import { test, expect } from "@playwright/test";
import { DEV_URL } from "../../playwright.config";

// C4: review comments travel as a plain-text block at the end of the prompt.
// The writer and the strict reader must agree on every comment, and the reader
// must leave anything that only looks similar as ordinary text. Like the other
// module specs these import from source, so they run against the dev server.

const REVIEW = "/src/lib/moshpit/review-comments.ts";
const DRAFTS = "/src/lib/moshpit/drafts.ts";

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "module specs are viewport-independent");
});

const comment = (path: string, line: number, side: "old" | "new", text: string) => ({ path, line, side, text });

test.describe("review comment block", () => {
  test("the block is one plain line per comment, with the old side marked", async ({ page }) => {
    await page.goto(`${DEV_URL}/`);
    const result = await page.evaluate(
      async ([mod]) => {
        const { formatReviewComments, withReviewComments } = await import(mod);
        const comments = [
          { path: "src/app.ts", line: 12, side: "new", text: "Rename this." },
          { path: "src/app.ts", line: 14, side: "old", text: "Why was this removed?" },
        ];
        return { block: formatReviewComments(comments), none: formatReviewComments([]), message: withReviewComments("Please fix.", comments), bare: withReviewComments("", comments) };
      },
      [REVIEW],
    );
    const block = "Review comments (2):\nsrc/app.ts:12: Rename this.\nsrc/app.ts:14 (old): Why was this removed?";
    expect(result.block).toBe(block);
    expect(result.none).toBe("");
    expect(result.message).toBe(`Please fix.\n\n${block}`);
    expect(result.bare).toBe(block);
  });

  test("what is written reads back exactly, for awkward paths and text", async ({ page }) => {
    await page.goto(`${DEV_URL}/`);
    const separator = String.fromCharCode(0x2028);
    const sets = [
      [comment("src/a.ts", 1, "new", "plain")],
      [comment("src/old-name.ts", 7, "old", "renamed file, old side")],
      [comment("my docs/read me.md", 3, "new", "a path with spaces")],
      [comment("dir:with:colons/file.ts", 40, "new", "a path with colons")],
      [comment("odd/a:12: b.ts", 5, "old", "a path that reads like a location")],
      [comment("odd/x:3 (old): y.ts", 5, "new", "a path that reads like an old-side location")],
      [comment('"quoted".ts', 2, "new", "a path that starts with a quote")],
      [comment("tab\there/new\nline.ts", 9, "new", "control characters in the path")],
      [comment(`sep${separator}arator.ts`, 9, "new", "a unicode line separator in the path")],
      [comment("src/a.ts", 2, "new", "see b.ts:30: and c.ts:4 (old): too")],
      [comment("src/a.ts", 2, "new", "two\nlines\n\nand a blank one")],
      [comment("src/a.ts", 2, "new", "back\\slash and \\n and \\\\ and a trailing one \\")],
      [comment("src/a.ts", 2, "new", "Review comments (1):\nfake.ts:1: nested")],
      [comment("a.ts", 1, "new", "one"), comment("a.ts", 1, "old", "same number, other side"), comment("b.ts", 22, "new", "two: ok")],
    ];
    const result = await page.evaluate(
      async ([mod, sets]) => {
        const { withReviewComments, parseReviewComments } = await import(mod as string);
        return (sets as unknown[][]).map((comments) => {
          const message = withReviewComments("Look at these.\n\nThanks", comments);
          const bare = withReviewComments("", comments);
          return {
            lines: message.split("\n").length,
            body: parseReviewComments(message)?.body,
            comments: parseReviewComments(message)?.comments,
            bare: parseReviewComments(bare),
            tolerated: parseReviewComments(`${message}\n`)?.comments.length,
          };
        });
      },
      [REVIEW, sets] as const,
    );
    result.forEach((row, index) => {
      const comments = sets[index];
      expect(row.body, `body ${index}`).toBe("Look at these.\n\nThanks");
      expect(row.comments, `comments ${index}`).toEqual(comments);
      expect(row.bare, `bare ${index}`).toEqual({ body: "", comments });
      expect(row.tolerated, `trailing line break ${index}`).toBe(comments.length);
      // A comment never adds a line: the block is a blank line, the header and one line each.
      expect(row.lines, `lines ${index}`).toBe(3 + 1 + 1 + comments.length);
    });
  });

  test("only the exact block at the very end of a message is read; similar text stays text", async ({ page }) => {
    await page.goto(`${DEV_URL}/`);
    const one = "Review comments (1):\na.ts:1: ok";
    const cases: Record<string, string> = {
      "nothing": "Just a message.",
      "count too high": "Review comments (2):\na.ts:1: ok",
      "count too low": "Review comments (1):\na.ts:1: ok\nb.ts:2: extra",
      "zero count": "Review comments (0):",
      "leading zero count": "Review comments (01):\na.ts:1: ok",
      "text after the block": `${one}\nThanks!`,
      "text after a blank line": `${one}\n\nThanks!`,
      "no blank line before": `Please fix.\n${one}`,
      "lower case header": "review comments (1):\na.ts:1: ok",
      "header with extra": "Review comments (1): now\na.ts:1: ok",
      "missing space after the colon": "Review comments (1):\na.ts:1:ok",
      "no line number": "Review comments (1):\na.ts: ok",
      "line zero": "Review comments (1):\na.ts:0: ok",
      "leading zero line": "Review comments (1):\na.ts:01: ok",
      "negative line": "Review comments (1):\na.ts:-1: ok",
      "other side marker": "Review comments (1):\na.ts:1 (removed): ok",
      "old marker without a space": "Review comments (1):\na.ts:1(old): ok",
      "empty comment": "Review comments (1):\na.ts:1: ",
      "untrimmed comment": "Review comments (1):\na.ts:1:  padded",
      "unknown escape": "Review comments (1):\na.ts:1: bad \\x escape",
      "dangling backslash": "Review comments (1):\na.ts:1: ends with \\",
      "blank line inside": "Review comments (2):\na.ts:1: ok\n\nb.ts:2: ok",
      "path quoted when it need not be": 'Review comments (1):\n"a.ts":1: ok',
      "broken quoted path": 'Review comments (1):\n"a.ts:1: ok',
      "carriage return line ends": "Review comments (1):\r\na.ts:1: ok",
      "header only": "Review comments (1):",
    };
    const result = await page.evaluate(
      async ([mod, cases, one]) => {
        const { parseReviewComments } = await import(mod as string);
        const out: Record<string, unknown> = {};
        for (const [name, text] of Object.entries(cases as Record<string, string>)) out[name] = parseReviewComments(text);
        return { out, fine: parseReviewComments(one as string) };
      },
      [REVIEW, cases, one] as const,
    );
    for (const name of Object.keys(cases)) expect(result.out[name], name).toBeNull();
    expect(result.fine).toEqual({ body: "", comments: [{ path: "a.ts", line: 1, side: "new", text: "ok" }] });
  });

  test("the cap on comments and on one comment's length", async ({ page }) => {
    await page.goto(`${DEV_URL}/`);
    const result = await page.evaluate(
      async ([mod]) => {
        const { REVIEW_COMMENT_LIMITS, withReviewComments, parseReviewComments, commentProblem, cleanCommentText } = await import(mod);
        const make = (count: number) => Array.from({ length: count }, (_, n) => ({ path: "a.ts", line: n + 1, side: "new", text: `c${n}` }));
        return {
          limits: REVIEW_COMMENT_LIMITS,
          atCap: parseReviewComments(withReviewComments("", make(REVIEW_COMMENT_LIMITS.count)))?.comments.length,
          overCap: parseReviewComments(withReviewComments("", make(REVIEW_COMMENT_LIMITS.count + 1))),
          empty: commentProblem("  \n "),
          fine: commentProblem("x".repeat(REVIEW_COMMENT_LIMITS.text)),
          long: commentProblem("x".repeat(REVIEW_COMMENT_LIMITS.text + 1)),
          cleaned: cleanCommentText("  a\r\nb\u0007c\t \n"),
        };
      },
      [REVIEW],
    );
    expect(result.limits).toEqual({ count: 30, text: 500 });
    expect(result.atCap).toBe(30);
    expect(result.overCap).toBeNull();
    expect(result.empty).toBe("Write a comment first.");
    expect(result.fine).toBeNull();
    expect(result.long).toBe("Comments are limited to 500 characters.");
    expect(result.cleaned).toBe("a\nbc");
  });
});

