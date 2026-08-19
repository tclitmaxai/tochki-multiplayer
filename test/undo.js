const assert = require('assert');
const WebSocket = require('ws');
const { createServer } = require('../server.js');

function onceMessage(ws, pred){
  return new Promise((resolve) => {
    function h(raw){
      const m = JSON.parse(raw);
      if (!pred || pred(m)){ ws.removeListener('message', h); resolve(m); }
    }
    ws.on('message', h);
  });
}

async function playOneCapture(c1, c2, snap){
  // Разыгрывает минимальную партию до первого захвата (без extraTurnOnCapture),
  // возвращая финальный snapshot после захватывающего хода. Не полагается на
  // конкретную геометрию доски заранее — вычисляет opening zone из snapshot.
  // Важно: broadcastRoom шлёт 'state' ОБОИМ клиентам на каждый ход, поэтому
  // после каждого хода нужно вычитывать по одному 'state' у ОБОИХ, иначе у
  // "неактивного" в этом ходе клиента накопится очередь и следующее чтение
  // с него вернёт устаревшее сообщение (было ровно так, отладили руками).
  const zone = snap.openingZone;
  const cx = Math.floor((zone.minX + zone.maxX) / 2);
  const cy = Math.floor((zone.minY + zone.maxY) / 2);
  const moves = [
    [c1, cx, cy],
    [c2, cx + 1, cy],
    [c1, cx + 2, cy],
    [c2, cx - 2, cy - 2],
    [c1, cx + 1, cy - 1],
    [c2, cx - 2, cy - 1],
    [c1, cx + 1, cy + 1],
  ];
  let lastForMover;
  for (const [c, x, y] of moves){
    c.send(JSON.stringify({ type:'move', x, y }));
    const other = c === c1 ? c2 : c1;
    const [moverMsg, otherMsg] = await Promise.all([
      onceMessage(c, m => m.type === 'state' || m.type === 'error'),
      onceMessage(other, m => m.type === 'state' || m.type === 'error'),
    ]);
    assert.strictEqual(moverMsg.type, 'state', `move (${x},${y}) должен быть легальным, получили: ${JSON.stringify(moverMsg)}`);
    lastForMover = moverMsg;
  }
  return lastForMover.snapshot;
}

