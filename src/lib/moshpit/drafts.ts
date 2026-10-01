import { useSyncExternalStore } from "react";
import { z } from "zod";

export type DraftKey = readonly [
  hostId: string,
  sessionId: string,
  mode: "conversation" | "terminal",
];
const submissionSchema = z.object({
  requestId: z.string(),
  state: z.enum(["submitting", "failed", "unknown", "delivered", "queued"]),
  message: z.string().optional(),
});
const draftSchema = z.object({
  text: z.string(),
  attachment: z
    .custom<File>(
      (value) => typeof File !== "undefined" && value instanceof File,
    )
    .nullable(),
  revision: z.number().int().nonnegative(),
  submission: submissionSchema.optional(),
});
export type Draft = z.infer<typeof draftSchema>;
export type DraftReceipt = Omit<z.infer<typeof submissionSchema>, "state"> & {
  state: "failed" | "unknown" | "delivered" | "queued";
};
type Snapshot = { loaded: boolean; draft: Draft; error: string | null };
const emptyDraft = (): Draft => ({ text: "", attachment: null, revision: 0 });
let database: Promise<IDBDatabase> | undefined;

function openDatabase() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("moshpit-drafts", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Draft storage is blocked by another tab."));
  });
  return database;
}

async function readDraft(id: string) {
  const db = await openDatabase();
  return new Promise<Draft | undefined>((resolve, reject) => {
    const request = db.transaction("drafts").objectStore("drafts").get(id);
    request.onsuccess = () => {
      const result = draftSchema.safeParse(request.result);
      if (request.result !== undefined && !result.success)
        reject(new Error("Saved draft could not be read."));
      else resolve(result.success ? result.data : undefined);
    };
    request.onerror = () => reject(request.error);
  });
}

async function writeDraft(id: string, draft: Draft) {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("drafts", "readwrite");
    transaction.objectStore("drafts").put(draft, id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function interruptedDraft(draft: Draft): Draft {
  return draft.submission?.state === "submitting"
    ? {
        ...draft,
        submission: {
          ...draft.submission,
          state: "unknown",
          message:
            "Delivery was interrupted. Check the conversation before retrying.",
        },
      }
    : draft;
}

const stores = new Map<string, ReturnType<typeof createDraftStore>>();
function createDraftStore(key: DraftKey) {
  const id = JSON.stringify(key);
  let snapshot: Snapshot = { loaded: false, draft: emptyDraft(), error: null };
  let edited = false;
  const listeners = new Set<() => void>();
  const publish = (next: Snapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const failed = (error: unknown) =>
    publish({
      ...snapshot,
      error: `Draft is only saved in memory. ${error instanceof Error ? error.message : "Device storage is unavailable."}`,
    });
  const ready = readDraft(id)
    .then((saved) => {
      publish({
        ...snapshot,
        loaded: true,
        draft: !edited && saved ? interruptedDraft(saved) : snapshot.draft,
      });
    })
    .catch((error: unknown) => {
      publish({ ...snapshot, loaded: true });
      failed(error);
    });
  let writes: Promise<void> = ready;
  const persist = (draft: Draft) => {
    writes = writes
      .then(() => writeDraft(id, draft))
      .then(() => {
        if (snapshot.error) publish({ ...snapshot, error: null });
      })
      .catch(failed);
  };
  const replace = (draft: Draft) => {
    edited = true;
    publish({ ...snapshot, draft });
    persist(draft);
  };
  return {
    key,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(patch: Partial<Pick<Draft, "text" | "attachment">>) {
      replace({
        ...snapshot.draft,
        ...patch,
        revision: snapshot.draft.revision + 1,
      });
    },
    discard() {
      replace({ ...emptyDraft(), revision: snapshot.draft.revision + 1 });
    },
    markSubmitting(requestId: string) {
      replace({
        ...snapshot.draft,
        submission: { requestId, state: "submitting" },
      });
      return writes;
    },
    settle(receipt: DraftReceipt, capturedRevision: number) {
      if (snapshot.draft.submission?.requestId !== receipt.requestId) return;
      const clear =
        (receipt.state === "delivered" || receipt.state === "queued") &&
        snapshot.draft.revision === capturedRevision;
      replace({
        ...(clear
          ? { ...emptyDraft(), revision: capturedRevision + 1 }
          : snapshot.draft),
        submission: receipt,
      });
    },
    async flush() {
      await ready;
      await writes;
    },
  };
}

export function draftStore(key: DraftKey) {
  const id = JSON.stringify(key);
  let store = stores.get(id);
  if (!store) {
    store = createDraftStore(key);
    stores.set(id, store);
  }
  return store;
}

export function useDraft(key: DraftKey) {
  const store = draftStore(key);
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  return {
    ...snapshot,
    update: store.update,
    discard: store.discard,
    markSubmitting: store.markSubmitting,
    settle: store.settle,
  };
}

export async function listDrafts(): Promise<
  Array<{ key: DraftKey; draft: Draft }>
> {
  const found = new Map<string, { key: DraftKey; draft: Draft }>();
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("drafts");
      const request = transaction.objectStore("drafts").openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        try {
          const key = z
            .tuple([
              z.string(),
              z.string(),
              z.enum(["conversation", "terminal"]),
            ])
            .parse(JSON.parse(String(cursor.key)));
          const draft = interruptedDraft(draftSchema.parse(cursor.value));
          found.set(JSON.stringify(key), { key, draft });
        } catch {
          /* Ignore records from incompatible storage versions. */
        }
        cursor.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } catch {
    /* In-memory drafts remain recoverable when storage is unavailable. */
  }
  for (const [id, store] of stores) {
    await store.flush();
    found.set(id, { key: store.key, draft: store.getSnapshot().draft });
  }
  return [...found.values()].filter(
    ({ draft }) => draft.text || draft.attachment,
  );
}
