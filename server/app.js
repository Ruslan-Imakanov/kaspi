'use strict';

const path = require('node:path');
const express = require('express');
const { openStore } = require('./db');
const { openNodeDriver } = require('./drivers/node');
const { createCore, SECURITY_HEADERS } = require('./core');

const PUBLIC = path.join(__dirname, '..', 'public');

/** Express-адаптер для локального запуска и Docker. Вся логика API — в core.js. */
function createApp({ dbFile, users, kaspi = {}, tz = 'Asia/Almaty' }) {
  const store = openStore(openNodeDriver(dbFile));
  const core = createCore({ store, users, kaspi, tz });

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req, res, next) => { res.set(SECURITY_HEADERS); next(); });
  app.use(express.static(PUBLIC, { maxAge: 0, etag: true }));

  app.use(express.raw({ type: () => true, limit: '10mb' }));
  app.use(async (req, res, next) => {
    const url = new URL(req.originalUrl, 'http://local');
    const r = await core.handle({
      method: req.method, path: url.pathname, query: url.searchParams,
      headers: { cookie: req.headers.cookie, origin: req.headers.origin, host: req.headers.host },
      ip: req.ip, secure: req.secure, raw: Buffer.isBuffer(req.body) ? req.body : undefined,
    });
    if (!r) return next();
    res.status(r.status).set(r.headers || {});
    if (r.json !== undefined) return res.json(r.json);
    return res.send(Buffer.from(r.body));
  });

  return { app, store, kaspiSync: core.kaspiSync };
}

module.exports = { createApp };
