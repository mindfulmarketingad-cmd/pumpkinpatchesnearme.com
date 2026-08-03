/**
 * Builds a placeholder dataset so the directory is fully browsable before the
 * real Outscraper export lands. Every row is flagged `sample: true`; the build
 * marks those pages noindex and keeps them out of sitemap.xml, and the site
 * shows a banner while any sample rows remain.
 *
 * Replace it for real with:  node scripts/import-outscraper.mjs export.csv
 *
 *   node scripts/make-sample-data.mjs
 */
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATES, slugify, uniqueSlug } from './lib/listings.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// One anchor metro per state: [stateCode, city, postalCode, lat, lng, areaCode]
const ANCHORS = [
  ['AL', 'Huntsville', '35801', 34.730, -86.586, '256'],
  ['AK', 'Anchorage', '99501', 61.217, -149.900, '907'],
  ['AZ', 'Phoenix', '85004', 33.448, -112.074, '602'],
  ['AR', 'Little Rock', '72201', 34.746, -92.289, '501'],
  ['CA', 'Sacramento', '95814', 38.582, -121.494, '916'],
  ['CO', 'Denver', '80202', 39.739, -104.990, '303'],
  ['CT', 'Hartford', '06103', 41.764, -72.685, '860'],
  ['DE', 'Dover', '19901', 39.158, -75.524, '302'],
  ['FL', 'Orlando', '32801', 28.538, -81.379, '407'],
  ['GA', 'Atlanta', '30303', 33.749, -84.388, '404'],
  ['HI', 'Honolulu', '96813', 21.307, -157.858, '808'],
  ['ID', 'Boise', '83702', 43.615, -116.202, '208'],
  ['IL', 'Springfield', '62701', 39.798, -89.644, '217'],
  ['IN', 'Indianapolis', '46204', 39.768, -86.158, '317'],
  ['IA', 'Des Moines', '50309', 41.586, -93.625, '515'],
  ['KS', 'Topeka', '66603', 39.048, -95.678, '785'],
  ['KY', 'Lexington', '40507', 38.040, -84.503, '859'],
  ['LA', 'Baton Rouge', '70802', 30.451, -91.187, '225'],
  ['ME', 'Portland', '04101', 43.659, -70.257, '207'],
  ['MD', 'Frederick', '21701', 39.414, -77.410, '301'],
  ['MA', 'Worcester', '01608', 42.263, -71.802, '508'],
  ['MI', 'Grand Rapids', '49503', 42.963, -85.668, '616'],
  ['MN', 'Minneapolis', '55401', 44.978, -93.265, '612'],
  ['MS', 'Jackson', '39201', 32.299, -90.185, '601'],
  ['MO', 'Columbia', '65201', 38.951, -92.334, '573'],
  ['MT', 'Bozeman', '59715', 45.680, -111.038, '406'],
  ['NE', 'Lincoln', '68508', 40.813, -96.708, '402'],
  ['NV', 'Reno', '89501', 39.530, -119.814, '775'],
  ['NH', 'Concord', '03301', 43.208, -71.538, '603'],
  ['NJ', 'Trenton', '08608', 40.217, -74.743, '609'],
  ['NM', 'Albuquerque', '87102', 35.084, -106.651, '505'],
  ['NY', 'Rochester', '14604', 43.161, -77.611, '585'],
  ['NC', 'Raleigh', '27601', 35.779, -78.638, '919'],
  ['ND', 'Fargo', '58102', 46.877, -96.789, '701'],
  ['OH', 'Columbus', '43215', 39.961, -82.999, '614'],
  ['OK', 'Oklahoma City', '73102', 35.467, -97.516, '405'],
  ['OR', 'Portland', '97204', 45.515, -122.678, '503'],
  ['PA', 'Lancaster', '17602', 40.038, -76.305, '717'],
  ['RI', 'Providence', '02903', 41.824, -71.413, '401'],
  ['SC', 'Columbia', '29201', 34.001, -81.035, '803'],
  ['SD', 'Sioux Falls', '57104', 43.546, -96.731, '605'],
  ['TN', 'Nashville', '37203', 36.166, -86.784, '615'],
  ['TX', 'Fredericksburg', '78624', 30.275, -98.872, '830'],
  ['UT', 'Salt Lake City', '84101', 40.761, -111.891, '801'],
  ['VT', 'Burlington', '05401', 44.476, -73.212, '802'],
  ['VA', 'Charlottesville', '22902', 38.030, -78.479, '434'],
  ['WA', 'Spokane', '99201', 47.659, -117.426, '509'],
  ['WV', 'Charleston', '25301', 38.350, -81.633, '304'],
  ['WI', 'Madison', '53703', 43.073, -89.401, '608'],
  ['WY', 'Cheyenne', '82001', 41.140, -104.820, '307'],
];

