#!/usr/bin/env node
// Read-only health check for a moshpit verification instance.
// Usage: node helpers/doctor.mjs [port]   (default 8188)
import http from "node:http";
import net from "node:net";
import { execFileSync } from "node:child_process";

const port = Number(process.argv[2] ?? 8188);
const failures = [];
const ok = (line) => console.log(`ok   ${line}`);
const bad = (line) => {
  failures.push(line);
  console.log(`FAIL ${line}`);
};

// 1. Port answering
const tcp = await new Promise((resolve) => {
  const s = net.connect({ port, host: "127.0.0.1" });
  s.once("connect", () => {
    s.destroy();
    resolve(true);
  });
  s.once("error", () => resolve(false));
});
if (tcp) ok(`port ${port} is answering`);
else bad(`port ${port} not answering`);

// 2. Root page serves the app
if (tcp) {
  const body = await new Promise((resolve) => {
    http
      .get({ host: "127.0.0.1", port, path: "/" }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, data }));
      })
      .on("error", (e) => resolve({ status: 0, data: `E ${e.message}` }));
  });
  if (body.status !== 200) bad(`GET / returned ${body.status}`);
  else ok("GET / returned 200");
  if (!/moshpit/i.test(body.data))
    bad("root HTML does not mention moshpit (wrong app on this port?)");
  else ok("root HTML is the moshpit app");
}

// 3. Who owns the port (warn, not fail)
try {
  const out = execFileSync("ss", ["-ltnp", `sport = :${port}`], {
    encoding: "utf8",
  });
  const m = out.match(/pid=(\d+)/);
  if (m) {
    const cmd = execFileSync("ps", ["-o", "args=", m[1]], {
      encoding: "utf8",
    }).trim();
    if (/vite|node/.test(cmd)) ok(`port owned by our dev server (pid ${m[1]}: ${cmd.slice(0, 60)})`);
    else bad(`port owned by an unexpected process (pid ${m[1]}: ${cmd.slice(0, 60)})`);
  } else {
    console.log("warn could not identify port owner via ss");
  }
} catch {
  console.log("warn ss not available; skipped owner check");
}

// 4. Drivability: playwright present and browser installed
try {
  const { chromium } = await import("playwright");
  const version = chromium.executablePath();
  ok(`playwright chromium available (${version})`);
} catch (e) {
  bad(`playwright unusable: ${e.message.split("\n")[0]} (run: npm install --prefix helpers)`);
}

console.log(failures.length ? `\ndoctor: ${failures.length} failure(s)` : "\ndoctor: healthy");
process.exit(failures.length ? 1 : 0);
