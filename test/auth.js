// test/auth.js
//
// Автоматическая проверка регистрации/входа: успешная регистрация,
// отказ по занятому нику, отказ по занятой почте (независимо от
// регистра символов), вход по нику и по почте, отказ по неверному
// паролю, проверка токена сессии, валидация формата полей.

const assert = require('assert');
const http = require('http');
const { createServer } = require('../server.js');

function request(port, method, urlPath, body, headers){
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: 'localhost',
      port,
      path: urlPath,
      method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {},
        headers || {}
      )
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (e){ /* оставляем null */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main(){
  // dbPath: ':memory:' — чистая база на каждый прогон теста, ничего не
  // остаётся на диске и тесты не мешают друг другу при параллельном запуске.
  const { httpServer } = createServer({ dbPath: ':memory:' });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  console.log(`Test server on http://localhost:${port}`);

  // 1) Успешная регистрация.
  const reg1 = await request(port, 'POST', '/api/register', {
    nickname: 'Алиса', email: 'alice@example.com', password: 'secret123'
  });
  assert.strictEqual(reg1.status, 201);
  assert.strictEqual(reg1.body.user.nickname, 'Алиса');
  assert.strictEqual(typeof reg1.body.token, 'string');
  console.log('OK: регистрация успешна, выдан токен сессии');

  // 2) Повторная регистрация с тем же ником (другой регистр букв) отклонена.
  const reg2 = await request(port, 'POST', '/api/register', {
    nickname: 'алиса', email: 'someone-else@example.com', password: 'anotherpass'
  });
  assert.strictEqual(reg2.status, 409);
  assert.strictEqual(reg2.body.error, 'nickname-taken');
  console.log('OK: занятый ник (без учёта регистра) отклонён —', reg2.body.error);

  // 3) Повторная регистрация с той же почтой (другой регистр) отклонена.
  const reg3 = await request(port, 'POST', '/api/register', {
    nickname: 'DifferentNick', email: 'Alice@Example.com', password: 'anotherpass'
  });
  assert.strictEqual(reg3.status, 409);
  assert.strictEqual(reg3.body.error, 'email-taken');
  console.log('OK: занятая почта (без учёта регистра) отклонена —', reg3.body.error);

  // 4) Некорректный формат почты отклонён с понятной причиной.
  const reg4 = await request(port, 'POST', '/api/register', {
    nickname: 'ValidNick', email: 'not-an-email', password: 'validpass'
  });
  assert.strictEqual(reg4.status, 409);
  assert.strictEqual(reg4.body.field, 'email');
  console.log('OK: некорректная почта отклонена —', reg4.body.error);

  // 5) Слишком короткий пароль отклонён.
  const reg5 = await request(port, 'POST', '/api/register', {
    nickname: 'AnotherNick', email: 'another@example.com', password: '123'
  });
  assert.strictEqual(reg5.status, 409);
  assert.strictEqual(reg5.body.field, 'password');
  console.log('OK: слишком короткий пароль отклонён —', reg5.body.error);

  // 6) Вход по нику с верным паролем.
  const login1 = await request(port, 'POST', '/api/login', { login: 'Алиса', password: 'secret123' });
  assert.strictEqual(login1.status, 200);
  assert.strictEqual(login1.body.user.email, 'alice@example.com');
  console.log('OK: вход по нику успешен');

  // 7) Вход по почте (другой регистр) с верным паролем.
  const login2 = await request(port, 'POST', '/api/login', { login: 'ALICE@EXAMPLE.COM', password: 'secret123' });
  assert.strictEqual(login2.status, 200);
  assert.strictEqual(login2.body.user.nickname, 'Алиса');
  console.log('OK: вход по почте (без учёта регистра) успешен');

  // 8) Неверный пароль отклонён.
  const login3 = await request(port, 'POST', '/api/login', { login: 'Алиса', password: 'wrong-password' });
  assert.strictEqual(login3.status, 401);
  assert.strictEqual(login3.body.error, 'invalid-credentials');
  console.log('OK: неверный пароль отклонён —', login3.body.error);

  // 9) Несуществующий пользователь получает ту же причину отказа, что и
  // неверный пароль (не подтверждаем перебором, какие ники существуют).
  const login4 = await request(port, 'POST', '/api/login', { login: 'НетТакогоНика', password: 'whatever1' });
  assert.strictEqual(login4.status, 401);
  assert.strictEqual(login4.body.error, 'invalid-credentials');
  console.log('OK: несуществующий пользователь получает ту же ошибку — без утечки информации');

  // 10) Токен сессии подтверждает личность на /api/me.
  const me1 = await request(port, 'GET', '/api/me', undefined, { Authorization: `Bearer ${login1.body.token}` });
  assert.strictEqual(me1.status, 200);
  assert.strictEqual(me1.body.user.nickname, 'Алиса');
  console.log('OK: /api/me подтверждает пользователя по токену сессии');

  // 11) Неверный/несуществующий токен отклонён.
  const me2 = await request(port, 'GET', '/api/me', undefined, { Authorization: 'Bearer not-a-real-token' });
  assert.strictEqual(me2.status, 401);
  console.log('OK: неверный токен сессии отклонён');

  // 12) Выход аннулирует токен.
  const logout1 = await request(port, 'POST', '/api/logout', {}, { Authorization: `Bearer ${login1.body.token}` });
  assert.strictEqual(logout1.status, 200);
  const me3 = await request(port, 'GET', '/api/me', undefined, { Authorization: `Bearer ${login1.body.token}` });
  assert.strictEqual(me3.status, 401);
  console.log('OK: после выхода токен больше не принимается');

  httpServer.close();
  console.log('\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ — регистрация, уникальность ника/почты и вход работают корректно.');
}

main().catch((err) => { console.error('ТЕСТ УПАЛ:', err); process.exit(1); });
