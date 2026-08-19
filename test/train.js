// test/train.js
//
// Шаг 12: POST /api/admin/train — запуск дообучения бота отдельным
// процессом (см. createTrainingRunner() в server.js). Проверяем:
//  - без ADMIN_TOKEN эндпоинт всегда 503 (выключен по умолчанию, а не
//    молча открыт);
//  - с ADMIN_TOKEN нужен верный заголовок X-Admin-Token, иначе 403;
//  - ':memory:' БД отклоняется явной ошибкой (дочерний процесс писал бы
//    в свою, не связанную с сервером, память);
//  - реальный маленький прогон реально спавнится, доходит до конца
//    (exitCode 0), и его результат реально появляется в bot_weights —
//    то есть в /api/bot/weights/:difficulty и /api/admin/summary,
//    ровно как после ручного запуска tools/train-bot.js;
//  - пока прогон идёт, повторный POST отклоняется как already-running.

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

async function waitUntilFinished(port, headers, timeoutMs){
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline){
    const res = await request(port, 'GET', '/api/admin/train', undefined, headers);
    if (res.status === 200 && res.body.running === false && res.body.startedAt) return res.body;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('training did not finish within timeout');
}

async function main(){
  // --- 1) Без ADMIN_TOKEN эндпоинт выключен, даже без заголовка. ---
  {
    const { httpServer } = createServer({ dbPath: ':memory:' }); // adminToken не задан
    await new Promise((resolve) => httpServer.listen(0, resolve));
    const port = httpServer.address().port;
    const res = await request(port, 'POST', '/api/admin/train', {});
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.body.error, 'admin-training-disabled');
    console.log('OK: без ADMIN_TOKEN /api/admin/train отдаёт 503, а не молча работает');
    httpServer.close();
  }

  // --- 2) С ADMIN_TOKEN, но ':memory:' БД — явная ошибка, не тихий сбой. ---
  {
    const { httpServer } = createServer({ dbPath: ':memory:', adminToken: 'secret-token' });
    await new Promise((resolve) => httpServer.listen(0, resolve));
    const port = httpServer.address().port;

    const noAuth = await request(port, 'POST', '/api/admin/train', {});
    assert.strictEqual(noAuth.status, 403);
    console.log('OK: без правильного X-Admin-Token — 403');

    const wrongAuth = await request(port, 'POST', '/api/admin/train', {}, { 'X-Admin-Token': 'wrong' });
    assert.strictEqual(wrongAuth.status, 403);
    console.log('OK: с неверным X-Admin-Token — тоже 403 (а не 500 из-за разной длины буфера)');

    const memRes = await request(port, 'POST', '/api/admin/train', {}, { 'X-Admin-Token': 'secret-token' });
    assert.strictEqual(memRes.status, 400);
    assert.strictEqual(memRes.body.error, 'in-memory-db');
    console.log('OK: с :memory: базой запуск отклонён явной ошибкой in-memory-db');
    httpServer.close();
  }

  // --- 3) Реальный прогон на файловой БД: спавнится, доигрывает, пишет
  //        новое поколение весов, видно через существующие эндпоинты. ---
  {
    const tmpDbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tochki-train-test-')), 'tochki.db');
    const ADMIN_TOKEN = 'secret-token';
    const headers = { 'X-Admin-Token': ADMIN_TOKEN };
    const { httpServer } = createServer({ dbPath: tmpDbPath, adminToken: ADMIN_TOKEN });
    await new Promise((resolve) => httpServer.listen(0, resolve));
    const port = httpServer.address().port;

    const before = await request(port, 'GET', '/api/admin/train', undefined, headers);
    assert.strictEqual(before.status, 200);
    assert.strictEqual(before.body.running, false);
    assert.strictEqual(before.body.startedAt, null);
    console.log('OK: до первого запуска статус — running:false, startedAt:null');

    const weightsBefore = await request(port, 'GET', '/api/bot/weights/normal');
    assert.deepStrictEqual(weightsBefore.body.history, []);

    // Специально маленькие параметры — тест должен доехать быстро, сама
    // "обучаемость" уже проверена вручную и в test/gamelog.js напрямую
    // через gameLog.saveBotWeights(); здесь важна интеграция по HTTP.
    const started = await request(port, 'POST', '/api/admin/train',
      { difficulty: 'normal', generations: 1, population: 1, games: 1 }, headers);
    assert.strictEqual(started.status, 202);
    assert.strictEqual(started.body.started, true);
    assert.strictEqual(started.body.run.running, true);
    assert.strictEqual(started.body.run.params.difficulty, 'normal');
    console.log('OK: POST /api/admin/train приняла запрос (202) и сразу вернула управление — не ждёт self-play');

    // Пока прогон не завершился — повторный запуск отклоняется.
    const busy = await request(port, 'POST', '/api/admin/train', {}, headers);
    assert.strictEqual(busy.status, 409);
    assert.strictEqual(busy.body.error, 'already-running');
    console.log('OK: повторный запуск во время уже идущего прогона отклонён — already-running');

    const finished = await waitUntilFinished(port, headers, 30000);
    assert.strictEqual(finished.exitCode, 0, `training process exited with ${finished.exitCode}, output: ${(finished.outputTail||[]).join('\n')}`);
    assert.strictEqual(finished.ok, true);
    assert.ok(finished.outputTail.length > 0, 'ожидали хоть какой-то вывод train-bot.js в outputTail');
    console.log('OK: дочерний процесс дошёл до конца (exitCode 0), вывод виден через outputTail');

    const weightsAfter = await request(port, 'GET', '/api/bot/weights/normal');
    assert.strictEqual(weightsAfter.status, 200);
    assert.strictEqual(weightsAfter.body.history.length, 1, 'ожидали ровно одно новое поколение весов после прогона');
    console.log('OK: результат реального дочернего процесса появился в /api/bot/weights/normal — как после ручного tools/train-bot.js');

    const summary = await request(port, 'GET', '/api/admin/summary');
    assert.strictEqual(summary.body.botWeights.normal.generations, 1);
    console.log('OK: тот же результат виден и в /api/admin/summary');

    // Статус без токена больше не должен ничего выдавать даже после
    // завершения прогона (защита не снимается сама собой).
    const statusNoAuth = await request(port, 'GET', '/api/admin/train');
    assert.strictEqual(statusNoAuth.status, 403);
    console.log('OK: GET-статус без X-Admin-Token тоже защищён');

    httpServer.close();
    fs.rmSync(path.dirname(tmpDbPath), { recursive: true, force: true });
  }

  console.log('\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ — /api/admin/train защищён, спавнит отдельный процесс и не блокирует сервер.');
}

main().catch((err) => { console.error('ТЕСТ УПАЛ:', err); process.exit(1); });
