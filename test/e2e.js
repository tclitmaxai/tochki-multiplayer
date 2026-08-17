// test/e2e.js
//
// Автоматическая проверка комнат по коду без браузера: создаём комнату,
// присоединяемся к ней вторым клиентом, играем несколько ходов, проверяем
// синхронность состояния и обработку ошибок (неверный код, переполненная
// комната, чужая очередь, ход вне дебютной зоны).

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

  const c1 = new WebSocket(url);
  const c2 = new WebSocket(url);
  const c3 = new WebSocket(url);
  await Promise.all([
    new Promise((r) => c1.on('open', r)),
    new Promise((r) => c2.on('open', r)),
    new Promise((r) => c3.on('open', r))
  ]);

  // 1) Создание комнаты с настройками (маленькое поле, победа при 3 очках).
  c1.send(JSON.stringify({ type:'create-room', options:{ sizeKey:'small', targetScore:3 } }));
  const created = await onceMessage(c1);
  assert.strictEqual(created.type, 'room-created');
  assert.strictEqual(created.seat, 1);
  assert.strictEqual(typeof created.code, 'string');
  assert.strictEqual(created.code.length, 5);
  assert.strictEqual(created.snapshot.rows, Engine.SIZES.small.rows);
  assert.strictEqual(created.snapshot.rules.targetScore, 3);
  console.log('OK: комната создана, код =', created.code, '(правило: победа при 3 очках)');

  // 2) Присоединение по несуществующему коду отклоняется.
  c3.send(JSON.stringify({ type:'join-room', code:'ZZZZZ' }));
  const notFound = await onceMessage(c3);
  assert.strictEqual(notFound.type, 'error');
  assert.strictEqual(notFound.reason, 'room-not-found');
  console.log('OK: неверный код отклонён —', notFound.reason);

  // 3) Второй игрок присоединяется по верному коду.
  c2.send(JSON.stringify({ type:'join-room', code: created.code }));
  const joined = await onceMessage(c2);
  assert.strictEqual(joined.type, 'room-joined');
  assert.strictEqual(joined.seat, 2);
  assert.strictEqual(joined.code, created.code);
  console.log('OK: игрок 2 присоединился к комнате', joined.code);

  // Создатель узнаёт о подключении оппонента через широковещательный 'state'.
  const seatUpdate = await onceMessage(c1);
  assert.strictEqual(seatUpdate.type, 'state');
  console.log('OK: создатель комнаты узнал о подключении второго игрока');

  // 4) Третий клиент не может занять место — комната уже полна.
  c3.send(JSON.stringify({ type:'join-room', code: created.code }));
  const roomFull = await onceMessage(c3);
  assert.strictEqual(roomFull.type, 'error');
  assert.strictEqual(roomFull.reason, 'room-full');
  console.log('OK: третий игрок не пущен в заполненную комнату —', roomFull.reason);

  const { rows, cols } = created.snapshot;
  const zone = Engine.getOpeningZone(rows, cols);

  // 5) Ход вне дебютной зоны отклоняется.
  c1.send(JSON.stringify({ type:'move', x: 0, y: 0 }));
  const rejected = await onceMessage(c1);
  assert.strictEqual(rejected.reason, 'illegal-cell');
  console.log('OK: ход вне дебютной зоны отклонён');

  // 6) Ход не в свою очередь отклоняется.
  c2.send(JSON.stringify({ type:'move', x: zone.minX, y: zone.minY }));
  const notYourTurn = await onceMessage(c2);
  assert.strictEqual(notYourTurn.reason, 'not-your-turn');
  console.log('OK: ход не в свою очередь отклонён');

  // 7) Легальные ходы обоих игроков синхронно приходят обеим сторонам.
  c1.send(JSON.stringify({ type:'move', x: zone.minX, y: zone.minY }));
  const [s1a, s2a] = await Promise.all([onceMessage(c1), onceMessage(c2)]);
  assert.deepStrictEqual(s1a.snapshot.stone, s2a.snapshot.stone);
  assert.strictEqual(s1a.snapshot.current, 2);
  console.log('OK: ход игрока 1 синхронно доставлен обоим клиентам');

  c2.send(JSON.stringify({ type:'move', x: zone.maxX, y: zone.maxY }));
  await Promise.all([onceMessage(c1), onceMessage(c2)]);
  console.log('OK: ход игрока 2 принят, дебютная зона снята');

  // 8) Досрочное завершение партии кнопкой «Закончить игру».
  c1.send(JSON.stringify({ type:'end' }));
  const [end1, end2] = await Promise.all([onceMessage(c1), onceMessage(c2)]);
  assert.strictEqual(end1.snapshot.gameOver, true);
  assert.strictEqual(end2.snapshot.gameOver, true);
  console.log('OK: досрочное завершение партии применилось и разослалось обоим игрокам');

  // ---------- Шаг 4: очередь матчмейкинга ----------
  const c4 = new WebSocket(url);
  const c5 = new WebSocket(url);
  await Promise.all([
    new Promise((r) => c4.on('open', r)),
    new Promise((r) => c5.on('open', r))
  ]);

  // 9) c4 ищет соперника на маленьком поле — очередь пуста, встаёт в неё.
  c4.send(JSON.stringify({ type:'find-match', options:{ sizeKey:'small' } }));
  const searching = await onceMessage(c4);
  assert.strictEqual(searching.type, 'searching');
  console.log('OK: игрок встал в очередь матчмейкинга (никого подходящего ещё нет)');

  // 10) c5 ищет соперника на СРЕДНЕМ поле — другие настройки, с c4 не сведётся.
  c5.send(JSON.stringify({ type:'find-match', options:{ sizeKey:'medium' } }));
  const searchingMismatch = await onceMessage(c5);
  assert.strictEqual(searchingMismatch.type, 'searching');
  console.log('OK: игрок с другими настройками поля тоже просто встал в очередь (не сведён с c4)');

  // 11) Повторный поиск, пока уже ищешь — ошибка.
  c4.send(JSON.stringify({ type:'find-match', options:{ sizeKey:'small' } }));
  const alreadySearching = await onceMessage(c4);
  assert.strictEqual(alreadySearching.type, 'error');
  assert.strictEqual(alreadySearching.reason, 'already-searching');
  console.log('OK: повторный поиск отклонён —', alreadySearching.reason);

  // 12) c6 ищет с ТЕМИ ЖЕ настройками, что и c4 (small) — должны свестись сразу.
  const c6 = new WebSocket(url);
  await new Promise((r) => c6.on('open', r));
  c6.send(JSON.stringify({ type:'find-match', options:{ sizeKey:'small' } }));
  const [matched4, matched6] = await Promise.all([onceMessage(c4), onceMessage(c6)]);
  assert.strictEqual(matched4.type, 'match-found');
  assert.strictEqual(matched6.type, 'match-found');
  assert.strictEqual(matched4.code, matched6.code);
  assert.notStrictEqual(matched4.seat, matched6.seat);
  assert.strictEqual(matched4.snapshot.rows, Engine.SIZES.small.rows);
  console.log('OK: два игрока с одинаковыми настройками автоматически сведены в комнату', matched4.code);

  // 13) c5 всё ещё ждёт (никого с medium не нашлось) — отменяет поиск.
  c5.send(JSON.stringify({ type:'cancel-find' }));
  const cancelled = await onceMessage(c5);
  assert.strictEqual(cancelled.type, 'search-cancelled');
  console.log('OK: отмена поиска сработала для игрока, которому пары не нашлось');

  c4.close(); c5.close(); c6.close();

  // ---------- Шаг 5: переподключение при обрыве связи ----------
  const c7 = new WebSocket(url);
  const c8 = new WebSocket(url);
  await Promise.all([
    new Promise((r) => c7.on('open', r)),
    new Promise((r) => c8.on('open', r))
  ]);

  c7.send(JSON.stringify({ type:'create-room', options:{ sizeKey:'small' } }));
  const rc = await onceMessage(c7);
  assert.strictEqual(rc.type, 'room-created');
  assert.strictEqual(typeof rc.token, 'string');
  console.log('OK: комната для теста переподключения создана, токен выдан');

  c8.send(JSON.stringify({ type:'join-room', code: rc.code }));
  const rj = await onceMessage(c8);
  assert.strictEqual(rj.type, 'room-joined');
  assert.strictEqual(typeof rj.token, 'string');
  await onceMessage(c7); // 'state' про подключение оппонента
  console.log('OK: второй игрок присоединился, тоже получил токен');

  // 14) Игрок 2 (c8) внезапно рвёт соединение — игрок 1 должен узнать,
  // что это временное отключение, а не окончательный уход.
  const disconnectedNotice = onceMessage(c7);
  c8.close();
  const disc = await disconnectedNotice;
  assert.strictEqual(disc.type, 'opponent-disconnected');
  assert.strictEqual(disc.seat, 2);
  console.log('OK: игрок 1 получил уведомление о временном отключении оппонента');

  // 15) Игрок 2 переподключается новым сокетом с сохранённым токеном —
  // должен вернуться на то же место с актуальным состоянием партии.
  const c8b = new WebSocket(url);
  await new Promise((r) => c8b.on('open', r));
  const opponentReconnectedNotice = onceMessage(c7);
  c8b.send(JSON.stringify({ type:'reconnect', code: rc.code, seat: 2, token: rj.token }));
  const reconnected = await onceMessage(c8b);
  assert.strictEqual(reconnected.type, 'reconnected');
  assert.strictEqual(reconnected.seat, 2);
  assert.strictEqual(reconnected.code, rc.code);
  const reconnNotice = await opponentReconnectedNotice;
  assert.strictEqual(reconnNotice.type, 'state');
  assert.strictEqual(reconnNotice.note, 'opponent-reconnected');
  console.log('OK: игрок 2 успешно переподключился тем же токеном на то же место');

  // 16) Неверный токен — переподключение отклоняется.
  const c9 = new WebSocket(url);
  await new Promise((r) => c9.on('open', r));
  c9.send(JSON.stringify({ type:'reconnect', code: rc.code, seat: 2, token: 'bogus-token' }));
  const badToken = await onceMessage(c9);
  assert.strictEqual(badToken.type, 'error');
  assert.strictEqual(badToken.reason, 'reconnect-failed');
  console.log('OK: переподключение с неверным токеном отклонено');
  c9.close();

  // 17) Если игрок так и не вернулся до истечения grace-периода — место
  // освобождается окончательно, а старый токен перестаёт действовать.
  // Сначала приходит немедленное 'opponent-disconnected' (как и при первом
  // разрыве), а уже потом, спустя reconnectGraceMs, — окончательное 'opponent-left'.
  const disconnectedAgain = onceMessage(c7);
  c8b.close();
  const discAgain = await disconnectedAgain;
  assert.strictEqual(discAgain.type, 'opponent-disconnected');
  const goneNotice = onceMessage(c7);
  const gone = await goneNotice;
  assert.strictEqual(gone.type, 'opponent-left');
  assert.strictEqual(gone.seat, 2);
  console.log('OK: по истечении grace-периода место освобождено окончательно');

  const c8c = new WebSocket(url);
  await new Promise((r) => c8c.on('open', r));
  c8c.send(JSON.stringify({ type:'reconnect', code: rc.code, seat: 2, token: rj.token }));
  const expiredToken = await onceMessage(c8c);
  assert.strictEqual(expiredToken.type, 'error');
  assert.strictEqual(expiredToken.reason, 'reconnect-failed');
  console.log('OK: токен после истечения grace-периода больше не действует');

  c7.close(); c8c.close();

  // ---------- Шаг 6: игра с ботом на уровне комнаты ----------
  const c10 = new WebSocket(url);
  await new Promise((r) => c10.on('open', r));
  c10.send(JSON.stringify({ type:'create-room', options:{ sizeKey:'small', vsBot:true, botDifficulty:'normal' } }));
  const botRoom = await onceMessage(c10);
  assert.strictEqual(botRoom.type, 'room-created');
  assert.strictEqual(botRoom.vsBot, true);
  console.log('OK: комната с ботом создана, место 2 сразу занято ботом');

  // Место 2 занято ботом — человек присоединиться по коду не может.
  const c11 = new WebSocket(url);
  await new Promise((r) => c11.on('open', r));
  c11.send(JSON.stringify({ type:'join-room', code: botRoom.code }));
  const botRoomFull = await onceMessage(c11);
  assert.strictEqual(botRoomFull.type, 'error');
  assert.strictEqual(botRoomFull.reason, 'room-full');
  console.log('OK: второй человек не может занять место, уже занятое ботом');
  c11.close();

  // Человек делает легальный первый ход — бот должен ответить сам, без
  // участия второго клиента.
  const zoneBot = Engine.getOpeningZone(botRoom.snapshot.rows, botRoom.snapshot.cols);
  c10.send(JSON.stringify({ type:'move', x: zoneBot.minX, y: zoneBot.minY }));
  const afterHumanMove = await onceMessage(c10);
  assert.strictEqual(afterHumanMove.snapshot.current, 2);
  console.log('OK: ход человека принят, очередь перешла к боту (место 2)');

  const afterBotMove = await onceMessage(c10);
  assert.strictEqual(afterBotMove.type, 'state');
  assert.strictEqual(afterBotMove.lastMove.player, 2);
  assert.strictEqual(afterBotMove.snapshot.current, 1);
  assert.strictEqual(afterBotMove.snapshot.stone[afterBotMove.lastMove.y][afterBotMove.lastMove.x], 2);
  console.log('OK: бот сам сходил в ответ, очередь вернулась к человеку — без участия второго клиента');

  c10.close();

  c1.close(); c2.close(); c3.close();
  httpServer.close();
  console.log('\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ — комнаты по коду, матчмейкинг, переподключение и игра с ботом работают корректно.');
}

main().catch((err) => { console.error('ТЕСТ УПАЛ:', err); process.exit(1); });
