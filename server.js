// server.js
//
// Шаг 6 плана: игра с ботом на уровне комнаты. При создании комнаты можно
// включить «Играть с ботом» — тогда место 2 сразу занимает бот (используя
// тот же chooseMove()/match.botMove() из gameEngine.js, что и в
// однопользовательской версии), и партия начинается без ожидания второго
// человека. Комнаты с ботом не участвуют в матчмейкинге и не принимают
// вход по коду (место 2 уже занято) — это защищённый одиночный сценарий
// «человек против бота», просто поверх той же сетевой инфраструктуры.
//
// Протокол (JSON-сообщения по WebSocket):
//   клиент -> сервер:
//     {type:'create-room', options:{sizeKey, targetScore, targetFillPercent, vsBot, botDifficulty, isPublic}, authToken?}
//     {type:'join-room', code, authToken?}
//     {type:'find-match', options:{sizeKey, targetScore, targetFillPercent}, authToken?}
//     {type:'cancel-find'}
//     {type:'reconnect', code, seat, token, authToken?}
//     {type:'move', x, y}
//     {type:'end'}
//     {type:'list-rooms'}                     — шаг 10: список открытых комнат для лобби
//     {type:'spectate-room', code}            — шаг 10: подключиться зрителем к открытой комнате
//     {type:'leave-room'}                     — немедленно освободить своё место/уйти из зрителей
//     {type:'rematch'}                        — шаг 10: сыграть ещё раз в той же комнате
//   authToken — необязательный токен сессии из /api/login (не путать с
//   token переподключения к месту, который сервер сам генерирует и
//   присылает клиенту). Если валиден — сервер подставляет ник вместо
//   ника-заглушки "Индиго"/"Гранат" в playerNames.
//   сервер -> клиент:
//     {type:'room-created', code, seat, token, snapshot, vsBot, playerNames}  — только создателю
//     {type:'room-joined',  code, seat, token, snapshot, playerNames}        — только присоединившемуся
//     {type:'searching'}                             — встал в очередь
//     {type:'search-cancelled'}                      — вышел из очереди
//     {type:'match-found', code, seat, token, snapshot, playerNames}   — обоим сведённым игрокам
//     {type:'reconnected', code, seat, token, snapshot, vsBot, playerNames}  — успешно вернувшемуся
//     {type:'state', snapshot, playerNames, lastMove?, note?}     — рассылается обоим (и зрителям)
//     {type:'opponent-disconnected', seat, graceMs}  — оппонент отвалился, ждём
//     {type:'opponent-left', seat}                   — оппонент не вернулся — место освобождено
//     {type:'room-list', rooms:[{code, sizeKey, targetScore, targetFillPercent, status,
//                                 playerNames, spectatorCount}]}   — ответ на list-rooms
//     {type:'spectate-joined', code, snapshot, playerNames, vsBot}   — только зрителю
//     {type:'rematch-requested', seat}         — один из игроков предложил реванш, ждём второго
//     {type:'rematch-started', seat, token, snapshot, playerNames, vsBot}   — персонально каждому месту
//     (зрители получают ту же партию через обычный 'state' с новым snapshot)
//     {type:'error', reason}
//
// Шаг 10 — публичные комнаты, зрители и реванш:
//   При создании комнаты можно пометить её isPublic:true — тогда, пока в
//   ней свободно место (ждёт второго игрока) ИЛИ партия идёт, она попадает
//   в список list-rooms и её можно смотреть через spectate-room (только
//   просмотр состояния, зритель не может ходить). Комнаты с ботом и
//   приватные (isPublic:false, по умолчанию) в список не попадают.
//   Реванш: когда партия окончена (gameOver), любой из сидящих за столом
//   игроков может прислать 'rematch' — сервер ждёт согласия ВТОРОГО живого
//   игрока (если он ещё в комнате), затем создаёт новую партию с теми же
//   правилами в той же комнате (новая строка в games, тот же room_code).
//   Против бота реванш стартует сразу по одному запросу человека. Явное
//   'leave-room' освобождает место без ожидания reconnectGraceMs — чтобы
//   можно было сразу же уступить место другому игроку по тому же коду.
//
// Шаг 9 — логи партий и статистика (HTTP, не WS):
//   Каждая партия и каждый применённый ход (человека и бота) пишутся в
//   БД (см. gamelog.js) сразу по ходу дела — не пост-фактум и не только
//   при выигрыше. Игровая сессия в памяти (сокеты, таймеры реконнекта)
//   и её персистентный лог — разные вещи: комната пропадёт из памяти при
//   рестарте сервера, а её лог в БД останется.
//     GET  /api/games/:code        → {game, moves}   — сводка + все ходы по коду комнаты
//     GET  /api/stats/me           → {nickname, stats}         (нужен Authorization: Bearer)
//     GET  /api/stats/me/games?limit=20 → {games:[...]}        (нужен Authorization: Bearer)
//     GET  /api/stats/:nickname    → {nickname, stats}         — публично, без входа
//   stats = {gamesPlayed, wins, losses, draws, gamesVsBot, winRate}.
//   Только партии со статусом 'finished' входят в статистику — 'abandoned'
//   (комната брошена недоигранной) — нет.
//
// Запуск:  npm install && npm start   (или PORT=3000 node server.js)
// Тест:    npm test

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const Engine = require('./gameEngine.js');
const { openDatabase } = require('./db.js');
const { createAuth } = require('./auth.js');
const { createGameLog } = require('./gamelog.js');

