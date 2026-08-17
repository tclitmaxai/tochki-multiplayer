// db.js
//
// Шаг 7 плана: персистентное хранилище учётных записей. Шаг 9: то же для
// логов партий (games/moves) и производной от них статистики по игрокам.
// Комнаты по-прежнему живут в памяти процесса, пока партия не завершится
// или не будет заброшена — это сознательно не меняем, см. README ("Что
// дальше"): персистентны сами партии (для истории/статистики), а не
// текущее сетевое состояние комнаты (сокеты, таймеры реконнекта и т.п.).
//
// SQLite через better-sqlite3: синхронный API, один файл на диске,
// ничего дополнительного разворачивать не нужно — подходит для одного
// процесса сервера (см. README про варианты деплоя).

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

function openDatabase(dbPath){
  dbPath = dbPath || process.env.DB_PATH || path.join(__dirname, 'data', 'tochki.db');

  // ':memory:' — отдельный случай для тестов: должен остаться как есть,
  // никакую директорию под него создавать не нужно.
  if (dbPath !== ':memory:'){
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      nickname          TEXT NOT NULL,
      nickname_norm     TEXT NOT NULL,
      email             TEXT NOT NULL,
      email_norm        TEXT NOT NULL,
      password_hash     TEXT NOT NULL,
      created_at        INTEGER NOT NULL
    );

    -- Уникальность без учёта регистра нужна и для кириллицы, а встроенный
    -- в SQLite COLLATE NOCASE понимает только ASCII A-Z. Поэтому регистр
    -- нормализуется на стороне приложения (String.toLowerCase() из auth.js,
    -- корректно работает и для не-ASCII алфавитов) и уникальность
    -- проверяется по отдельным *_norm колонкам, а не через COLLATE NOCASE.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_nickname_norm
      ON users (nickname_norm);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_norm
      ON users (email_norm);

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);

    -- Шаг 9: одна строка на партию (не на комнату — если в комнате сыграли
    -- вничью и открыли ещё одну партию, это отдельная строка). Статус
    -- 'in_progress' пока партия не окончена; 'finished' — окончена по
    -- правилам ИЛИ вручную (см. end_reason); 'abandoned' — комнату убрали
    -- по таймауту недоигранной (никто не вернулся) — такие НЕ считаются
    -- в статистике побед/поражений, только в общем логе.
    --
    -- player{N}_user_id — учётная запись, если игрок был залогинен, иначе
    -- NULL (гость или бот). player{N}_name — ФИКСИРУЕТСЯ на момент
    -- завершения партии (а не создания комнаты), чтобы ник в логе partии
    -- совпадал с тем, под каким игрок доиграл её до конца, даже если он
    -- успел перелогиниться между ходами (см. authToken при reconnect).
    CREATE TABLE IF NOT EXISTS games (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      room_code            TEXT NOT NULL,
      size_key             TEXT NOT NULL,
      target_score         INTEGER NOT NULL,
      target_fill_percent  INTEGER NOT NULL,
      vs_bot               INTEGER NOT NULL DEFAULT 0,
      bot_difficulty       TEXT,
      player1_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      player2_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      player1_name         TEXT,
      player2_name         TEXT,
      status               TEXT NOT NULL DEFAULT 'in_progress',
      winner_seat          INTEGER,
      score1               INTEGER,
      score2               INTEGER,
      end_reason           TEXT,
      started_at           INTEGER NOT NULL,
      ended_at             INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_games_player1 ON games (player1_user_id);
    CREATE INDEX IF NOT EXISTS idx_games_player2 ON games (player2_user_id);
    CREATE INDEX IF NOT EXISTS idx_games_room_code ON games (room_code);
    CREATE INDEX IF NOT EXISTS idx_games_status ON games (status);

    -- Полный лог ходов — по одной строке на КАЖДЫЙ реально применённый ход
    -- (человека или бота), в порядке партии. score{N}_after — счёт СРАЗУ
    -- после этого хода, чтобы можно было восстановить график партии по
    -- ходам, не переигрывая её заново через движок.
    CREATE TABLE IF NOT EXISTS moves (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id       INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      move_index    INTEGER NOT NULL,
      seat          INTEGER NOT NULL,
      x             INTEGER NOT NULL,
      y             INTEGER NOT NULL,
      captured      INTEGER NOT NULL DEFAULT 0,
      score1_after  INTEGER NOT NULL,
      score2_after  INTEGER NOT NULL,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_moves_game_id ON moves (game_id);

    -- Веса оценочной функции бота (см. BOT_WEIGHTS в gameEngine.js).
    -- Одна строка на "поколение" весов — history, не перезапись; текущими
    -- считаются веса с наибольшим id для данного difficulty. Так храним
    -- историю подбора (tools/train-bot.js) и всегда можем откатиться.
    -- source: 'default' — встроенные в код значения, 'trained' — подобраны
    -- self-play подбором.
    CREATE TABLE IF NOT EXISTS bot_weights (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      difficulty     TEXT NOT NULL,
      potential      REAL NOT NULL,
      cohesion       REAL NOT NULL,
      stones         REAL NOT NULL,
      liberty        REAL NOT NULL,
      source         TEXT NOT NULL DEFAULT 'trained',
      win_rate       REAL,
      games_played   INTEGER,
      note           TEXT,
      created_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bot_weights_difficulty ON bot_weights (difficulty, id);
  `);

  return db;
}

module.exports = { openDatabase };
