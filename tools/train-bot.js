#!/usr/bin/env node
// tools/train-bot.js
//
// Офлайн self-play подбор весов оценочной функции бота (см. BOT_WEIGHTS /
// evaluateStatic в gameEngine.js). У бота нет нейросети и нет обучаемых
// параметров в духе градиентного спуска — есть только вектор весов
// (potential, cohesion, stones, liberty) внутри альфа-бета поиска.
// "Обучение на партиях" здесь означает две связанные вещи:
//
//  1. self-play — движок играет сам с собой множеством вариантов весов;
//     побеждающий вариант становится новым эталоном. Это простой (1+λ)-ES
//     (эволюционная стратегия с одним родителем и λ потомками за
//     поколение) — минимально сложный метод, который реально работает
//     для 4-параметрового вектора весов и не требует ни датасета
//     размеченных позиций, ни фреймворков машинного обучения;
//
//  2. реальные дебюты людей из БД (games/moves — независимо от того, кто
//     играл, человек или бот; важно только что партия доиграна) берутся
//     как стартовые позиции self-play партий. Без этого подбор весов
//     оценивался бы только на дебютах "бот против бота играет как ему
//     привычно" — а нас как раз интересует сила бота в позициях, которые
//     реально возникают в игре с людьми (в т.ч. попытки окружения).
//
// Запуск (из папки multiplayer/):
//   node tools/train-bot.js
//   node tools/train-bot.js --difficulty strong --generations 8 --population 6 --games 12
//   node tools/train-bot.js --db ./data/tochki.db   (по умолчанию — тот же файл, что у сервера)
//
// Пишет итоговый вектор весов в таблицу bot_weights (см. db.js/gamelog.js),
// НЕ трогая предыдущие поколения (история). server.js подхватывает новые
// веса на следующем ходе бота — перезапуск процесса не нужен (см.
// botWeightsFor() в server.js).
//
// Важно про стоимость: self-play использует Engine.TRAIN_DIFF (быстрые
// настройки поиска, см. gameEngine.js) — это специально урезанная сила
// бота ради скорости самих партий, НЕ финальная сила, с которой играют
// люди (та берётся из DIFFICULTY.normal/strong при реальной игре). Полный
// прогон с дефолтными параметрами — это задача для cron/ночного job, а не
// для "подождать 10 секунд в терминале"; смотрите --generations/--population
// /--games ниже, чтобы оценить порядок времени под вашу машину.

const Engine = require('../gameEngine.js');
const { openDatabase } = require('../db.js');
const { createGameLog } = require('../gamelog.js');

function parseArgs(argv){
  const out = {
    difficulty: 'strong', generations: 4, population: 4, games: 8,
    dbPath: undefined, sizeKey: 'medium', seed: Date.now() >>> 0
  };
  for (let i = 0; i < argv.length; i++){
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--difficulty') out.difficulty = val();
    else if (a === '--generations') out.generations = parseInt(val(), 10);
    else if (a === '--population') out.population = parseInt(val(), 10);
    else if (a === '--games') out.games = parseInt(val(), 10);
    else if (a === '--db') out.dbPath = val();
    else if (a === '--size') out.sizeKey = val();
    else if (a === '--seed') out.seed = parseInt(val(), 10) >>> 0;
  }
  return out;
}

