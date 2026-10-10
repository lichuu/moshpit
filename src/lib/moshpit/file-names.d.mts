export const MAX_FILE_BYTES: number;
export const MAX_FILE_NAME_BYTES: number;
export function cleanFileName(raw: unknown): { name: string; error?: undefined } | { error: string; name?: undefined };
export function quoteShellWord(text: string): string;
