import { test, expect } from "@playwright/test";
import { formatBytes, insertQuotedPath, isImageFile, MAX_FILE_BYTES, validateFile } from "../../src/lib/moshpit/file-upload";

// C12: where an uploaded file's path lands in the draft, and which files the
// app refuses before any request. Pure functions, so no browser is involved.

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "module specs are viewport-independent");
});

const file = (name: string, size: number, type = "text/plain") => new File([new Uint8Array(size)], name, { type });

test.describe("inserting a path", () => {
  test("an empty draft takes the quoted path alone", () => {
    expect(insertQuotedPath("", 0, 0, "/srv/files/ab/notes.txt")).toEqual({ text: "'/srv/files/ab/notes.txt'", caret: 25 });
  });

  test("a space goes before the path unless one is already there, and after it unless whitespace follows", () => {
    expect(insertQuotedPath("look at", 7, 7, "/a")).toEqual({ text: "look at '/a'", caret: 12 });
    expect(insertQuotedPath("look at ", 8, 8, "/a")).toEqual({ text: "look at '/a'", caret: 12 });
    expect(insertQuotedPath("look at\n", 8, 8, "/a")).toEqual({ text: "look at\n'/a'", caret: 12 });
    expect(insertQuotedPath("before after", 7, 7, "/a")).toEqual({ text: "before '/a' after", caret: 11 });
    expect(insertQuotedPath("before  after", 7, 7, "/a")).toEqual({ text: "before '/a' after", caret: 11 });
    expect(insertQuotedPath("beforeafter", 6, 6, "/a")).toEqual({ text: "before '/a' after", caret: 11 });
  });

  test("a selection is replaced, and a stale caret is clamped into the text", () => {
    expect(insertQuotedPath("one two three", 4, 7, "/a")).toEqual({ text: "one '/a' three", caret: 8 });
    expect(insertQuotedPath("short", 99, 120, "/a")).toEqual({ text: "short '/a'", caret: 10 });
  });

  test("a single quote in the path is closed, escaped and reopened", () => {
    expect(insertQuotedPath("", 0, 0, "/a/it's here.txt").text).toBe(`'/a/it'\\''s here.txt'`);
  });
});

test.describe("checking a file first", () => {
  test("a good file passes and the size cap is inclusive", () => {
    expect(validateFile(file("notes.txt", 10))).toBeNull();
    expect(validateFile(file("résumé 日本語.pdf", 1))).toBeNull();
    expect(validateFile(file("exact.bin", MAX_FILE_BYTES))).toBeNull();
  });

  test("an empty, oversized or badly named file is refused with a reason", () => {
    expect(validateFile(file("empty.txt", 0))).toBe("That file is empty.");
    expect(validateFile(file("big.bin", MAX_FILE_BYTES + 1))).toBe("Files must be 10 MB or smaller.");
    expect(validateFile(file(".env", 3))).toMatch(/may not start with a dot/);
    expect(validateFile(file("a\u202etxt.exe", 3))).toMatch(/control or hidden/);
    expect(validateFile(file("con", 3))).toBe("That file name is reserved.");
  });

  test("only the four image types the bridge decodes take the attachment path", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif"]) expect(isImageFile(file("x", 1, type))).toBe(true);
    for (const type of ["image/svg+xml", "image/heic", "text/plain", ""]) expect(isImageFile(file("x", 1, type))).toBe(false);
  });

  test("sizes read plainly", () => {
    expect([0, 18, 1024, 1536, 20 * 1024, 10 * 1024 * 1024].map(formatBytes)).toEqual(["0 B", "18 B", "1.0 KB", "1.5 KB", "20 KB", "10.0 MB"]);
  });
});
