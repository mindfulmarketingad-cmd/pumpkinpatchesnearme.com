/**
 * Add u-pick berry and fruit farms to data/listings.json.
 *
 *   node scripts/import-berry-farms.mjs <listings.json> <listing-details.json>
 *
 * Selection (Farm or Orchard only):
 *   The name contains one of the target phrases as a whole word:
 *   strawberry, blueberry, blackberry, peach, cherry, berry, berries,
 *   pick-your-own, pick your own, u-pick, u pick.
 *   Whole words, so "Mayberry", "Cherrywood", and "raspberries" do not match
 *   on the letters buried inside another word. Closed businesses are dropped.
 *
 * Listings already in the directory (same place id, or same name + city +
 * state) are tagged into the section. Everyone else is appended.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { slugify, uniqueSlug } from './lib/listings.mjs';

const NAME_RE = /\b(?:strawberries|strawberry|blueberries|blueberry|blackberries|blackberry|peaches|peach|cherries|cherry|berries|berry|pick-your-own|pick your own|u-pick|u pick)\b/i;
const SECTION_FEATURE = 'Berry & fruit picking';
const PICK_RE = /\b(?:pick-your-own|pick your own|u-pick|u pick)\b/i;
const CROP_RULES = [
  [/\bstrawberries\b|\bstrawberry\b/i, 'Strawberries'],
  [/\bblueberries\b|\bblueberry\b/i, 'Blueberries'],
  [/\bblackberries\b|\bblackberry\b/i, 'Blackberries'],
  [/\bcherries\b|\bcherry\b/i, 'Cherries'],
  [/\bpeaches\b|\bpeach\b/i, 'Peaches'],
];
const EXTRA_FRUITS = [
  [/\bapples?\b/i, 'apples'],
  [/\braspberries\b|\braspberry\b/i, 'raspberries'],
  [/\bnectarines?\b/i, 'nectarines'],
  [/\bplums?\b/i, 'plums'],
  [/\bpears?\b/i, 'pears'],
  [/\bgrapes?\b/i, 'grapes'],
];
const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const [listingsPath, detailsPath, outPath] = process.argv.slice(2);
if (!listingsPath || !detailsPath) {
  console.error('Usage: node scripts/import-berry-farms.mjs <listings.json> <listing-details.json> [out.json]');
  process.exit(1);
}

const source = JSON.parse(readFileSync(listingsPath, 'utf8'));
const details = JSON.parse(readFileSync(detailsPath, 'utf8'));
const data = JSON.parse(readFileSync(outPath || 'data/listings.json', 'utf8'));

function component(comps, type) {
  return (comps || []).find((c) => Array.isArray(c.types) && c.types.includes(type)) || null;
}

function formatTime(hour, minute = 0) {
  const h = ((hour % 24) + 24) % 24;
  const suffix = h >= 12 ? 'PM' : 'AM';
  let hr = h % 12;
  if (hr === 0) hr = 12;
  if (!minute) return `${hr}${suffix}`;
  return `${hr}:${String(minute).padStart(2, '0')}${suffix}`;
}

function hoursFromDetails(detail) {
  const hours = detail?.regularOpeningHours;
  if (!hours) return null;
  const byDay = DAY_KEYS.map(() => []);
  let any = false;
  for (const period of hours.periods || []) {
    if (!period?.open || !Number.isInteger(period.open.day)) continue;
    any = true;
    const open = formatTime(period.open.hour || 0, period.open.minute || 0);
    let close = '';
    if (period.close && Number.isInteger(period.close.hour)) {
      close = formatTime(period.close.hour, period.close.minute || 0);
    }
    byDay[period.open.day].push(close ? `${open}-${close}` : open);
  }
  if (!any) return null;
  const out = {};
  DAY_KEYS.forEach((key, i) => {
    // Google's day index is Sunday = 0. Our object is keyed by day name.
    const googleIndex = i; // DAY_KEYS starts at sunday to match Google
    out[key] = byDay[googleIndex].length ? byDay[googleIndex].join(' / ') : 'Closed';
  });
  return out;
}

function hoursSentence(hours) {
  if (!hours) return '';
  const groups = [];
  for (let i = 0; i < 7; i++) {
    const key = DAY_KEYS[i];
    const value = hours[key] || 'Closed';
    const prev = groups[groups.length - 1];
    if (prev && prev.value === value) prev.end = i;
    else groups.push({ start: i, end: i, value });
  }
  const parts = groups.map((g) => {
    const days = g.start === g.end ? DAY_SHORT[g.start] : `${DAY_SHORT[g.start]}-${DAY_SHORT[g.end]}`;
    return `${days} ${g.value}`;
  });
  return `Published hours: ${parts.join(', ')}.`;
}

function featuresFor(name) {
  const features = [SECTION_FEATURE];
  for (const [re, label] of CROP_RULES) {
    if (re.test(name)) features.push(label);
  }
  if (PICK_RE.test(name)) features.push('Pick-your-own');
  return features;
}

function extraFruits(name) {
  return EXTRA_FRUITS.filter(([re]) => re.test(name)).map(([, label]) => label);
}

function joinAnd(items) {
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function describe(row, features, hours) {
  const kind = row.category === 'Orchard' ? 'orchard' : 'farm';
  const crops = features.filter((f) => f !== SECTION_FEATURE && f !== 'Pick-your-own').map((f) => f.toLowerCase());
  const extras = extraFruits(row.name).filter((fruit) => !crops.some((c) => c.startsWith(fruit.slice(0, 4))));
  const fruits = [...crops, ...extras];
  const pick = features.includes('Pick-your-own');
  const namedBerry = /\b(?:berries|berry)\b/i.test(row.name);
  let points;
  if (fruits.length && pick) points = `The name points to pick-your-own ${joinAnd(fruits)}.`;
  else if (fruits.length) points = `The name points to ${joinAnd(fruits)}.`;
  else if (namedBerry && pick) points = 'The name points to pick-your-own berries.';
  else if (namedBerry) points = 'The name points to berries.';
  else points = 'The name says pick-your-own and does not name a fruit.';
  const where = [row.city, row.state].filter(Boolean).join(', ');
  const rating = Number(row.rating);
  const reviews = Number(row.reviewCount);
  const reviewWord = reviews === 1 ? 'review' : 'reviews';
  const ratingBit = Number.isFinite(rating) && rating > 0
    ? ` It is listed at ${Math.round(rating * 10) / 10} on Google${Number.isFinite(reviews) && reviews > 0 ? ` from ${Math.round(reviews).toLocaleString('en-US')} ${reviewWord}` : ''}.`
    : '';
  const hoursBit = hours ? ` ${hoursSentence(hours)}` : ' Published hours were not on the record used here.';
  const article = kind === 'orchard' ? 'an' : 'a';
  const leadOptions = [
    `${row.name} is ${article} ${kind} in ${where}.`,
    `${row.name}, in ${where}, is listed as ${article} ${kind}.`,
    `Listed in ${where}, ${row.name} is ${article} ${kind}.`,
  ];
  let hash = 0;
  for (let i = 0; i < row.id.length; i++) hash = (hash * 31 + row.id.charCodeAt(i)) >>> 0;
  return `${leadOptions[hash % leadOptions.length]} ${points}${ratingBit}${hoursBit}`;
}

function streetFrom(comps) {
  const num = String(component(comps, 'street_number')?.shortText || '').trim();
  const route = String(component(comps, 'route')?.shortText || '').trim();
  // Some rural addresses put the road name in street_number as well as route.
  // Only prefix a value that actually starts with a number.
  if (/^\d/.test(num) && route) return `${num} ${route}`;
  return route || num || null;
}

function countyFrom(comps) {
  const name = component(comps, 'administrative_area_level_2')?.longText || '';
  if (/ County$/i.test(name)) return name.replace(/ County$/i, '');
  return null;
}

function phoneFrom(detail) {
  const intl = String(detail?.internationalPhoneNumber || '').trim();
  if (/^\+1\b/.test(intl)) return intl;
  const national = String(detail?.nationalPhoneNumber || '').trim();
  const digits = national.replace(/\D/g, '');
  if (digits.length === 10) return `+1 ${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+1 ${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  return null;
}

function mapsUrl(name, placeId) {
  const params = new URLSearchParams({
    api: '1',
    query: name,
    query_place_id: placeId,
  });
  return `https://www.google.com/maps/search/?${params.toString()}`;
}

// Re-runs replace listings this script added last time, instead of stacking copies.
data.listings = data.listings.filter((l) => !l.generatedDescription);

const byPlace = new Map(data.listings.filter((l) => l.placeId).map((l) => [l.placeId, l]));
const byNameCity = new Map();
for (const l of data.listings) {
  const key = `${(l.name || '').trim().toLowerCase()}|${(l.city || '').trim().toLowerCase()}|${(l.stateCode || '').trim().toUpperCase()}`;
  if (!byNameCity.has(key)) byNameCity.set(key, []);
  byNameCity.get(key).push(l);
}

const taken = new Set(data.listings.map((l) => l.slug));
const stats = {
  matched: 0,
  closed: 0,
  mergedPlaceId: 0,
  mergedNameCity: 0,
  added: 0,
  skippedNoGeo: 0,
  closedNames: [],
  merged: [],
};
const fresh = [];

for (const row of source.listings || []) {
  if (row.category !== 'Farm' && row.category !== 'Orchard') continue;
  if (!NAME_RE.test(row.name || '')) continue;
  const detail = details[row.id];
  const status = detail?.businessStatus || '';
  if (/CLOSED/i.test(status)) {
    stats.closed++;
    stats.closedNames.push(`${row.name} (${status})`);
    continue;
  }
  stats.matched++;
  const features = featuresFor(row.name);
  const idHit = byPlace.get(row.id);
  const nameKey = `${row.name.trim().toLowerCase()}|${(row.city || '').trim().toLowerCase()}|${(row.stateCode || '').toUpperCase()}`;
  const nameHit = (byNameCity.get(nameKey) || []).find((l) => l.placeId !== row.id);
  const existing = idHit || nameHit;
  if (existing) {
    if (!Array.isArray(existing.features)) existing.features = [];
    for (const feature of features) {
      if (!existing.features.includes(feature)) existing.features.push(feature);
    }
    if (idHit) stats.mergedPlaceId++;
    else stats.mergedNameCity++;
    stats.merged.push({
      how: idHit ? 'placeId' : 'name+city',
      name: row.name,
      city: row.city,
      stateCode: row.stateCode,
      slug: existing.slug,
    });
    continue;
  }

  const lat = Number(row.lat);
  const lng = Number(row.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    stats.skippedNoGeo++;
    continue;
  }
  const comps = detail?.addressComponents || [];
  const hours = hoursFromDetails(detail);
  const stateCode = String(row.stateCode || '').toUpperCase();
  const slug = uniqueSlug(slugify([row.name, row.city, stateCode].filter(Boolean).join(' ')), taken);
  const rating = Number(row.rating);
  const reviews = Number(row.reviewCount);
  const website = String(detail?.websiteUri || row.website || '').trim() || null;
  const postal = String(row.zip || component(comps, 'postal_code')?.longText || '').trim() || null;
  const formatted = String(detail?.formattedAddress || row.address || '').replace(/, USA$/, '').trim() || null;

  fresh.push({
    id: row.id,
    slug,
    name: row.name,
    category: row.category,
    description: describe(row, features, hours),
    street: streetFrom(comps),
    city: row.city || null,
    county: countyFrom(comps),
    state: row.state || null,
    stateCode: stateCode || null,
    postalCode: postal,
    fullAddress: formatted,
    lat,
    lng,
    phone: phoneFrom(detail),
    website,
    email: null,
    rating: Number.isFinite(rating) && rating > 0 ? Math.round(rating * 10) / 10 : null,
    reviews: Number.isFinite(reviews) && reviews > 0 ? Math.round(reviews) : null,
    reviewsPerScore: null,
    reviewTags: null,
    hours,
    photo: null,
    photosCount: null,
    mapsUrl: mapsUrl(row.name, row.id),
    placeId: row.id,
    features,
    season: null,
    admission: null,
    directions: null,
    payment: null,
    featured: false,
    sample: false,
    generatedDescription: true,
  });
}

fresh.sort((a, b) => (a.stateCode || '').localeCompare(b.stateCode || '') || (a.city || '').localeCompare(b.city || '') || a.name.localeCompare(b.name));
data.listings.push(...fresh);
data.count = data.listings.length;
stats.added = fresh.length;

const destination = outPath || 'data/listings.json';
writeFileSync(destination, `${JSON.stringify(data, null, 2)}\n`);
console.log(JSON.stringify(stats, null, 2));
