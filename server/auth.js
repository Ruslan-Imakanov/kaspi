'use strict';

const crypto = require('node:crypto');

const COOKIE = 'kaspi_session';
const TTL_MS = 30 * 24 * 3600 * 1000;

/** "Руслан:пароль1,Айгуль:пароль2" → [{name, password}] */
function parseUsers(spec) {
  const users = [];
  for (const part of String(spec || '').split(',')) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const password = part.slice(i + 1).trim();
    if (name && password && !users.some((u) => u.name === name)) users.push({ name, password });
  }
  return users;
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token, secret) {
  if (typeof token !== 'string') return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createAuth({ users, secret }) {
  const failures = new Map(); // ip -> { count, until }
  const MAX_FAILS = 8;
  const WINDOW = 15 * 60 * 1000;

  const blocked = (ip) => {
    const f = failures.get(ip);
    if (!f) return false;
    if (Date.now() > f.until) { failures.delete(ip); return false; }
    return f.count >= MAX_FAILS;
  };
  const fail = (ip) => {
    const f = failures.get(ip);
    if (!f || Date.now() > f.until) failures.set(ip, { count: 1, until: Date.now() + WINDOW });
    else f.count += 1;
  };

  return {
    /** Возвращает { status, error } или { status: 200, user, token }. */
    login({ ip, name, password }) {
      if (blocked(ip)) return { status: 429, error: 'Слишком много попыток. Попробуйте через 15 минут.' };
      const user = users.find((u) => u.name.toLowerCase() === String(name || '').trim().toLowerCase());
      // сравниваем в любом случае, чтобы не выдавать наличие имени по времени ответа
      const ok = safeEqual(password ?? '', user ? user.password : '\0') && !!user;
      if (!ok) { fail(ip); return { status: 401, error: 'Неверное имя или пароль' }; }
      failures.delete(ip);
      return { status: 200, user: user.name, token: sign({ u: user.name, exp: Date.now() + TTL_MS }, secret) };
    },
    /** Имя пользователя по заголовку Cookie или null. */
    userFrom(cookieHeader) {
      const p = verify(parseCookies(cookieHeader)[COOKIE], secret);
      return (p && users.find((u) => u.name === p.u)?.name) || null;
    },
  };
}

const sessionCookie = (token, secure) =>
  `${COOKIE}=${token}; Max-Age=${Math.floor(TTL_MS / 1000)}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
const clearCookie = (secure) => `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

module.exports = { parseUsers, createAuth, sign, verify, sessionCookie, clearCookie };
