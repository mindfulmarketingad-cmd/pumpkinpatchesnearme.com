/**
 * Pulls fall experiences from the Viator Partner API into
 * data/experiences.json, which build.mjs turns into /experiences/<state>/
 * pages.
 *
 *   export VIATOR_API_KEY=...        (never commit this)
 *   npm run fetch-viator
 *   npm run build
 *
 * Run this once, commit data/experiences.json, and every build after that
 * is credential-free — the site itself never calls Viator, visitors only
 * ever see baked HTML. Re-run it when you want to refresh (tours get
 * discontinued and dead affiliate links earn nothing).
 *
 * Network access is required, so run it locally rather than in a sandbox.
 *
 * ---------------------------------------------------------------------
 * If Viator's response shape doesn't match what this expects, the script
 * writes the raw response to data/viator-raw-sample.json and stops. Send
 * that file back and the mapping in normaliseProduct() gets corrected —
 * that's the only part of this pipeline tied to their field names.
 * ---------------------------------------------------------------------
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATES } from './lib/listings.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = join(ROOT, 'data/experiences.json');
const RAW_SAMPLE = join(ROOT, 'data/viator-raw-sample.json');

/* ------------------------------------------------------------ API config */
/* Everything Viator-specific is in this block, so a contract change is a
   small, contained edit rather than a rewrite. */
const API_BASE = 'https://api.viator.com/partner';
const API_HEADERS = (key) => ({
  'exp-api-key': key,
  Accept: 'application/json;version=2.0',
  'Accept-Language': 'en-US',
  'Content-Type': 'application/json',
});

// Your affiliate attribution, appended to every product link so clicks are
// actually tracked to your account.
const AFFILIATE_PARAMS = { pid: 'P00320180', mcid: '42383', medium: 'link' };

// What counts as a "fall" experience. Viator has no fall category, so this
// is a keyword pass over their catalogue.
const FALL_TERMS = [
  'pumpkin patch',
  'pumpkin picking',
  'corn maze',
  'hayride',
  'apple orchard',
  'fall foliage',
  'harvest festival',
  'haunted',
];

const MAX_PER_STATE = 24;
const CONCURRENCY = 3;
const TIMEOUT_MS = 25000;

/* ---------------------------------------------------------------- helpers */

const KEY = process.env.VIATOR_API_KEY;
if (!KEY) {
  console.error('VIATOR_API_KEY is not set.\n');
  console.error('  export VIATOR_API_KEY=your-key-here');
  console.error('  npm run fetch-viator\n');
  console.error('Set it in your shell or a .env file (already gitignored).');
  console.error('Do not add it to Netlify/Vercel — the build never calls Viator.');
  process.exit(1);
}

// STATES is a { AL: 'Alabama', ... } map shared with the build.
const US_STATE_NAMES = Object.values(STATES).filter((n) => n !== 'District of Columbia');

let rawSaved = false;
function saveRawOnce(label, payload) {
  if (rawSaved) return;
  rawSaved = true;
  mkdirSync(dirname(RAW_SAMPLE), { recursive: true });
  writeFileSync(RAW_SAMPLE, JSON.stringify({ label, payload }, null, 2));
  console.error(`\nUnexpected response shape. Raw sample written to:\n  ${RAW_SAMPLE}`);
  console.error('Send that file back and the mapping will be corrected.\n');
}

async function api(path, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: API_HEADERS(KEY),
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      console.error(`\nViator rejected the key (HTTP ${res.status}).`);
      console.error('Check VIATOR_API_KEY, and that your account has Partner API access.');
      process.exit(1);
    }
    if (res.status === 429) return { rateLimited: true };
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch {
      saveRawOnce(path, text.slice(0, 4000));
      return { error: `non-JSON response (HTTP ${res.status})` };
    }
    if (!res.ok) return { error: `HTTP ${res.status}`, json };
    return { json };
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'timed out' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Adds affiliate attribution to a Viator product URL. */
function affiliateUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url, 'https://www.viator.com');
    for (const [k, v] of Object.entries(AFFILIATE_PARAMS)) u.searchParams.set(k, v);
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Maps one Viator product onto the schema the site renders. Written
 * tolerantly on purpose — Viator has shifted field names between API
 * versions, so each value checks a couple of plausible shapes before
 * giving up. THIS is the function to fix if the raw sample disagrees.
 */
