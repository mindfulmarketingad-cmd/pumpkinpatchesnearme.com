// Builds dist/data/page-meta.json: the on-page elements of every page.
//
// OmniConsole's Insights tab suggests rewriting a page's title, H1, meta
// description and opening paragraph. Advice like that is worth very little
// without the current value next to it — "shorten the title" means nothing
// when you cannot see the title. The console runs in a browser on another
// origin, so it cannot read those out of the page itself: same-origin
// policy blocks reading a cross-origin iframe, and there is no API that
// returns them.
//
// So the site publishes them. The build already has every page in memory;
// this pulls the four elements out and writes them where the console can
// fetch them, exactly as they are right now rather than as they were when
// Google last crawled.
//
// Run: node scripts/page-meta.mjs   (after a build)
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const SITE_URL = 'https://www.pumpkinpatchesnearme.com';

// The opening paragraph is for judging, not for reading in full.
const LEDE_MAX = 260;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name === 'index.html') out.push(p);
  }
  return out;
}

const routeOf = (file) => {
  const rel = relative(DIST, dirname(file)).split(/[\\/]/).join('/');
  return rel === '' || rel === '.' ? '/' : `/${rel}/`;
};

const DECODE = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
const text = (s) =>
  String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#?\w+);/g, (m, k) => DECODE[k] ?? (k[0] === '#' ? String.fromCharCode(+k.slice(1)) : m))
    .replace(/\s+/g, ' ')
    .trim();

const one = (html, re) => {
  const m = html.match(re);
  return m ? text(m[1]) : '';
};

const pages = {};
let missingTitle = 0, missingDesc = 0, missingH1 = 0, longTitle = 0, shortDesc = 0;

for (const file of walk(DIST)) {
  const html = readFileSync(file, 'utf8');
  const route = routeOf(file);

  const title = one(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const desc = one(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
    || one(html, /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  const h1 = one(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);

  // The first paragraph of the body, not of the header or a notice.
  // Body copy only: the footer and the header sit outside <main>, and
  // counting their boilerplate would make every page look 200 words longer
  // than it is.
  const from = html.indexOf('<main');
  const to = html.indexOf('</main>');
  const main = html.slice(from < 0 ? 0 : from, to < 0 ? html.length : to);
  let lede = '';
  // `<p(?=[\s>])` and not `<p[^>]*>`, because the latter also matches the
  // `<path>` of every inline SVG icon — which then runs to the next real
  // `</p>` and swallows whatever markup lies between.
  const pRe = /<p(?=[\s>])[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = pRe.exec(main)) !== null) {
    const t = text(m[1]);
    // Skip breadcrumb-ish and one-word fragments; the lede is prose.
    if (t.split(' ').length >= 8) { lede = t; break; }
  }
  if (lede.length > LEDE_MAX) lede = lede.slice(0, LEDE_MAX - 1).replace(/\s\S*$/, '') + '…';

  // The section headings, in order. They are the page's outline, and the
  // console reconstructs the page from them rather than framing it.
  const h2 = [];
  const hRe = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
  let hm;
  while ((hm = hRe.exec(main)) !== null && h2.length < 14) {
    const t = text(hm[1]);
    if (t) h2.push(t.length > 90 ? t.slice(0, 89) + '…' : t);
  }

  // A rough body word count, for telling a stub from a real page.
  const words = text(main.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')).split(' ').filter(Boolean).length;

  if (!title) missingTitle++;
  if (!desc) missingDesc++;
  if (!h1) missingH1++;
  if (title.length > 60) longTitle++;
  if (desc && desc.length < 120) shortDesc++;

  pages[route] = { t: title, d: desc, h: h1, p: lede, w: words, s: h2 };
}

const out = {
  site: SITE_URL,
  builtAt: new Date().toISOString(),
  source: 'read from the built HTML at build time',
  count: Object.keys(pages).length,
  pages,
};

mkdirSync(join(DIST, 'data'), { recursive: true });
writeFileSync(join(DIST, 'data', 'page-meta.json'), JSON.stringify(out));

const n = out.count.toLocaleString('en-US');
const kb = Math.round(JSON.stringify(out).length / 1024).toLocaleString('en-US');
console.log(`Page meta: ${n} pages (${kb}KB)`);
if (missingTitle) console.log(`  ${missingTitle.toLocaleString('en-US')} with no title`);
if (missingDesc) console.log(`  ${missingDesc.toLocaleString('en-US')} with no meta description`);
if (missingH1) console.log(`  ${missingH1.toLocaleString('en-US')} with no H1`);
if (longTitle) console.log(`  ${longTitle.toLocaleString('en-US')} titles over 60 characters`);
if (shortDesc) console.log(`  ${shortDesc.toLocaleString('en-US')} descriptions under 120 characters`);
console.log('Wrote dist/data/page-meta.json');
