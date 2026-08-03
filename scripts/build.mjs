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

/* ----------------------------------------------------------------- inputs */

const data = JSON.parse(readFileSync(join(ROOT, 'data/listings.json'), 'utf8'));
const listings = data.listings || [];
const faqs = JSON.parse(readFileSync(join(SRC, 'data/faqs.json'), 'utf8'));
const template = readFileSync(join(SRC, 'templates/base.html'), 'utf8');

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

const statePath = (stateName) => `/pumpkin-patches/${slugify(stateName)}/`;
const listingPath = (listing) => `/patch/${listing.slug}/`;

/* -------------------------------------------------------- data aggregates */

const byState = new Map();
for (const l of listings) {
  if (!l.state) continue;
  if (!byState.has(l.state)) byState.set(l.state, []);
  byState.get(l.state).push(l);
}
for (const [, arr] of byState) {
  arr.sort((a, b) => (b.rating || 0) - (a.rating || 0) || a.name.localeCompare(b.name));
}
const stateNames = [...new Set(Object.values(STATES))]
  .filter((s) => s !== 'District of Columbia')
  .sort();

const cityCount = new Set(listings.map((l) => `${l.city}|${l.stateCode}`).filter((k) => !k.startsWith('null'))).size;

const stats = {
  listings: listings.length,
  states: byState.size,
  cities: cityCount,
};

/* ------------------------------------------------------- shared fragments */

