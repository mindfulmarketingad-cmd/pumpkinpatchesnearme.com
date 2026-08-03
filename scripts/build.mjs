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

/** Every listing image: the real photo when we have one, the illustrated
 *  placeholder when we don't — a listing never renders with no image. Google
 *  photo URLs occasionally 404 after the fact, so onerror swaps to the same
 *  placeholder client-side rather than leaving a broken-image icon. */
function listingImage(l, { alt, className = '', sizes = '' } = {}) {
  const src = l.photo || PLACEHOLDER_IMAGE;
  const altText = alt || `${l.name}${l.city ? ` in ${l.city}` : ''}`;
  return `<img class="${className}" src="${attr(src)}" alt="${attr(altText)}" loading="lazy" decoding="async"${sizes ? ` sizes="${attr(sizes)}"` : ''} onerror="this.onerror=null;this.src='${PLACEHOLDER_IMAGE}';">`;
}

/* ----------------------------------------------------------------- inputs */

const data = JSON.parse(readFileSync(join(ROOT, 'data/listings.json'), 'utf8'));
const listings = data.listings || [];
const faqs = JSON.parse(readFileSync(join(SRC, 'data/faqs.json'), 'utf8'));
const categories = JSON.parse(readFileSync(join(SRC, 'data/categories.json'), 'utf8'));
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

