/**
 * Static site generator for pumpkinpatchesnearme.com.
 *
 *   node scripts/build.mjs
 *
 * Reads src/pages/**.html (each with a JSON front-matter block), wraps them in
 * src/templates/base.html, generates state and listing pages from
 * data/listings.json, and writes everything to dist/.
 */
import {
  readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync, readdirSync,
} from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { slugify, STATES, DAYS } from './lib/listings.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');
const SITE_URL = 'https://pumpkinpatchesnearme.com';
const SITE_NAME = 'Pumpkin Patches Near Me';
const CONTACT_EMAIL = 'hello@pumpkinpatchesnearme.com';
const ASSET_VERSION = String(Date.now()).slice(-6);
const BUILD_DATE = new Date().toISOString().slice(0, 10);
const PLACEHOLDER_IMAGE = '/assets/img/patch-placeholder.svg';

// Analytics is opt-in: set SUPABASE_URL and SUPABASE_ANON_KEY at build time
// (e.g. in the Vercel/Netlify environment) to turn it on. With neither set,
// analytics-client.js sees an empty config and no-ops everywhere — the site
// builds and runs identically either way. The anon key is meant to be public
// (Supabase's row-level-security policies are what actually gate access, not
// key secrecy), so embedding it in the built HTML is intentional, not a leak.
// Table name is namespaced per directory site since one Supabase project can
// host analytics for several of this operator's directories.
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const ANALYTICS_TABLE = 'pumpkinpatchesnearme_dashboard';

/**
 * Programmatic blog posts are backdated 30–60 days before the build date
 * rather than all sharing today's date — publishing 800+ posts with an
 * identical "today" byline reads as an obvious bulk-generation event rather
 * than an established blog. The offset is a deterministic hash of the post's
 * own slug, so a given post's date stays stable across rebuilds instead of
 * reshuffling every time the site is built.
 */
function backdatedPostDate(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const offsetDays = 30 + (hash % 31); // 30..60 inclusive
  const d = new Date(`${BUILD_DATE}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - offsetDays);
  return d.toISOString().slice(0, 10);
}

/** A stable (rebuild-to-rebuild) "random" 0..2^32-1 hash of a string —
 *  used anywhere a page needs a pick or shuffle that looks random but
 *  doesn't reshuffle every time the site rebuilds from the same data. */
function seededHash(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return hash;
}

/** Google's photo CDN takes the requested pixel size straight in the URL
 *  (`=w800-h500-k-no`) — swapping those numbers gets an appropriately small
 *  image instead of downloading the full 800x500 source for a 120px
 *  thumbnail. A state page with 200+ entries was shipping 200+ full-size
 *  photos for images rendered at a fraction of that size. */
function resizedPhotoUrl(url, width, height) {
  if (!url || url.indexOf('googleusercontent.com') === -1) return url;
  return url.replace(/=w\d+-h\d+[^&]*$/, `=w${width}-h${height}-k-no`);
}

const IMAGE_SIZES = {
  thumb: { width: 280, height: 175 }, // listicle/pillar entry thumbnails (rendered 84-180px)
  card: { width: 480, height: 300 },  // grid cards (rendered up to 340px)
  hero: { width: 900, height: 500 },  // detail/blog/category hero (rendered up to 900px)
};

/** Every listing image: the real photo when we have one, the illustrated
 *  placeholder when we don't — a listing never renders with no image. Google
 *  photo URLs occasionally 404 after the fact, so onerror swaps to the same
 *  placeholder client-side rather than leaving a broken-image icon. Explicit
 *  width/height attributes (matching the rendered aspect ratio) let the
 *  browser reserve space before the image loads, avoiding layout shift. */
function listingImage(l, { alt, className = '', sizes = '', size = 'card' } = {}) {
  const preset = IMAGE_SIZES[size] || IMAGE_SIZES.card;
  const altText = alt || `${l.name}${l.city ? ` in ${l.city}` : ''}`;
  const src = l.photo ? resizedPhotoUrl(l.photo, preset.width, preset.height) : PLACEHOLDER_IMAGE;
  return `<img class="${className}" src="${attr(src)}" alt="${attr(altText)}" width="${preset.width}" height="${preset.height}" loading="lazy" decoding="async"${sizes ? ` sizes="${attr(sizes)}"` : ''} onerror="this.onerror=null;this.src='${PLACEHOLDER_IMAGE}';">`;
}

/* ----------------------------------------------------------------- inputs */

const data = JSON.parse(readFileSync(join(ROOT, 'data/listings.json'), 'utf8'));
const listings = data.listings || [];
const faqs = JSON.parse(readFileSync(join(SRC, 'data/faqs.json'), 'utf8'));
const categories = JSON.parse(readFileSync(join(SRC, 'data/categories.json'), 'utf8'));
const authors = JSON.parse(readFileSync(join(SRC, 'data/authors.json'), 'utf8'));
const authorsBySlug = new Map(authors.map((a) => [a.slug, a]));
const template = readFileSync(join(SRC, 'templates/base.html'), 'utf8');
const SEASON_YEAR = new Date().getFullYear();

const hasRealData = listings.some((l) => !l.sample);
const sampleOnly = listings.length > 0 && !hasRealData;

/* ------------------------------------------------------------- utilities */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const attr = (s) => esc(s).replace(/'/g, '&#39;');

// Meta descriptions get cut off in the SERP snippet somewhere around 155-160
// characters — trimming at a word boundary here keeps every page's tag
// under that budget instead of relying on each call site to count.
function truncateMetaDescription(s, max = 155) {
  const str = String(s ?? '');
  if (str.length <= max) return str;
  const cut = str.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 0 ? lastSpace : max - 1)}…`;
}

function writePage(urlPath, html) {
  const rel = urlPath === '/' ? 'index.html' : join(urlPath.replace(/^\/|\/$/g, ''), 'index.html');
  const out = join(DIST, rel);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
}

function stars(rating) {
  if (!rating) return '';
  const full = Math.round(rating);
  return '★'.repeat(full) + '☆'.repeat(Math.max(0, 5 - full));
}

const statePath = (stateName) => `/${slugify(stateName)}/`;
const cityPath = (stateName, cityName) => `/${slugify(stateName)}/${slugify(cityName)}/`;
const categoryPath = (category) => `/${category.slug}/`;
// City-scoped service page, e.g. /hayrides/calhoun-ga/ — same "city-state
// code" slug shape the per-city blog posts already use, so URLs read
// consistently across the site.
const categoryCityPath = (category, cityName, stateCode) => `/${category.slug}/${slugify(`${cityName} ${stateCode}`)}/`;
// State-scoped service page, e.g. /hayrides/georgia/.
const categoryStatePath = (category, stateName) => `/${category.slug}/${slugify(stateName)}/`;

// Shared by every state and city page's List/Map toggle.
const pageMapScripts = `<link rel="stylesheet" href="/assets/vendor/leaflet/leaflet.css">
<script src="/assets/vendor/leaflet/leaflet.js" defer></script>
<script src="/assets/js/page-map.js?v=${ASSET_VERSION}" defer></script>`;

/**
 * Individual listings live at /<state>/<city>/<business-name>/, nested under
 * the same state and city pages. Business-name slugs are de-duplicated within
 * their city so two farms sharing a name in the same town don't collide, and
 * this runs once up front so every call site (cards, breadcrumbs, JSON-LD,
 * the client-side map JSON) agrees on the same URL for a given listing.
 */
const usedByCityBucket = new Map(); // "state-slug/city-slug" -> Set of business slugs taken
for (const l of listings) {
  if (l.state && l.city) {
    const stateSlug = slugify(l.state);
    const citySlug = slugify(l.city);
    const bucketKey = `${stateSlug}/${citySlug}`;
    if (!usedByCityBucket.has(bucketKey)) usedByCityBucket.set(bucketKey, new Set());
    const used = usedByCityBucket.get(bucketKey);
    const base = slugify(l.name) || 'pumpkin-patch';
    let businessSlug = base;
    let n = 2;
    while (used.has(businessSlug)) businessSlug = `${base}-${n++}`;
    used.add(businessSlug);
    l.url = `/${stateSlug}/${citySlug}/${businessSlug}/`;
  } else {
    // Listings missing a state or city shouldn't occur with clean data, but
    // fall back to a flat path rather than ever producing a broken URL.
    l.url = `/patch/${l.slug}/`;
  }
}
const listingPath = (listing) => listing.url;

/** Featured (paid placement) listings float to the top of every collection. */
function rankListings(items) {
  return [...items].sort(
    (a, b) =>
      Number(Boolean(b.featured)) - Number(Boolean(a.featured)) ||
      (b.rating || 0) - (a.rating || 0) ||
      (b.reviews || 0) - (a.reviews || 0) ||
      a.name.localeCompare(b.name)
  );
}

/* -------------------------------------------------------- data aggregates */

const byState = new Map();
for (const l of listings) {
  if (!l.state) continue;
  if (!byState.has(l.state)) byState.set(l.state, []);
  byState.get(l.state).push(l);
}
for (const [key, arr] of byState) byState.set(key, rankListings(arr));

// Only states that actually have a listing get a page — no empty shells for
// the rest of the 50, and this stays correct automatically as data changes.
const stateNames = [...byState.keys()].sort();

// Cities keyed as "State|City" so identically named towns in different states
// stay separate (Portland ME and Portland OR both exist in the data).
const byCity = new Map();
for (const l of listings) {
  if (!l.state || !l.city) continue;
  const key = `${l.state}|${l.city}`;
  if (!byCity.has(key)) byCity.set(key, []);
  byCity.get(key).push(l);
}
for (const [key, arr] of byCity) byCity.set(key, rankListings(arr));

const citiesInState = (stateName) =>
  [...byCity.keys()]
    .filter((k) => k.startsWith(`${stateName}|`))
    .map((k) => k.split('|')[1])
    .sort();

// Approximate centroid per city (average of its own listings' coordinates)
// — good enough to rank other towns in the same state by real proximity for
// "nearby cities" links, without needing a separate geocoding source.
const cityCentroids = new Map();
for (const [key, arr] of byCity) {
  const withCoords = arr.filter((l) => Number.isFinite(l.lat) && Number.isFinite(l.lng));
  if (!withCoords.length) continue;
  cityCentroids.set(key, {
    lat: withCoords.reduce((sum, l) => sum + l.lat, 0) / withCoords.length,
    lng: withCoords.reduce((sum, l) => sum + l.lng, 0) / withCoords.length,
  });
}

function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Other towns in the same state, ranked by real distance between city
// centroids rather than alphabetically — used for the "Nearby Cities"
// section on every listing page.
function nearbyCities(stateName, cityName, count) {
  const ownKey = `${stateName}|${cityName}`;
  const origin = cityCentroids.get(ownKey);
  if (!origin) return [];
  return [...cityCentroids.entries()]
    .filter(([key]) => key !== ownKey && key.startsWith(`${stateName}|`))
    .map(([key, centroid]) => {
      const city = key.split('|')[1];
      return { city, distance: haversineMiles(origin.lat, origin.lng, centroid.lat, centroid.lng), count: byCity.get(key).length };
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, count);
}

const byCategory = new Map();
for (const cat of categories) {
  byCategory.set(cat.slug, rankListings(listings.filter((l) => (l.features || []).includes(cat.feature))));
}

const featuredListings = rankListings(listings.filter((l) => l.featured));
const cityCount = byCity.size;

const stats = {
  listings: listings.length,
  states: byState.size,
  cities: cityCount,
};

/* --- pillar/cluster link registries --------------------------------------
   Every programmatic blog post below registers itself here as it's
   written, so the state, city, category and listing pages generated later
   in this file can link back down to their own cluster content — without
   re-deriving slugs independently in four separate places (the bug class
   that already bit the pricing-guide post once). */
// catSlug is null for posts that aren't scoped to one attraction (the
// overview "10 Best," Fields/Farms and pricing-guide posts) and set to the
// category slug for posts that are (U-Pick, Petting Zoo, Fall Festival,
// and every "Best <Attraction> in <City>" post) — lets the listing-page
// picker below match a guide to a business's own feature tags instead of
// just grabbing whichever post happens to be first.
const stateGuideLinks = new Map(); // stateName -> [{ title, href, catSlug }]
const cityGuideLinks = new Map(); // "state|city" -> [{ title, href, catSlug }]
const categoryStateGuideLinks = new Map(); // cat.slug -> [{ stateName, title, href }]
const categoryCityGuideLinks = new Map(); // cat.slug -> [{ stateName, cityName, title, href, n }]

function addStateGuideLink(stateName, title, href, catSlug = null) {
  if (!stateGuideLinks.has(stateName)) stateGuideLinks.set(stateName, []);
  stateGuideLinks.get(stateName).push({ title, href, catSlug });
}
function addCityGuideLink(stateName, cityName, title, href, catSlug = null) {
  const key = `${stateName}|${cityName}`;
  if (!cityGuideLinks.has(key)) cityGuideLinks.set(key, []);
  cityGuideLinks.get(key).push({ title, href, catSlug });
}
function addCategoryStateGuideLink(catSlug, stateName, title, href) {
  if (!categoryStateGuideLinks.has(catSlug)) categoryStateGuideLinks.set(catSlug, []);
  categoryStateGuideLinks.get(catSlug).push({ stateName, title, href });
}
function addCategoryCityGuideLink(catSlug, stateName, cityName, title, href, n) {
  if (!categoryCityGuideLinks.has(catSlug)) categoryCityGuideLinks.set(catSlug, []);
  categoryCityGuideLinks.get(catSlug).push({ stateName, cityName, title, href, n });
}

// Separate from the guide registries above: these track the actual
// city-scoped directory pages (/hayrides/<city>-<state>/ and friends),
// not the blog posts about them — so a city's directory page can link to
// its own local service page, and a category hub can list its own city
// sub-pages, distinct from linking to blog content.
const categoryCityPageLinks = new Map(); // "catSlug|state|city" -> { title, href }
const categoryCityPageList = new Map(); // catSlug -> [{ stateName, cityName, title, href, n }]

function addCategoryCityPage(catSlug, stateName, cityName, title, href, n) {
  categoryCityPageLinks.set(`${catSlug}|${stateName}|${cityName}`, { title, href });
  if (!categoryCityPageList.has(catSlug)) categoryCityPageList.set(catSlug, []);
  categoryCityPageList.get(catSlug).push({ stateName, cityName, title, href, n });
}

// Same idea, one level up: /hayrides/<state>/ etc.
const categoryStatePageLinks = new Map(); // "catSlug|state" -> { title, href }

function addCategoryStatePage(catSlug, stateName, title, href) {
  categoryStatePageLinks.set(`${catSlug}|${stateName}`, { title, href });
}

/* ------------------------------------------------------- shared fragments */

function renderCard(l, { showState = true, showCity = true, headingLevel = 3 } = {}) {
  const place = [showCity ? l.city : null, showState ? l.stateCode : null].filter(Boolean).join(', ');
  const tags = (l.features || []).slice(0, 3);
  const h = headingLevel;
  return `<article class="listing-card${l.featured ? ' is-featured' : ''}">
  ${l.featured ? '<p class="featured-flag">Featured farm</p>' : ''}
  <a class="listing-card-media" href="${listingPath(l)}" tabindex="-1" aria-hidden="true">
    ${listingImage(l, { className: 'listing-card-img', sizes: '(min-width: 900px) 340px, 100vw' })}
  </a>
  <div class="listing-card-body">
    <h${h}><a href="${listingPath(l)}">${esc(l.name)}</a></h${h}>
    <div class="listing-meta">
      ${l.rating ? `<span class="rating"><span class="stars" aria-hidden="true">${stars(l.rating)}</span> ${l.rating.toFixed(1)}</span>` : ''}
      ${l.reviews ? `<span>${l.reviews.toLocaleString('en-US')} reviews</span>` : ''}
      ${place ? `<span>${esc(place)}</span>` : ''}
      ${l.sample ? '<span class="tag">Sample data</span>' : ''}
    </div>
    ${l.street ? `<p class="listing-address">${esc(l.street)}${l.postalCode ? `, ${esc(l.postalCode)}` : ''}</p>` : ''}
    ${tags.length ? `<div class="tag-row">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
    <div class="card-actions">
      <a class="btn btn-primary btn-sm" href="${listingPath(l)}">View details</a>
      <a class="btn btn-outline btn-sm" href="https://www.google.com/maps/dir/?api=1&amp;destination=${l.lat},${l.lng}" target="_blank" rel="noopener nofollow">Directions</a>
    </div>
  </div>
</article>`;
}

// A small gallery of real photos from a page's own listings, deterministically
// shuffled per page (same seed -> same photos on every rebuild, not a fresh
// shuffle each time). Skipped entirely on pages with no photographed listings
// rather than padding with the illustrated placeholder.
function renderPhotoGallery(items, seedKey, label, count = 5) {
  const withPhotos = items.filter((l) => l.photo);
  if (!withPhotos.length) return '';
  const picks = withPhotos
    .map((l) => ({ l, key: seededHash(seedKey + l.slug) }))
    .sort((a, b) => a.key - b.key)
    .slice(0, count)
    .map((x) => x.l);
  return `<h2>Photos from pumpkin patches in ${esc(label)}</h2>
<div class="photo-gallery">
${picks
  .map(
    (l) => `  <a class="photo-gallery-item" href="${listingPath(l)}" aria-label="${attr(l.name)}">
    ${listingImage(l, { className: 'photo-gallery-img', size: 'card' })}
  </a>`
  )
  .join('\n')}
</div>`;
}

/* ------------------------------------------------------------ AdSense ---
   Three ad units, each placed where it fits the page's own content shape
   rather than the same unit repeated everywhere: "in-article" (Google's
   fluid, reflow-friendly format) inside long-form prose — blog posts and
   listing descriptions; "vertical" right after a listing's hero image,
   the highest-visibility spot on a listing page that doesn't compete with
   the description for attention; "square" spliced natively into the
   scrolling pillar-list on state/city/category/directory pages, since
   that list *is* the page for most visitors on mobile. The loader script
   itself lives once in base.html's <head> — every call site below is just
   the <ins> unit plus its own push({}).
*/
const AD_CLIENT = 'ca-pub-9332749804326149';
const AD_SLOTS = { vertical: '5282024480', square: '1541306209', inArticle: '4753212343' };

function renderAdSlot(type) {
  const insAttrs =
    type === 'inArticle'
      ? `style="display:block; text-align:center;" data-ad-layout="in-article" data-ad-format="fluid"`
      : `style="display:block" data-ad-format="auto" data-full-width-responsive="true"`;
  return `<div class="ad-slot ad-slot-${type}">
  <p class="ad-label">Advertisement</p>
  <ins class="adsbygoogle" ${insAttrs} data-ad-client="${AD_CLIENT}" data-ad-slot="${AD_SLOTS[type]}"></ins>
  <script>(adsbygoogle = window.adsbygoogle || []).push({});</script>
</div>`;
}

// Drops an in-article ad right after a post/description's opening
// paragraph — reading has already started, so it doesn't read as an
// interstitial, but it's still above almost everything else on the page.
// A plain string replace on the first "</p>" is deliberate: every post
// body on this site (hand-authored and programmatic alike) opens with a
// lede paragraph before its first heading, so this never needs to parse
// arbitrary HTML to find a safe insertion point.
function injectInArticleAd(bodyHtml) {
  const marker = '</p>';
  const idx = bodyHtml.indexOf(marker);
  if (idx === -1) return bodyHtml;
  const cut = idx + marker.length;
  return bodyHtml.slice(0, cut) + '\n' + renderAdSlot('inArticle') + bodyHtml.slice(cut);
}

// Splices a square ad directly into a pillar-list's own entries — native
// to the scroll a mobile visitor is already doing, rather than a banner
// they scroll past. Skipped on short lists (nothing to interrupt), and
// doubled up past 20 entries, where a single ad near the top would leave
// most of a long scroll unmonetized. renderEntry is (listing, index) =>
// html, already closed over whatever per-page seed a caller's own
// renderPillarEntry() call needs — this only owns list assembly.
function pillarEntriesWithAds(items, renderEntry) {
  const entries = items.map((l, i) => renderEntry(l, i));
  if (entries.length < 6) return entries.join('\n');
  const withAds = entries.slice();
  const adLi = `    <li class="pillar-ad">${renderAdSlot('square')}</li>`;
  withAds.splice(4, 0, adLi);
  if (entries.length >= 20) withAds.splice(15, 0, adLi);
  return withAds.join('\n');
}

function joinNatural(words) {
  if (words.length <= 1) return words[0] || '';
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function patchWord(n) {
  return n === 1 ? 'Pumpkin Patch' : 'Pumpkin Patches';
}

// Cycles through a handful of sentence shapes so a page of 10 ranked farms
// doesn't read as the same template ten times in a row.
// Index 0 is reserved for the #1 entry specifically — it must never cycle
// back onto a later rank (a 5- or 9-item list previously wrapped modulo-4
// and told visitors the last entry "takes the top spot").
const BLURB_OPENERS = [
  (name, place) => `${name}${place ? ` in ${place}` : ''} takes the top spot`,
  (name, place) => `${name}${place ? `, out in ${place},` : ''} is next up`,
  (name, place) => `${name}${place ? ` near ${place}` : ''} rounds out this stretch of the list`,
  (name, place) => `Also worth the drive: ${name}${place ? ` in ${place}` : ''}`,
  (name, place) => `${name}${place ? ` in ${place}` : ''} is another strong option`,
];

function blurbFor(l, rank, stateName) {
  const place = l.city && l.city !== stateName ? l.city : null;
  const opener =
    rank === 0
      ? BLURB_OPENERS[0](esc(l.name), place ? esc(place) : null)
      : BLURB_OPENERS[1 + ((rank - 1) % (BLURB_OPENERS.length - 1))](esc(l.name), place ? esc(place) : null);

  const ratingClause = l.rating
    ? `, rated ${l.rating.toFixed(1)} out of 5${l.reviews ? ` from ${l.reviews.toLocaleString('en-US')} review${l.reviews === 1 ? '' : 's'}` : ''}`
    : '';

  const features = (l.features || []).slice(0, 2).map((f) => esc(f.toLowerCase()));
  const featureSentence = features.length ? ` Visitors come here for ${joinNatural(features)}.` : '';
  const seasonSentence = l.season ? ` Typical season: ${esc(l.season)}.` : '';

  const featuredNote = l.featured ? ' This is a featured listing.' : '';

  return `${opener}${ratingClause}.${featureSentence}${seasonSentence}${featuredNote}`;
}

// Every ranked listicle entry (state pages, city pages, and the programmatic
// "5 Best" blog posts all share this renderer) gets a substantial,
// data-grounded summary of the business rather than a one-line blurb — see
// businessSummaryHtml() below. Nothing here invents a fact about a specific
// farm; where data is missing the copy says so and points to the full
// listing page instead.
function hoursSummaryText(l) {
  if (!l.hours) return '';
  return DAYS.filter((d) => l.hours[d] && l.hours[d].toLowerCase() !== 'closed')
    .map((d) => `${d[0].toUpperCase()}${d.slice(1)} ${l.hours[d]}`)
    .join(', ');
}

function businessSummaryHtml(l, rank, stateName) {
  const name = esc(l.name);
  const place = l.city && l.city !== stateName ? l.city : null;
  const fullPlace = [l.city, l.stateCode].filter(Boolean).join(', ');
  const address = l.fullAddress || [l.street, fullPlace, l.postalCode].filter(Boolean).join(', ');

  // Paragraph 1 — overview: where it is, how it's rated, what it's tagged for.
  const ratingSentence = l.rating
    ? `It carries a ${l.rating.toFixed(1)}-out-of-5 rating on Google${l.reviews ? ` from ${l.reviews.toLocaleString('en-US')} review${l.reviews === 1 ? '' : 's'}` : ''}, which puts it${place ? ` among the more established pumpkin patches we track near ${esc(place)}` : ' among the more established pumpkin patches in our data'}.`
    : `We don't have a public rating on file for this listing yet — that usually just means it's newer to Google's index rather than a reflection of quality, so the details below lean on the rest of its business listing.`;
  const featureIntro = (l.features || []).length
    ? ` Beyond the pumpkin field itself, it's tagged for ${joinNatural(l.features.slice(0, 4).map((f) => esc(f.toLowerCase())))}, so there's usually more to a visit than just picking a pumpkin and heading home.`
    : ` Its listing doesn't break out specific extra attractions beyond the pumpkin patch itself, so it's worth a quick look at the farm's website or a call ahead if you're hoping for something like a corn maze or hayride on top of the field.`;
  const p1 = `${name} is ranked ${rank === 1 ? '#1' : `#${rank}`} on this list${address ? `, located at ${esc(address)}` : place ? `, serving the ${esc(place)} area` : ''}. ${ratingSentence}${featureIntro}`;

  // Paragraph 2 — what visitors mention, in the site's own words where we have them.
  const tagsSentence = (l.reviewTags || []).length
    ? `Recurring themes in reviews of ${name} include ${joinNatural(l.reviewTags.slice(0, 5).map((t) => esc(t.toLowerCase())))} — not a direct quote from any single visitor, but the topics that come up most often when people describe the farm.`
    : `Google hasn't surfaced a set of recurring review themes for ${name} yet, so there isn't a themed summary of what visitors say to pass along here — the star rating and review count above remain the clearest public signal until more detail comes in.`;
  const descSentence = l.description ? ` In the farm's own words: "${esc(l.description)}"` : '';
  const categoryMatch = categories.find((c) => (l.features || []).includes(c.feature));
  const categorySentence = categoryMatch
    ? ` ${esc(l.name)} is one of the farms we track with a ${esc(categoryMatch.singular)}, which typically means ${(categoryMatch.intro.match(/<p>(.*?)<\/p>/) || ['', 'guests get more than a straightforward pumpkin field — check the listing for specifics on what runs and when'])[1].replace(/<[^>]+>/g, '').toLowerCase().slice(0, 220)}${(categoryMatch.intro.match(/<p>(.*?)<\/p>/) || ['', ''])[1].length > 220 ? '…' : '.'}`
    : ` Most pumpkin patches share a similar core visit regardless of what's formally listed: a field or lot of pumpkins priced individually or by weight, sometimes reached by a short wagon ride, with an extra attraction like a corn maze or animal area running at many farms in season. What's actually open on a given day depends on the week and the weather, so the listing above is a starting point rather than the full picture.`;
  const p2 = `${tagsSentence}${descSentence}${categorySentence}`;

  // Paragraph 3 — practical visiting info: hours, season, admission, payment.
  const hoursSummary = hoursSummaryText(l);
  const hoursSentence = hoursSummary
    ? `Based on its public listing, ${name} is typically open ${hoursSummary}. Pumpkin patch hours shift often during the season — expect longer hours the two or three weekends around mid-October and shorter, sometimes weekend-only hours toward either end of the season — so treat this as a strong starting point rather than a guarantee.`
    : `Hours aren't listed for ${name} in our data. Most pumpkin patches run daily or weekends-only from mid-September through the first days of November, but the surest way to know is to call ahead or check the farm's website before you drive out.`;
  const admissionSentence = l.admission
    ? ` ${l.admission} Pricing can still shift season to season, so confirm current admission and pumpkin pricing directly with the farm.`
    : ` Admission pricing isn't listed for ${name} either — pumpkin patches generally charge one of three ways (free entry with pumpkins priced individually or by weight, a flat gate admission bundling attractions, or a per-attraction wristband system), so it's worth asking which applies here before you go.`;
  const paymentSentence = l.payment && l.payment.length
    ? ` It accepts ${joinNatural(l.payment.map((p) => esc(p.toLowerCase())))}, though it's still smart to carry some cash — field admission and wagon rides at farms like this are sometimes handled separately from the main store.`
    : ` Payment methods aren't listed, and a meaningful share of family-run patches are cash-only for field admission and wagon rides even when the farm store takes cards — bringing some cash as backup avoids an awkward trip back to the car at the gate.`;
  const p3 = `${hoursSentence}${admissionSentence}${paymentSentence}`;

  // Paragraph 4 — planning a visit: weather, footwear, timing, worth knowing regardless of what data we have.
  const seasonSentence = l.season
    ? `${name} lists its season as ${esc(l.season)}, though like almost any working farm that can shift a little in either direction depending on weather and how the crop comes in.`
    : `Like most working farms, the exact open and close dates for ${name} can shift year to year with weather and how the pumpkin crop comes in, even though the general window is fairly predictable.`;
  const p4 = `${seasonSentence} If you're planning a special trip, a weekday morning is consistently the quietest time to go, with shorter waits for wagon rides and easier parking than a weekend afternoon. Wear shoes you don't mind getting muddy — pumpkin fields are working farmland rather than paved lots, and they get soft fast after rain — and call ahead if it's rained heavily in the last day or two, since field access and hayrides are usually the first things a farm closes when the ground is saturated. Layers help too: fall mornings can start cold and warm up quickly once the sun is over an open field.`;

  // Paragraph 5 — wrap-up: county, directions, link to the full profile.
  const wrapLead = address
    ? `${name} sits${l.county ? ` in ${esc(l.county)} County` : ''}${fullPlace ? `, near ${esc(fullPlace)}` : ''}, with parking typically in a grass field rather than a paved lot — allow a few extra minutes on busy weekends for staff or volunteers to direct traffic, and if you're navigating by GPS rather than the link on this page, search the farm name directly rather than just the street address, since rural addresses sometimes route to the wrong gate.`
    : `Exact directions for ${name} are on its full listing page and the map on this page, along with parking notes where we have them. If you're navigating by GPS, searching the farm name directly tends to be more reliable than a bare street address out in farm country.`;
  const p5 = `${wrapLead} See the full profile — hours table, rating breakdown, review themes, FAQ and a map you can route from — on <a href="${listingPath(l)}">${name}'s listing page</a>, or tap Directions below to head straight there.`;

  return `<div class="listicle-summary">
      <p>${p1}</p>
      <p>${p2}</p>
      <p>${p3}</p>
      <p>${p4}</p>
      <p>${p5}</p>
    </div>`;
}

function renderListicleEntry(l, rank, stateName) {
  const place = [l.city, l.stateCode].filter(Boolean).join(', ');
  const tags = (l.features || []).slice(0, 4);
  return `<li class="listicle-item${l.featured ? ' is-featured' : ''}" id="${attr(l.slug)}">
  <span class="listicle-rank" aria-hidden="true">${rank}</span>
  <a class="listicle-media" href="${listingPath(l)}" tabindex="-1" aria-hidden="true">
    ${listingImage(l, { className: 'listicle-img', sizes: '(min-width: 640px) 180px, 100vw', size: 'thumb' })}
  </a>
  <div class="listicle-body">
    ${l.featured ? '<p class="featured-flag featured-flag-inline">Featured farm</p>' : ''}
    <h2><a href="${listingPath(l)}">${esc(l.name)}</a></h2>
    <div class="listing-meta">
      ${l.rating ? `<span class="rating"><span class="stars" aria-hidden="true">${stars(l.rating)}</span> ${l.rating.toFixed(1)}</span>` : ''}
      ${l.reviews ? `<span>${l.reviews.toLocaleString('en-US')} reviews</span>` : ''}
      ${place ? `<span>${esc(place)}</span>` : ''}
      ${l.sample ? '<span class="tag">Sample data</span>' : ''}
    </div>
    <p class="listicle-blurb">${blurbFor(l, rank - 1, stateName)}</p>
    ${l.street ? `<p class="listing-address">${esc(l.street)}${l.postalCode ? `, ${esc(l.postalCode)}` : ''}</p>` : ''}
    ${tags.length ? `<div class="tag-row">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
    <button class="listicle-toggle" type="button" aria-expanded="false">Read full write-up<span class="listicle-toggle-icon" aria-hidden="true"></span></button>
    <div class="listicle-more" hidden>
      ${businessSummaryHtml(l, rank, stateName)}
    </div>
    <div class="card-actions">
      <a class="btn btn-primary btn-sm" href="${listingPath(l)}">View details</a>
      <a class="btn btn-outline btn-sm" href="https://www.google.com/maps/dir/?api=1&amp;destination=${l.lat},${l.lng}" target="_blank" rel="noopener nofollow">Directions</a>
    </div>
  </div>
</li>`;
}

// A one-line steer for who a farm suits, derived only from real feature
// tags and rating/review volume already on the listing — never a specific
// invented claim about a farm we don't actually have data for.
function perfectForText(l) {
  const f = l.features || [];
  if (f.includes('Petting zoo') || f.includes('Kids play area')) return 'Perfect for families with young kids';
  if (f.includes('Haunted attraction')) return 'Perfect for older kids and teens looking for a scare';
  if (f.includes('Corn maze')) return 'Perfect for a group that wants a challenge';
  if (f.includes('Sunflower field')) return 'Perfect for photos';
  if (f.includes('Apple picking')) return 'Perfect for a two-in-one apple and pumpkin trip';
  if (f.includes('Fall festival')) return 'Perfect for a full day out with food and music';
  if (f.includes('Hayrides')) return 'Perfect for a classic hayride out to the field';
  if (f.includes('U-pick pumpkins')) return 'Perfect for picking your own pumpkin straight from the vine';
  if (l.rating >= 4.7 && l.reviews >= 200) return 'Perfect for a reliably great visit, based on reviews';
  return 'Perfect for a straightforward pumpkin-picking trip';
}

// A lighter-weight ranked entry than renderListicleEntry() above — a
// thumbnail, name, rating line and one-sentence blurb, no 500-word summary.
// Used anywhere a list needs to stay skimmable at real scale: the "Must See"
// pillar post (up to 240 entries) and full state directories (up to several
// hundred). data-* attributes carry enough of the listing for client-side
// search/filter/sort/distance/today's-hours to work over server-rendered
// content, no second fetch.
function renderPillarEntry(l, rank, stateName) {
  const place = [l.city, l.stateCode].filter(Boolean).join(', ');
  const features = (l.features || []).join('|');
  const address = l.fullAddress || [l.street, place, l.postalCode].filter(Boolean).join(', ');
  const tags = (l.features || []).slice(0, 4);
  const hoursJson = l.hours ? attr(JSON.stringify(DAYS.map((d) => l.hours[d] || ''))) : '';

  // Every listing carries a Google placeId/mapsUrl from the import, so these
  // always resolve — no fabricated links, just pointing existing data at the
  // right Google surface (public reviews list, directions, the place's own
  // photo set) instead of leaving the rating, address and photo count as
  // plain text.
  const reviewsUrl = l.placeId ? `https://search.google.com/local/reviews?placeid=${encodeURIComponent(l.placeId)}` : l.mapsUrl || '';
  const directionsUrl = Number.isFinite(l.lat) && Number.isFinite(l.lng) ? `https://www.google.com/maps/dir/?api=1&destination=${l.lat},${l.lng}` : '';
  const photosUrl = l.mapsUrl || '';

  const ratingReviewsInner = `${l.rating ? `<span class="rating"><span class="stars" aria-hidden="true">${stars(l.rating)}</span> ${l.rating.toFixed(1)}</span>` : ''}${l.reviews ? `<span>${l.reviews.toLocaleString('en-US')} reviews</span>` : ''}`;
  const ratingReviewsHtml = ratingReviewsInner
    ? reviewsUrl
      ? `<a class="pillar-reviews-link" href="${attr(reviewsUrl)}" target="_blank" rel="noopener nofollow">${ratingReviewsInner}</a>`
      : ratingReviewsInner
    : '';

  const cityHtml = l.city && l.state ? `<a href="${cityPath(l.state, l.city)}">${esc(l.city)}</a>` : esc(l.city || '');
  const stateHtml = l.state && l.stateCode ? `<a href="${statePath(l.state)}">${esc(l.stateCode)}</a>` : esc(l.stateCode || '');
  const placeHtml = `${cityHtml ? `<span>${cityHtml}</span>` : ''}${cityHtml && stateHtml ? ', ' : ''}${stateHtml ? `<span>${stateHtml}</span>` : ''}`;

  const contactParts = [];
  if (l.phone) contactParts.push(`<a href="tel:${attr(l.phone.replace(/[^\d+]/g, ''))}">${esc(l.phone)}</a>`);
  if (l.website) contactParts.push(`<a href="${attr(l.website)}" target="_blank" rel="noopener nofollow">Visit website</a>`);
  if (photosUrl) contactParts.push(`<a href="${attr(photosUrl)}" target="_blank" rel="noopener nofollow">${l.photosCount ? `Photos (${l.photosCount.toLocaleString('en-US')})` : 'Photos'}</a>`);
  const contactHtml = contactParts.length ? `<p class="pillar-contact">${contactParts.join(' <span aria-hidden="true">&middot;</span> ')}</p>` : '';

  return `    <li class="pillar-entry" id="${attr(l.slug)}" data-name="${attr(l.name.toLowerCase())}" data-city="${attr((l.city || '').toLowerCase())}" data-city-label="${attr(l.city || '')}" data-state="${attr((l.state || '').toLowerCase())}" data-features="${attr(features.toLowerCase())}" data-rating="${l.rating || 0}" data-reviews="${l.reviews || 0}" data-lat="${l.lat ?? ''}" data-lng="${l.lng ?? ''}"${hoursJson ? ` data-hours='${hoursJson}'` : ''}>
      <a class="pillar-media" href="${listingPath(l)}" tabindex="-1" aria-hidden="true">
        ${listingImage(l, { className: 'pillar-img', sizes: '(min-width: 640px) 120px, 96px', size: 'thumb' })}
      </a>
      <div class="pillar-entry-body">
        <h3><a href="${listingPath(l)}">${esc(l.name)}</a></h3>
        <p class="listing-meta">${ratingReviewsHtml}${placeHtml}<span class="pillar-distance" hidden></span></p>
        ${address ? `<p class="pillar-address">${directionsUrl ? `<a href="${attr(directionsUrl)}" target="_blank" rel="noopener nofollow">${esc(address)}</a>` : esc(address)}</p>` : ''}
        ${contactHtml}
        <p class="pillar-hours-today">${l.hours ? '' : 'Hours not listed — confirm directly before you go.'}</p>
        <p class="pillar-perfect-for"><strong>${esc(perfectForText(l))}.</strong></p>
        <p class="pillar-blurb">${blurbFor(l, rank, stateName)}</p>
        ${tags.length ? `<div class="tag-row">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
      </div>
    </li>`;
}

/* ------------------------------------------------ listing detail content */
/* Everything below builds the substantial, data-grounded content a single
   listing page needs so it is never thin: real numbers restated in prose
   where we have them (ratings, review counts, hours, season, payment), and
   evergreen practical guidance where we don't. Nothing here invents a fact
   about a specific farm — where data is missing, the copy says so and
   points the visitor to confirm directly, matching the voice used
   everywhere else on the site. */

function ratingBarsHtml(l) {
  if (!l.reviewsPerScore) return '';
  const total = [1, 2, 3, 4, 5].reduce((sum, star) => sum + (l.reviewsPerScore[star] || 0), 0);
  if (!total) return '';
  const rows = [5, 4, 3, 2, 1]
    .map((star) => {
      const count = l.reviewsPerScore[star] || 0;
      const pct = Math.round((count / total) * 100);
      return `      <div class="rating-bar-row">
        <span class="rating-bar-label">${star}<span aria-hidden="true"> &#9733;</span></span>
        <span class="rating-bar-track" role="img" aria-label="${pct}% of reviews gave ${star} star${star === 1 ? '' : 's'}"><span class="rating-bar-fill" style="width:${pct}%"></span></span>
        <span class="rating-bar-count">${count.toLocaleString('en-US')}</span>
      </div>`;
    })
    .join('\n');
  return `<h2>Rating breakdown</h2>
    <p>${esc(l.name)} is rated ${l.rating ? l.rating.toFixed(1) : '—'} out of 5 based on ${total.toLocaleString('en-US')} Google reviews. Here is how those reviews break down by star rating:</p>
    <div class="rating-bars">
${rows}
    </div>`;
}

function knownForHtml(l) {
  if (!l.reviewTags || !l.reviewTags.length) return '';
  return `<h2>What visitors mention</h2>
    <p>These are recurring themes Google surfaces from reviews of ${esc(l.name)} — not a quote from any single review, but the topics visitors bring up most:</p>
    <div class="tag-row">${l.reviewTags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>`;
}

function whatToExpectHtml(l) {
  const matched = categories.filter((c) => (l.features || []).includes(c.feature));
  if (!matched.length) {
    return `<h2>What to expect</h2>
    <p>${esc(l.name)}'s full list of attractions is not catalogued in our data yet, but most pumpkin patches share a similar core visit: a field or lot of pumpkins to choose from, usually priced individually or by weight, sometimes with a wagon ride out to the picking area. Many farms also run at least one extra attraction in season — a corn maze, hayride or animal area are the most common — though what is actually running on a given day can change with the weather and the week. Calling ahead or checking ${l.website ? `<a href="${attr(l.website)}" target="_blank" rel="noopener nofollow">${esc(l.name)}'s website</a>` : 'the farm’s website or phone number'} before you drive out is the most reliable way to know what to expect the day you go.</p>`;
  }
  const sections = matched
    .slice(0, 5)
    .map((c) => {
      const firstPara = (c.intro.match(/<p>.*?<\/p>/) || [c.intro])[0];
      return `    <h3>${esc(c.name)}</h3>
    ${firstPara}`;
    })
    .join('\n');
  return `<h2>What to expect at ${esc(l.name)}</h2>
    <p>Based on its listing, ${esc(l.name)} offers ${joinNatural(matched.map((c) => c.singular))}. Here is what each of those typically involves, and what to plan for:</p>
${sections}`;
}

function visitingGuidanceHtml(l, place) {
  const name = esc(l.name);
  return `<h2>Visiting ${name}</h2>
    <p>Like almost every pumpkin patch in the country, ${name} runs on a compressed seasonal schedule — typically open from mid-to-late September through the first days of November, with the exact opening and closing dates shifting slightly year to year based on weather and how the pumpkin crop comes in. Hours are also prone to change week to week during the season: many farms extend their hours on the two or three weekends around mid-October, when demand peaks, and cut back to weekend-only or reduced hours toward either end of the season.</p>
    <p>Because of that variability, the hours listed on this page — sourced from ${name}'s public business listing — are a strong starting point but not a guarantee. A farm can close early for a private event, shut the field after heavy rain, or sell out of pumpkins before the posted closing time. If ${place ? `the trip to ${esc(place)}` : 'the trip'} is more than a few minutes for you, it is worth a quick call to confirm the farm is open and the field is accessible before you leave.</p>
    <p>Payment practices are another area where it pays to check ahead. A meaningful share of pumpkin patches — especially smaller, family-run operations — are cash-only or limit card payments to the main farm store while wagon rides and field admission are collected in cash. Carrying some cash covers you even if ${name} does take cards, and avoids an awkward trip back to the car at the gate.</p>
    <p>If you are planning around young children, it is worth thinking about nap schedules and stamina rather than just the drive time — a two- or three-hour outing that includes a wagon ride, a walk through the field and a stop at a play area or animal pen tends to hold a toddler's attention better than a rushed visit squeezed between other errands. Groups with a wider age range often do best splitting up once on site, since older kids and adults can tackle a corn maze or longer walk while younger children stay closer to the main picking area.</p>`;
}

function visitTipsHtml() {
  return `<h2>Tips for a good visit</h2>
    <ul>
      <li><strong>Go on a weekday morning if you can.</strong> It is consistently the quietest time at almost any pumpkin patch, with shorter waits for wagon rides and easier parking.</li>
      <li><strong>Wear shoes you don't mind getting muddy.</strong> Pumpkin fields are working farmland, not paved lots, and they get soft fast after rain.</li>
      <li><strong>Bring cash.</strong> Even farms that accept cards at the store sometimes run field admission and wagon rides as cash-only.</li>
      <li><strong>Call ahead after wet weather.</strong> Field access and hayrides are the first things a farm closes when the ground is saturated.</li>
      <li><strong>Check what's actually running that day.</strong> Corn mazes and haunted attractions in particular often open later in the season than the pumpkin patch itself, or run on a more limited schedule.</li>
      <li><strong>Pack layers.</strong> Fall mornings can start cold and warm up fast once the sun is out over an open field, especially if you're there for a few hours.</li>
    </ul>`;
}

function locationParagraphHtml(l, address, place) {
  const name = esc(l.name);
  const parts = [];
  parts.push(
    `<h2>Getting to ${name}</h2>`
  );
  if (address) {
    parts.push(
      `<p>${name} is located at ${esc(address)}${l.county ? ` in ${esc(l.county)} County` : ''}. Use the <strong>Get directions</strong> button on this page to route from your current location in Google Maps, or the map below to see exactly where the farm sits relative to nearby towns.</p>`
    );
  } else {
    parts.push(
      `<p>Use the map on this page for ${name}'s exact location${place ? ` near ${esc(place)}` : ''}, or the <strong>Get directions</strong> button to route there from your current location.</p>`
    );
  }
  parts.push(
    `<p>As with most pumpkin patches, parking is typically in a grass field rather than a paved lot, so allow a few extra minutes on busy weekends for staff or volunteers to direct traffic. If you are relying on a GPS app rather than the link on this page, search the farm name directly rather than just the street address — rural addresses sometimes route to the wrong gate or an adjacent property.</p>`
  );
  return parts.join('\n    ');
}

/**
 * Five FAQ pairs per listing, grounded in whatever real data exists (hours,
 * admission, payment) and falling back to honest, evergreen guidance where
 * it doesn't. Returns both the rendered HTML and the plain question/answer
 * pairs so the FAQPage JSON-LD can be built from the exact same source.
 */
function listingFaqData(l, place) {
  const name = l.name;
  const hoursSummary = hoursSummaryText(l);

  const qa = [
    {
      q: `What are ${name}'s hours?`,
      a: hoursSummary
        ? `Based on its public listing, ${name} is typically open ${hoursSummary}. Pumpkin patch hours change often during the season, so confirm directly with the farm before visiting, especially outside of peak October weekends.`
        : `Hours are not listed for ${name} in our data. Most pumpkin patches open daily or on weekends from mid-September through early November, but the safest way to know for certain is to call the farm or check its website before you drive out.`,
    },
    {
      q: `How much does it cost to visit ${name}?`,
      a: l.admission
        ? `${l.admission} That said, pricing can change season to season — confirm current admission and pumpkin pricing with the farm directly.`
        : `Admission pricing is not listed for ${name}. Pumpkin patches generally use one of three models: free entry with pumpkins priced individually or by weight, a flat gate admission that bundles attractions like a corn maze or hayride, or a wristband system priced per attraction. Call ahead or check the farm's website to find out which applies here.`,
    },
    {
      q: `When is the best time to visit ${name}?`,
      a: `Weekday mornings are consistently the quietest time to visit any pumpkin patch, including this one. The two weekends on either side of mid-October are typically the busiest of the season nationwide, so expect longer waits for wagon rides and parking if you go then. Late October usually means a thinner pumpkin selection but shorter lines.`,
    },
    {
      q: `Does ${name} accept credit cards?`,
      a: l.payment && l.payment.length
        ? `Yes — based on its listing, ${name} accepts ${joinNatural(l.payment.map((p) => p.toLowerCase()))}. It's still worth carrying some cash, since field admission and wagon rides are sometimes handled separately from the main store.`
        : `Payment methods are not listed for ${name}. Many pumpkin patches, particularly smaller family-run farms, are cash-only for field admission and wagon rides even when the farm store accepts cards, so it is worth bringing cash as a backup.`,
    },
    {
      q: `Where is ${name} located?`,
      a: place
        ? `${name} is located in or near ${place}${l.county ? `, in ${l.county} County` : ''}. See the address and map on this page, or use the Get Directions button to route there from your current location.`
        : `See the address and map on this page for ${name}'s exact location, or use the Get Directions button to route there from your current location.`,
    },
  ];

  const html = `<h2>Frequently asked questions</h2>
    <div class="faq-list">
${qa
  .map(
    (item) => `      <details class="faq-item">
        <summary>${esc(item.q)}</summary>
        <div class="faq-answer"><p>${esc(item.a)}</p></div>
      </details>`
  )
  .join('\n')}
    </div>`;

  return { html, qa };
}

/* ---------------------------------------------------------- blog authors */

const authorPath = (author) => `/authors/${author.slug}/`;

function renderByline(authorSlug, dateStr, readingTime) {
  const author = authorsBySlug.get(authorSlug);
  const dateHtml = dateStr
    ? new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
    : '';
  if (!author) {
    return dateStr ? `<p class="post-meta">Published ${dateHtml}</p>` : '';
  }
  return `<div class="byline">
  <a href="${authorPath(author)}" class="byline-avatar"><img src="/assets/img/authors/${author.slug}.svg" alt="" width="44" height="44" loading="lazy"></a>
  <div class="byline-text">
    <p class="byline-name">By <a href="${authorPath(author)}">${esc(author.name)}</a>, ${esc(author.title)}</p>
    <p class="byline-meta">${dateStr ? `Published ${dateHtml}` : ''}${dateStr && readingTime ? ' &middot; ' : ''}${readingTime ? esc(readingTime) : ''}</p>
  </div>
</div>`;
}

/**
 * Auto-builds a jump-link table of contents from a post's own <h2> headings,
 * and stamps matching ids onto those headings so the links resolve. Used for
 * hand-authored guides; programmatic city posts build their own TOC over
 * business names instead (see the city-post loop) since that is the more
 * useful granularity there.
 */
function autoToc(bodyHtml) {
  const headings = [...bodyHtml.matchAll(/<h2>(.*?)<\/h2>/g)];
  if (headings.length < 2) return { toc: '', body: bodyHtml };

  const used = new Set();
  let i = 0;
  const body = bodyHtml.replace(/<h2>(.*?)<\/h2>/g, (match, inner) => {
    const text = inner.replace(/<[^>]+>/g, '');
    let id = slugify(text) || `section-${i}`;
    while (used.has(id)) id = `${id}-${++i}`;
    used.add(id);
    i++;
    return `<h2 id="${id}">${inner}</h2>`;
  });

  const ids = [...used];
  const toc = `<p class="listicle-toc"><strong>Jump to:</strong> ${headings
    .map((h, idx) => `<a href="#${ids[idx]}">${h[1].replace(/<[^>]+>/g, '')}</a>`)
    .join(' <span aria-hidden="true">&middot;</span> ')}</p>`;

  return { toc, body };
}

function renderFaqHtml(items) {
  return `<div class="faq-list">
${items
  .map(
    (f) => `  <details class="faq-item">
    <summary>${esc(f.question)}</summary>
    <div class="faq-answer">${f.answer}</div>
  </details>`
  )
  .join('\n')}
</div>`;
}

function renderCategoryGrid() {
  return `<div class="grid grid-4">
${categories
  .map((c) => {
    const count = (byCategory.get(c.slug) || []).length;
    return `  <a class="category-card" href="${categoryPath(c)}">
    <h3>${esc(c.name)}</h3>
    <p>${count.toLocaleString('en-US')} farm${count === 1 ? '' : 's'}</p>
  </a>`;
  })
  .join('\n')}
</div>`;
}

function renderCityLinks(stateName) {
  const cities = citiesInState(stateName);
  if (!cities.length) return '';
  return `<div class="state-grid">
${cities
  .map((city) => {
    const count = (byCity.get(`${stateName}|${city}`) || []).length;
    return `  <a class="state-link" href="${cityPath(stateName, city)}">${esc(city)} <span>${count}</span></a>`;
  })
  .join('\n')}
</div>`;
}

/**
 * Wraps a state or city page's farm listing content with a List/Map toggle.
 * The map is scoped to exactly the farms passed in — not the whole
 * dataset — and its data is embedded inline as JSON rather than fetched, so
 * opening the map costs no extra request. Leaflet itself only initialises
 * when a visitor actually clicks "Map".
 */
function renderScopedMap(items, listHtml, { singular = 'pumpkin patch', plural = 'pumpkin patches' } = {}) {
  const mappable = items.filter((l) => Number.isFinite(l.lat) && Number.isFinite(l.lng));
  if (!mappable.length) return listHtml;

  const mapData = mappable.map((l) => ({
    name: l.name,
    url: l.url,
    lat: l.lat,
    lng: l.lng,
    rating: l.rating,
    reviews: l.reviews,
    city: l.city,
    stateCode: l.stateCode,
    photo: l.photo,
  }));
  // Inline JSON inside a <script> tag must not contain a literal "</" or a
  // browser will parse it as the tag's own closing tag.
  const json = JSON.stringify(mapData).replace(/</g, '\\u003c');

  return `<div class="page-toggle-bar">
  <p class="page-toggle-label">${mappable.length.toLocaleString('en-US')} ${mappable.length === 1 ? singular : plural} on this page</p>
  <div class="control-group">
    <button class="toggle-btn" type="button" id="page-view-list" aria-pressed="true">List</button>
    <button class="toggle-btn" type="button" id="page-view-map" aria-pressed="false">Map</button>
  </div>
</div>
<div id="page-list-view">
${listHtml}
</div>
<div class="page-map-wrap" id="page-map-view" hidden>
  <div class="page-map" id="page-map"></div>
  <div class="map-tools"><button class="toggle-btn" type="button" id="page-map-satellite" aria-pressed="false">Satellite</button></div>
</div>
<script type="application/json" id="page-map-data">${json}</script>`;
}

function renderStateGrid() {
  return `<div class="state-grid">
${stateNames
  .map((s) => `  <a class="state-link" href="${statePath(s)}">${esc(s)} <span>${byState.get(s).length}</span></a>`)
  .join('\n')}
</div>`;
}

/* ------------------------------------------------------- page assembly */

function jsonLdFor(meta, extra) {
  if (extra) return JSON.stringify(extra);
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: meta.title,
    description: meta.description,
    url: SITE_URL + meta.path,
    isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: SITE_URL },
  });
}

