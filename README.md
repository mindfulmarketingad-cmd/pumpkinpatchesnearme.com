# pumpkinpatchesnearme.com

Directory website for **Pumpkin Patches Near Me** — a map-first directory of pumpkin
patches, corn mazes and fall farms across all 50 US states. Listing data comes from
an Outscraper export.

Static site, zero runtime dependencies, built with plain Node. No framework, no
database, no build toolchain to maintain.

---

## Quick start

```bash
npm run build     # generate dist/
npm run dev       # build, then preview at http://localhost:4173
```

Deploy the contents of `dist/` to any static host (Vercel, Netlify, Cloudflare
Pages, S3, or plain nginx). `vercel.json` and `netlify.toml` are included and
already point at the right build command and output directory.

---

## Importing Outscraper data

`data/listings.json` holds the live dataset — currently 2,000 real listings
across 48 states, imported from an Outscraper export. To refresh it with a
new export:

```bash
node scripts/import-outscraper.mjs ~/Downloads/outscraper-pumpkin-patches.xlsx
npm run build
```

XLSX (Outscraper's default download format), CSV and JSON are all accepted.
The import **replaces** `data/listings.json` outright — run it, then rebuild.
State and city pages are generated only for locations that actually have a
listing (`stateNames` and `byCity` in `scripts/build.mjs` are both derived
from the data, not a fixed list), so a state or town with zero listings
simply gets no page rather than an empty placeholder.

Before this repo had real data, it shipped with a **placeholder dataset** so
the directory was fully browsable before the first import — every row carried
`"sample": true`, which marked it `noindex`, kept it out of `sitemap.xml`,
tagged it "Sample data" in the UI, and triggered a banner on the homepage.
That machinery still exists (`npm run sample-data` regenerates it) for local
development or a fresh clone with no data yet, but nothing in the live
dataset is flagged `sample` today, so none of it is currently active.

Recognised Outscraper columns:

| Outscraper column | Used for |
| --- | --- |
| `name` | Listing name (required) |
| `latitude`, `longitude` | Map position (required) |
| `street`, `city`, `postal_code`, `state`, `us_state` / `state_code`, `full_address` | Address |
| `phone`, `site` / `website`, `email_1` | Contact details |
| `rating`, `reviews` | Rating display and sorting |
| `working_hours` | Hours table on the listing page. Each day may be a plain string or an array (a lunch-break split, timed sessions); arrays are joined with " / " |
| `category`, `type`, `subtypes`, `description` | Category and auto-generated feature tags |
| `place_id`, `google_id`, `location_link`, `photo` | Identifiers and media |
| `business_status` | Rows marked `CLOSED_PERMANENTLY` are dropped; `CLOSED_TEMPORARILY` rows are kept |
| `county` / `borough` | Shown on the listing page if present |
| `about` | Outscraper's nested attributes column — accepted payment methods are pulled out of it automatically |

Outscraper fills empty cells with literal placeholder text — `county` is
`"None"` on roughly 90% of rows in a typical export — rather than leaving them
blank. `cleanField()` in `scripts/lib/listings.mjs` catches that (`"None"`,
`"N/A"`, `"-"`, etc.) and stores `null` instead of publishing the placeholder
text as if it were real data.

A few fields Outscraper does not carry — `season`, `admission`, `directions`,
`featured` — stay `null` until a farm sends them in through `/add-a-listing/` or
`/contact/`; the listing page simply omits whatever is missing.

Rows without a name or usable coordinates are skipped and reported at the end of
the run. Slugs are generated from name + city + state and de-duplicated
automatically.

Useful flags:

- `--keep-samples` — retain the existing placeholder rows alongside the import
  (handy for filling states the export does not cover yet).

To regenerate the placeholder dataset from scratch: `npm run sample-data`.

---

## Project layout

```
data/listings.json          the live dataset (generated — do not hand-edit)
src/
  templates/base.html       page shell: head, header, footer
  pages/*.html              static pages, each with a JSON <!--meta --> block
  pages/blog/*.html         blog posts
  data/faqs.json            homepage FAQs — feeds both the HTML and the FAQ schema
  assets/css/style.css      design system (orange + white)
  assets/js/map.js          homepage search map
  assets/js/detail-map.js   single-location map on listing pages
  assets/js/site.js         nav and contact form
  assets/vendor/leaflet/    self-hosted Leaflet (no CDN dependency)
  assets/img/               logo, favicons, OG image
scripts/
  build.mjs                 static site generator
  import-outscraper.mjs     Outscraper CSV/JSON importer
  make-sample-data.mjs      placeholder dataset generator
  make-icons.mjs            favicon / app icon / OG image generator
  serve.mjs                 local preview server
dist/                       build output (generated, git-ignored)
```

### Generated URLs

| URL | Source |
| --- | --- |
| `/` | `src/pages/index.html` — full-screen search map |
| `/about/`, `/contact/`, `/find/`, `/partners/`, `/add-a-listing/`, `/featured/`, `/search/`, `/blog/`, `/disclaimer/`, `/privacy/`, `/terms/`, `/sitemap/` | `src/pages/*.html` |
| `/blog/<slug>/` | `src/pages/blog/*.html` (hand-written) plus one auto-generated `/blog/5-best-pumpkin-patches-in-<city>-<state>/` per town with 5+ listings, see below |
| `/<state>/` | one page per state, e.g. `/nebraska/` — a ranked listicle ("The N Best Pumpkin Patches in Nebraska"), see below |
| `/<state>/<city>/` | one page per town, e.g. `/nebraska/lincoln/` — also a ranked listicle, same treatment as state pages |
| `/<state>/<city>/<business-name>/` | one page per listing, e.g. `/nebraska/lincoln/cider-creek-pumpkin-farm/` |
| `/<attraction>/` (e.g. `/corn-mazes/`, `/hayrides/`) | one page per category in `src/data/categories.json`, listing every farm with that feature tag |
| `/sitemap.xml`, `/robots.txt`, `/ads.txt`, `/site.webmanifest` | generated by the build |
| `/data/search-index.json` | lightweight index (farms, towns, states, attractions, guides) powering `/search/` |

State, city and attraction slugs all live at the site root, so `scripts/build.mjs`
resolves every static page (`/about/`, `/corn-mazes/`, state names, etc.) into one
namespace — a state or city name that collided with an existing route would
overwrite it. None do today (state names don't clash with the static pages or
attraction slugs), but keep that in mind before renaming a category or adding a
new top-level static page.

Listing URLs nest under their state and city (`/<state>/<city>/<business-name>/`).
The business-name segment is de-duplicated per city at build time, so two farms
sharing a name in the same town still get distinct URLs (`...-2/`, `...-3/`, …).
A listing missing a state or city — which shouldn't happen with clean data —
falls back to `/patch/<slug>/` rather than producing a broken link. Every
listing's resolved path is stored on the object itself (`listing.url`) and
included in `dist/data/listings.json`, so the homepage map and search index
read it directly instead of re-deriving it.

### State and city pages are listicles

Both `/<state>/` and `/<state>/<city>/` rank their farms — featured listings
first, then by rating and review volume (the same ordering used everywhere
else, from `rankListings()`) — and present the top 10 as a numbered list with
a short, data-driven blurb per entry (no fabricated claims: the blurb only
ever restates the farm's own rating, review count, feature tags and season).
On a city page the blurb drops the city name from its own sentence, since
saying "in Lincoln" on the Lincoln page is redundant; on the state page it's
kept, since a state groups multiple towns. Any listings beyond the top 10 stay
in a plain grid below, followed by (on state pages) the town list and
attraction breakdown, or (on city pages) nearby towns in the same state — then
the same planning content either way. A page with 10 or fewer listings is
entirely "the ranked part" — no overflow grid.

Both page types also carry a **List/Map toggle** (`src/assets/js/page-map.js`)
above the listicle: click "Map" and the ranked list and overflow grid swap for
a Leaflet map scoped to exactly the farms on that page, with a satellite
toggle and a popup per marker linking to the listing. The farm data for the
map is embedded inline as JSON right on the page (`renderScopedMap()` in
`scripts/build.mjs`) rather than fetched, and Leaflet itself doesn't
initialise until "Map" is actually clicked — so the toggle costs nothing for
visitors who never use it. `?view=map` on either URL opens straight to the
map view.

Featured (paid) listings are flagged `"featured": true` in the dataset. They sort
to the top of every state, town and category page they qualify for, get a
highlighted card border and a "Featured farm" flag, and are collected on
`/featured/`. This is enforced consistently in `rankListings()` in
`scripts/build.mjs` — there is one ranking function, used everywhere, so a farm
can't be featured on one page and buried on another.

### Programmatic "5 Best Pumpkin Patches in <City>" posts

For every town with at least `CITY_POST_MIN_LISTINGS` (5) **distinctly-named**
businesses, the build generates a full blog post at
`/blog/5-best-pumpkin-patches-in-<city>-<state>/` with no hand-written source
file — it comes straight from the dataset, so the set of posts grows on its
own as future imports push more towns past the threshold. Each post has:

- A summary paragraph naming all five farms, a jump-to table of contents, and
  a closing "Summary" section
- The five farms as business-card listicle entries (`renderListicleEntry()` —
  the same component state and city pages use), with the business name as an
  H2, an image, rating, review count and a data-grounded blurb
- A 5-question FAQ (also emitted as `FAQPage` JSON-LD), generated from real
  fields where we have them (e.g. which of the five have a petting zoo or
  kids' play area) and honest evergreen guidance where we don't
- A byline for one of the site's authors (see below)

The distinct-name requirement is deliberately a hard gate, not a preference:
some towns have one operator running several same-named seasonal lots, which
are legitimate separate listings on the directory pages but make a curated
"5 Best" post look broken if the identical name shows up three times in a
top-5. A town that has, say, 9 raw listings but only 3 distinct business
names does not get a post at all, rather than getting one padded out with
repeats. Programmatic posts share one feed with the hand-written guides in
`src/pages/blog/` — both appear in the blog index, both XML and HTML
sitemaps, and the search index — so nothing downstream needs to know which
kind a given post is.

### Authors

`src/data/authors.json` defines the site's writers — four personas, each with
a focus area, a bio and a generated avatar (`npm run avatars`, or
`scripts/make-avatars.mjs` directly — a flat-colour circle with initials,
deliberately illustrated rather than a photo, since nothing on this site
claims to be a photograph of a real person). Every blog post, hand-written or
programmatic, carries an `author` slug: hand-written posts set it in their
own front matter; programmatic city posts rotate through the author pool
deterministically by iteration order, so a given city always lands on the
same byline across rebuilds.

Author data flows into:

- A byline (avatar, name, title, publish date, reading time) at the top of
  every post, linking to that author's page (`renderByline()`)
- `Person` schema as the `author` of each post's `BlogPosting` JSON-LD
  (falls back to the site `Organization` if a post has no author set)
- `/authors/` — an index card grid — and `/authors/<slug>/`, each with its
  own `Person` JSON-LD and a list of that author's posts

Bios describe general, non-verifiable experience ("has spent years
covering...") rather than specific claims about real institutions,
publications or credentials — deliberately, to stay on the right side of the
line between a content-team persona (common, generally accepted) and
fabricating a checkable, false credential.

---

## Adding a page

Create `src/pages/your-page.html` starting with a meta block:

```html
<!--meta
{
  "path": "/your-page/",
  "title": "Page title for the browser tab and search results",
  "description": "Meta description, 150-160 characters.",
  "h1": "Visible heading",
  "lede": "Optional intro paragraph under the heading.",
  "nav": "about",
  "layout": "prose",
  "trail": [{ "label": "Your page" }]
}
-->
<p>Body HTML goes here.</p>
```

`layout` is `prose` (narrow, for reading), `wide` (full-width, for grids) or `raw`
(no wrapper — used by the homepage). `nav` highlights a header link. Available
tokens inside the body: `{{FAQ}}`, `{{STATE_GRID}}`, `{{BLOG_TEASERS}}`,
`{{FEATURED_CARDS}}`, `{{STAT_LISTINGS}}`, `{{STAT_STATES}}`, `{{STAT_CITIES}}`,
`{{CONTACT_EMAIL}}`, `{{BUILD_DATE}}`.

Blog posts live in `src/pages/blog/` and use `slug`, `date`, `excerpt` and
`readingTime` instead of `path`.

---

## Branding

Icons and the social share image are generated from a vector description of the
pumpkin mark — no design tool needed:

```bash
npm run icons
```

That writes `favicon.ico`, `favicon-16/32.png`, `apple-touch-icon.png`,
`icon-192/512.png` and `og-image.png`. The header logo (`logo-mark.svg`) and the
full lockup (`logo.svg`) are hand-authored SVG. Brand colours live at the top of
`src/assets/css/style.css`.

---

## Third-party services

| Service | Purpose | Notes |
| --- | --- | --- |
| OpenStreetMap | street map tiles | free, attribution required and included |
| Esri World Imagery | satellite tiles | free, attribution required and included |
| Zippopotam.us | ZIP → coordinates for ZIP codes not in the dataset | no API key |
| Google Fonts | Fredoka + Inter | swap for self-hosted if you want zero third parties |
| Google AdSense | advertising | publisher `pub-9332749804326149`, matching `ads.txt` |

Leaflet is self-hosted in `src/assets/vendor/leaflet/` (no marker-clustering
plugin — every listing gets its own pin, on every map, at every zoom level).
To upgrade it:

```bash
npm install --save-dev leaflet@<version>
cp node_modules/leaflet/dist/leaflet.{js,css} src/assets/vendor/leaflet/
cp node_modules/leaflet/dist/images/*.png src/assets/vendor/leaflet/images/
```

---

## Before going live

- [x] Run the real Outscraper import so the placeholder banner disappears
- [ ] Point `CONTACT_EMAIL` in `scripts/build.mjs` at a mailbox you actually monitor
- [ ] Submit `https://pumpkinpatchesnearme.com/sitemap.xml` in Google Search Console
- [ ] Confirm `https://pumpkinpatchesnearme.com/ads.txt` resolves before requesting AdSense review
- [ ] Have the Privacy, Terms and Disclaimer pages reviewed by counsel — they are
      thorough drafts written for this site's specifics, not legal advice
- [ ] Fill in the governing-law jurisdiction in Terms section 15
