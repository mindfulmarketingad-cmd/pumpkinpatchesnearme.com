// Builds dist/data/link-graph.json: every internal link on the site, counted.
//
// Search Console shows this report but publishes no API for it — the
// Search Console API is sites, sitemaps, searchAnalytics and urlInspection,
// and nothing else — so the only way to get the numbers out of Google is by
// hand, from the export.
//
// This does not need Google. Internal links are a fact about our own HTML,
// so we can count them ourselves from the pages we just built, exactly
// rather than sampled, and the same day rather than whenever Google last
// recrawled. The output is the shape OmniConsole's Links page reads.
//
// Run: node scripts/link-graph.mjs   (after a build)
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const SITE_URL = 'https://www.pumpkinpatchesnearme.com';

// The full graph is ~300k edges and writes a 12MB file, most of it the
// header nav repeated 6,334 times. Nobody is going to fetch that into a
// browser, so two caps: every page keeps its count, and the pages worth
// drilling into keep a sample of what links to them. Paths are stored
// without the origin and rehydrated by the reader, which alone takes a
// third off the file.
const MAX_SOURCES = 40;
const MAX_DETAIL = 400;

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

/* Only hrefs, and only the ones that point at a page of this site. Anchors,
   query strings and the trailing slash are normalised away so /blog and
   /blog/ are not counted as two different pages. */
const HREF = /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

function internalTargets(html, from) {
  const found = new Set();
  let m;
  HREF.lastIndex = 0;
  while ((m = HREF.exec(html)) !== null) {
    let href = (m[1] ?? m[2] ?? '').trim();
    if (!href) continue;
    if (/^(#|mailto:|tel:|javascript:)/i.test(href)) continue;
    if (/^https?:\/\//i.test(href)) {
      if (!href.startsWith(SITE_URL) && !href.startsWith('https://pumpkinpatchesnearme.com')) continue;
      href = href.replace(/^https?:\/\/[^/]+/, '');
    } else if (!href.startsWith('/')) {
      // a relative href, resolved against the page it was found on
      href = from.replace(/[^/]*$/, '') + href;
    }
    href = href.split('#')[0].split('?')[0];
    if (!href) continue;
    // files keep their extension; pages get one trailing slash
    if (!/\.[a-z0-9]{2,5}$/i.test(href) && !href.endsWith('/')) href += '/';
    if (/\.(png|jpe?g|svg|webp|ico|css|js|xml|txt|json|webmanifest)$/i.test(href)) continue;
    found.add(href);
  }
  return found;
}

const files = walk(DIST);
const incoming = new Map();   // target -> Set(source)
let edges = 0;

for (const file of files) {
  const from = routeOf(file);
  const html = readFileSync(file, 'utf8');
  for (const to of internalTargets(html, from)) {
    if (to === from) continue;          // a page linking to itself is not a vote
    if (!incoming.has(to)) incoming.set(to, new Set());
    incoming.get(to).add(from);
    edges++;
  }
}

const pages = [...incoming.entries()]
  .map(([to, from]) => ({ to, n: from.size, from: [...from].sort() }))
  .sort((a, b) => b.n - a.n || a.to.localeCompare(b.to));

const orphanPages = files.map(routeOf).filter((r) => r !== '/' && !incoming.has(r));

const out = {
  site: SITE_URL,
  builtAt: new Date().toISOString(),
  source: 'computed from the built HTML, not from Search Console',
  pagesCrawled: files.length,
  internalTotal: edges,
  detailFor: Math.min(MAX_DETAIL, pages.length),
  maxSources: MAX_SOURCES,
  // Paths only; the reader puts `site` back on the front.
  internalPages: pages.map((p) => [p.to, p.n]),
  detail: Object.fromEntries(
    pages.slice(0, MAX_DETAIL).map((p) => [p.to, p.from.slice(0, MAX_SOURCES)])
  ),
  // Pages nothing links to. Google will struggle to find these, and they
  // are the one thing in here that is immediately actionable.
  orphans: orphanPages,
};

mkdirSync(join(DIST, 'data'), { recursive: true });
const file = join(DIST, 'data', 'link-graph.json');
writeFileSync(file, JSON.stringify(out));

const orphans = orphanPages;
console.log(`Link graph: ${edges.toLocaleString('en-US')} internal links across ${files.length.toLocaleString('en-US')} pages`);
console.log(`  ${pages.length.toLocaleString('en-US')} pages have at least one link in`);
if (orphans.length) {
  console.log(`  ${orphans.length.toLocaleString('en-US')} pages have none — nothing on the site links to them:`);
  for (const o of orphans.slice(0, 10)) console.log(`    ${o}`);
  if (orphans.length > 10) console.log(`    and ${orphans.length - 10} more`);
}
const kb = Math.round(JSON.stringify(out).length / 1024);
console.log(`Wrote dist/data/link-graph.json (${kb.toLocaleString('en-US')}KB, detail for the top ${out.detailFor.toLocaleString('en-US')})`);
