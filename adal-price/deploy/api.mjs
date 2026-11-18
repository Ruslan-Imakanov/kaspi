// API for the "Благодарственные письма" cabinet: public list + files, password-protected admin actions.
// Storage — one SQLite-backed Durable Object (class LettersStore, binding LETTERS):
//   kv('auth')     {"salt","hash","key"}: password HMAC-SHA256 with a random salt; "key" signs sessions
//   kv('letters')  [{id,title,date,pages:[[w,h],...],added}], newest first
//   files          (id, part, n) -> chunks of JPEG pages p1..p10 (long side ≤ 2000 px) and thumb (≤ 600 px)
// Every letter is stored as pictures: the cabinet turns a photo into one page and draws each PDF page
// with PDF.js in the browser, so visitors read the letter right on the site.
// Passwords: while no password is stored, the ADMIN_BOOTSTRAP secret works once and becomes the stored one.
// Forgot it: set the ADMIN_RESET secret, sign in with it (it replaces the stored password), then delete the secret.

import { DurableObject } from 'cloudflare:workers';

const CHUNK = 1024 * 1024; // SQLite rows in Durable Objects are limited to 2 MB

export class LettersStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS files (id TEXT NOT NULL, part TEXT NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, part, n))');
  }

  getJson(k) {
    const row = this.sql.exec('SELECT v FROM kv WHERE k = ?', k).toArray()[0];
    return row ? JSON.parse(row.v) : null;
  }

  putJson(k, value) {
    this.sql.exec('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', k, JSON.stringify(value));
  }

  file(id, part) {
    const rows = this.sql.exec('SELECT data FROM files WHERE id = ? AND part = ? ORDER BY n', id, part).toArray();
    if (!rows.length) return null;
    const out = new Uint8Array(rows.reduce((sum, r) => sum + r.data.byteLength, 0));
    let offset = 0;
    for (const r of rows) {
      out.set(new Uint8Array(r.data), offset);
      offset += r.data.byteLength;
    }
    return out;
  }

  // adds a letter with its files in one step; returns the new list
  add(entry, files) {
    for (const [part, bytes] of Object.entries(files)) {
      for (let i = 0, n = 0; i < bytes.byteLength; i += CHUNK, n++) {
        this.sql.exec('INSERT INTO files (id, part, n, data) VALUES (?, ?, ?, ?)', entry.id, part, n, bytes.slice(i, i + CHUNK).buffer);
      }
    }
    const letters = [entry, ...(this.getJson('letters') || [])];
    this.putJson('letters', letters);
    return letters;
  }

  // removes a letter and its files; returns the new list, or null when there is no such letter
  remove(id) {
    const letters = this.getJson('letters') || [];
    const rest = letters.filter((l) => l.id !== id);
    if (rest.length === letters.length) return null;
    this.sql.exec('DELETE FROM files WHERE id = ?', id);
    this.putJson('letters', rest);
    return rest;
  }
}

const COOKIE = 'ap_session';
const SESSION_DAYS = 7;
const MAX_LETTERS = 100;
const MAX_PAGES = 10;
// 10 MB per letter keeps one upload well inside the CPU time of a Workers request
const LIMIT = { page: 6 * 1024 * 1024, thumb: 1024 * 1024, total: 10 * 1024 * 1024 };
const ID = '[a-z0-9-]{6,40}';
const enc = new TextEncoder();

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
});
const fail = (status, error) => json({ ok: false, error }, status);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));

const hmacKey = (raw, usage) => crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);

async function makeAuth(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await crypto.subtle.sign('HMAC', await hmacKey(salt, 'sign'), enc.encode(password));
  return { salt: b64(salt), hash: b64(hash), key: b64(crypto.getRandomValues(new Uint8Array(32))) };
}

// constant-time checks: HMAC verify for the stored password, digest + timingSafeEqual for the bootstrap secret
async function checkPassword(auth, password) {
  return crypto.subtle.verify('HMAC', await hmacKey(unb64(auth.salt), 'verify'), unb64(auth.hash), enc.encode(password));
}
async function sameSecret(a, b) {
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
  return crypto.subtle.timingSafeEqual(x, y);
}