function breadcrumbs(trail) {
  if (!trail || !trail.length) return '';
  const items = [{ label: 'Home', href: '/' }, ...trail];
  return `<nav class="breadcrumbs" aria-label="Breadcrumb"><ol>${items
    .map((i, idx) =>
      idx === items.length - 1
        ? `<li aria-current="page">${esc(i.label)}</li>`
        : `<li><a href="${i.href}">${esc(i.label)}</a></li>`
    )
    .join('')}</ol></nav>`;
}

function breadcrumbJsonLd(trail, currentPath) {
  const items = [{ label: 'Home', href: '/' }, ...trail];
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((i, idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      name: i.label,
      item: SITE_URL + (idx === items.length - 1 ? currentPath : i.href),
    })),
  };
}

function layoutContent(meta, body) {
  const layout = meta.layout || 'prose';
  if (layout === 'raw') return body;

  const head = `<div class="page-head">
  <div class="${layout === 'wide' ? 'wrap' : 'wrap-narrow'}">
    ${breadcrumbs(meta.trail)}
    <h1>${esc(meta.h1 || meta.title)}</h1>
    ${meta.lede ? `<p class="lede">${meta.lede}</p>` : ''}
  </div>
</div>`;

  const wrapClass = layout === 'wide' ? 'wrap' : 'wrap-narrow prose';
  return `${head}
<section class="section">
  <div class="${wrapClass}">
${body}
  </div>
</section>`;
}

function render(meta, body, opts = {}) {
  const navKeys = ['home', 'blog', 'about', 'find', 'pumpkin-patches', 'corn-mazes', 'hayrides', 'partners'];
  let html = template;

  const banner = sampleOnly && meta.path === '/'
    ? `<div class="data-banner">Preview mode: this directory is running on placeholder listings. Import your Outscraper export to publish live data. <a href="/contact/">Add a real patch</a></div>`
    : '';

  const replacements = {
    '{{TITLE}}': esc(meta.title),
    '{{DESCRIPTION}}': attr(truncateMetaDescription(meta.description)),
    '{{CANONICAL}}': SITE_URL + meta.path,
    '{{SITE_URL}}': SITE_URL,
    '{{OG_TYPE}}': meta.ogType || 'website',
    '{{BODY_CLASS}}': meta.bodyClass || 'page',
    '{{ADSENSE_SCRIPT}}': '<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-9332749804326149" crossorigin="anonymous"></script>',
    // Corn Mazes and Hayrides are the only two category hubs in the main
    // nav, so they pick up a link from every page on the site while the
    // other six only get linked from pages that happen to carry that
    // feature — a 10-100x gap in internal links pointing at them. This
    // footer block gives all eight the same site-wide link.
    '{{FOOTER_CATEGORY_NAV}}': `<nav class="footer-nav footer-nav-cats" aria-label="Browse by feature">
      <span class="footer-nav-label">Browse by feature</span>
      <ul>
${categories.map((c) => `        <li><a href="${categoryPath(c)}">${esc(c.name)}</a></li>`).join('\n')}
      </ul>
    </nav>`,
    '{{HEAD_EXTRA}}': (meta.noindex ? '<meta name="robots" content="noindex, follow">\n' : '') + (opts.headExtra || ''),
    '{{SCRIPTS}}': opts.scripts || '',
    '{{JSONLD}}': jsonLdFor(meta, opts.jsonld),
    '{{CONTENT}}': banner + layoutContent(meta, body),
    '{{YEAR}}': String(new Date().getFullYear()),
    '{{ASSET_VERSION}}': ASSET_VERSION,
    '{{ANALYTICS_CONFIG_JSON}}': JSON.stringify({
      url: SUPABASE_URL,
      anonKey: SUPABASE_ANON_KEY,
      table: ANALYTICS_TABLE,
    }).replace(/</g, '\\u003c'),
  };

  // The noindex directive must replace, not stack with, the default robots tag.
  if (meta.noindex) {
    html = html.replace(
      '<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">',
      ''
    );
  }

  for (const key of navKeys) {
    replacements[`{{NAV_${key.toUpperCase()}}}`] = meta.nav === key ? ' aria-current="page"' : '';
  }

  for (const [token, value] of Object.entries(replacements)) {
    html = html.split(token).join(value);
  }
  return html;
}

/* ----------------------------------------------------------- page sources */

function readPageFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.html'))
    .map((e) => {
      const raw = readFileSync(join(dir, e.name), 'utf8');
      const match = raw.match(/^<!--meta\s*([\s\S]*?)-->\s*/);
      if (!match) throw new Error(`Missing <!--meta --> block in ${join(dir, e.name)}`);
      return {
        file: basename(e.name, '.html'),
        meta: JSON.parse(match[1]),
        body: raw.slice(match[0].length),
      };
    });
}

/* ------------------------------------------------------------------ build */

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const sitemapEntries = [];
const addToSitemap = (path, priority, changefreq, lastmod) =>
  sitemapEntries.push({ path, priority, changefreq, lastmod: lastmod || BUILD_DATE });

/* --- blog posts ---------------------------------------------------------- */

