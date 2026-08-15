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
    ${businessSummaryHtml(l, rank, stateName)}
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
function renderScopedMap(items, listHtml) {
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
  <p class="page-toggle-label">${mappable.length.toLocaleString('en-US')} pumpkin patch${mappable.length === 1 ? '' : 'es'} on this page</p>
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
}

/* --- one-off: "10 Best Pumpkin Fields in Georgia" ------------------------
   Hand-requested post, not a generic per-state loop like the one above —
   uses the heavier renderListicleEntry format (H2 business names, full
   500-word summaries, address and tags) that the city and attraction posts
   use, rather than the lighter pillar-entry cards. */
{
  const stateName = 'Georgia';
  const stateItems = byState.get(stateName) || [];
  const seenGaNames = new Set();
  const gaDistinct = stateItems.filter((l) => {
    const key = l.name.trim().toLowerCase();
    if (seenGaNames.has(key)) return false;
    seenGaNames.add(key);
    return true;
  });
  const top10 = gaDistinct.slice(0, 10);
  const names = top10.map((l) => l.name);
  const gaAuthorSlug = authors[0].slug;
  const h1 = '10 Best Pumpkin Fields in Georgia';
  const slug = slugify(h1);
  const path = `/blog/${slug}/`;

  const heroSrc = (top10.find((l) => l.photo) || {}).photo || PLACEHOLDER_IMAGE;
  const heroHtml = blogHeroFigureHtml(heroSrc, `Pumpkin fields in ${stateName}`);

  const tocSection = `<p class="listicle-toc"><strong>Jump to:</strong> ${top10
    .map((l, i) => `<a href="#${attr(l.slug)}">${i + 1}. ${esc(l.name)}</a>`)
    .join(' <span aria-hidden="true">&middot;</span> ')}</p>`;

  const linkedNames = top10.map((l) => `<a href="${listingPath(l)}">${esc(l.name)}</a>`);
  const summaryIntro = `<p>The 10 best pumpkin fields in Georgia are ${joinNatural(linkedNames)}, ranked by rating and review volume out of the ${esc(stateItems.length.toLocaleString('en-US'))} pumpkin patches we track statewide. Below, each field gets a closer look — what it offers, how it's rated, and how to get there — followed by a table of contents' worth of jumping-off points and answers to the questions we hear most about visiting a Georgia pumpkin field. Want the complete, searchable list? See every pumpkin patch we track in <a href="${statePath(stateName)}">${esc(stateName)}</a>, or start from our <a href="/pumpkin-patches/">state-by-state directory</a>.</p>`;

  const listicleHtml = `<ol class="listicle">
${top10.map((l, i) => renderListicleEntry(l, i + 1, stateName)).join('\n')}
</ol>`;

  const kidFriendlyGa = top10.filter((l) => (l.features || []).some((f) => ['Petting zoo', 'Kids play area'].includes(f)));
  const kidAnswerGa = kidFriendlyGa.length
    ? `${joinNatural(kidFriendlyGa.map((l) => esc(l.name)))} ${kidFriendlyGa.length === 1 ? 'stands' : 'stand'} out for younger children on this list, with a petting zoo or a dedicated play area. Hours and what's running can change week to week, so confirm directly before you go.`
    : `None of the fields on this list are tagged with a dedicated kids' play area or petting zoo in our data, though most pumpkin fields are stroller- and toddler-friendly at a basic level. Call ahead if young kids need specific attractions.`;

  const faqQa = [
    {
      q: 'What is the highest-rated pumpkin field in Georgia?',
      a: `${esc(top10[0].name)}${top10[0].city ? ` in ${esc(top10[0].city)}` : ''} tops this list${top10[0].rating ? `, rated ${top10[0].rating.toFixed(1)} out of 5${top10[0].reviews ? ` from ${top10[0].reviews.toLocaleString('en-US')} reviews` : ''}` : ''}. Ratings reflect public data at the time of writing and can shift over time.`,
    },
    {
      q: 'When do pumpkin fields in Georgia open for the season?',
      a: 'Most Georgia pumpkin fields open in mid-to-late September and run through the first days of November, though exact dates shift year to year with weather and how the pumpkin crop comes in. Check the individual listings above, or call ahead, to confirm current dates.',
    },
    {
      q: 'How much does it cost to visit a pumpkin field in Georgia?',
      a: 'It varies by farm. Some charge only for the pumpkins you pick, priced individually or by weight; others charge a flat gate admission that bundles in attractions like a corn maze or hayride. See the admission details on each listing above where we have them, or call the farm directly.',
    },
    { q: 'Which Georgia pumpkin field is best for young kids?', a: kidAnswerGa },
    {
      q: 'Are Georgia pumpkin fields open on weekdays?',
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
<p>${esc(top10[0].name)} tops our list of Georgia pumpkin fields${top10[0].rating ? `, rated ${top10[0].rating.toFixed(1)} out of 5` : ''}, with ${joinNatural(names.slice(1).map((n) => esc(n)))} rounding out the top ten. Ratings and review counts reflect public data at the time of writing and can change, and hours, admission and what's actually running on a given day can vary week to week during the season — always confirm with the field directly before you drive out. For the full, ranked, searchable list, see every <a href="${statePath(stateName)}">pumpkin patch we track in ${esc(stateName)}</a>.</p>`;

  const body = `${tocSection}
${summaryIntro}
${listicleHtml}
${conclusion}
${faqHtml}`;

  const description = `The 10 best pumpkin fields in Georgia, ranked by rating and reviews: ${joinNatural(names)}.`;
  const postMeta = {
    path,
    slug,
    title: `${h1} | Ranked by Rating`,
    description,
    h1,
    excerpt: description,
    date: backdatedPostDate(slug),
    readingTime: '9 min read',
    author: gaAuthorSlug,
  };

  const meta = {
    ...postMeta,
    nav: 'blog',
    layout: 'prose',
    ogType: 'article',
    trail: [{ label: 'Blog', href: '/blog/' }, { label: h1 }],
  };
  const gaAuthor = authorsBySlug.get(gaAuthorSlug);
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
        author: gaAuthor
          ? { '@type': 'Person', name: gaAuthor.name, url: SITE_URL + authorPath(gaAuthor), jobTitle: gaAuthor.title }
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
  const byline = renderByline(gaAuthorSlug, postMeta.date, postMeta.readingTime);
  writePage(path, render(meta, heroHtml + byline + injectInArticleAd(body), { jsonld }));
  addToSitemap(path, '0.6', 'weekly', postMeta.date);
  handAuthoredPosts.push({ meta: postMeta, body });
}

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
  writePage(path, render(meta, heroHtml + byline + injectInArticleAd(body), { jsonld }));
  addToSitemap(path, '0.6', 'weekly', postMeta.date);
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
    writePage(path, render(meta, heroHtml + byline + injectInArticleAd(body), { jsonld }));
    addToSitemap(path, '0.6', 'weekly', postMeta.date);
  }
}

