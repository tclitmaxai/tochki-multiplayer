// test/rooms.js
//
// Шаг 10: список открытых комнат в лобби, просмотр партии зрителем, явный
// немедленный уход с места (leave-room) и реванш в той же комнате.

const assert = require('assert');
const WebSocket = require('ws');
const { createServer } = require('../server.js');
const Engine = require('../gameEngine.js');

function onceMessage(ws){
  return new Promise((resolve) => {
    ws.once('message', (raw) => resolve(JSON.parse(raw)));
  });
}

async function main(){
  const { httpServer } = createServer({ reconnectGraceMs: 400, emptyRoomTtlMs: 800 });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  const url = `ws://localhost:${port}`;
  console.log(`Test server on ${url}`);

  const c1 = new WebSocket(url); // создатель публичной комнаты
  const c2 = new WebSocket(url); // второй игрок
  const c3 = new WebSocket(url); // зритель
  const c4 = new WebSocket(url); // создатель приватной комнаты (для контраста)
  await Promise.all([c1, c2, c3, c4].map((ws) => new Promise((r) => ws.on('open', r))));

  // 1) Приватная (по умолчанию) комната не попадает в список.
  c4.send(JSON.stringify({ type:'create-room', options:{ sizeKey:'small' } }));
  const privateRoom = await onceMessage(c4);
  assert.strictEqual(privateRoom.isPublic, false);

  // 2) Публичная комната создана, ждёт второго игрока — видна в list-rooms.
  c1.send(JSON.stringify({ type:'create-room', options:{ sizeKey:'small', isPublic:true } }));
  const pub = await onceMessage(c1);
  assert.strictEqual(pub.type, 'room-created');
  assert.strictEqual(pub.isPublic, true);

  c3.send(JSON.stringify({ type:'list-rooms' }));
  const list1 = await onceMessage(c3);
  assert.strictEqual(list1.type, 'room-list');
  const entry1 = list1.rooms.find((r) => r.code === pub.code);
  assert.ok(entry1, 'публичная комната должна быть в списке');
  assert.strictEqual(entry1.status, 'waiting');
  assert.ok(!list1.rooms.some((r) => r.code === privateRoom.code), 'приватная комната не должна быть в списке');
  console.log('OK: приватная комната скрыта, публичная в статусе waiting видна в list-rooms');

  // 3) Зритель может смотреть публичную комнату, даже пока она waiting.
  c3.send(JSON.stringify({ type:'spectate-room', code: pub.code }));
  const spec = await onceMessage(c3);
  assert.strictEqual(spec.type, 'spectate-joined');
  assert.strictEqual(spec.code, pub.code);
  console.log('OK: зритель подключился к публичной комнате');

  // Зритель не может смотреть приватную комнату.
  const c5 = new WebSocket(url);
  await new Promise((r) => c5.on('open', r));
  c5.send(JSON.stringify({ type:'spectate-room', code: privateRoom.code }));
  const specDenied = await onceMessage(c5);
  assert.strictEqual(specDenied.type, 'error');
  assert.strictEqual(specDenied.reason, 'room-not-public');
  console.log('OK: приватную комнату посмотреть нельзя —', specDenied.reason);
  c5.close();

  // 4) Второй игрок присоединяется — зритель тоже получает обновление state.
  const specStateP = onceMessage(c3);
  c2.send(JSON.stringify({ type:'join-room', code: pub.code }));
  const joined = await onceMessage(c2);
  assert.strictEqual(joined.type, 'room-joined');
  await onceMessage(c1); // создатель узнаёт о подключении
  const specState = await specStateP;
  assert.strictEqual(specState.type, 'state');
  console.log('OK: зритель получает те же обновления состояния, что и игроки');

  // Комната теперь 'playing' в списке.
  c3.send(JSON.stringify({ type:'list-rooms' }));
  const list2 = await onceMessage(c3);
  const entry2 = list2.rooms.find((r) => r.code === pub.code);
  assert.strictEqual(entry2.status, 'playing');
  assert.strictEqual(entry2.spectatorCount, 1);
  console.log('OK: список отражает статус playing и число зрителей');

  const { rows, cols } = joined.snapshot;
  const zone = Engine.getOpeningZone(rows, cols);

  // 5) Досрочно завершаем партию, чтобы проверить реванш.
  const specEndP = onceMessage(c3);
  c1.send(JSON.stringify({ type:'end' }));
  const [end1, end2] = await Promise.all([onceMessage(c1), onceMessage(c2)]);
  assert.strictEqual(end1.snapshot.gameOver, true);
  assert.strictEqual(end2.snapshot.gameOver, true);
  await specEndP;
  console.log('OK: партия завершена вручную (нужно для проверки реванша)');

  // Оконченная партия больше не должна попадать в список (ни waiting, ни playing).
  c3.send(JSON.stringify({ type:'list-rooms' }));
  const list3 = await onceMessage(c3);
  assert.ok(!list3.rooms.some((r) => r.code === pub.code), 'оконченная партия не должна быть в списке');
  console.log('OK: оконченная партия скрыта из list-rooms');

  // 6) Реванш: первый запрос только предупреждает второго, игра не стартует.
  c1.send(JSON.stringify({ type:'rematch' }));
  const rematchAsk = await onceMessage(c2);
  assert.strictEqual(rematchAsk.type, 'rematch-requested');
  assert.strictEqual(rematchAsk.seat, 1);
  console.log('OK: первый запрос на реванш только уведомляет соперника, не стартует сам');

  // Второй соглашается — обоим (персонально) приходит rematch-started со
  // свежим снимком, зритель получает обычный 'state'.
  const specRematchP = onceMessage(c3);
  const p1RematchP = onceMessage(c1);
  c2.send(JSON.stringify({ type:'rematch' }));
  const [p1Rematch, p2Rematch] = await Promise.all([p1RematchP, onceMessage(c2)]);
  assert.strictEqual(p1Rematch.type, 'rematch-started');
  assert.strictEqual(p2Rematch.type, 'rematch-started');
  assert.strictEqual(p1Rematch.snapshot.gameOver, false);
  assert.strictEqual(p1Rematch.snapshot.stonesPlacedTotal, 0);
  const specRematch = await specRematchP;
  assert.strictEqual(specRematch.type, 'state');
  assert.strictEqual(specRematch.snapshot.gameOver, false);
  console.log('OK: реванш стартовал новой партией в той же комнате, зритель узнал об этом');

  // Партия снова видна как playing (оба игрока остались).
  c3.send(JSON.stringify({ type:'list-rooms' }));
  const list4 = await onceMessage(c3);
  assert.ok(list4.rooms.some((r) => r.code === pub.code && r.status === 'playing'));
  console.log('OK: после реванша комната снова в списке как playing');

  // 7) Игрок 2 явно покидает комнату (leave-room) — место мгновенно
  // освобождается, без ожидания reconnectGraceMs, и в списке снова waiting.
  // opponent-left уходит и игроку 1, и зрителю (broadcastRoom рассылает
  // всем) — нужно разобрать оба, иначе следующий onceMessage(c3) подхватит
  // это же уведомление вместо ответа на будущий list-rooms.
  const p1LeftNoticeP = onceMessage(c1);
  const specLeftNoticeP = onceMessage(c3);
  c2.send(JSON.stringify({ type:'leave-room' }));
  const leftAck = await onceMessage(c2);
  assert.strictEqual(leftAck.type, 'left-room');
  const p1LeftNotice = await p1LeftNoticeP;
  assert.strictEqual(p1LeftNotice.type, 'opponent-left');
  assert.strictEqual(p1LeftNotice.seat, 2);
  const specLeftNotice = await specLeftNoticeP;
  assert.strictEqual(specLeftNotice.type, 'opponent-left');
  console.log('OK: leave-room мгновенно освобождает место, без грейс-периода');

  c3.send(JSON.stringify({ type:'list-rooms' }));
  const list5 = await onceMessage(c3);
  const entry5 = list5.rooms.find((r) => r.code === pub.code);
  assert.strictEqual(entry5.status, 'waiting');
  console.log('OK: после ухода игрока 2 комната снова waiting — можно зайти другому по коду');

  // Новый игрок заходит по тому же коду — «тот же соперник или другой».
  const c6 = new WebSocket(url);
  await new Promise((r) => c6.on('open', r));
  const specSeatUpdateP = onceMessage(c3); // тот же 'seat-update' state уходит и зрителю
  c6.send(JSON.stringify({ type:'join-room', code: pub.code }));
  const rejoin = await onceMessage(c6);
  assert.strictEqual(rejoin.type, 'room-joined');
  assert.strictEqual(rejoin.seat, 2);
  console.log('OK: новый игрок занял освободившееся место в той же комнате');
  await onceMessage(c1);
  await specSeatUpdateP;

  // Зритель тоже может явно уйти.
  c3.send(JSON.stringify({ type:'leave-room' }));
  const specLeftAck = await onceMessage(c3);
  assert.strictEqual(specLeftAck.type, 'left-room');
  console.log('OK: зритель может явно перестать смотреть партию');

  c1.close(); c2.close(); c3.close(); c4.close(); c6.close();
  httpServer.close();
  console.log('\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ — список открытых комнат, зрители, мгновенный уход и реванш работают корректно.');
}

main().catch((err) => { console.error('ТЕСТ УПАЛ:', err); process.exit(1); });