// Blog posts get a featured hero image pulled from the Outscraper photo data
// rather than a stock graphic — real photos of real pumpkin patches from the
// directory, rotated deterministically so rebuilds are reproducible. Posts
// tied to a specific city (the programmatic "5 Best" posts) use a photo from
// one of their own top-5 businesses instead; see the city-post loop below.
const photoPool = rankListings(listings.filter((l) => l.photo));
const pickBlogPhoto = (seedIndex) => (photoPool.length ? photoPool[seedIndex % photoPool.length].photo : PLACEHOLDER_IMAGE);
const absImageUrl = (src) => (src.startsWith('http') ? src : `${SITE_URL}${src}`);
function blogHeroFigureHtml(src, altText) {
  const isPlaceholder = src === PLACEHOLDER_IMAGE;
  const resized = isPlaceholder ? src : resizedPhotoUrl(src, IMAGE_SIZES.hero.width, IMAGE_SIZES.hero.height);
  return `<figure class="detail-hero blog-hero">
  <img class="detail-hero-img" src="${attr(resized)}" alt="${attr(altText)}" width="${IMAGE_SIZES.hero.width}" height="${IMAGE_SIZES.hero.height}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='${PLACEHOLDER_IMAGE}';">
  <figcaption>${isPlaceholder ? 'Illustration' : 'Photo via Google, from a pumpkin patch in our directory'}</figcaption>
</figure>`;
}

const handAuthoredPosts = readPageFiles(join(SRC, 'pages/blog'))
  .map((p) => ({ ...p, meta: { ...p.meta, path: `/blog/${p.meta.slug}/` } }))
  .sort((a, b) => (b.meta.date || '').localeCompare(a.meta.date || ''));

let handAuthoredHeroIndex = 0;
for (const post of handAuthoredPosts) {
  const meta = {
    ...post.meta,
    nav: 'blog',
    layout: 'prose',
    ogType: 'article',
    trail: [{ label: 'Blog', href: '/blog/' }, { label: post.meta.h1 || post.meta.title }],
  };
  const author = authorsBySlug.get(post.meta.author);
  // Hand-authored posts don't go through the static-page expandTokens()
  // pipeline, but a couple of live stats are still useful to reference
  // without hardcoding a number that drifts out of date on the next import.
  const postBody = post.body
    .split('{{STAT_LISTINGS}}').join(stats.listings.toLocaleString('en-US'))
    .split('{{STAT_STATES}}').join(String(stats.states))
    .split('{{STAT_CITIES}}').join(String(stats.cities));
  const { toc, body: bodyWithIds } = autoToc(postBody);
  const heroSrc = pickBlogPhoto(handAuthoredHeroIndex++);
  const heroHtml = blogHeroFigureHtml(heroSrc, post.meta.h1 || post.meta.title);
  const jsonld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BlogPosting',
        headline: post.meta.h1 || post.meta.title,
        description: post.meta.description,
        datePublished: post.meta.date,
        dateModified: post.meta.updated || post.meta.date,
        mainEntityOfPage: SITE_URL + meta.path,
        image: absImageUrl(heroSrc),
        author: author
          ? { '@type': 'Person', name: author.name, url: SITE_URL + authorPath(author), jobTitle: author.title }
          : { '@type': 'Organization', name: SITE_NAME, url: SITE_URL },
        publisher: {
          '@type': 'Organization',
          name: SITE_NAME,
          url: SITE_URL,
          logo: { '@type': 'ImageObject', url: `${SITE_URL}/assets/img/icon-512.png` },
        },
      },
      breadcrumbJsonLd(meta.trail, meta.path),
    ],
  };
  const byline = renderByline(post.meta.author, post.meta.date, post.meta.readingTime);
  writePage(meta.path, render(meta, heroHtml + byline + toc + injectInArticleAd(bodyWithIds), { jsonld }));
  addToSitemap(meta.path, '0.6', 'monthly', post.meta.updated || post.meta.date);
}

/* --- pillar post: "Must See Pumpkin Patches" (top 5 per state) ----------
   One long-form roundup covering every state we have data for, rather than
   one city or one attraction — the top of the site's content funnel. Kept
   deliberately text-only (no per-entry photo, no address/tag chips): the
   full-detail version of every entry already lives on its state, city and
   listing pages, and this piece's job is to link out to all of them rather
   than duplicate them. */
const pillarPosts = [];
{
  const h1 = 'Must See Pumpkin Patches To Visit This Halloween Season';
  const slug = slugify(h1);
  const path = `/blog/${slug}/`;
  const pillarAuthorSlug = 'emily-carter';
  const statePicks = stateNames.map((stateName) => ({
    stateName,
    top5: (byState.get(stateName) || []).slice(0, 5),
  }));
  const totalPicks = statePicks.reduce((sum, s) => sum + s.top5.length, 0);

  const heroSrc = pickBlogPhoto(0);
  const heroHtml = blogHeroFigureHtml(heroSrc, h1);

  const tocHtml = `<div class="tag-row">
${statePicks.map((s) => `  <a class="tag tag-link" href="#${attr(slugify(s.stateName))}">${esc(s.stateName)}</a>`).join('\n')}
</div>`;

  const introHtml = `<p>Halloween season means one thing above all: finding a pumpkin patch worth the drive. We pulled the ${esc(totalPicks.toLocaleString('en-US'))} highest-rated pumpkin patches from our directory — up to five per state, ranked by Google rating and review volume — into one list, state by state, so you can find the best option near you or scout one out before a trip. Jump to your state below, or read straight through for the full coast-to-coast picture.</p>
<p>Every farm below links to its full profile with hours, admission details and a map, and every state links to our complete, ranked directory of every pumpkin patch we track there — this list is the highlight reel, not the whole picture. For help narrowing it down once you're on a specific farm's page, see our guide to <a href="/blog/how-to-choose-a-pumpkin-patch/">choosing the right pumpkin patch for your group</a>, and check <a href="/blog/when-does-pumpkin-patch-season-start/">when pumpkin patch season actually starts</a> in your region before you plan the trip. Want to search instead of scroll? Head to <a href="/pumpkin-patches/">Find a Pumpkin Patch Near You</a> and filter by state, ZIP code or attraction.</p>
<p><button class="toggle-btn" type="button" data-geo-trigger>Show distance from me</button></p>`;

  const stateSectionsHtml = statePicks
    .map(({ stateName, top5 }) => {
      if (!top5.length) return '';
      const stateSlug = slugify(stateName);
      const entriesHtml = top5.map((l, i) => renderPillarEntry(l, i, stateName)).join('\n');
      return `<h2 id="${attr(stateSlug)}">${esc(stateName)}</h2>
<p>${esc(top5[0].name)} leads our ${esc(stateName)} picks${top5[0].rating ? `, rated ${top5[0].rating.toFixed(1)} out of 5` : ''}. <a href="${statePath(stateName)}">See every pumpkin patch we track in ${esc(stateName)} &rarr;</a></p>
<ol class="pillar-list">
${entriesHtml}
</ol>`;
    })
    .join('\n\n');

  const faqQa = [
    {
      q: 'How did you pick the pumpkin patches on this list?',
      a: 'Every farm here is ranked by its public Google rating and review volume, pulled from our full directory of tracked pumpkin patches. We show up to five per state — fewer if a state has fewer than five listed. Nothing on this list is a paid placement; claimed listings get priority within a directory page, but this roundup is ranked purely on rating and reviews.',
    },
    {
      q: 'What is the single best pumpkin patch in the country?',
      a: "There isn't one objectively — ratings are strong within a farm's own market but aren't a fair way to compare, say, a small u-pick lot in one state against a destination agritourism farm in another. Use this list to find the strongest options in your own state, or nearby ones, rather than chasing a single national \"best.\"",
    },
    {
      q: 'When should I visit a pumpkin patch this Halloween season?',
      a: 'Most patches nationwide run from mid-to-late September through the first days of November, with the two or three weekends around mid-October the busiest by far. Weekday mornings are consistently the quietest time to go. See our full <a href="/blog/when-does-pumpkin-patch-season-start/">season timing guide</a> for how this shifts by region.',
    },
    {
      q: 'Are the pumpkin patches on this list good for young kids?',
      a: "It varies by farm — check the feature tags and details on each farm's own listing page, which we link to throughout. Petting zoos and dedicated play areas are the two features that tend to matter most for toddlers and preschoolers specifically.",
    },
    {
      q: 'How often is this list updated?',
      a: "This page rebuilds from the same live directory data as the rest of the site, so rankings reflect current ratings and review counts as of publish. Individual farm hours, pricing and what's running on a given day can still change week to week during the season — always confirm with the farm directly before you drive out.",
    },
  ];
  const faqHtml = `<h2>Frequently asked questions</h2>
<div class="faq-list">
${faqQa
  .map(
    (item) => `  <details class="faq-item">
    <summary>${esc(item.q)}</summary>
    <div class="faq-answer"><p>${item.a}</p></div>
  </details>`
  )
  .join('\n')}
</div>`;

  const closingSummary = `<h2>Summary</h2>
<p>This roundup covers our top-rated pumpkin patch picks in ${esc(String(statePicks.filter((s) => s.top5.length).length))} states, drawn straight from the ${esc(stats.listings.toLocaleString('en-US'))}-farm directory we maintain year-round. Ratings and review counts reflect public data at the time of writing and shift over time, and hours, admission and what's actually running can vary week to week during the season — always confirm with a farm directly before you drive out. For the complete, ranked list in any state, jump to its section above or start from <a href="/pumpkin-patches/">Find a Pumpkin Patch Near You</a>.</p>`;

  const tocSection = `<p class="listicle-toc"><strong>Jump to your state:</strong></p>
${tocHtml}`;

  const body = `${tocSection}
${introHtml}
${stateSectionsHtml}
${faqHtml}
${closingSummary}`;

  const description = `Our picks for the best pumpkin patches to visit this Halloween season, state by state — ranked by rating and reviews, with ${esc(totalPicks.toLocaleString('en-US'))} farms across ${esc(String(statePicks.filter((s) => s.top5.length).length))} states.`;
  const postMeta = {
    path,
    slug,
    title: h1,
    description,
    h1,
    excerpt: description,
    date: backdatedPostDate(slug),
    readingTime: '18 min read',
    author: pillarAuthorSlug,
  };
  pillarPosts.push({ meta: postMeta, body });

  const meta = {
    ...postMeta,
    nav: 'blog',
    layout: 'prose',
    ogType: 'article',
    trail: [{ label: 'Blog', href: '/blog/' }, { label: h1 }],
  };
  const pillarAuthor = authorsBySlug.get(pillarAuthorSlug);
  const allPicks = statePicks.flatMap((s) => s.top5);
  const jsonld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BlogPosting',
        headline: h1,
        description,
        datePublished: postMeta.date,
        dateModified: postMeta.date,
        mainEntityOfPage: SITE_URL + path,
        image: absImageUrl(heroSrc),
        author: pillarAuthor
          ? { '@type': 'Person', name: pillarAuthor.name, url: SITE_URL + authorPath(pillarAuthor), jobTitle: pillarAuthor.title }
          : { '@type': 'Organization', name: SITE_NAME, url: SITE_URL },
        publisher: {
          '@type': 'Organization',
          name: SITE_NAME,
          url: SITE_URL,
          logo: { '@type': 'ImageObject', url: `${SITE_URL}/assets/img/icon-512.png` },
        },
      },
      {
        '@type': 'ItemList',
        numberOfItems: allPicks.length,
        itemListElement: allPicks.slice(0, 25).map((l, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          url: SITE_URL + listingPath(l),
          name: l.name,
        })),
      },
      {
        '@type': 'FAQPage',
        mainEntity: faqQa.map((item) => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.a.replace(/<[^>]+>/g, '') },
        })),
      },
      breadcrumbJsonLd(meta.trail, path),
    ],
  };
  const byline = renderByline(pillarAuthorSlug, postMeta.date, postMeta.readingTime);
  const pillarScripts = `<script src="/assets/js/pillar-entry.js?v=${ASSET_VERSION}" defer></script>`;
  writePage(path, render(meta, heroHtml + byline + injectInArticleAd(body), { jsonld, scripts: pillarScripts }));
  addToSitemap(path, '0.7', 'weekly', postMeta.date);
}

/* --- programmatic "10 Best Pumpkin Patches in <State>" posts -------------
   One per state with at least STATE_POST_MIN_LISTINGS listings, using the
   same pillar-entry card format as the /state/ directory pages themselves
   (full address, phone/website, today's hours, "perfect for" line) rather
   than the heavier per-entry format the city posts use. Ranked by rating —
   byState is already sorted that way (featured first, then rating, then
   review volume). */
const STATE_POST_MIN_LISTINGS = 10;
const STATE_POST_COUNT = 10;

const statePosts = [];
let statePostIndex = 0;
for (const stateName of stateNames) {
  const items = byState.get(stateName) || [];
  if (items.length < STATE_POST_MIN_LISTINGS) continue;

  // Same-named business at the same city occasionally appears twice in the
  // source data (separate seasonal lots run by one operator) — dedupe on
  // name+city, not name alone, so a real chain with locations in two
  // different towns isn't wrongly treated as a duplicate.
  const seenNameCity = new Set();
  const distinct = items.filter((l) => {
    const key = `${l.name.trim().toLowerCase()}|${(l.city || '').trim().toLowerCase()}`;
    if (seenNameCity.has(key)) return false;
    seenNameCity.add(key);
    return true;
  });
  const topN = distinct.slice(0, STATE_POST_COUNT);
  const names = topN.map((l) => l.name);

  const stateAuthorSlug = authors[statePostIndex++ % authors.length].slug;
  const h1 = `${STATE_POST_COUNT} Best Pumpkin Patches in ${stateName}`;
  const slug = slugify(h1);
  const path = `/blog/${slug}/`;

  const heroSrc = (topN.find((l) => l.photo) || {}).photo || PLACEHOLDER_IMAGE;
  const heroHtml = blogHeroFigureHtml(heroSrc, `Pumpkin patches in ${stateName}`);

  const tocSection = `<p class="listicle-toc"><strong>Jump to:</strong> ${topN
    .map((l, i) => `<a href="#${attr(l.slug)}">${i + 1}. ${esc(l.name)}</a>`)
    .join(' <span aria-hidden="true">&middot;</span> ')}</p>`;

  const summaryIntro = `<p>The ${STATE_POST_COUNT} best pumpkin patches in ${esc(stateName)} are ${joinNatural(names.map((n) => esc(n)))}, ranked by rating and review volume out of the ${esc(items.length.toLocaleString('en-US'))} pumpkin patches we track statewide. Each entry below includes the full address, today's hours, and what visitors say the farm is best for. Want the complete, searchable list? See every pumpkin patch we track in <a href="${statePath(stateName)}">${esc(stateName)}</a>, or start from our <a href="/pumpkin-patches/">state-by-state directory</a>.</p>
<p><button class="toggle-btn" type="button" data-geo-trigger>Show distance from me</button></p>`;

  const listHtml = `<ol class="pillar-list">
${pillarEntriesWithAds(topN, (l, i) => renderPillarEntry(l, i, stateName))}
</ol>`;

  const faqQa = [
    {
      q: `Which pumpkin patch is the highest rated in ${stateName}?`,
      a: `${esc(topN[0].name)}${topN[0].city ? ` in ${esc(topN[0].city)}` : ''} tops this list${topN[0].rating ? `, rated ${topN[0].rating.toFixed(1)} out of 5${topN[0].reviews ? ` from ${topN[0].reviews.toLocaleString('en-US')} reviews` : ''}` : ''}. Ratings reflect public data at the time of writing and can shift over time.`,
    },
    {
      q: `When do pumpkin patches in ${stateName} open for the season?`,
      a: `Most pumpkin patches in ${stateName} open in mid-to-late September and run through the first days of November, though exact dates shift year to year with weather and how the pumpkin crop comes in. Check the individual listings above, or call ahead, to confirm current dates.`,
    },
    {
      q: `How much does it cost to visit a pumpkin patch in ${stateName}?`,
      a: `It varies by farm. Some charge only for the pumpkins you pick, priced individually or by weight; others charge a flat gate admission that bundles in attractions like a corn maze or hayride. See the admission details on each listing above where we have them, or call the farm directly.`,
    },
    {
      q: `Are pumpkin patches in ${stateName} open on weekdays?`,
      a: `Many are, though weekday hours are often shorter than weekends, and some smaller farms only open Friday through Sunday during the season. Weekday mornings are also the quietest time to visit if your schedule allows it.`,
    },
    {
      q: `How often is this list updated?`,
      a: `This page rebuilds from the same live directory data as the rest of the site, so rankings reflect current ratings and review counts as of publish. Individual farm hours, pricing and what's running on a given day can still change week to week during the season — always confirm with the farm directly before you drive out.`,
    },
  ];
  const faqHtml = `<h2>Frequently asked questions</h2>
<div class="faq-list">
${faqQa
  .map(
    (item) => `  <details class="faq-item">
    <summary>${esc(item.q)}</summary>
    <div class="faq-answer"><p>${esc(item.a)}</p></div>
  </details>`
  )
  .join('\n')}
</div>`;

  const closingSummary = `<h2>Summary</h2>
<p>${esc(topN[0].name)} tops our list of pumpkin patches in ${esc(stateName)}${topN[0].rating ? `, rated ${topN[0].rating.toFixed(1)} out of 5` : ''}, with ${joinNatural(names.slice(1).map((n) => esc(n)))} rounding out the top ${STATE_POST_COUNT}. Ratings and review counts reflect public data at the time of writing and can change, and hours, admission and what's actually running on a given day can vary week to week during the season — always confirm with the farm directly before you drive out. For the full, ranked, searchable list, see every <a href="${statePath(stateName)}">pumpkin patch we track in ${esc(stateName)}</a>.</p>`;

  const body = `${tocSection}
${summaryIntro}
${listHtml}
${faqHtml}
${closingSummary}`;

  const description = `The ${STATE_POST_COUNT} best pumpkin patches in ${stateName}, ranked by rating and reviews: ${joinNatural(names)}.`;
  const postMeta = {
    path,
    slug,
    title: `${h1} | Ranked by Rating`,
    description,
    h1,
    excerpt: description,
    date: backdatedPostDate(slug),
    readingTime: '9 min read',
    author: stateAuthorSlug,
  };

  statePosts.push({ meta: postMeta, body });

  const meta = {
    ...postMeta,
    nav: 'blog',
    layout: 'prose',
    ogType: 'article',
    trail: [{ label: 'Blog', href: '/blog/' }, { label: postMeta.h1 }],
  };
  const stateAuthor = authorsBySlug.get(stateAuthorSlug);
  const jsonld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BlogPosting',
        headline: postMeta.h1,
        description: postMeta.description,
        datePublished: postMeta.date,
        dateModified: postMeta.date,
        mainEntityOfPage: SITE_URL + path,
        image: absImageUrl(heroSrc),
        author: stateAuthor
          ? { '@type': 'Person', name: stateAuthor.name, url: SITE_URL + authorPath(stateAuthor), jobTitle: stateAuthor.title }
          : { '@type': 'Organization', name: SITE_NAME, url: SITE_URL },
        publisher: {
          '@type': 'Organization',
          name: SITE_NAME,
          url: SITE_URL,
          logo: { '@type': 'ImageObject', url: `${SITE_URL}/assets/img/icon-512.png` },
        },
      },
      {
        '@type': 'ItemList',
        numberOfItems: topN.length,
        itemListElement: topN.map((l, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          url: SITE_URL + listingPath(l),
          name: l.name,
        })),
      },
      {
        '@type': 'FAQPage',
        mainEntity: faqQa.map((item) => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.a },
        })),
      },
      breadcrumbJsonLd(meta.trail, path),
    ],
  };
  const byline = renderByline(stateAuthorSlug, postMeta.date, postMeta.readingTime);
  const statePostScripts = `<script src="/assets/js/pillar-entry.js?v=${ASSET_VERSION}" defer></script>`;
  writePage(path, render(meta, heroHtml + byline + injectInArticleAd(body), { jsonld, scripts: statePostScripts }));
  addToSitemap(path, '0.6', 'weekly', postMeta.date);
  addStateGuideLink(stateName, h1, path);
}

/* --- programmatic "10 Best Pumpkin Fields/Farms in <State>" posts --------
   Same per-state gate as the "10 Best Pumpkin Patches" posts above
   (STATE_POST_MIN_LISTINGS), but distinct titles ("Fields"/"Farms" vs
   "Patches") and the heavier renderListicleEntry format (H2 business
   names, full 500-word summaries, address and tags) that the city and
   attraction posts use, rather than the lighter pillar-entry cards —
   started as a hand-requested one-off for Georgia ("Fields"), then
   generalized to every qualifying state, then again into this shared
   function so "Farms" could reuse it as a second noun rather than a
   second copy of ~150 lines. */
function generateStateNounListicles(nounSingular) {
  const nounPlural = `${nounSingular}s`;
  let postIndex = 0;
  for (const stateName of stateNames) {
    const stateItems = byState.get(stateName) || [];
    if (stateItems.length < STATE_POST_MIN_LISTINGS) continue;

    const seenNames = new Set();
    const distinct = stateItems.filter((l) => {
      const key = l.name.trim().toLowerCase();
      if (seenNames.has(key)) return false;
      seenNames.add(key);
      return true;
    });
    const top10 = distinct.slice(0, STATE_POST_COUNT);
    const names = top10.map((l) => l.name);
    const postAuthorSlug = authors[postIndex++ % authors.length].slug;
    const h1 = `${STATE_POST_COUNT} Best Pumpkin ${nounPlural.charAt(0).toUpperCase()}${nounPlural.slice(1)} in ${stateName}`;
    const slug = slugify(h1);
    const path = `/blog/${slug}/`;

    const heroSrc = (top10.find((l) => l.photo) || {}).photo || PLACEHOLDER_IMAGE;
    const heroHtml = blogHeroFigureHtml(heroSrc, `Pumpkin ${nounPlural} in ${stateName}`);

    const tocSection = `<p class="listicle-toc"><strong>Jump to:</strong> ${top10
      .map((l, i) => `<a href="#${attr(l.slug)}">${i + 1}. ${esc(l.name)}</a>`)
      .join(' <span aria-hidden="true">&middot;</span> ')}</p>`;

    const linkedNames = top10.map((l) => `<a href="${listingPath(l)}">${esc(l.name)}</a>`);
    const summaryIntro = `<p>The ${STATE_POST_COUNT} best pumpkin ${nounPlural} in ${esc(stateName)} are ${joinNatural(linkedNames)}, ranked by rating and review volume out of the ${esc(stateItems.length.toLocaleString('en-US'))} pumpkin patches we track statewide. Below, each ${nounSingular} gets a closer look — what it offers, how it's rated, and how to get there — followed by a table of contents' worth of jumping-off points and answers to the questions we hear most about visiting a ${esc(stateName)} pumpkin ${nounSingular}. Want the complete, searchable list? See every pumpkin patch we track in <a href="${statePath(stateName)}">${esc(stateName)}</a>, or start from our <a href="/pumpkin-patches/">state-by-state directory</a>.</p>`;

    const listicleHtml = `<ol class="listicle">
${top10.map((l, i) => renderListicleEntry(l, i + 1, stateName)).join('\n')}
</ol>`;

    const kidFriendly = top10.filter((l) => (l.features || []).some((f) => ['Petting zoo', 'Kids play area'].includes(f)));
    const kidAnswer = kidFriendly.length
      ? `${joinNatural(kidFriendly.map((l) => esc(l.name)))} ${kidFriendly.length === 1 ? 'stands' : 'stand'} out for younger children on this list, with a petting zoo or a dedicated play area. Hours and what's running can change week to week, so confirm directly before you go.`
      : `None of the ${nounPlural} on this list are tagged with a dedicated kids' play area or petting zoo in our data, though most pumpkin ${nounPlural} are stroller- and toddler-friendly at a basic level. Call ahead if young kids need specific attractions.`;

    const faqQa = [
      {
        q: `What is the highest-rated pumpkin ${nounSingular} in ${stateName}?`,
        a: `${esc(top10[0].name)}${top10[0].city ? ` in ${esc(top10[0].city)}` : ''} tops this list${top10[0].rating ? `, rated ${top10[0].rating.toFixed(1)} out of 5${top10[0].reviews ? ` from ${top10[0].reviews.toLocaleString('en-US')} reviews` : ''}` : ''}. Ratings reflect public data at the time of writing and can shift over time.`,
      },
      {
        q: `When do pumpkin ${nounPlural} in ${stateName} open for the season?`,
        a: `Most ${stateName} pumpkin ${nounPlural} open in mid-to-late September and run through the first days of November, though exact dates shift year to year with weather and how the pumpkin crop comes in. Check the individual listings above, or call ahead, to confirm current dates.`,
      },
      {
        q: `How much does it cost to visit a pumpkin ${nounSingular} in ${stateName}?`,
        a: 'It varies by farm. Some charge only for the pumpkins you pick, priced individually or by weight; others charge a flat gate admission that bundles in attractions like a corn maze or hayride. See the admission details on each listing above where we have them, or call the farm directly.',
      },
      { q: `Which ${stateName} pumpkin ${nounSingular} is best for young kids?`, a: kidAnswer },
      {
        q: `Are ${stateName} pumpkin ${nounPlural} open on weekdays?`,
        a: 'Many are, though weekday hours are often shorter than weekends, and some smaller farms only open Friday through Sunday during the season. Weekday mornings are also the quietest time to visit if your schedule allows it.',
      },
    ];
    const faqHtml = `<h2>Frequently asked questions</h2>
<div class="faq-list">
${faqQa
  .map(
    (item) => `  <details class="faq-item">
    <summary>${esc(item.q)}</summary>
    <div class="faq-answer"><p>${esc(item.a)}</p></div>
  </details>`
  )
  .join('\n')}
</div>`;

    const conclusion = `<h2>Conclusion</h2>
<p>${esc(top10[0].name)} tops our list of ${esc(stateName)} pumpkin ${nounPlural}${top10[0].rating ? `, rated ${top10[0].rating.toFixed(1)} out of 5` : ''}, with ${joinNatural(names.slice(1).map((n) => esc(n)))} rounding out the top ${STATE_POST_COUNT}. Ratings and review counts reflect public data at the time of writing and can change, and hours, admission and what's actually running on a given day can vary week to week during the season — always confirm with the ${nounSingular} directly before you drive out. For the full, ranked, searchable list, see every <a href="${statePath(stateName)}">pumpkin patch we track in ${esc(stateName)}</a>.</p>`;

    const body = `${tocSection}
${summaryIntro}
${listicleHtml}
${conclusion}
${faqHtml}`;

    const description = `The ${STATE_POST_COUNT} best pumpkin ${nounPlural} in ${stateName}, ranked by rating and reviews: ${joinNatural(names)}.`;
    const postMeta = {
      path,
      slug,
      title: `${h1} | Ranked by Rating`,
      description,
      h1,
      excerpt: description,
      date: backdatedPostDate(slug),
      readingTime: '9 min read',
      author: postAuthorSlug,
    };

    const meta = {
      ...postMeta,
      nav: 'blog',
      layout: 'prose',
      ogType: 'article',
      trail: [{ label: 'Blog', href: '/blog/' }, { label: h1 }],
    };
    const postAuthor = authorsBySlug.get(postAuthorSlug);
    const jsonld = {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'BlogPosting',
          headline: h1,
          description,
          datePublished: postMeta.date,
          dateModified: postMeta.date,
          mainEntityOfPage: SITE_URL + path,
          image: absImageUrl(heroSrc),
          author: postAuthor
            ? { '@type': 'Person', name: postAuthor.name, url: SITE_URL + authorPath(postAuthor), jobTitle: postAuthor.title }
            : { '@type': 'Organization', name: SITE_NAME, url: SITE_URL },
          publisher: {
            '@type': 'Organization',
            name: SITE_NAME,
            url: SITE_URL,
            logo: { '@type': 'ImageObject', url: `${SITE_URL}/assets/img/icon-512.png` },
          },
        },
        {
          '@type': 'ItemList',
          numberOfItems: top10.length,
          itemListElement: top10.map((l, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            url: SITE_URL + listingPath(l),
            name: l.name,
          })),
        },
        {
          '@type': 'FAQPage',
          mainEntity: faqQa.map((item) => ({
            '@type': 'Question',
            name: item.q,
            acceptedAnswer: { '@type': 'Answer', text: item.a },
          })),
        },
        breadcrumbJsonLd(meta.trail, path),
      ],
    };
    const byline = renderByline(postAuthorSlug, postMeta.date, postMeta.readingTime);
    writePage(path, render(meta, heroHtml + byline + injectInArticleAd(body), { jsonld, scripts: `<script src="/assets/js/listicle-toggle.js?v=${ASSET_VERSION}" defer></script>` }));
    addToSitemap(path, '0.6', 'weekly', postMeta.date);
    handAuthoredPosts.push({ meta: postMeta, body });
    addStateGuideLink(stateName, h1, path);
  }
}

generateStateNounListicles('field');
generateStateNounListicles('farm');

/* --- programmatic "5 Best Pumpkin Patches To Pick Your Own Pumpkin in
   <State>" posts -----------------------------------------------------------
   Scoped to the real "U-pick pumpkins" feature tag, not every pumpkin
   patch in the state — only 35 of 48 states have any listing carrying it.
   Generated with at least one distinctly-named u-pick farm (same
   ATTRACTION_POST_MIN_LISTINGS=1 precedent as the per-city attraction
   posts), capped at 5, with the title/count reading singular for a state
   that only has one rather than a misleading fixed "5 Best". */