// Небольшой детерминированный ГПСЧ (xorshift32) — чтобы прогон с тем же
// --seed был воспроизводим: та же выборка дебютов, те же случайные веса.
// Math.random() для этого не подходит (не параметризуется сидом).
function makeRng(seed){
  let s = (seed >>> 0) || 1;
  return function(){
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

const WEIGHT_KEYS = ['potential', 'cohesion', 'stones', 'liberty'];
// Границы не дают подбору уйти в абсурдные значения — например,
// отрицательный liberty означал бы «поощрять собственное окружение».
const WEIGHT_BOUNDS = {
  potential: [1, 16],
  cohesion:  [0.1, 5],
  stones:    [0, 1],
  liberty:   [0, 20]
};

function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

function mutate(weights, rng, strength){
  const out = {};
  for (const k of WEIGHT_KEYS){
    const [lo, hi] = WEIGHT_BOUNDS[k];
    const span = hi - lo;
    const delta = (rng() * 2 - 1) * span * strength;
    out[k] = Math.round(clamp((weights[k] ?? (lo + hi) / 2) + delta, lo, hi) * 100) / 100;
  }
  return out;
}

// ---------- Дебюты людей из лога партий ----------

function loadOpenings(gameLog, sizeKey, maxPrefixLen){
  const games = gameLog.getFinishedGamesForTraining({ limit: 500 });
  const openings = [];
  for (const { game, moves } of games){
    if (game.size_key !== sizeKey) continue;
    if (!moves.length) continue;
    const prefixLen = Math.min(maxPrefixLen, moves.length);
    const prefix = moves.slice(0, prefixLen).map(m => ({ x: m.x, y: m.y, seat: m.seat }));
    openings.push({
      prefix,
      targetScore: game.target_score,
      targetFillPercent: game.target_fill_percent
    });
  }
  return openings;
}

// ---------- Одна self-play партия между двумя наборами весов ----------

function pickMove(match, weights){
  const snap = match.getSnapshot();
  // getSnapshot() уже отдаёт свежие копии stone/dead/territory (см.
  // createMatch в gameEngine.js) — этого достаточно для chooseMove, ему не
  // нужны внутренние поля матча.
  const state = { stone: snap.stone, dead: snap.dead, territory: snap.territory };
  return Engine.chooseMove(state, snap.rows, snap.cols, snap.current, Engine.TRAIN_DIFF, weights);
}

// weightsBySeat: {1: weights, 2: weights}. Возвращает 1, 2 или 0 (ничья).
function playSelfPlayGame(sizeKey, opening, weightsBySeat, maxMoves){
  const match = Engine.createMatch({
    sizeKey,
    targetScore: opening ? opening.targetScore : 0,
    targetFillPercent: opening ? opening.targetFillPercent : 35
  });

  if (opening){
    for (const mv of opening.prefix){
      const res = match.applyMove(mv.seat, mv.x, mv.y);
      // Несовместимый/повреждённый дебют (например race between sizeKey и
      // реальными границами доски) — не роняем прогон, просто доигрываем
      // self-play с той позиции, до которой дошли.
      if (!res.ok) break;
      if (res.gameOver) return res.winner;
    }
  }

  let moves = 0;
  while (moves < maxMoves){
    const snap = match.getSnapshot();
    if (snap.gameOver) break;
    const weights = weightsBySeat[snap.current];
    const move = pickMove(match, weights);
    if (!move) break; // нет легальных ходов — доска заполнена
    const res = match.applyMove(snap.current, move.x, move.y);
    if (!res.ok) break; // защитная проверка, по правилам не должно случаться
    moves++;
    if (res.gameOver) break;
  }
  const finalSnap = match.getSnapshot();
  const s1 = finalSnap.scores[1], s2 = finalSnap.scores[2];
  return s1 > s2 ? 1 : (s2 > s1 ? 2 : 0);
}

// Играем `games` партий кандидата против эталона, меняя местами места 1/2
// через раз — иначе один из наборов весов систематически получал бы
// преимущество/недостаток первого хода (право первого хода в этой игре
// значимо, как и в го).
function contest(sizeKey, openings, incumbent, candidate, games, rng){
  let candidateWins = 0, incumbentWins = 0, draws = 0;
  for (let i = 0; i < games; i++){
    const opening = openings.length ? openings[Math.floor(rng() * openings.length)] : null;
    const candidateSeat = (i % 2) + 1;
    const weightsBySeat = candidateSeat === 1
      ? { 1: candidate, 2: incumbent }
      : { 1: incumbent, 2: candidate };
    const winner = playSelfPlayGame(sizeKey, opening, weightsBySeat, 260);
    if (winner === 0) draws++;
    else if (winner === candidateSeat) candidateWins++;
    else incumbentWins++;
  }
  return { candidateWins, incumbentWins, draws, winRate: (candidateWins + draws * 0.5) / games };
}

function main(){
  const args = parseArgs(process.argv.slice(2));
  const rng = makeRng(args.seed);

  // Без --db открывает тот же файл, что и сервер по умолчанию (см.
  // DB_PATH / data/tochki.db в db.js) — тренируемся на реальном
  // накопленном логе партий этого же деплоя.
  const db = openDatabase(args.dbPath);
  const gameLog = createGameLog(db);

  const openings = loadOpenings(gameLog, args.sizeKey, 6);
  console.log(`Дебютов из БД для sizeKey=${args.sizeKey}: ${openings.length}` +
    (openings.length ? '' : ' (нет подходящих доигранных партий — self-play стартует с пустой доски)'));

  let incumbent = gameLog.getCurrentBotWeights(args.difficulty) || { ...Engine.BOT_WEIGHTS };
  let incumbentLabel = 'стартовые (БД или дефолт из движка)';
  console.log('Стартовые веса:', incumbent);

  let totalGamesPlayed = 0;
  let lastWinRate = null;

  for (let gen = 1; gen <= args.generations; gen++){
    // Сила мутации затухает от поколения к поколению — сперва грубый
    // поиск по всему диапазону, затем всё более тонкая подстройка вокруг
    // текущего эталона.
    const strength = Math.max(0.08, 0.35 * (1 - gen / (args.generations + 1)));
    let bestCandidate = null, bestResult = null;

    for (let p = 0; p < args.population; p++){
      const candidate = mutate(incumbent, rng, strength);
      const result = contest(args.sizeKey, openings, incumbent, candidate, args.games, rng);
      totalGamesPlayed += args.games;
      console.log(
        `  поколение ${gen}, кандидат ${p + 1}/${args.population}: ` +
        `winRate=${result.winRate.toFixed(2)} (${result.candidateWins}W/${result.incumbentWins}L/${result.draws}D)` +
        ` weights=${JSON.stringify(candidate)}`
      );
      if (!bestResult || result.winRate > bestResult.winRate){
        bestResult = result;
        bestCandidate = candidate;
      }
    }

    // Порог 0.55, а не 0.5 — партии self-play короткие и играются на
    // урезанном TRAIN_DIFF, поэтому в разнице 0.50-0.55 больше шума, чем
    // сигнала; принимаем эталон только при заметном перевесе.
    if (bestResult.winRate > 0.55){
      incumbent = bestCandidate;
      lastWinRate = bestResult.winRate;
      incumbentLabel = `поколение ${gen}`;
      console.log(`  -> новый эталон (${incumbentLabel}), winRate=${bestResult.winRate.toFixed(2)}`);
    } else {
      console.log(`  -> поколение ${gen} не улучшило эталон (лучший winRate=${bestResult.winRate.toFixed(2)})`);
    }
  }

  console.log('\nИтоговые веса:', incumbent);
  gameLog.saveBotWeights(args.difficulty, incumbent, {
    source: 'trained',
    winRate: lastWinRate,
    gamesPlayed: totalGamesPlayed,
    note: `${incumbentLabel}; self-play, openings=${openings.length}, seed=${args.seed}`
  });
  console.log(`Сохранено в bot_weights (difficulty=${args.difficulty}). Сервер подхватит эти веса на следующем ходе бота без перезапуска.`);

  db.close();
}

main();
