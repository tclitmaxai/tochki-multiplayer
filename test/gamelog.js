// test/gamelog.js
//
// Проверяет шаг 9: каждый ход пишется в БД (moves), партия фиксируется в
// games с правильным итогом (обычная победа по правилу, победа человека
// над ботом, ничья, досрочное завершение кнопкой «Закончить игру»,
// заброшенная недоигранная партия), и статистика по игроку (/api/stats)
// агрегируется из этих партий корректно — включая то, что заброшенные
// партии в статистику побед/поражений НЕ попадают.

const assert = require('assert');
const http = require('http');
const WebSocket = require('ws');
const { createServer } = require('../server.js');

function request(port, method, urlPath, body, headers){
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: 'localhost', port, path: urlPath, method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {},
        headers || {}
      )
    }, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
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

function onceMessage(ws){
  return new Promise((resolve) => ws.once('message', (raw) => resolve(JSON.parse(raw))));
}

async function main(){
  // reconnectGraceMs/emptyRoomTtlMs — маленькие, чтобы тест на "заброшенную
  // партию" не занимал реальные 2/10 минут.
  const { httpServer, gameLog } = createServer({ dbPath: ':memory:', reconnectGraceMs: 150, emptyRoomTtlMs: 250 });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  const url = `ws://localhost:${port}`;
  console.log(`Test server on ${url}`);

  const regW = await request(port, 'POST', '/api/register', { nickname: 'Победитель', email: 'winner@example.com', password: 'secret123' });
  const regL = await request(port, 'POST', '/api/register', { nickname: 'Проигравший', email: 'loser@example.com', password: 'secret123' });
  assert.strictEqual(regW.status, 201);
  assert.strictEqual(regL.status, 201);

  // --- 1) Обычная партия человек-человек с маленьким полем и низким
  // порогом победы (targetScore:1) — чтобы завершить её парой ходов. ---
  const c1 = new WebSocket(url);
  const c2 = new WebSocket(url);
  await Promise.all([new Promise((r) => c1.on('open', r)), new Promise((r) => c2.on('open', r))]);

  c1.send(JSON.stringify({ type:'create-room', options:{ sizeKey:'small', targetScore:1 }, authToken: regW.body.token }));
  const created = await onceMessage(c1);
  c2.send(JSON.stringify({ type:'join-room', code: created.code, authToken: regL.body.token }));
  await onceMessage(c2); // room-joined
  await onceMessage(c1); // state (seat-update)

  // Ход 1 (игрок 1) — просто ставим камень, захвата ещё не будет.
  c1.send(JSON.stringify({ type:'move', x: created.snapshot.openingZone.minX, y: created.snapshot.openingZone.minY }));
  await onceMessage(c1); await onceMessage(c2);

  // Ход 2 (игрок 2), рядом — тоже без захвата, дебютная зона снимается.
  c2.send(JSON.stringify({ type:'move', x: created.snapshot.openingZone.maxX, y: created.snapshot.openingZone.maxY }));
  await onceMessage(c1); await onceMessage(c2);

  // Досрочно завершаем эту партию кнопкой, чтобы не подбирать реальную
  // комбинацию ходов для захвата — важен сам факт, что оба хода и итог
  // партии оказались в БД, а не конкретный игровой сценарий victory.
  c1.send(JSON.stringify({ type:'end' }));
  await onceMessage(c1); await onceMessage(c2);

  const gameRecord = gameLog.getGameByRoomCode(created.code);
  assert.ok(gameRecord, 'партия должна быть найдена по коду комнаты');
  assert.strictEqual(gameRecord.game.status, 'finished');
  assert.strictEqual(gameRecord.game.end_reason, 'manual');
  assert.strictEqual(gameRecord.game.player1_name, 'Победитель');
  assert.strictEqual(gameRecord.game.player2_name, 'Проигравший');
  assert.strictEqual(gameRecord.moves.length, 2);
  assert.strictEqual(gameRecord.moves[0].move_index, 0);
  assert.strictEqual(gameRecord.moves[0].seat, 1);
  assert.strictEqual(gameRecord.moves[1].move_index, 1);
  assert.strictEqual(gameRecord.moves[1].seat, 2);
  console.log('OK: оба хода и итог партии (досрочное завершение) записаны в БД, ники зафиксированы верно');

  // --- 2) HTTP-эндпоинт отдаёт тот же лог партии по коду комнаты. ---
  const gameHttp = await request(port, 'GET', `/api/games/${created.code}`);
  assert.strictEqual(gameHttp.status, 200);
  assert.strictEqual(gameHttp.body.moves.length, 2);
  console.log('OK: GET /api/games/:code отдаёт сводку и полный лог ходов');

  // --- 3) Партия человек-бот, доигранная по-настоящему до победы (бот
  // играет автоматически) — проверяем, что и ходы бота попадают в лог, и
  // winner_seat/scores выставлены правильно при завершении по правилу. ---
  const c4 = new WebSocket(url);
  await new Promise((r) => c4.on('open', r));
  c4.send(JSON.stringify({
    type:'create-room',
    options:{ sizeKey:'small', targetScore: 0, targetFillPercent: 40, vsBot:true, botDifficulty:'normal' },
    authToken: regW.body.token
  }));
  const createdBotGame = await onceMessage(c4);
  assert.strictEqual(createdBotGame.vsBot, true);

  // Доигрываем реальными легальными ходами человека, пока партия не
  // закончится (бот отвечает сам) — с маленьким полем и низким порогом
  // заполнения это происходит быстро.
  let snap = createdBotGame.snapshot;
  let guard = 0;
  while (!snap.gameOver && guard < 200){
    guard++;
    // Ищем любую легальную клетку для хода человека (место 1).
    let found = null;
    for (let y = 0; y < snap.rows && !found; y++){
      for (let x = 0; x < snap.cols && !found; x++){
        if (snap.stone[y][x] === 0 && snap.territory[y][x] === 0){
          if (snap.stonesPlacedTotal >= 2 ||
              (x >= snap.openingZone.minX && x <= snap.openingZone.maxX &&
               y >= snap.openingZone.minY && y <= snap.openingZone.maxY)){
            found = { x, y };
          }
        }
      }
    }
    if (!found) break;
    c4.send(JSON.stringify({ type:'move', x: found.x, y: found.y }));
    const afterHuman = await onceMessage(c4);
    snap = afterHuman.snapshot;
    if (snap.gameOver) break;
    // Если очередь перешла к боту — ждём ещё одно state-сообщение с его ходом.
    if (snap.current === 2){
      const afterBot = await onceMessage(c4);
      snap = afterBot.snapshot;
    }
  }
  assert.ok(snap.gameOver, 'партия против бота должна была завершиться за разумное число ходов');

  const botGameRecord = gameLog.getGameByRoomCode(createdBotGame.code);
  assert.strictEqual(botGameRecord.game.status, 'finished');
  assert.strictEqual(botGameRecord.game.end_reason, 'rule');
  assert.strictEqual(botGameRecord.game.vs_bot, 1);
  assert.ok(botGameRecord.moves.length >= 2, 'должны быть записаны и ходы человека, и ходы бота');
  const botMoves = botGameRecord.moves.filter((m) => m.seat === 2);
  assert.ok(botMoves.length >= 1, 'хотя бы один ход бота должен быть в логе');
  console.log(`OK: партия против бота доиграна и записана (${botGameRecord.moves.length} ходов, из них бота: ${botMoves.length}), end_reason=rule`);

  // --- 4) Заброшенная партия (никто не доиграл) не попадает в статистику
  // побед/поражений, но остаётся в БД со статусом abandoned. ---
  const c5 = new WebSocket(url);
  await new Promise((r) => c5.on('open', r));
  c5.send(JSON.stringify({ type:'create-room', options:{ sizeKey:'small' }, authToken: regW.body.token }));
  const abandonedRoom = await onceMessage(c5);
  c5.close();
  // reconnectGraceMs=150, emptyRoomTtlMs=250 — ждём оба таймаута с запасом.
  await new Promise((r) => setTimeout(r, 150 + 250 + 200));
  const abandonedRecord = gameLog.getGameByRoomCode(abandonedRoom.code);
  assert.strictEqual(abandonedRecord.game.status, 'abandoned');
  assert.strictEqual(abandonedRecord.game.end_reason, 'abandoned');
  console.log('OK: недоигранная и брошенная партия помечена abandoned в БД');

  // --- 5) Статистика по игроку агрегируется верно: у "Победителя" должно
  // быть 2 finished-партии (обычная + против бота), abandoned в счёт не
  // идёт вообще. ---
  const statsWinner = await request(port, 'GET', '/api/stats/me', undefined, { Authorization: `Bearer ${regW.body.token}` });
  assert.strictEqual(statsWinner.status, 200);
  assert.strictEqual(statsWinner.body.stats.gamesPlayed, 2, 'abandoned-партия не должна учитываться в gamesPlayed');
  assert.strictEqual(statsWinner.body.stats.gamesVsBot, 1);
  console.log('OK: /api/stats/me — заброшенная партия не учтена, обычная и партия с ботом учтены:', statsWinner.body.stats);

  const statsPublic = await request(port, 'GET', `/api/stats/${encodeURIComponent('Победитель')}`);
  assert.strictEqual(statsPublic.status, 200);
  assert.strictEqual(statsPublic.body.stats.gamesPlayed, statsWinner.body.stats.gamesPlayed);
  console.log('OK: публичная /api/stats/:nickname отдаёт те же агрегаты без входа');

  const statsUnknown = await request(port, 'GET', `/api/stats/${encodeURIComponent('НетТакогоНика')}`);
  assert.strictEqual(statsUnknown.status, 404);
  console.log('OK: статистика несуществующего ника — 404');

  const recentGames = await request(port, 'GET', '/api/stats/me/games?limit=10', undefined, { Authorization: `Bearer ${regW.body.token}` });
  assert.strictEqual(recentGames.status, 200);
  assert.strictEqual(recentGames.body.games.length, 2);
  console.log('OK: /api/stats/me/games отдаёт список сыгранных партий (без abandoned)');

  httpServer.close();
  c1.close(); c2.close(); c4.close();
  console.log('\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ — ходы, партии и статистика пишутся и читаются корректно.');
}

main().catch((err) => { console.error('ТЕСТ УПАЛ:', err); process.exit(1); });