const UPICK_CATEGORY = categories.find((c) => c.slug === 'u-pick-pumpkin-patches');
const UPICK_POST_MAX = 5;
let upickPostIndex = 0;
for (const stateName of stateNames) {
  const stateItems = byState.get(stateName) || [];
  const seenUpickNames = new Set();
  const upickDistinct = stateItems.filter((l) => {
    if (!(l.features || []).includes(UPICK_CATEGORY.feature)) return false;
    const key = l.name.trim().toLowerCase();
    if (seenUpickNames.has(key)) return false;
    seenUpickNames.add(key);
    return true;
  });
  if (!upickDistinct.length) continue;

  const topN = upickDistinct.slice(0, UPICK_POST_MAX);
  const x = topN.length;
  const names = topN.map((l) => l.name);
  const upickAuthorSlug = authors[upickPostIndex++ % authors.length].slug;
  const h1 = x === 1
    ? `Best Pumpkin Patch To Pick Your Own Pumpkin in ${stateName}`
    : `${x} Best Pumpkin Patches To Pick Your Own Pumpkin in ${stateName}`;
  const slug = slugify(h1);
  const path = `/blog/${slug}/`;

  const heroSrc = (topN.find((l) => l.photo) || {}).photo || PLACEHOLDER_IMAGE;
  const heroHtml = blogHeroFigureHtml(heroSrc, `U-pick pumpkin patches in ${stateName}`);

  const tocSection = `<p class="listicle-toc"><strong>Jump to:</strong> ${topN
    .map((l, i) => `<a href="#${attr(l.slug)}">${i + 1}. ${esc(l.name)}</a>`)
    .join(' <span aria-hidden="true">&middot;</span> ')}</p>`;

  const linkedNames = topN.map((l) => `<a href="${listingPath(l)}">${esc(l.name)}</a>`);
  const summaryIntro = x === 1
    ? `<p>The best place to pick your own pumpkin in ${esc(stateName)} is ${linkedNames[0]} — the only farm we track statewide that's tagged for true u-pick, where you cut a pumpkin straight from the vine instead of choosing from a pile by the barn. Here's a closer look at what it offers, how it's rated, and how to get there, followed by answers to the questions we hear most about visiting. See every pumpkin patch we track in <a href="${statePath(stateName)}">${esc(stateName)}</a>, or browse u-pick farms in every state on our <a href="${categoryPath(UPICK_CATEGORY)}">U-Pick Pumpkin Patches near me</a> page.</p>`
    : `<p>The ${x} best places to pick your own pumpkin in ${esc(stateName)} are ${joinNatural(linkedNames)} — farms tagged for true u-pick, where you cut a pumpkin straight from the vine instead of choosing from a pile by the barn. Below, each gets a closer look — what it offers, how it's rated, and how to get there — followed by answers to the questions we hear most about visiting. See every pumpkin patch we track in <a href="${statePath(stateName)}">${esc(stateName)}</a>, or browse u-pick farms in every state on our <a href="${categoryPath(UPICK_CATEGORY)}">U-Pick Pumpkin Patches near me</a> page.</p>`;

  const listicleHtml = `<ol class="listicle">
${topN.map((l, i) => renderListicleEntry(l, i + 1, stateName)).join('\n')}
</ol>`;

  const faqQa = [
    {
      q: `What is the best pumpkin patch to pick your own pumpkin in ${stateName}?`,
      a: `Based on rating and review volume, ${esc(topN[0].name)} ranks first among the u-pick pumpkin patches we track in ${esc(stateName)}${topN[0].rating ? `, with a ${topN[0].rating.toFixed(1)}-out-of-5 rating` : ''}. See the full breakdown above, or its <a href="${listingPath(topN[0])}">full listing</a> for hours and directions.`,
    },
    {
      q: `What does "u-pick" actually mean at a pumpkin patch?`,
      a: `True u-pick means walking into a growing field and cutting a pumpkin off the vine yourself, rather than choosing from a pile of pumpkins trucked in and arranged near the barn. Both are common — if cutting from the vine matters to you, call ahead and ask whether the field is still open, especially late in the season.`,
    },
    {
      q: `When is u-pick season in ${stateName}?`,
      a: `Most u-pick fields open alongside the rest of the pumpkin season, roughly mid-to-late September through the first days of November, and smaller growers can pick out and switch to a pre-picked pile before the season officially ends. Check the listings above or call ahead to confirm the field is still open.`,
    },
    {
      q: `What should I bring to pick my own pumpkin?`,
      a: `Gloves and, ideally, your own shears — pumpkin vines are prickly, and a cleanly cut stem two to four inches long keeps a pumpkin fresh far longer than one twisted off by hand. Wear shoes you don't mind getting muddy, since fields are working farmland, not paved lots.`,
    },
    {
      q: x === 1 ? `Is this u-pick patch good for young kids?` : `Are these u-pick patches good for young kids?`,
      a: `It depends on the farm and how far the field is from parking. Check the individual listing pages above for feature tags like a petting zoo or kids' play area, and call ahead if you're planning around young children or strollers.`,
    },
  ];
  const faqHtml = `<h2>Frequently asked questions</h2>
<div class="faq-list">
${faqQa
  .map(
    (item) => `  <details class="faq-item">
    <summary>${esc(item.q)}</summary>
    <div class="faq-answer"><p>${esc(item.a)}</p></div>
  </details>`
  )
  .join('\n')}
</div>`;

  const conclusion = `<h2>Conclusion</h2>
<p>${esc(topN[0].name)} is${x > 1 ? ' our top pick' : ' the only farm we currently track'} for picking your own pumpkin in ${esc(stateName)}${topN[0].rating ? `, rated ${topN[0].rating.toFixed(1)} out of 5` : ''}${x > 1 ? `, with ${joinNatural(names.slice(1).map((n) => esc(n)))} rounding out the list` : ''}. Ratings and review counts reflect public data at the time of writing and can change, and hours, admission and what's actually running on a given day can vary week to week during the season — always confirm with the farm directly, and ask specifically whether the field is still open for cutting, before you drive out. For more options, see every <a href="${statePath(stateName)}">pumpkin patch we track in ${esc(stateName)}</a> or browse <a href="${categoryPath(UPICK_CATEGORY)}">u-pick pumpkin patches near you</a>.</p>`;

  const body = `${tocSection}
${summaryIntro}
${listicleHtml}
${conclusion}
${faqHtml}`;

  const description = x === 1
    ? `The best pumpkin patch to pick your own pumpkin in ${stateName} is ${names[0]}. See its rating, hours and directions before you go.`
    : `The ${x} best pumpkin patches to pick your own pumpkin in ${stateName}: ${joinNatural(names)}. Ranked by rating and reviews.`;
  const postMeta = {
    path,
    slug,
    title: `${h1} | Ranked by Rating`,
    description,
    h1,
    excerpt: description,
    date: backdatedPostDate(slug),
    readingTime: '7 min read',
    author: upickAuthorSlug,
  };

  const meta = {
    ...postMeta,
    nav: 'blog',
    layout: 'prose',
    ogType: 'article',
    trail: [{ label: 'Blog', href: '/blog/' }, { label: h1 }],
  };
  const upickAuthor = authorsBySlug.get(upickAuthorSlug);
  const jsonld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BlogPosting',
        headline: h1,
        description,
        datePublished: postMeta.date,
        dateModified: postMeta.date,
        mainEntityOfPage: SITE_URL + path,
        image: absImageUrl(heroSrc),
        author: upickAuthor
          ? { '@type': 'Person', name: upickAuthor.name, url: SITE_URL + authorPath(upickAuthor), jobTitle: upickAuthor.title }
          : { '@type': 'Organization', name: SITE_NAME, url: SITE_URL },
        publisher: {
          '@type': 'Organization',
          name: SITE_NAME,
          url: SITE_URL,
          logo: { '@type': 'ImageObject', url: `${SITE_URL}/assets/img/icon-512.png` },
        },
      },
      {
        '@type': 'ItemList',
        numberOfItems: topN.length,
        itemListElement: topN.map((l, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          url: SITE_URL + listingPath(l),
          name: l.name,
        })),
      },
      {
        '@type': 'FAQPage',
        mainEntity: faqQa.map((item) => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.a },
        })),
      },
      breadcrumbJsonLd(meta.trail, path),
    ],
  };
  const byline = renderByline(upickAuthorSlug, postMeta.date, postMeta.readingTime);
  writePage(path, render(meta, heroHtml + byline + injectInArticleAd(body), { jsonld, scripts: `<script src="/assets/js/listicle-toggle.js?v=${ASSET_VERSION}" defer></script>` }));
  addToSitemap(path, '0.6', 'weekly', postMeta.date);
  handAuthoredPosts.push({ meta: postMeta, body });
  addStateGuideLink(stateName, h1, path, UPICK_CATEGORY.slug);
  addCategoryStateGuideLink(UPICK_CATEGORY.slug, stateName, h1, path);
}

/* --- programmatic "What Are The Prices Of Pumpkins At a Pumpkin Patch in
   <State>?" posts -----------------------------------------------------------
   An educational cost guide, not a business ranking — every tracked state
   gets one (stateNames already guarantees at least one listing). Pricing
   itself isn't a field in the Outscraper data — no listing anywhere in the
   dataset has an admission figure — so this deliberately never states a
   dollar figure as if it were this site's own verified data for that
   state. It's framed the same honest way the existing national
   /blog/how-much-does-a-pumpkin-patch-cost/ guide already is: real,
   widely-known pricing models and typical nationwide ranges, explicitly
   applied to a first-timer's question about a specific state rather than
   invented as state-specific statistics. What IS genuinely state-specific
   is real: the count of farms this site tracks there, and links to that
   state's own directory and any per-state posts it qualifies for. */
for (const stateName of stateNames) {
  const stateItems = byState.get(stateName) || [];
  const priceAuthorSlug = authors[(stateNames.indexOf(stateName) + 1) % authors.length].slug;
  const h1 = `What Are The Prices Of Pumpkins At a Pumpkin Patch in ${stateName}?`;
  const slug = slugify(h1);
  const path = `/blog/${slug}/`;

  const heroSrc = (stateItems.find((l) => l.photo) || {}).photo || PLACEHOLDER_IMAGE;
  const heroHtml = blogHeroFigureHtml(heroSrc, `Pumpkin patch pricing in ${stateName}`);

  const upickCount = new Set(
    stateItems.filter((l) => (l.features || []).includes(UPICK_CATEGORY.feature)).map((l) => l.name.trim().toLowerCase())
  ).size;
  const qualifiesForStatePost = stateItems.length >= STATE_POST_MIN_LISTINGS;

  const intro = `<p>If you've never been to a pumpkin patch before, the honest answer is: it depends entirely on which one you walk into. A family of four can spend $18 at one farm in ${esc(stateName)} and $140 at another on the same Saturday, and neither farm is doing anything wrong — they're just running different kinds of businesses. We track ${esc(stateItems.length.toLocaleString('en-US'))} pumpkin patch${stateItems.length === 1 ? '' : 'es'} in ${esc(stateName)}, and we don't collect pricing as a data field (farms change it too often, season to season, for us to promise it's current) — but the pricing <em>models</em> themselves are consistent and predictable nationwide, and knowing which one you're walking into is really the whole trick. Here's what to expect, what to bring, and what actually drives the total.</p>`;

  const modelsSection = `<h2>How pumpkin patch pricing actually works</h2>
<p>Almost every pumpkin patch in the country, ${esc(stateName)} included, prices itself one of three ways. Knowing which one a farm uses before you drive out tells you more about your total cost than almost anything else.</p>
<h3>1. Free entry, pay for pumpkins</h3>
<p>Typical of smaller working farms and roadside u-pick operations. There's no gate fee — you walk the field, cut what you want, and pay at a stand on the way out. Pumpkins are priced either <strong>per pumpkin</strong> (commonly $5–$12 for a carving-size pumpkin, $2–$4 for pie pumpkins and gourds) or <strong>by the pound</strong> (commonly $0.49–$0.89 per pound, which puts a 20-pound carver around $10–$18). A typical family of four spends <strong>$25–$50</strong> here.</p>
<h3>2. Flat admission, pumpkins extra</h3>
<p>The agritourism model — a gate price that bundles the corn maze, hayride, play areas and animal barn, with pumpkins sold separately at the exit. Weekend admission commonly runs <strong>$10–$25 per person</strong>, often half that on weekdays. A typical family of four spends <strong>$70–$140</strong> including a couple of pumpkins and some food.</p>
<h3>3. Wristbands and à la carte</h3>
<p>A middle path: free or cheap entry, with individual attractions priced separately and an all-access wristband — usually $20–$30 — for anyone who wants everything. A typical family of four spends <strong>$30–$110</strong> depending on how much they do.</p>
<p>None of this is specific to ${esc(stateName)} — it's how the industry works nationwide — but it's exactly what determines whether your day costs $20 or $130, wherever you go. <a href="/blog/how-much-does-a-pumpkin-patch-cost/">See the full national cost breakdown</a> for more on all three, including what catches first-timers off guard.</p>`;

  const extrasSection = `<h2>What else costs extra</h2>
<ul>
  <li><strong>Corn mazes and haunted attractions</strong> are frequently priced separately from daytime admission, and a haunted trail is almost always a different evening time slot — don't assume a daytime wristband covers it.</li>
  <li><strong>Food</strong> is priced like festival food. Cider donuts, kettle corn and hot cider add up fast; budget $30–$50 for a family of four if you're not eating beforehand.</li>
  <li><strong>Photo sessions.</strong> Some larger farms now charge separately for professional photography on the property, sometimes with rules about tripods or professional gear without a booked slot.</li>
  <li><strong>Parking</strong> is usually free but is a $5–$10 add-on at a minority of bigger operations.</li>
</ul>`;

  const paymentSection = `<h2>Cash or card?</h2>
<p>Bring both, but lean on cash as your backup. Card readers are common at the main farm store, but wagon rides, field admission and satellite stands are still frequently cash-only — and cell service at rural farms is often too weak for a card reader to work reliably even when a farm intends to accept one. $40–$60 in small bills covers most visits without a trip back to the car.</p>`;

  const budgetSection = `<h2>What a family of four typically spends</h2>
<p>Pulling the three models together: a bare-bones u-pick visit runs <strong>$25–$50</strong>, a full agritourism day with a maze and hayride runs <strong>$70–$140</strong>, and an à la carte visit lands <strong>$30–$110</strong> depending on what you add. If your actual goal is a pumpkin on the porch and a nice photo, the free-entry u-pick route delivers that for a fraction of the flat-admission price — often in a prettier field, too.</p>`;

  const savingSection = `<h2>How to spend less in ${esc(stateName)}</h2>
<ul>
  <li><strong>Go on a weekday.</strong> The single biggest saving available — often 40–50% off weekend admission.</li>
  <li><strong>Call ahead and ask which pricing model a farm uses.</strong> Two minutes on the phone is the difference between planning a $25 day and a $130 one.</li>
  <li><strong>Buy pumpkins on your way out</strong> rather than carrying them around the farm for three hours.</li>
  <li><strong>Check for a season pass</strong> if you're planning more than one visit — it frequently breaks even on the second trip.</li>
  <li><strong>Visit late in the season.</strong> Farms clearing a field in the last days of October often sell pumpkins at a flat, cheap rate or by the carload.</li>
</ul>`;

  const upickPostSlug = upickCount === 1
    ? slugify(`Best Pumpkin Patch To Pick Your Own Pumpkin in ${stateName}`)
    : upickCount > 1
      ? slugify(`${Math.min(upickCount, 5)} Best Pumpkin Patches To Pick Your Own Pumpkin in ${stateName}`)
      : null;
  const fieldsPostSlug = qualifiesForStatePost ? slugify(`${STATE_POST_COUNT} Best Pumpkin Fields in ${stateName}`) : null;
  const farmsPostSlug = qualifiesForStatePost ? slugify(`${STATE_POST_COUNT} Best Pumpkin Farms in ${stateName}`) : null;
  const relatedLinks = [
    `<a href="${statePath(stateName)}">Every pumpkin patch we track in ${esc(stateName)}</a>`,
    qualifiesForStatePost ? `<a href="/blog/${fieldsPostSlug}/">${STATE_POST_COUNT} Best Pumpkin Fields in ${esc(stateName)}</a>` : null,
    qualifiesForStatePost ? `<a href="/blog/${farmsPostSlug}/">${STATE_POST_COUNT} Best Pumpkin Farms in ${esc(stateName)}</a>` : null,
    upickPostSlug ? `<a href="/blog/${upickPostSlug}/">Where to pick your own pumpkin in ${esc(stateName)}</a>` : null,
    `<a href="${categoryPath(UPICK_CATEGORY)}">U-Pick Pumpkin Patches near me</a>`,
  ].filter(Boolean);

  const trackedSection = `<h2>Pumpkin patches we track in ${esc(stateName)}</h2>
<p>We track ${esc(stateItems.length.toLocaleString('en-US'))} pumpkin patch${stateItems.length === 1 ? '' : 'es'} in ${esc(stateName)}${upickCount ? `, ${esc(String(upickCount))} of which ${upickCount === 1 ? 'is' : 'are'} tagged for true u-pick (cutting straight from the vine, not a pre-picked pile)` : ''}. None of them list a price with us — that's exactly why calling ahead matters — but you can see ratings, addresses, hours and directions for every one:</p>
<ul>
${relatedLinks.map((l) => `  <li>${l}</li>`).join('\n')}
</ul>`;

  const faqQa = [
    {
      q: `Do pumpkin patches in ${stateName} charge admission?`,
      a: `Some do and some don't — it's genuinely split roughly into the three pricing models above. Smaller u-pick farms are frequently free to enter with pumpkins priced individually, while larger agritourism-style farms almost always charge a gate fee. Call ahead or check the farm's own website or social media, since we don't track pricing directly.`,
    },
    {
      q: 'Is it cheaper to pick your own pumpkin than to buy one at the entrance?',
      a: "Usually, yes, and it's also typically a better experience — you're choosing from the full field rather than a pre-picked pile. U-pick farms also tend to run the free-entry pricing model, which keeps the total lower even before you factor that in.",
    },
    {
      q: 'Do kids get in free?',
      a: 'At flat-admission farms, very young children (usually under 2 or under 3) are commonly free, with everyone older paying the same per-head price as adults. It varies by farm, so confirm the age cutoff when you call.',
    },
    {
      q: `What's the cheapest way to visit a pumpkin patch in ${stateName}?`,
      a: 'A weekday visit to a free-entry u-pick farm, paying only for the pumpkin itself, is consistently the least expensive version of this trip — often a third of the cost of a weekend visit to a flat-admission farm with a corn maze and hayride included.',
    },
    {
      q: 'Are prices different on weekends?',
      a: "Often significantly — frequently double at flat-admission farms. If your schedule allows any flexibility, a weekday visit in mid-October is both cheaper and noticeably quieter than the same week's Saturday.",
    },
  ];
  const faqHtml = `<h2>Frequently asked questions</h2>
<div class="faq-list">
${faqQa
  .map(
    (item) => `  <details class="faq-item">
    <summary>${esc(item.q)}</summary>
    <div class="faq-answer"><p>${item.a}</p></div>
  </details>`
  )
  .join('\n')}
</div>`;

  const conclusion = `<h2>Conclusion</h2>
<p>There's no single answer to "what does a pumpkin patch cost in ${esc(stateName)}" because the honest answer depends on which of the three pricing models the farm you pick actually runs — not on the state you're in. A free-entry u-pick farm and a full agritourism destination can sit five miles apart and charge wildly different totals for what is, at its core, the same afternoon out. Decide which kind of day you actually want — a cheap pumpkin and a nice photo, or a few hours of maze-and-hayride entertainment — and call ahead to confirm which model the farm uses before you go. For the full national breakdown of what catches people out, see <a href="/blog/how-much-does-a-pumpkin-patch-cost/">How Much Does a Pumpkin Patch Cost?</a>, and for help matching a specific farm to your group, see <a href="/blog/how-to-choose-a-pumpkin-patch/">How to Choose the Right Pumpkin Patch</a>.</p>`;

  const { toc, body: sectionsWithIds } = autoToc(`${modelsSection}
${extrasSection}
${paymentSection}
${budgetSection}
${savingSection}
${trackedSection}
${faqHtml}
${conclusion}`);
  const body = `${intro}
${toc}
${sectionsWithIds}`;

  const description = `What pumpkins and admission actually cost at a pumpkin patch in ${stateName}: the three pricing models, typical ranges, cash-vs-card, and how to spend less.`;
  const postMeta = {
    path,
    slug,
    title: `${h1} | Cost Guide`,
    description,
    h1,
    excerpt: `A first-timer's guide to pumpkin patch pricing in ${stateName} — the three pricing models, what things typically cost, and how to spend less.`,
    date: backdatedPostDate(slug),
    readingTime: '8 min read',
    author: priceAuthorSlug,
  };

  const meta = {
    ...postMeta,
    nav: 'blog',
    layout: 'prose',
    ogType: 'article',
    trail: [{ label: 'Blog', href: '/blog/' }, { label: h1 }],
  };
  const priceAuthor = authorsBySlug.get(priceAuthorSlug);
  const jsonld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BlogPosting',
        headline: h1,
        description,
        datePublished: postMeta.date,
        dateModified: postMeta.date,
        mainEntityOfPage: SITE_URL + path,
        image: absImageUrl(heroSrc),
        author: priceAuthor
          ? { '@type': 'Person', name: priceAuthor.name, url: SITE_URL + authorPath(priceAuthor), jobTitle: priceAuthor.title }
          : { '@type': 'Organization', name: SITE_NAME, url: SITE_URL },
        publisher: {
          '@type': 'Organization',
          name: SITE_NAME,
          url: SITE_URL,
          logo: { '@type': 'ImageObject', url: `${SITE_URL}/assets/img/icon-512.png` },
        },
      },
      {
        '@type': 'FAQPage',
        mainEntity: faqQa.map((item) => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.a.replace(/<[^>]+>/g, '') },
        })),
      },
      breadcrumbJsonLd(meta.trail, path),
    ],
  };
  const byline = renderByline(priceAuthorSlug, postMeta.date, postMeta.readingTime);
  writePage(path, render(meta, heroHtml + byline + injectInArticleAd(body), { jsonld }));
  addToSitemap(path, '0.6', 'weekly', postMeta.date);
  handAuthoredPosts.push({ meta: postMeta, body });
  addStateGuideLink(stateName, h1, path);
}

/* --- programmatic per-state attraction listicles (petting zoos, fall
   festivals) -----------------------------------------------------------
   Generalizes the U-pick state-listicle pattern above for any category in
   categories.json: scoped to the real feature tag, skips states with zero
   matches, and reads singular/plural depending on how many distinctly-named
   businesses actually qualify (same no-fabrication precedent as every other
   state-post generator in this file). content.* callbacks supply the
   category-specific prose while the shared plumbing — TOC, JSON-LD,
   sitemap, handAuthoredPosts — lives here once.
   catOrSlug accepts either a real categories.json slug, or a plain
   { slug, name, singular } object for a series (like the Halloween pumpkin
   patch guides) that isn't scoped to one feature tag — pass
   content.itemFilter in that case to override the default feature-tag
   filter. */
function generateStateAttractionListicles(catOrSlug, content) {
  const cat = typeof catOrSlug === 'string' ? categories.find((c) => c.slug === catOrSlug) : catOrSlug;
  const itemFilter = content.itemFilter || ((l) => (l.features || []).includes(cat.feature));
  const max = content.max || 5;
  let postIndex = 0;
  for (const stateName of stateNames) {
    const stateItems = byState.get(stateName) || [];
    const seen = new Set();
    const distinct = stateItems.filter((l) => {
      if (!itemFilter(l)) return false;
      const key = l.name.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!distinct.length) continue;

    const topN = distinct.slice(0, max);
    const x = topN.length;
    const names = topN.map((l) => l.name);
    const linkedNames = topN.map((l) => `<a href="${listingPath(l)}">${esc(l.name)}</a>`);
    const authorSlug = authors[postIndex++ % authors.length].slug;

    const h1 = x === 1 ? content.titleSingular(stateName) : content.titlePlural(x, stateName);
    const slug = slugify(h1);
    const path = `/blog/${slug}/`;

    const heroSrc = (topN.find((l) => l.photo) || {}).photo || PLACEHOLDER_IMAGE;
    const heroHtml = blogHeroFigureHtml(heroSrc, content.heroAlt(stateName));

    const tocSection = `<p class="listicle-toc"><strong>Jump to:</strong> ${topN
      .map((l, i) => `<a href="#${attr(l.slug)}">${i + 1}. ${esc(l.name)}</a>`)
      .join(' <span aria-hidden="true">&middot;</span> ')}</p>`;

    const summaryIntro = content.intro({ topN, x, names, linkedNames, stateName, cat });
    const listicleHtml = `<ol class="listicle">
${topN.map((l, i) => renderListicleEntry(l, i + 1, stateName)).join('\n')}
</ol>`;

    const faqQa = content.faq({ topN, x, names, stateName, cat });
    const faqHtml = `<h2>Frequently asked questions</h2>
<div class="faq-list">
${faqQa
  .map(
    (item) => `  <details class="faq-item">
    <summary>${esc(item.q)}</summary>
    <div class="faq-answer"><p>${item.a}</p></div>
  </details>`
  )
  .join('\n')}
</div>`;

    const conclusion = content.conclusion({ topN, x, names, stateName, cat });

    const body = `${tocSection}
${summaryIntro}
${listicleHtml}
${conclusion}
${faqHtml}`;

    const description = content.description({ topN, x, names, stateName });
    const postMeta = {
      path,
      slug,
      title: `${h1} | Ranked by Rating`,
      description,
      h1,
      excerpt: description,
      date: backdatedPostDate(slug),
      readingTime: content.readingTime || '7 min read',
      author: authorSlug,
    };

    const meta = {
      ...postMeta,
      nav: 'blog',
      layout: 'prose',
      ogType: 'article',
      trail: [{ label: 'Blog', href: '/blog/' }, { label: h1 }],
    };
    const author = authorsBySlug.get(authorSlug);
    const jsonld = {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'BlogPosting',
          headline: h1,
          description,
          datePublished: postMeta.date,
          dateModified: postMeta.date,
          mainEntityOfPage: SITE_URL + path,
          image: absImageUrl(heroSrc),
          author: author
            ? { '@type': 'Person', name: author.name, url: SITE_URL + authorPath(author), jobTitle: author.title }
            : { '@type': 'Organization', name: SITE_NAME, url: SITE_URL },
          publisher: {
            '@type': 'Organization',
            name: SITE_NAME,
            url: SITE_URL,
            logo: { '@type': 'ImageObject', url: `${SITE_URL}/assets/img/icon-512.png` },
          },
        },
        {
          '@type': 'ItemList',
          numberOfItems: topN.length,
          itemListElement: topN.map((l, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            url: SITE_URL + listingPath(l),
            name: l.name,
          })),
        },
        {
          '@type': 'FAQPage',
          mainEntity: faqQa.map((item) => ({
            '@type': 'Question',
            name: item.q,
            acceptedAnswer: { '@type': 'Answer', text: item.a.replace(/<[^>]+>/g, '') },
          })),
        },
        breadcrumbJsonLd(meta.trail, path),
      ],
    };
    const byline = renderByline(authorSlug, postMeta.date, postMeta.readingTime);
    writePage(path, render(meta, heroHtml + byline + injectInArticleAd(body), { jsonld, scripts: `<script src="/assets/js/listicle-toggle.js?v=${ASSET_VERSION}" defer></script>` }));
    addToSitemap(path, '0.6', 'weekly', postMeta.date);
    handAuthoredPosts.push({ meta: postMeta, body });
    addStateGuideLink(stateName, h1, path, cat.slug);
    addCategoryStateGuideLink(cat.slug, stateName, h1, path);
  }
}

generateStateAttractionListicles('petting-zoos', {
  titleSingular: (s) => `Best Pumpkin Patch With a Petting Zoo in ${s}`,
  titlePlural: (x, s) => `${x} Best Pumpkin Patches With a Petting Zoo in ${s}`,
  heroAlt: (s) => `Pumpkin patches with a petting zoo in ${s}`,
  description: ({ x, names, stateName }) =>
    x === 1
      ? `The best pumpkin patch with a petting zoo in ${stateName} is ${names[0]}. See its rating, hours and directions before you go.`
      : `The ${x} best pumpkin patches with a petting zoo in ${stateName}: ${joinNatural(names)}. Ranked by rating and reviews.`,
  intro: ({ x, linkedNames, stateName, cat }) =>
    x === 1
      ? `<p>The best pumpkin patch with a petting zoo in ${esc(stateName)} is ${linkedNames[0]} — the only farm we track statewide tagged for farm animals kids can get close to, alongside the pumpkins. For toddlers and preschoolers especially, an animal barn is often worth more than every other attraction on the farm combined. Here's a closer look at what it offers, how it's rated, and how to get there, followed by answers to the questions we hear most about visiting. See every pumpkin patch we track in <a href="${statePath(stateName)}">${esc(stateName)}</a>, or browse pumpkin patches with petting zoos in every state on our <a href="${categoryPath(cat)}">Petting Zoos and Farm Animals near me</a> page.</p>`
      : `<p>The ${x} best pumpkin patches with a petting zoo in ${esc(stateName)} are ${joinNatural(linkedNames)} — farms tagged for farm animals kids can get close to, alongside the pumpkins. For toddlers and preschoolers especially, an animal barn is often worth more than every other attraction on the farm combined. Below, each gets a closer look — what it offers, how it's rated, and how to get there — followed by answers to the questions we hear most about visiting. See every pumpkin patch we track in <a href="${statePath(stateName)}">${esc(stateName)}</a>, or browse pumpkin patches with petting zoos in every state on our <a href="${categoryPath(cat)}">Petting Zoos and Farm Animals near me</a> page.</p>`,
  faq: ({ topN, x, stateName }) => [
    {
      q: `What is the best pumpkin patch with a petting zoo in ${stateName}?`,
      a: `Based on rating and review volume, ${esc(topN[0].name)} ranks first among the pumpkin patches with a petting zoo we track in ${esc(stateName)}${topN[0].rating ? `, with a ${topN[0].rating.toFixed(1)}-out-of-5 rating` : ''}. See the full breakdown above, or its <a href="${listingPath(topN[0])}">full listing</a> for hours and directions.`,
    },
    {
      q: `What animals are usually at a pumpkin patch petting zoo?`,
      a: `It varies by farm, but goats, sheep, alpacas, rabbits and barn cats are the most common. Larger farms sometimes add pigs, ponies or a small aviary. Feed cups are usually available for a dollar or two even when general admission is free.`,
    },
    {
      q: `Is the petting zoo included in admission?`,
      a: `At most farms, yes — the animal barn is bundled into general admission rather than ticketed separately. It's still worth confirming when you call, since a minority of larger destination farms do charge extra for it.`,
    },
    {
      q: `Are petting zoos safe for toddlers?`,
      a: `Generally yes, with normal precautions. Well-run farms provide hand-washing stations near the animal area and it's worth using them properly — animal contact areas are a recognized source of E. coli and salmonella exposure in young children. Strollers are frequently not permitted inside the enclosure itself, so plan for carrying.`,
    },
    {
      q: x === 1 ? `Is this pumpkin patch good for young kids?` : `Are these pumpkin patches good for young kids?`,
      a: `Yes — a petting zoo is one of the two features (alongside a dedicated kids' play area) that most reliably holds a toddler's or preschooler's attention. Check the listings above for hours, and call ahead if you're planning specifically around animal-barn access.`,
    },
  ],
  conclusion: ({ topN, x, names, stateName }) => `<h2>Conclusion</h2>
<p>${esc(topN[0].name)} is${x > 1 ? ' our top pick' : ' the only farm we currently track'} for a pumpkin patch with a petting zoo in ${esc(stateName)}${topN[0].rating ? `, rated ${topN[0].rating.toFixed(1)} out of 5` : ''}${x > 1 ? `, with ${joinNatural(names.slice(1).map((n) => esc(n)))} rounding out the list` : ''}. Ratings and review counts reflect public data at the time of writing and can change, and which animals are on site — and whether the barn is open that day — can vary week to week, so always confirm with the farm directly before you drive out. For more options, see every <a href="${statePath(stateName)}">pumpkin patch we track in ${esc(stateName)}</a>.</p>`,
});

