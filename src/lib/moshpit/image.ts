import type { Attachment } from "./types";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

export function validateImage(image: File) {
  if (!IMAGE_TYPES.includes(image.type)) return "Choose a PNG, JPEG, WebP, or GIF image.";
  if (!image.size || image.size > MAX_IMAGE_BYTES) return "Choose an image smaller than 10 MB.";
  return null;
}

export function formatImageLine(attachment: Pick<Attachment, "name" | "size">) {
  return `> [image] ${attachment.name} (${attachment.size})`;
}