function normaliseProduct(p) {
  if (!p || typeof p !== 'object') return null;

  const code = p.productCode || p.code || p.productId || null;
  const title = p.title || p.productName || p.name || null;
  if (!code || !title) return null;

  const rawUrl =
    p.productUrl ||
    p.webURL ||
    p.url ||
    (code ? `https://www.viator.com/tours/${code}` : null);

  const image =
    (p.images && p.images[0] && (
      (p.images[0].variants && p.images[0].variants.slice(-1)[0]?.url) ||
      p.images[0].url
    )) || p.thumbnailURL || p.photoURL || null;

  const rating =
    (p.reviews && (p.reviews.combinedAverageRating ?? p.reviews.averageRating)) ??
    p.rating ?? null;
  const reviewCount =
    (p.reviews && (p.reviews.totalReviews ?? p.reviews.reviewCount)) ??
    p.reviewCount ?? null;

  const duration =
    (p.duration && (p.duration.description || p.duration.fixedDurationInMinutes)) ||
    p.durationText || null;

  return {
    code: String(code),
    title: String(title).trim(),
    url: affiliateUrl(rawUrl),
    image: image || null,
    rating: typeof rating === 'number' ? Number(rating.toFixed(1)) : null,
    reviews: typeof reviewCount === 'number' ? reviewCount : null,
    duration: typeof duration === 'string' ? duration : null,
    summary: (p.description || p.shortDescription || '').toString().trim().slice(0, 400) || null,
  };
}

/* ------------------------------------------------------------ destinations */

/** Viator organises the world by destination, not by US state, so state
 *  names have to be matched against their destination taxonomy first. */
async function loadStateDestinations() {
  const { json, error } = await api('/destinations');
  if (error || !json) {
    console.error('Could not load destinations:', error || 'empty response');
    process.exit(1);
  }
  const list = json.destinations || json.data || (Array.isArray(json) ? json : null);
  if (!Array.isArray(list)) {
    saveRawOnce('/destinations', json);
    process.exit(1);
  }

  const byState = new Map();
  for (const d of list) {
    const name = d.name || d.destinationName;
    const id = d.destinationId ?? d.id;
    if (!name || id == null) continue;
    const match = US_STATE_NAMES.find((n) => n.toLowerCase() === String(name).toLowerCase());
    if (match) byState.set(match, String(id));
  }
  return byState;
}

/* ---------------------------------------------------------------- searching */

async function searchState(stateName, destinationId) {
  const found = new Map();

  for (const term of FALL_TERMS) {
    // Free-text search scoped to the state's destination. If Viator's
    // request contract differs, this body is the thing to adjust.
    const { json, error, rateLimited } = await api('/search/freetext', {
      method: 'POST',
      body: {
        searchTerm: `${term} ${stateName}`,
        currency: 'USD',
        searchTypes: [{ searchType: 'PRODUCTS', pagination: { start: 1, count: 20 } }],
        ...(destinationId ? { filtering: { destination: destinationId } } : {}),
      },
    });

    if (rateLimited) { await new Promise((r) => setTimeout(r, 2000)); continue; }
    if (error || !json) continue;

    const products =
      json.products?.results || json.products?.data || json.products ||
      json.data?.products || (Array.isArray(json.results) ? json.results : []);
    if (!Array.isArray(products)) { saveRawOnce('/search/freetext', json); continue; }

    for (const raw of products) {
      const item = normaliseProduct(raw);
      if (item && item.url && !found.has(item.code)) found.set(item.code, item);
    }
    if (found.size >= MAX_PER_STATE) break;
  }

  return [...found.values()]
    .sort((a, b) => (b.rating || 0) * Math.log10((b.reviews || 1) + 1) - (a.rating || 0) * Math.log10((a.reviews || 1) + 1))
    .slice(0, MAX_PER_STATE);
}

async function pool(items, limit, worker) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) await worker(items[cursor++]);
  }));
}

/* -------------------------------------------------------------------- main */

console.log('Loading Viator destinations…');
const destinations = await loadStateDestinations();
console.log(`Matched ${destinations.size} of ${US_STATE_NAMES.length} states to a Viator destination.\n`);

const states = {};
let done = 0;

await pool(US_STATE_NAMES, CONCURRENCY, async (stateName) => {
  const items = await searchState(stateName, destinations.get(stateName));
  if (items.length) states[stateName] = items;
  done++;
  console.log(`  ${String(done).padStart(2)}/${US_STATE_NAMES.length}  ${stateName.padEnd(16)} ${items.length} experience(s)`);
});

const total = Object.values(states).reduce((n, a) => n + a.length, 0);
if (!total) {
  console.error('\nNo experiences returned for any state — nothing written.');
  console.error('If data/viator-raw-sample.json exists, send it back so the mapping can be fixed.');
  process.exit(1);
}

writeFileSync(OUT_FILE, `${JSON.stringify({
  fetchedAt: new Date().toISOString().slice(0, 10),
  source: 'viator',
  totalExperiences: total,
  states,
}, null, 2)}\n`);

console.log(`\nWrote ${total} experiences across ${Object.keys(states).length} states to data/experiences.json`);
console.log('Next: npm run build, then commit data/experiences.json.');