generateStateAttractionListicles('fall-festivals', {
  titleSingular: (s) => `Best Pumpkin Patch Fall Festival in ${s}`,
  titlePlural: (x, s) => `${x} Best Pumpkin Patch Fall Festivals in ${s}`,
  heroAlt: (s) => `Fall festivals at pumpkin patches in ${s}`,
  description: ({ x, names, stateName }) =>
    x === 1
      ? `The best pumpkin patch fall festival in ${stateName} is ${names[0]}. See its rating, hours and directions before you go.`
      : `The ${x} best pumpkin patch fall festivals in ${stateName}: ${joinNatural(names)}. Ranked by rating and reviews.`,
  intro: ({ x, linkedNames, stateName, cat }) =>
    x === 1
      ? `<p>The best pumpkin patch fall festival in ${esc(stateName)} is ${linkedNames[0]} — the only farm we track statewide tagged for a dedicated festival weekend, running its full lineup of attractions, food vendors and live music at once, alongside the pumpkins. Here's a closer look at what it offers, how it's rated, and how to get there, followed by answers to the questions we hear most about visiting. See every pumpkin patch we track in <a href="${statePath(stateName)}">${esc(stateName)}</a>, or browse fall festivals in every state on our <a href="${categoryPath(cat)}">Fall Festivals near me</a> page.</p>`
      : `<p>The ${x} best pumpkin patch fall festivals in ${esc(stateName)} are ${joinNatural(linkedNames)} — farms tagged for a dedicated festival weekend, running their full lineup of attractions, food vendors and live music at once, alongside the pumpkins. Below, each gets a closer look — what it offers, how it's rated, and how to get there — followed by answers to the questions we hear most about visiting. See every pumpkin patch we track in <a href="${statePath(stateName)}">${esc(stateName)}</a>, or browse fall festivals in every state on our <a href="${categoryPath(cat)}">Fall Festivals near me</a> page.</p>`,
  faq: ({ topN, x, stateName }) => [
    {
      q: `What is the best pumpkin patch fall festival in ${stateName}?`,
      a: `Based on rating and review volume, ${esc(topN[0].name)} ranks first among the pumpkin patch fall festivals we track in ${esc(stateName)}${topN[0].rating ? `, with a ${topN[0].rating.toFixed(1)}-out-of-5 rating` : ''}. See the full breakdown above, or its <a href="${listingPath(topN[0])}">full listing</a> for hours and directions.`,
    },
    {
      q: `What actually happens at a pumpkin patch fall festival?`,
      a: `A festival weekend is the farm running at full capacity — every attraction open at once, food vendors on site, live music, and frequently a craft or produce market, on top of the regular pumpkin patch. It's the best day to visit for the complete experience, and the busiest day to visit if you'd rather have a quiet field and a short line.`,
    },
    {
      q: `Do fall festivals cost extra?`,
      a: `Sometimes. Festival weekends are the days a farm is most likely to charge a higher gate price or require advance tickets, since every attraction is running. Confirm current pricing directly with the farm — it's not a field we track, and it changes year to year more than regular admission does.`,
    },
    {
      q: `When are fall festival weekends usually held?`,
      a: `Typically a handful of specific weekends in the back half of the season, rather than the whole season — often concentrated in October. Exact dates vary farm to farm, so check the listing or the farm's own site directly before planning a trip around one.`,
    },
    {
      q: x === 1 ? `Is this fall festival good for young kids?` : `Are these fall festivals good for young kids?`,
      a: `Generally yes — festival weekends bundle in the kid-oriented attractions a farm runs alongside everything else. Check the listings above for feature tags like a petting zoo or play area, and call ahead if you're planning specifically around a young child's attention span in a bigger crowd.`,
    },
  ],
  conclusion: ({ topN, x, names, stateName }) => `<h2>Conclusion</h2>
<p>${esc(topN[0].name)} is${x > 1 ? ' our top pick' : ' the only farm we currently track'} for a pumpkin patch fall festival in ${esc(stateName)}${topN[0].rating ? `, rated ${topN[0].rating.toFixed(1)} out of 5` : ''}${x > 1 ? `, with ${joinNatural(names.slice(1).map((n) => esc(n)))} rounding out the list` : ''}. Ratings and review counts reflect public data at the time of writing and can change, and festival dates, pricing and what's actually running can shift week to week — always confirm directly with the farm before you drive out. For more options, see every <a href="${statePath(stateName)}">pumpkin patch we track in ${esc(stateName)}</a>.</p>`,
});

// Backed by real Search Console demand: "haunted attractions near me" and
// city-modified variants ("haunted attractions sacramento," "haunted corn
// maze sacramento") show real impressions with no dedicated state-level
// page to serve them, the same gap Petting Zoos/Fall Festivals filled
// above. 59 listings across 25 states support it (same 1+ gate as those).
generateStateAttractionListicles('haunted-attractions', {
  titleSingular: (s) => `Best Haunted Attraction at a Pumpkin Patch in ${s}`,
  titlePlural: (x, s) => `${x} Best Haunted Attractions at Pumpkin Patches in ${s}`,
  heroAlt: (s) => `Haunted attractions at pumpkin patches in ${s}`,
  description: ({ x, names, stateName }) =>
    x === 1
      ? `The best haunted attraction at a pumpkin patch in ${stateName} is ${names[0]}. See its rating, hours and directions before you go.`
      : `The ${x} best haunted attractions at pumpkin patches in ${stateName}: ${joinNatural(names)}. Ranked by rating and reviews.`,
  intro: ({ x, linkedNames, stateName, cat }) =>
    x === 1
      ? `<p>The best haunted attraction at a pumpkin patch in ${esc(stateName)} is ${linkedNames[0]} — the only farm we track statewide running a haunted hayride, haunted corn maze or haunted trail after dark, alongside the daytime pumpkin patch. Here's a closer look at what it offers, how it's rated, and how to get there, followed by answers to the questions we hear most about visiting. See every pumpkin patch we track in <a href="${statePath(stateName)}">${esc(stateName)}</a>, or browse haunted attractions in every state on our <a href="${categoryPath(cat)}">Haunted Attractions near me</a> page.</p>`
      : `<p>The ${x} best haunted attractions at pumpkin patches in ${esc(stateName)} are ${joinNatural(linkedNames)} — farms running a haunted hayride, haunted corn maze or haunted trail after dark, alongside the daytime pumpkin patch. Below, each gets a closer look — what it offers, how it's rated, and how to get there — followed by answers to the questions we hear most about visiting. See every pumpkin patch we track in <a href="${statePath(stateName)}">${esc(stateName)}</a>, or browse haunted attractions in every state on our <a href="${categoryPath(cat)}">Haunted Attractions near me</a> page.</p>`,
  faq: ({ topN, x, stateName }) => [
    {
      q: `What is the best haunted attraction at a pumpkin patch in ${stateName}?`,
      a: `Based on rating and review volume, ${esc(topN[0].name)} ranks first among the haunted attractions we track in ${esc(stateName)}${topN[0].rating ? `, with a ${topN[0].rating.toFixed(1)}-out-of-5 rating` : ''}. See the full breakdown above, or its <a href="${listingPath(topN[0])}">full listing</a> for hours and directions.`,
    },
    {
      q: `Are farm haunted attractions ticketed separately from daytime admission?`,
      a: `Almost always, yes. Haunted hayrides, haunted corn mazes and haunted trails run in the evening — usually Friday and Saturday from late September — on a separate ticket from the daytime pumpkin patch, and frequently on a different visit entirely rather than the same trip.`,
    },
    {
      q: `Are these haunted attractions appropriate for young kids?`,
      a: `It varies far more than at a commercial haunted house. Some are mild walk-throughs suitable for ten-year-olds; others involve actors who make contact and carry a minimum recommended age. Ask the farm directly what age they recommend and whether actors touch guests before booking for a family with young children.`,
    },
    {
      q: `Do I need to buy tickets in advance?`,
      a: `Many farms have moved to timed entry to control lines, especially on the two weekends before Halloween, when queues run longest. Check the farm's own site for whether tickets are timed and buy ahead if a specific night matters to you.`,
    },
    {
      q: x === 1 ? `When does this haunted attraction run?` : `When do these haunted attractions run?`,
      a: `Typically evenings only, Friday and Saturday from late September through Halloween weekend, separate from the farm's regular daytime hours. Check the listings above or the farm's own site for the current schedule, since haunt nights are more limited than regular pumpkin-patch hours.`,
    },
  ],
  conclusion: ({ topN, x, names, stateName }) => `<h2>Conclusion</h2>
<p>${esc(topN[0].name)} is${x > 1 ? ' our top pick' : ' the only farm we currently track'} for a haunted attraction at a pumpkin patch in ${esc(stateName)}${topN[0].rating ? `, rated ${topN[0].rating.toFixed(1)} out of 5` : ''}${x > 1 ? `, with ${joinNatural(names.slice(1).map((n) => esc(n)))} rounding out the list` : ''}. Ratings and review counts reflect public data at the time of writing and can change, and haunt nights, ticketing and intensity level vary a lot farm to farm — always confirm directly before you go, especially if you're planning around young kids. For more options, see every <a href="${statePath(stateName)}">pumpkin patch we track in ${esc(stateName)}</a>.</p>`,
});

// Not tied to one feature tag — the "for Halloween" framing covers the same
// statewide population as the flagship "10 Best Pumpkin Patches" post, just
// angled at a different real query pattern (picking a carving pumpkin,
// timing a visit around Halloween weekend crowds) with its own FAQ content,
// so it earns its own page rather than duplicating that one. A plain
// { slug, name, singular } stands in for a categories.json entry since
// pumpkin patches themselves aren't a category tag — categoryPath(cat)
// still resolves correctly to the real /pumpkin-patches/ hub.
generateStateAttractionListicles(
  { slug: 'pumpkin-patches', name: 'Pumpkin Patches', singular: 'pumpkin patch' },
  {
    itemFilter: () => true,
    titleSingular: (s) => `Best Pumpkin Patch To Visit For Halloween in ${s}`,
    titlePlural: (x, s) => `${x} Best Pumpkin Patches To Visit For Halloween in ${s}`,
    heroAlt: (s) => `Pumpkin patches to visit for Halloween in ${s}`,
    description: ({ x, names, stateName }) =>
      x === 1
        ? `The best pumpkin patch to visit for Halloween in ${stateName} is ${names[0]}. See its rating, hours and directions before you go.`
        : `The ${x} best pumpkin patches to visit for Halloween in ${stateName}: ${joinNatural(names)}. Ranked by rating and reviews.`,
    intro: ({ x, linkedNames, stateName, cat }) =>
      x === 1
        ? `<p>The best pumpkin patch to visit for Halloween in ${esc(stateName)} is ${linkedNames[0]} — the top-rated farm we track statewide for picking a carving pumpkin and getting the full seasonal experience before the holiday. Here's a closer look at what it offers, how it's rated, and how to get there, followed by answers to the questions we hear most about timing a Halloween visit. See every pumpkin patch we track in <a href="${statePath(stateName)}">${esc(stateName)}</a>, or browse our full <a href="${categoryPath(cat)}">state-by-state pumpkin patch directory</a>.</p>`
        : `<p>The ${x} best pumpkin patches to visit for Halloween in ${esc(stateName)} are ${joinNatural(linkedNames)}, ranked by rating and review volume — top picks for finding a carving pumpkin and getting the full seasonal experience before the holiday. Below, each gets a closer look — what it offers, how it's rated, and how to get there — followed by answers to the questions we hear most about timing a Halloween visit. See every pumpkin patch we track in <a href="${statePath(stateName)}">${esc(stateName)}</a>, or browse our full <a href="${categoryPath(cat)}">state-by-state pumpkin patch directory</a>.</p>`,
    faq: ({ topN, x, stateName }) => [
      {
        q: `What is the best pumpkin patch to visit for Halloween in ${stateName}?`,
        a: `Based on rating and review volume, ${esc(topN[0].name)} ranks first among the pumpkin patches we track in ${esc(stateName)}${topN[0].rating ? `, with a ${topN[0].rating.toFixed(1)}-out-of-5 rating` : ''}. See the full breakdown above, or its <a href="${listingPath(topN[0])}">full listing</a> for hours and directions.`,
      },
      {
        q: `When's the best time to visit before Halloween?`,
        a: `The two weekends before Halloween are the most popular — and most crowded — for picking a carving pumpkin, since the field selection is still strong but the pumpkin won't sit around rotting for weeks. A weekday morning in that same window gets you the same selection with a much shorter line.`,
      },
      {
        q: `Do pumpkin patches run out of pumpkins before Halloween?`,
        a: `The best-picked sizes and shapes can thin out in the final week, especially at smaller or heavily-visited farms. If a specific size or look matters for carving, visiting earlier in October is the safer bet than waiting for Halloween week itself.`,
      },
      {
        q: `Can I pick a pumpkin and do other Halloween activities the same trip?`,
        a: `Often, yes — many pumpkin patches also run a corn maze, hayride or haunted attraction on the same property, so it's worth checking the feature tags on each listing above before you go if you want to combine picking a pumpkin with other activities in one visit.`,
      },
      {
        q: x === 1 ? `Is this pumpkin patch busy on Halloween weekend?` : `Are these pumpkin patches busy on Halloween weekend?`,
        a: `Generally yes — the final weekend before Halloween is the busiest of the season at most farms. If a quieter visit matters more than picking on the exact weekend, a weekday or the first half of October is usually a calmer option with the same farm.`,
      },
    ],
    conclusion: ({ topN, x, names, stateName }) => `<h2>Conclusion</h2>
<p>${esc(topN[0].name)} is${x > 1 ? ' our top pick' : ' the only farm we currently track'} for a Halloween pumpkin patch visit in ${esc(stateName)}${topN[0].rating ? `, rated ${topN[0].rating.toFixed(1)} out of 5` : ''}${x > 1 ? `, with ${joinNatural(names.slice(1).map((n) => esc(n)))} rounding out the list` : ''}. Ratings and review counts reflect public data at the time of writing and can change, and pumpkin selection, hours and pricing shift as the season goes on — always confirm with the farm directly before you drive out, especially close to Halloween. For more options, see every <a href="${statePath(stateName)}">pumpkin patch we track in ${esc(stateName)}</a>.</p>`,
  }
);

generateStateAttractionListicles('corn-mazes', {
  titleSingular: (s) => `Best Corn Maze To Visit For Halloween in ${s}`,
  titlePlural: (x, s) => `${x} Best Corn Mazes To Visit For Halloween in ${s}`,
  heroAlt: (s) => `Corn mazes to visit for Halloween in ${s}`,
  description: ({ x, names, stateName }) =>
    x === 1
      ? `The best corn maze to visit for Halloween in ${stateName} is ${names[0]}. See its rating, hours and directions before you go.`
      : `The ${x} best corn mazes to visit for Halloween in ${stateName}: ${joinNatural(names)}. Ranked by rating and reviews.`,
  intro: ({ x, linkedNames, stateName, cat }) =>
    x === 1
      ? `<p>The best corn maze to visit for Halloween in ${esc(stateName)} is ${linkedNames[0]} — the top-rated farm we track statewide with a corn maze running through the Halloween season, alongside the pumpkins. Here's a closer look at what it offers, how it's rated, and how to get there, followed by answers to the questions we hear most about visiting one for Halloween. See every pumpkin patch we track in <a href="${statePath(stateName)}">${esc(stateName)}</a>, or browse corn mazes in every state on our <a href="${categoryPath(cat)}">Corn Mazes near me</a> page.</p>`
      : `<p>The ${x} best corn mazes to visit for Halloween in ${esc(stateName)} are ${joinNatural(linkedNames)}, ranked by rating and review volume — farms running a corn maze through the Halloween season, alongside the pumpkins. Below, each gets a closer look — what it offers, how it's rated, and how to get there — followed by answers to the questions we hear most about visiting one for Halloween. See every pumpkin patch we track in <a href="${statePath(stateName)}">${esc(stateName)}</a>, or browse corn mazes in every state on our <a href="${categoryPath(cat)}">Corn Mazes near me</a> page.</p>`,
  faq: ({ topN, x, stateName }) => [
    {
      q: `What is the best corn maze to visit for Halloween in ${stateName}?`,
      a: `Based on rating and review volume, ${esc(topN[0].name)} ranks first among the corn mazes we track in ${esc(stateName)}${topN[0].rating ? `, with a ${topN[0].rating.toFixed(1)}-out-of-5 rating` : ''}. See the full breakdown above, or its <a href="${listingPath(topN[0])}">full listing</a> for hours and directions.`,
    },
    {
      q: `Are corn mazes open through Halloween?`,
      a: `Most run their daytime maze through the end of October, often with a separate haunted or nighttime version on select evenings closer to Halloween. Check the individual listing above, or call ahead, for exact closing dates.`,
    },
    {
      q: `How long does a corn maze take to walk?`,
      a: `It varies a lot by farm and maze design — anywhere from 15 minutes for a smaller maze to over an hour for a larger, multi-path one. Some farms offer a shorter and a longer route on the same property, so ask at the gate if time is tight.`,
    },
    {
      q: `Is a corn maze the same ticket as pumpkin picking?`,
      a: `Sometimes it's bundled into general admission, and sometimes it's ticketed separately — this varies farm to farm more than most other attractions. Confirm current pricing directly with the farm before you go.`,
    },
    {
      q: x === 1 ? `Is this corn maze good for young kids?` : `Are these corn mazes good for young kids?`,
      a: `It depends on the maze's size and difficulty — some farms design a shorter, simpler route specifically for younger kids alongside the full-length maze. Check the listings above for details, or ask at the gate before starting.`,
    },
  ],
  conclusion: ({ topN, x, names, stateName }) => `<h2>Conclusion</h2>
<p>${esc(topN[0].name)} is${x > 1 ? ' our top pick' : ' the only farm we currently track'} for a corn maze to visit for Halloween in ${esc(stateName)}${topN[0].rating ? `, rated ${topN[0].rating.toFixed(1)} out of 5` : ''}${x > 1 ? `, with ${joinNatural(names.slice(1).map((n) => esc(n)))} rounding out the list` : ''}. Ratings and review counts reflect public data at the time of writing and can change, and maze hours, difficulty and whether a nighttime version is running vary week to week — always confirm directly with the farm before you drive out. For more options, see every <a href="${statePath(stateName)}">pumpkin patch we track in ${esc(stateName)}</a>.</p>`,
});

/* --- programmatic "5 Best Pumpkin Patches in <City>" posts --------------- */
// One per town with at least this many listings, generated straight from
// the dataset — no hand-written source file, so this list grows on its own
// as new cities clear the bar on future imports.
const CITY_POST_MIN_LISTINGS = 5;
const CITY_POST_KID_FEATURES = ['Petting zoo', 'Kids play area'];

const cityPosts = [];
let cityPostIndex = 0;
for (const [key, items] of byCity) {
  // Some towns have one operator running several same-named seasonal lots —
  // legitimate separate listings, but a curated "5 Best" post that features
  // the identical business name two or three times reads like a data error,
  // which undercuts the trust this format is supposed to build. A post only
  // gets generated when a town has at least five *distinctly named*
  // businesses, not just five raw listings.
  const seenNames = new Set();
  const distinct = items.filter((l) => {
    const nameKey = l.name.trim().toLowerCase();
    if (seenNames.has(nameKey)) return false;
    seenNames.add(nameKey);
    return true;
  });
  if (distinct.length < CITY_POST_MIN_LISTINGS) continue;

  const [stateName, cityName] = key.split('|');
  const stateCode = items[0].stateCode || '';
  const label = `${cityName}, ${stateCode}`;
  // Rotate deterministically through the author pool rather than picking
  // one writer for every city post — Map iteration order is stable for a
  // given dataset, so the same city always lands on the same byline.
  const cityAuthorSlug = authors[cityPostIndex++ % authors.length].slug;
  const top5 = distinct.slice(0, 5);
  const names = top5.map((l) => l.name);
  const slug = slugify(`5 best pumpkin patches in ${cityName} ${stateCode}`);
  const path = `/blog/${slug}/`;

  const heroSrc = (top5.find((l) => l.photo) || {}).photo || PLACEHOLDER_IMAGE;
  const heroHtml = blogHeroFigureHtml(heroSrc, `Pumpkin patches near ${label}`);

  const tocSection = `<p class="listicle-toc"><strong>Jump to:</strong> ${top5
    .map((l, i) => `<a href="#${attr(l.slug)}">${i + 1}. ${esc(l.name)}</a>`)
    .join(' <span aria-hidden="true">&middot;</span> ')}</p>`;

  const summaryIntro = `<p>The 5 best pumpkin patches in ${esc(label)} are ${joinNatural(names.map((n) => esc(n)))}, ranked by rating and review volume. Here's a closer look at each — what they offer, how they're rated, and how to get there — followed by answers to the questions we hear most about visiting. Want the full picture? See every farm we track in <a href="${cityPath(stateName, cityName)}">${esc(label)}</a>, browse all of <a href="${statePath(stateName)}">${esc(stateName)}</a>, or start from our <a href="/pumpkin-patches/">state-by-state directory</a>.</p>`;

  const listicleHtml = `<ol class="listicle">
${top5.map((l, i) => renderListicleEntry(l, i + 1, cityName)).join('\n')}
</ol>`;

  const kidFriendly = top5.filter((l) => (l.features || []).some((f) => CITY_POST_KID_FEATURES.includes(f)));
  const kidAnswer = kidFriendly.length
    ? `${joinNatural(kidFriendly.map((l) => esc(l.name)))} ${kidFriendly.length === 1 ? 'stands' : 'stand'} out for younger children on this list, with a petting zoo or a dedicated play area. Hours and what's running can change week to week, so confirm directly before you go.`
    : `None of the farms on this list are tagged with a dedicated kids' play area or petting zoo in our data, though most pumpkin patches are stroller- and toddler-friendly at a basic level. Call ahead if young kids need specific attractions.`;

  const faqQa = [
    {
      q: `When do pumpkin patches in ${cityName} open for the season?`,
      a: `Most pumpkin patches near ${cityName} open in mid-to-late September and run through the first days of November, though exact dates shift year to year with weather and how the pumpkin crop comes in. Check the individual listings above, or call ahead, to confirm current dates.`,
    },
    {
      q: `How much does it cost to visit a pumpkin patch in ${cityName}?`,
      a: `It varies by farm. Some charge only for the pumpkins you pick, priced individually or by weight; others charge a flat gate admission that bundles in attractions like a corn maze or hayride. See the admission details on each listing above where we have them, or call the farm directly.`,
    },
    { q: `Which pumpkin patch near ${cityName} is best for young kids?`, a: kidAnswer },
    {
      q: `Are pumpkin patches near ${cityName} open on weekdays?`,
      a: `Many are, though weekday hours are often shorter than weekends, and some smaller farms only open Friday through Sunday during the season. Weekday mornings are also the quietest time to visit if your schedule allows it.`,
    },
    {
      q: `Do pumpkin patches near ${cityName} accept credit cards?`,
      a: `It varies by farm — some take cards throughout, others are cash-only for field admission and wagon rides even when the store itself takes cards. Bringing some cash as a backup is the safe move at any of the farms listed above.`,
    },
  ];
  const faqHtml = `<h2>Frequently asked questions</h2>
<div class="faq-list">
${faqQa
  .map(
    (item) => `  <details class="faq-item">
    <summary>${esc(item.q)}</summary>
    <div class="faq-answer"><p>${esc(item.a)}</p></div>
  </details>`
  )
  .join('\n')}
</div>`;

  const closingSummary = `<h2>Summary</h2>
<p>${esc(top5[0].name)} tops our list of pumpkin patches in ${esc(label)}${top5[0].rating ? `, rated ${top5[0].rating.toFixed(1)} out of 5` : ''}, with ${joinNatural(names.slice(1).map((n) => esc(n)))} rounding out the top five. Ratings and review counts reflect public data at the time of writing and can change, and hours, admission and what's actually running on a given day can vary week to week during the season — always confirm with the farm directly before you drive out. For more options nearby, see the full <a href="${cityPath(stateName, cityName)}">list of pumpkin patches in ${esc(label)}</a> or browse all of <a href="${statePath(stateName)}">${esc(stateName)}</a>.</p>`;

  const body = `${tocSection}
${summaryIntro}
${listicleHtml}
${faqHtml}
${closingSummary}`;

  const postMeta = {
    path,
    slug,
    title: `5 Best Pumpkin Patches in ${label} | Fun Family Friendly Locations`,
    description: `The 5 best pumpkin patches in ${label} are ${joinNatural(names)}. Compare ratings, hours and directions before you go.`,
    h1: `5 Best Pumpkin Patches in ${label}`,
    excerpt: `Our picks for the best pumpkin patches in ${label}, ranked by rating and reviews: ${joinNatural(names)}.`,
    date: backdatedPostDate(slug),
    readingTime: '6 min read',
    author: cityAuthorSlug,
  };

  cityPosts.push({ meta: postMeta, body });

  const meta = {
    ...postMeta,
    nav: 'blog',
    layout: 'prose',
    ogType: 'article',
    trail: [{ label: 'Blog', href: '/blog/' }, { label: postMeta.h1 }],
  };
  const cityAuthor = authorsBySlug.get(cityAuthorSlug);
  const jsonld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BlogPosting',
        headline: postMeta.h1,
        description: postMeta.description,
        datePublished: postMeta.date,
        dateModified: postMeta.date,
        mainEntityOfPage: SITE_URL + path,
        image: absImageUrl(heroSrc),
        author: cityAuthor
          ? { '@type': 'Person', name: cityAuthor.name, url: SITE_URL + authorPath(cityAuthor), jobTitle: cityAuthor.title }
          : { '@type': 'Organization', name: SITE_NAME, url: SITE_URL },
        publisher: {
          '@type': 'Organization',
          name: SITE_NAME,
          url: SITE_URL,
          logo: { '@type': 'ImageObject', url: `${SITE_URL}/assets/img/icon-512.png` },
        },
      },
      {
        '@type': 'ItemList',
        numberOfItems: top5.length,
        itemListElement: top5.map((l, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          url: SITE_URL + listingPath(l),
          name: l.name,
        })),
      },
      {
        '@type': 'FAQPage',
        mainEntity: faqQa.map((item) => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.a },
        })),
      },
      breadcrumbJsonLd(meta.trail, path),
    ],
  };
  const byline = renderByline(cityAuthorSlug, postMeta.date, postMeta.readingTime);
  writePage(path, render(meta, heroHtml + byline + injectInArticleAd(body), { jsonld, scripts: `<script src="/assets/js/listicle-toggle.js?v=${ASSET_VERSION}" defer></script>` }));
  addToSitemap(path, '0.6', 'weekly', postMeta.date);
  addCityGuideLink(stateName, cityName, postMeta.h1, path);
}

/* --- programmatic "X Best <Attraction> in <City>" posts ------------------
   Same idea as the city-wide "5 Best Pumpkin Patches" posts above, but
   scoped to one attraction (corn maze, hayride, etc.) within one city. Only
   generated where at least one distinctly-named business in that city
   carries the attraction's feature tag — with a single qualifying business
   the post reads as "Best <Attraction> in <City>" (singular, no leading
   count) rather than the grammatically odd "1 Best Attractions".
*/
const ATTRACTION_POST_MIN_LISTINGS = 1;
const ATTRACTION_POST_MAX_LISTINGS = 5;
const attractionCityPosts = [];
let attractionPostIndex = 0;
const titleCase = (s) => s.replace(/(^|[\s-])([a-z])/g, (m, sep, c) => sep + c.toUpperCase());

