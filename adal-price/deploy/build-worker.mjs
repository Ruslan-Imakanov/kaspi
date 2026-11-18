// Packs the static site into one Cloudflare Worker.
// - Serves index.html, robots.txt and only the assets that index.html / styles.css actually use.
// - Text files are inlined; images are copied next to the script and imported as binary
//   "Data" modules (rule in wrangler.jsonc), so serving them costs no decoding work.
// - Security headers come from ../_headers ("/*" block) — the same file Cloudflare Pages reads,
//   so the site keeps them when it is moved to Pages.
// - /api/* and /letters/* (thank-you letters cabinet) are handled by deploy/api.mjs (Durable Object binding LETTERS).
// - /assets/vendor/*: PDF.js for the cabinet (it draws uploaded PDF letters as pictures in the browser). It is too big
//   to bundle, so the Worker takes it from a public npm CDN and serves it from this site only when the bytes match the
//   pinned SHA-256 — the pages keep their strict CSP (scripts from 'self' only).
// Usage: node deploy/build-worker.mjs   (from the adal-price folder)
// Output: deploy/.build/ — deploy it with `npx wrangler deploy -c deploy/wrangler.jsonc`.
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { join, relative, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'deploy', '.build');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};
const TEXT = new Set(['.html', '.css', '.js', '.svg', '.txt']);
// Short paths browsers and bots ask for on their own.
const ALIASES = { '/favicon.ico': '/assets/img/favicon-32.png' };
// PDF.js 4.10.38, legacy build (works in older browsers too). Hashes: sha256 of the files in the pdfjs-dist npm package.
const PDFJS = '4.10.38';
const VENDOR = Object.fromEntries([
  ['pdf.min.mjs', '44ec6f011027ee77791386b66c14876a5fc29e20bf0433c07c6726fff7212b72'],
  ['pdf.worker.min.mjs', 'bd88805178a26c729db8c0107a5b630cb900ec070f4d8c7529a3e45530afd41d'],
].map(([file, sha256]) => [`/assets/vendor/pdfjs-${PDFJS}/${file}`, {
  sha256,
  urls: [
    `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS}/legacy/build/${file}`,
    `https://unpkg.com/pdfjs-dist@${PDFJS}/legacy/build/${file}`,
  ],
}]));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function hash(buf) {
  let h = 2166136261;
  for (const b of buf) { h ^= b; h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(36);
}

// "/*" block of the Pages-style _headers file -> { name: value }
function readHeaders() {
  const file = join(root, '_headers');
  if (!existsSync(file)) return {};
  const out = {};
  let block = null;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) { block = line.trim(); continue; }
    if (block !== '/*') continue;
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

// Pages: the site and the cabinet for thank-you letters (/admin).
const EXTRA_PAGES = ['admin.html'].filter((p) => existsSync(join(root, p)));
const pages = ['index.html', ...EXTRA_PAGES].map((p) => readFileSync(join(root, p), 'utf8'));
const css = readFileSync(join(root, 'assets', 'styles.css'), 'utf8');
// Images first, then scripts/styles: image module names (f2, f3, ...) stay the same when text files are added.
const assets = walk(join(root, 'assets'))
  .map((p) => relative(root, p).split('\\').join('/'))
  .filter((p) => TYPES[extname(p)] && (pages.some((h) => h.includes(p)) || css.includes(p.slice('assets/'.length))))
  .sort((a, b) => Number(TEXT.has(extname(a))) - Number(TEXT.has(extname(b))) || (a < b ? -1 : a > b ? 1 : 0));
const files = ['index.html', ...(existsSync(join(root, 'robots.txt')) ? ['robots.txt'] : []), ...assets, ...EXTRA_PAGES];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'bin'), { recursive: true });

const imports = [];
const table = [];
files.forEach((p, i) => {
  const ext = extname(p);
  const buf = readFileSync(join(root, p));
  const etag = JSON.stringify('"' + buf.length.toString(36) + '-' + hash(buf) + '"');
  const meta = `t: ${JSON.stringify(TYPES[ext])}, e: ${etag}`;
  if (TEXT.has(ext)) {
    table.push(`  ${JSON.stringify('/' + p)}: { ${meta}, b: ${JSON.stringify(buf.toString('utf8'))} },`);
  } else {
    const name = `f${i}${ext}`;
    copyFileSync(join(root, p), join(outDir, 'bin', name));
    imports.push(`import f${i} from './bin/${name}';`);
    table.push(`  ${JSON.stringify('/' + p)}: { ${meta}, b: f${i}, bin: true },`);
  }
});

const security = readHeaders();
// The cabinet may also compile WebAssembly (PDF.js decodes JPEG 2000 scans with it); the public pages may not.
const adminCsp = (security['Content-Security-Policy'] || '').replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'");
const aliases = Object.fromEntries(Object.entries(ALIASES).filter(([, to]) => files.includes(to.slice(1))));

copyFileSync(join(root, 'deploy', 'api.mjs'), join(outDir, 'api.mjs'));

