// Локальный просмотр: собирает сайт и отдаёт dist/ на http://localhost:4173 (bun run dev).
import path from "node:path";
import { fileURLToPath } from "node:url";

await import("./build.mjs");

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const port = Number(process.env.PORT || 4173);

Bun.serve({
  port,
  async fetch(req) {
    let rel = decodeURIComponent(new URL(req.url).pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.join(DIST, path.normalize(rel));
    if (file.startsWith(DIST + path.sep) || file === DIST) {
      const f = Bun.file(file);
      if (await f.exists()) return new Response(f);
    }
    return new Response(Bun.file(path.join(DIST, "404.html")), { status: 404 });
  },
});

console.log(`http://localhost:${port}/`);