for (const [key, items] of byCity) {
  const [stateName, cityName] = key.split('|');
  const stateCode = items[0].stateCode || '';
  const label = `${cityName}, ${stateCode}`;

  for (const cat of categories) {
    const seenNames = new Set();
    const distinct = items.filter((l) => {
      if (!(l.features || []).includes(cat.feature)) return false;
      const nameKey = l.name.trim().toLowerCase();
      if (seenNames.has(nameKey)) return false;
      seenNames.add(nameKey);
      return true;
    });
    if (distinct.length < ATTRACTION_POST_MIN_LISTINGS) continue;

    const topN = distinct.slice(0, ATTRACTION_POST_MAX_LISTINGS);
    const x = topN.length;
    const names = topN.map((l) => l.name);
    const attractionAuthorSlug = authors[attractionPostIndex++ % authors.length].slug;
    // A single qualifying business reads as "Best <Attraction> in <City>"
    // (singular, no leading count) rather than "1 Best Attractions".
    const attractionNamePlural = cat.name;
    const attractionNameForCount = x === 1 ? titleCase(cat.singular) : cat.name;
    const slug = x === 1
      ? slugify(`best ${cat.singular} in ${cityName} ${stateCode}`)
      : slugify(`${x} best ${cat.name} in ${cityName} ${stateCode}`);
    const path = `/blog/${slug}/`;
    const h1 = x === 1 ? `Best ${attractionNameForCount} in ${label}` : `${x} Best ${attractionNamePlural} in ${label}`;

    const heroSrc = (topN.find((l) => l.photo) || {}).photo || PLACEHOLDER_IMAGE;
    const heroHtml = blogHeroFigureHtml(heroSrc, `${cat.name} near ${label}`);

    const tocSection = `<p class="listicle-toc"><strong>Jump to:</strong> ${topN
      .map((l, i) => `<a href="#${attr(l.slug)}">${i + 1}. ${esc(l.name)}</a>`)
      .join(' <span aria-hidden="true">&middot;</span> ')}</p>`;

    const summaryIntro = x === 1
      ? `<p>The best ${esc(cat.singular)} in ${esc(label)} is ${esc(names[0])}, based on rating and review volume — it's the only one we currently track in town. Here's what it offers, how it's rated, and how to get there — followed by the questions we hear most about visiting. For every pumpkin patch we track nearby, see the full <a href="${cityPath(stateName, cityName)}">list of pumpkin patches in ${esc(label)}</a> or browse all of <a href="${statePath(stateName)}">${esc(stateName)}</a>. You can also browse ${esc(cat.name.toLowerCase())} everywhere we track them on our <a href="${categoryPath(cat)}">${esc(cat.name)} near me</a> page.</p>`
      : `<p>The ${x} best ${esc(cat.name.toLowerCase())} in ${esc(label)} are ${joinNatural(names.map((n) => esc(n)))}, ranked by rating and review volume. Here's what each offers, how it's rated, and how to get there — followed by the questions we hear most about visiting. For every pumpkin patch we track nearby, see the full <a href="${cityPath(stateName, cityName)}">list of pumpkin patches in ${esc(label)}</a> or browse all of <a href="${statePath(stateName)}">${esc(stateName)}</a>. You can also browse ${esc(cat.name.toLowerCase())} everywhere we track them on our <a href="${categoryPath(cat)}">${esc(cat.name)} near me</a> page.</p>`;

    const listicleHtml = `<ol class="listicle">
${topN.map((l, i) => renderListicleEntry(l, i + 1, cityName)).join('\n')}
</ol>`;

    const faqQa = [
      {
        q: `What is the best ${esc(cat.singular)} in ${esc(cityName)}?`,
        a: `Based on rating and review volume, ${esc(topN[0].name)} ranks first among the ${esc(cat.singular)}${x > 1 ? 's' : ''} we track near ${esc(cityName)}${topN[0].rating ? `, with a ${topN[0].rating.toFixed(1)}-out-of-5 rating` : ''}. See the full breakdown above, or its <a href="${listingPath(topN[0])}">full listing</a> for hours and directions.`,
      },
      {
        q: `When is ${esc(cat.name.toLowerCase())} season near ${esc(cityName)}?`,
        a: `Most farms with a ${esc(cat.singular)} open it alongside the rest of their pumpkin season, roughly mid-to-late September through the first days of November, though the exact window shifts year to year with weather. Check the listings above or call ahead to confirm current dates.`,
      },
      {
        q: `How much does it cost to visit a ${esc(cat.singular)} near ${esc(cityName)}?`,
        a: `It varies by farm — some bundle the ${esc(cat.singular)} into general admission, others charge separately. See the admission details on each listing above where we have them, or call the farm directly to confirm current pricing.`,
      },
      {
        q: x === 1 ? `Is this ${esc(cat.singular)} good for young kids?` : `Are these ${esc(cat.name.toLowerCase())} good for young kids?`,
        a: `It depends on the farm and, for haunted attractions in particular, can vary a lot in intensity. Check the individual listing pages above for feature tags and details, and call ahead if you're planning around a specific age group.`,
      },
      {
        q: `Do I need to book ahead for a ${esc(cat.singular)} near ${esc(cityName)}?`,
        a: `Some farms run first-come, first-served, while others — especially haunted attractions and festival-weekend events — use timed tickets. Check the farm's website or call ahead, particularly for a visit on a weekend in mid-October when demand peaks.`,
      },
    ];
    const faqHtml = `<h2>Frequently asked questions</h2>
<div class="faq-list">
${faqQa
  .map(
    (item) => `  <details class="faq-item">
    <summary>${esc(item.q)}</summary>
    <div class="faq-answer"><p>${esc(item.a)}</p></div>
  </details>`
  )
  .join('\n')}
</div>`;

    const closingSummary = `<h2>Summary</h2>
<p>${esc(topN[0].name)} is${names.length > 1 ? ' our top pick' : ' the only farm we currently track'} with a ${esc(cat.singular)} in ${esc(label)}${topN[0].rating ? `, rated ${topN[0].rating.toFixed(1)} out of 5` : ''}${names.length > 1 ? `, with ${joinNatural(names.slice(1).map((n) => esc(n)))} rounding out the list` : ''}. Ratings and review counts reflect public data at the time of writing and can change, and hours, admission and what's actually running on a given day can vary week to week during the season — always confirm with the farm directly before you drive out. For more options nearby, see the full <a href="${cityPath(stateName, cityName)}">list of pumpkin patches in ${esc(label)}</a> or browse ${esc(cat.name.toLowerCase())} across every state on our <a href="${categoryPath(cat)}">${esc(cat.name)} near me</a> page.</p>`;

    const body = `${tocSection}
${summaryIntro}
${listicleHtml}
${faqHtml}
${closingSummary}`;

    const postMeta = {
      path,
      slug,
      title: h1,
      description: x === 1
        ? `The best ${cat.singular} in ${label} is ${names[0]}. See its rating, hours and directions before you go.`
        : `The ${x} best ${cat.name.toLowerCase()} in ${label} are ${joinNatural(names)}. Compare ratings, hours and directions before you go.`,
      h1,
      excerpt: x === 1
        ? `Our pick for the best ${cat.singular} in ${label}: ${names[0]}.`
        : `Our picks for the best ${cat.name.toLowerCase()} in ${label}, ranked by rating and reviews: ${joinNatural(names)}.`,
      date: backdatedPostDate(slug),
      readingTime: '6 min read',
      author: attractionAuthorSlug,
    };

    attractionCityPosts.push({ meta: postMeta, body });

    const meta = {
      ...postMeta,
      nav: 'blog',
      layout: 'prose',
      ogType: 'article',
      trail: [{ label: 'Blog', href: '/blog/' }, { label: h1 }],
    };
    const attractionAuthor = authorsBySlug.get(attractionAuthorSlug);
    const jsonld = {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'BlogPosting',
          headline: h1,
          description: postMeta.description,
          datePublished: postMeta.date,
          dateModified: postMeta.date,
          mainEntityOfPage: SITE_URL + path,
          image: absImageUrl(heroSrc),
          author: attractionAuthor
            ? { '@type': 'Person', name: attractionAuthor.name, url: SITE_URL + authorPath(attractionAuthor), jobTitle: attractionAuthor.title }
            : { '@type': 'Organization', name: SITE_NAME, url: SITE_URL },
          publisher: {
            '@type': 'Organization',
            name: SITE_NAME,
            url: SITE_URL,
            logo: { '@type': 'ImageObject', url: `${SITE_URL}/assets/img/icon-512.png` },
          },
        },
        {
          '@type': 'ItemList',
          numberOfItems: topN.length,
          itemListElement: topN.map((l, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            url: SITE_URL + listingPath(l),
            name: l.name,
          })),
        },
        {
          '@type': 'FAQPage',
          mainEntity: faqQa.map((item) => ({
            '@type': 'Question',
            name: item.q,
            acceptedAnswer: { '@type': 'Answer', text: item.a },
          })),
        },
        breadcrumbJsonLd(meta.trail, path),
      ],
    };
    const byline = renderByline(attractionAuthorSlug, postMeta.date, postMeta.readingTime);
    writePage(path, render(meta, heroHtml + byline + injectInArticleAd(body), { jsonld, scripts: `<script src="/assets/js/listicle-toggle.js?v=${ASSET_VERSION}" defer></script>` }));
    addToSitemap(path, '0.6', 'weekly', postMeta.date);
    addCityGuideLink(stateName, cityName, h1, path, cat.slug);
    addCategoryCityGuideLink(cat.slug, stateName, cityName, h1, path, distinct.length);
  }
}

// Hand-authored guides and both flavors of programmatic city listicles share
// one feed from here on — the blog index, XML/HTML sitemaps and search index
// all read from `posts` and don't need to know which kind a given entry is.
const posts = [...handAuthoredPosts, ...pillarPosts, ...statePosts, ...cityPosts, ...attractionCityPosts].sort((a, b) => (b.meta.date || '').localeCompare(a.meta.date || ''));

/* --- category + city service pages (e.g. /hayrides/<city>-<state>/) -----
   Distinct from both the city directory page (every business in a town)
   and the category page (one attraction, every state): this is the
   service+location combination page — just the businesses in one city
   carrying one specific attraction tag, at a clean city-scoped URL under
   that attraction's own path. Complements, rather than replaces, the
   "Best <Attraction> in <City>" blog posts above (those are curated
   editorial write-ups; these are plain ranked directory pages, the same
   pillar-list format the state/city/category pages use). Only generated
   for a category once explicitly requested — call
   generateCategoryCityPages for each one that should get these. */
function generateCategoryCityPages(catOrSlug, { minListings = 1, itemFilter = null } = {}) {
  const cat = typeof catOrSlug === 'string' ? categories.find((c) => c.slug === catOrSlug) : catOrSlug;
  const test = itemFilter || ((l) => (l.features || []).includes(cat.feature));

  // Precompute every qualifying city before writing any page, so each
  // page can list its sibling towns in the same state regardless of Map
  // iteration order.
  const qualifying = [];
  for (const [key, items] of byCity) {
    const [stateName, cityName] = key.split('|');
    const seen = new Set();
    const distinct = items.filter((l) => {
      if (!test(l)) return false;
      const k = l.name.trim().toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (distinct.length < minListings) continue;
    qualifying.push({ stateName, cityName, stateCode: items[0].stateCode || '', distinct });
  }

  for (const { stateName, cityName, stateCode, distinct } of qualifying) {
    const label = `${cityName}, ${stateCode}`;
    const path = categoryCityPath(cat, cityName, stateCode);
    const n = distinct.length;
    const h1 = `${cat.name} in ${label}`;

    // cat.feature is null for the "farms" virtual category (every listing
    // qualifies — there's no attraction being offered), so it reads as a
    // plain roster rather than "N patches offer pumpkin farm."
    const description = cat.feature
      ? `Find ${cat.name.toLowerCase()} in ${label} — ${n} pumpkin patch${n === 1 ? '' : 'es'} we track with ${cat.singular}, ranked by rating, with address, hours and directions.`
      : `${n} ${cat.singular}${n === 1 ? '' : 's'} in ${label}, ranked by rating, with address, hours and directions for each.`;
    const lede = cat.feature
      ? `${n} pumpkin patch${n === 1 ? '' : 'es'} we track in ${label} ${n === 1 ? 'offers' : 'offer'} ${cat.singular}, ranked by rating and review volume.`
      : `${n} ${cat.singular}${n === 1 ? '' : 's'} we track in ${label}, ranked by rating and review volume.`;
    const meta = {
      path,
      title: `${h1} | ${n} Farm${n === 1 ? '' : 's'}, Ranked (${SEASON_YEAR})`,
      description,
      h1,
      lede,
      nav: cat.slug === 'corn-mazes' ? 'corn-mazes' : cat.slug === 'hayrides' ? 'hayrides' : 'pumpkin-patches',
      layout: 'wide',
      trail: [
        { label: 'Pumpkin Patches', href: '/pumpkin-patches/' },
        { label: cat.name, href: categoryPath(cat) },
        { label },
      ],
    };

    const heroSrc = (distinct.find((l) => l.photo) || {}).photo || PLACEHOLDER_IMAGE;
    const heroHtml = blogHeroFigureHtml(heroSrc, `${cat.name} in ${label}`);

    const listHtml = `<p><button class="toggle-btn" type="button" data-geo-trigger>Show distance from me</button></p>
<ol class="pillar-list">
${pillarEntriesWithAds(distinct, (l, i) => renderPillarEntry(l, i, cityName))}
</ol>`;

    const relatedGuide = (cityGuideLinks.get(`${stateName}|${cityName}`) || []).find((g) => g.catSlug === cat.slug);
    const siblings = qualifying.filter((q) => q.stateName === stateName && q.cityName !== cityName);

    const body = `${heroHtml}
${renderScopedMap(distinct, listHtml, { singular: cat.singular, plural: cat.name.toLowerCase() })}
<div class="section" style="padding-bottom:0">
  <p>Want everything ${esc(label)} has to offer, not just ${esc(cat.name.toLowerCase())}? See <a href="${cityPath(stateName, cityName)}">every pumpkin patch we track in ${esc(label)}</a>, or browse ${esc(cat.name.toLowerCase())} in every state on our <a href="${categoryPath(cat)}">${esc(cat.name)} near me</a> page.</p>
  ${relatedGuide ? `<p>Want the full write-up? Read <a href="${relatedGuide.href}">${esc(relatedGuide.title)}</a>.</p>` : ''}

  ${siblings.length ? `<h2>${esc(cat.name)} in other ${esc(stateName)} towns</h2>
  <div class="tag-row">
${siblings.map((s) => `    <a class="tag tag-link" href="${categoryCityPath(cat, s.cityName, s.stateCode)}">${esc(s.cityName)} (${s.distinct.length})</a>`).join('\n')}
  </div>` : ''}

  <p style="margin-top:1.5rem">
    <a class="btn btn-primary" href="/">Search the map by ZIP code</a>
    <a class="btn btn-outline" href="${statePath(stateName)}">All ${esc(stateName)} pumpkin patches</a>
  </p>
  ${renderPhotoGallery(distinct, path, label)}
</div>`;

    const jsonld = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'CollectionPage', name: meta.title, description: meta.description, url: SITE_URL + path },
        {
          '@type': 'ItemList',
          numberOfItems: distinct.length,
          itemListElement: distinct.slice(0, 25).map((l, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            url: SITE_URL + listingPath(l),
            name: l.name,
          })),
        },
        breadcrumbJsonLd(meta.trail, path),
      ],
    };

    const scripts = `${pageMapScripts}\n<script src="/assets/js/pillar-entry.js?v=${ASSET_VERSION}" defer></script>`;
    writePage(path, render(meta, body, { jsonld, scripts }));
    addToSitemap(path, '0.6', 'weekly');
    addCategoryCityPage(cat.slug, stateName, cityName, h1, path, n);
  }
}

/* --- category + state service pages (e.g. /hayrides/<state>/) -----------
   One level up from the city pages above: every business in a whole state
   carrying one attraction tag, at /<category>/<state>/ — sits between the
   category hub (every state) and the city page (one town). Call this for
   a category AFTER generateCategoryCityPages has already run for it, so
   this page can list its own city sub-pages (from categoryCityPageList)
   without caring about Map iteration order. */
function generateCategoryStatePages(catOrSlug, { minListings = 1, itemFilter = null } = {}) {
  const cat = typeof catOrSlug === 'string' ? categories.find((c) => c.slug === catOrSlug) : catOrSlug;
  const test = itemFilter || ((l) => (l.features || []).includes(cat.feature));

  for (const stateName of stateNames) {
    const stateItems = byState.get(stateName) || [];
    const seen = new Set();
    const distinct = stateItems.filter((l) => {
      if (!test(l)) return false;
      const k = l.name.trim().toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (distinct.length < minListings) continue;

    const path = categoryStatePath(cat, stateName);
    const n = distinct.length;
    const h1 = `${cat.name} in ${stateName}`;
    const cities = [...new Set(distinct.map((l) => l.city).filter(Boolean))].sort();

    const description = cat.feature
      ? `Find ${cat.name.toLowerCase()} in ${stateName} — ${n} pumpkin patch${n === 1 ? '' : 'es'} we track statewide with ${cat.singular}, ranked by rating, with address, hours and directions.`
      : `${n} ${cat.singular}${n === 1 ? '' : 's'} in ${stateName}, ranked by rating, with address, hours and directions for each.`;
    const lede = cat.feature
      ? `${n} pumpkin patch${n === 1 ? '' : 'es'} we track in ${stateName} ${n === 1 ? 'offers' : 'offer'} ${cat.singular}, ranked by rating and review volume across ${cities.length} ${cities.length === 1 ? 'town' : 'towns'}.`
      : `${n} ${cat.singular}${n === 1 ? '' : 's'} we track in ${stateName}, ranked by rating and review volume across ${cities.length} ${cities.length === 1 ? 'town' : 'towns'}.`;

    const meta = {
      path,
      title: `${h1} | ${n} Farm${n === 1 ? '' : 's'}, Ranked (${SEASON_YEAR})`,
      description,
      h1,
      lede,
      nav: cat.slug === 'corn-mazes' ? 'corn-mazes' : cat.slug === 'hayrides' ? 'hayrides' : 'pumpkin-patches',
      layout: 'wide',
      trail: [
        { label: 'Pumpkin Patches', href: '/pumpkin-patches/' },
        { label: cat.name, href: categoryPath(cat) },
        { label: stateName },
      ],
    };

    const heroSrc = (distinct.find((l) => l.photo) || {}).photo || PLACEHOLDER_IMAGE;
    const heroHtml = blogHeroFigureHtml(heroSrc, `${cat.name} in ${stateName}`);

    const listHtml = `<p><button class="toggle-btn" type="button" data-geo-trigger>Show distance from me</button></p>
<ol class="pillar-list">
${pillarEntriesWithAds(distinct, (l, i) => renderPillarEntry(l, i, stateName))}
</ol>`;

    const cityPages = cities
      .map((city) => categoryCityPageLinks.get(`${cat.slug}|${stateName}|${city}`))
      .filter(Boolean);
    const stateGuide = (stateGuideLinks.get(stateName) || []).find((g) => g.catSlug === cat.slug);

    const body = `${heroHtml}
${renderScopedMap(distinct, listHtml, { singular: cat.singular, plural: cat.name.toLowerCase() })}
<div class="section" style="padding-bottom:0">
  <p>Want everything ${esc(stateName)} has to offer, not just ${esc(cat.name.toLowerCase())}? See <a href="${statePath(stateName)}">every pumpkin patch we track in ${esc(stateName)}</a>, or browse ${esc(cat.name.toLowerCase())} in every state on our <a href="${categoryPath(cat)}">${esc(cat.name)} near me</a> page.</p>
  ${stateGuide ? `<p>Want the full write-up? Read <a href="${stateGuide.href}">${esc(stateGuide.title)}</a>.</p>` : ''}

  ${cityPages.length ? `<h2>${esc(cat.name)} by town in ${esc(stateName)}</h2>
  <div class="tag-row">
${cityPages.map((c) => `    <a class="tag tag-link" href="${c.href}">${esc(c.title.replace(`${cat.name} in `, ''))}</a>`).join('\n')}
  </div>` : ''}

  <p style="margin-top:1.5rem">
    <a class="btn btn-primary" href="/">Search the map by ZIP code</a>
    <a class="btn btn-outline" href="${categoryPath(cat)}">All ${esc(cat.name)}</a>
  </p>
  ${renderPhotoGallery(distinct, path, stateName)}
</div>`;

    const jsonld = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'CollectionPage', name: meta.title, description: meta.description, url: SITE_URL + path },
        {
          '@type': 'ItemList',
          numberOfItems: distinct.length,
          itemListElement: distinct.slice(0, 25).map((l, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            url: SITE_URL + listingPath(l),
            name: l.name,
          })),
        },
        breadcrumbJsonLd(meta.trail, path),
      ],
    };

    const scripts = `${pageMapScripts}\n<script src="/assets/js/pillar-entry.js?v=${ASSET_VERSION}" defer></script>`;
    writePage(path, render(meta, body, { jsonld, scripts }));
    addToSitemap(path, '0.7', 'weekly');
    addCategoryStatePage(cat.slug, stateName, h1, path);
  }
}

generateCategoryCityPages('hayrides');
generateCategoryCityPages('corn-mazes');
generateCategoryStatePages('hayrides');
generateCategoryStatePages('corn-mazes');
generateCategoryStatePages('haunted-attractions');

/* --- /farms/ hub and /farms/<city>-<state>/ pages -------------------------
   "Pumpkin farm" is real, distinct search phrasing from "pumpkin patch" —
   the same reasoning that already justified separate "10 Best Pumpkin
   Fields/Farms" state posts alongside "10 Best Pumpkin Patches" ones,
   ranking the same real businesses under different wording rather than
   inventing new ones. /farms/ is a second full-catalog hub next to
   /pumpkin-patches/ with that framing; /farms/<city>-<state>/ reuses the
   same city-service-page generator as the attraction pages above, just
   with every listing in a city counting (no feature required) and a
   higher bar (CITY_POST_MIN_LISTINGS, the same gate the "5 Best Pumpkin
   Patches in <City>" post uses) so it doesn't produce a near-duplicate of
   every single /state/city/ page — only towns with real inventory. */
const farmsHub = {
  slug: 'farms',
  feature: null,
  name: 'Pumpkin Farms',
  singular: 'pumpkin farm',
  title: 'Pumpkin Farms Near Me — Find a Pumpkin Farm in Your State',
  description: 'Find pumpkin farms near you. Browse every pumpkin farm we track across all 50 states, with addresses, hours, ratings and directions.',
  lede: 'Real, working farms growing and selling pumpkins — browse every one we track near you, from small roadside stands to full agritourism destinations.',
  intro: `<p>"Pumpkin farm," "pumpkin patch" and "pumpkin field" all describe the same kind of place, and people search for all three — so we cover all three. Every listing here is a real, working farm or seasonal lot pulled from public business data: address, hours, rating and what's actually on site, in one page.</p>
<p>Some are small roadside operations selling pumpkins from a stand or a field; others run a full fall program with a corn maze, hayrides and a petting zoo alongside the pumpkins. Filter by state or attraction below, or search by name or town.</p>`,
};

{
  const items = rankListings(listings);
  const presentCategoriesAll = categories
    .map((c) => ({ c, n: items.filter((l) => (l.features || []).includes(c.feature)).length }))
    .filter((x) => x.n > 0);
  const stateCounts = stateNames.map((s) => ({ state: s, n: (byState.get(s) || []).length }));

  const meta = {
    path: '/farms/',
    title: farmsHub.title,
    description: farmsHub.description,
    h1: `${farmsHub.name} Near Me`,
    lede: farmsHub.lede,
    nav: 'pumpkin-patches',
    layout: 'wide',
    trail: [{ label: 'Pumpkin Patches', href: '/pumpkin-patches/' }, { label: farmsHub.name }],
  };

  const heroSrc = (items.find((l) => l.photo) || {}).photo || PLACEHOLDER_IMAGE;
  const heroHtml = blogHeroFigureHtml(heroSrc, `${farmsHub.name} near you`);

  const filterBar = `<div class="find-tool state-filter" id="state-filter">
  <div class="search-field">
    <label class="visually-hidden" for="state-filter-q">Search by name, city or state</label>
    <input id="state-filter-q" type="text" placeholder="Search by name, city or state..." autocomplete="off">
  </div>
  <div class="control-group">
    <label class="control">
      <span class="control-label">State</span>
      <select id="state-filter-state" aria-label="Filter by state">
        <option value="">All states</option>
${stateCounts.map(({ state, n }) => `        <option value="${attr(state.toLowerCase())}">${esc(state)} (${n})</option>`).join('\n')}
      </select>
    </label>
    <label class="control">
      <span class="control-label">Attraction</span>
      <select id="state-filter-feature" aria-label="Filter by attraction">
        <option value="">All</option>
${presentCategoriesAll.map(({ c, n }) => `        <option value="${attr(c.feature.toLowerCase())}">${esc(c.name)} (${n})</option>`).join('\n')}
      </select>
    </label>
    <label class="control">
      <span class="control-label">Sort</span>
      <select id="state-filter-sort" aria-label="Sort results">
        <option value="rating">Top rated</option>
        <option value="reviews">Most reviewed</option>
        <option value="name">Name A-Z</option>
        <option value="distance">Nearest to me</option>
      </select>
    </label>
    <button class="toggle-btn" type="button" id="state-filter-reset">Reset</button>
    <button class="toggle-btn" type="button" data-geo-trigger>Show distance from me</button>
  </div>
  <div class="results-head" style="padding:0.6rem 0 0;background:transparent;border:0">
    <p class="results-count" id="state-filter-count">${items.length.toLocaleString('en-US')} pumpkin farms</p>
  </div>
</div>`;

  const listHtml = `${filterBar}
<ol class="pillar-list" id="state-pillar-list">
${pillarEntriesWithAds(items, (l, i) => renderPillarEntry(l, i, l.state))}
</ol>
<p class="empty-state" id="state-filter-empty" hidden><strong>No matches.</strong> Try a different search, state or attraction, or <button type="button" class="btn-link" id="state-filter-empty-reset">reset the filters</button>.</p>`;

  const body = `${heroHtml}
${farmsHub.intro}
${renderScopedMap(items, listHtml, { singular: farmsHub.singular, plural: farmsHub.name.toLowerCase() })}
<div class="section" style="padding-bottom:0">
  <h2>${esc(farmsHub.name)} by state</h2>
  <div class="state-grid">
${stateCounts.map(({ state, n }) => `    <a class="state-link" href="${statePath(state)}">${esc(state)} <span>${n}</span></a>`).join('\n')}
  </div>
  <p style="margin-top:1.5rem"><a class="btn btn-outline" href="/pumpkin-patches/">Browse the full pumpkin patch directory</a></p>
</div>`;

  const jsonld = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'CollectionPage', name: meta.title, description: meta.description, url: SITE_URL + meta.path },
      {
        '@type': 'ItemList',
        numberOfItems: items.length,
        itemListElement: items.slice(0, 25).map((l, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          url: SITE_URL + listingPath(l),
          name: l.name,
        })),
      },
      breadcrumbJsonLd(meta.trail, meta.path),
    ],
  };

  const scripts = `${pageMapScripts}\n<script src="/assets/js/state-filter.js?v=${ASSET_VERSION}" defer></script>\n<script src="/assets/js/pillar-entry.js?v=${ASSET_VERSION}" defer></script>`;
  writePage(meta.path, render(meta, body, { jsonld, scripts }));
  addToSitemap(meta.path, '0.7', 'weekly');
}

// CITY_POST_MIN_LISTINGS (5) turned out far too strict for an unfiltered
// count — only 4 towns nationwide have 5+ distinctly-named farms. 2 keeps
// these pages meaningfully different from a single-card duplicate of the
// city directory page while still producing real coverage (~230 towns).
const FARMS_CITY_MIN_LISTINGS = 2;
generateCategoryCityPages(farmsHub, { itemFilter: () => true, minListings: FARMS_CITY_MIN_LISTINGS });

/* --- author pages ---------------------------------------------------------
   /authors/ lists every writer; /authors/<slug>/ gives each their own page
   with bio and a list of what they've written. Bios describe general,
   non-verifiable experience (years spent doing something, general interest)
   rather than specific claims about real institutions or publications, and
   avatars are explicitly illustrated initials, never presented as photos of
   real people. */