// Hand-authored guides and both flavors of programmatic city listicles share
// one feed from here on — the blog index, XML/HTML sitemaps and search index
// all read from `posts` and don't need to know which kind a given entry is.
const posts = [...handAuthoredPosts, ...pillarPosts, ...statePosts, ...cityPosts, ...attractionCityPosts].sort((a, b) => (b.meta.date || '').localeCompare(a.meta.date || ''));

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

const featured = [...listings]
  .filter((l) => l.rating)
  .sort((a, b) => (b.rating || 0) * Math.log10((b.reviews || 1) + 1) - (a.rating || 0) * Math.log10((a.reviews || 1) + 1))
  .slice(0, 6);

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
  '{{FEATURED_CARDS}}': featured.map((l) => renderCard(l)).join('\n'),
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

  const meta = {
    path,
    title: `${items.length} ${patchWord(items.length)} in ${stateName}, Ranked (${SEASON_YEAR})`,
    description: `Every pumpkin patch we track in ${stateName} — ${items.length} listing${items.length === 1 ? '' : 's'} across ${cities.length} ${cities.length === 1 ? 'town' : 'towns'}, ranked by rating, with search and filter. Updated for ${SEASON_YEAR}.`,
    h1: `${items.length} ${patchWord(items.length)} in ${stateName}`,
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
${presentCategories.map(({ c, n }) => `  <a class="tag tag-link" href="${categoryPath(c)}">${esc(c.name)} (${n})</a>`).join('\n')}
</div>`
    : '';

  const body = `${renderScopedMap(items, listHtml)}
<div class="section" style="padding-bottom:0">
${citySection}
${catSection}
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
${featureCounts.map(({ c, n }) => `    <a class="tag tag-link" href="${categoryPath(c)}">${esc(c.name)} (${n})</a>`).join('\n')}
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
    description: cat.description,
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

  const body = `${catHeroHtml}
${cat.intro}

${renderScopedMap(items, listHtml)}

<div class="section" style="padding-bottom:0">
  ${statesWith.length ? `<h2>${esc(cat.name)} by state</h2>
  <div class="state-grid">
${statesWith
  .map((s) => {
    const n = items.filter((l) => l.state === s).length;
    return `    <a class="state-link" href="${statePath(s)}">${esc(s)} <span>${n}</span></a>`;
  })
  .join('\n')}
  </div>` : ''}

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
// card UI — it doesn't need the full listing record (hours, description,
// phone, reviewsPerScore, mapsUrl, ids...). Trimming to just the fields
// that script actually reads cut this file
// from ~2.6MB to a fraction of that, which matters more than almost
// anything else here since it's fetched in full on every homepage/find
// visit before the map or results list can render at all.
const CLIENT_LISTING_FIELDS = [
  'slug', 'name', 'street', 'city', 'county', 'state', 'stateCode', 'postalCode',
  'lat', 'lng', 'rating', 'reviews', 'photo', 'features', 'featured', 'sample', 'url',
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
