'use strict';

const crypto = require('node:crypto');

const COOKIE = 'kaspi_session';
const TTL_MS = 30 * 24 * 3600 * 1000;

/** "Руслан:пароль1,Жена:пароль2" → [{name, password}] */
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
    login(req, res) {
      const ip = req.ip;
      if (blocked(ip)) return res.status(429).json({ error: 'Слишком много попыток. Попробуйте через 15 минут.' });
      const { name, password } = req.body || {};
      const user = users.find((u) => u.name.toLowerCase() === String(name || '').trim().toLowerCase());
      // сравниваем в любом случае, чтобы не выдавать наличие имени по времени ответа
      const ok = safeEqual(password ?? '', user ? user.password : '\0') && !!user;
      if (!ok) { fail(ip); return res.status(401).json({ error: 'Неверное имя или пароль' }); }
      failures.delete(ip);
      const token = sign({ u: user.name, exp: Date.now() + TTL_MS }, secret);
      res.cookie(COOKIE, token, {
        httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: TTL_MS, path: '/',
      });
      res.json({ user: user.name });
    },
    logout(req, res) {
      res.clearCookie(COOKIE, { path: '/' });
      res.json({ ok: true });
    },
    middleware(req, res, next) {
      const p = verify(parseCookies(req.headers.cookie)[COOKIE], secret);
      const user = p && users.find((u) => u.name === p.u);
      if (!user) return res.status(401).json({ error: 'Требуется вход' });
      req.user = user.name;
      next();
    },
  };
}

module.exports = { parseUsers, createAuth, sign, verify };
