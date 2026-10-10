import type { ChangedFile, Checkout } from "./changes";

// Demo mode has no bridge, so the Changes sheet shows a made-up checkout: one
// edit with two hunks, a rename, a new file, a deletion and a binary file.

const SESSION = `diff --git a/src/auth/session.ts b/src/auth/session.ts
index 3f2a9c1..8d4e07b 100644
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -12,8 +12,11 @@ export type Session = {
   expiresAt: number;
 };

-export function isExpired(session: Session): boolean {
-  return session.expiresAt < Date.now();
+const SKEW_MS = 30_000;
+
+/** A token counts as expired a little early, so a request never leaves with one that dies in flight. */
+export function isExpired(session: Session, now = Date.now()): boolean {
+  return session.expiresAt - SKEW_MS < now;
 }

 export async function refresh(session: Session): Promise<Session> {
@@ -31,5 +34,5 @@ export async function refresh(session: Session): Promise<Session> {
   if (!response.ok) {
     throw new Error("refresh failed");
   }
-  return { ...session, token: (await response.json()).token };
+  return { ...session, ...(await response.json()) };
 }
`;

const RENAMED = `diff --git a/src/auth/token.ts b/src/auth/tokens.ts
similarity index 88%
rename from src/auth/token.ts
rename to src/auth/tokens.ts
index 51c0d2e..a7b3f90 100644
--- a/src/auth/token.ts
+++ b/src/auth/tokens.ts
@@ -1,5 +1,6 @@
-export function parseToken(raw: string) {
+export function parseToken(raw: string): { id: string; secret: string } {
   const [id, secret] = raw.split(".");
+  if (!id || !secret) throw new Error("malformed token");
   return { id, secret };
 }

`;

const FRESH = `diff --git a/src/auth/session.test.ts b/src/auth/session.test.ts
new file mode 100644
index 0000000..c91e4a2
--- /dev/null
+++ b/src/auth/session.test.ts
@@ -0,0 +1,9 @@
+import { expect, test } from "vitest";
+import { isExpired } from "./session";
+
+test("a token is expired a little before its time", () => {
+  const session = { token: "t", expiresAt: 100_000 };
+  expect(isExpired(session, 60_000)).toBe(false);
+  expect(isExpired(session, 80_000)).toBe(true);
+});
+
`;

const REMOVED = `diff --git a/src/auth/legacy.ts b/src/auth/legacy.ts
deleted file mode 100644
index 7e11b6d..0000000
--- a/src/auth/legacy.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-// Kept for the old login page.
-export const LEGACY = true;
-export default LEGACY;
`;

const LOGO = `diff --git a/public/logo.png b/public/logo.png
index 0b9d1aa..4cc2e51 100644
Binary files a/public/logo.png and b/public/logo.png differ
`;

/** The changes shown for any agent in demo mode. */
export function demoChanges(repo: string, branch: string): Checkout {
  const pieces: Array<[string, Omit<ChangedFile, "patch">]> = [
    [SESSION, { path: "src/auth/session.ts", status: "modified", added: 6, deleted: 3, binary: false, untracked: false }],
    [RENAMED, { path: "src/auth/tokens.ts", previousPath: "src/auth/token.ts", status: "renamed", added: 2, deleted: 1, binary: false, untracked: false }],
    [REMOVED, { path: "src/auth/legacy.ts", status: "deleted", added: 0, deleted: 3, binary: false, untracked: false }],
    [LOGO, { path: "public/logo.png", status: "modified", added: null, deleted: null, binary: true, untracked: false }],
    [FRESH, { path: "src/auth/session.test.ts", status: "added", added: 9, deleted: 0, binary: false, untracked: true }],
  ];
  let patch = "";
  const files = pieces.map(([text, file]) => {
    const start = patch.length;
    patch += text;
    return { ...file, patch: [start, patch.length] as [number, number] };
  });
  return { kind: "checkout", repo, branch: branch || "main", detached: false, head: "a1b2c3d", files, fileCount: files.length, patch, truncated: false };
}
