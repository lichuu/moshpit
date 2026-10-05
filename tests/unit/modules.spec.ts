import { test, expect } from "@playwright/test";
import { DEV_URL } from "../../playwright.config";

// Resolved by vite in the browser, not by tsc, so they are passed as data.
const DRAFTS = "/src/lib/moshpit/drafts.ts";
const SESSION = "/src/lib/moshpit/session.ts";
const LINK_TARGET = "/src/components/moshpit/link-target.ts";
const KEYS = "/src/lib/moshpit/keys.ts";
const BRIDGE = "/src/lib/moshpit/bridge.ts";
const ASK_KEYS = "/src/lib/moshpit/ask-keys.ts";
const KEY_QUEUE = "/src/lib/moshpit/key-queue.ts";
const COMMANDS = "/src/lib/moshpit/commands.ts";
const BUILTINS = "/src/lib/moshpit/builtin-commands.ts";

// Viewport is irrelevant to a module test, so run these once rather than
// once per project.
test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "module specs are viewport-independent");
});

// These exercise modules rather than the UI, but still need a browser: drafts
// persists through IndexedDB, and both are imported from source, so they run
// against the dev server instead of the production build.
test.describe("draft store", () => {
  test("keeps newer typing across a settle, and recovers after a reload", async ({ page }) => {
    await page.goto(`${DEV_URL}/`);

    const result = await page.evaluate(async (mod) => {
      const { draftStore, listDrafts } = await import(mod);
      const first = draftStore(["host", "session", "conversation"]);
      first.update({
        text: "first",
        attachment: new File(["image bytes"], "draft.png", { type: "image/png" }),
      });
      await first.flush();

      // A receipt that settles an older revision must not clobber what was
      // typed while the send was in flight.
      const revision = first.getSnapshot().draft.revision;
      first.markSubmitting("one");
      first.update({ text: "newer typing" });
      first.settle({ requestId: "one", state: "delivered" }, revision);
      const newerPreserved = first.getSnapshot().draft.text;

      first.markSubmitting("two");
      first.settle(
        { requestId: "two", state: "failed", message: "offline" },
        first.getSnapshot().draft.revision,
      );
      const failedPreserved = first.getSnapshot().draft.text;

      const terminal = draftStore(["host", "session", "terminal"]);
      terminal.update({ text: "terminal draft" });
      await terminal.flush();
      const other = draftStore(["host", "other", "conversation"]);
      other.update({ text: "old session" });
      await other.flush();

      // A queued or delivered send clears the draft it consumed.
      const clear = draftStore(["host", "clear", "conversation"]);
      clear.update({ text: "clear me" });
      clear.markSubmitting("clear");
      clear.settle(
        { requestId: "clear", state: "queued" },
        clear.getSnapshot().draft.revision,
      );
      await clear.flush();

      return {
        newerPreserved,
        failedPreserved,
        cleared: clear.getSnapshot().draft.text,
        recovered: (await listDrafts()).length,
      };
    }, DRAFTS);

    expect(result).toEqual({
      newerPreserved: "newer typing",
      failedPreserved: "newer typing",
      cleared: "",
      recovered: 3,
    });

    // Drafts are the thing you would be angriest to lose, so they have to
    // survive the tab closing.
    await page.reload();
    const restored = await page.evaluate(async (mod) => {
      const { draftStore } = await import(mod);
      const first = draftStore(["host", "session", "conversation"]);
      await first.flush();
      const draft = first.getSnapshot().draft;
      const terminal = draftStore(["host", "session", "terminal"]);
      await terminal.flush();
      return {
        text: draft.text,
        name: draft.attachment?.name,
        bytes: await draft.attachment?.text(),
        terminal: terminal.getSnapshot().draft.text,
        terminalImage: terminal.getSnapshot().draft.attachment?.name,
      };
    }, DRAFTS);

    expect(restored.text).toBe("newer typing");
    expect(restored.name).toBe("draft.png");
    expect(restored.bytes).toBe("image bytes");
    // Terminal and conversation keep separate text for the same agent, and
    // share the session's image.
    expect(restored.terminal).toBe("terminal draft");
    expect(restored.terminalImage).toBe("draft.png");
  });

  test("a session's image is shared by both views until one of them sends it", async ({ page }) => {
    await page.goto(`${DEV_URL}/`);

    const result = await page.evaluate(async (mod) => {
      const { draftStore, listDrafts } = await import(mod);
      const image = (name: string) => new File([name], name, { type: "image/png" });
      const chat = draftStore(["host", "shared", "conversation"]);
      const terminal = draftStore(["host", "shared", "terminal"]);
      const elsewhere = draftStore(["host", "elsewhere", "terminal"]);
      const name = (store: typeof chat) => store.getSnapshot().draft.attachment?.name ?? null;

      chat.update({ text: "chat text", attachment: image("one.png") });
      const attached = [name(chat), name(terminal), name(elsewhere)];
      const terminalText = terminal.getSnapshot().draft.text;
      await chat.flush();
      const listed = (await listDrafts()).filter((item: { draft: { attachment: File | null } }) => item.draft.attachment).length;

      // The other view swaps the image while this one's send is in flight:
      // the delivery clears what it sent, not the replacement.
      let revision = chat.getSnapshot().draft.revision;
      chat.markSubmitting("one");
      terminal.update({ attachment: image("two.png") });
      chat.settle({ requestId: "one", state: "delivered" }, revision);
      const replaced = [chat.getSnapshot().draft.text, name(chat), name(terminal)];

      revision = terminal.getSnapshot().draft.revision;
      terminal.markSubmitting("two");
      terminal.settle({ requestId: "two", state: "delivered" }, revision);
      const sent = [name(chat), name(terminal)];
      await terminal.flush();
      return { attached, terminalText, listed, replaced, sent };
    }, DRAFTS);

    expect(result).toEqual({
      attached: ["one.png", "one.png", null],
      terminalText: "",
      listed: 1,
      replaced: ["", "two.png", "two.png"],
      sent: [null, null],
    });

    await page.reload();
    const restored = await page.evaluate(async (mod) => {
      const { draftStore } = await import(mod);
      const chat = draftStore(["host", "shared", "conversation"]);
      await chat.flush();
      return chat.getSnapshot().draft.attachment?.name ?? null;
    }, DRAFTS);
    expect(restored).toBeNull();
  });

  test("an image saved in a view's own record moves to the session", async ({ page }) => {
    await page.goto(`${DEV_URL}/`);

    const names = await page.evaluate(async (mod) => {
      const { draftStore } = await import(mod);
      const key = JSON.stringify(["host", "legacy", "terminal"]);
      await draftStore(["host", "warm", "conversation"]).flush();
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("moshpit-drafts", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const record = () => new Promise<{ attachment: File | null }>((resolve, reject) => {
        const request = db.transaction("drafts").objectStore("drafts").get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("drafts", "readwrite");
        transaction.objectStore("drafts").put({ text: "old", attachment: new File(["x"], "old.png", { type: "image/png" }), revision: 1 }, key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      const terminal = draftStore(["host", "legacy", "terminal"]);
      const chat = draftStore(["host", "legacy", "conversation"]);
      await terminal.flush();
      await chat.flush();
      return {
        terminal: [terminal.getSnapshot().draft.text, terminal.getSnapshot().draft.attachment?.name],
        chat: chat.getSnapshot().draft.attachment?.name,
        record: (await record()).attachment,
      };
    }, DRAFTS);

    expect(names).toEqual({ terminal: ["old", "old.png"], chat: "old.png", record: null });
  });
});

test.describe("session merge", () => {
  test("a reset during pagination replaces the abandoned branch", async ({ page }) => {
    await page.goto(`${DEV_URL}/`);

    const result = await page.evaluate(async (mod) => {
      const { mergeSession } = await import(mod);
      const entry = (id: string, text: string) => ({
        id,
        turnId: "t",
        kind: "message",
        role: "assistant",
        text,
      });
      const previous = {
        kind: "available",
        agentId: "pane",
        sessionId: "session",
        entries: [entry("old", "abandoned branch")],
        cursor: "old",
        before: "older",
        reset: false,
        capabilities: { inputModes: ["send"], stop: false, fit: false },
      };
      const reset = {
        ...previous,
        entries: [entry("new", "active branch")],
        cursor: "new",
        before: null,
        reset: true,
      };
      return mergeSession(previous, reset, true);
    }, SESSION);

    // Keeping the old entries here would splice a dead branch of the
    // conversation into the live one.
    expect(result.entries.map((e: { text: string }) => e.text)).toEqual(["active branch"]);
    expect(result.cursor).toBe("new");
  });

  test("an unchanged poll keeps the previous session object", async ({ page }) => {
    await page.goto(`${DEV_URL}/`);

    const result = await page.evaluate(async (mod) => {
      const { mergeSession } = await import(mod);
      const entry = (id: string, text: string) => ({
        id,
        turnId: "t",
        kind: "message",
        role: "assistant",
        text,
      });
      const previous = {
        kind: "available",
        agentId: "pane",
        sessionId: "session",
        entries: [entry("one", "hello")],
        cursor: "c1",
        before: "older",
        reset: false,
        capabilities: { inputModes: ["send"], stop: false, fit: false },
      };
      const empty = {
        ...previous,
        entries: [],
        cursor: "c1",
        before: null,
        reset: false,
      };
      const merged = mergeSession(previous, empty, false);
      const updated = {
        ...previous,
        entries: [entry("one", "hello"), entry("two", "there")],
        cursor: "c2",
      };
      const grown = mergeSession(previous, updated, false);
      return {
        sameObject: merged === previous,
        sameEntries: merged.entries === previous.entries,
        grownCount: grown.entries.length,
        grownSame: grown === previous,
      };
    }, SESSION);

    expect(result.sameObject).toBe(true);
    expect(result.sameEntries).toBe(true);
    expect(result.grownCount).toBe(2);
    expect(result.grownSame).toBe(false);
  });

  // S6: a poll that re-sends entries the reader already has must not read as
  // new activity, but a cursor move or a changed field still has to land.
  test("repeated nonempty content keeps entry identity; metadata and changes still land", async ({ page }) => {
    await page.goto(`${DEV_URL}/`);

    const result = await page.evaluate(async (mod) => {
      const { mergeSession } = await import(mod);
      const message = (id: string, text: string) => ({ id, turnId: "t", kind: "message", role: "assistant", text });
      const question = (resolved: boolean, answers?: string[]) => ({
        id: "q", turnId: "t", kind: "question", title: "Ask", resolved,
        questions: [{ text: "Pick", multi: false, options: [{ label: "A" }, { label: "B" }], ...(answers ? { answers } : {}) }],
      });
      const previous = {
        kind: "available", agentId: "pane", sessionId: "session",
        entries: [message("one", "hello"), message("two", "there"), question(false)],
        cursor: "c2", before: "older", reset: false,
        capabilities: { inputModes: ["send"], stop: false, fit: false },
      };
      // The same tail again, freshly parsed so no object is shared.
      const repeat = { ...previous, entries: [message("two", "there"), question(false)], before: null };
      const repeated = mergeSession(previous, repeat, false);
      const moved = mergeSession(previous, { ...repeat, cursor: "c3" }, false);
      const emptyMoved = mergeSession(previous, { ...repeat, entries: [], cursor: "c3" }, false);
      const capable = mergeSession(previous, { ...repeat, capabilities: { inputModes: ["send"], stop: true, fit: false } }, false);
      const edited = mergeSession(previous, { ...repeat, entries: [message("two", "there!"), question(false)] }, false);
      const answered = mergeSession(previous, { ...repeat, entries: [question(true, ["B"])] }, false);
      const older = mergeSession(previous, { ...previous, entries: [message("one", "hello")], before: "oldest" }, true);
      return {
        repeatedSame: repeated === previous,
        movedCursor: moved.cursor,
        movedEntriesSame: moved.entries === previous.entries,
        emptyMovedCursor: emptyMoved.cursor,
        emptyMovedEntriesSame: emptyMoved.entries === previous.entries,
        capableStop: capable.capabilities.stop,
        capableEntriesSame: capable.entries === previous.entries,
        editedFirstSame: edited.entries[0] === previous.entries[0],
        editedSecondSame: edited.entries[1] === previous.entries[1],
        editedText: edited.entries[1].text,
        answeredQuestionSame: answered.entries[2] === previous.entries[2],
        answeredResolved: answered.entries[2].resolved,
        olderBefore: older.before,
        olderEntriesSame: older.entries === previous.entries,
      };
    }, SESSION);

    expect(result.repeatedSame).toBe(true);
    expect(result.movedCursor).toBe("c3");
    expect(result.movedEntriesSame).toBe(true);
    expect(result.emptyMovedCursor).toBe("c3");
    expect(result.emptyMovedEntriesSame).toBe(true);
    expect(result.capableStop).toBe(true);
    expect(result.capableEntriesSame).toBe(true);
    expect(result.editedFirstSame).toBe(true);
    expect(result.editedSecondSame).toBe(false);
    expect(result.editedText).toBe("there!");
    expect(result.answeredQuestionSame).toBe(false);
    expect(result.answeredResolved).toBe(true);
    // A prepend of an entry already held moves the history bound only.
    expect(result.olderBefore).toBe("oldest");
    expect(result.olderEntriesSame).toBe(true);
  });
});

test.describe("chat markdown links", () => {
  test("only http(s) and uploaded images are live", async ({ page }) => {
    await page.goto(`${DEV_URL}/`);
    const result = await page.evaluate(async (mod) => {
      const { linkTarget } = await import(mod);
      return {
        https: linkTarget("https://example.com/docs"),
        http: linkTarget("http://127.0.0.1:8080"),
        upload: linkTarget("/api/upload?path=tiny.png"),
        file: linkTarget("file:///etc/passwd"),
        relative: linkTarget("../src/app.ts"),
        abs: linkTarget("/home/you/projects/moshpit/README.md"),
        user: linkTarget("https://user:secret@example.com"),
      };
    }, LINK_TARGET);
    expect(result.https).toBe("anchor");
    expect(result.http).toBe("anchor");
    expect(result.upload).toBe("image");
    expect(result.file).toBe("inert");
    expect(result.relative).toBe("inert");
    expect(result.abs).toBe("inert");
    expect(result.user).toBe("inert");
  });
});

test.describe("pane keys", () => {
  test("Shift+Tab is named and Home is reported, not typed", async ({ page }) => {
    await page.goto(`${DEV_URL}/`);
    const result = await page.evaluate(async (mod) => {
      const { parsePaneKey } = await import(mod);
      const event = (partial: Record<string, unknown>) => ({
        key: "",
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        ...partial,
      });
      return {
        tab: parsePaneKey(event({ key: "Tab" })),
        shiftTab: parsePaneKey(event({ key: "Tab", shiftKey: true })),
        home: parsePaneKey(event({ key: "Home" })),
        copy: parsePaneKey(event({ key: "c", ctrlKey: true, metaKey: false })),
        letter: parsePaneKey(event({ key: "a" })),
      };
    }, KEYS);
    expect(result.tab).toEqual({ kind: "deliver", value: "\t" });
    expect(result.shiftTab).toEqual({ kind: "deliver", value: "shift+tab" });
    expect(result.home).toEqual({ kind: "unsupported", label: "Home" });
    expect(result.copy).toEqual({ kind: "ignore" });
    expect(result.letter).toEqual({ kind: "deliver", value: "a" });
  });

  // An unsupported modifier combination must be reported, never silently
  // weakened into a different key. Ctrl+Enter delivering a bare \r submits
  // whatever the agent had staged.
  test("a modifier combination is never reduced to a different operation", async ({ page }) => {
    const matrix: [string, Record<string, unknown>, unknown][] = [
      ["Ctrl+ArrowUp", { key: "ArrowUp", ctrlKey: true }, { kind: "unsupported", label: "Ctrl+ArrowUp" }],
      ["Shift+Enter", { key: "Enter", shiftKey: true }, { kind: "unsupported", label: "Shift+Enter" }],
      ["Ctrl+Enter", { key: "Enter", ctrlKey: true }, { kind: "unsupported", label: "Ctrl+Enter" }],
      ["Meta+Enter", { key: "Enter", metaKey: true }, { kind: "unsupported", label: "Meta+Enter" }],
      ["Ctrl+Tab", { key: "Tab", ctrlKey: true }, { kind: "unsupported", label: "Ctrl+Tab" }],
      ["Ctrl+Backspace", { key: "Backspace", ctrlKey: true }, { kind: "unsupported", label: "Ctrl+Backspace" }],
      ["Alt+Backspace", { key: "Backspace", altKey: true }, { kind: "unsupported", label: "Alt+Backspace" }],
      ["Tab", { key: "Tab" }, { kind: "deliver", value: "\t" }],
      ["Shift+Tab", { key: "Tab", shiftKey: true }, { kind: "deliver", value: "shift+tab" }],
      ["Enter", { key: "Enter" }, { kind: "deliver", value: "\r" }],
      ["Alt+Enter", { key: "Enter", altKey: true }, { kind: "deliver", value: "alt+enter" }],
      ["Backspace", { key: "Backspace" }, { kind: "deliver", value: "\x7f" }],
      ["Escape", { key: "Escape" }, { kind: "deliver", value: "\x1b" }],
      ["ArrowUp", { key: "ArrowUp" }, { kind: "deliver", value: "up" }],
      ["Shift+ArrowUp", { key: "ArrowUp", shiftKey: true }, { kind: "unsupported", label: "Shift+ArrowUp" }],
      ["Ctrl+c", { key: "c", ctrlKey: true }, { kind: "ignore" }],
      ["Ctrl+v", { key: "v", ctrlKey: true }, { kind: "ignore" }],
      ["Ctrl+b", { key: "b", ctrlKey: true }, { kind: "deliver", value: "\x02" }],
      ["letter", { key: "a" }, { kind: "deliver", value: "a" }],
      ["Shift+letter", { key: "A", shiftKey: true }, { kind: "deliver", value: "A" }],
      ["Delete", { key: "Delete" }, { kind: "unsupported", label: "Delete" }],
      ["composing", { key: "Enter", nativeEvent: { isComposing: true } }, { kind: "ignore" }],
      // Holding a modifier down is not an unsupported combination; reporting
      // one toasts every time the user reaches for Ctrl.
      ["bare Shift", { key: "Shift", shiftKey: true }, { kind: "ignore" }],
      ["bare Control", { key: "Control", ctrlKey: true }, { kind: "ignore" }],
      ["bare Alt", { key: "Alt", altKey: true }, { kind: "ignore" }],
      ["bare Meta", { key: "Meta", metaKey: true }, { kind: "ignore" }],
    ];
    await page.goto(`${DEV_URL}/`);
    const actual = await page.evaluate(
      async ([mod, rows]) => {
        const { parsePaneKey } = await import(mod as string);
        return (rows as [string, Record<string, unknown>, unknown][]).map(([, partial]) =>
          parsePaneKey({ key: "", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...partial }),
        );
      },
      [KEYS, matrix] as const,
    );
    expect(Object.fromEntries(matrix.map(([name], i) => [name, actual[i]]))).toEqual(
      Object.fromEntries(matrix.map(([name, , expected]) => [name, expected])),
    );
  });
});

test.describe("bridge responses", () => {
  // These responses carry credentials and terminal tickets. A cast would let a
  // wrong-shaped body reach localStorage or a WebSocket URL.
  test("a malformed response is refused instead of used", async ({ page }) => {
    await page.goto(`${DEV_URL}/`);
    const result = await page.evaluate(async (mod) => {
      const { fetchVapid, discoverAccess } = await import(mod);
      const reply = (body: unknown) => {
        window.fetch = (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;
      };
      const outcome = async (fn: () => Promise<unknown>) => {
        try {
          return { ok: true, message: '', value: await fn() };
        } catch (e) {
          return { ok: false, message: (e as Error).message, value: null };
        }
      };
      const host = 'http://127.0.0.1:1';
      reply({ publicKey: 'a-real-key' });
      const good = await outcome(() => fetchVapid(host));
      reply({});
      const missing = await outcome(() => fetchVapid(host));
      reply({ publicKey: 123 });
      const wrongType = await outcome(() => fetchVapid(host));
      reply({ protocol: '2', requiredFactors: [] });
      const badProtocol = await outcome(() => discoverAccess(host));
      return { good, missing, wrongType, badProtocol };
    }, BRIDGE);
    expect(result.good.ok).toBe(true);
    expect(result.good.value).toEqual({ publicKey: "a-real-key" });
    expect(result.missing.ok).toBe(false);
    expect(result.missing.message).toContain("unusable vapid response");
    expect(result.wrongType.ok).toBe(false);
    expect(result.badProtocol.ok).toBe(false);
    expect(result.badProtocol.message).toContain("unusable auth info response");
  });
});

test.describe("ask-user option keys", () => {
  test("codex and claude send the bare digit; pi uses its submit key", async ({ page }) => {
    await page.goto(`${DEV_URL}/`);

    const result = await page.evaluate(async (mod) => {
      const { askOptionKeys } = await import(mod);
      const question = { text: "Which one?", multi: false, options: [{ label: "green" }, { label: "mauve" }] };
      return {
        codex: askOptionKeys("codex", question, 1),
        claude: askOptionKeys("claude", question, 1),
        pi: askOptionKeys("pi", question, 1),
        unknown: askOptionKeys("opencode", question, 0),
        keyLike: askOptionKeys("opencode", { ...question, options: [{ label: "Enter" }] }, 0),
      };
    }, ASK_KEYS);
    // Digits and labels are marked text, so the bridge types them rather than
    // guessing; a label reading "Enter" must not press Enter.
    expect(result.codex).toEqual([{ text: "2" }]);
    expect(result.claude).toEqual([{ text: "2" }]);
    expect(result.pi).toEqual(["down", "enter"]);
    expect(result.unknown).toEqual([{ text: "green" }, "enter"]);
    expect(result.keyLike).toEqual([{ text: "Enter" }, "enter"]);
  });
});

test.describe("command catalog", () => {
  test("merges built-ins with host skills across prefixes", async ({ page }) => {
    await page.goto(`${DEV_URL}/`);

    const result = await page.evaluate(async ([commandsMod, builtinsMod]) => {
      const { mergeCatalog, detectCommandToken, matchCommands } = await import(commandsMod);
      const { builtinCommands, collisionPolicy } = await import(builtinsMod);
      const skill = (prefix: string, name: string) => ({ name, invocation: `${prefix}${name}`, description: "" });

      // Codex: $ skills beside / built-ins.
      const codex = mergeCatalog(builtinCommands("codex"), {
        prefixes: ["$"], coverage: "full", commands: [skill("$", "deploy")],
      })!;
      const dollar = detectCommandToken("run $dep", 8, codex.prefixes);
      const slash = detectCommandToken("/mo", 3, codex.prefixes);

      // Claude: a skill named like a built-in wins, and there is one row for it.
      const claude = mergeCatalog(builtinCommands("claude"), {
        prefixes: ["/"], coverage: "full", commands: [{ ...skill("/", "review"), description: "my review" }],
      })!;
      const reviews = claude.commands.filter((c: { invocation: string }) => c.invocation === "/review");

      // Pi: built-ins and / templates beside /skill: skills. A template named
      // like a built-in is shadowed, as in pi.
      const pi = mergeCatalog(builtinCommands("pi"), {
        prefixes: ["/skill:", "/"], coverage: "partial",
        commands: [skill("/skill:", "notes"), skill("/", "fix-tests"), { ...skill("/", "model"), description: "mine" }],
      }, collisionPolicy("pi"))!;
      const piSkillToken = detectCommandToken("/skill:no", 9, pi.prefixes);

      // Grok: the built-in keeps /compact and a same-named skill moves to
      // /user:compact, still reachable.
      const grok = mergeCatalog(builtinCommands("grok"), {
        prefixes: ["/"], coverage: "partial", commands: [skill("/", "compact"), skill("/", "commit")],
      }, collisionPolicy("grok"))!;

      return {
        codexPrefixes: [...codex.prefixes].sort(),
        codexCoverage: codex.coverage,
        dollar: dollar && matchCommands(codex.commands, dollar.prefix, "dep").map((c: { invocation: string }) => c.invocation),
        slash: slash && matchCommands(codex.commands, slash.prefix, "mo").map((c: { invocation: string }) => c.invocation),
        reviewCount: reviews.length,
        reviewDescription: reviews[0]?.description,
        claudeAll: matchCommands(claude.commands, "/", "").length,
        pi: {
          prefixes: pi.prefixes,
          coverage: pi.coverage,
          model: pi.commands.filter((c: { invocation: string }) => c.invocation === "/model").map((c: { description: string }) => c.description),
          template: pi.commands.some((c: { invocation: string }) => c.invocation === "/fix-tests"),
          skillToken: piSkillToken?.prefix,
          skills: piSkillToken && matchCommands(pi.commands, piSkillToken.prefix, "no").map((c: { invocation: string }) => c.invocation),
        },
        grok: {
          prefixes: grok.prefixes,
          compact: grok.commands.filter((c: { name: string }) => c.name === "compact").map((c: { invocation: string; origin?: string }) => [c.invocation, c.origin ?? "skill"]),
          commit: grok.commands.some((c: { invocation: string }) => c.invocation === "/commit"),
        },
        shell: mergeCatalog(builtinCommands("shell"), undefined) ?? null,
      };
    }, [COMMANDS, BUILTINS]);

    expect(result.codexPrefixes).toEqual(["$", "/"]);
    // A hand-kept built-in list is never the whole catalog.
    expect(result.codexCoverage).toBe("partial");
    expect(result.dollar).toEqual(["$deploy"]);
    expect(result.slash).toEqual(["/model"]);
    expect(result.reviewCount).toBe(1);
    expect(result.reviewDescription).toBe("my review");
    // More than the old eight-row cap, all of it reachable.
    expect(result.claudeAll).toBeGreaterThan(8);
    expect(result.pi).toEqual({
      prefixes: ["/skill:", "/"],
      coverage: "partial",
      model: ["Select a model"],
      template: true,
      skillToken: "/skill:",
      skills: ["/skill:notes"],
    });
    expect(result.grok.prefixes).toEqual(["/user:", "/"]);
    expect(result.grok.compact).toEqual([["/compact", "built-in"], ["/user:compact", "skill"]]);
    expect(result.grok.commit).toBe(true);
    expect(result.shell).toBeNull();
  });

  test("scoped catalogs validate exact scope, bounded metadata and no clipping", async ({ page }) => {
    await page.goto(`${DEV_URL}/`);

    const result = await page.evaluate(async ([commandsMod]) => {
      const { parseScopedCommandsResponse, commandScope } = await import(commandsMod);
      const scope = { target: "w1:p1", sessionId: "sess-1", project: JSON.stringify([null, "/repo/app"]) };
      const wire = (over: Record<string, unknown> = {}) => ({
        scope,
        revision: "a".repeat(64),
        coverage: "partial",
        truncated: false,
        prefixes: ["/"],
        commands: [{ name: "deploy", invocation: "/deploy", description: "Ship it.", origin: "home-skills" }],
        warnings: [],
        ...over,
      });
      const ok = parseScopedCommandsResponse(wire(), scope);
      const throws = (value: unknown) => {
        try {
          parseScopedCommandsResponse(value, scope);
          return false;
        } catch {
          return true;
        }
      };
      return {
        scope: ok.scope,
        revision: ok.revision,
        truncated: ok.truncated,
        warnings: ok.warnings,
        catalog: ok.catalog,
        wrongTarget: throws(wire({ scope: { ...scope, target: "w9:p9" } })),
        wrongSession: throws(wire({ scope: { ...scope, sessionId: "other" } })),
        wrongProject: throws(wire({ scope: { ...scope, project: JSON.stringify([null, "/repo/other"]) } })),
        missingScope: throws(wire({ scope: undefined })),
        missingRevision: throws(wire({ revision: "" })),
        badCoverage: throws(wire({ coverage: "maybe" })),
        badTruncated: throws(wire({ truncated: "yes" })),
        badPrefix: throws(wire({ prefixes: ["%"] })),
        noPrefixes: throws(wire({ prefixes: [] })),
        unsupportedWithCommands: throws(wire({ coverage: "unsupported", prefixes: [], commands: [{ name: "d", invocation: "/d", description: "", origin: "home-skills" }] })),
        overlongInvocation: throws(wire({ commands: [{ name: "d", invocation: "/" + "i".repeat(101), description: "", origin: "home-skills" }] })),
        whitespaceInvocation: throws(wire({ commands: [{ name: "d", invocation: "/d e", description: "", origin: "home-skills" }] })),
        foreignInvocation: throws(wire({ commands: [{ name: "d", invocation: "$d", description: "", origin: "home-skills" }] })),
        missingOrigin: throws(wire({ commands: [{ name: "d", invocation: "/d", description: "" }] })),
        tooMany: throws(wire({ commands: Array.from({ length: 201 }, (_, i) => ({ name: `c${i}`, invocation: `/c${i}`, description: "", origin: "home-skills" })) })),
        longWarningsTrimmed: parseScopedCommandsResponse(wire({ warnings: Array.from({ length: 40 }, (_, i) => `w${i}`) }), scope).warnings.length,
        unsupported: parseScopedCommandsResponse(wire({ coverage: "unsupported", prefixes: [], commands: [] }), scope).catalog,
        scopeFromAgent: commandScope({ id: "w1:p1", sessionId: "sess-1", cwd: "/repo/app", projectRoot: "/repo" }),
        noSession: commandScope({ id: "w1:p1", cwd: "/repo/app" }),
        noCwd: commandScope({ id: "w1:p1", sessionId: "sess-1", cwd: "" }),
      };
    }, [COMMANDS]);

    expect(result.scope).toEqual({ target: "w1:p1", sessionId: "sess-1", project: JSON.stringify([null, "/repo/app"]) });
    expect(result.revision).toBe("a".repeat(64));
    expect(result.truncated).toBe(false);
    expect(result.catalog).toEqual({
      prefixes: ["/"],
      commands: [{ name: "deploy", invocation: "/deploy", description: "Ship it.", origin: "home-skills" }],
      coverage: "partial",
    });
    for (const key of [
      "wrongTarget", "wrongSession", "wrongProject", "missingScope", "missingRevision",
      "badCoverage", "badTruncated", "badPrefix", "noPrefixes", "unsupportedWithCommands",
      "overlongInvocation", "whitespaceInvocation", "foreignInvocation", "missingOrigin", "tooMany",
    ] as const) {
      expect(result[key], key).toBe(true);
    }
    expect(result.longWarningsTrimmed).toBe(16);
    expect(result.unsupported).toEqual({ prefixes: [], commands: [], coverage: "unsupported" });
    expect(result.scopeFromAgent).toEqual({ target: "w1:p1", sessionId: "sess-1", project: JSON.stringify(["/repo", "/repo/app"]) });
    expect(result.noSession).toBeNull();
    expect(result.noCwd).toBeNull();
  });
});

test.describe("terminal key queue", () => {
  test("sends in press order, batches typed text, and drops what is left after a failure", async ({ page }) => {
    await page.goto(`${DEV_URL}/`);
    const result = await page.evaluate(async (mod) => {
      const { createKeyQueue, nextBatch } = await import(mod);
      const sent: unknown[] = [];
      const dropped: string[] = [];
      let release: () => void = () => {};
      let fail = false;
      const queue = createKeyQueue(
        (keys: unknown) => {
          sent.push(keys);
          if (fail) return Promise.reject(new Error("offline"));
          return new Promise<void>((resolve) => { release = resolve; });
        },
        (error: Error) => dropped.push(error.message),
      );
      queue.push("l");
      // Pressed while "l" is in flight: one request, typed runs merged.
      for (const key of ["s", " ", "-", "a", "\r", "u", "p"]) queue.push(key);
      const whileBusy = sent.length;
      release();
      await new Promise((r) => setTimeout(r, 0));
      fail = true;
      release();
      await new Promise((r) => setTimeout(r, 0));
      queue.push("x");
      queue.push("y");
      await new Promise((r) => setTimeout(r, 0));
      const afterFailure = sent.length;
      queue.close();
      queue.push("z");
      return {
        whileBusy,
        sent,
        dropped,
        afterFailure,
        cap: nextBatch(Array.from({ length: 20 }, () => "enter")).length,
        long: nextBatch(Array.from({ length: 4097 }, () => "a")),
      };
    }, KEY_QUEUE);
    expect(result.whileBusy).toBe(1);
    expect(result.sent.slice(0, 2)).toEqual([[{ text: "l" }], [{ text: "s -a" }, "\r", { text: "up" }]]);
    // "x" failed and "y", queued behind it, was dropped rather than replayed.
    expect(result.sent[2]).toEqual([{ text: "x" }]);
    expect(result.afterFailure).toBe(3);
    expect(result.dropped).toEqual(["offline"]);
    expect(result.sent).toHaveLength(3);
    expect(result.cap).toBe(16);
    // A text run stops at the bridge's 4096-character cap and starts a new one.
    expect(result.long).toEqual([{ text: "a".repeat(4096) }, { text: "a" }]);
  });
});
