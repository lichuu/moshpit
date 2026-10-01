import { cn } from "@/lib/utils";

export function MoshpitMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("text-accent", className)}
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M5 7.2v7.4a3.4 3.4 0 0 0 3.4 3.4h7.2A3.4 3.4 0 0 0 19 14.6V7.2"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path
        d="M12 3.4v6.2"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
