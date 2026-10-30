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
  users = [{ name: 'demo1', password: 'demo1' }, { name: 'demo2', password: 'demo2' }];
  console.warn('⚠ APP_USERS не задан — используются тестовые пользователи demo1/demo1 и demo2/demo2');
}

const { app } = createApp({ dbFile, users });
app.listen(port, () => console.log(`Kaspi Учёт: http://localhost:${port}  (пользователи: ${users.map((u) => u.name).join(', ')})`));
