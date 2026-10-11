export function createAlertDelay<T extends { id: string }>(
  holds: (item: T, status: string | undefined) => boolean,
): {
  step(candidates: T[], agents: { id: string; status: string }[], delayMs: number, now: number): T[];
  clear(): void;
  readonly size: number;
};