const FIRST = [
  'Harvest Hollow', 'Golden Acres', 'Maple Ridge', 'Cider Creek', 'Copper Kettle',
  'Hilltop', 'Sunny Meadow', 'Rolling Hills', 'Whispering Pines', 'Autumn Grove',
  'Cedar Bend', 'Stone Barn', 'Willow Run', 'Frost Hollow', 'Lantern Hill',
];
const SECOND = ['Pumpkin Patch', 'Pumpkin Farm', 'Farm & Corn Maze', 'Family Farm', 'Orchard & Pumpkins'];
const STREETS = ['Orchard Lane', 'County Road 12', 'Harvest Road', 'Old Mill Road', 'Meadow View Drive', 'Pumpkin Hill Road'];
const FEATURE_POOL = [
  ['Corn maze', 'Hayrides', 'U-pick pumpkins', 'Kids play area'],
  ['U-pick pumpkins', 'Petting zoo', 'Cider and donuts', 'Photo spots'],
  ['Corn maze', 'Haunted attraction', 'Food and drinks', 'Fall festival'],
  ['Apple picking', 'Farm store', 'Hayrides', 'Sunflower field'],
];
const SEASONS = [
  'Late September through October 31',
  'Weekends from mid-September to Halloween',
  'Daily from October 1 through November 2',
  'Saturdays and Sundays, late September to early November',
];
const HOURS_SETS = [
  { monday: 'Closed', tuesday: 'Closed', wednesday: '10AM-6PM', thursday: '10AM-6PM', friday: '10AM-8PM', saturday: '9AM-8PM', sunday: '9AM-6PM' },
  { monday: '10AM-6PM', tuesday: '10AM-6PM', wednesday: '10AM-6PM', thursday: '10AM-6PM', friday: '10AM-7PM', saturday: '9AM-7PM', sunday: '10AM-5PM' },
  { monday: 'Closed', tuesday: 'Closed', wednesday: 'Closed', thursday: 'Closed', friday: '12PM-7PM', saturday: '9AM-7PM', sunday: '9AM-5PM' },
];

// Deterministic pseudo-random so repeated builds produce identical output.
function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

const listings = [];
const taken = new Set();
let n = 0;

ANCHORS.forEach(([code, city, zip, lat, lng, area], si) => {
  const random = rng(si * 7919 + 13);
  for (let i = 0; i < 3; i++) {
    n++;
    const name = `${FIRST[(si * 3 + i) % FIRST.length]} ${SECOND[(si + i) % SECOND.length]}`;
    const features = FEATURE_POOL[(si + i) % FEATURE_POOL.length];
    const street = `${1000 + Math.floor(random() * 8000)} ${STREETS[(si + i) % STREETS.length]}`;
    const jitterLat = (random() - 0.5) * 0.9;
    const jitterLng = (random() - 0.5) * 1.1;
    const slug = uniqueSlug(slugify(`${name} ${city} ${code}`), taken);

    listings.push({
      id: `sample-${code.toLowerCase()}-${i + 1}`,
      slug,
      name,
      category: 'Pumpkin patch',
      description:
        `${name} is a family-run fall destination near ${city}, ${STATES[code]}, with ` +
        `${features.slice(0, 3).join(', ').toLowerCase()} and pick-your-own pumpkins through the harvest season.`,
      street,
      city,
      state: STATES[code],
      stateCode: code,
      postalCode: zip,
      fullAddress: `${street}, ${city}, ${code} ${zip}`,
      lat: Math.round((lat + jitterLat) * 1e5) / 1e5,
      lng: Math.round((lng + jitterLng) * 1e5) / 1e5,
      // 555-01XX is the block reserved for fictional use.
      phone: `(${area}) 555-01${String((n % 90) + 10).padStart(2, '0')}`,
      website: null,
      email: null,
      rating: Math.round((3.9 + random() * 1.1) * 10) / 10,
      reviews: 40 + Math.floor(random() * 900),
      hours: HOURS_SETS[(si + i) % HOURS_SETS.length],
      photo: null,
      mapsUrl: null,
      placeId: null,
      features,
      season: SEASONS[(si + i) % SEASONS.length],
      sample: true,
    });
  }
});

listings.sort((a, b) => a.state.localeCompare(b.state) || a.name.localeCompare(b.name));

writeFileSync(
  resolve(ROOT, 'data/listings.json'),
  `${JSON.stringify(
    {
      source: 'sample',
      importedAt: new Date().toISOString(),
      count: listings.length,
      sampleCount: listings.length,
      listings,
    },
    null,
    2
  )}\n`
);

console.log(`Wrote ${listings.length} sample listings across ${ANCHORS.length} states to data/listings.json`);