const MAX_JSON_BODY_BYTES = 10 * 1024; // регистрация/вход — маленькие тела, больше не нужно

function readJsonBody(req){
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES){
        reject(Object.assign(new Error('payload-too-large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e){ reject(Object.assign(new Error('bad-json'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, body){
  const data = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data)
  });
  res.end(data);
}

// Без похожих друг на друга символов (0/O, 1/I/L), чтобы код было легко
// продиктовать или напечатать без ошибок.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
// Если комната опустела (оба игрока отключились и не вернулись) — держим
// её ещё немного на случай, что кто-то просто перезагрузил страницу, потом
// удаляем. Это отдельный, более долгий таймаут поверх RECONNECT_GRACE_MS —
// он применяется уже ПОСЛЕ того, как оба места точно освободились навсегда.
const DEFAULT_EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;
// Сколько времени даём отключившемуся игроку на переподключение, прежде
// чем окончательно освободить его место и аннулировать токен.
const DEFAULT_RECONNECT_GRACE_MS = 2 * 60 * 1000;

function generateToken(){
  return crypto.randomBytes(16).toString('hex');
}

// room = { code, match, seats:{1:ws|null,2:ws|null}, tokens:{1,2},
//          playerNames:{1,2}, playerUserIds:{1,2}, gameId, moveCount,
//          options, emptyTimer, graceTimers:{1:timer|null,2:timer|null},
//          vsBot, botSeat, botDifficulty,
//          isPublic, spectators:Set<ws>, rematchVotes:Set<seat> }
function createRoomsRegistry(config){
  const emptyRoomTtlMs = config.emptyRoomTtlMs;
  const reconnectGraceMs = config.reconnectGraceMs;
  const rooms = new Map();

  function generateCode(){
    let code;
    do {
      code = '';
      for (let i=0; i<CODE_LENGTH; i++){
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
    } while (rooms.has(code));
    return code;
  }

  function createRoom(options){
    const code = generateCode();
    const room = {
      code,
      match: Engine.createMatch(options || {}),
      seats: { 1: null, 2: null },
      tokens: { 1: null, 2: null },
      // Отображаемое имя для каждого места — ник из учётной записи, если
      // игрок вошёл (см. authToken в create-room/join-room/find-match/
      // reconnect), иначе null — тогда клиент сам показывает запасное имя
      // ("Индиго"/"Гранат"). Хранится на сервере (а не только в клиенте),
      // чтобы оппонент тоже видел настоящий ник, а не свой выдуманный.
      playerNames: { 1: null, 2: null },
      // id учётной записи для каждого места (или null для гостя/бота) —
      // именно по нему считается статистика в gamelog.js, ник для этого
      // не годится (его в будущем можно будет сменить).
      playerUserIds: { 1: null, 2: null },
      // id строки в таблице games (см. gamelog.js) — null, пока БД ещё не
      // подключена (createRoom используется и в тестах movegen-подобных
      // сценариев без сервера); в createServer() выставляется сразу же
      // после создания комнаты.
      gameId: null,
      // Порядковый номер следующего хода для записи в таблицу moves —
      // 0-based, растёт монотонно, независим от того, кто сходил.
      moveCount: 0,
      options: options || {},
      emptyTimer: null,
      graceTimers: { 1: null, 2: null },
      vsBot: false,
      botSeat: null,
      botDifficulty: null,
      // Шаг 10: комната видна в лобби (list-rooms) и доступна для просмотра
      // зрителями (spectate-room), только если создатель явно это включил.
      isPublic: false,
      spectators: new Set(),
      // Места (по номеру места), уже согласившиеся сыграть реванш в этой же
      // комнате — см. обработчик 'rematch'. Сбрасывается при старте новой
      // партии и при уходе игрока с места.
      rematchVotes: new Set()
    };
    rooms.set(code, room);
    return room;
  }

  function getRoom(code){
    return rooms.get(String(code || '').toUpperCase());
  }

  // Место, занятое ботом, никогда не считается свободным для человека —
  // ни для входа по коду, ни (в принципе) для матчмейкинга.
  function freeSeat(room){
    if (!room.seats[1]) return 1;
    if (room.vsBot && room.botSeat === 2) return null;
    if (!room.seats[2]) return 2;
    return null;
  }

  function armEmptyTimer(room){
    if (room.emptyTimer) clearTimeout(room.emptyTimer);
    room.emptyTimer = setTimeout(() => {
      if (!room.seats[1] && !room.seats[2]){
        // Партия недоигранной комнаты, которую никто не забрал обратно,
        // помечается в БД как abandoned (не в статистику), прежде чем
        // сама комната пропадёт из памяти — иначе это "потерянная" партия,
        // которая навсегда останется висеть в статусе in_progress.
        if (config.onRoomExpired) config.onRoomExpired(room);
        rooms.delete(room.code);
      }
    }, emptyRoomTtlMs);
    // unref: этот таймер не должен сам по себе держать процесс живым
    // (иначе, например, скрипты тестов/graceful shutdown зависают).
    if (typeof room.emptyTimer.unref === 'function') room.emptyTimer.unref();
  }

  function disarmEmptyTimer(room){
    if (room.emptyTimer){ clearTimeout(room.emptyTimer); room.emptyTimer = null; }
  }

  // Место освобождается не сразу при разрыве связи, а даёт игроку
  // reconnectGraceMs на возврат с тем же токеном. Если не вернулся —
  // токен аннулируется, место освобождается окончательно.
  function armSeatGraceTimer(room, seat, onExpire){
    clearSeatGraceTimer(room, seat);
    room.graceTimers[seat] = setTimeout(() => {
      room.graceTimers[seat] = null;
      if (room.seats[seat]) return; // уже успел переподключиться
      room.tokens[seat] = null;
      onExpire();
    }, reconnectGraceMs);
    if (typeof room.graceTimers[seat].unref === 'function') room.graceTimers[seat].unref();
  }

  function clearSeatGraceTimer(room, seat){
    if (room.graceTimers[seat]){ clearTimeout(room.graceTimers[seat]); room.graceTimers[seat] = null; }
  }

  return {
    rooms, createRoom, getRoom, freeSeat,
    armEmptyTimer, disarmEmptyTimer,
    armSeatGraceTimer, clearSeatGraceTimer,
    reconnectGraceMs
  };
}

function send(ws, msg){
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// Рассылка обоим местам за столом И всем зрителям (шаг 10) — зрителям
// уходят те же сообщения о состоянии партии, что и игрокам, кроме тех,
// что относятся конкретно к месту (это фильтруется на уровне вызывающего
// кода: приватные per-seat сообщения вроде rematch-started шлются отдельно).
function broadcastRoom(room, msg){
  send(room.seats[1], msg);
  send(room.seats[2], msg);
  broadcastSpectators(room, msg);
}

function broadcastSpectators(room, msg){
  for (const specWs of room.spectators) send(specWs, msg);
}

function stateMessage(room, extra){
  return Object.assign({ type: 'state', snapshot: room.match.getSnapshot(), playerNames: room.playerNames }, extra || {});
}

// Статус комнаты для списка в лобби: 'waiting' — ждёт второго игрока (можно
// присоединиться по коду), 'playing' — партия идёт (можно только смотреть),
// null — комната не годится для списка (партия окончена, комната с ботом).
function roomListStatus(room){
  if (room.vsBot || !room.isPublic) return null;
  const snap = room.match.getSnapshot();
  if (snap.gameOver) return null;
  if (!room.seats[1] || !room.seats[2]) return 'waiting';
  return 'playing';
}

function roomListEntry(room){
  const status = roomListStatus(room);
  if (!status) return null;
  return {
    code: room.code,
    sizeKey: room.match.sizeKey,
    targetScore: room.options.targetScore || 0,
    targetFillPercent: typeof room.options.targetFillPercent === 'number' ? room.options.targetFillPercent : 100,
    status,
    playerNames: room.playerNames,
    spectatorCount: room.spectators.size
  };
}

// Раздача статики из /public — чтобы тестовый клиент открывался прямо с
// этого же сервера. На проде статику обычно отдают иначе (CDN, отдельный
// хостинг) — здесь это только для удобства локальной проверки.
function serveStatic(req, res){
  const publicDir = path.join(__dirname, 'public');
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/') reqPath = '/client.html';
  const filePath = path.join(publicDir, reqPath);
  if (!filePath.startsWith(publicDir)){
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err){ res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// Возвращает true, если запрос был обработан как /api/* маршрут (в этом
// случае вызывающий код ничего больше с res делать не должен), иначе false —
// тогда запрос отдаётся дальше на serveStatic.
async function handleApiRequest(req, res, auth, gameLog){
  const urlObj = new URL(req.url, 'http://internal');
  const urlPath = urlObj.pathname;
  if (!urlPath.startsWith('/api/')) return false;

  const cors = () => {
    // Тестовый прототип открыт для запросов с любого источника (например,
    // клиент, отданный со статического хостинга отдельно от API) — на
    // проде это стоит сузить до конкретного домена клиента.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  };
  cors();
  if (req.method === 'OPTIONS'){ res.writeHead(204); res.end(); return true; }

  if (urlPath === '/api/register' && req.method === 'POST'){
    try {
      const body = await readJsonBody(req);
      const result = auth.register(body);
      if (!result.ok) sendJson(res, 409, { error: result.reason, field: result.field });
      else sendJson(res, 201, { user: result.user, token: result.token });
    } catch (err){
      sendJson(res, err.statusCode || 400, { error: err.message || 'bad-request' });
    }
    return true;
  }

  if (urlPath === '/api/login' && req.method === 'POST'){
    try {
      const body = await readJsonBody(req);
      const result = auth.login(body);
      if (!result.ok) sendJson(res, 401, { error: result.reason });
      else sendJson(res, 200, { user: result.user, token: result.token });
    } catch (err){
      sendJson(res, err.statusCode || 400, { error: err.message || 'bad-request' });
    }
    return true;
  }

  if (urlPath === '/api/logout' && req.method === 'POST'){
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    auth.logout(token);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (urlPath === '/api/me' && req.method === 'GET'){
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const user = auth.verifySession(token);
    if (!user) sendJson(res, 401, { error: 'invalid-session' });
    else sendJson(res, 200, { user });
    return true;
  }

  // Шаг 9: статистика и логи партий (см. gamelog.js). Ничего из этого не
  // требует входа, КРОМЕ /api/stats/me и /api/stats/me/games — там "me"
  // означает "текущий вошедший пользователь", это уже не публичная выдача.
  if (urlPath === '/api/stats/me' && req.method === 'GET'){
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const user = auth.verifySession(token);
    if (!user) sendJson(res, 401, { error: 'invalid-session' });
    else sendJson(res, 200, { nickname: user.nickname, stats: gameLog.getStats(user.id) });
    return true;
  }

  if (urlPath === '/api/stats/me/games' && req.method === 'GET'){
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const user = auth.verifySession(token);
    if (!user) return sendJson(res, 401, { error: 'invalid-session' }), true;
    const limit = parseInt(urlObj.searchParams.get('limit'), 10);
    sendJson(res, 200, { games: gameLog.getRecentGames(user.id, Number.isFinite(limit) ? limit : 20) });
    return true;
  }

  if (urlPath.startsWith('/api/stats/') && req.method === 'GET'){
    // Публичная статистика по нику — например, посмотреть, как играет
    // оппонент. Отдаёт только id/ник + агрегаты, без почты.
    const nickname = decodeURIComponent(urlPath.slice('/api/stats/'.length));
    const user = auth.findPublicUserByNickname(nickname);
    if (!user) sendJson(res, 404, { error: 'user-not-found' });
    else sendJson(res, 200, { nickname: user.nickname, stats: gameLog.getStats(user.id) });
    return true;
  }

  if (urlPath.startsWith('/api/games/') && req.method === 'GET'){
    // Полный лог партии по коду комнаты: сводка + все ходы по порядку.
    // Код комнаты и так уже был известен обоим игрокам (это не секрет
    // сложнее самого приглашения в партию), поэтому эндпоинт открытый.
    const code = decodeURIComponent(urlPath.slice('/api/games/'.length));
    const found = gameLog.getGameByRoomCode(code);
    if (!found) sendJson(res, 404, { error: 'game-not-found' });
    else sendJson(res, 200, found);
    return true;
  }

  // Шаг 11: "сколько партий в базе" и "виден ли прогресс дообучения бота".
  // Открытые GET-эндпоинты, как и /api/games/:code выше, — это read-only
  // сводка без личных данных (email/пароли не выдаются), просто счётчики
  // и веса бота. Для боевого продакшена эти два эндпоинта стоит закрыть
  // отдельной админской авторизацией — здесь её сознательно нет, как и в
  // остальном прототипе (см. README, «Что дальше»).
  if (urlPath === '/api/admin/summary' && req.method === 'GET'){
    sendJson(res, 200, gameLog.getDbSummary());
    return true;
  }

  if (urlPath.startsWith('/api/bot/weights/') && req.method === 'GET'){
    const difficulty = decodeURIComponent(urlPath.slice('/api/bot/weights/'.length));
    if (!Engine.DIFFICULTY[difficulty]) return sendJson(res, 404, { error: 'unknown-difficulty' }), true;
    const limit = parseInt(urlObj.searchParams.get('limit'), 10);
    sendJson(res, 200, {
      difficulty,
      current: gameLog.getCurrentBotWeights(difficulty) || { ...Engine.BOT_WEIGHTS, meta: { source: 'default (никогда не дообучался)' } },
      history: gameLog.getBotWeightsHistory(difficulty, Number.isFinite(limit) ? limit : 50)
    });
    return true;
  }

  sendJson(res, 404, { error: 'not-found' });
  return true;
}

function sanitizeCreateOptions(raw){
  raw = raw || {};
  const options = {};
  if (typeof raw.sizeKey === 'string' && Engine.SIZES[raw.sizeKey]) options.sizeKey = raw.sizeKey;
  if (Number.isFinite(raw.targetScore)) options.targetScore = raw.targetScore;
  if (Number.isFinite(raw.targetFillPercent)) options.targetFillPercent = raw.targetFillPercent;
  return options;
}

// vsBot/botDifficulty — это метаданные КОМНАТЫ, а не движка партии
// (Engine.createMatch про бота ничего не знает — он только считает ход
// по запросу через match.botMove()). Поэтому разбираем их отдельно от
// sanitizeCreateOptions, который формирует опции именно для createMatch().
function sanitizeRoomOptions(raw){
  raw = raw || {};
  const matchOptions = sanitizeCreateOptions(raw);
  const vsBot = raw.vsBot === true;
  const botDifficulty = (typeof raw.botDifficulty === 'string' && Engine.DIFFICULTY[raw.botDifficulty])
    ? raw.botDifficulty
    : 'normal';
  // Комната с ботом никогда не публикуется в лобби — это защищённый
  // одиночный сценарий, смотреть там особо не на что, а претендовать на
  // место 2 всё равно нельзя (см. freeSeat).
  const isPublic = !vsBot && raw.isPublic === true;
  return { matchOptions, vsBot, botDifficulty, isPublic };
}

// Матчмейкинг сводит только игроков с ОДИНАКОВЫМИ настройками партии —
// иначе пришлось бы выбирать, чьи правила побеждают, что нечестно и неявно
// для игрока. Поэтому опции сначала приводятся к полному, однозначному
// виду (без "не указано"), а очередь ожидания разбита по ключу этих опций:
// одинаковые настройки -> одна и та же очередь -> первая же пара сводится.
function normalizeMatchOptions(raw){
  const o = sanitizeCreateOptions(raw);
  return {
    sizeKey: o.sizeKey || 'medium',
    targetScore: Number.isFinite(o.targetScore) ? Math.max(0, Math.min(9999, Math.floor(o.targetScore))) : 0,
    targetFillPercent: Number.isFinite(o.targetFillPercent) ? Math.max(0, Math.min(100, Math.floor(o.targetFillPercent))) : 100
  };
}
function matchOptionsKey(o){
  return `${o.sizeKey}|${o.targetScore}|${o.targetFillPercent}`;
}

function createServer(serverOptions){
  serverOptions = serverOptions || {};
  const reconnectGraceMs = serverOptions.reconnectGraceMs || DEFAULT_RECONNECT_GRACE_MS;
  const emptyRoomTtlMs = serverOptions.emptyRoomTtlMs || DEFAULT_EMPTY_ROOM_TTL_MS;

  // dbPath: ':memory:' удобно для тестов (см. test/e2e.js) — не оставляет
  // файлов на диске и каждый прогон теста начинает с чистой базы.
  const db = serverOptions.db || openDatabase(serverOptions.dbPath);
  const auth = createAuth(db);
  const gameLog = createGameLog(db);

  const {
    rooms, createRoom, getRoom, freeSeat,
    armEmptyTimer, disarmEmptyTimer,
    armSeatGraceTimer, clearSeatGraceTimer
  } = createRoomsRegistry({
    reconnectGraceMs, emptyRoomTtlMs,
    onRoomExpired: (room) => {
      gameLog.abandonIfUnfinished(room);
      // Зрители (шаг 10) не держат место и не участвуют в reconnect —
      // им нужно явное уведомление, что комната пропала из памяти сервера.
      broadcastSpectators(room, { type:'room-closed', code: room.code });
    }
  });

  // Веса оценочной функции бота — если tools/train-bot.js уже что-то
  // подобрал для этой сложности, берём последнее "поколение" из БД, иначе
  // — встроенные в движок значения по умолчанию. Чтение из bot_weights —
  // это простой индексированный SELECT в SQLite (синхронный, доли мс), так
  // что дёшево делать его при каждом ходе бота, а не только при старте
  // сервера: новое поколение весов от train-bot.js подхватывается сразу,
  // без перезапуска процесса.
  function botWeightsFor(difficulty){
    const trained = gameLog.getCurrentBotWeights(difficulty || 'normal');
    if (trained) return trained;
    return Engine.BOT_WEIGHTS;
  }

  const httpServer = http.createServer((req, res) => {
    handleApiRequest(req, res, auth, gameLog).then((handled) => {
      if (!handled) serveStatic(req, res);
    }).catch((err) => {
      console.error('API error:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal-error' });
    });
  });
  const wss = new WebSocketServer({ server: httpServer });

  // Очередь ожидания матчмейкинга: Map<optionsKey, ws[]>. Комнаты по коду
  // (шаг 3) и матчмейкинг (шаг 4) используют один и тот же createRoom() —
  // разница только в том, кто сводит игроков: сам человек (делится кодом)
  // или сервер (как только в очереди набралась пара с одинаковыми опциями).
  const matchmakingQueues = new Map();

  function removeFromQueue(ws){
    if (!ws.searching || !ws.searchKey) return;
    const queue = matchmakingQueues.get(ws.searchKey);
    if (queue){
      const idx = queue.indexOf(ws);
      if (idx !== -1) queue.splice(idx, 1);
      if (!queue.length) matchmakingQueues.delete(ws.searchKey);
    }
    ws.searching = false;
    ws.searchKey = null;
  }

  function seatWithToken(room, seat, ws, player){
    room.seats[seat] = ws;
    room.tokens[seat] = generateToken();
    room.playerNames[seat] = (player && player.nickname) || null;
    room.playerUserIds[seat] = (player && player.id) || null;
    ws.roomCode = room.code;
    ws.seat = seat;
    return room.tokens[seat];
  }

  // authToken — токен сессии из учётной записи (не путать с токеном
  // переподключения к месту в комнате, который сервер сам выдаёт в
  // room-created/room-joined и т.д.). Если он не передан, невалиден или
  // истёк — это не ошибка: игрок просто остаётся гостем без ника и без
  // привязки статистики к учётной записи.
  function resolvePlayer(authToken){
    if (!authToken) return null;
    return auth.verifySession(authToken); // {id, nickname, email} | null
  }

  // Небольшая задержка перед расчётом хода бота — чтобы ответ на ход
  // человека успел уйти раньше, чем начнётся (синхронный, блокирующий
  // event loop) перебор вариантов у бота. Сама задержка не делает расчёт
  // неблокирующим — это know limitation прототипа, см. README: при
  // реальной нагрузке с несколькими одновременными комнатами расчёт хода
  // бота стоит выносить в worker_threads, чтобы не подвешивать другие
  // комнаты на время "раздумий" бота.
  const BOT_MOVE_DELAY_MS = 30;

  // Общая точка записи хода в лог для человека и для бота — оба пути
  // ведут через applyMove() и должны одинаково попадать в moves/games,
  // поэтому вынесено отдельно, а не продублировано в двух местах.
  function recordMoveInLog(room, seat, x, y, result){
    const moveIndex = room.moveCount;
    room.moveCount += 1;
    gameLog.recordMove(room.gameId, moveIndex, seat, x, y, result.gained.length, result.scores);
    if (result.gameOver) gameLog.finish(room, result.winner, result.scores, 'rule');
  }

  function maybeTriggerBotMove(room){
    if (!room.vsBot) return;
    const snap = room.match.getSnapshot();
    if (snap.gameOver || snap.current !== room.botSeat) return;
    setTimeout(() => {
      const stillThere = getRoom(room.code);
      if (!stillThere) return; // комнату успели удалить (не должно случаться так быстро, но проверим)
      const freshSnap = stillThere.match.getSnapshot();
      if (freshSnap.gameOver || freshSnap.current !== stillThere.botSeat) return;
      const move = stillThere.match.botMove(stillThere.botDifficulty, botWeightsFor(stillThere.botDifficulty));
      if (!move) return;
      const result = stillThere.match.applyMove(stillThere.botSeat, move.x, move.y);
      if (!result.ok) return; // защитная проверка — по правилам бот всегда должен ходить легально
      recordMoveInLog(stillThere, stillThere.botSeat, move.x, move.y, result);
      broadcastRoom(stillThere, stateMessage(stillThere, { lastMove: { x: move.x, y: move.y, player: stillThere.botSeat } }));
    }, BOT_MOVE_DELAY_MS);
  }

  // Шаг 10: реванш в той же комнате — та же комната/код/правила, но новая
  // партия (новая строка в games, room.match и moveCount с нуля). Кто сидит
  // за столом (room.seats/tokens/playerNames) не трогаем — соперник тот же,
  // если он остался; если он ушёл (см. 'leave-room'), место 2 просто пустое
  // и ждёт кого угодно нового по тому же коду.
  function startRematch(room){
    room.match = Engine.createMatch(room.options);
    room.moveCount = 0;
    room.rematchVotes = new Set();
    room.gameId = gameLog.startGame(room);
    const snapshot = room.match.getSnapshot();
    [1, 2].forEach((seat) => {
      const seatWs = room.seats[seat];
      if (seatWs) send(seatWs, { type:'rematch-started', seat, token: room.tokens[seat], snapshot, playerNames: room.playerNames, vsBot: room.vsBot });
    });
    broadcastSpectators(room, { type:'state', snapshot, playerNames: room.playerNames, note:'rematch-started' });
  }

  wss.on('connection', (ws) => {
    ws.roomCode = null;
    ws.seat = null;
    ws.searching = false;
    ws.searchKey = null;
    ws.spectating = false;

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch (e){ return send(ws, { type:'error', reason:'bad-json' }); }

      if (msg.type === 'create-room'){
        if (ws.roomCode) return send(ws, { type:'error', reason:'already-in-room' });
        const { matchOptions, vsBot, botDifficulty, isPublic } = sanitizeRoomOptions(msg.options);
        const room = createRoom(matchOptions);
        room.vsBot = vsBot;
        room.botSeat = vsBot ? 2 : null;
        room.botDifficulty = vsBot ? botDifficulty : null;
        room.isPublic = isPublic;
        if (vsBot) room.playerNames[2] = botDifficulty === 'strong' ? 'Бот (сильный)' : 'Бот (обычный)';
        const token = seatWithToken(room, 1, ws, resolvePlayer(msg.authToken));
        room.gameId = gameLog.startGame(room);
        send(ws, { type:'room-created', code: room.code, seat: 1, token, snapshot: room.match.getSnapshot(), vsBot, isPublic, playerNames: room.playerNames });
        return;
      }

      if (msg.type === 'join-room'){
        if (ws.roomCode) return send(ws, { type:'error', reason:'already-in-room' });
        const room = getRoom(msg.code);
        if (!room) return send(ws, { type:'error', reason:'room-not-found' });
        const seat = freeSeat(room);
        if (!seat) return send(ws, { type:'error', reason:'room-full' });

        disarmEmptyTimer(room);
        const player = resolvePlayer(msg.authToken);
        const token = seatWithToken(room, seat, ws, player);
        gameLog.recordSecondPlayer(room.gameId, player && player.id, player && player.nickname);
        send(ws, { type:'room-joined', code: room.code, seat, token, snapshot: room.match.getSnapshot(), playerNames: room.playerNames });
        // создателю тоже нужно узнать, что оппонент сел за стол (и как его зовут)
        broadcastRoom(room, stateMessage(room, { note: 'seat-update' }));
        return;
      }

      if (msg.type === 'find-match'){
        if (ws.roomCode) return send(ws, { type:'error', reason:'already-in-room' });
        if (ws.searching) return send(ws, { type:'error', reason:'already-searching' });

        const options = normalizeMatchOptions(msg.options);
        const key = matchOptionsKey(options);
        const queue = matchmakingQueues.get(key);

        if (queue && queue.length){
          // Нашёлся ожидающий с такими же настройками — сразу сводим пару.
          const partner = queue.shift();
          if (!queue.length) matchmakingQueues.delete(key);
          partner.searching = false;
          partner.searchKey = null;

          const room = createRoom(options);
          const tokenPartner = seatWithToken(room, 1, partner, resolvePlayer(partner.pendingAuthToken));
          const tokenSelf = seatWithToken(room, 2, ws, resolvePlayer(msg.authToken));
          room.gameId = gameLog.startGame(room);

          const snapshot = room.match.getSnapshot();
          send(partner, { type:'match-found', code: room.code, seat: 1, token: tokenPartner, snapshot, playerNames: room.playerNames });
          send(ws, { type:'match-found', code: room.code, seat: 2, token: tokenSelf, snapshot, playerNames: room.playerNames });
          return;
        }

        // Пары нет — встаём в очередь ждать следующего с такими же опциями.
        // authToken запоминаем на ws — сведение пары происходит в момент,
        // когда сообщение find-match присылает уже ВТОРОЙ игрок, поэтому
        // ник первого (partner) нужно достать из его собственного запроса,
        // сохранённого на его сокете, а не из текущего msg.
        ws.searching = true;
        ws.searchKey = key;
        ws.pendingAuthToken = msg.authToken || null;
        if (!matchmakingQueues.has(key)) matchmakingQueues.set(key, []);
        matchmakingQueues.get(key).push(ws);
        send(ws, { type:'searching' });
        return;
      }

      if (msg.type === 'cancel-find'){
        if (!ws.searching) return send(ws, { type:'error', reason:'not-searching' });
        removeFromQueue(ws);
        send(ws, { type:'search-cancelled' });
        return;
      }

      if (msg.type === 'list-rooms'){
        const list = [];
        for (const room of rooms.values()){
          const entry = roomListEntry(room);
          if (entry) list.push(entry);
        }
        send(ws, { type:'room-list', rooms: list });
        return;
      }

      if (msg.type === 'spectate-room'){
        if (ws.roomCode) return send(ws, { type:'error', reason:'already-in-room' });
        const room = getRoom(msg.code);
        if (!room) return send(ws, { type:'error', reason:'room-not-found' });
        if (!room.isPublic) return send(ws, { type:'error', reason:'room-not-public' });
        room.spectators.add(ws);
        ws.roomCode = room.code;
        ws.seat = null; // зритель не занимает место — отличает его от игрока в обработчиках ниже
        ws.spectating = true;
        send(ws, { type:'spectate-joined', code: room.code, snapshot: room.match.getSnapshot(), playerNames: room.playerNames, vsBot: room.vsBot });
        return;
      }

      if (msg.type === 'leave-room'){
        // Немедленный, явный уход — в отличие от обрыва связи (ws close),
        // не ждёт reconnectGraceMs: место сразу же становится свободным,
        // чтобы по тому же коду мог зайти другой игрок (см. README, шаг 10).
        if (ws.spectating){
          const room = getRoom(ws.roomCode);
          if (room) room.spectators.delete(ws);
          ws.roomCode = null; ws.seat = null; ws.spectating = false;
          send(ws, { type:'left-room' });
          return;
        }
        const room = getRoom(ws.roomCode);
        if (!room || !ws.seat) return send(ws, { type:'error', reason:'not-in-room' });
        const seat = ws.seat;
        clearSeatGraceTimer(room, seat);
        room.seats[seat] = null;
        room.tokens[seat] = null;
        room.rematchVotes.delete(seat);
        ws.roomCode = null; ws.seat = null;
        send(ws, { type:'left-room' });
        broadcastRoom(room, { type:'opponent-left', seat });
        if (!room.seats[1] && !room.seats[2]) armEmptyTimer(room);
        return;
      }

      if (msg.type === 'reconnect'){
        if (ws.roomCode) return send(ws, { type:'error', reason:'already-in-room' });
        const room = getRoom(msg.code);
        const seat = msg.seat;
        if (!room || (seat !== 1 && seat !== 2)) return send(ws, { type:'error', reason:'reconnect-failed' });
        if (!room.tokens[seat] || room.tokens[seat] !== msg.token) return send(ws, { type:'error', reason:'reconnect-failed' });
        if (room.seats[seat]) return send(ws, { type:'error', reason:'seat-occupied' });

        clearSeatGraceTimer(room, seat);
        disarmEmptyTimer(room);
        room.seats[seat] = ws;
        ws.roomCode = room.code;
        ws.seat = seat;
        // Ник/учётку переподключившегося не трогаем, если он не прислал
        // новый authToken (например, просто открыл вкладку заново, не
        // логинясь повторно) — иначе бот/гостевые места теряли бы имя при
        // реконнекте. Итоговые значения для лога партии фиксируются позже,
        // при её завершении (см. gameLog.finish в 'move'/'end' ниже).
        const reconnectedPlayer = resolvePlayer(msg.authToken);
        if (reconnectedPlayer){
          room.playerNames[seat] = reconnectedPlayer.nickname;
          room.playerUserIds[seat] = reconnectedPlayer.id;
        }

        send(ws, { type:'reconnected', code: room.code, seat, token: room.tokens[seat], snapshot: room.match.getSnapshot(), vsBot: room.vsBot, playerNames: room.playerNames });
        const otherSeat = seat === 1 ? 2 : 1;
        send(room.seats[otherSeat], stateMessage(room, { note: 'opponent-reconnected', seat }));
        return;
      }

      const room = getRoom(ws.roomCode);
      if (!room || !ws.seat) return send(ws, { type:'error', reason:'not-in-room' });

      if (msg.type === 'move'){
        const result = room.match.applyMove(ws.seat, msg.x, msg.y);
        if (!result.ok) return send(ws, { type:'error', reason: result.reason });
        recordMoveInLog(room, ws.seat, msg.x, msg.y, result);
        broadcastRoom(room, stateMessage(room, { lastMove: { x: msg.x, y: msg.y, player: ws.seat } }));
        maybeTriggerBotMove(room);
        return;
      }

      if (msg.type === 'end'){
        const result = room.match.endNow();
        if (!result.ok) return send(ws, { type:'error', reason: result.reason });
        gameLog.finish(room, result.winner, result.scores, 'manual');
        broadcastRoom(room, stateMessage(room));
        return;
      }

      if (msg.type === 'rematch'){
        if (!room.match.getSnapshot().gameOver) return send(ws, { type:'error', reason:'game-not-over' });
        const seat = ws.seat;
        room.rematchVotes.add(seat);
        const opponentSeat = seat === 1 ? 2 : 1;
        const opponentWs = room.seats[opponentSeat];
        // Против бота, или если за столом больше никого нет (второе место
        // свободно — соперник ушёл), согласие второй стороны спрашивать не
        // у кого, реванш стартует сразу по одному запросу.
        const bothReady = room.vsBot || !opponentWs || room.rematchVotes.has(opponentSeat);
        if (bothReady) startRematch(room);
        else send(opponentWs, { type:'rematch-requested', seat });
        return;
      }

      send(ws, { type:'error', reason:'unknown-message-type' });
    });

    ws.on('close', () => {
      removeFromQueue(ws);
      const room = getRoom(ws.roomCode);
      if (!room) return;
      if (ws.spectating){
        room.spectators.delete(ws);
        return;
      }
      if (ws.seat && room.seats[ws.seat] === ws){
        const seat = ws.seat;
        room.seats[seat] = null;
        room.rematchVotes.delete(seat);
        broadcastRoom(room, { type:'opponent-disconnected', seat, graceMs: reconnectGraceMs });
        armSeatGraceTimer(room, seat, () => {
          broadcastRoom(room, { type:'opponent-left', seat });
          if (!room.seats[1] && !room.seats[2]) armEmptyTimer(room);
        });
      }
    });
  });

  return { httpServer, wss, rooms, db, auth, gameLog };
}

if (require.main === module){
  const PORT = process.env.PORT || 8080;
  const { httpServer } = createServer();
  httpServer.listen(PORT, () => {
    console.log(`Tochki multiplayer server: http://localhost:${PORT}`);
    console.log('Один игрок создаёт комнату и получает код, второй присоединяется по этому коду.');
  });
}

module.exports = { createServer };
