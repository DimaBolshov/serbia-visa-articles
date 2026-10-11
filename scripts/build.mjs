// Собирает статичный сайт из articles/*.md в dist/ (запуск: bun run build).
import { Marked } from "marked";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "articles");
const ASSETS = path.join(ROOT, "site");
const OUT = path.join(ROOT, "dist");

const SITE_URL = (process.env.SITE_URL || "https://dimabolshov.github.io/serbia-visa-articles").replace(/\/$/, "");
const BASE_PATH = new URL(SITE_URL).pathname.replace(/\/$/, "");
const REPO_URL = "https://github.com/DimaBolshov/serbia-visa-articles";
const SITE_TITLE = "Визы для россиян, живущих в Сербии";
const SITE_DESC =
  "Статьи о визах для граждан России, проживающих в Сербии: куда и как подаваться, документы, деньги на счёте, сроки и стоимость.";

// Префикс slug → название страны для карточки на главной.
const COUNTRIES = {
  albania: "Албания",
  austria: "Австрия",
  belgium: "Бельгия",
  bulgaria: "Болгария",
  china: "Китай",
  croatia: "Хорватия",
  cyprus: "Кипр",
  france: "Франция",
  germany: "Германия",
  greece: "Греция",
  hungary: "Венгрия",
  italy: "Италия",
  japan: "Япония",
  netherlands: "Нидерланды",
  "north-macedonia": "Северная Македония",
  poland: "Польша",
  portugal: "Португалия",
  romania: "Румыния",
  slovakia: "Словакия",
  slovenia: "Словения",
  spain: "Испания",
  sweden: "Швеция",
  switzerland: "Швейцария",
  "united-kingdom": "Великобритания",
  usa: "США",
};

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const decode = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const norm = (s) => s.toLowerCase().replace(/ё/g, "е");
const slugify = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "section";

// Текст из inline-токенов без разметки; метку `чат` можно выкинуть (для описаний и поиска).
function plain(tokens = [], skipChat = false) {
  return tokens
    .map((t) => {
      if (t.type === "codespan") return skipChat && t.text === "чат" ? "" : t.text;
      if (t.type === "br") return " ";
      if (t.tokens) return plain(t.tokens, skipChat);
      return t.text ?? "";
    })
    .join("");
}
const clean = (s) => decode(s).replace(/\s+/g, " ").trim();

function truncate(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max).replace(/\s+\S*$/, "");
  return cut.replace(/[\s,;:.(—–-]+$/, "") + "…";
}