function joinNatural(words) {
  if (words.length <= 1) return words[0] || '';
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

// Cycles through a handful of sentence shapes so a page of 10 ranked farms
// doesn't read as the same template ten times in a row.
const BLURB_OPENERS = [
  (name, place) => `${name}${place ? ` in ${place}` : ''} takes the top spot`,
  (name, place) => `${name}${place ? `, out in ${place},` : ''} is next up`,
  (name, place) => `${name}${place ? ` near ${place}` : ''} rounds out this stretch of the list`,
  (name, place) => `Also worth the drive: ${name}${place ? ` in ${place}` : ''}`,
];

function blurbFor(l, rank, stateName) {
  const place = l.city && l.city !== stateName ? l.city : null;
  const opener = BLURB_OPENERS[rank % BLURB_OPENERS.length](esc(l.name), place ? esc(place) : null);

  const ratingClause = l.rating
    ? `, rated ${l.rating.toFixed(1)} out of 5${l.reviews ? ` from ${l.reviews.toLocaleString('en-US')} reviews` : ''}`
    : '';

  const features = (l.features || []).slice(0, 2).map((f) => esc(f.toLowerCase()));
  const featureSentence = features.length ? ` Visitors come here for ${joinNatural(features)}.` : '';
  const seasonSentence = l.season ? ` Typical season: ${esc(l.season)}.` : '';

  const featuredNote = l.featured ? ' This is a featured listing.' : '';

  return `${opener}${ratingClause}.${featureSentence}${seasonSentence}${featuredNote}`;
}

function renderListicleEntry(l, rank, stateName) {
  const place = [l.city, l.stateCode].filter(Boolean).join(', ');
  const tags = (l.features || []).slice(0, 4);
  return `<li class="listicle-item${l.featured ? ' is-featured' : ''}" id="${attr(l.slug)}">
  <span class="listicle-rank" aria-hidden="true">${rank}</span>
  <a class="listicle-media" href="${listingPath(l)}" tabindex="-1" aria-hidden="true">
    ${listingImage(l, { className: 'listicle-img', sizes: '(min-width: 640px) 180px, 100vw' })}
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
    <div class="card-actions">
      <a class="btn btn-primary btn-sm" href="${listingPath(l)}">View details</a>
      <a class="btn btn-outline btn-sm" href="https://www.google.com/maps/dir/?api=1&amp;destination=${l.lat},${l.lng}" target="_blank" rel="noopener nofollow">Directions</a>
    </div>
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
  const hoursSummary = l.hours
    ? DAYS.filter((d) => l.hours[d] && l.hours[d].toLowerCase() !== 'closed')
        .map((d) => `${d[0].toUpperCase()}${d.slice(1)} ${l.hours[d]}`)
        .join(', ')
    : '';

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
  const navKeys = ['home', 'blog', 'about', 'find', 'partners'];
  let html = template;

  const banner = sampleOnly && meta.path === '/'
    ? `<div class="data-banner">Preview mode: this directory is running on placeholder listings. Import your Outscraper export to publish live data. <a href="/contact/">Add a real patch</a></div>`
    : '';

  const replacements = {
    '{{TITLE}}': esc(meta.title),
    '{{DESCRIPTION}}': attr(meta.description),
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
const addToSitemap = (path, priority, changefreq) =>
  sitemapEntries.push({ path, priority, changefreq });

/* --- blog posts ---------------------------------------------------------- */

const posts = readPageFiles(join(SRC, 'pages/blog'))
  .map((p) => ({ ...p, meta: { ...p.meta, path: `/blog/${p.meta.slug}/` } }))
  .sort((a, b) => (b.meta.date || '').localeCompare(a.meta.date || ''));

for (const post of posts) {
  const meta = {
    ...post.meta,
    nav: 'blog',
    layout: 'prose',
    ogType: 'article',
    trail: [{ label: 'Blog', href: '/blog/' }, { label: post.meta.h1 || post.meta.title }],
  };
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
        image: `${SITE_URL}/assets/img/og-image.png`,
        author: { '@type': 'Organization', name: SITE_NAME, url: SITE_URL },
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
  const dateLine = post.meta.date
    ? `<p class="post-meta">Published ${new Date(`${post.meta.date}T12:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })}</p>`
    : '';
  writePage(meta.path, render(meta, dateLine + post.body, { jsonld }));
  addToSitemap(meta.path, '0.6', 'monthly');
}

const blogTeasers = posts
  .map(
    (p) => `<article class="post-item">
  <h3><a href="/blog/${p.meta.slug}/">${esc(p.meta.h1 || p.meta.title)}</a></h3>
  <p class="post-meta">${p.meta.date ? new Date(`${p.meta.date}T12:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) : ''}${p.meta.readingTime ? ` &middot; ${esc(p.meta.readingTime)}` : ''}</p>
  <p>${esc(p.meta.excerpt || p.meta.description)}</p>
  <a class="btn btn-outline btn-sm" href="/blog/${p.meta.slug}/">Read the guide</a>
</article>`
  )
  .join('\n');

/* --- static pages -------------------------------------------------------- */

const featured = [...listings]
  .filter((l) => l.rating)
  .sort((a, b) => (b.rating || 0) * Math.log10((b.reviews || 1) + 1) - (a.rating || 0) * Math.log10((a.reviews || 1) + 1))
  .slice(0, 6);

const staticPages = readPageFiles(join(SRC, 'pages'));

const tokens = {
  '{{FAQ}}': renderFaqHtml(faqs),
  '{{STATE_GRID}}': renderStateGrid(),
  '{{BLOG_TEASERS}}': blogTeasers,
  '{{FEATURED_CARDS}}': featured.map((l) => renderCard(l)).join('\n'),
  '{{STAT_LISTINGS}}': stats.listings.toLocaleString('en-US'),
  '{{STAT_STATES}}': String(stats.states),
  '{{STAT_CITIES}}': String(stats.cities),
  '{{CONTACT_EMAIL}}': CONTACT_EMAIL,
  '{{BUILD_DATE}}': new Date(`${BUILD_DATE}T12:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }),
  '{{SITEMAP_STATES}}': stateNames
    .map((s) => `<li><a href="${statePath(s)}">Pumpkin patches in ${esc(s)}</a></li>`)
    .join('\n'),
  '{{SITEMAP_POSTS}}': posts
    .map((p) => `<li><a href="/blog/${p.meta.slug}/">${esc(p.meta.h1 || p.meta.title)}</a></li>`)
    .join('\n'),
  '{{CATEGORY_GRID}}': renderCategoryGrid(),
  '{{SITEMAP_CATEGORIES}}': categories
    .map((c) => `<li><a href="${categoryPath(c)}">${esc(c.name)} near me</a></li>`)
    .join('\n'),
  '{{FEATURED_FARM_CARDS}}': featuredListings.length
    ? `<div class="grid grid-3">\n${featuredListings.map((l) => renderCard(l)).join('\n')}\n</div>`
    : `<div class="empty-state">
  <h3>No featured farms yet this season</h3>
  <p>Featured placement opens ahead of each fall season. If you run a pumpkin patch and want the top of your state and metro results, we would like to hear from you.</p>
  <a class="btn btn-primary" href="/contact/">Request featured pricing</a>
</div>`,
  '{{SEASON_YEAR}}': String(SEASON_YEAR),
};

function expandTokens(html) {
  let out = html;
  for (const [token, value] of Object.entries(tokens)) out = out.split(token).join(value);
  return out;
}

for (const page of staticPages) {
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
  addToSitemap(meta.path, meta.path === '/' ? '1.0' : '0.7', meta.path === '/' ? 'daily' : 'monthly');
}

/* --- state pages --------------------------------------------------------- */

