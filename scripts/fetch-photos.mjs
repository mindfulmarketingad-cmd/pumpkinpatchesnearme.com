/**
 * Downloads every listing photo and rewrites data/listings.json to point at
 * local copies, so the site stops depending on Google's photo CDN.
 *
 *   node scripts/fetch-photos.mjs
 *   node scripts/fetch-photos.mjs --width 800 --height 500
 *   node scripts/fetch-photos.mjs --concurrency 12 --force
 *
 * Why this exists: Outscraper exports Google Places photo URLs in the
 * `lh3.googleusercontent.com/gps-cs-s/...` form. Those are signed,
 * short-lived URLs, not permalinks — they expire a few weeks after the
 * export, at which point every photo on the site silently falls back to the
 * placeholder. Downloading them once removes that whole failure mode.
 *
 * Safe to re-run: listings already pointing at a local file are skipped, and
 * a URL that fails to download is left exactly as it was so a later run can
 * retry it (a dead URL still renders the placeholder via the img onerror
 * handler, so a partial run never breaks a page).
 *
 * Network access is required, so run this locally rather than in a sandbox.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = join(ROOT, 'data/listings.json');
const OUT_DIR = join(ROOT, 'src/assets/img/listings');
const PUBLIC_PREFIX = '/assets/img/listings';

/* ------------------------------------------------------------------ args */

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const WIDTH = Number(arg('width', 640));
const HEIGHT = Number(arg('height', 400));
const CONCURRENCY = Math.max(1, Number(arg('concurrency', 8)));
const FORCE = Boolean(arg('force', false));
const TIMEOUT_MS = 20000;

/* --------------------------------------------------------------- helpers */

/** Google's CDN takes the pixel size in the URL — ask for the size we
 *  actually render rather than pulling the full-size original. */
function sizedUrl(url) {
  if (url.includes('googleusercontent.com')) {
    return url.replace(/=w\d+-h\d+[^&]*$/, `=w${WIDTH}-h${HEIGHT}-k-no`);
  }
  if (url.includes('streetviewpixels')) {
    return url.replace(/([?&])w=\d+/, `$1w=${WIDTH}`).replace(/([?&])h=\d+/, `$1h=${HEIGHT}`);
  }
  return url;
}

const EXT_BY_TYPE = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/gif': '.gif',
};

function localPathFor(slug, ext) {
  return join(OUT_DIR, `${slug}${ext}`);
}

function existingLocal(slug) {
  for (const ext of ['.jpg', '.png', '.webp', '.avif', '.gif']) {
    const p = localPathFor(slug, ext);
    if (existsSync(p) && statSync(p).size > 0) return { path: p, ext };
  }
  return null;
}

async function download(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(sizedUrl(url), {
      signal: controller.signal,
      headers: { 'User-Agent': 'pumpkinpatchesnearme.com photo importer' },
      redirect: 'follow',
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = EXT_BY_TYPE[type];
    if (!ext) return { ok: false, reason: `unexpected content-type "${type || 'none'}"` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return { ok: false, reason: 'empty response' };
    return { ok: true, buf, ext };
  } catch (err) {
    return { ok: false, reason: err.name === 'AbortError' ? 'timed out' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Simple fixed-size worker pool — keeps a steady number of requests in
 *  flight without pulling in a dependency. */
async function pool(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

/* ------------------------------------------------------------------ main */

const raw = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
const listings = Array.isArray(raw) ? raw : raw.listings;
if (!Array.isArray(listings)) {
  console.error('Could not find a listings array in data/listings.json');
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

const queue = listings.filter((l) => typeof l.photo === 'string' && /^https?:\/\//i.test(l.photo));
const alreadyLocal = listings.filter((l) => typeof l.photo === 'string' && l.photo.startsWith(PUBLIC_PREFIX)).length;
const noPhoto = listings.length - queue.length - alreadyLocal;

console.log(`${listings.length} listings — ${queue.length} remote photo(s) to fetch, ${alreadyLocal} already local, ${noPhoto} without a photo.`);
console.log(`Requesting ${WIDTH}x${HEIGHT}, ${CONCURRENCY} at a time.\n`);

let saved = 0;
let skipped = 0;
let bytes = 0;
const failures = [];

await pool(queue, CONCURRENCY, async (listing) => {
  const slug = listing.slug || String(listing.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) {
    failures.push({ name: listing.name, reason: 'no slug' });
    return;
  }

  if (!FORCE) {
    const hit = existingLocal(slug);
    if (hit) {
      listing.photo = `${PUBLIC_PREFIX}/${slug}${hit.ext}`;
      skipped++;
      return;
    }
  }

  const result = await download(listing.photo);
  if (!result.ok) {
    // Leave listing.photo untouched so a later run can retry this one.
    failures.push({ name: listing.name, reason: result.reason });
    return;
  }

  writeFileSync(localPathFor(slug, result.ext), result.buf);
  listing.photo = `${PUBLIC_PREFIX}/${slug}${result.ext}`;
  saved++;
  bytes += result.buf.length;

  const done = saved + skipped + failures.length;
  if (done % 100 === 0) console.log(`  ...${done}/${queue.length}`);
});

writeFileSync(DATA_FILE, `${JSON.stringify(raw, null, 2)}\n`);

const mb = (bytes / 1024 / 1024).toFixed(1);
console.log(`\nDownloaded ${saved} photo(s), ${mb} MB. Reused ${skipped} already on disk.`);

if (failures.length) {
  const byReason = failures.reduce((acc, f) => { acc[f.reason] = (acc[f.reason] || 0) + 1; return acc; }, {});
  console.log(`\n${failures.length} failed (their listings still point at the original URL, so re-running retries them):`);
  for (const [reason, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${reason}`);
  }
  console.log('\nA large batch of 403/404s means the exported Google URLs have expired —');
  console.log('re-run the Outscraper export and importer first, then this script.');
}

console.log('\ndata/listings.json updated. Run `npm run build` to rebuild the site.');