const renderer = {
  heading({ tokens, depth, id }) {
    const inner = this.parser.parseInline(tokens);
    if (!id) return `<h${depth}>${inner}</h${depth}>\n`;
    return `<h${depth} id="${esc(id)}">${inner}<a class="anchor" href="#${esc(id)}" aria-label="Ссылка на этот раздел">#</a></h${depth}>\n`;
  },
  link({ href, title, tokens }) {
    const text = this.parser.parseInline(tokens);
    const external = /^https?:\/\//i.test(href);
    const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : "";
    return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ""}${attrs}>${text}</a>`;
  },
  codespan({ text }) {
    if (text === "чат") {
      return '<span class="src-chat" title="Сведения из чата заявителей, а не с официальной страницы">чат</span>';
    }
    return `<code>${text}</code>`;
  },
  table(token) {
    const labels = token.header.map((c) => clean(plain(c.tokens)));
    const align = (i) => (token.align[i] ? ` style="text-align:${token.align[i]}"` : "");
    const head = token.header
      .map((c, i) => `<th scope="col"${align(i)}>${this.parser.parseInline(c.tokens)}</th>`)
      .join("");
    const rows = token.rows
      .map(
        (r) =>
          "<tr>" +
          r.map((c, i) => `<td data-label="${esc(labels[i] ?? "")}"${align(i)}>${this.parser.parseInline(c.tokens)}</td>`).join("") +
          "</tr>",
      )
      .join("\n");
    const cols = labels.length;
    const cls = (cols >= 3 ? " wide" : "") + (cols >= 5 ? " many" : "");
    return `<div class="table-wrap${cls}" style="--cols:${cols}"><table><thead><tr>${head}</tr></thead><tbody>\n${rows}\n</tbody></table></div>\n`;
  },
};

function gitDate(file, fallback) {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%cI", "--", `articles/${file}`], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out) return new Date(out);
  } catch {}
  return fallback;
}
const ruDate = (d) => d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

async function buildArticle(file) {
  const slug = file.replace(/\.md$/, "");
  const full = path.join(SRC, file);
  const md = (await readFile(full, "utf8")).replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const updated = gitDate(file, (await stat(full)).mtime);

  const m = new Marked({ gfm: true, renderer });
  const tokens = m.lexer(md);
  const body = tokens.slice();
  body.links = tokens.links;
  // Заголовок, вводный абзац и курсивная заметка об источниках выводим в шапке страницы, а не в тексте.
  const take = (pred) => {
    const k = body.findIndex((t) => t.type !== "space");
    return k >= 0 && pred(body[k]) ? body.splice(k, 1)[0] : null;
  };
  const titleTok = take((t) => t.type === "heading" && t.depth === 1);
  const leadTok = take((t) => t.type === "paragraph");
  const noteTok = take((t) => t.type === "paragraph" && t.tokens.length === 1 && t.tokens[0].type === "em");

  const title = titleTok ? clean(plain(titleTok.tokens)) : slug;
  const prefix = slug.replace(/-(tourist-visa|visa-d)-russians-serbia$/, "");
  const country = COUNTRIES[prefix] ?? title;
  if (!COUNTRIES[prefix]) console.warn(`! нет названия страны для «${prefix}», использую заголовок`);
  if (!leadTok) console.warn(`! ${file}: нет вводного абзаца`);
  if (!noteTok) console.warn(`! ${file}: нет курсивной заметки об источниках`);

  const seen = new Map();
  const toc = [];
  for (const t of body) {
    if (t.type !== "heading" || t.depth < 2 || t.depth > 3) continue;
    const text = clean(plain(t.tokens));
    const base = slugify(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    t.id = n ? `${base}-${n + 1}` : base;
    const item = { id: t.id, text, children: [] };
    if (t.depth === 2 || !toc.length) toc.push(item);
    else toc[toc.length - 1].children.push(item);
  }

  const lead = leadTok ? clean(plain(leadTok.tokens, true)) : "";
  const headings = toc.flatMap((s) => [s.text, ...s.children.map((c) => c.text)]);
  return {
    slug,
    file,
    title,
    country,
    updated,
    toc,
    description: truncate(lead, 200),
    search: norm([country, title, lead, ...headings].join(" ")),
    leadHtml: leadTok ? m.parser([leadTok]) : "",
    noteHtml: noteTok ? m.parser([noteTok]) : "",
    bodyHtml: m.parser(body),
  };
}

function tocList(items, withChildren) {
  return (
    "<ul>" +
    items
      .map((s) => {
        const kids = withChildren && s.children.length ? tocList(s.children, false) : "";
        return `<li${kids ? ' class="group"' : ""}><a href="#${esc(s.id)}">${esc(s.text)}</a>${kids}</li>`;
      })
      .join("") +
    "</ul>"
  );
}

const favicon =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#1f5fbf"/><text x="16" y="23" font-family="Arial,sans-serif" font-size="20" font-weight="700" text-anchor="middle" fill="#fff">В</text></svg>',
  );

function layout({ title, description, base, canonical, ogType, content, assetV, bodyClass = "" }) {
  const full = title === SITE_TITLE ? title : `${title} — ${SITE_TITLE}`;
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(full)}</title>
<meta name="description" content="${esc(description)}">
<meta name="color-scheme" content="light dark">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:site_name" content="${esc(SITE_TITLE)}">
<meta property="og:locale" content="ru_RU">
<meta property="og:type" content="${ogType}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<link rel="icon" href="${favicon}">
<link rel="stylesheet" href="${base}assets/style.css?v=${assetV.css}">
<script src="${base}assets/app.js?v=${assetV.js}" defer></script>
</head>
<body class="${bodyClass}">
<a class="skip" href="#main">К содержанию</a>
<header class="site-header">
  <div class="wrap bar">
    <a class="brand" href="${base || "./"}">${esc(SITE_TITLE)}</a>
    <a class="gh" href="${REPO_URL}" target="_blank" rel="noopener noreferrer">GitHub</a>
  </div>
</header>
${content}
<footer class="site-footer">
  <div class="wrap">
    <p>Это обзоры, а не юридическая консультация: правила и сроки меняются. Перед подачей сверяйтесь с официальными страницами из раздела «Источники» в каждой статье.</p>
    <p><a href="${REPO_URL}" target="_blank" rel="noopener noreferrer">Исходники статей на GitHub</a></p>
  </div>
</footer>
</body>
</html>
`;
}

function articlePage(a, assetV) {
  const side = `<aside class="toc-side" aria-label="Содержание"><p class="toc-title">На этой странице</p>${tocList(a.toc, true)}</aside>`;
  const inline = `<details class="toc-inline"><summary>Содержание</summary>${tocList(a.toc, true)}</details>`;
  const content = `<main id="main" class="wrap article-layout">
<article class="article">
  <nav class="crumbs" aria-label="Навигация"><a href="../">← Все статьи</a></nav>
  <h1>${esc(a.title)}</h1>
  <p class="meta">Обновлено ${ruDate(a.updated)} · <a href="${REPO_URL}/blob/main/articles/${esc(a.file)}" target="_blank" rel="noopener noreferrer">исходник на GitHub</a></p>
  <div class="lead">${a.leadHtml}</div>
  ${a.noteHtml ? `<aside class="note">${a.noteHtml}</aside>` : ""}
  <p class="legend"><span class="src-chat">чат</span> — опыт заявителей из чата: официального подтверждения нет, проверьте перед подачей.</p>
  ${inline}
  <div class="prose">
${a.bodyHtml}
  </div>
</article>
${side}
</main>`;
  return layout({
    title: a.title,
    description: a.description || SITE_DESC,
    base: "../",
    canonical: `${SITE_URL}/articles/${a.slug}.html`,
    ogType: "article",
    content,
    assetV,
    bodyClass: "page-article",
  });
}

