/*
 * Rift Chess — computer opponent.
 *
 * Iterative-deepening alpha-beta (negamax) with a transposition table,
 * move ordering (TT move, MVV-LVA, killers, history), check extension and
 * quiescence search. It uses the exact same legal-move generator and
 * make/unmake code as the rules engine, so every portal effect is applied
 * before a position is evaluated.
 *
 * The search works on its own copy of the position and never touches the
 * live game. Like rules.js, it is one factory function so a Web Worker can
 * be built from its source text.
 */
function RiftAIFactory(Rules) {
  'use strict';

  var I = Rules.internal;
  var genLegal = I.genLegal, makeMove = I.makeMove, unmakeMove = I.unmakeMove;
  var isAttacked = I.isAttacked, isDeadBoard = I.isDeadBoard, epIsLegal = I.epIsLegal;
  var KNIGHT_MOVES = I.KNIGHT_MOVES, KING_MOVES = I.KING_MOVES, RAYS = I.RAYS;
  var PORTAL_EXIT = Rules.PORTAL_EXIT, PIECE_CHARS = I.PIECE_CHARS;
  var FLAG_CAPTURE = Rules.FLAG_CAPTURE, FLAG_PROMO = Rules.FLAG_PROMO;

  var MATE = 100000, INF = 1000000, MAX_PLY = 64;

  // Configurable targets, not guarantees.
  var LEVELS = {
    easy: { label: 'Easy', timeMs: 200, maxDepth: 2, fullEval: false, noise: 70, blunderRate: 0.12, useTT: false },
    medium: { label: 'Medium', timeMs: 750, maxDepth: 5, fullEval: true, noise: 0, blunderRate: 0, useTT: true },
    hard: { label: 'Hard', timeMs: 2200, maxDepth: 40, fullEval: true, noise: 0, blunderRate: 0, useTT: true }
  };

  /* --------------------------------------------------------------- Zobrist */
  var seed = 0x9E3779B9;
  function rnd() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed | 0; }
  var Z1 = new Int32Array(16 * 64), Z2 = new Int32Array(16 * 64);
  for (var zi = 0; zi < Z1.length; zi++) { Z1[zi] = rnd(); Z2[zi] = rnd(); }
  var ZT1 = rnd(), ZT2 = rnd();
  var ZC1 = new Int32Array(16), ZC2 = new Int32Array(16), ZE1 = new Int32Array(64), ZE2 = new Int32Array(64);
  for (zi = 0; zi < 16; zi++) { ZC1[zi] = rnd(); ZC2[zi] = rnd(); }
  for (zi = 0; zi < 64; zi++) { ZE1[zi] = rnd(); ZE2[zi] = rnd(); }

  var H1 = 0, H2 = 0; // output registers of the hash functions
  function hashPos(pos) {
    var a = 0, c = 0, b = pos.board;
    for (var s = 0; s < 64; s++) { var p = b[s]; if (p) { a ^= Z1[p * 64 + s]; c ^= Z2[p * 64 + s]; } }
    if (pos.turn) { a ^= ZT1; c ^= ZT2; }
    a ^= ZC1[pos.castling]; c ^= ZC2[pos.castling];
    if (pos.epTarget >= 0 && epIsLegal(pos)) { a ^= ZE1[pos.epTarget]; c ^= ZE2[pos.epTarget]; }
    H1 = a; H2 = c;
  }
  // Same identity computed from a repetition key string produced by rules.js.
  function hashKeyString(key) {
    var a = 0, c = 0, s, parts = key.split(' ');
    for (s = 0; s < 64; s++) { var p = PIECE_CHARS.indexOf(key[s]); if (p > 0) { a ^= Z1[p * 64 + s]; c ^= Z2[p * 64 + s]; } }
    if (parts[1] === 'b') { a ^= ZT1; c ^= ZT2; }
    var cs = parts[2], cr = 0;
    if (cs.indexOf('K') >= 0) cr |= 1; if (cs.indexOf('Q') >= 0) cr |= 2;
    if (cs.indexOf('k') >= 0) cr |= 4; if (cs.indexOf('q') >= 0) cr |= 8;
    a ^= ZC1[cr]; c ^= ZC2[cr];
    if (parts[3] !== '-') { var e = Rules.sqIndex(parts[3]); a ^= ZE1[e]; c ^= ZE2[e]; }
    H1 = a; H2 = c;
  }

  /* ------------------------------------------------------------ Evaluation */
  var VALUE = [0, 100, 320, 330, 500, 900, 0];
  // Piece-square tables, written from White's point of view with rank 8 first.
  var PST = [null,
    [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5,
      0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
    [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30,
      -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
    [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10,
      -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20],
    [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0],
    [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5,
      0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
    [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30,
      -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20]
  ];
  var KING_EG = [-50, -40, -30, -20, -20, -30, -40, -50, -30, -20, -10, 0, 0, -10, -20, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -30, 0, 0, 0, 0, -30, -30, -50, -30, -30, -30, -30, -30, -30, -50];
  var PASSED = [0, 5, 10, 20, 35, 60, 100, 0];
  var PORTAL_SQUARES = [];
  for (var ps = 0; ps < 64; ps++) if (PORTAL_EXIT[ps] >= 0) PORTAL_SQUARES.push(ps);

  function pstIndex(color, s) { return color === 0 ? (7 - (s >> 3)) * 8 + (s & 7) : s; }
  function dist(a, b) { return Math.max(Math.abs((a & 7) - (b & 7)), Math.abs((a >> 3) - (b >> 3))); }

  function evaluate(pos, full) {
    var b = pos.board, s, p, t, c, score = [0, 0], phase = 0, kingMg = [0, 0], kingEg = [0, 0];
    var bishops = [0, 0], pawnFiles = [[0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0]];
    for (s = 0; s < 64; s++) {
      p = b[s]; if (!p) continue;
      t = p & 7; c = p >> 3;
      if (t === KINGT) { kingMg[c] = PST[6][pstIndex(c, s)]; kingEg[c] = KING_EG[pstIndex(c, s)]; continue; }
      score[c] += VALUE[t] + PST[t][pstIndex(c, s)];
      if (t === 2 || t === 3) phase += 1; else if (t === 4) phase += 2; else if (t === 5) phase += 4;
      if (t === 3) bishops[c]++;
      if (t === 1) pawnFiles[c][s & 7]++;
      if (full && t >= 2 && t <= 5) score[c] += mobility(b, s, t, c);
    }
    if (phase > 24) phase = 24;
    var mgW = phase / 24, egW = 1 - mgW;
    for (c = 0; c < 2; c++) score[c] += Math.round(kingMg[c] * mgW + kingEg[c] * egW);
    if (full) {
      for (c = 0; c < 2; c++) {
        if (bishops[c] >= 2) score[c] += 30;
        score[c] += pawnStructure(b, c, pawnFiles, egW);
        score[c] += Math.round(kingSafety(pos, c) * mgW);
        score[c] += portalPressure(pos, c);
      }
    }
    var v = score[0] - score[1];
    return (pos.turn === 0 ? v : -v) + 10; // small tempo bonus
  }
  var KINGT = 6;

  function mobility(b, s, t, c) {
    var n = 0, k, list, d, ray, q;
    if (t === 2) {
      list = KNIGHT_MOVES[s];
      for (k = 0; k < list.length; k++) { q = b[list[k]]; if (!q || (q >> 3) !== c) n++; }
      return (n - 4) * 4;
    }
    var d0 = t === 4 ? 0 : (t === 3 ? 4 : 0), d1 = t === 4 ? 4 : 8;
    for (d = d0; d < d1; d++) {
      ray = RAYS[d][s];
      for (k = 0; k < ray.length; k++) { q = b[ray[k]]; if (!q) { n++; continue; } if ((q >> 3) !== c) n++; break; }
    }
    if (t === 3) return (n - 6) * 4;
    if (t === 4) return (n - 7) * 2;
    return (n - 13);
  }

  function pawnStructure(b, c, files, egW) {
    var v = 0, f, s, own = c * 8 + 1, opp = (1 - c) * 8 + 1;
    for (f = 0; f < 8; f++) {
      var n = files[c][f];
      if (!n) continue;
      if (n > 1) v -= 10 * (n - 1);
      if ((f === 0 || !files[c][f - 1]) && (f === 7 || !files[c][f + 1])) v -= 12 * n;
    }
    for (s = 8; s < 56; s++) {
      if (b[s] !== own) continue;
      var file = s & 7, rank = s >> 3, passed = true;
      for (var df = -1; df <= 1 && passed; df++) {
        var ff = file + df; if (ff < 0 || ff > 7) continue;
        if (c === 0) { for (var r = rank + 1; r < 8; r++) if (b[r * 8 + ff] === opp) { passed = false; break; } }
        else { for (var r2 = rank - 1; r2 >= 0; r2--) if (b[r2 * 8 + ff] === opp) { passed = false; break; } }
      }
      if (passed) {
        var adv = c === 0 ? rank : 7 - rank;
        v += Math.round(PASSED[adv] * (0.5 + egW));
      }
    }
    return v;
  }

  function kingSafety(pos, c) {
    var b = pos.board, k = pos.kings[c], v = 0, list = KING_MOVES[k], pawn = c * 8 + 1;
    var fwd = c === 0 ? 8 : -8, f = k & 7;
    for (var df = -1; df <= 1; df++) {
      var ff = f + df; if (ff < 0 || ff > 7) continue;
      var s1 = k + fwd + df, s2 = k + 2 * fwd + df;
      if (s1 >= 0 && s1 < 64 && b[s1] === pawn) v += 12;
      else if (s2 >= 0 && s2 < 64 && b[s2] === pawn) v += 6;
    }
    for (var i = 0; i < list.length; i++) if (isAttacked(b, list[i], 1 - c)) v -= 8;
    return v;
  }

  // Variant term: control of portal entries whose exit is open, especially
  // when the exit lands near the enemy king.
  function portalPressure(pos, c) {
    var b = pos.board, v = 0, enemyKing = pos.kings[1 - c];
    for (var i = 0; i < PORTAL_SQUARES.length; i++) {
      var p = PORTAL_SQUARES[i], e = PORTAL_EXIT[p];
      if (b[e] !== 0) continue;
      var q = b[p];
      if (q && (q >> 3) === c) continue;
      if (isAttacked(b, p, c)) v += 5 + (dist(e, enemyKing) <= 2 ? 15 : 0);
    }
    return v;
  }

  /* ---------------------------------------------------------------- Search */
  var TT_BITS = 18, TT_SIZE = 1 << TT_BITS, TT_MASK = TT_SIZE - 1;
  var ttK1 = new Int32Array(TT_SIZE), ttK2 = new Int32Array(TT_SIZE), ttMove = new Int32Array(TT_SIZE);
  var ttScore = new Int32Array(TT_SIZE), ttDepth = new Int8Array(TT_SIZE), ttFlag = new Int8Array(TT_SIZE);
  var TT_EXACT = 1, TT_LOWER = 2, TT_UPPER = 3;
  function clearTT() { ttFlag.fill(0); }

  var ABORT = { abort: true };

  function Search(state, level, options) {
    this.pos = I.toPos(state);
    this.level = level;
    this.full = level.fullEval;
    this.useTT = level.useTT;
    this.nodes = 0;
    this.deadline = 0;
    this.canStop = false;
    this.ghi = false;
    this.killers = [];
    for (var i = 0; i < MAX_PLY + 8; i++) this.killers.push([0, 0]);
    this.history = new Int32Array(64 * 64);
    this.now = (options && options.now) || function () { return Date.now(); };
    // Game history hashes for repetition detection (last entry = root).
    this.h1 = []; this.h2 = [];
    var hist = state.history, start = Math.max(0, hist.length - 1 - state.halfmove);
    for (i = start; i < hist.length - 1; i++) { hashKeyString(hist[i]); this.h1.push(H1); this.h2.push(H2); }
  }

  Search.prototype.isRepetition = function (a, c) {
    var n = this.h1.length, lim = n - this.pos.halfmove;
    for (var j = n - 2; j >= 0 && j >= lim; j -= 2) if (this.h1[j] === a && this.h2[j] === c) return true;
    return false;
  };

  Search.prototype.tick = function () {
    if ((++this.nodes & 1023) === 0 && this.canStop && this.now() > this.deadline) throw ABORT;
  };

  Search.prototype.orderMoves = function (moves, ttm, ply) {
    var b = this.pos.board, scores = new Array(moves.length), k = this.killers[ply], h = this.history;
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i], fl = (m >> 15) & 31, sc;
      if (m === ttm) sc = 10000000;
      else if (fl & FLAG_CAPTURE) {
        var victim = b[(m >> 6) & 63] & 7 || 1;
        sc = 1000000 + VALUE[victim] * 10 - VALUE[b[m & 63] & 7] / 10;
      } else if (fl & FLAG_PROMO) sc = 900000 + VALUE[(m >> 12) & 7];
      else if (m === k[0]) sc = 800000;
      else if (m === k[1]) sc = 790000;
      else sc = h[(m & 63) * 64 + ((m >> 6) & 63)];
      if ((fl & FLAG_PROMO) && (fl & FLAG_CAPTURE)) sc += VALUE[(m >> 12) & 7];
      scores[i] = sc;
    }
    // insertion sort (lists are short)
    for (i = 1; i < moves.length; i++) {
      var mv = moves[i], s = scores[i], j = i - 1;
      while (j >= 0 && scores[j] < s) { moves[j + 1] = moves[j]; scores[j + 1] = scores[j]; j--; }
      moves[j + 1] = mv; scores[j + 1] = s;
    }
    return moves;
  };

  Search.prototype.search = function (depth, ply, alpha, beta) {
    var saved = this.ghi;
    this.ghi = false;
    var v = this.searchInner(depth, ply, alpha, beta);
    this.ghi = saved || this.ghi;
    return v;
  };

  Search.prototype.searchInner = function (depth, ply, alpha, beta) {
    var pos = this.pos;
    this.tick();
    hashPos(pos);
    var a1 = H1, a2 = H2, r1 = H1, r2 = H2;
    if (ply > 0) {
      if (this.isRepetition(a1, a2)) { this.ghi = true; return 0; }
      if (isDeadBoard(pos.board)) return 0;
    }
    var check = I.inCheck(pos);
    if (check && ply < MAX_PLY) depth++;
    if (depth <= 0 || ply >= MAX_PLY) return this.quiesce(alpha, beta, ply, 0);

    // Positions near the move-count thresholds must not share entries.
    if (pos.halfmove >= 60) { a1 ^= Math.imul(pos.halfmove, 0x45D9F3B); a2 ^= Math.imul(pos.halfmove, 0x119DE1F3); }
    var idx = a1 & TT_MASK, ttm = 0, origAlpha = alpha;
    if (this.useTT && ttFlag[idx] && ttK1[idx] === a1 && ttK2[idx] === a2) {
      ttm = ttMove[idx];
      if (ply > 0 && ttDepth[idx] >= depth) {
        var ts = ttScore[idx];
        if (ts > MATE - 1000) ts -= ply; else if (ts < -MATE + 1000) ts += ply;
        var tf = ttFlag[idx];
        if (tf === TT_EXACT) return ts;
        if (tf === TT_LOWER && ts >= beta) return ts;
        if (tf === TT_UPPER && ts <= alpha) return ts;
      }
    }

    var moves = genLegal(pos, false);
    if (!moves.length) return check ? -MATE + ply : 0;
    if (ply > 0 && pos.halfmove >= 100) return 0; // claimable fifty-move draw (mate already ruled out)

    this.orderMoves(moves, ttm, ply);
    this.h1.push(r1); this.h2.push(r2);
    var best = -INF, bestMove = moves[0];
    try {
      for (var i = 0; i < moves.length; i++) {
        var m = moves[i];
        makeMove(pos, m);
        var score;
        try {
          if (i === 0) score = -this.search(depth - 1, ply + 1, -beta, -alpha);
          else {
            score = -this.search(depth - 1, ply + 1, -alpha - 1, -alpha);
            if (score > alpha && score < beta) score = -this.search(depth - 1, ply + 1, -beta, -alpha);
          }
        } finally { unmakeMove(pos); }
        if (score > best) { best = score; bestMove = m; }
        if (score > alpha) alpha = score;
        if (alpha >= beta) {
          if (!((m >> 15) & (FLAG_CAPTURE | FLAG_PROMO))) {
            var k = this.killers[ply];
            if (k[0] !== m) { k[1] = k[0]; k[0] = m; }
            this.history[(m & 63) * 64 + ((m >> 6) & 63)] += depth * depth;
          }
          break;
        }
      }
    } finally { this.h1.pop(); this.h2.pop(); }

    if (this.useTT && !this.ghi) {
      var st = best;
      if (st > MATE - 1000) st += ply; else if (st < -MATE + 1000) st -= ply;
      ttK1[idx] = a1; ttK2[idx] = a2; ttMove[idx] = bestMove; ttScore[idx] = st; ttDepth[idx] = depth;
      ttFlag[idx] = best <= origAlpha ? TT_UPPER : (best >= beta ? TT_LOWER : TT_EXACT);
    }
    return best;
  };

  Search.prototype.quiesce = function (alpha, beta, ply, qd) {
    var pos = this.pos;
    this.tick();
    if (isDeadBoard(pos.board)) return 0;
    var check = I.inCheck(pos), moves, best;
    if (check && qd < 6) {
      moves = genLegal(pos, false);
      if (!moves.length) return -MATE + ply;
      best = -INF;
    } else {
      var stand = evaluate(pos, this.full);
      if (stand >= beta || ply >= MAX_PLY + 6) return stand;
      if (stand > alpha) alpha = stand;
      best = stand;
      moves = genLegal(pos, true);
    }
    this.orderMoves(moves, 0, Math.min(ply, MAX_PLY));
    for (var i = 0; i < moves.length; i++) {
      makeMove(pos, moves[i]);
      var score;
      try { score = -this.quiesce(-beta, -alpha, ply + 1, qd + 1); } finally { unmakeMove(pos); }
      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    return best;
  };

  // Exact root scores for every move (used for Easy's controlled randomness).
  Search.prototype.scoreAll = function (moves, depth) {
    var out = [], pos = this.pos;
    hashPos(pos); this.h1.push(H1); this.h2.push(H2);
    for (var i = 0; i < moves.length; i++) {
      makeMove(pos, moves[i]);
      try { out.push({ move: moves[i], score: -this.search(depth - 1, 1, -INF, INF) }); }
      finally { unmakeMove(pos); }
    }
    this.h1.pop(); this.h2.pop();
    return out;
  };

  Search.prototype.rootSearch = function (moves, depth) {
    var pos = this.pos, alpha = -INF, beta = INF, best = -INF, bestMove = moves[0], scores = [];
    hashPos(pos); this.h1.push(H1); this.h2.push(H2);
    try {
      for (var i = 0; i < moves.length; i++) {
        makeMove(pos, moves[i]);
        var score;
        try {
          if (i === 0) score = -this.search(depth - 1, 1, -beta, -alpha);
          else {
            score = -this.search(depth - 1, 1, -alpha - 1, -alpha);
            if (score > alpha) score = -this.search(depth - 1, 1, -beta, -alpha);
          }
        } finally { unmakeMove(pos); }
        scores.push(score);
        if (score > best) { best = score; bestMove = moves[i]; }
        if (score > alpha) alpha = score;
      }
    } finally { this.h1.pop(); this.h2.pop(); }
    return { move: bestMove, score: best, scores: scores };
  };

  /*
   * think(state, levelName, options) -> { move, score, depth, nodes, ms }
   *   move  : rich move description (same shape as Rules.legalMoves entries)
   *   score : centipawns from the mover's point of view
   * options: { timeMs, maxDepth, random, now }
   */
  function think(state, levelName, options) {
    options = options || {};
    var level = LEVELS[levelName] || LEVELS.medium;
    var random = options.random || Math.random;
    var s = new Search(state, level, options);
    var pos = s.pos;
    var t0 = s.now();
    var timeMs = options.timeMs != null ? options.timeMs : level.timeMs;
    var maxDepth = options.maxDepth || level.maxDepth;
    var moves = genLegal(pos, false);
    if (!moves.length) return null;
    if (!level.useTT) clearTT();

    var bestMove = moves[0], bestScore = 0, depthDone = 0;
    if (moves.length === 1) {
      bestScore = evaluate(pos, level.fullEval);
    } else if (level.noise > 0) {
      // Easy: exact shallow scores, then a noisy pick among reasonable moves.
      s.deadline = t0 + timeMs * 4; s.canStop = false;
      var scored = s.scoreAll(moves.slice(), Math.min(maxDepth, 2));
      depthDone = Math.min(maxDepth, 2);
      scored.sort(function (x, y) { return y.score - x.score; });
      var top = scored[0].score;
      var pool;
      if (top > MATE - 1000) pool = [scored[0]];
      else {
        var safe = scored.filter(function (x) { return x.score > -MATE + 1000; });
        if (!safe.length) safe = scored;
        if (random() < level.blunderRate) pool = safe.filter(function (x) { return x.score >= top - 300; }).slice(0, 4);
        else pool = safe.filter(function (x) { return x.score >= top - 120; });
        if (!pool.length) pool = [scored[0]];
      }
      var pick = pool[0], pickVal = -INF;
      for (var i = 0; i < pool.length; i++) {
        var v = pool[i].score + random() * level.noise;
        if (v > pickVal) { pickVal = v; pick = pool[i]; }
      }
      bestMove = pick.move; bestScore = pick.score;
    } else {
      s.deadline = t0 + timeMs;
      var order = moves.slice();
      for (var depth = 1; depth <= maxDepth; depth++) {
        s.canStop = depth > 1;
        var r;
        try { r = s.rootSearch(order, depth); }
        catch (e) { if (e === ABORT) break; throw e; }
        bestMove = r.move; bestScore = r.score; depthDone = depth;
        // Re-order root moves: best first, then by score.
        var paired = order.map(function (m, j) { return { m: m, s: r.scores[j] }; });
        paired.sort(function (x, y) { return y.s - x.s; });
        order = paired.map(function (x) { return x.m; });
        if (Math.abs(bestScore) > MATE - 1000 && depth >= (MATE - Math.abs(bestScore))) break;
        if (s.now() - t0 > timeMs * 0.55) break;
      }
    }
    return {
      move: I.describe(pos, bestMove), score: bestScore, depth: depthDone,
      nodes: s.nodes, ms: s.now() - t0
    };
  }

  return { LEVELS: LEVELS, think: think, evaluate: function (state, full) { return evaluate(I.toPos(state), full !== false); }, MATE: MATE, clearTT: clearTT };
}

var RiftAI = RiftAIFactory(RiftRules);
if (typeof module !== 'undefined' && module.exports) module.exports = RiftAI;
