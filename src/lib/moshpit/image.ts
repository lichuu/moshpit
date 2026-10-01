import type { Attachment } from "./types";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

export function formatImageLine(attachment: Pick<Attachment, "name" | "size">) {
  return `> [image] ${attachment.name} (${attachment.size})`;
}