async function main(){
  const { httpServer } = createServer({ dbPath: ':memory:' });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  const url = `ws://localhost:${port}`;

  // 1) Полный цикл человек-человек: запрос → согласие → откат захвата.
  {
    const c1 = new WebSocket(url);
    await new Promise((r) => c1.on('open', r));
    c1.send(JSON.stringify({ type:'create-room', options:{ sizeKey:'small' } }));
    const created = await onceMessage(c1);
    const code = created.code;

    const c2 = new WebSocket(url);
    await new Promise((r) => c2.on('open', r));
    c2.send(JSON.stringify({ type:'join-room', code }));
    await onceMessage(c2); // room-joined
    await onceMessage(c1); // c1 узнаёт, что оппонент подключился

    const finalSnap = await playOneCapture(c1, c2, created.snapshot);
    assert.ok(finalSnap.scores[1] > 0, 'захват точно произошёл, счёт вырос');
    const scoreBeforeUndo = { ...finalSnap.scores };
    assert.strictEqual(finalSnap.lastMoverSeat, 1);
    assert.strictEqual(finalSnap.canUndo, true);

    // Игрок 2 не может отменить чужой (первого игрока) ход.
    c2.send(JSON.stringify({ type:'request-undo' }));
    const rejected = await onceMessage(c2, m => m.type === 'error');
    assert.strictEqual(rejected.reason, 'not-your-move-to-undo');
    console.log('OK: чужой ход отменить нельзя (not-your-move-to-undo)');

    // Игрок 1 просит отмену — оба получают undo-requested. Оба сообщения
    // сервер шлёт синхронно в один тик, поэтому читать их нужно
    // ОДНОВРЕМЕННО через Promise.all — иначе 'message' у второго клиента
    // может прийти и потеряться (нет слушателя) ещё до того, как мы
    // успеем вызвать для него onceMessage (см. предупреждение в шапке
    // playOneCapture выше — это тот же самый race).
    c1.send(JSON.stringify({ type:'request-undo' }));
    const [reqSeenByRequester, reqSeenByOpponent] = await Promise.all([
      onceMessage(c1, m => m.type === 'undo-requested'),
      onceMessage(c2, m => m.type === 'undo-requested'),
    ]);
    assert.strictEqual(reqSeenByRequester.seat, 1);
    assert.strictEqual(reqSeenByOpponent.seat, 1);

    // Пока запрос висит — ходить нельзя (даже сопернику).
    c2.send(JSON.stringify({ type:'move', x: 0, y: 0 }));
    const blockedMove = await onceMessage(c2, m => m.type === 'error');
    assert.strictEqual(blockedMove.reason, 'undo-pending');
    console.log('OK: пока запрос на отмену висит, ходить нельзя (undo-pending)');

    // Повторный запрос от того же игрока тоже отклоняется.
    c1.send(JSON.stringify({ type:'request-undo' }));
    const dupReq = await onceMessage(c1, m => m.type === 'error');
    assert.strictEqual(dupReq.reason, 'undo-already-requested');

    // Сам запросивший не может "подтвердить" свой же запрос.
    c1.send(JSON.stringify({ type:'undo-approve' }));
    const selfApprove = await onceMessage(c1, m => m.type === 'error');
    assert.strictEqual(selfApprove.reason, 'cannot-approve-own-request');

    // Соперник соглашается — откат применяется у обоих. Та же ловушка:
    // оба 'state' уходят синхронно, читаем их через Promise.all.
    c2.send(JSON.stringify({ type:'undo-approve' }));
    const [stateAtC1, stateAtC2] = await Promise.all([
      onceMessage(c1, m => m.type === 'state'),
      onceMessage(c2, m => m.type === 'state'),
    ]);
    assert.strictEqual(stateAtC1.note, 'undo-applied');
    assert.strictEqual(stateAtC2.note, 'undo-applied');
    assert.strictEqual(stateAtC1.snapshot.scores[1], scoreBeforeUndo[1] - 1, 'захваченное очко вернулось назад');
    assert.deepStrictEqual(stateAtC1.snapshot, stateAtC2.snapshot, 'оба клиента видят одинаковое состояние после отката');
    console.log('OK: полный цикл запрос → согласие → откат применён у обоих клиентов, счёт и доска синхронны');

    c1.close(); c2.close();
  }

  // 2) Отклонение запроса.
  {
    const c1 = new WebSocket(url);
    await new Promise((r) => c1.on('open', r));
    c1.send(JSON.stringify({ type:'create-room', options:{ sizeKey:'small' } }));
    const created = await onceMessage(c1);
    const code = created.code;
    const c2 = new WebSocket(url);
    await new Promise((r) => c2.on('open', r));
    c2.send(JSON.stringify({ type:'join-room', code }));
    await onceMessage(c2);
    await onceMessage(c1);

    const zone = created.snapshot.openingZone;
    c1.send(JSON.stringify({ type:'move', x: zone.minX, y: zone.minY }));
    const [afterMove1] = await Promise.all([
      onceMessage(c1, m => m.type === 'state'),
      onceMessage(c2, m => m.type === 'state'),
    ]);
    assert.strictEqual(afterMove1.snapshot.lastMoverSeat, 1);

    c1.send(JSON.stringify({ type:'request-undo' }));
    await Promise.all([
      onceMessage(c1, m => m.type === 'undo-requested'),
      onceMessage(c2, m => m.type === 'undo-requested'),
    ]);

    c2.send(JSON.stringify({ type:'undo-decline' }));
    const declineSeenByRequester = await onceMessage(c1, m => m.type === 'undo-declined');
    assert.strictEqual(declineSeenByRequester.seat, 1);
    console.log('OK: отклонённый запрос доходит до инициатора (undo-declined)');

    // После отклонения игра снова разблокирована — можно ходить.
    c2.send(JSON.stringify({ type:'move', x: zone.minX + 1, y: zone.minY }));
    const moveAfterDecline = await onceMessage(c2, m => m.type === 'state' || m.type === 'error');
    assert.strictEqual(moveAfterDecline.type, 'state', 'после отклонения ходить снова можно');
    console.log('OK: после отклонения запроса игра разблокирована');

    c1.close(); c2.close();
  }

  // 3) Против бота: авто-согласие, без второго живого игрока.
  {
    const c1 = new WebSocket(url);
    await new Promise((r) => c1.on('open', r));
    c1.send(JSON.stringify({ type:'create-room', options:{ sizeKey:'small', vsBot:true, botDifficulty:'normal' } }));
    const created = await onceMessage(c1);
    assert.strictEqual(created.snapshot.current, 1);

    const zone = created.snapshot.openingZone;
    c1.send(JSON.stringify({ type:'move', x: zone.minX, y: zone.minY }));
    const afterMyMove = await onceMessage(c1, m => m.type === 'state');
    // бот вот-вот сходит следующим сообщением
    const afterBotMove = await onceMessage(c1, m => m.type === 'state');
    assert.strictEqual(afterBotMove.snapshot.lastMoverSeat, 2, 'последний ход теперь за ботом');
    assert.strictEqual(afterBotMove.snapshot.current, 1, 'ход снова у человека');

    // Человек не может отменить ход бота (не свой последний ход).
    c1.send(JSON.stringify({ type:'request-undo' }));
    const rejected = await onceMessage(c1, m => m.type === 'error');
    assert.strictEqual(rejected.reason, 'not-your-move-to-undo');
    console.log('OK: против бота нельзя отменить ход самого бота, если последним ходил он');

    c1.close();
  }

  // 4) Против бота: человек отменяет СВОЙ ход — авто-согласие бота, без 'undo-requested'.
  {
    const c1 = new WebSocket(url);
    await new Promise((r) => c1.on('open', r));
    c1.send(JSON.stringify({ type:'create-room', options:{ sizeKey:'small', vsBot:true, botDifficulty:'normal', firstMove:'opponent' } }));
    const created = await onceMessage(c1);
    assert.strictEqual(created.snapshot.current, 2, 'бот ходит первым по firstMove:opponent');
    const afterBotOpening = await onceMessage(c1, m => m.type === 'state');
    assert.strictEqual(afterBotOpening.snapshot.lastMoverSeat, 2);
    assert.strictEqual(afterBotOpening.snapshot.current, 1);

    const zone = afterBotOpening.snapshot.openingZone;
    // найдём свободную клетку в openingZone для второго хода человека
    let hx = -1, hy = -1;
    outer:
    for (let y = zone.minY; y <= zone.maxY; y++){
      for (let x = zone.minX; x <= zone.maxX; x++){
        if (afterBotOpening.snapshot.stone[y][x] === 0){ hx = x; hy = y; break outer; }
      }
    }
    assert.ok(hx >= 0, 'нашли свободную клетку для второго хода');
    c1.send(JSON.stringify({ type:'move', x: hx, y: hy }));
    const afterMyMove = await onceMessage(c1, m => m.type === 'state');
    assert.strictEqual(afterMyMove.snapshot.lastMoverSeat, 1);

    c1.send(JSON.stringify({ type:'request-undo' }));
    // Против бота — сразу применяется, никакого 'undo-requested' не будет;
    // ждём именно 'state' с note:'undo-applied'.
    const afterUndo = await onceMessage(c1, m => m.type === 'state');
    assert.strictEqual(afterUndo.note, 'undo-applied');
    assert.strictEqual(afterUndo.snapshot.stonesPlacedTotal, afterBotOpening.snapshot.stonesPlacedTotal, 'откат вернул именно к состоянию после хода бота');
    assert.strictEqual(afterUndo.snapshot.current, 1, 'ход снова за человеком, бот повторно не походил');
    console.log('OK: против бота свой ход отменяется мгновенно, без диалога согласия');

    c1.close();
  }

  // 5) undoAllowed:false — создатель отключил отмену хода для всей партии.
  {
    const c1 = new WebSocket(url);
    await new Promise((r) => c1.on('open', r));
    c1.send(JSON.stringify({ type:'create-room', options:{ sizeKey:'small', undoAllowed:false } }));
    const created = await onceMessage(c1);
    assert.strictEqual(created.snapshot.rules.undoAllowed, false, 'снимок отражает выключенное правило');
    assert.strictEqual(created.snapshot.canUndo, false, 'canUndo сразу false, даже до первого хода');
    const code = created.code;

    const c2 = new WebSocket(url);
    await new Promise((r) => c2.on('open', r));
    c2.send(JSON.stringify({ type:'join-room', code }));
    await onceMessage(c2);
    await onceMessage(c1);

    const zone = created.snapshot.openingZone;
    c1.send(JSON.stringify({ type:'move', x: zone.minX, y: zone.minY }));
    const [afterMove1] = await Promise.all([
      onceMessage(c1, m => m.type === 'state'),
      onceMessage(c2, m => m.type === 'state'),
    ]);
    assert.strictEqual(afterMove1.snapshot.lastMoverSeat, 1);
    assert.strictEqual(afterMove1.snapshot.canUndo, false, 'даже после реального хода отмена недоступна');

    // Запрос на отмену своего же последнего хода всё равно отклоняется —
    // именно из-за правила комнаты, а не из-за "нечего отменять".
    c1.send(JSON.stringify({ type:'request-undo' }));
    const rejected = await onceMessage(c1, m => m.type === 'error');
    assert.strictEqual(rejected.reason, 'undo-disabled');
    console.log('OK: undoAllowed:false отключает отмену хода для всей партии (undo-disabled)');

    c1.close(); c2.close();
  }

  httpServer.close();
  console.log('\nВСЕ ПРОВЕРКИ ОТМЕНЫ ХОДА (шаг 14/15) ПРОЙДЕНЫ');
}

main().catch((e) => { console.error(e); process.exit(1); });
