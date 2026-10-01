import { useSyncExternalStore } from "react";

function subscribeNetwork(update: () => void) {
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  return () => {
    window.removeEventListener("online", update);
    window.removeEventListener("offline", update);
  };
}

export function useOnline() {
  return useSyncExternalStore(
    subscribeNetwork,
    () => navigator.onLine,
    () => true,
  );
}
