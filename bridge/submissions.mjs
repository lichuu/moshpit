import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { RequestError } from "./upload.mjs";

const modes = new Set(["send", "steer", "queue", "terminal", "stop"]);
const receiptStates = new Set(["delivered", "queued", "failed", "unknown"]);

function identity(request, deviceId) {
  if (!request || typeof request !== "object" ||
      typeof request.id !== "string" || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(request.id) ||
      typeof request.target !== "string" || !request.target ||
      typeof request.sessionId !== "string" || !request.sessionId ||
      !modes.has(request.mode) || typeof request.text !== "string" || request.text.length > 32768 ||
      typeof deviceId !== "string" || !deviceId) {
    throw new RequestError(400, "Invalid submission.");
  }
  const attachment = request.attachment;
  if (attachment !== undefined && (!attachment || typeof attachment.name !== "string" ||
      typeof attachment.type !== "string" || typeof attachment.data !== "string")) {
    throw new RequestError(400, "Invalid image attachment.");
  }
  return createHash("sha256").update(JSON.stringify([
    deviceId, request.target, request.sessionId, request.mode, request.text,
    attachment ? [attachment.name, attachment.type, attachment.data] : null,
  ])).digest("hex");
}

async function writeSynced(file, record, exclusive = false) {
  const handle = await open(file, exclusive ? "wx" : "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify(record));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function createSubmissions({ stateDir, herdr, prepareAttachment, canonical = async (target) => target }) {
  const directory = path.join(stateDir, "submissions");
  const lanes = new Map();
  const pending = new Map();

  // One lane per pane, keyed by its canonical ID so a label and a pane ID for
  // the same pane queue together. `authorize` runs inside the lane, right
  // before the write: a device revoked while its write waited behind an
  // earlier one dispatches nothing.
  // Lane keys resolve one after another, so writes join their lane in the
  // order they arrived even when one lookup is slower than the next.
  let resolving = Promise.resolve();
  function inLane(target, action, authorize) {
    const key = resolving.then(() => canonical(target)).catch(() => target);
    resolving = key.catch(() => {});
    const operation = key.then((lane) => {
      const previous = lanes.get(lane) ?? Promise.resolve();
      const queued = previous.catch(() => {}).then(async () => {
        if (authorize) await authorize();
        return action();
      });
      lanes.set(lane, queued);
      void queued.finally(() => {
        if (lanes.get(lane) === queued) lanes.delete(lane);
      }).catch(() => {});
      return queued;
    });
    return operation;
  }

  async function readRecord(file, fingerprint) {
    const record = JSON.parse(await readFile(file, "utf8"));
    if (record.fingerprint !== fingerprint) {
      throw new RequestError(409, "This submission ID belongs to a different request or device.");
    }
    if (!record.receipt || !receiptStates.has(record.receipt.state)) {
      throw new Error("Invalid saved submission receipt.");
    }
    return record.receipt;
  }

  async function run(request, fingerprint, authorize) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${request.id}.json`);
    const unknown = { id: request.id, state: "unknown", message: "Delivery could not be confirmed. Check the session before sending again." };
    const record = { fingerprint, receipt: unknown };
    try {
      await writeSynced(file, record, true);
      await syncDirectory(directory);
    } catch (error) {
      if (error.code === "EEXIST") return readRecord(file, fingerprint);
      throw error;
    }

    let receipt;
    let deliveryStarted = false;
    try {
      receipt = await inLane(request.target, async () => {
        async function validateSession() {
          const snapshot = await herdr.snapshot();
          const agent = snapshot.agents.find((candidate) => candidate.id === request.target);
          if (!agent) {
            // A companion shell is a bare pane: only raw terminal writes are
            // allowed, addressed by its unresolved session id.
            if (
              request.mode !== "terminal" ||
              request.sessionId !== `unresolved:${request.target}` ||
              !(await herdr.isShell?.(request.target))
            ) {
              throw new RequestError(409, "This agent session changed. Your draft has been preserved.");
            }
            return;
          }
          const matches = agent.sessionId
            ? agent.sessionId === request.sessionId
            : request.mode === "terminal" && request.sessionId === `unresolved:${request.target}`;
          if (!matches) {
            throw new RequestError(409, "This agent session changed. Your draft has been preserved.");
          }
        }
        await validateSession();
        let text = request.text;
        if (request.attachment) {
          if (!prepareAttachment || request.mode === "terminal" || request.mode === "stop") {
            throw new RequestError(400, "Attachments are unavailable for this action.");
          }
          text = await prepareAttachment(request.attachment, request);
          if (typeof text !== "string") throw new Error("Attachment preparation did not return text.");
          await validateSession();
        }
        deliveryStarted = true;
        const result = await herdr.submit(request.target, text, request.mode);
        if (!result || !["delivered", "queued"].includes(result.state) || typeof result.message !== "string") {
          throw new Error("The agent did not return a delivery receipt.");
        }
        return { id: request.id, state: result.state, message: result.message };
      }, authorize);
    } catch (error) {
      receipt = !deliveryStarted || error.delivery === "failed"
        ? { id: request.id, state: "failed", message: error.message || "The message could not be sent." }
        : unknown;
    }
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeSynced(temporary, { fingerprint, receipt });
      await rename(temporary, file);
      await syncDirectory(directory);
    } catch {
      await unlink(temporary).catch(() => {});
      return unknown;
    }
    return receipt;
  }

  return {
    submit(request, deviceId, authorize) {
      const fingerprint = identity(request, deviceId);
      const existing = pending.get(request.id);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new RequestError(409, "This submission ID belongs to a different request or device.");
        }
        return existing.operation;
      }
      const operation = run(request, fingerprint, authorize);
      pending.set(request.id, { fingerprint, operation });
      void operation.finally(() => pending.delete(request.id)).catch(() => {});
      return operation;
    },
    write(target, keys, authorize) {
      return inLane(target, () => herdr.keys(target, keys), authorize);
    },
    prompt(target, text, authorize) {
      return inLane(target, () => herdr.submit(target, text, "send"), authorize);
    },
    // In the lane like every other write: the answer re-reads the pane before
    // it sends, and a prompt landing between that read and the keystroke is
    // exactly what the re-read is there to rule out.
    answer(target, token, optionKey, authorize) {
      return inLane(target, () => herdr.answer(target, token, optionKey), authorize);
    },
  };
}
