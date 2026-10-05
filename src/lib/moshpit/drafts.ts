import { useSyncExternalStore } from "react";
import { z } from "zod";

export type DraftKey = readonly [
  hostId: string,
  sessionId: string,
  mode: "conversation" | "terminal",
];
// One spelling for an agent with no native session yet, so Chat and Terminal
// reach the same drafts.
export const draftSessionId = (
  agent: { id: string; sessionId?: string },
  demo: boolean,
) => agent.sessionId ?? `${demo ? "demo" : "unresolved"}:${agent.id}`;
const submissionSchema = z.object({
  requestId: z.string(),
  state: z.enum(["submitting", "failed", "unknown", "delivered", "queued"]),
  message: z.string().optional(),
});
const fileSchema = z.custom<File>(
  (value) => typeof File !== "undefined" && value instanceof File,
);
// The image belongs to the session, not to a view: Chat and Terminal show the
// same one. It is stored once, beside the per-view records, so a view's own
// record always writes `attachment: null`. A record written before the image
// was shared may still carry one.
const attachmentSchema = z.object({ attachment: fileSchema.nullable() });
const draftSchema = z.object({
  text: z.string(),
  attachment: fileSchema.nullable(),
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

async function readRecord<T>(id: string, schema: z.ZodType<T>) {
  const db = await openDatabase();
  return new Promise<T | undefined>((resolve, reject) => {
    const request = db.transaction("drafts").objectStore("drafts").get(id);
    request.onsuccess = () => {
      const result = schema.safeParse(request.result);
      if (request.result !== undefined && !result.success)
        reject(new Error("Saved draft could not be read."));
      else resolve(result.success ? result.data : undefined);
    };
    request.onerror = () => reject(request.error);
  });
}

async function writeRecord(id: string, record: unknown) {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("drafts", "readwrite");
    transaction.objectStore("drafts").put(record, id);
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

const attachments = new Map<string, ReturnType<typeof createAttachmentStore>>();
function createAttachmentStore(hostId: string, sessionId: string) {
  const id = JSON.stringify([hostId, sessionId, "attachment"]);
  let file: File | null = null;
  let edited = false;
  const listeners = new Set<() => void>();
  const publish = (next: File | null) => {
    file = next;
    for (const listener of listeners) listener();
  };
  const ready = readRecord(id, attachmentSchema).then((saved) => {
    if (!edited && saved) publish(saved.attachment);
  });
  let writes: Promise<void> = ready.catch(() => {});
  return {
    ready,
    get: () => file,
    subscribe(listener: () => void) {
      listeners.add(listener);
    },
    set(next: File | null) {
      edited = true;
      publish(next);
      const write = writes.then(() => writeRecord(id, { attachment: next }));
      writes = write.catch(() => {});
      return write;
    },
  };
}
function attachmentStore(hostId: string, sessionId: string) {
  const id = JSON.stringify([hostId, sessionId]);
  let store = attachments.get(id);
  if (!store) {
    store = createAttachmentStore(hostId, sessionId);
    attachments.set(id, store);
  }
  return store;
}

const stores = new Map<string, ReturnType<typeof createDraftStore>>();
function createDraftStore(key: DraftKey) {
  const id = JSON.stringify(key);
  const shared = attachmentStore(key[0], key[1]);
  let snapshot: Snapshot = {
    loaded: false,
    draft: { ...emptyDraft(), attachment: shared.get() },
    error: null,
  };
  let edited = false;
  // The image this view's send in flight carries. A delivery clears the
  // shared image only while it is still that one.
  let submitted: File | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: Snapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  shared.subscribe(() => {
    if (snapshot.draft.attachment !== shared.get())
      publish({
        ...snapshot,
        draft: { ...snapshot.draft, attachment: shared.get() },
      });
  });
  const failed = (error: unknown) =>
    publish({
      ...snapshot,
      error: `Draft is only saved in memory. ${error instanceof Error ? error.message : "Device storage is unavailable."}`,
    });
  const ready = Promise.all([readRecord(id, draftSchema), shared.ready])
    .then(([saved]) => {
      const legacy = saved?.attachment;
      if (legacy && !shared.get()) share(legacy);
      publish({
        ...snapshot,
        loaded: true,
        draft:
          !edited && saved
            ? { ...interruptedDraft(saved), attachment: shared.get() }
            : snapshot.draft,
      });
      // Drop the copy this record carried, or it would come back after the
      // shared image is sent.
      if (legacy) persist(snapshot.draft);
    })
    .catch((error: unknown) => {
      publish({ ...snapshot, loaded: true });
      failed(error);
    });
  let writes: Promise<void> = ready;
  const queue = (work: () => Promise<void>) => {
    writes = writes
      .then(work)
      .then(() => {
        if (snapshot.error) publish({ ...snapshot, error: null });
      })
      .catch(failed);
  };
  const persist = (draft: Draft) =>
    queue(() => writeRecord(id, { ...draft, attachment: null }));
  const share = (file: File | null) => {
    const write = shared.set(file);
    queue(() => write);
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
      if (patch.attachment !== undefined) share(patch.attachment);
      replace({
        ...snapshot.draft,
        ...patch,
        revision: snapshot.draft.revision + 1,
      });
    },
    discard() {
      share(null);
      replace({ ...emptyDraft(), revision: snapshot.draft.revision + 1 });
    },
    markSubmitting(requestId: string) {
      submitted = snapshot.draft.attachment;
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
      if (clear && submitted && shared.get() === submitted) share(null);
      replace({
        ...(clear
          ? {
              ...emptyDraft(),
              attachment: shared.get(),
              revision: capturedRevision + 1,
            }
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
  const images = new Map<string, File | null>();
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("drafts");
      const request = transaction.objectStore("drafts").openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        try {
          const [hostId, sessionId, kind] = z
            .tuple([
              z.string(),
              z.string(),
              z.enum(["conversation", "terminal", "attachment"]),
            ])
            .parse(JSON.parse(String(cursor.key)));
          if (kind === "attachment")
            images.set(
              JSON.stringify([hostId, sessionId]),
              attachmentSchema.parse(cursor.value).attachment,
            );
          else {
            const key: DraftKey = [hostId, sessionId, kind];
            const draft = interruptedDraft(draftSchema.parse(cursor.value));
            found.set(JSON.stringify(key), { key, draft });
          }
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
  for (const [id, store] of attachments) images.set(id, store.get());
  // A session's image is listed once, with its conversation draft.
  for (const [id, image] of images) {
    const [hostId, sessionId] = JSON.parse(id) as [string, string];
    const terminal = found.get(JSON.stringify([hostId, sessionId, "terminal"]));
    if (terminal) terminal.draft = { ...terminal.draft, attachment: null };
    const key: DraftKey = [hostId, sessionId, "conversation"];
    const draft = found.get(JSON.stringify(key))?.draft ?? emptyDraft();
    found.set(JSON.stringify(key), {
      key,
      draft: { ...draft, attachment: image },
    });
  }
  return [...found.values()].filter(
    ({ draft }) => draft.text || draft.attachment,
  );
}