for (const stateName of stateNames) {
  // stateNames is derived from byState's own keys, so every state reached
  // here has at least one listing — no empty-state branch needed.
  const items = byState.get(stateName);
  const path = statePath(stateName);
  const cities = [...new Set(items.map((l) => l.city).filter(Boolean))].sort();
  const rankedCount = Math.min(10, items.length);
  const ranked = items.slice(0, rankedCount);
  const rest = items.slice(rankedCount);

  const meta = {
    path,
    title: `The ${rankedCount} Best Pumpkin Patches in ${stateName} (${SEASON_YEAR})`,
    description: `Ranked: the best pumpkin patches in ${stateName}, with ratings, addresses, hours and directions. ${items.length} listing${items.length === 1 ? '' : 's'} total, updated for ${SEASON_YEAR}.`,
    h1: `The ${rankedCount} Best Pumpkin Patches in ${stateName}`,
    lede: `Ranked by rating and review volume across ${cities.length} ${cities.length === 1 ? 'town' : 'towns'} in ${stateName}${rest.length ? `, plus ${rest.length} more listing${rest.length === 1 ? '' : 's'} below` : ''}. Always confirm hours before you drive out — most patches open late September and close in early November.`,
    nav: 'find',
    layout: 'wide',
    trail: [{ label: 'Find', href: '/find/' }, { label: stateName }],
  };

  const tocSection = ranked.length > 3
    ? `<p class="listicle-toc"><strong>Jump to:</strong> ${ranked
        .map((l, i) => `<a href="#${attr(l.slug)}">${i + 1}. ${esc(l.name)}</a>`)
        .join(' <span aria-hidden="true">&middot;</span> ')}</p>`
    : '';

  const rankedSection = `${tocSection}
<ol class="listicle">
${ranked.map((l, i) => renderListicleEntry(l, i + 1, stateName)).join('\n')}
</ol>`;

  const restSection = rest.length
    ? `<h2>More pumpkin patches in ${esc(stateName)}</h2>
<div class="grid grid-3">
${rest.map((l) => renderCard(l, { showState: false, headingLevel: 2 })).join('\n')}
</div>`
    : '';

  const citySection = cities.length
    ? `<h2>Pumpkin patches by town in ${esc(stateName)}</h2>
<p>Pick a town to see just the farms there.</p>
${renderCityLinks(stateName)}`
    : '';

  const catSection = (() => {
    const present = categories
      .map((c) => ({ c, n: items.filter((l) => (l.features || []).includes(c.feature)).length }))
      .filter((x) => x.n > 0);
    if (!present.length) return '';
    return `<h2>${esc(stateName)} farms by attraction</h2>
<div class="tag-row">
${present.map(({ c, n }) => `  <a class="tag tag-link" href="${categoryPath(c)}">${esc(c.name)} (${n})</a>`).join('\n')}
</div>`;
  })();

  const body = `${renderScopedMap(items, `${rankedSection}${restSection ? `\n${restSection}` : ''}`)}
<div class="section" style="padding-bottom:0">
${citySection}
${catSection}
<h2>Planning a ${esc(stateName)} pumpkin patch trip</h2>
<p>Pumpkin patch season in ${esc(stateName)} generally runs from mid-September through the first weekend of November, with the busiest weekends falling in mid-October. Weekday mornings are the quietest time to visit, and many farms charge admission only on weekends when the corn maze, hayrides and food stands are all running.</p>
<p>Bring cash — plenty of family farms still run cash-only gates or wagon rides — and check whether the patch charges by the pumpkin, by the pound or as a flat admission. Call ahead after heavy rain, since field access is the first thing farms close.</p>
<p><a class="btn btn-outline" href="/">Search the ${esc(stateName)} map</a></p>
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

  writePage(path, render(meta, body, { jsonld, scripts: items.length ? pageMapScripts : '' }));
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

  const rankedCount = Math.min(10, items.length);
  const ranked = items.slice(0, rankedCount);
  const rest = items.slice(rankedCount);

  const meta = {
    path,
    title: `The ${rankedCount} Best Pumpkin Patches in ${label} (${SEASON_YEAR})`,
    description: `Ranked: the best pumpkin patches near ${label}, with ratings, addresses, hours and directions. ${items.length} listing${items.length === 1 ? '' : 's'} total, updated for ${SEASON_YEAR}.`,
    h1: `The ${rankedCount} Best Pumpkin Patches in ${label}`,
    lede: `Ranked by rating and review volume${rest.length ? `, plus ${rest.length} more listing${rest.length === 1 ? '' : 's'} below` : ''}. Updated for the ${SEASON_YEAR} season — always confirm hours with the farm before you drive out.`,
    nav: 'find',
    layout: 'wide',
    trail: [
      { label: 'Find', href: '/find/' },
      { label: stateName, href: statePath(stateName) },
      { label: cityName },
    ],
  };

  const siblings = citiesInState(stateName).filter((c) => c !== cityName);

  const tocSection = ranked.length > 3
    ? `<p class="listicle-toc"><strong>Jump to:</strong> ${ranked
        .map((l, i) => `<a href="#${attr(l.slug)}">${i + 1}. ${esc(l.name)}</a>`)
        .join(' <span aria-hidden="true">&middot;</span> ')}</p>`
    : '';

  const rankedSection = `${tocSection}
<ol class="listicle">
${ranked.map((l, i) => renderListicleEntry(l, i + 1, cityName)).join('\n')}
</ol>`;

  const restSection = rest.length
    ? `<h2>More pumpkin patches near ${esc(cityName)}</h2>
<div class="grid grid-3">
${rest.map((l) => renderCard(l, { showState: false, showCity: false, headingLevel: 2 })).join('\n')}
</div>`
    : '';

  const body = `${renderScopedMap(items, `${rankedSection}${restSection ? `\n${restSection}` : ''}`)}

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

  writePage(path, render(meta, body, { jsonld, scripts: pageMapScripts }));
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
    nav: 'find',
    layout: 'wide',
    trail: [{ label: 'Find', href: '/find/' }, { label: cat.name }],
  };

  const topItems = items.slice(0, 24);

  const body = `${cat.intro}

${items.length ? `<h2>Top-rated farms with a ${esc(cat.singular)}</h2>
<div class="grid grid-3">
${topItems.map((l) => renderCard(l)).join('\n')}
</div>
${items.length > topItems.length ? `<p style="color:var(--muted)">Showing ${topItems.length} of ${items.length.toLocaleString('en-US')} farms. <a href="/">Search the map</a> and filter by ${esc(cat.name.toLowerCase())} to see them all near you.</p>` : ''}` : `<div class="empty-state">
  <h3>No ${esc(cat.name.toLowerCase())} listed yet</h3>
  <p>We are still building out this category. If you know a farm that should be here, send it to us.</p>
  <a class="btn btn-primary" href="/add-a-listing/">Submit a farm</a>
