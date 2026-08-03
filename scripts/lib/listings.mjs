/** Shared helpers for listing data: slugs, states, normalisation. */

export const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

export const STATE_CODE_BY_NAME = Object.fromEntries(
  Object.entries(STATES).map(([code, name]) => [name.toLowerCase(), code])
);

export const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

export function slugify(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

/** Ensures slugs stay unique across the dataset. */
export function uniqueSlug(base, taken) {
  let slug = base || 'pumpkin-patch';
  let n = 2;
  while (taken.has(slug)) slug = `${base}-${n++}`;
  taken.add(slug);
  return slug;
}

export function resolveStateCode(stateRaw, usStateRaw) {
  const raw = String(usStateRaw || stateRaw || '').trim();
  if (!raw) return '';
  const upper = raw.toUpperCase();
  if (STATES[upper]) return upper;
  return STATE_CODE_BY_NAME[raw.toLowerCase()] || '';
}

const PLACEHOLDER_VALUES = new Set(['none', 'n/a', 'na', 'null', 'undefined', '-', '--']);

/**
 * Outscraper fills empty fields with literal placeholder text ("None" is by
 * far the most common, e.g. ~90% of `county` values in a typical export)
 * rather than leaving the cell blank. Trims and maps those to null so they
 * don't get published as if they were real data.
 */
export function cleanField(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed || PLACEHOLDER_VALUES.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

/** Great-circle distance in miles. */
export function distanceMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Outscraper exports working hours as a JSON-ish string, e.g.
 * {"Monday":"9AM-6PM","Tuesday":"Closed"}. Normalise to lowercase day keys.
 */
export function parseWorkingHours(value) {
  if (!value) return null;
  if (typeof value === 'object') return normaliseHourKeys(value);
  const text = String(value).trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text.replace(/'/g, '"'));
    if (parsed && typeof parsed === 'object') return normaliseHourKeys(parsed);
  } catch {
    /* fall through to the plain-text form */
  }
  return null;
}

function normaliseHourKeys(obj) {
  const out = {};
  for (const [key, val] of Object.entries(obj)) {
    const day = String(key).trim().toLowerCase();
    if (!DAYS.includes(day)) continue;
    // Outscraper gives each day as an array — usually one window ("10AM-6PM"),
    // occasionally several (a lunch break, or a farm open only for timed
    // sessions) — joined here rather than left as a comma-run from a bare
    // String(array) cast.
    out[day] = Array.isArray(val) ? val.map((v) => String(v).trim()).join(' / ') : String(val).trim();
  }
  return Object.keys(out).length ? out : null;
}

const FEATURE_RULES = [
  [/corn\s*maze/i, 'Corn maze'],
  [/hay\s*ride|wagon\s*ride/i, 'Hayrides'],
  [/u-?pick|pick[- ]your[- ]own|pick your own/i, 'U-pick pumpkins'],
  [/petting|animal/i, 'Petting zoo'],
  [/apple/i, 'Apple picking'],
  [/sunflower/i, 'Sunflower field'],
  [/cider|donut/i, 'Cider and donuts'],
  [/haunt|ghost|spook/i, 'Haunted attraction'],
  [/festival/i, 'Fall festival'],
  [/market|farm\s*stand|store/i, 'Farm store'],
  [/play|playground|kids/i, 'Kids play area'],
  [/food truck|concession|snack/i, 'Food and drinks'],
];

/** Derives visitor-facing feature tags from free-text fields. */
export function deriveFeatures(...texts) {
  const haystack = texts.filter(Boolean).join(' ');
  const found = new Set();
  for (const [pattern, label] of FEATURE_RULES) {
    if (pattern.test(haystack)) found.add(label);
  }
  return [...found];
}

/**
 * Outscraper puts structured attributes in an `about` column as nested JSON,
 * e.g. {"Payments":{"Credit cards":true,"Cash only":false}}. Pull out the
 * accepted payment methods so listings can show them the way visitors ask.
 */
export function parsePayments(value) {
  if (!value) return null;
  let obj = value;
  if (typeof value === 'string') {
    try {
      obj = JSON.parse(value.replace(/'/g, '"'));
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const group = obj.Payments || obj.payments;
  if (!group || typeof group !== 'object') return null;
  const accepted = Object.entries(group)
    .filter(([, on]) => on === true)
    .map(([label]) => label.trim());
  return accepted.length ? accepted : null;
}

/** Final shape consumed by the site build and the front-end map. */
export function normaliseListing(input, taken) {
  const stateCode = resolveStateCode(input.state, input.us_state || input.state_code);
  const city = cleanField(input.city) || '';
  const name = String(input.name || '').trim();
  if (!name) return null;

  const lat = Number(input.lat ?? input.latitude);
  const lng = Number(input.lng ?? input.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const slug = uniqueSlug(
    slugify([name, city, stateCode].filter(Boolean).join(' ')),
    taken
  );

  const rating = Number(input.rating);
  const reviews = Number(input.reviews);

  return {
    id: String(input.place_id || input.google_id || slug),
    slug,
    name,
    category: String(input.category || input.type || 'Pumpkin patch').trim(),
    description: String(input.description || '').trim() || null,
    street: cleanField(input.street),
    city: city || null,
    county: cleanField(input.county || input.borough),
    state: STATES[stateCode] || cleanField(input.state) || null,
    stateCode: stateCode || null,
    postalCode: cleanField(input.postal_code || input.postalCode),
    fullAddress: cleanField(input.full_address),
    lat,
    lng,
    phone: cleanField(input.phone),
    website: cleanField(input.site || input.website),
    email: cleanField(input.email_1 || input.email),
    rating: Number.isFinite(rating) && rating > 0 ? Math.round(rating * 10) / 10 : null,
    reviews: Number.isFinite(reviews) && reviews > 0 ? Math.round(reviews) : null,
    hours: parseWorkingHours(input.working_hours || input.hours),
    photo: String(input.photo || '').trim() || null,
    mapsUrl: String(input.location_link || input.mapsUrl || '').trim() || null,
    placeId: String(input.place_id || '').trim() || null,
    features:
      Array.isArray(input.features) && input.features.length
        ? input.features
        : deriveFeatures(name, input.description, input.subtypes, input.category, input.type),
    // Owner-supplied extras. Outscraper rarely carries these, so they stay null
    // until a farm sends them in; the listing page hides whatever is missing.
    season: String(input.season || '').trim() || null,
    admission: String(input.admission || '').trim() || null,
    directions: String(input.directions || '').trim() || null,
    payment: Array.isArray(input.payment) ? input.payment : parsePayments(input.about),
    featured: Boolean(input.featured),
    sample: Boolean(input.sample),
  };
}
