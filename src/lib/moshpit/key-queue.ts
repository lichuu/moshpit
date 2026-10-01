import type { KeyInput } from "./bridge";

// Terminal keys go to the bridge over HTTP, one request at a time, so they
// reach the pane in the order they were pressed. Keys pressed while a request
// is in flight wait, and a run of typed characters is sent as one { text }.
// Raw keys have no receipt: after a failure the keys still waiting are
// dropped rather than replayed into a pane whose state is now unknown.

export const MAX_KEYS_PER_REQUEST = 16;
export const MAX_TEXT = 4096;

const typed = (key: string) => [...key].length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) !== 127;

/** The next request's worth of keys, taken from the front of `queue`. */
export function nextBatch(queue: string[]): KeyInput[] {
  const batch: KeyInput[] = [];
  while (queue.length && batch.length < MAX_KEYS_PER_REQUEST) {
    const key = queue[0];
    const last = batch[batch.length - 1];
    if (typed(key)) {
      if (typeof last === "object" && last.text.length + key.length <= MAX_TEXT) last.text += key;
      else batch.push({ text: key });
    } else {
      batch.push(key);
    }
    queue.shift();
  }
  return batch;
}

export function createKeyQueue(send: (keys: KeyInput[]) => Promise<void>, onDropped: (error: unknown) => void) {
  let queue: string[] = [];
  let sending = false;
  let closed = false;
  async function drain() {
    if (sending) return;
    sending = true;
    while (queue.length && !closed) {
      const batch = nextBatch(queue);
      try {
        await send(batch);
      } catch (error) {
        queue = [];
        if (!closed) onDropped(error);
      }
    }
    sending = false;
  }
  return {
    push(key: string) {
      if (closed) return;
      queue.push(key);
      void drain();
    },
    /** Teardown: unsent keys are dropped, never sent later. Returns how many. */
    close() {
      closed = true;
      const dropped = queue.length;
      queue = [];
      return dropped;
    },
  };
}
