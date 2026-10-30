import { DurableObject } from 'cloudflare:workers';
import { createCore, SECURITY_HEADERS } from '../server/core.js';
import { openStore } from '../server/db.js';
import { createDoDriver } from '../server/drivers/do.js';
import { parseUsers } from '../server/auth.js';

const toResponse = (r) => {
  const headers = new Headers(r.headers || {});
  if (r.json !== undefined) {
    headers.set('Content-Type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(r.json), { status: r.status, headers });
  }
  return new Response(new Uint8Array(r.body), { status: r.status, headers });
};

/** Один Durable Object хранит всю базу (SQLite) и обслуживает API: как «один сервер с файлом БД». */
export class AppDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.users = parseUsers(env.APP_USERS);
    // Сайт публичный: не запускаемся с образцом из .dev.vars.example и с короткими паролями
    this.configError = !this.users.length
      ? 'Не задана переменная APP_USERS (формат: "Имя1:пароль1,Имя2:пароль2")'
      : this.users.some((u) => /придумайте/i.test(u.password)) ? 'В APP_USERS остались пароли-образцы: замените их на свои'
        : this.users.some((u) => u.password.length < 8) ? 'Пароли в APP_USERS должны быть не короче 8 символов' : '';
    this.core = !this.configError
      ? createCore({
        store: openStore(createDoDriver(ctx)),
        users: this.users,
        kaspi: { token: env.KASPI_TOKEN || '', base: env.KASPI_API_BASE },
        tz: env.APP_TZ || 'Asia/Almaty',
      })
      : null;
  }

  async fetch(request) {
    if (!this.core) return Response.json({ error: this.configError }, { status: 503 });
    const url = new URL(request.url);
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : new Uint8Array(await request.arrayBuffer());
    const r = await this.core.handle({
      method: request.method, path: url.pathname, query: url.searchParams,
      headers: { cookie: request.headers.get('cookie') || undefined, origin: request.headers.get('origin') || undefined, host: url.host },
      ip: request.headers.get('cf-connecting-ip') || 'unknown', secure: url.protocol === 'https:', raw: body,
    });
    return r ? toResponse(r) : new Response('Not found', { status: 404 });
  }

  /** Плановая синхронизация с Kaspi (cron), только если задан токен. */
  async cron() {
    if (!this.core || !this.env.KASPI_TOKEN) return;
    try { await this.core.kaspiSync(); } catch (e) { console.error('Kaspi sync:', e.message); }
  }
}

const withSecurity = (res) => {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
};

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/') || pathname === '/healthz') {
      return withSecurity(await env.APP.get(env.APP.idFromName('main')).fetch(request));
    }
    return withSecurity(await env.ASSETS.fetch(request));
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(env.APP.get(env.APP.idFromName('main')).cron());
  },
};