function indexPage(articles, assetV) {
  const cards = articles
    .map(
      (a) => `    <li class="card" data-search="${esc(a.search)}">
      <a href="articles/${esc(a.slug)}.html">
        <span class="country">${esc(a.country)}</span>
        <span class="title">${esc(a.title)}</span>
        <span class="date">Обновлено ${ruDate(a.updated)}</span>
      </a>
    </li>`,
    )
    .join("\n");
  const content = `<main id="main" class="wrap">
  <section class="hero">
    <h1>${esc(SITE_TITLE)}</h1>
    <p class="hero-text">Туристические визы в страны, куда едут из Сербии: куда и как подаваться, какие документы нужны, сколько денег показать, сколько стоит и как долго ждать.</p>
    <div class="search">
      <label class="sr" for="q">Поиск по статьям</label>
      <input id="q" type="search" placeholder="Страна или тема: Германия, дети, страховка…" autocomplete="off" enterkeyhint="search">
      <span id="count" class="count" aria-live="polite"></span>
    </div>
  </section>
  <ul class="cards" id="cards">
${cards}
  </ul>
  <p id="empty" class="empty" hidden>Ничего не найдено. Попробуйте название страны или другое слово.</p>
  <section class="howto">
    <h2>Как читать</h2>
    <p>Каждая статья собрана по официальным страницам посольств и миграционных служб и по опыту людей из чата заявителей. Всё, что взято из чата, помечено значком <span class="src-chat">чат</span>: это чужой опыт, он может отличаться от официальных правил. Источники указаны в конце каждой статьи.</p>
  </section>
</main>`;
  return layout({
    title: SITE_TITLE,
    description: SITE_DESC,
    base: "",
    canonical: `${SITE_URL}/`,
    ogType: "website",
    content,
    assetV,
  });
}

function notFoundPage(assetV) {
  const base = `${BASE_PATH}/`;
  const content = `<main id="main" class="wrap">
  <section class="hero">
    <h1>Страница не найдена</h1>
    <p class="hero-text"><a href="${base}">Вернуться к списку статей</a></p>
  </section>
</main>`;
  return layout({
    title: "Страница не найдена",
    description: SITE_DESC,
    base,
    canonical: `${SITE_URL}/`,
    ogType: "website",
    content,
    assetV,
  });
}

const hash = async (f) => createHash("md5").update(await readFile(f)).digest("hex").slice(0, 8);

await rm(OUT, { recursive: true, force: true });
await mkdir(path.join(OUT, "articles"), { recursive: true });
await mkdir(path.join(OUT, "assets"), { recursive: true });
await cp(path.join(ASSETS, "style.css"), path.join(OUT, "assets", "style.css"));
await cp(path.join(ASSETS, "app.js"), path.join(OUT, "assets", "app.js"));
const assetV = { css: await hash(path.join(ASSETS, "style.css")), js: await hash(path.join(ASSETS, "app.js")) };

const files = (await readdir(SRC)).filter((f) => f.endsWith(".md")).sort();
const articles = [];
for (const f of files) articles.push(await buildArticle(f));
articles.sort((a, b) => a.country.localeCompare(b.country, "ru"));

for (const a of articles) await writeFile(path.join(OUT, "articles", `${a.slug}.html`), articlePage(a, assetV));
await writeFile(path.join(OUT, "index.html"), indexPage(articles, assetV));
await writeFile(path.join(OUT, "404.html"), notFoundPage(assetV));
await writeFile(path.join(OUT, ".nojekyll"), "");
await writeFile(path.join(OUT, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);
const urls = [
  { loc: `${SITE_URL}/`, lastmod: new Date(Math.max(...articles.map((a) => +a.updated))) },
  ...articles.map((a) => ({ loc: `${SITE_URL}/articles/${a.slug}.html`, lastmod: a.updated })),
];
await writeFile(
  path.join(OUT, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${esc(u.loc)}</loc><lastmod>${u.lastmod.toISOString().slice(0, 10)}</lastmod></url>`).join("\n") +
    `\n</urlset>\n`,
);

console.log(`Собрано статей: ${articles.length} → ${path.relative(ROOT, OUT)}/`);