</div>`}

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
    <a class="btn btn-outline" href="/find/">Browse all attractions</a>
  </p>
</div>`;

  const jsonld = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'CollectionPage', name: cat.title, description: cat.description, url: SITE_URL + path },
      {
        '@type': 'ItemList',
        numberOfItems: items.length,
        itemListElement: topItems.map((l, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          url: SITE_URL + listingPath(l),
          name: l.name,
        })),
      },
      breadcrumbJsonLd(meta.trail, path),
    ],
  };

  writePage(path, render(meta, body, { jsonld }));
  addToSitemap(path, '0.8', 'weekly');
}

/* --- listing detail pages ------------------------------------------------ */

for (const l of listings) {
  const path = listingPath(l);
  const place = [l.city, l.stateCode].filter(Boolean).join(', ');
  const meta = {
    path,
    title: `${l.name}${place ? ` — ${place}` : ''} | Pumpkin Patch Near Me`,
    description:
      l.description ||
      `${l.name} is a pumpkin patch${place ? ` in ${place}` : ''}. See the address, hours, rating and directions before you visit.`,
    h1: l.name,
    lede: place ? `Pumpkin patch in ${place}` : 'Pumpkin patch',
    nav: 'find',
    layout: 'wide',
    noindex: Boolean(l.sample),
    trail: [
      { label: 'Find', href: '/find/' },
      ...(l.state ? [{ label: l.state, href: statePath(l.state) }] : []),
      ...(l.state && l.city ? [{ label: l.city, href: cityPath(l.state, l.city) }] : []),
      { label: l.name },
    ],
  };

  // Other farms in the same town, so every listing page has somewhere to go next.
  const nearby = (byCity.get(`${l.state}|${l.city}`) || []).filter((o) => o.slug !== l.slug).slice(0, 3);

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
  ${listingImage(l, { className: 'detail-hero-img', sizes: '(min-width: 900px) 900px, 100vw' })}
  <figcaption>${l.photo ? `Photo of ${esc(l.name)} via Google` : `Illustration — a real photo is not yet available for ${esc(l.name)}`}</figcaption>
</figure>
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
    <p style="font-size:0.85rem;color:var(--muted);margin-top:0.75rem">Listing details come from public business data and may be out of date. <a href="/contact/">Report a correction</a> or <a href="/add-a-listing/">claim this listing</a>.</p>
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
writeFileSync(join(DIST, 'data/listings.json'), JSON.stringify({ ...data, listings }, null, 0));

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
    <lastmod>${BUILD_DATE}</lastmod>
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
