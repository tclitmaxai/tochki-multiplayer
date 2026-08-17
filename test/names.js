// test/names.js
//
// Проверяет "логичный шаг" из README: игрок, вошедший в учётную запись,
// видит свой ник вместо "Индиго"/"Гранат" — и, что важнее, ОППОНЕНТ тоже
// видит настоящий ник, а не тот, что оппонент придумал бы сам. Плюс:
// гость (без входа) по-прежнему получает null и должен сам подставить
// запасное имя — сервер ничего не решает за клиента насчёт fallback-текста.

const assert = require('assert');
const http = require('http');
const WebSocket = require('ws');
const { createServer } = require('../server.js');

function request(port, method, urlPath, body){
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost', port, path: urlPath, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function onceMessage(ws){
  return new Promise((resolve) => ws.once('message', (raw) => resolve(JSON.parse(raw))));
}

async function main(){
  const { httpServer } = createServer({ dbPath: ':memory:' });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  const url = `ws://localhost:${port}`;
  console.log(`Test server on ${url}`);

  const reg1 = await request(port, 'POST', '/api/register', { nickname: '创造者', email: 'creator@example.com', password: 'secret123' });
  assert.strictEqual(reg1.status, 201);
  const reg2 = await request(port, 'POST', '/api/register', { nickname: 'Соперница', email: 'joiner@example.com', password: 'secret123' });
  assert.strictEqual(reg2.status, 201);

  const c1 = new WebSocket(url); // войдёт как "Создатель"
  const c2 = new WebSocket(url); // войдёт как "Соперница"
  const c3 = new WebSocket(url); // гость, без входа
  await Promise.all([
    new Promise((r) => c1.on('open', r)),
    new Promise((r) => c2.on('open', r)),
    new Promise((r) => c3.on('open', r))
  ]);

  // 1) Создатель с authToken — сразу видит свой ник вместо "Индиго".
  c1.send(JSON.stringify({ type:'create-room', options:{ sizeKey:'small' }, authToken: reg1.body.token }));
  const created = await onceMessage(c1);
  assert.strictEqual(created.type, 'room-created');
  assert.strictEqual(created.playerNames[1], '创造者');
  assert.strictEqual(created.playerNames[2], null); // место ещё не занято
  console.log('OK: создатель с валидным authToken получает свой ник в playerNames[1]');

  // 2) Гость присоединяется без authToken — его место остаётся null,
  // клиент сам подставит запасное имя.
  c3.send(JSON.stringify({ type:'join-room', code: created.code }));
  const joinedGuest = await onceMessage(c3);
  assert.strictEqual(joinedGuest.type, 'room-joined');
  assert.strictEqual(joinedGuest.playerNames[2], null);
  console.log('OK: гость без authToken получает null — сервер не придумывает имя за него');

  // Создателю приходит state с обновлённым составом (гость всё ещё null).
  const stateAfterGuest = await onceMessage(c1);
  assert.strictEqual(stateAfterGuest.type, 'state');
  assert.strictEqual(stateAfterGuest.playerNames[1], '创造者');
  assert.strictEqual(stateAfterGuest.playerNames[2], null);
  console.log('OK: создатель видит актуальный playerNames через state (место 2 — гость)');

  // 3) Другая комната: оба игрока входят под своими учётками — оппонент
  // должен увидеть чужой РЕАЛЬНЫЙ ник, а не тот, что мог бы выдумать сам.
  c2.send(JSON.stringify({ type:'join-room', code: created.code })); // код уже занят гостем — должен получить room-full
  const roomFull = await onceMessage(c2);
  assert.strictEqual(roomFull.type, 'error');
  assert.strictEqual(roomFull.reason, 'room-full');

  const c4 = new WebSocket(url);
  await new Promise((r) => c4.on('open', r));
  c4.send(JSON.stringify({ type:'create-room', options:{ sizeKey:'small' }, authToken: reg1.body.token }));
  const created2 = await onceMessage(c4);

  c2.send(JSON.stringify({ type:'join-room', code: created2.code, authToken: reg2.body.token }));
  const joined2 = await onceMessage(c2);
  assert.strictEqual(joined2.type, 'room-joined');
  assert.strictEqual(joined2.playerNames[1], '创造者');
  assert.strictEqual(joined2.playerNames[2], 'Соперница');
  console.log('OK: присоединившийся под своей учёткой видит и свой, и чужой настоящий ник');

  const stateAfterReal = await onceMessage(c4);
  assert.strictEqual(stateAfterReal.playerNames[2], 'Соперница');
  console.log('OK: создатель тоже видит настоящий ник присоединившегося оппонента');

  // 4) Бот получает читаемое имя вместо null/"Гранат".
  const c5 = new WebSocket(url);
  await new Promise((r) => c5.on('open', r));
  c5.send(JSON.stringify({ type:'create-room', options:{ sizeKey:'small', vsBot:true, botDifficulty:'strong' } }));
  const createdBot = await onceMessage(c5);
  assert.strictEqual(createdBot.playerNames[2], 'Бот (сильный)');
  console.log('OK: комната с ботом сразу получает имя бота вместо "Гранат" —', createdBot.playerNames[2]);

  httpServer.close();
  c1.close(); c2.close(); c3.close(); c4.close(); c5.close();
  console.log('\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ — ники из учётной записи доходят и до владельца, и до оппонента.');
}

main().catch((err) => { console.error('ТЕСТ УПАЛ:', err); process.exit(1); });