function renderCard(l, { showState = true } = {}) {
  const place = [l.city, showState ? l.stateCode : null].filter(Boolean).join(', ');
  const tags = (l.features || []).slice(0, 3);
  return `<article class="listing-card">
  <div class="listing-card-body">
    <h3><a href="${listingPath(l)}">${esc(l.name)}</a></h3>
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

function renderStateGrid() {
  return `<div class="state-grid">
${stateNames
  .map((s) => {
    const count = (byState.get(s) || []).length;
    return `  <a class="state-link" href="${statePath(s)}">${esc(s)} <span>${count || '—'}</span></a>`;
  })
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
<link rel="stylesheet" href="/assets/vendor/leaflet/MarkerCluster.css">
<script src="/assets/vendor/leaflet/leaflet.js" defer></script>
<script src="/assets/vendor/leaflet/leaflet.markercluster.js" defer></script>
<script src="/assets/js/map.js?v=${ASSET_VERSION}" defer></script>`;
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
  const items = byState.get(stateName) || [];
  const path = statePath(stateName);
  const cities = [...new Set(items.map((l) => l.city).filter(Boolean))].sort();

  const meta = {
    path,
    title: `Pumpkin Patches in ${stateName} — Find a Pumpkin Patch Near You`,
    description: items.length
      ? `Browse ${items.length} pumpkin patch${items.length === 1 ? '' : 'es'} in ${stateName}, with addresses, hours, ratings and directions. Updated for the current fall season.`
      : `Looking for a pumpkin patch in ${stateName}? Browse our directory of ${stateName} pumpkin patches, corn mazes and fall farms, and submit the ones we are missing.`,
    h1: `Pumpkin Patches in ${stateName}`,
    lede: items.length
      ? `${items.length} listing${items.length === 1 ? '' : 's'} across ${cities.length} ${cities.length === 1 ? 'town' : 'towns'} in ${stateName}. Check hours before you drive out — most patches open late September and close in early November.`
      : `We are still building out our ${stateName} coverage. Know a great local patch? Send it to us and we will add it.`,
    nav: 'find',
    layout: 'wide',
    trail: [{ label: 'Find', href: '/find/' }, { label: stateName }],
  };

  const listSection = items.length
    ? `<div class="grid grid-3">
${items.map((l) => renderCard(l, { showState: false })).join('\n')}
</div>`
    : `<div class="empty-state">
  <h3>No ${esc(stateName)} listings yet</h3>
  <p>Our ${esc(stateName)} data is on the way. If you run or love a pumpkin patch here, tell us about it and we will get it listed.</p>
  <a class="btn btn-primary" href="/contact/">Submit a pumpkin patch</a>
</div>`;

  const citySection = cities.length
    ? `<h2>Towns with pumpkin patches in ${esc(stateName)}</h2>
<p>${cities.map((c) => esc(c)).join(' &middot; ')}</p>`
    : '';

  const body = `${listSection}
<div class="section" style="padding-bottom:0">
${citySection}
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
      { label: l.name },
    ],
  };

  const address = l.fullAddress || [l.street, place, l.postalCode].filter(Boolean).join(', ');
  const hoursRows = l.hours
    ? DAYS.map(
        (d) =>
          `<tr><td>${d[0].toUpperCase() + d.slice(1)}</td><td>${esc(l.hours[d] || 'Not listed')}</td></tr>`
      ).join('')
    : '';

  const body = `${l.sample ? `<div class="notice"><p><strong>Sample listing.</strong> This is placeholder data used to demonstrate the directory layout. It is excluded from search engines and will be replaced when the live Outscraper import runs.</p></div>` : ''}
<div class="detail-grid">
  <div class="prose">
    <div class="listing-meta">
      ${l.rating ? `<span class="rating"><span class="stars" aria-hidden="true">${stars(l.rating)}</span> ${l.rating.toFixed(1)}</span>` : ''}
      ${l.reviews ? `<span>${l.reviews.toLocaleString('en-US')} Google reviews</span>` : ''}
      ${l.category ? `<span>${esc(l.category)}</span>` : ''}
    </div>
    ${(l.features || []).length ? `<div class="tag-row">${l.features.map((f) => `<span class="tag">${esc(f)}</span>`).join('')}</div>` : ''}
    ${l.description ? `<p>${esc(l.description)}</p>` : ''}
    <h2>Visiting ${esc(l.name)}</h2>
    <p>Pumpkin patch hours change week to week during the fall, and many farms open only on weekends outside of October. Confirm hours, admission and pumpkin pricing with the farm directly before you drive out.</p>
    ${l.season ? `<p><strong>Typical season:</strong> ${esc(l.season)}</p>` : ''}
    <h2>Hours</h2>
    ${hoursRows ? `<table class="hours-table"><tbody>${hoursRows}</tbody></table>` : '<p>Hours are not listed for this location. Contact the farm to confirm before visiting.</p>'}
  </div>
  <aside>
    <div class="card">
      <h3>Location and contact</h3>
      <ul class="fact-list">
        ${address ? `<li><b>Address</b><span>${esc(address)}</span></li>` : ''}
        ${l.phone ? `<li><b>Phone</b><span><a href="tel:${attr(l.phone.replace(/[^\d+]/g, ''))}">${esc(l.phone)}</a></span></li>` : ''}
        ${l.website ? `<li><b>Website</b><span><a href="${attr(l.website)}" target="_blank" rel="noopener nofollow">Visit site</a></span></li>` : ''}
        ${l.state ? `<li><b>State</b><span><a href="${statePath(l.state)}">${esc(l.state)}</a></span></li>` : ''}
      </ul>
      <p style="margin:1rem 0 0">
        <a class="btn btn-primary btn-block" href="https://www.google.com/maps/dir/?api=1&amp;destination=${l.lat},${l.lng}" target="_blank" rel="noopener nofollow">Get directions</a>
      </p>
    </div>
    <div class="detail-map" id="detail-map" data-lat="${l.lat}" data-lng="${l.lng}" data-name="${attr(l.name)}" style="margin-top:1.25rem"></div>
    <p style="font-size:0.85rem;color:var(--muted);margin-top:0.75rem">Listing details come from public business data and may be out of date. <a href="/contact/">Report a correction</a>.</p>
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
console.log(`  static: ${staticPages.length}, posts: ${posts.length}, states: ${stateNames.length}, listings: ${listings.length}`);
if (sampleOnly) console.log('  note: dataset is sample-only — listing pages are noindex and excluded from sitemap.xml');
console.log(`Output: ${DIST}`);
