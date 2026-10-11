// Holding a key on the bar repeats it, the way a keyboard does. Only the keys
// whose repeat is a movement or an erase: Enter, Esc, Tab and every Ctrl
// combination do something once, and doing it again is never what a held
// finger means.

export const REPEAT_DELAY_MS = 400;
/** About twelve a second. */
export const REPEAT_INTERVAL_MS = 83;
/** Per hold, so a thumb left on a key cannot type for ever. */
export const REPEAT_CAP = 200;

const REPEATING = new Set(["up", "down", "left", "right", "backspace", "delete"]);

export const repeats = (key: string) => REPEATING.has(key);

/**
 * One hold at a time. `start` sends nothing: the first key goes out once the
 * delay has passed, so a press released sooner is only its click. The count
 * stays readable after the hold ends, so the release that follows a real hold
 * can be told from a tap.
 */
export function createHoldRepeat(send: (key: string) => void) {
  let running = false;
  let timer: number | undefined;
  let sent = 0;
  const stop = () => {
    running = false;
    window.clearTimeout(timer);
    window.clearInterval(timer);
    timer = undefined;
    return sent;
  };
  return {
    start(key: string) {
      stop();
      sent = 0;
      running = true;
      const fire = () => {
        send(key);
        // `send` ends the hold when it has nothing to send to, and then the
        // key does not count.
        if (!running) return false;
        sent += 1;
        if (sent >= REPEAT_CAP) stop();
        return running;
      };
      timer = window.setTimeout(() => {
        if (fire()) timer = window.setInterval(fire, REPEAT_INTERVAL_MS);
      }, REPEAT_DELAY_MS);
    },
    /** Ends the hold, if there is one. Returns how many keys it sent. */
    stop,
  };
}
