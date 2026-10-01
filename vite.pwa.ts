import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Plugin } from "vite";

export function pwaAssets(): Plugin {
  return {
    name: "moshpit-offline-shell",
    apply: "build",
    enforce: "post",
    async generateBundle(_options, bundle) {
      const worker = await readFile(
        new URL("./public/sw.js", import.meta.url),
        "utf8",
      );
      const publicFiles = [
        "manifest.webmanifest",
        "favicon.svg",
        "icon-192.png",
        "icon-512.png",
        "icon-maskable-512.png",
        "apple-touch-icon.png",
      ];
      const hash = createHash("sha256").update(worker);
      for (const file of Object.values(bundle))
        hash.update(file.type === "chunk" ? file.code : file.source);
      for (const file of publicFiles)
        hash.update(
          await readFile(new URL(`./public/${file}`, import.meta.url)),
        );
      const urls = [
        ...new Set([
          "index.html",
          ...Object.keys(bundle).filter((file) => !file.endsWith(".map")),
          ...publicFiles,
        ]),
      ].map((file) => `/${file}`);
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: worker
          .replace("__BUILD_ID__", hash.digest("hex").slice(0, 16))
          .replace(
            "const PRECACHE = [];",
            `const PRECACHE = ${JSON.stringify(urls)};`,
          ),
      });
    },
  };
}