const AUTHOR_PAGE_ARTICLE_CAP = 40;
for (const author of authors) {
  const path = authorPath(author);
  const authored = posts.filter((p) => p.meta.author === author.slug);
  const shown = authored.slice(0, AUTHOR_PAGE_ARTICLE_CAP);

  const articleList = authored.length
    ? `<div class="post-list">
${shown
  .map(
    (p) => `  <article class="post-item">
    <h3><a href="/blog/${p.meta.slug}/">${esc(p.meta.h1 || p.meta.title)}</a></h3>
    <p class="post-meta">${p.meta.date ? new Date(`${p.meta.date}T12:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) : ''}${p.meta.readingTime ? ` &middot; ${esc(p.meta.readingTime)}` : ''}</p>
    <p>${esc(p.meta.excerpt || p.meta.description)}</p>
    <a class="btn btn-outline btn-sm" href="/blog/${p.meta.slug}/">Read the guide</a>
  </article>`
  )
  .join('\n')}
</div>
${authored.length > shown.length ? `<p style="margin-top:1rem"><a href="/blog/">See all ${authored.length} guides by ${esc(author.name)}, or browse the full blog &rarr;</a></p>` : ''}`
    : `<p>${esc(author.name)} hasn't published a guide yet — check back soon.</p>`;

  const body = `<div class="author-header">
  <img src="/assets/img/authors/${author.slug}.svg" alt="" width="96" height="96" class="author-avatar">
  <div>
    <p class="author-title">${esc(author.title)}</p>
    <p class="author-focus">${esc(author.focus)}</p>
  </div>
</div>
<div class="prose">
  <p>${esc(author.bio)}</p>
</div>
<h2>Articles by ${esc(author.name)}</h2>
${articleList}`;

  const meta = {
    path,
    title: `${author.name} — ${author.title} | Pumpkin Patches Near Me`,
    description: author.short,
    h1: author.name,
    lede: author.title,
    nav: 'blog',
    layout: 'wide',
    trail: [{ label: 'Authors', href: '/authors/' }, { label: author.name }],
  };

  const jsonld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Person',
        name: author.name,
        jobTitle: author.title,
        description: author.bio,
        url: SITE_URL + path,
        image: `${SITE_URL}/assets/img/authors/${author.slug}.svg`,
        worksFor: { '@type': 'Organization', name: SITE_NAME, url: SITE_URL },
      },
      breadcrumbJsonLd(meta.trail, path),
    ],
  };

  writePage(path, render(meta, body, { jsonld }));
  addToSitemap(path, '0.4', 'monthly');
}

const authorsIndexBody = `<div class="grid grid-2">
${authors
  .map(
    (author) => `  <a class="author-card" href="${authorPath(author)}">
    <img src="/assets/img/authors/${author.slug}.svg" alt="" width="64" height="64">
    <div>
      <h2>${esc(author.name)}</h2>
      <p class="author-title">${esc(author.title)}</p>
      <p>${esc(author.short)}</p>
    </div>
  </a>`
  )
  .join('\n')}
</div>`;

{
  const path = '/authors/';
  const meta = {
    path,
    title: 'Our Writers — Pumpkin Patches Near Me',
    description: 'Meet the writers behind the guides on Pumpkin Patches Near Me: family travel, agritourism, recipes and fall traditions.',
    h1: 'Our Writers',
    lede: 'The people behind our guides to visiting, planning around, and cooking with pumpkins.',
    nav: 'blog',
    layout: 'wide',
    trail: [{ label: 'Authors' }],
  };
  const jsonld = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'CollectionPage', name: meta.title, description: meta.description, url: SITE_URL + path },
      breadcrumbJsonLd(meta.trail, path),
    ],
  };
  writePage(path, render(meta, authorsIndexBody, { jsonld }));
  addToSitemap(path, '0.4', 'monthly');
}

/* --- static pages -------------------------------------------------------- */

// Weighted rating*reviews ranking, used as the server-rendered (nationwide,
// no location known yet) default for each homepage "Near Me" carousel —
// swapped client-side for a real distance-sorted set the moment a visitor's
// location is known (auto-locate on load, ZIP search, or "Use my location").
function topRated(items, count = 12) {
  return [...items]
    .filter((l) => l.rating)
    .sort((a, b) => (b.rating || 0) * Math.log10((b.reviews || 1) + 1) - (a.rating || 0) * Math.log10((a.reviews || 1) + 1))
    .slice(0, count);
}
const topRatedAll = topRated(listings);

// The two carousels that sit directly under the map/results, ahead of the
// per-category ones. "Open Now" has no valid *server-rendered* content —
// open/closed is only true at the exact moment someone loads the page, so
// items is null here and the client fills it in live (see isOpenNow in
// map.js); the placeholder text is what shows for the instant before that
// JS runs (and permanently for a no-JS visitor).
const homepagePrioritySections = [
  {
    key: 'nearby-open-now',
    title: 'Open Now',
    href: '/pumpkin-patches/',
    cta: 'Browse all pumpkin patches',
    sub: 'Farms showing open hours right now.',
    items: null,
    footnote: "Based on each farm's listed hours and your device clock — hours change by season, always confirm before you go.",
  },
  {
    key: 'nearby-top-rated',
    title: 'Top Rated',
    href: '/pumpkin-patches/',
    cta: 'Browse all pumpkin patches',
    sub: 'The strongest review profiles in our directory right now.',
    items: topRatedAll,
  },
];

// One "Near Me" carousel per real attraction category, plus two virtual
// ones (Farms, Pumpkin Patches) that cover the same full dataset under
// different wording, same as the /farms/ and /pumpkin-patches/ pages.
const homepageNearbySections = [
  ...categories.map((c) => ({
    key: `nearby-${c.slug}`,
    title: `${c.name} Near Me`,
    href: categoryPath(c),
    items: topRated(byCategory.get(c.slug) || []),
  })),
  { key: 'nearby-farms', title: 'Farms Near Me', href: '/farms/', items: topRatedAll },
  { key: 'nearby-pumpkin-patches', title: 'Pumpkin Patches Near Me', href: '/pumpkin-patches/', items: topRatedAll },
];

function renderNearbyCarouselSection(section, altBg) {
  const label = section.title.replace(/ Near Me$/, '');
  const subText = section.sub || `Top-rated ${label.toLowerCase()} in our directory right now.`;
  const ctaText = section.cta || `See all ${label.toLowerCase()} near me`;
  const trackInner = section.items
    ? section.items.map((l) => renderCard(l)).join('\n')
    : '<p class="carousel-empty">Checking which farms are open right now&hellip;</p>';
  return `<section class="section${altBg ? ' section-alt' : ''}">
  <div class="wrap">
    <div class="section-head">
      <span class="eyebrow">Near you</span>
      <h2 id="${section.key}-heading">${esc(section.title)}</h2>
      <p id="${section.key}-sub">${esc(subText)}</p>
    </div>
    <div class="carousel-wrap">
      <button class="carousel-arrow" type="button" data-dir="prev" data-target="${section.key}" aria-label="Scroll left">&larr;</button>
      <div class="carousel-track" id="${section.key}">
${trackInner}
      </div>
      <button class="carousel-arrow" type="button" data-dir="next" data-target="${section.key}" aria-label="Scroll right">&rarr;</button>
    </div>
    ${section.footnote ? `<p class="carousel-overflow-note">${esc(section.footnote)}</p>` : ''}
    <p style="margin-top:1.1rem"><a class="btn btn-outline" href="${section.href}">${esc(ctaText)} &rarr;</a></p>
  </div>
</section>`;
}

const nearbyPriorityCarouselsHtml = homepagePrioritySections.map((s, i) => renderNearbyCarouselSection(s, i % 2 === 0)).join('\n\n');
const nearbyCarouselsHtml = homepageNearbySections.map((s, i) => renderNearbyCarouselSection(s, i % 2 === 0)).join('\n\n');

const staticPages = readPageFiles(join(SRC, 'pages'));

const tokens = {
  '{{FAQ}}': renderFaqHtml(faqs),
  '{{STATE_GRID}}': renderStateGrid(),
  // The homepage teases a handful of guides rather than the full feed —
  // with 800+ programmatic attraction posts now in the mix, dumping every
  // post's card onto "/" would make it enormous. The pillar post always
  // gets a slot; hand-authored and citywide posts fill the rest by recency.
  // Long-tail attraction posts are left for /blog/ and search to surface.
  '{{HOME_BLOG_TEASERS}}': [
    ...pillarPosts,
    ...[...handAuthoredPosts, ...cityPosts]
      .sort((a, b) => (b.meta.date || '').localeCompare(a.meta.date || ''))
      .slice(0, 2),
  ]
    .map((p) => {
      const author = authorsBySlug.get(p.meta.author);
      const byAuthor = author ? `By <a href="${authorPath(author)}">${esc(author.name)}</a> &middot; ` : '';
      return `<article class="post-item">
  <h3><a href="/blog/${p.meta.slug}/">${esc(p.meta.h1 || p.meta.title)}</a></h3>
  <p class="post-meta">${byAuthor}${p.meta.date ? new Date(`${p.meta.date}T12:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) : ''}${p.meta.readingTime ? ` &middot; ${esc(p.meta.readingTime)}` : ''}</p>
  <p>${esc(p.meta.excerpt || p.meta.description)}</p>
  <a class="btn btn-outline btn-sm" href="/blog/${p.meta.slug}/">Read the guide</a>
</article>`;
    })
    .join('\n'),
  // Homepage "Near Me" carousels — one per real category plus Farms/Pumpkin
  // Patches, nationwide top-rated by default, replaced client-side with a
  // real distance-sorted set once location is known.
  '{{NEARBY_PRIORITY_CAROUSELS}}': nearbyPriorityCarouselsHtml,
  '{{NEARBY_CAROUSELS}}': nearbyCarouselsHtml,
  '{{STAT_LISTINGS}}': stats.listings.toLocaleString('en-US'),
  '{{STAT_STATES}}': String(stats.states),
  '{{STAT_CITIES}}': String(stats.cities),
  '{{CONTACT_EMAIL}}': CONTACT_EMAIL,
  '{{BUILD_DATE}}': new Date(`${BUILD_DATE}T12:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }),
  '{{SITEMAP_STATES}}': stateNames
    .map((s) => `<li><a href="${statePath(s)}">Pumpkin patches in ${esc(s)}</a></li>`)
    .join('\n'),
  // Hand-authored and citywide guides only — the 800+ programmatic
  // attraction/city posts are reachable from the paginated /blog/ index and
  // the XML sitemap, but listing every one of them here would make this
  // human-facing page unusable.
  '{{SITEMAP_POSTS}}': [...handAuthoredPosts, ...cityPosts]
    .map((p) => `<li><a href="/blog/${p.meta.slug}/">${esc(p.meta.h1 || p.meta.title)}</a></li>`)
    .join('\n') + `\n<li><a href="/blog/">All ${posts.length} guides &amp; local roundups &rarr;</a></li>`,
  '{{CATEGORY_GRID}}': renderCategoryGrid(),
  '{{SITEMAP_CATEGORIES}}': categories
    .map((c) => `<li><a href="${categoryPath(c)}">${esc(c.name)} near me</a></li>`)
    .join('\n'),
  '{{FEATURED_FARM_CARDS}}': featuredListings.length
    ? `<div class="grid grid-3">\n${featuredListings.map((l) => renderCard(l)).join('\n')}\n</div>`
    : `<div class="empty-state">
  <h3>No featured farms yet this season</h3>
  <p>Featured placement goes to claimed listings. If you run a pumpkin patch and want the top of your state and town results, claim your listing.</p>
  <a class="btn btn-primary" href="/partners/">Claim your listing</a>
</div>`,
  '{{SEASON_YEAR}}': String(SEASON_YEAR),
  '{{AD_SQUARE}}': renderAdSlot('square'),
  // The national /pumpkin-patches/ directory — every listing we track, in
  // the same pillar-list format as the state/city/category pages, with a
  // state filter added since (unlike those pages) nothing here is already
  // scoped to one state.
  '{{PUMPKIN_PATCHES_DIRECTORY}}': (() => {
    const items = rankListings(listings);
    const presentCategoriesAll = categories
      .map((c) => ({ c, n: items.filter((l) => (l.features || []).includes(c.feature)).length }))
      .filter((x) => x.n > 0);
    const stateCounts = stateNames.map((s) => ({ state: s, n: (byState.get(s) || []).length }));

    const filterBar = `<div class="find-tool state-filter" id="state-filter">
  <div class="search-field">
    <label class="visually-hidden" for="state-filter-q">Search by name, city or state</label>
    <input id="state-filter-q" type="text" placeholder="Search by name, city or state..." autocomplete="off">
  </div>
  <div class="control-group">
    <label class="control">
      <span class="control-label">State</span>
      <select id="state-filter-state" aria-label="Filter by state">
        <option value="">All states</option>
${stateCounts.map(({ state, n }) => `        <option value="${attr(state.toLowerCase())}">${esc(state)} (${n})</option>`).join('\n')}
      </select>
    </label>
    <label class="control">
      <span class="control-label">Attraction</span>
      <select id="state-filter-feature" aria-label="Filter by attraction">
        <option value="">All</option>
${presentCategoriesAll.map(({ c, n }) => `        <option value="${attr(c.feature.toLowerCase())}">${esc(c.name)} (${n})</option>`).join('\n')}
      </select>
    </label>
    <label class="control">
      <span class="control-label">Sort</span>
      <select id="state-filter-sort" aria-label="Sort results">
        <option value="rating">Top rated</option>
        <option value="reviews">Most reviewed</option>
        <option value="name">Name A-Z</option>
        <option value="distance">Nearest to me</option>
      </select>
    </label>
    <button class="toggle-btn" type="button" id="state-filter-reset">Reset</button>
    <button class="toggle-btn" type="button" data-geo-trigger>Show distance from me</button>
  </div>
  <div class="results-head" style="padding:0.6rem 0 0;background:transparent;border:0">
    <p class="results-count" id="state-filter-count">${items.length.toLocaleString('en-US')} pumpkin patches</p>
  </div>
</div>`;

    const listHtml = `${filterBar}
<ol class="pillar-list" id="state-pillar-list">
${pillarEntriesWithAds(items, (l, i) => renderPillarEntry(l, i, l.state))}
</ol>
<p class="empty-state" id="state-filter-empty" hidden><strong>No matches.</strong> Try a different search, state or attraction, or <button type="button" class="btn-link" id="state-filter-empty-reset">reset the filters</button>.</p>`;

    return renderScopedMap(items, listHtml);
  })(),
};

function expandTokens(html) {
  let out = html;
  for (const [token, value] of Object.entries(tokens)) out = out.split(token).join(value);
  return out;
}

// The blog index is paginated rather than dumping every post on one page —
// with 800+ programmatic attraction/city posts alongside the hand-written
// guides, an unpaginated /blog/ would be an unreasonably large single page.
// Page 1 is /blog/, subsequent pages are /blog/page/2/, /blog/page/3/, etc.,
// each indexable with its own title and canonical (a differing set of
// teasers per page, not duplicate content).
const BLOG_PAGE_SIZE = 24;

for (const page of staticPages) {
  if (page.meta.path === '/blog/') {
    const totalPages = Math.max(1, Math.ceil(posts.length / BLOG_PAGE_SIZE));
    const [beforeTeasers, afterTeasers] = page.body.split('{{BLOG_TEASERS}}');
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const pagePath = pageNum === 1 ? '/blog/' : `/blog/page/${pageNum}/`;
      const slice = posts.slice((pageNum - 1) * BLOG_PAGE_SIZE, pageNum * BLOG_PAGE_SIZE);
      const teasersForPage = slice
        .map((p) => {
          const author = authorsBySlug.get(p.meta.author);
          const byAuthor = author ? `By <a href="${authorPath(author)}">${esc(author.name)}</a> &middot; ` : '';
          return `<article class="post-item">
  <h3><a href="/blog/${p.meta.slug}/">${esc(p.meta.h1 || p.meta.title)}</a></h3>
  <p class="post-meta">${byAuthor}${p.meta.date ? new Date(`${p.meta.date}T12:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) : ''}${p.meta.readingTime ? ` &middot; ${esc(p.meta.readingTime)}` : ''}</p>
  <p>${esc(p.meta.excerpt || p.meta.description)}</p>
  <a class="btn btn-outline btn-sm" href="/blog/${p.meta.slug}/">Read the guide</a>
</article>`;
        })
        .join('\n');
      const paginationHtml = totalPages > 1
        ? `<nav class="pagination" aria-label="Blog pagination">
  ${pageNum > 1 ? `<a class="btn btn-outline btn-sm" href="${pageNum === 2 ? '/blog/' : `/blog/page/${pageNum - 1}/`}">&larr; Newer</a>` : '<span></span>'}
  <span class="pagination-status">Page ${pageNum} of ${totalPages}</span>
  ${pageNum < totalPages ? `<a class="btn btn-outline btn-sm" href="/blog/page/${pageNum + 1}/">Older &rarr;</a>` : '<span></span>'}
</nav>`
        : '';
      const closeIdx = afterTeasers.indexOf('</div>') + '</div>'.length;
      const afterWithPagination = afterTeasers.slice(0, closeIdx) + '\n' + paginationHtml + afterTeasers.slice(closeIdx);
      const pageBody = expandTokens(`${beforeTeasers}${teasersForPage}${afterWithPagination}`);

      const pageMeta = {
        ...page.meta,
        path: pagePath,
        title: pageNum === 1 ? page.meta.title : `${page.meta.title} — Page ${pageNum} of ${totalPages}`,
        // The page-number marker goes first, not appended at the end —
        // meta descriptions get truncated around 155 characters, and a
        // suffix past that cutoff would collapse every page's description
        // to the same truncated string instead of staying distinct.
        description: pageNum === 1 ? page.meta.description : `Page ${pageNum} of ${totalPages}. ${page.meta.description}`,
        trail: pageNum === 1 ? page.meta.trail : [{ label: 'Blog', href: '/blog/' }, { label: `Page ${pageNum}` }],
      };
      const crumbs = breadcrumbJsonLd(pageMeta.trail, pagePath);
      const jsonld = {
        '@context': 'https://schema.org',
        '@graph': [
          { '@type': 'WebPage', name: pageMeta.title, description: pageMeta.description, url: SITE_URL + pagePath },
          crumbs,
        ],
      };
      writePage(pagePath, render(pageMeta, pageBody, { jsonld }));
      addToSitemap(pagePath, pageNum === 1 ? '0.7' : '0.4', 'weekly');
    }
    continue;
  }

  const meta = page.meta;
  const body = expandTokens(page.body);
  let jsonld = null;
  let scripts = '';

  if (meta.path === '/') {
    jsonld = {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'WebSite',
          '@id': `${SITE_URL}/#website`,
          name: SITE_NAME,
          url: SITE_URL,
          description: meta.description,
          potentialAction: {
            '@type': 'SearchAction',
            target: { '@type': 'EntryPoint', urlTemplate: `${SITE_URL}/?zip={search_term_string}` },
            'query-input': 'required name=search_term_string',
          },
        },
        {
          '@type': 'Organization',
          '@id': `${SITE_URL}/#organization`,
          name: SITE_NAME,
          url: SITE_URL,
          email: CONTACT_EMAIL,
          logo: { '@type': 'ImageObject', url: `${SITE_URL}/assets/img/icon-512.png` },
        },
        {
          '@type': 'FAQPage',
          mainEntity: faqs.map((f) => ({
            '@type': 'Question',
            name: f.question,
            acceptedAnswer: { '@type': 'Answer', text: f.answer.replace(/<[^>]+>/g, '').trim() },
          })),
        },
      ],
    };
    scripts = `<link rel="stylesheet" href="/assets/vendor/leaflet/leaflet.css">
<script src="/assets/vendor/leaflet/leaflet.js" defer></script>
<script src="/assets/js/map.js?v=${ASSET_VERSION}" defer></script>`;
  }

  if (meta.path === '/search/') {
    scripts = `<script src="/assets/js/search.js?v=${ASSET_VERSION}" defer></script>`;
  }

  if (meta.path === '/pumpkin-patches/') {
    scripts = `${pageMapScripts}\n<script src="/assets/js/state-filter.js?v=${ASSET_VERSION}" defer></script>\n<script src="/assets/js/pillar-entry.js?v=${ASSET_VERSION}" defer></script>`;
  }

  if (meta.path === '/dashboard/') {
    scripts = `<script src="/assets/vendor/supabase/supabase.js?v=${ASSET_VERSION}" defer></script>\n<script src="/assets/js/dashboard.js?v=${ASSET_VERSION}" defer></script>`;
  }

  if (meta.trail) {
    const crumbs = breadcrumbJsonLd(meta.trail, meta.path);
    jsonld = jsonld || {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'WebPage',
          name: meta.title,
          description: meta.description,
          url: SITE_URL + meta.path,
        },
        crumbs,
      ],
    };
  }

  writePage(meta.path, render(meta, body, { jsonld, scripts }));
  if (!meta.noindex) addToSitemap(meta.path, meta.path === '/' ? '1.0' : '0.7', meta.path === '/' ? 'daily' : 'monthly');
}

/* --- state pages --------------------------------------------------------- */

for (const stateName of stateNames) {
  // stateNames is derived from byState's own keys, so every state reached
  // here has at least one listing — no empty-state branch needed.
  const items = byState.get(stateName);
  const path = statePath(stateName);
  const cities = [...new Set(items.map((l) => l.city).filter(Boolean))].sort();

  // Title/H1 lead with "Near Me" rather than just "in <State>" — checked
  // real Search Console query data behind these pages before this change:
  // "pumpkin patch(es) near me" outweighs "pumpkin patch(es) in <state>"
  // by roughly 10 to 1 in impressions on state pages specifically (e.g. 57
  // + 29 impressions for the two "near me" variants vs. 5 for "georgia
  // pumpkin patches" and 2 for "pumpkin patch in georgia" on /georgia/
  // alone), so the literal query phrase wasn't in the title/H1 at all.
  const meta = {
    path,
    title: `${items.length} ${patchWord(items.length)} Near Me in ${stateName}, Ranked (${SEASON_YEAR})`,
    description: `Pumpkin patches near me in ${stateName} — every one we track, ${items.length} listing${items.length === 1 ? '' : 's'} across ${cities.length} ${cities.length === 1 ? 'town' : 'towns'}, ranked by rating, with search and filter. Updated for ${SEASON_YEAR}.`,
    h1: `${items.length} ${patchWord(items.length)} Near Me in ${stateName}`,
    lede: `Every pumpkin patch we track in ${stateName}, ranked by rating and review volume across ${cities.length} ${cities.length === 1 ? 'town' : 'towns'}. Search by name or town, or filter by attraction. Always confirm hours before you drive out — most patches open late September and close in early November.`,
    nav: 'find',
    layout: 'wide',
    trail: [{ label: 'Pumpkin Patches', href: '/pumpkin-patches/' }, { label: stateName }],
  };

  const presentCategories = categories
    .map((c) => ({ c, n: items.filter((l) => (l.features || []).includes(c.feature)).length }))
    .filter((x) => x.n > 0);

  const cityCounts = cities.map((c) => ({ city: c, n: items.filter((l) => l.city === c).length }));

  const filterBar = `<div class="find-tool state-filter" id="state-filter">
  <div class="search-field">
    <label class="visually-hidden" for="state-filter-q">Search by name or town</label>
    <input id="state-filter-q" type="text" placeholder="Search by name or town..." autocomplete="off">
  </div>
  <div class="control-group">
    <label class="control">
      <span class="control-label">City</span>
      <select id="state-filter-city" aria-label="Filter by city">
        <option value="">All cities</option>
${cityCounts.map(({ city, n }) => `        <option value="${attr(city.toLowerCase())}">${esc(city)} (${n})</option>`).join('\n')}
      </select>
    </label>
    <label class="control">
      <span class="control-label">Attraction</span>
      <select id="state-filter-feature" aria-label="Filter by attraction">
        <option value="">All</option>
${presentCategories.map(({ c, n }) => `        <option value="${attr(c.feature.toLowerCase())}">${esc(c.name)} (${n})</option>`).join('\n')}
      </select>
    </label>
    <label class="control">
      <span class="control-label">Sort</span>
      <select id="state-filter-sort" aria-label="Sort results">
        <option value="rating">Top rated</option>
        <option value="reviews">Most reviewed</option>
        <option value="name">Name A-Z</option>
        <option value="distance">Nearest to me</option>
      </select>
    </label>
    <button class="toggle-btn" type="button" id="state-filter-reset">Reset</button>
    <button class="toggle-btn" type="button" data-geo-trigger>Show distance from me</button>
  </div>
  <div class="results-head" style="padding:0.6rem 0 0;background:transparent;border:0">
    <p class="results-count" id="state-filter-count">${items.length.toLocaleString('en-US')} pumpkin patch${items.length === 1 ? '' : 'es'}</p>
  </div>
</div>`;

  const listHtml = `${filterBar}
<ol class="pillar-list" id="state-pillar-list">
${pillarEntriesWithAds(items, (l, i) => renderPillarEntry(l, i, stateName))}
</ol>
<p class="empty-state" id="state-filter-empty" hidden><strong>No matches.</strong> Try a different search, city or attraction, or <button type="button" class="btn-link" id="state-filter-empty-reset">reset the filters</button>.</p>`;

  const citySection = cities.length
    ? `<h2>Pumpkin patches by town in ${esc(stateName)}</h2>
<p>Pick a town to see just the farms there.</p>
${renderCityLinks(stateName)}`
    : '';

  const catSection = presentCategories.length
    ? `<h2>${esc(stateName)} farms by attraction</h2>
<div class="tag-row">
${presentCategories.map(({ c, n }) => {
  // Prefer this state's own service page (e.g. /hayrides/georgia/) over
  // the generic nationwide category page, when one was generated.
  const statePage = categoryStatePageLinks.get(`${c.slug}|${stateName}`);
  return `  <a class="tag tag-link" href="${statePage ? statePage.href : categoryPath(c)}">${esc(c.name)} (${n})</a>`;
}).join('\n')}
</div>`
    : '';

  // Links down to every blog post generated specifically for this state
  // (the state's own "10 Best" pillar post, Fields/Farms, U-Pick, Petting
  // Zoo, Fall Festival and pricing-guide posts, whichever qualify) — so the
  // state page, as the geographic pillar, actually surfaces its own
  // cluster content instead of dead-ending at the directory list.
  const stateGuides = stateGuideLinks.get(stateName) || [];
  const guidesSection = stateGuides.length
    ? `<h2>${esc(stateName)} pumpkin patch guides</h2>
<ul class="link-list">
${stateGuides.map((g) => `  <li><a href="${g.href}">${esc(g.title)}</a></li>`).join('\n')}
</ul>`
    : '';

  const body = `${renderScopedMap(items, listHtml)}
<div class="section" style="padding-bottom:0">
${citySection}
${catSection}
${guidesSection}
<h2>Planning a ${esc(stateName)} pumpkin patch trip</h2>
<p>Pumpkin patch season in ${esc(stateName)} generally runs from mid-September through the first weekend of November, with the busiest weekends falling in mid-October. Weekday mornings are the quietest time to visit, and many farms charge admission only on weekends when the corn maze, hayrides and food stands are all running.</p>
<p>Bring cash — plenty of family farms still run cash-only gates or wagon rides — and check whether the patch charges by the pumpkin, by the pound or as a flat admission. Call ahead after heavy rain, since field access is the first thing farms close.</p>
<p><a class="btn btn-outline" href="/">Search the ${esc(stateName)} map</a></p>
${renderPhotoGallery(items, path, stateName)}
</div>`;

  const jsonld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        name: meta.title,
        description: meta.description,
        url: SITE_URL + path,
      },
      {
        '@type': 'ItemList',
        numberOfItems: items.length,
        itemListElement: items.slice(0, 25).map((l, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          url: SITE_URL + listingPath(l),
          name: l.name,
        })),
      },
      breadcrumbJsonLd(meta.trail, path),
    ],
  };

  const scripts = items.length
    ? `${pageMapScripts}\n<script src="/assets/js/state-filter.js?v=${ASSET_VERSION}" defer></script>\n<script src="/assets/js/pillar-entry.js?v=${ASSET_VERSION}" defer></script>`
    : '';
  writePage(path, render(meta, body, { jsonld, scripts }));
  addToSitemap(path, '0.8', 'weekly');
}

/* --- city pages ---------------------------------------------------------- */

