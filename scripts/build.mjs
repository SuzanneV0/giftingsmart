// Vercel build: copies the static site into dist/, generates the info pages
// (about, privacy, cookies, terms, legal) and the sitemap, and writes
// dist/config.js with the Clerk publishable key from CLERK_PUBLISHABLE_KEY.
// That key is public by design; never put the secret key here, since
// config.js is served to every visitor. Without the variable (local builds),
// the repo's demo-mode config.js is used as is. The API in api/ is deployed
// by Vercel separately and reads its own settings.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

// Site owner details used on the info pages. Empty values show as a
// highlighted placeholder, so they're easy to spot and fill in.
const SITE = {
  url: 'https://giftingsmart.shop',
  operator: 'GiftingSmart',
  email: 'giftingsmartshopper@gmail.com',
  province: 'Ontario',
  updated: 'October 4, 2026', // change when a policy changes
};

const PAGES = ['about', 'privacy', 'cookies', 'terms', 'legal'];

const OUT = 'dist';
const FILES = [
  'index.html', 'styles.css', 'icon.svg', 'config.js', 'theme.js', 'analytics.js', 'robots.txt', 'og-image.png', 'apple-touch-icon.png',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png',
  'js', 'fonts', 'shared/pricing.js',
];

// Empty dist/ rather than deleting it (a local server may be running inside it).
mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) rmSync(`${OUT}/${f}`, { recursive: true, force: true });
for (const f of FILES) cpSync(f, `${OUT}/${f}`, { recursive: true });

// ---------------------------------------------------------------- info pages

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const placeholder = (label) => `<span class="placeholder">[${label}]</span>`;
const fill = {
  operator: SITE.operator ? esc(SITE.operator) : placeholder('your name'),
  email: SITE.email ? `<a href="mailto:${esc(SITE.email)}">${esc(SITE.email)}</a>` : placeholder('contact email'),
  province: SITE.province ? esc(SITE.province) : placeholder('province'),
  updated: esc(SITE.updated),
};

const footer = readFileSync('index.html', 'utf8').match(/<footer class="site-footer">[\s\S]*?<\/footer>/)[0];

for (const name of PAGES) {
  const src = readFileSync(`pages/${name}.html`, 'utf8');
  const title = src.match(/<!-- title: (.*?) -->/)[1];
  const description = src.match(/<!-- description: (.*?) -->/)[1];
  const body = src
    .replace(/<!--.*?-->\n?/g, '')
    .replace(/\{\{(\w+)\}\}/g, (m, key) => {
      if (!(key in fill)) throw new Error(`pages/${name}.html: unknown {{${key}}}`);
      return fill[key];
    });
  const url = `${SITE.url}/${name}`;
  writeFileSync(
    `${OUT}/${name}.html`,
    `<!doctype html>
<html lang="en-CA">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} · GiftingSmart</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${url}">
  <meta name="theme-color" content="#16132a">
  <meta name="color-scheme" content="light dark">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="GiftingSmart">
  <meta property="og:url" content="${url}">
  <meta property="og:title" content="${esc(title)} · GiftingSmart">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:image" content="${SITE.url}/og-image.png">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="stylesheet" href="/fonts/fonts.css">
  <link rel="stylesheet" href="/styles.css">
  <script src="/theme.js"></script>
  <script src="/analytics.js" defer></script>
</head>
<body>
  <a href="#content" class="skip">Skip to content</a>
  <header class="site-header">
    <div class="nav">
      <a href="/" class="brand" aria-label="GiftingSmart home">
        <img src="/icon.svg" width="28" height="28" alt="">
        <span>GiftingSmart</span>
      </a>
      <div class="nav-right"><a href="/#/events" class="btn primary sm">Open GiftingSmart</a></div>
    </div>
  </header>
  <main id="content">
${body}
  </main>
  ${footer}
</body>
</html>
`,
  );
}

// ---------------------------------------------------------------- sitemap

const today = new Date().toISOString().slice(0, 10);
writeFileSync(
  `${OUT}/sitemap.xml`,
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${['', ...PAGES].map((p) => `  <url><loc>${SITE.url}/${p}</loc><lastmod>${today}</lastmod></url>`).join('\n')}
</urlset>
`,
);

// ---------------------------------------------------------------- config.js

const key = process.env.CLERK_PUBLISHABLE_KEY || '';

if (!key) {
  console.log('build: CLERK_PUBLISHABLE_KEY not set, using demo-mode config.js');
  process.exit(0);
}
if (!/^pk_(test|live)_[A-Za-z0-9+/=_-]+$/.test(key)) {
  console.error('build: CLERK_PUBLISHABLE_KEY must be a publishable key (pk_test_… or pk_live_…), never the secret key');
  process.exit(1);
}

writeFileSync(
  `${OUT}/config.js`,
  `// Generated at build time by scripts/build.mjs. Do not edit.\n` +
    `window.GIFT_CONFIG = ${JSON.stringify({ clerkPublishableKey: key }, null, 2)};\n`,
);
console.log('build: sign-in connected (Clerk)');
