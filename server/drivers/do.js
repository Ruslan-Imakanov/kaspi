'use strict';

/**
 * Драйвер для SQLite внутри Cloudflare Durable Object (ctx.storage.sql).
 * Даёт тот же интерфейс, что и Node-драйвер: именованные параметры @name превращаются в позиционные.
 */
function createDoDriver(ctx) {
  const sql = ctx.storage.sql;

  const compile = (text) => {
    const names = [];
    const query = text.replace(/@(\w+)/g, (_, n) => { names.push(n); return '?'; });
    return { query, names };
  };
  const bindings = (names, args) => {
    if (!names.length) return args;
    const obj = args[0] || {};
    return names.map((n) => (obj[n] === undefined ? null : obj[n]));
  };

  return {
    exec: (text) => { sql.exec(text).toArray(); },
    prepare(text) {
      const { query, names } = compile(text);
      const cursor = (args) => sql.exec(query, ...bindings(names, args));
      return {
        run: (...args) => { cursor(args).toArray(); },
        get: (...args) => cursor(args).toArray()[0] ?? null,
        all: (...args) => cursor(args).toArray(),
      };
    },
    tx: (fn) => ctx.storage.transactionSync(fn),
  };
}

module.exports = { createDoDriver };
