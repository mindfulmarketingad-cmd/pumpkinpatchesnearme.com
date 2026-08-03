/**
 * Generates a simple illustrated avatar per author in src/data/authors.json —
 * a flat colour circle with initials, deliberately not a photo. Author bios
 * describe real-sounding experience, not verifiable credentials, and the
 * avatars follow the same honesty principle: nothing here claims to be a
 * photograph of a real person.
 *
 *   node scripts/make-avatars.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'src/assets/img/authors');
const authors = JSON.parse(readFileSync(resolve(ROOT, 'src/data/authors.json'), 'utf8'));

mkdirSync(OUT, { recursive: true });

function initials(name) {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const clamp = (v) => Math.max(0, Math.min(255, v));
  const r = clamp(((n >> 16) & 255) + amount);
  const g = clamp(((n >> 8) & 255) + amount);
  const b = clamp((n & 255) + amount);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

for (const author of authors) {
  const bg = author.color || '#F26A21';
  const dark = shade(bg, -35);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="Illustrated avatar for ${author.name}">
  <title>${author.name}</title>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${bg}"/>
      <stop offset="100%" stop-color="${dark}"/>
    </linearGradient>
  </defs>
  <circle cx="100" cy="100" r="100" fill="url(#bg)"/>
  <text x="100" y="116" text-anchor="middle" font-family="'Fredoka','Trebuchet MS',system-ui,sans-serif" font-size="72" font-weight="700" fill="#ffffff">${initials(author.name)}</text>
</svg>
`;
  writeFileSync(join(OUT, `${author.slug}.svg`), svg);
}

console.log(`Wrote ${authors.length} author avatars to src/assets/img/authors/`);
