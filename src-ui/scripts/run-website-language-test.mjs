import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../Web-Home/', import.meta.url);
const locales = ['', 'zh/', 'zh-hant/', 'ja/', 'ko/', 'es/', 'fr/', 'de/', 'pt/', 'ru/'];
for (const locale of locales) {
  const html = readFileSync(new URL(`${locale}index.html`, root), 'utf8');
  const button = html.match(/<button\b[^>]*id="lang-toggle"[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert(button, `${locale || '/'} must have a language entry`);
  assert.match(button, /aria-label="Language"/);
  assert.match(button, /<svg\b[^>]*aria-hidden="true"/);
  assert.match(button, /<span class="lang-label" lang="en">Language<\/span>/);
  // These immutable CDN URLs contain the old code that overwrites the globe
  // and label with EN/ZH, and the CSS without the globe layout.
  assert(!html.includes('/js/main.js?v=0.10.2"'), `${locale || '/'} still loads the cached abbreviation script`);
  assert(!html.includes('/css/style.css?v=0.8.2"'), `${locale || '/'} still loads the cached language-entry styles`);
}
const main = readFileSync(new URL('js/main.js', root), 'utf8');
assert.doesNotMatch(main, /toggle\.textContent\s*=/);
console.log('PASS language entry and immutable-cache regression across 10 homepages');