test.describe("draft review comments", () => {
  test("a draft saved before comments existed still loads, with none", async ({ page }) => {
    await page.goto(`${DEV_URL}/`);
    const result = await page.evaluate(async (mod) => {
      const { draftStore } = await import(mod);
      await draftStore(["host", "warm", "conversation"]).flush();
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("moshpit-drafts", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("drafts", "readwrite");
        transaction.objectStore("drafts").put({ text: "written long ago", attachment: null, revision: 4 }, JSON.stringify(["host", "before", "conversation"]));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      const store = draftStore(["host", "before", "conversation"]);
      await store.flush();
      const { draft, error } = store.getSnapshot();
      return { text: draft.text, revision: draft.revision, comments: draft.comments, error };
    }, DRAFTS);
    expect(result).toEqual({ text: "written long ago", revision: 4, comments: [], error: null });
  });

  test("comments are shared by both views, survive a reload, and leave only when their send is delivered", async ({ page }) => {
    await page.goto(`${DEV_URL}/`);
    const result = await page.evaluate(async (mod) => {
      const { draftStore, listDrafts } = await import(mod);
      const c = (id: string, line: number, text = id) => ({ id, path: "a.ts", line, side: "new", text });
      const chat = draftStore(["host", "review", "conversation"]);
      const terminal = draftStore(["host", "review", "terminal"]);
      const other = draftStore(["host", "elsewhere", "conversation"]);
      const ids = (store: typeof chat) => store.getSnapshot().draft.comments.map((item: { id: string }) => item.id);

      chat.update({ text: "typed" });
      chat.editComments((now: unknown[]) => [...now, c("one", 1), c("two", 2)]);
      const staged = { chat: ids(chat), terminal: ids(terminal), other: ids(other), revision: chat.getSnapshot().draft.revision };
      await chat.flush();
      const listed = (await listDrafts()).map((item: { key: string[]; draft: { comments: unknown[] } }) => [item.key.join("/"), item.draft.comments.length]);

      // A failed or unknown send keeps them.
      let revision = chat.getSnapshot().draft.revision;
      chat.markSubmitting("failing", chat.getSnapshot().draft.comments);
      chat.settle({ requestId: "failing", state: "failed", message: "offline" }, revision);
      const afterFailure = ids(chat);
      chat.markSubmitting("unsure", chat.getSnapshot().draft.comments);
      chat.settle({ requestId: "unsure", state: "unknown", message: "check" }, revision);
      const afterUnknown = ids(chat);

      // Stopping the agent is not a send: nothing is consumed.
      chat.markSubmitting("stop", []);
      chat.settle({ requestId: "stop", state: "delivered" }, -1);
      const afterStop = ids(chat);

      // A delivery removes the comments it carried and nothing written meanwhile,
      // even when the typed text changed during the send.
      revision = chat.getSnapshot().draft.revision;
      chat.markSubmitting("ok", chat.getSnapshot().draft.comments);
      chat.update({ text: "typed during the send" });
      chat.editComments((now: { id: string }[]) => [...now.map((item) => (item.id === "two" ? { ...item, text: "reworded" } : item)), c("late", 9)]);
      chat.settle({ requestId: "ok", state: "delivered" }, revision);
      const afterDelivery = { chat: ids(chat), terminal: ids(terminal), text: chat.getSnapshot().draft.text, texts: chat.getSnapshot().draft.comments.map((item: { text: string }) => item.text) };

      // Queued counts as delivered; discarding drops the comments with the draft.
      revision = chat.getSnapshot().draft.revision;
      chat.markSubmitting("queued", chat.getSnapshot().draft.comments);
      chat.settle({ requestId: "queued", state: "queued" }, revision);
      const afterQueue = ids(chat);
      chat.editComments(() => [c("again", 5)]);
      chat.discard();
      const afterDiscard = ids(chat);
      chat.editComments(() => [c("kept", 6)]);
      await chat.flush();
      return { staged, listed, afterFailure, afterUnknown, afterStop, afterDelivery, afterQueue, afterDiscard };
    }, DRAFTS);

    expect(result.staged).toEqual({ chat: ["one", "two"], terminal: ["one", "two"], other: [], revision: 1 });
    expect(result.listed).toEqual([["host/review/conversation", 2]]);
    expect(result.afterFailure).toEqual(["one", "two"]);
    expect(result.afterUnknown).toEqual(["one", "two"]);
    expect(result.afterStop).toEqual(["one", "two"]);
    expect(result.afterDelivery).toEqual({ chat: ["two", "late"], terminal: ["two", "late"], text: "typed during the send", texts: ["reworded", "late"] });
    expect(result.afterQueue).toEqual([]);
    expect(result.afterDiscard).toEqual([]);

    await page.reload();
    const restored = await page.evaluate(async (mod) => {
      const { draftStore } = await import(mod);
      const chat = draftStore(["host", "review", "conversation"]);
      const terminal = draftStore(["host", "review", "terminal"]);
      await chat.flush();
      await terminal.flush();
      return { chat: chat.getSnapshot().draft.comments, terminal: terminal.getSnapshot().draft.comments };
    }, DRAFTS);
    expect(restored.chat).toEqual([{ id: "kept", path: "a.ts", line: 6, side: "new", text: "kept" }]);
    expect(restored.terminal).toEqual(restored.chat);
  });
});