const worker = `// Generated by deploy/build-worker.mjs — do not edit by hand.
import { handleApi } from './api.mjs';
export { LettersStore } from './api.mjs';
${imports.join('\n')}

const SECURITY = ${JSON.stringify(security, null, 2)};
const ALIASES = ${JSON.stringify(aliases)};
const VENDOR = ${JSON.stringify(VENDOR, null, 2)};
// The PDF.js worker compiles its JPEG 2000 decoder from WebAssembly; nothing else may run in it.
const VENDOR_CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'";
const ADMIN_CSP = ${JSON.stringify(adminCsp)};
const FILES = {
${table.join('\n')}
};
const LOCAL = new Set(['localhost', '127.0.0.1']);
const NOT_FOUND = '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Страница не найдена — ADAL PRICE</title><p>Страница не найдена. <a href="/">На главную ADAL PRICE</a></p></html>';

function secure(headers, url) {
  for (const name in SECURITY) headers.set(name, SECURITY[name]);
  // The preview address on workers.dev stays out of search engines; a real domain is indexed normally.
  if (url.hostname.endsWith('.workers.dev')) headers.set('X-Robots-Tag', 'noindex');
  return headers;
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

// Third-party script: fetched from a CDN mirror, served only if its SHA-256 matches the pinned one.
async function vendor(request, url, v) {
  const headers = secure(new Headers(), url);
  headers.set('Content-Security-Policy', VENDOR_CSP);
  headers.set('Content-Type', 'text/javascript; charset=utf-8');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('ETag', '"' + v.sha256.slice(0, 32) + '"');
  if (request.headers.get('If-None-Match') === headers.get('ETag')) return new Response(null, { status: 304, headers });
  for (const src of v.urls) {
    try {
      const res = await fetch(src, { cf: { cacheEverything: true, cacheTtl: 2592000 } });
      if (!res.ok) continue;
      const body = await res.arrayBuffer();
      if (hex(await crypto.subtle.digest('SHA-256', body)) !== v.sha256) continue;
      return new Response(request.method === 'HEAD' ? null : body, { headers });
    } catch (e) { /* try the next mirror */ }
  }
  headers.set('Cache-Control', 'no-store');
  headers.set('Content-Type', 'text/plain; charset=utf-8');
  headers.delete('ETag');
  return new Response('Temporarily unavailable', { status: 502, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // One canonical address: HTTPS and no "www."
    if ((url.protocol === 'http:' && !LOCAL.has(url.hostname)) || url.hostname.startsWith('www.')) {
      url.protocol = 'https:';
      url.hostname = url.hostname.replace(/^www\\./, '');
      return new Response(null, { status: 301, headers: secure(new Headers({ Location: url.toString() }), url) });
    }

    // Thank-you letters: public list and files, cabinet API (deploy/api.mjs)
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/letters/')) {
      const res = await handleApi(request, env, url);
      const headers = secure(new Headers(res.headers), url);
      headers.set('X-Robots-Tag', 'noindex');
      return new Response(res.body, { status: res.status, headers });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: secure(new Headers({ Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }), url) });
    }

    let path = url.pathname;
    try { path = decodeURIComponent(path); } catch (e) { /* malformed escape: keep the raw path */ }
    if (path === '/' || path === '') path = '/index.html';
    if (path === '/admin' || path === '/admin/') path = '/admin.html';
    if (Object.prototype.hasOwnProperty.call(ALIASES, path)) path = ALIASES[path];
    if (Object.prototype.hasOwnProperty.call(VENDOR, path)) return vendor(request, url, VENDOR[path]);
    const f = Object.prototype.hasOwnProperty.call(FILES, path) ? FILES[path] : null;
    const headers = secure(new Headers(), url);

    if (!f) {
      headers.set('Content-Type', 'text/html; charset=utf-8');
      return new Response(request.method === 'HEAD' ? null : NOT_FOUND, { status: 404, headers });
    }

    headers.set('Content-Type', f.t);
    headers.set('ETag', f.e);
    headers.set('Cache-Control', path === '/admin.html' ? 'no-store'
      : path === '/index.html' ? 'public, max-age=0, must-revalidate'
      : 'public, max-age=3600, stale-while-revalidate=86400');
    if (path === '/admin.html') {
      headers.set('X-Robots-Tag', 'noindex, nofollow');
      if (ADMIN_CSP) headers.set('Content-Security-Policy', ADMIN_CSP);
    }
    if (request.headers.get('If-None-Match') === f.e) return new Response(null, { status: 304, headers });
    if (request.method === 'HEAD') return new Response(null, { headers });
    // Copy binary data so the shared module buffer is never handed off to a response.
    return new Response(f.bin ? f.b.slice(0) : f.b, { headers });
  },
};
`;

writeFileSync(join(outDir, 'worker.mjs'), worker);
console.log(`Packed ${files.length} files (${files.length - imports.length} text, ${imports.length} images) into deploy/.build/; ` +
  `${Object.keys(security).length} security headers; script ${(worker.length / 1024).toFixed(0)} KB`);
console.log('Files: ' + files.join(', '));
