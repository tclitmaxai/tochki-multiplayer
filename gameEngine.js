// gameEngine.js
//
// Чистые правила игры «Точки» — без canvas, без DOM, без localStorage.
// Тот же модуль подключается и в браузере (через <script>, кладёт себя
// в window.TochkiEngine), и в Node.js на сервере (через require/import) —
// поэтому сервер и клиент физически не могут разойтись в трактовке правил:
// это один и тот же код, а не две параллельные реализации.
//
// Публичный API:
//   TochkiEngine.SIZES / DIFFICULTY / BOT_WEIGHTS / BOT_PLAYER
//   TochkiEngine.getOpeningZone(rows, cols)
//   TochkiEngine.createMatch(options) -> объект партии с методами
//     applyMove(player, x, y), botMove(difficultyKey, weights),
//     endNow(), getSnapshot(), getMoveLog()
//
// createMatch — это как раз то, чего не хватало в однопользовательской
// версии: там правила жили в module-level переменных (let rows, cols, stone...),
// что нормально для одной партии в одной вкладке, но не подходит для сервера,
// которому нужно параллельно вести много независимых комнат. Здесь состояние
// партии — обычный объект в замыкании фабрики, поэтому createMatch можно
// вызывать сколько угодно раз с независимым состоянием на каждую комнату.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TochkiEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Кросс-окруженческий высокоточный таймер: в браузере — performance.now(),
  // в Node (>=16) он тоже есть глобально, но на всякий случай подстрахуемся.
  const now = (typeof performance !== 'undefined' && performance.now)
    ? () => performance.now()
    : () => Date.now();

  const SIZES = {
    small:  { cols: 11, rows: 9  },
    medium: { cols: 15, rows: 11 },
    large:  { cols: 19, rows: 15 }
  };

  const DIFFICULTY = {
    normal: { radius:2, candidateCap:10, timeLimit:220, maxDepth:3, branchWide:5, branchMid:4, branchNarrow:3, quiescenceExt:2 },
    strong: { radius:2, candidateCap:16, timeLimit:550, maxDepth:5, branchWide:7, branchMid:5, branchNarrow:4, quiescenceExt:2 }
  };
  const TRAIN_DIFF = { radius:2, candidateCap:14, timeLimit:70, maxDepth:3, branchWide:5, branchMid:4, branchNarrow:3, quiescenceExt:1 };

  const BOT_PLAYER = 2;
  // liberty — вес нового термина «безопасность групп» (см. computeGroupLiberties
  // / libertyRisk ниже). Без него бот видел опасность окружения только когда
  // захват уже случился внутри горизонта поиска; с ним — на любой глубине,
  // потому что риск считается прямо в статической оценке листа.
  // Значения по умолчанию подобраны вручную и являются стартовой точкой для
  // tools/train-bot.js — самообучение self-play подбирает их точнее.
  const BOT_WEIGHTS = { potential: 6, cohesion: 1.2, stones: 0.15, liberty: 5 };
  const CAPTURED_WEIGHT = 100;
  const DIRS4 = [[1,0],[-1,0],[0,1],[0,-1]];

  // ---------- Дебютная зона ----------
  const OPENING_ZONE_SIDE = 4;
  function getOpeningZone(rows, cols){
    const cx = Math.floor(cols/2), cy = Math.floor(rows/2);
    const half = Math.floor(OPENING_ZONE_SIDE/2);
    let minX = cx - half, minY = cy - half;
    let maxX = minX + OPENING_ZONE_SIDE - 1, maxY = minY + OPENING_ZONE_SIDE - 1;
    minX = Math.max(0, minX); minY = Math.max(0, minY);
    maxX = Math.min(cols-1, maxX); maxY = Math.min(rows-1, maxY);
    return {minX, minY, maxX, maxY};
  }
  function inZone(x, y, zone){
    return x>=zone.minX && x<=zone.maxX && y>=zone.minY && y<=zone.maxY;
  }

  function createEmptyState(rows, cols){
    return {
      stone: Array.from({length:rows}, () => new Array(cols).fill(0)),
      dead: Array.from({length:rows}, () => new Array(cols).fill(0)),
      territory: Array.from({length:rows}, () => new Array(cols).fill(0))
    };
  }

  function cloneState(state){
    return {
      stone: state.stone.map(r => r.slice()),
      dead: state.dead.map(r => r.slice()),
      territory: state.territory.map(r => r.slice())
    };
  }

  function cellOwner(state, x, y){
    const { stone, dead, territory } = state;
    if (dead[y][x] !== 0) return dead[y][x];
    if (territory[y][x] !== 0) return territory[y][x];
    if (stone[y][x] !== 0) return stone[y][x];
    return 0;
  }

  // Клетка — «стена» игрока player, только если это его живая точка либо
  // клетка уже под его контролем (прежде захваченная точка / территория).
  function isWall(state, x, y, player){
    const { stone, dead, territory } = state;
    if (dead[y][x] === player) return true;
    if (territory[y][x] === player) return true;
    if (stone[y][x] === player && dead[y][x] === 0) return true;
    return false;
  }

  // Захват: заливкой ищем связные области, не являющиеся стеной player,
  // не касающиеся края поля и содержащие хотя бы одну живую точку соперника.
  // Мутирует state.dead/state.territory. Возвращает список изменённых клеток.
  function runCaptures(state, player, rows, cols){
    const { stone, dead, territory } = state;
    const opponent = player === 1 ? 2 : 1;
    const visited = Array.from({length: rows}, () => new Array(cols).fill(false));
    const gained = [];

    for (let y=0; y<rows; y++){
      for (let x=0; x<cols; x++){
        if (visited[y][x]) continue;
        if (isWall(state, x, y, player)){
          visited[y][x] = true;
          continue;
        }
        const stack = [[x,y]];
        const region = [];
        let touchesBorder = false;
        let containsLiveOpponent = false;
        visited[y][x] = true;
        while (stack.length){
          const [cx,cy] = stack.pop();
          region.push([cx,cy]);
          if (cx===0 || cy===0 || cx===cols-1 || cy===rows-1) touchesBorder = true;
          if (stone[cy][cx] === opponent && dead[cy][cx] === 0) containsLiveOpponent = true;
          for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
            const nx=cx+dx, ny=cy+dy;
            if (nx<0||ny<0||nx>=cols||ny>=rows) continue;
            if (visited[ny][nx]) continue;
            visited[ny][nx] = true;
            if (isWall(state, nx, ny, player)) continue;
            stack.push([nx,ny]);
          }
        }
        if (!touchesBorder && containsLiveOpponent){
          for (const [cx,cy] of region){
            if (stone[cy][cx] !== 0){
              if (dead[cy][cx] !== player){
                gained.push({x:cx, y:cy, prevOwner: dead[cy][cx]});
                dead[cy][cx] = player;
              }
            } else if (territory[cy][cx] !== player){
              gained.push({x:cx, y:cy, prevOwner: territory[cy][cx]});
              territory[cy][cx] = player;
            }
          }
        }
      }
    }
    return gained;
  }

  // ---------- Бот ----------

  function generateCandidates(state, rows, cols, radius){
    const { stone, territory } = state;
    const cand = new Set();
    const has = (x,y) => stone[y][x] !== 0;
    let anyStone = false;
    let stoneCount = 0;
    for (let y=0; y<rows; y++){
      for (let x=0; x<cols; x++){
        if (!has(x,y)) continue;
        anyStone = true;
        stoneCount++;
        for (let dy=-radius; dy<=radius; dy++){
          for (let dx=-radius; dx<=radius; dx++){
            const nx=x+dx, ny=y+dy;
            if (nx<0||ny<0||nx>=cols||ny>=rows) continue;
            if (stone[ny][nx]!==0 || territory[ny][nx]!==0) continue;
            cand.add(ny*cols+nx);
          }
        }
      }
    }
    if (!anyStone){
      cand.add(Math.floor(rows/2)*cols + Math.floor(cols/2));
    }
    let result = Array.from(cand).map(v => ({x: v % cols, y: Math.floor(v/cols)}));

    if (stoneCount < 2){
      const zone = getOpeningZone(rows, cols);
      let restricted = result.filter(c => inZone(c.x, c.y, zone));
      if (!restricted.length){
        for (let y=zone.minY; y<=zone.maxY; y++){
          for (let x=zone.minX; x<=zone.maxX; x++){
            if (stone[y][x]===0 && territory[y][x]===0) restricted.push({x,y});
          }
        }
      }
      result = restricted;
    }
    return result;
  }

  function quickScore(state, rows, cols, x, y, player, urgentMap){
    const { stone } = state;
    const opponent = player === 1 ? 2 : 1;
    let s = 0;
    for (let dy=-2; dy<=2; dy++){
      for (let dx=-2; dx<=2; dx++){
        const nx=x+dx, ny=y+dy;
        if (nx<0||ny<0||nx>=cols||ny>=rows) continue;
        const dist = Math.max(Math.abs(dx),Math.abs(dy));
        if (stone[ny][nx]===opponent) s += 3/dist;
        else if (stone[ny][nx]===player) s += 2/dist;
      }
    }
    const cx = cols/2, cy = rows/2;
    s += 0.4 / (1 + Math.hypot(x-cx, y-cy));
    // Бонус за срочность — см. computeUrgentCells. Без него кандидат-ордеринг
    // и обрезка по candidateCap/branchFactor могли отбросить единственный
    // ход, спасающий группу от захвата, ещё до того, как поиск успевал его
    // увидеть — именно это и выглядело как «бот защищает обречённые точки».
    if (urgentMap){
      const bonus = urgentMap.get(y*cols+x);
      if (bonus) s += bonus;
    }
    return s;
  }

  function computeTerritoryPotential(state, rows, cols){
    const { stone, territory } = state;
    const visited = Array.from({length: rows}, () => new Array(cols).fill(false));
    const potential = {1:0, 2:0};
    for (let y=0; y<rows; y++){
      for (let x=0; x<cols; x++){
        if (visited[y][x]) continue;
        if (stone[y][x] !== 0 || territory[y][x] !== 0){ visited[y][x] = true; continue; }
        const stack = [[x,y]];
        visited[y][x] = true;
        let regionSize = 0;
        let touchesBorder = false;
        const owners = new Set();
        while (stack.length){
          const [cx,cy] = stack.pop();
          regionSize++;
          if (cx===0 || cy===0 || cx===cols-1 || cy===rows-1) touchesBorder = true;
          for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
            const nx=cx+dx, ny=cy+dy;
            if (nx<0||ny<0||nx>=cols||ny>=rows) continue;
            const neutral = stone[ny][nx]===0 && territory[ny][nx]===0;
            if (neutral){
              if (!visited[ny][nx]){ visited[ny][nx] = true; stack.push([nx,ny]); }
            } else {
              const owner = cellOwner(state, nx, ny);
              if (owner !== 0) owners.add(owner);
            }
          }
        }
        if (!touchesBorder && owners.size === 1){
          potential[[...owners][0]] += regionSize;
        }
      }
    }
    return potential;
  }

  // ---------- Свободы групп («атари») ----------
  //
  // computeTerritoryPotential выше отвечает на вопрос «какая пустая область
  // уже полностью замкнута одним игроком» — это факт, наступающий постфактум,
  // ровно в момент захвата. Он ничего не говорит о том, что группа живых
  // камней постепенно ЛИШАЕТСЯ путей наружу за несколько ходов до захвата —
  // а именно это нужно боту, чтобы вовремя защищаться и вовремя окружать
  // самому. Здесь используется тот же принцип, что «свободы» (liberties) в
  // го: для связной группы живых камней игрока считаются соседние клетки,
  // через которые группа ещё может «дышать» (пустые, не занятые соперником).
  // Если свобод становится мало (1-2), группа в шаге от захвата — даже если
  // формально до этого момента runCaptures её ещё не тронул.
  function computeGroupLiberties(state, rows, cols, player){
    const { stone, dead, territory } = state;
    const visited = Array.from({length: rows}, () => new Array(cols).fill(false));
    const groups = [];
    for (let y=0; y<rows; y++){
      for (let x=0; x<cols; x++){
        if (visited[y][x]) continue;
        if (!(stone[y][x] === player && dead[y][x] === 0)){ visited[y][x] = true; continue; }
        const stack = [[x,y]];
        visited[y][x] = true;
        const cells = [];
        const libs = new Set();
        while (stack.length){
          const [cx,cy] = stack.pop();
          cells.push([cx,cy]);
          for (const [dx,dy] of DIRS4){
            const nx=cx+dx, ny=cy+dy;
            if (nx<0||ny<0||nx>=cols||ny>=rows) continue;
            if (stone[ny][nx] === player && dead[ny][nx] === 0){
              if (!visited[ny][nx]){ visited[ny][nx] = true; stack.push([nx,ny]); }
            } else if (stone[ny][nx] === 0 && dead[ny][nx] === 0 && territory[ny][nx] === 0){
              libs.add(ny*cols+nx);
            }
          }
        }
        groups.push({ cells, size: cells.length, liberties: libs.size, libCells: libs });
      }
    }
    return groups;
  }

  // Риск группы растёт резко нелинейно по мере приближения к «атари»
  // (1 свобода — следующий ход соперника захватывает группу целиком).
  // Множитель на size означает, что потеря большой сцепленной группы —
  // катастрофа, а не мелкая потеря одного камня.
  function libertyRisk(groups){
    let risk = 0;
    for (const g of groups){
      if (g.liberties <= 1) risk += g.size * 6;
      else if (g.liberties === 2) risk += g.size * 2.5;
      else if (g.liberties === 3) risk += g.size * 0.8;
    }
    return risk;
  }

  function hasUrgentAtari(state, rows, cols, player){
    const opponent = player === 1 ? 2 : 1;
    const mine = computeGroupLiberties(state, rows, cols, player);
    if (mine.some(g => g.liberties <= 1)) return true;
    const theirs = computeGroupLiberties(state, rows, cols, opponent);
    if (theirs.some(g => g.liberties <= 1)) return true;
    return false;
  }

  // Клетки-«свободы» групп в атари (liberties<=2) для обеих сторон,
  // с бонусом для quickScore/сортировки кандидатов — чтобы срочный ход
  // (спасти свою группу или добить чужую) не вылетел из top-N кандидатов
  // при обрезке по candidateCap/branchFactor до того, как поиск вообще
  // успеет его увидеть.
  function computeUrgentCells(state, rows, cols, mover){
    const opponent = mover === 1 ? 2 : 1;
    const urgent = new Map();
    const mark = (groups, bonus) => {
      for (const g of groups){
        if (g.liberties > 2) continue;
        const w = g.liberties <= 1 ? bonus * 2.2 : bonus * 1.1;
        for (const key of g.libCells){
          if ((urgent.get(key) || 0) < w) urgent.set(key, w);
        }
      }
    };
    mark(computeGroupLiberties(state, rows, cols, mover), 5);      // спасти свою группу
    mark(computeGroupLiberties(state, rows, cols, opponent), 4.2); // добить чужую
    return urgent;
  }

  function evaluateStatic(state, rows, cols, forPlayer, weights){
    const { stone, dead, territory } = state;
    const opponent = forPlayer === 1 ? 2 : 1;
    const captured = {1:0, 2:0};
    const liveStones = {1:0, 2:0};
    const cohesion = {1:0, 2:0};
    for (let y=0; y<rows; y++){
      for (let x=0; x<cols; x++){
        if (dead[y][x] !== 0){ captured[dead[y][x]]++; continue; }
        if (territory[y][x] !== 0){ captured[territory[y][x]]++; continue; }
        const p = stone[y][x];
        if (p !== 0){
          liveStones[p]++;
          if (x+1<cols && stone[y][x+1]===p && dead[y][x+1]===0) cohesion[p]++;
          if (y+1<rows && stone[y+1][x]===p && dead[y+1][x]===0) cohesion[p]++;
        }
      }
    }
    const potential = computeTerritoryPotential(state, rows, cols);
    const capturedDiff  = captured[forPlayer] - captured[opponent];
    const potentialDiff = potential[forPlayer] - potential[opponent];
    const cohesionDiff  = cohesion[forPlayer] - cohesion[opponent];
    const stoneDiff     = liveStones[forPlayer] - liveStones[opponent];

    // libertyDiff > 0, когда СОПЕРНИК ближе к потере группы, чем forPlayer —
    // то есть положительно и за собственную оборону, и за давление на чужие
    // группы. weights.liberty может отсутствовать у старых сохранённых
    // весов (из БД/прежних версий) — тогда просто не влияет на оценку.
    const ownGroups = computeGroupLiberties(state, rows, cols, forPlayer);
    const oppGroups = computeGroupLiberties(state, rows, cols, opponent);
    const libertyDiff = libertyRisk(oppGroups) - libertyRisk(ownGroups);

    return capturedDiff*CAPTURED_WEIGHT + potentialDiff*weights.potential + cohesionDiff*weights.cohesion
      + stoneDiff*weights.stones + libertyDiff*(weights.liberty || 0);
  }

  function branchFactorForDepth(diff, depth){
    if (depth >= 3) return diff.branchWide;
    if (depth === 2) return diff.branchMid;
    return diff.branchNarrow;
  }

  function orderedCandidates(state, rows, cols, player, diff, depth){
    const cand = generateCandidates(state, rows, cols, diff.radius);
    const urgent = computeUrgentCells(state, rows, cols, player);
    cand.forEach(c => { c.q = quickScore(state, rows, cols, c.x, c.y, player, urgent); });
    cand.sort((a,b) => b.q - a.q);
    return cand.slice(0, branchFactorForDepth(diff, depth));
  }

  function hasForcingCapture(state, rows, cols, player, diff){
    const cand = generateCandidates(state, rows, cols, diff.radius)
      .map(c => ({...c, q: quickScore(state, rows, cols, c.x, c.y, player)}))
      .sort((a,b) => b.q - a.q)
      .slice(0, 6);
    for (const c of cand){
      const s = cloneState(state);
      s.stone[c.y][c.x] = player;
      if (runCaptures(s, player, rows, cols).length) return true;
    }
    return false;
  }

  function alphaBeta(state, rows, cols, depth, alpha, beta, player, diff, deadline, forPlayer, weights, extensionsLeft){
    const forcedExtension = depth <= 0 && extensionsLeft > 0 &&
      (hasForcingCapture(state, rows, cols, player, diff) || hasUrgentAtari(state, rows, cols, player));
    if ((depth <= 0 && !forcedExtension) || now() > deadline){
      return evaluateStatic(state, rows, cols, forPlayer, weights);
    }
    const searchDepth = depth > 0 ? depth : 1;
    const candidates = orderedCandidates(state, rows, cols, player, diff, searchDepth);
    if (!candidates.length) return evaluateStatic(state, rows, cols, forPlayer, weights);

    const opponent = player === 1 ? 2 : 1;
    const maximizing = player === forPlayer;
    let value = maximizing ? -Infinity : Infinity;
    const nextDepth = depth > 0 ? depth - 1 : 0;
    const nextExt = depth > 0 ? extensionsLeft : extensionsLeft - 1;

    for (const c of candidates){
      if (now() > deadline) break;
      const s2 = cloneState(state);
      s2.stone[c.y][c.x] = player;
      runCaptures(s2, player, rows, cols);
      const childVal = alphaBeta(s2, rows, cols, nextDepth, alpha, beta, opponent, diff, deadline, forPlayer, weights, nextExt);
      if (maximizing){
        if (childVal > value) value = childVal;
        alpha = Math.max(alpha, value);
      } else {
        if (childVal < value) value = childVal;
        beta = Math.min(beta, value);
      }
      if (beta <= alpha) break;
    }
    return value;
  }

  function chooseMove(state, rows, cols, mover, diff, weights){
    const opponent = mover === 1 ? 2 : 1;
    const extInit = diff.quiescenceExt ?? 2;

    let ordered = generateCandidates(state, rows, cols, diff.radius);
    if (!ordered.length) return null;
    const urgentTop = computeUrgentCells(state, rows, cols, mover);
    ordered.forEach(c => { c.q = quickScore(state, rows, cols, c.x, c.y, mover, urgentTop); });
    ordered.sort((a,b) => b.q - a.q);
    ordered = ordered.slice(0, diff.candidateCap);

    const deadline = now() + diff.timeLimit;
    let bestMove = null;

    for (let targetDepth = 2; targetDepth <= diff.maxDepth; targetDepth++){
      if (now() > deadline) break;
      let localBest = null, localBestScore = -Infinity;
      let completedFully = true;
      let alpha = -Infinity;
      const beta = Infinity;

      for (const c of ordered){
        if (now() > deadline){ completedFully = false; break; }
        const s1 = cloneState(state);
        s1.stone[c.y][c.x] = mover;
        runCaptures(s1, mover, rows, cols);
        const val = alphaBeta(s1, rows, cols, targetDepth-1, alpha, beta, opponent, diff, deadline, mover, weights, extInit);
        if (val > localBestScore){
          localBestScore = val;
          localBest = c;
        }
        alpha = Math.max(alpha, localBestScore);
      }

      if (localBest && completedFully){
        bestMove = localBest;
        const idx = ordered.indexOf(bestMove);
        if (idx > 0){ ordered.splice(idx, 1); ordered.unshift(bestMove); }
      } else if (!bestMove && localBest){
        bestMove = localBest;
      }
    }

    return bestMove || ordered[0];
  }

  function isBoardFull(state, rows, cols){
    for (let y=0;y<rows;y++)
      for (let x=0;x<cols;x++)
        if (state.stone[y][x]===0 && state.territory[y][x]===0) return false;
    return true;
  }

  function countFilledCells(state, rows, cols){
    let n = 0;
    for (let y=0;y<rows;y++)
      for (let x=0;x<cols;x++)
        if (state.stone[y][x]!==0 || state.territory[y][x]!==0) n++;
    return n;
  }

  function checkEndConditions(ctx){
    const { state, rows, cols, scores, scoreRuleActive, targetScore, fillRuleActive, targetFillPercent, totalCells } = ctx;
    if (isBoardFull(state, rows, cols)) return true;
    if (scoreRuleActive && (scores[1] >= targetScore || scores[2] >= targetScore)) return true;
    if (fillRuleActive){
      const targetCells = Math.ceil(totalCells * targetFillPercent / 100);
      if (countFilledCells(state, rows, cols) >= targetCells) return true;
    }
    return false;
  }

  // ---------- Партия целиком: инкапсулированное состояние одной игры ----------
  // Это то, что нужно серверу: можно создать много независимых createMatch()
  // (по одной на комнату), и они не будут делить между собой никакие
  // module-level переменные — в отличие от однопользовательской версии.
  function createMatch(options){
    options = options || {};
    const sizeKey = options.sizeKey && SIZES[options.sizeKey] ? options.sizeKey : 'medium';
    const size = SIZES[sizeKey];
    const rows = size.rows, cols = size.cols;
    const state = createEmptyState(rows, cols);

    let current = 1;
    const scores = {1:0, 2:0};
    let gameOver = false;
    let stonesPlacedTotal = 0;
    const moveLog = [];
    const totalCells = rows*cols;

    const targetScore = Math.max(0, Math.min(9999, Math.floor(options.targetScore) || 0));
    let targetFillPercent = options.targetFillPercent;
    if (typeof targetFillPercent !== 'number' || isNaN(targetFillPercent)) targetFillPercent = 100;
    targetFillPercent = Math.max(0, Math.min(100, Math.floor(targetFillPercent)));
    const scoreRuleActive = targetScore > 0;
    const fillRuleActive = targetFillPercent > 0 && targetFillPercent < 100;

    function isLegal(x, y){
      if (gameOver) return false;
      if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
      if (x<0 || y<0 || x>=cols || y>=rows) return false;
      if (state.stone[y][x] !== 0 || state.territory[y][x] !== 0) return false;
      if (stonesPlacedTotal < 2 && !inZone(x, y, getOpeningZone(rows, cols))) return false;
      return true;
    }

    // Выполняет ход player-а. Возвращает {ok:true, ...} при успехе или
    // {ok:false, reason} при недопустимом ходе — второе не мутирует состояние.
    function applyMove(player, x, y){
      if (gameOver) return { ok:false, reason:'game-over' };
      if (player !== current) return { ok:false, reason:'not-your-turn' };
      if (!isLegal(x, y)) return { ok:false, reason:'illegal-cell' };

      state.stone[y][x] = player;
      stonesPlacedTotal++;
      moveLog.push({x, y, p: player});

      const gained = runCaptures(state, player, rows, cols);
      for (const g of gained){
        if (g.prevOwner && g.prevOwner !== player){
          scores[g.prevOwner] = Math.max(0, scores[g.prevOwner] - 1);
        }
        scores[player] += 1;
      }

      let winner = null;
      const ended = checkEndConditions({ state, rows, cols, scores, scoreRuleActive, targetScore, fillRuleActive, targetFillPercent, totalCells });
      if (ended){
        gameOver = true;
        winner = scores[1] > scores[2] ? 1 : (scores[2] > scores[1] ? 2 : 0);
      } else {
        current = player === 1 ? 2 : 1;
      }

      return {
        ok: true, player, x, y,
        gained, scores: {...scores}, current, gameOver, winner,
        stonesPlacedTotal
      };
    }

    // Досрочное завершение (аналог кнопки «Закончить игру»).
    function endNow(){
      if (gameOver) return { ok:false, reason:'game-over' };
      gameOver = true;
      const winner = scores[1] > scores[2] ? 1 : (scores[2] > scores[1] ? 2 : 0);
      return { ok:true, gameOver, winner, scores: {...scores} };
    }

    function botMove(difficultyKey, weights){
      const diff = DIFFICULTY[difficultyKey] || DIFFICULTY.normal;
      return chooseMove(state, rows, cols, current, diff, weights || BOT_WEIGHTS);
    }

    // Полный снимок состояния — то, что уходит клиенту по WebSocket.
    function getSnapshot(){
      return {
        sizeKey, rows, cols,
        stone: state.stone.map(r => r.slice()),
        dead: state.dead.map(r => r.slice()),
        territory: state.territory.map(r => r.slice()),
        current, scores: {...scores}, gameOver, stonesPlacedTotal,
        openingZone: getOpeningZone(rows, cols),
        rules: { targetScore, targetFillPercent, scoreRuleActive, fillRuleActive, totalCells }
      };
    }

    function getMoveLog(){ return moveLog.slice(); }

    return { rows, cols, sizeKey, applyMove, endNow, botMove, getSnapshot, getMoveLog };
  }

  return {
    SIZES, DIFFICULTY, TRAIN_DIFF, BOT_PLAYER, BOT_WEIGHTS,
    OPENING_ZONE_SIDE, getOpeningZone, inZone,
    createEmptyState, cloneState, cellOwner, isWall, runCaptures,
    generateCandidates, quickScore, computeTerritoryPotential, evaluateStatic,
    computeGroupLiberties, libertyRisk, computeUrgentCells, hasUrgentAtari,
    chooseMove, isBoardFull, countFilledCells, checkEndConditions,
    createMatch
  };
});