async function sessionCookie(auth, url) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(unb64(auth.key), 'sign'), enc.encode('session:' + exp));
  return cookie(url, exp + '.' + b64url(sig), SESSION_DAYS * 86400);
}
function cookie(url, value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` + (url.protocol === 'https:' ? '; Secure' : '');
}
async function signedIn(request, auth) {
  if (!auth) return false;
  const m = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)ap_session=(\d+)\.([A-Za-z0-9_-]+)/);
  if (!m || Number(m[1]) < Date.now()) return false;
  try {
    return await crypto.subtle.verify('HMAC', await hmacKey(unb64(auth.key), 'verify'), unb64url(m[2]), enc.encode('session:' + m[1]));
  } catch (e) {
    return false;
  }
}

const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const fileBytes = async (value) => (value && typeof value === 'object' && 'arrayBuffer' in value ? new Uint8Array(await value.arrayBuffer()) : null);
const publicView = (l) => ({ id: l.id, title: l.title, date: l.date, pages: l.pages });
const storeOf = (env) => env.LETTERS.get(env.LETTERS.idFromName('letters'));
const newId = () => Date.now().toString(36) + '-' + [...crypto.getRandomValues(new Uint8Array(6))].map((b) => (b % 36).toString(36)).join('');

export async function handleApi(request, env, url) {
  const { pathname: path } = url;
  const method = request.method;
  if (!env.LETTERS) return fail(503, 'Хранилище писем не подключено');
  const store = storeOf(env);

  // public: letter files (ids never change, so they are cached for a year)
  let m = path.match(new RegExp(`^/letters/(${ID})/(thumb|p(?:10|[1-9]))\\.jpg$`));
  if (m) {
    if (method !== 'GET' && method !== 'HEAD') return fail(405, 'Method not allowed');
    const data = await store.file(m[1], m[2]);
    if (!data) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    return new Response(method === 'HEAD' ? null : data, {
      headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' },
    });
  }

  // public: list of letters
  if (path === '/api/letters' && method === 'GET') {
    return json({ ok: true, letters: ((await store.getJson('letters')) || []).map(publicView) }, 200, { 'Cache-Control': 'no-cache' });
  }

  const auth = await store.getJson('auth');
  if (path === '/api/session' && method === 'GET') {
    return json({ ok: true, authenticated: await signedIn(request, auth), configured: Boolean(auth || env.ADMIN_BOOTSTRAP) });
  }

  if (method === 'GET' || method === 'HEAD') return fail(404, 'Not found');

  // everything below changes data: same-site requests only
  if (request.headers.get('Origin') !== url.origin) return fail(403, 'Запрос отклонён');

  if (path === '/api/login' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const password = String(body.password || '');
    let current = auth;
    let ok = false;
    const secret = env.ADMIN_RESET || (auth ? '' : env.ADMIN_BOOTSTRAP);
    if (secret && password.length >= 10 && (await sameSecret(password, secret))) {
      current = await makeAuth(password);
      await store.putJson('auth', current);
      ok = true;
    } else if (current) {
      ok = await checkPassword(current, password);
    }
    if (!ok) {
      await wait(1000);
      return fail(401, 'Неверный пароль');
    }
    return json({ ok: true }, 200, { 'Set-Cookie': await sessionCookie(current, url) });
  }

  if (path === '/api/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(url, '', 0) });
  }

  if (!(await signedIn(request, auth))) return fail(401, 'Войдите в кабинет');

  if (path === '/api/letters' && method === 'POST') {
    const count = ((await store.getJson('letters')) || []).length;
    if (count >= MAX_LETTERS) return fail(400, `На сайте уже ${MAX_LETTERS} писем — удалите старые`);
    if (Number(request.headers.get('Content-Length')) > LIMIT.total + 64 * 1024) return fail(413, 'Письмо больше 10 МБ — загрузите PDF с меньшим числом страниц');
    let form;
    try {
      form = await request.formData();
    } catch (e) {
      return fail(400, 'Не удалось прочитать файл');
    }
    const title = clean(form.get('title'), 120);
    if (!title) return fail(400, 'Укажите, от кого письмо');

    // pages: "sizes" = [[w,h],...] and JPEG files p1..pN, plus one small thumb for the grid
    let sizes = null;
    try {
      sizes = JSON.parse(String(form.get('sizes') || ''));
    } catch (e) { /* checked below */ }
    if (!Array.isArray(sizes) || !sizes.length || sizes.length > MAX_PAGES) return fail(400, 'Нужно фото или PDF письма');
    const pages = sizes.map((s) => [Math.round(Number(s && s[0])), Math.round(Number(s && s[1]))]);
    if (pages.some(([w, h]) => !(w > 0 && w <= 4000 && h > 0 && h <= 4000))) return fail(400, 'Нужно фото или PDF письма');
    const files = { thumb: await fileBytes(form.get('thumb')) };
    for (let i = 1; i <= pages.length; i++) files['p' + i] = await fileBytes(form.get('p' + i));
    const parts = Object.entries(files);
    if (parts.some(([, bytes]) => !bytes || !isJpeg(bytes))) return fail(400, 'Нужно фото или PDF письма');
    if (files.thumb.length > LIMIT.thumb || parts.some(([part, bytes]) => part !== 'thumb' && bytes.length > LIMIT.page)) return fail(413, 'Файл слишком большой');
    if (parts.reduce((sum, [, bytes]) => sum + bytes.length, 0) > LIMIT.total) return fail(413, 'Письмо больше 10 МБ — загрузите PDF с меньшим числом страниц');

    const entry = { id: newId(), title, date: clean(form.get('date'), 40), pages, added: new Date().toISOString() };
    const letters = await store.add(entry, files);
    return json({ ok: true, letters: letters.map(publicView) });
  }

  m = path.match(new RegExp(`^/api/letters/(${ID})$`));
  if (m && method === 'DELETE') {
    const letters = await store.remove(m[1]);
    if (!letters) return fail(404, 'Письмо не найдено');
    return json({ ok: true, letters: letters.map(publicView) });
  }

  if (path === '/api/password' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const next = String(body.next || '');
    if (!(await checkPassword(auth, String(body.current || '')))) {
      await wait(1000);
      return fail(401, 'Текущий пароль неверный');
    }
    if (next.length < 10) return fail(400, 'Новый пароль должен быть не короче 10 символов');
    const fresh = await makeAuth(next); // new session key: other devices are signed out
    await store.putJson('auth', fresh);
    return json({ ok: true }, 200, { 'Set-Cookie': await sessionCookie(fresh, url) });
  }

  return fail(404, 'Not found');
}
