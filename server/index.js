'use strict';

const path = require('node:path');
const { createApp } = require('./app');
const { parseUsers } = require('./auth');

const port = Number(process.env.PORT) || 3000;
const dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'kaspi.db');
const production = process.env.NODE_ENV === 'production';

let users = parseUsers(process.env.APP_USERS);
if (!users.length) {
  if (production) {
    console.error('Не задана переменная APP_USERS (формат: "Имя1:пароль1,Имя2:пароль2").');
    process.exit(1);
  }
  users = [{ name: 'Руслан', password: 'demo1' }, { name: 'Айгуль', password: 'demo2' }];
  console.warn('⚠ APP_USERS не задан — используются тестовые пользователи Руслан/demo1 и Айгуль/demo2');
}

const kaspiToken = process.env.KASPI_TOKEN || '';
const { app, kaspiSync } = createApp({ dbFile, users, kaspi: { token: kaspiToken, base: process.env.KASPI_API_BASE }, tz: process.env.APP_TZ || 'Asia/Almaty' });
app.listen(port, () => console.log(`Kaspi Учёт: http://localhost:${port}  (пользователи: ${users.map((u) => u.name).join(', ')})`));

if (kaspiToken) {
  const run = () => kaspiSync().then(
    (r) => console.log(`Kaspi: заказов ${r.fetched}, новых продаж ${r.added}`),
    (e) => console.error(`Kaspi: ${e.message}`),
  );
  setTimeout(run, 10_000);
  setInterval(run, Number(process.env.KASPI_SYNC_MINUTES || 30) * 60_000);
  console.log('Автосинхронизация с Kaspi Магазином включена');
}
