/**
 * Imports an Outscraper "Google Maps / Places" export into data/listings.json.
 *
 *   node scripts/import-outscraper.mjs path/to/outscraper-export.csv
 *   node scripts/import-outscraper.mjs path/to/export.json --keep-samples
 *
 * Accepts CSV or JSON. Recognised Outscraper columns:
 *   name, site, category, type, subtypes, phone, full_address, street, city,
 *   postal_code, state, us_state, latitude, longitude, rating, reviews,
 *   working_hours, photo, place_id, google_id, location_link, description,
 *   business_status, email_1
 *
 * Rows without a name or usable coordinates are skipped and reported.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normaliseListing } from './lib/listings.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = resolve(ROOT, 'data/listings.json');

/* ------------------------------------------------------------ CSV parsing */

/** RFC 4180 CSV parser (handles quoted fields, embedded commas and newlines). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows
    .slice(1)
    .filter((r) => r.some((cell) => cell.trim() !== ''))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/* ------------------------------------------------------------------- main */

function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const keepSamples = args.includes('--keep-samples');

  if (!file) {
    console.error('Usage: node scripts/import-outscraper.mjs <export.csv|export.json> [--keep-samples]');
    process.exit(1);
  }
  const source = resolve(process.cwd(), file);
  if (!existsSync(source)) {
    console.error(`Import file not found: ${source}`);
    process.exit(1);
  }

  const raw = readFileSync(source, 'utf8');
  let rows;
  if (extname(source).toLowerCase() === '.json') {
    const parsed = JSON.parse(raw);
    rows = Array.isArray(parsed) ? parsed : parsed.listings || parsed.data || [];
  } else {
    rows = parseCsv(raw);
  }

  const taken = new Set();
  const listings = [];
  const skipped = [];

  for (const row of rows) {
    if (String(row.business_status || '').toUpperCase() === 'CLOSED_PERMANENTLY') {
      skipped.push({ name: row.name, reason: 'permanently closed' });
      continue;
    }
    const listing = normaliseListing(row, taken);
    if (!listing) {
      skipped.push({ name: row.name || '(unnamed)', reason: 'missing name or coordinates' });
      continue;
    }
    listings.push(listing);
  }

  let kept = [];
  if (keepSamples && existsSync(DATA_FILE)) {
    const existing = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
    kept = (existing.listings || []).filter((l) => l.sample);
    for (const l of kept) taken.add(l.slug);
  }

  const all = [...listings, ...kept];
  all.sort((a, b) => (a.state || '').localeCompare(b.state || '') || a.name.localeCompare(b.name));

  writeFileSync(
    DATA_FILE,
    `${JSON.stringify(
      {
        source: 'outscraper',
        importedAt: new Date().toISOString(),
        count: all.length,
        sampleCount: all.filter((l) => l.sample).length,
        listings: all,
      },
      null,
      2
    )}\n`
  );

  console.log(`Imported ${listings.length} listings from ${file}`);
  if (kept.length) console.log(`Kept ${kept.length} sample listings (--keep-samples)`);
  if (skipped.length) {
    console.log(`Skipped ${skipped.length} rows:`);
    for (const s of skipped.slice(0, 15)) console.log(`  - ${s.name}: ${s.reason}`);
    if (skipped.length > 15) console.log(`  ...and ${skipped.length - 15} more`);
  }
  console.log('Now run: npm run build');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
