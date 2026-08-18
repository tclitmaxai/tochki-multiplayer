// gamelog.js
//
// Шаг 9: персистентный лог партий (одна строка в `games` на партию,
// полный список ходов в `moves`) и статистика по игрокам, вычисляемая
// агрегирующим SQL-запросом по `games` — НЕ отдельным счётчиком, который
// пришлось бы держать в синхронизации ходом каждой партии и который рано
// или поздно разойдётся с реальностью при любом пропущенном обновлении.
// Источник правды — таблица games, статистика всегда пересчитывается из
// неё заново.

// end_reason: 'rule' — партия окончена по правилам (целевой счёт/заполнение
// поля), 'manual' — игрок нажал «Закончить игру», 'abandoned' — комната
// удалена по таймауту недоигранной (никто не вернулся после разрыва).
// 'abandoned' НЕ считается в статистике побед/поражений — только 'finished'.

const Engine = require('./gameEngine.js');

function createGameLog(db){
  const insertGame = db.prepare(`
    INSERT INTO games (
      room_code, size_key, target_score, target_fill_percent, vs_bot, bot_difficulty,
      player1_user_id, player1_name, player2_user_id, player2_name,
      status, started_at
    ) VALUES (@roomCode, @sizeKey, @targetScore, @targetFillPercent, @vsBot, @botDifficulty,
              @player1UserId, @player1Name, @player2UserId, @player2Name,
              'in_progress', @startedAt)
  `);
  const setPlayer2 = db.prepare(
    `UPDATE games SET player2_user_id = @userId, player2_name = @name WHERE id = @gameId AND status = 'in_progress'`
  );
  const insertMove = db.prepare(`
    INSERT INTO moves (game_id, move_index, seat, x, y, captured, score1_after, score2_after, created_at)
    VALUES (@gameId, @moveIndex, @seat, @x, @y, @captured, @score1After, @score2After, @createdAt)
  `);
  const finishGame = db.prepare(`
    UPDATE games SET
      status = 'finished', winner_seat = @winnerSeat, score1 = @score1, score2 = @score2,
      end_reason = @endReason, player1_name = @player1Name, player2_name = @player2Name,
      player1_user_id = @player1UserId, player2_user_id = @player2UserId, ended_at = @endedAt
    WHERE id = @gameId AND status = 'in_progress'
  `);
  const abandonGame = db.prepare(`
    UPDATE games SET status = 'abandoned', end_reason = 'abandoned', ended_at = @endedAt
    WHERE id = @gameId AND status = 'in_progress'
  `);

  const gameById = db.prepare(`SELECT * FROM games WHERE id = ?`);
  const gameByRoomCode = db.prepare(`SELECT * FROM games WHERE room_code = ? ORDER BY id DESC LIMIT 1`);
  const movesByGameId = db.prepare(
    `SELECT move_index, seat, x, y, captured, score1_after, score2_after, created_at
       FROM moves WHERE game_id = ? ORDER BY move_index ASC`
  );

  // status='finished' — только по-настоящему доигранные партии считаются
  // в статистике; заброшенные (abandoned) в неё не попадают вовсе.
  const statsStmt = db.prepare(`
    SELECT
      COUNT(*) AS gamesPlayed,
      SUM(CASE WHEN (player1_user_id = @uid AND winner_seat = 1)
                 OR (player2_user_id = @uid AND winner_seat = 2) THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN (player1_user_id = @uid AND winner_seat = 2)
                 OR (player2_user_id = @uid AND winner_seat = 1) THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN winner_seat = 0 THEN 1 ELSE 0 END) AS draws,
      SUM(CASE WHEN vs_bot = 1 THEN 1 ELSE 0 END) AS gamesVsBot
    FROM games
    WHERE status = 'finished' AND (player1_user_id = @uid OR player2_user_id = @uid)
  `);

  const recentGamesStmt = db.prepare(`
    SELECT id, room_code, size_key, vs_bot, bot_difficulty,
           player1_user_id, player1_name, player2_user_id, player2_name,
           winner_seat, score1, score2, end_reason, started_at, ended_at
    FROM games
    WHERE status = 'finished' AND (player1_user_id = @uid OR player2_user_id = @uid)
    ORDER BY ended_at DESC
    LIMIT @limit
  `);

  // Текущие "боевые" веса для сложности — последняя (максимальный id) строка
  // в bot_weights. Если для этой сложности ещё ничего не обучалось — null,
  // и вызывающий код (server.js) должен подставить дефолт из gameEngine.js.
  const currentWeightsStmt = db.prepare(`
    SELECT potential, cohesion, stones, liberty, source, win_rate, games_played, created_at
    FROM bot_weights WHERE difficulty = ? ORDER BY id DESC LIMIT 1
  `);
  const insertWeights = db.prepare(`
    INSERT INTO bot_weights (difficulty, potential, cohesion, stones, liberty, source, win_rate, games_played, note, created_at)
    VALUES (@difficulty, @potential, @cohesion, @stones, @liberty, @source, @winRate, @gamesPlayed, @note, @createdAt)
  `);
  // Шаг 11: видимость прогресса дообучения бота и общего объёма БД —
  // см. getDbSummary()/getBotWeightsHistory() ниже и /api/admin/summary,
  // /api/bot/weights/:difficulty в server.js.
  const gamesCountByStatusStmt = db.prepare(`SELECT status, COUNT(*) AS n FROM games GROUP BY status`);
  const movesCountStmt = db.prepare(`SELECT COUNT(*) AS n FROM moves`);
  const usersCountStmt = db.prepare(`SELECT COUNT(*) AS n FROM users`);
  const botWeightsCountStmt = db.prepare(`SELECT difficulty, COUNT(*) AS n FROM bot_weights GROUP BY difficulty`);
  const botWeightsHistoryStmt = db.prepare(`
    SELECT id, potential, cohesion, stones, liberty, source, win_rate, games_played, note, created_at
    FROM bot_weights WHERE difficulty = ? ORDER BY id DESC
  `);

  function getCurrentBotWeights(difficulty){
    const row = currentWeightsStmt.get(difficulty);
    if (!row) return null;
    return {
      potential: row.potential, cohesion: row.cohesion, stones: row.stones, liberty: row.liberty,
      meta: { source: row.source, winRate: row.win_rate, gamesPlayed: row.games_played, createdAt: row.created_at }
    };
  }

  // Вызывается из tools/train-bot.js по итогам self-play подбора — сохраняет
  // новое "поколение" весов, не трогая предыдущие (история подбора).
  function saveBotWeights(difficulty, weights, meta){
    meta = meta || {};
    insertWeights.run({
      difficulty,
      potential: weights.potential, cohesion: weights.cohesion,
      stones: weights.stones, liberty: weights.liberty,
      source: meta.source || 'trained',
      winRate: typeof meta.winRate === 'number' ? meta.winRate : null,
      gamesPlayed: typeof meta.gamesPlayed === 'number' ? meta.gamesPlayed : null,
      note: meta.note || null,
      createdAt: Date.now()
    });
  }

  // Выборка сыгранных партий для обучения: полные списки ходов доигранных
  // партий (по умолчанию — все, не только против бота: партии человек-человек
  // тоже ценны, из них tools/train-bot.js берёт реальные дебютные ходы людей,
  // чтобы self-play не варился в собственном соку одинаковых открытий).
  // status='finished' — abandoned не участвуют, там нет осмысленного исхода.
  function getFinishedGamesForTraining(opts){
    opts = opts || {};
    const limit = Math.max(1, Math.min(5000, opts.limit || 500));
    const rows = db.prepare(`
      SELECT id, size_key, target_score, target_fill_percent, vs_bot, bot_difficulty,
             winner_seat, score1, score2, end_reason, started_at, ended_at
      FROM games
      WHERE status = 'finished' ${opts.vsBotOnly ? 'AND vs_bot = 1' : ''}
      ORDER BY ended_at DESC
      LIMIT @limit
    `).all({ limit });
    return rows.map(g => ({ game: g, moves: movesByGameId.all(g.id) }));
  }

  // Партия создаётся в БД сразу при создании комнаты (а не при первом
  // ходе) — так в лог попадают и партии, где второй игрок так и не
  // подключился (см. abandonIfUnfinished), это тоже полезная информация.
  function startGame(room){
    const rules = room.match.getSnapshot().rules;
    const info = insertGame.run({
      roomCode: room.code,
      sizeKey: room.match.sizeKey,
      targetScore: rules.targetScore,
      targetFillPercent: rules.targetFillPercent,
      vsBot: room.vsBot ? 1 : 0,
      botDifficulty: room.vsBot ? room.botDifficulty : null,
      player1UserId: room.playerUserIds[1] || null,
      player1Name: room.playerNames[1] || null,
      player2UserId: room.playerUserIds[2] || null,
      player2Name: room.playerNames[2] || null,
      startedAt: Date.now()
    });
    return info.lastInsertRowid;
  }

  function recordSecondPlayer(gameId, userId, name){
    if (!gameId) return;
    setPlayer2.run({ gameId, userId: userId || null, name: name || null });
  }

  // moveIndex ведёт сам room.moveCount (см. server.js) — здесь только
  // пишем то, что нам передали, никакой собственной нумерации.
  function recordMove(gameId, moveIndex, seat, x, y, captured, scores){
    if (!gameId) return;
    insertMove.run({
      gameId, moveIndex, seat, x, y,
      captured: captured || 0,
      score1After: scores[1], score2After: scores[2],
      createdAt: Date.now()
    });
  }

  // Имена/user_id фиксируются в момент завершения (а не создания) — см.
  // комментарий у CREATE TABLE games в db.js: так в логе партии остаётся
  // ник, под которым игрок её доиграл, даже если перелогинился на середине.
  function finish(room, winnerSeat, scores, endReason){
    if (!room.gameId) return;
    finishGame.run({
      gameId: room.gameId,
      winnerSeat,
      score1: scores[1], score2: scores[2],
      endReason,
      player1Name: room.playerNames[1] || null,
      player2Name: room.playerNames[2] || null,
      player1UserId: room.playerUserIds[1] || null,
      player2UserId: room.playerUserIds[2] || null,
      endedAt: Date.now()
    });
  }

  // Вызывается, когда комната удаляется по таймауту с недоигранной
  // партией (см. armEmptyTimer в server.js). Партия, которую вообще
  // никто не начинал (0 ходов, второй игрок не подключился), тоже
  // помечается abandoned — это осознанно: она уже занимает строку с
  // started_at и хотя бы могла бы кому-то пригодиться в общем логе,
  // просто не участвует в статистике побед/поражений.
  function abandonIfUnfinished(room){
    if (!room.gameId) return;
    abandonGame.run({ gameId: room.gameId, endedAt: Date.now() });
  }

  function getGameByRoomCode(code){
    const game = gameByRoomCode.get(String(code || '').toUpperCase());
    if (!game) return null;
    const moves = movesByGameId.all(game.id);
    return { game, moves };
  }

  function getStats(userId){
    const row = statsStmt.get({ uid: userId });
    const gamesPlayed = row.gamesPlayed || 0;
    const wins = row.wins || 0;
    const losses = row.losses || 0;
    const draws = row.draws || 0;
    return {
      gamesPlayed, wins, losses, draws,
      gamesVsBot: row.gamesVsBot || 0,
      winRate: gamesPlayed > 0 ? Math.round((wins / gamesPlayed) * 1000) / 10 : 0
    };
  }

  function getRecentGames(userId, limit){
    return recentGamesStmt.all({ uid: userId, limit: Math.max(1, Math.min(100, limit || 20)) });
  }

  // Шаг 11: "сколько партий сохранено в базе" и "виден ли прогресс
  // дообучения бота" — сводка по всей БД, без привязки к конкретному
  // пользователю. totalGames = сумма games.status (in_progress/finished/
  // abandoned); botWeights[difficulty].generations — сколько раз
  // tools/train-bot.js УЖЕ сохранял новое поколение весов для этой
  // сложности (см. saveBotWeights) — если 0, дообучение для неё ни разу
  // не запускали, и бот играет на встроенных в gameEngine.js дефолтах.
  function getDbSummary(){
    const byStatus = {};
    for (const row of gamesCountByStatusStmt.all()) byStatus[row.status] = row.n;
    const totalGames = Object.values(byStatus).reduce((a, b) => a + b, 0);
    const botWeights = {};
    for (const difficulty of Object.keys(Engine.DIFFICULTY)){
      const current = currentWeightsStmt.get(difficulty);
      const countRow = botWeightsCountStmt.all().find((r) => r.difficulty === difficulty);
      botWeights[difficulty] = {
        generations: countRow ? countRow.n : 0,
        current: current ? {
          potential: current.potential, cohesion: current.cohesion,
          stones: current.stones, liberty: current.liberty,
          source: current.source, winRate: current.win_rate,
          gamesPlayed: current.games_played, createdAt: current.created_at
        } : null // null = дообучение для этой сложности ещё ни разу не запускали
      };
    }
    return {
      totalGames,
      gamesByStatus: byStatus,
      totalMoves: movesCountStmt.get().n,
      totalUsers: usersCountStmt.get().n,
      botWeights
    };
  }

  // Полная история поколений весов для одной сложности — самый новый
  // первым. Это и есть "лог обучения бота": каждая строка — один прогон
  // tools/train-bot.js (или его часть, если он остановился на поколении,
  // не улучшившем эталон, — тогда предыдущая строка так и останется
  // последней). note хранит короткое описание прогона (см. train-bot.js).
  function getBotWeightsHistory(difficulty, limit){
    const rows = botWeightsHistoryStmt.all(difficulty);
    return rows.slice(0, Math.max(1, Math.min(200, limit || 50)));
  }

  return {
    startGame, recordSecondPlayer, recordMove, finish, abandonIfUnfinished,
    getGameByRoomCode, getStats, getRecentGames,
    getCurrentBotWeights, saveBotWeights, getFinishedGamesForTraining,
    getDbSummary, getBotWeightsHistory
  };
}

module.exports = { createGameLog };