for (const [key, items] of byCity) {
  const [stateName, cityName] = key.split('|');
  const path = cityPath(stateName, cityName);
  const stateCode = items[0].stateCode || '';
  const label = `${cityName}, ${stateCode}`;
  const featureCounts = categories
    .map((c) => ({ c, n: items.filter((l) => (l.features || []).includes(c.feature)).length }))
    .filter((x) => x.n > 0);

  const meta = {
    path,
    title: `${items.length} ${patchWord(items.length)} in ${label}, Ranked (${SEASON_YEAR})`,
    description: `Every pumpkin patch we track in ${label} — ${items.length} listing${items.length === 1 ? '' : 's'}, ranked by rating, with search and filter. Updated for ${SEASON_YEAR}.`,
    h1: `${items.length} ${patchWord(items.length)} in ${label}`,
    lede: `Every pumpkin patch we track in ${label}, ranked by rating and review volume. Search by name, or filter by attraction. Always confirm hours before you drive out — most patches open late September and close in early November.`,
    nav: 'find',
    layout: 'wide',
    trail: [
      { label: 'Pumpkin Patches', href: '/pumpkin-patches/' },
      { label: stateName, href: statePath(stateName) },
      { label: cityName },
    ],
  };

  const siblings = citiesInState(stateName).filter((c) => c !== cityName);

  // This city's own blog posts — its "5 Best Pumpkin Patches" listicle and
  // any "Best <Attraction> in <City>" posts — so the city page (the
  // smallest geographic pillar) links straight down to its cluster
  // content instead of leaving it only reachable from /blog/.
  const cityGuides = cityGuideLinks.get(`${stateName}|${cityName}`) || [];

  const filterBar = `<div class="find-tool state-filter" id="state-filter">
  <div class="search-field">
    <label class="visually-hidden" for="state-filter-q">Search by name</label>
    <input id="state-filter-q" type="text" placeholder="Search by name..." autocomplete="off">
  </div>
  <div class="control-group">
    <label class="control">
      <span class="control-label">Attraction</span>
      <select id="state-filter-feature" aria-label="Filter by attraction">
        <option value="">All</option>
${featureCounts.map(({ c, n }) => `        <option value="${attr(c.feature.toLowerCase())}">${esc(c.name)} (${n})</option>`).join('\n')}
      </select>
    </label>
    <label class="control">
      <span class="control-label">Sort</span>
      <select id="state-filter-sort" aria-label="Sort results">
        <option value="rating">Top rated</option>
        <option value="reviews">Most reviewed</option>
        <option value="name">Name A-Z</option>
        <option value="distance">Nearest to me</option>
      </select>
    </label>
    <button class="toggle-btn" type="button" id="state-filter-reset">Reset</button>
    <button class="toggle-btn" type="button" data-geo-trigger>Show distance from me</button>
  </div>
  <div class="results-head" style="padding:0.6rem 0 0;background:transparent;border:0">
    <p class="results-count" id="state-filter-count">${items.length.toLocaleString('en-US')} pumpkin patch${items.length === 1 ? '' : 'es'}</p>
  </div>
</div>`;

  const listHtml = `${filterBar}
<ol class="pillar-list" id="state-pillar-list">
${pillarEntriesWithAds(items, (l, i) => renderPillarEntry(l, i, cityName))}
</ol>
<p class="empty-state" id="state-filter-empty" hidden><strong>No matches.</strong> Try a different search or attraction, or <button type="button" class="btn-link" id="state-filter-empty-reset">reset the filters</button>.</p>`;

  const body = `${renderScopedMap(items, listHtml)}

<div class="section" style="padding-bottom:0">
  ${featureCounts.length ? `<h2>What ${esc(cityName)} farms offer</h2>
  <div class="tag-row">
${featureCounts.map(({ c, n }) => {
  // Link straight to this city's own service page (e.g. /hayrides/calhoun-ga/)
  // when one was generated, rather than the generic statewide category page —
  // it's the more precise match for someone browsing this city specifically.
  const cityPage = categoryCityPageLinks.get(`${c.slug}|${stateName}|${cityName}`);
  return `    <a class="tag tag-link" href="${cityPage ? cityPage.href : categoryPath(c)}">${esc(c.name)} (${n})</a>`;
}).join('\n')}
  </div>` : ''}

  <h2>Visiting a pumpkin patch near ${esc(cityName)}</h2>
  <p>Farms around ${esc(cityName)} follow the same rhythm as the rest of ${esc(stateName)}: gates open in the second half of September, the busiest weekends fall in mid-October, and most patches close within a few days of Halloween. Weekday mornings are consistently the quietest time to go.</p>
  <p>Call ahead if it has rained recently. Field access and wagon rides are the first things a farm closes when the ground is soft, and that decision is usually made the morning of.</p>

  ${siblings.length ? `<h2>Nearby towns in ${esc(stateName)}</h2>
  <div class="state-grid">
${siblings
  .map((c) => `    <a class="state-link" href="${cityPath(stateName, c)}">${esc(c)} <span>${(byCity.get(`${stateName}|${c}`) || []).length}</span></a>`)
  .join('\n')}
  </div>` : ''}

  ${cityGuides.length ? `<h2>${esc(cityName)} pumpkin patch guides</h2>
  <ul class="link-list">
${cityGuides.map((g) => `    <li><a href="${g.href}">${esc(g.title)}</a></li>`).join('\n')}
  </ul>` : ''}

  <p style="margin-top:1.5rem">
    <a class="btn btn-primary" href="/">Search the map by ZIP code</a>
    <a class="btn btn-outline" href="${statePath(stateName)}">All ${esc(stateName)} pumpkin patches</a>
  </p>

  ${renderPhotoGallery(items, path, cityName)}
</div>`;

  const jsonld = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'CollectionPage', name: meta.title, description: meta.description, url: SITE_URL + path },
      {
        '@type': 'ItemList',
        numberOfItems: items.length,
        itemListElement: items.slice(0, 25).map((l, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          url: SITE_URL + listingPath(l),
          name: l.name,
        })),
      },
      breadcrumbJsonLd(meta.trail, path),
    ],
  };

  const scripts = `${pageMapScripts}\n<script src="/assets/js/state-filter.js?v=${ASSET_VERSION}" defer></script>\n<script src="/assets/js/pillar-entry.js?v=${ASSET_VERSION}" defer></script>`;

  writePage(path, render(meta, body, { jsonld, scripts }));
  addToSitemap(path, '0.7', 'weekly');
}

/* --- attraction category pages ------------------------------------------- */

for (const cat of categories) {
  const items = byCategory.get(cat.slug) || [];
  const path = categoryPath(cat);
  const statesWith = [...new Set(items.map((l) => l.state).filter(Boolean))].sort();

  const meta = {
    path,
    title: cat.title,
    // A real freshness signal in the description (not just the title, which
    // several of these are already close to the 60-char safe length) —
    // "near me" searchers skew toward wanting current-season results.
    description: truncateMetaDescription(`${cat.description} Updated for ${SEASON_YEAR}.`),
    h1: `${cat.name} Near Me`,
    lede: cat.lede,
    nav: cat.slug === 'corn-mazes' ? 'corn-mazes' : cat.slug === 'hayrides' ? 'hayrides' : 'pumpkin-patches',
    layout: 'wide',
    trail: [{ label: 'Pumpkin Patches', href: '/pumpkin-patches/' }, { label: cat.name }],
  };

  const catHeroSrc = (items.find((l) => l.photo) || {}).photo || PLACEHOLDER_IMAGE;
  const catHeroHtml = blogHeroFigureHtml(catHeroSrc, `${cat.name} near you`);

  const filterBar = `<div class="find-tool state-filter" id="cat-filter">
  <div class="search-field">
    <label class="visually-hidden" for="cat-filter-q">Search by name or town</label>
    <input id="cat-filter-q" type="text" placeholder="Search by name or town..." autocomplete="off">
  </div>
  <div class="control-group">
    <label class="control">
      <span class="control-label">State</span>
      <select id="cat-filter-state" aria-label="Filter by state">
        <option value="">All states</option>
${statesWith.map((s) => `        <option value="${attr(s.toLowerCase())}">${esc(s)} (${items.filter((l) => l.state === s).length})</option>`).join('\n')}
      </select>
    </label>
    <label class="control">
      <span class="control-label">Sort</span>
      <select id="cat-filter-sort" aria-label="Sort results">
        <option value="rating">Top rated</option>
        <option value="reviews">Most reviewed</option>
        <option value="name">Name A-Z</option>
        <option value="distance">Nearest to me</option>
      </select>
    </label>
    <button class="toggle-btn" type="button" id="cat-filter-reset">Reset</button>
    <button class="toggle-btn" type="button" data-geo-trigger>Show distance from me</button>
  </div>
  <div class="results-head" style="padding:0.6rem 0 0;background:transparent;border:0">
    <p class="results-count" id="cat-filter-count">${items.length.toLocaleString('en-US')} listings</p>
  </div>
</div>`;

  const listHtml = items.length
    ? `${filterBar}
<ol class="pillar-list" id="cat-pillar-list">
${pillarEntriesWithAds(items, (l, i) => renderPillarEntry(l, i, cat.name))}
</ol>
<p class="empty-state" id="cat-filter-empty" hidden><strong>No matches.</strong> Try a different search or state, or <button type="button" class="btn-link" id="cat-filter-empty-reset">reset the filters</button>.</p>`
    : `<div class="empty-state">
  <h3>No ${esc(cat.name.toLowerCase())} listed yet</h3>
  <p>We are still building out this category. If you know a farm that should be here, send it to us.</p>
  <a class="btn btn-primary" href="/add-a-listing/">Submit a farm</a>
</div>`;

  // This category's own in-depth guides: a full per-state listicle series
  // exists for some categories (U-Pick, Petting Zoos, Fall Festivals); for
  // the rest, fall back to the strongest per-city "Best <Attraction> in
  // <City>" posts (there can be well over a hundred of these per category,
  // so cap it rather than dumping every one on a single page — the state
  // grid above and each state/city page's own guide links are how the
  // long tail stays reachable).
  const CATEGORY_CITY_GUIDE_CAP = 24;
  // The category's own city-scoped service pages (e.g. /hayrides/<city>-<state>/),
  // when that category has them — separate from catCityGuides below, which
  // links to blog posts about the same cities, not the directory pages.
  const catCityPages = (categoryCityPageList.get(cat.slug) || [])
    .slice()
    .sort((a, b) => b.n - a.n)
    .slice(0, CATEGORY_CITY_GUIDE_CAP);
  const catCityPagesSection = catCityPages.length
    ? `<h2>${esc(cat.name)} by city</h2>
  <ul class="link-list grid grid-2">
${catCityPages.map((g) => `    <li><a href="${g.href}">${esc(g.title)}</a></li>`).join('\n')}
  </ul>`
    : '';
  const catStateGuides = categoryStateGuideLinks.get(cat.slug) || [];
  const catCityGuides = (categoryCityGuideLinks.get(cat.slug) || [])
    .slice()
    .sort((a, b) => b.n - a.n)
    .slice(0, CATEGORY_CITY_GUIDE_CAP);
  const catGuidesSection = catStateGuides.length
    ? `<h2>${esc(cat.name)} guides by state</h2>
  <ul class="link-list grid grid-2">
${catStateGuides.map((g) => `    <li><a href="${g.href}">${esc(g.title)}</a></li>`).join('\n')}
  </ul>`
    : catCityGuides.length
      ? `<h2>${esc(cat.name)} guides by city</h2>
  <ul class="link-list grid grid-2">
${catCityGuides.map((g) => `    <li><a href="${g.href}">${esc(g.title)}</a></li>`).join('\n')}
  </ul>`
      : '';

  const catFaqHtml = cat.faq && cat.faq.length
    ? `<h2>Frequently asked questions</h2>
  <div class="faq-list">
${cat.faq
  .map(
    (item) => `    <details class="faq-item">
      <summary>${esc(item.q)}</summary>
      <div class="faq-answer"><p>${item.a}</p></div>
    </details>`
  )
  .join('\n')}
  </div>`
    : '';

  const body = `${catHeroHtml}
${cat.intro}
${cat.extraIntro || ''}

${renderScopedMap(items, listHtml, { singular: cat.singular, plural: cat.name.toLowerCase() })}

<div class="section" style="padding-bottom:0">
  ${statesWith.length ? `<h2>${esc(cat.name)} by state</h2>
  <div class="state-grid">
${statesWith
  .map((s) => {
    const n = items.filter((l) => l.state === s).length;
    const statePage = categoryStatePageLinks.get(`${cat.slug}|${s}`);
    return `    <a class="state-link" href="${statePage ? statePage.href : statePath(s)}">${esc(s)} <span>${n}</span></a>`;
  })
  .join('\n')}
  </div>` : ''}

  ${catCityPagesSection}

  ${catGuidesSection}

  ${catFaqHtml}

  <h2>Find a ${esc(cat.singular)} near you</h2>
  <p>The fastest way to find a farm with a ${esc(cat.singular)} nearby is the map: enter your ZIP code, then set the feature filter to ${esc(cat.name.toLowerCase())}. Results re-sort by distance from your location.</p>
  <p>
    <a class="btn btn-primary" href="/">Search the map</a>
    <a class="btn btn-outline" href="/pumpkin-patches/">Browse all attractions</a>
  </p>
  ${renderPhotoGallery(items, path, cat.name)}
</div>`;

  const jsonld = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'CollectionPage', name: cat.title, description: cat.description, url: SITE_URL + path },
      {
        '@type': 'ItemList',
        numberOfItems: items.length,
        itemListElement: items.slice(0, 25).map((l, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          url: SITE_URL + listingPath(l),
          name: l.name,
        })),
      },
      ...(cat.faq && cat.faq.length
        ? [
            {
              '@type': 'FAQPage',
              mainEntity: cat.faq.map((item) => ({
                '@type': 'Question',
                name: item.q,
                acceptedAnswer: { '@type': 'Answer', text: item.a.replace(/<[^>]+>/g, '') },
              })),
            },
          ]
        : []),
      breadcrumbJsonLd(meta.trail, path),
    ],
  };

  const scripts = items.length
    ? `${pageMapScripts}\n<script src="/assets/js/category-filter.js?v=${ASSET_VERSION}" defer></script>\n<script src="/assets/js/pillar-entry.js?v=${ASSET_VERSION}" defer></script>`
    : '';

  writePage(path, render(meta, body, { jsonld, scripts }));
  addToSitemap(path, '0.8', 'weekly');
}

/* --- listing detail pages ------------------------------------------------ */

// Some operators run several same-named seasonal lots in one town (real,
// separate listings at different addresses) — precomputed so their titles
// and descriptions can be disambiguated with a street address instead of
// shipping identical <title>/<meta description> tags across distinct URLs.
const nameCityCounts = new Map();
for (const l of listings) {
  const key = `${l.name.trim().toLowerCase()}|${l.city || ''}|${l.state || ''}`;
  nameCityCounts.set(key, (nameCityCounts.get(key) || 0) + 1);
}

for (const l of listings) {
  const path = listingPath(l);
  const place = [l.city, l.stateCode].filter(Boolean).join(', ');
  const isDuplicateNameInCity = nameCityCounts.get(`${l.name.trim().toLowerCase()}|${l.city || ''}|${l.state || ''}`) > 1;
  const titlePlace = isDuplicateNameInCity && l.street ? `${l.street}, ${place}` : place;
  const baseTitle = `${l.name}${titlePlace ? ` — ${titlePlace}` : ''}`;
  // Drop the site-name suffix rather than truncating mid-word when the full
  // title would run past a safe SERP display length — the business name and
  // location are the part worth keeping intact.
  const title = `${baseTitle} | Pumpkin Patch Near Me`.length <= 60 ? `${baseTitle} | Pumpkin Patch Near Me` : baseTitle;
  const meta = {
    path,
    title,
    description:
      l.description ||
      `${l.name} is a pumpkin patch${isDuplicateNameInCity && l.street ? ` at ${l.street}` : place ? ` in ${place}` : ''}. See the address, hours, rating and directions before you visit.`,
    h1: l.name,
    lede: place ? `Pumpkin patch in ${place}` : 'Pumpkin patch',
    nav: 'pumpkin-patches',
    layout: 'wide',
    noindex: Boolean(l.sample),
    trail: [
      { label: 'Pumpkin Patches', href: '/pumpkin-patches/' },
      ...(l.state ? [{ label: l.state, href: statePath(l.state) }] : []),
      ...(l.state && l.city ? [{ label: l.city, href: cityPath(l.state, l.city) }] : []),
      { label: l.name },
    ],
  };

  // Other farms in the same town, so every listing page has somewhere to go next.
  const nearby = (byCity.get(`${l.state}|${l.city}`) || []).filter((o) => o.slug !== l.slug).slice(0, 3);

  // A second, broader set of relevant listings statewide — sharing at least
  // one attraction tag where possible, so a listing page links out to more
  // than just its own town rather than dead-ending at three same-city cards.
  const excludeSlugs = new Set([l.slug, ...nearby.map((o) => o.slug)]);
  const sameStateOthers = (byState.get(l.state) || []).filter((o) => !excludeSlugs.has(o.slug));
  const sameStateByFeature = sameStateOthers.filter((o) => (o.features || []).some((f) => (l.features || []).includes(f)));
  const related = (sameStateByFeature.length ? sameStateByFeature : sameStateOthers).slice(0, 3);
  const nearCities = l.state && l.city ? nearbyCities(l.state, l.city, 8) : [];

  // Editorial guides relevant to this specific listing: its city's own
  // "Best Pumpkin Patches" roundup, a "Best <Attraction> in <City>" post
  // matching one of its feature tags if one exists, and a state-level guide
  // (preferring one matching a feature tag, falling back to the general
  // one) — every listing page ends up pointing at real blog content
  // instead of dead-ending in directory pages alone.
  const featureCatSlugs = new Set(categories.filter((c) => (l.features || []).includes(c.feature)).map((c) => c.slug));
  const listingCityGuides = cityGuideLinks.get(`${l.state}|${l.city}`) || [];
  const listingStateGuides = stateGuideLinks.get(l.state) || [];
  const listingGuides = [
    listingCityGuides.find((g) => !g.catSlug),
    listingCityGuides.find((g) => g.catSlug && featureCatSlugs.has(g.catSlug)),
    listingStateGuides.find((g) => g.catSlug && featureCatSlugs.has(g.catSlug)) || listingStateGuides.find((g) => !g.catSlug),
  ]
    .filter(Boolean)
    .filter((g, i, arr) => arr.findIndex((x) => x.href === g.href) === i);

  const address = l.fullAddress || [l.street, place, l.postalCode].filter(Boolean).join(', ');
  const hoursRows = l.hours
    ? DAYS.map(
        (d) =>
          `<tr><td>${d[0].toUpperCase() + d.slice(1)}</td><td>${esc(l.hours[d] || 'Not listed')}</td></tr>`
      ).join('')
    : '';

  const faq = listingFaqData(l, place);

  const body = `${l.sample ? `<div class="notice"><p><strong>Sample listing.</strong> This is placeholder data used to demonstrate the directory layout. It is excluded from search engines and will be replaced when the live Outscraper import runs.</p></div>` : ''}
<figure class="detail-hero">
  ${listingImage(l, { className: 'detail-hero-img', sizes: '(min-width: 900px) 900px, 100vw', size: 'hero' })}
  <figcaption>${l.photo ? `Photo of ${esc(l.name)} via Google` : `Illustration — a real photo is not yet available for ${esc(l.name)}`}</figcaption>
</figure>
${renderAdSlot('vertical')}
<div class="detail-grid">
  <div class="prose">
    <div class="listing-meta">
      ${l.rating ? `<span class="rating"><span class="stars" aria-hidden="true">${stars(l.rating)}</span> ${l.rating.toFixed(1)}</span>` : ''}
      ${l.reviews ? `<span>${l.reviews.toLocaleString('en-US')} Google reviews</span>` : ''}
      ${l.category ? `<span>${esc(l.category)}</span>` : ''}
    </div>
    ${(l.features || []).length ? `<div class="tag-row">${l.features.map((f) => `<span class="tag">${esc(f)}</span>`).join('')}</div>` : ''}
    ${l.description
      ? `<p>${esc(l.description)}</p>`
      : `<p>${esc(l.name)} is a listed pumpkin patch${place ? ` in ${esc(place)}` : ''}${l.county ? `, ${esc(l.county)} County` : ''}. We don't yet have a farm-provided description for this listing — if you run or have visited ${esc(l.name)}, <a href="/contact/">let us know</a> what makes it worth a stop and we will add it.</p>`}

    ${renderAdSlot('inArticle')}

    ${ratingBarsHtml(l)}

    ${knownForHtml(l)}

    ${whatToExpectHtml(l)}

    ${visitingGuidanceHtml(l, place)}

    ${l.season || l.admission || (l.payment && l.payment.length) ? `<h3>Quick facts</h3>
    <ul class="fact-list">
      ${l.season ? `<li><b>Season</b><span>${esc(l.season)}</span></li>` : ''}
      ${l.admission ? `<li><b>Admission</b><span>${esc(l.admission)}</span></li>` : ''}
      ${l.payment && l.payment.length ? `<li><b>Payment</b><span>${l.payment.map((p) => esc(p)).join(', ')}</span></li>` : ''}
    </ul>` : ''}

    ${visitTipsHtml()}

    <h2>Hours</h2>
    <p>${hoursRows ? `Listed hours for ${esc(l.name)} are below. As with any seasonal farm, treat these as a strong starting point rather than a guarantee — confirm directly if you are travelling any distance to visit.` : `Hours are not listed for ${esc(l.name)} in our data. Contact the farm directly to confirm before visiting — see the phone number and website in the panel to the right, if listed.`}</p>
    ${hoursRows ? `<table class="hours-table"><tbody>${hoursRows}</tbody></table>` : ''}
    ${l.directions ? `<h2>Directions</h2>\n    <p>${esc(l.directions)}</p>` : ''}

    ${locationParagraphHtml(l, address, place)}

    ${faq.html}

    ${nearby.length ? `<h2>Other pumpkin patches near ${esc(l.city)}</h2>
    <p>Comparing options nearby is always worth a minute before you commit to a drive — hours, pricing and what's running can vary a lot between farms just a few miles apart.</p>
    <div class="grid grid-2">
${nearby.map((o) => renderCard(o, { showState: false, showCity: false })).join('\n')}
    </div>
    <p><a href="${cityPath(l.state, l.city)}">All pumpkin patches in ${esc(l.city)}, ${esc(l.stateCode || '')}</a></p>` : ''}

    ${related.length ? `<h2>You might also like</h2>
    <p>${sameStateByFeature.length ? `More farms in ${esc(l.stateCode || l.state)} with similar attractions:` : `More pumpkin patches to compare across ${esc(l.stateCode || l.state)}:`}</p>
    <div class="grid grid-2">
${related.map((o) => renderCard(o, { showState: false, showCity: true })).join('\n')}
    </div>
    <p><a href="${statePath(l.state)}">All pumpkin patches in ${esc(l.state)}</a></p>` : ''}

    ${nearCities.length ? `<h2>Nearby Cities</h2>
    <p>Pumpkin patches in towns near ${esc(l.city)}, ${esc(l.stateCode || l.state)}:</p>
    <div class="tag-row">
${nearCities.map((c) => `      <a class="tag tag-link" href="${cityPath(l.state, c.city)}">${esc(c.city)} (${c.count})</a>`).join('\n')}
    </div>` : ''}

    ${listingGuides.length ? `<h2>Read more</h2>
    <ul class="link-list">
${listingGuides.map((g) => `      <li><a href="${g.href}">${esc(g.title)}</a></li>`).join('\n')}
    </ul>` : ''}

    <p style="margin-top:1.5rem"><a class="btn btn-outline" href="/">Search the full map for pumpkin patches near you</a></p>
  </div>
  <aside>
    <div class="card">
      <h3>Location and contact</h3>
      <ul class="fact-list">
        ${address ? `<li><b>Address</b><span>${esc(address)}</span></li>` : ''}
        ${l.phone ? `<li><b>Phone</b><span><a href="tel:${attr(l.phone.replace(/[^\d+]/g, ''))}">${esc(l.phone)}</a></span></li>` : ''}
        ${l.website ? `<li><b>Website</b><span><a href="${attr(l.website)}" target="_blank" rel="noopener nofollow">Visit site</a></span></li>` : ''}
        ${l.email ? `<li><b>Email</b><span><a href="mailto:${attr(l.email)}">${esc(l.email)}</a></span></li>` : ''}
        ${l.county ? `<li><b>County</b><span>${esc(l.county)}</span></li>` : ''}
        ${l.city && l.state ? `<li><b>Town</b><span><a href="${cityPath(l.state, l.city)}">${esc(l.city)}</a></span></li>` : ''}
        ${l.state ? `<li><b>State</b><span><a href="${statePath(l.state)}">${esc(l.state)}</a></span></li>` : ''}
      </ul>
      <p style="margin:1rem 0 0">
        <a class="btn btn-primary btn-block" href="https://www.google.com/maps/dir/?api=1&amp;destination=${l.lat},${l.lng}" target="_blank" rel="noopener nofollow">Get directions</a>
      </p>
    </div>
    <div class="detail-map" id="detail-map" data-lat="${l.lat}" data-lng="${l.lng}" data-name="${attr(l.name)}" style="margin-top:1.25rem"></div>
    ${(l.features || []).length ? `<div class="card" style="margin-top:1.25rem">
      <h3>At this farm</h3>
      <ul class="fact-list">
${categories
  .filter((c) => (l.features || []).includes(c.feature))
  .map((c) => `        <li><a href="${categoryPath(c)}">${esc(c.name)} near me</a></li>`)
  .join('\n')}
      </ul>
    </div>` : ''}
    <div class="card claim-card" style="margin-top:1.25rem">
      <h3>Is this your farm?</h3>
      <p>Claim ${esc(l.name)} to verify ownership, get priority placement on this page's state and town listings, and correct anything that's out of date.</p>
      <a class="btn btn-primary btn-block" href="https://buy.stripe.com/28E4gAfuG58I9UG9pIfrW04" target="_blank" rel="noopener">Claim This Business</a>
    </div>
    <p style="font-size:0.85rem;color:var(--muted);margin-top:0.75rem">Listing details come from public business data and may be out of date. <a href="/contact/">Report a correction</a> for free, or <a href="/partners/">claim this listing</a>.</p>
  </aside>
</div>`;

  const jsonld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'LocalBusiness',
        name: l.name,
        url: SITE_URL + path,
        ...(address ? { address: {
          '@type': 'PostalAddress',
          streetAddress: l.street || undefined,
          addressLocality: l.city || undefined,
          addressRegion: l.stateCode || undefined,
          postalCode: l.postalCode || undefined,
          addressCountry: 'US',
        } } : {}),
        geo: { '@type': 'GeoCoordinates', latitude: l.lat, longitude: l.lng },
        ...(l.phone ? { telephone: l.phone } : {}),
        ...(l.website ? { sameAs: [l.website] } : {}),
        ...(l.rating && l.reviews
          ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: l.rating, reviewCount: l.reviews } }
          : {}),
      },
      {
        '@type': 'FAQPage',
        mainEntity: faq.qa.map((item) => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.a },
        })),
      },
      breadcrumbJsonLd(meta.trail, path),
    ],
  };

  const scripts = `<link rel="stylesheet" href="/assets/vendor/leaflet/leaflet.css">
<script src="/assets/vendor/leaflet/leaflet.js" defer></script>
<script src="/assets/js/detail-map.js?v=${ASSET_VERSION}" defer></script>`;

  writePage(path, render(meta, body, { jsonld, scripts }));
  if (!l.sample) addToSitemap(path, '0.6', 'monthly');
}

/* --- assets and root files ---------------------------------------------- */

cpSync(join(SRC, 'assets'), join(DIST, 'assets'), { recursive: true });
mkdirSync(join(DIST, 'data'), { recursive: true });

// The only consumer of this file is map.js, driving the homepage map and
// card UI — it doesn't need the full listing record (description, phone,
// reviewsPerScore, mapsUrl, ids...). Trimming to just the fields that
// script actually reads cut this file from ~2.6MB to a fraction of that,
// which matters more than almost anything else here since it's fetched in
// full on every homepage/find visit before the map or results list can
// render at all. `hours` is back on the list — the homepage's "Open Now"
// carousel needs it client-side to compute open/closed live in the
// visitor's browser (there's no way to pre-render "open right now" at
// build time; it's true or false only at the moment someone loads the page).
const CLIENT_LISTING_FIELDS = [
  'slug', 'name', 'street', 'city', 'county', 'state', 'stateCode', 'postalCode',
  'lat', 'lng', 'rating', 'reviews', 'photo', 'features', 'featured', 'sample', 'url', 'hours',
];
const clientListings = listings.map((l) => {
  const out = {};
  for (const key of CLIENT_LISTING_FIELDS) if (l[key] != null) out[key] = l[key];
  return out;
});
writeFileSync(join(DIST, 'data/listings.json'), JSON.stringify({ listings: clientListings }, null, 0));

/* Lightweight index for the /search/ page: farms, states, attractions, guides. */
const searchIndex = [
  // The homepage map shows sample rows too (tagged), so search stays consistent
  // with it rather than with the sitemap, which excludes them from indexing.
  ...listings.map((l) => ({
    type: l.sample ? 'Farm (sample)' : 'Farm',
    name: l.name,
    place: [l.city, l.stateCode].filter(Boolean).join(', '),
    url: listingPath(l),
  })),
  ...stateNames.map((s) => ({
    type: 'State',
    name: s,
    place: `${(byState.get(s) || []).length} listings`,
    url: statePath(s),
  })),
  ...[...byCity.keys()].map((key) => {
    const [stateName, cityName] = key.split('|');
    return {
      type: 'Town',
      name: cityName,
      place: stateName,
      url: cityPath(stateName, cityName),
    };
  }),
  ...categories.map((c) => ({ type: 'Attraction', name: c.name, place: 'Browse by state', url: categoryPath(c) })),
  ...posts.map((p) => ({ type: 'Guide', name: p.meta.h1 || p.meta.title, place: 'Blog', url: p.meta.path })),
  ...authors.map((a) => ({ type: 'Author', name: a.name, place: a.title, url: authorPath(a) })),
];
writeFileSync(join(DIST, 'data/search-index.json'), JSON.stringify(searchIndex));

if (existsSync(join(SRC, 'static'))) {
  cpSync(join(SRC, 'static'), DIST, { recursive: true });
}

writeFileSync(
  join(DIST, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapEntries
  .map(
    (e) => `  <url>
    <loc>${SITE_URL}${e.path}</loc>
    <lastmod>${e.lastmod}</lastmod>
    <changefreq>${e.changefreq}</changefreq>
    <priority>${e.priority}</priority>
  </url>`
  )
  .join('\n')}
</urlset>
`
);

writeFileSync(
  join(DIST, 'robots.txt'),
  `User-agent: *
Allow: /

Sitemap: ${SITE_URL}/sitemap.xml
`
);

writeFileSync(join(DIST, 'ads.txt'), 'google.com, pub-9332749804326149, DIRECT, f08c47fec0942fa0\n');

writeFileSync(
  join(DIST, 'site.webmanifest'),
  JSON.stringify(
    {
      name: SITE_NAME,
      short_name: 'Pumpkin Patches',
      description: 'Find pumpkin patches near you across all 50 states.',
      start_url: '/',
      display: 'standalone',
      background_color: '#ffffff',
      theme_color: '#F26A21',
      icons: [
        { src: '/assets/img/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/assets/img/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    },
    null,
    2
  )
);

console.log(`Built ${sitemapEntries.length} indexable pages`);
console.log(
  `  static: ${staticPages.length}, posts: ${posts.length}, states: ${stateNames.length}, ` +
    `cities: ${byCity.size}, categories: ${categories.length}, listings: ${listings.length}`
);
if (sampleOnly) console.log('  note: dataset is sample-only — listing pages are noindex and excluded from sitemap.xml');
console.log(`Output: ${DIST}`);
