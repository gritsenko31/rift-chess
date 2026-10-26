/*
 * Rift Chess — automated tests.
 * Runs in the browser (tests.html) and in Node (node run-tests.js).
 * Requires RiftRules, RiftAI and RiftGame to be loaded first.
 */
(function (global) {
  'use strict';

  var R = global.RiftRules, AI = global.RiftAI, G = global.RiftGame;
  var tests = [];
  function test(name, fn) { tests.push({ name: name, fn: fn }); }

  /* --------------------------------------------------------------- helpers */
  function AssertError(msg) { this.message = msg; this.name = 'AssertError'; }
  AssertError.prototype = Object.create(Error.prototype);
  function ok(v, msg) { if (!v) throw new AssertError(msg || 'expected truthy'); }
  function eq(a, b, msg) {
    if (a !== b) throw new AssertError((msg ? msg + ': ' : '') + 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
  }
  function deepEq(a, b, msg) { eq(JSON.stringify(a), JSON.stringify(b), msg); }

  var S = R.sqIndex;
  function fen(f) { return R.parseFEN(f); }
  function spec(uci) {
    return { from: uci.slice(0, 2), to: uci.slice(2, 4), promo: uci.length > 4 ? uci[4] : 0 };
  }
  function play(state) {
    for (var i = 1; i < arguments.length; i++) state = R.applyMove(state, spec(arguments[i])).state;
    return state;
  }
  function move(state, uci) { return R.applyMove(state, spec(uci)); }
  function isLegal(state, uci) { return R.findMove(state, spec(uci)) !== null; }
  function at(state, sq) { return state.board[S(sq)]; }
  function P(color, type) { return R.makePiece(color, type); }
  var W = R.WHITE, B = R.BLACK;
  function movesFrom(state, sq) { return R.legalMoves(state).filter(function (m) { return m.from === S(sq); }); }

  function memoryStorage(initial) {
    var data = {};
    if (initial) for (var k in initial) data[k] = initial[k];
    return {
      data: data,
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) { data[k] = String(v); },
      removeItem: function (k) { delete data[k]; }
    };
  }

  // Fake AI runner: records requests; tests decide when (and whether) they complete.
  function fakeRunner() {
    var pending = [];
    return {
      pending: pending,
      usesWorker: function () { return false; },
      busy: function () { return pending.length > 0; },
      request: function (state, level, cb) { pending.push({ state: state, level: level, cb: cb }); return pending.length; },
      cancel: function () { pending.cancelled = (pending.cancelled || 0) + 1; }
    };
  }
  function syncGame(opts) {
    opts = opts || {};
    return G.createGame({
      storage: opts.storage || memoryStorage(), aiRunner: opts.aiRunner || null, noRestore: opts.noRestore,
      setTimeout: function (f) { f(); return 0; }, clearTimeout: function () {}
    });
  }

  /* --------------------------------------------------- base move generator */

  test('Standard initial position', function () {
    var s = R.createInitialState();
    eq(R.toFEN(s), R.START_FEN);
    eq(s.turn, W, 'White moves first');
    eq(R.legalMoves(s).length, 20);
    eq(at(s, 'e1'), P(W, R.KING)); eq(at(s, 'd8'), P(B, R.QUEEN));
    eq(R.getStatus(s).over, false);
  });

  test('Orthodox perft matches known values when portals are disabled', function () {
    var I = R.internal, saved = R.PORTAL_EXIT.slice();
    function perft(pos, d) {
      var ms = I.genLegal(pos, false);
      if (d === 1) return ms.length;
      var n = 0;
      for (var i = 0; i < ms.length; i++) { I.makeMove(pos, ms[i]); n += perft(pos, d - 1); I.unmakeMove(pos); }
      return n;
    }
    try {
      for (var i = 0; i < 64; i++) R.PORTAL_EXIT[i] = -1;
      eq(perft(I.toPos(R.createInitialState()), 3), 8902, 'start d3');
      eq(perft(I.toPos(fen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1')), 3), 97862, 'kiwipete d3');
      eq(perft(I.toPos(fen('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1')), 4), 43238, 'position 3 d4');
      eq(perft(I.toPos(fen('r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1')), 3), 9467, 'position 4 d3');
    } finally {
      for (var j = 0; j < 64; j++) R.PORTAL_EXIT[j] = saved[j];
    }
  });

  test('Movement and sliding blockers', function () {
    var s = fen('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
    eq(movesFrom(s, 'a1').length, 10, 'rook a1 open lines');
    s = fen('4k3/8/8/P7/8/8/8/R3K3 w - - 0 1');
    eq(movesFrom(s, 'a1').length, 6, 'own pawn on a5 blocks');
    ok(!isLegal(s, 'a1a6'), 'cannot jump over blocker');
    eq(movesFrom(R.createInitialState(), 'a1').length, 0, 'rook boxed in at start');
    eq(movesFrom(R.createInitialState(), 'b1').length, 2, 'knight jumps');
  });

  test('Captures', function () {
    var s = fen('4k3/8/8/n7/8/8/8/R3K3 w - - 5 1');
    var r = move(s, 'a1a5');
    ok(r.move.capture, 'flagged as capture');
    eq(at(r.state, 'a5'), P(W, R.ROOK));
    eq(r.state.halfmove, 0, 'capture resets halfmove clock');
    ok(!isLegal(s, 'a1a6'), 'cannot pass through enemy piece');
  });

  /* ---------------------------------------------------------------- portals */

  test('Portal teleportation (Nb1-c3 emerges on f6)', function () {
    var r = move(R.createInitialState(), 'b1c3');
    ok(r.move.teleported);
    eq(r.move.exit, S('f6'));
    eq(at(r.state, 'c3'), 0, 'entry empty');
    eq(at(r.state, 'f6'), P(W, R.KNIGHT), 'knight on exit');
    eq(r.move.notation, 'Nb1-c3→f6+', 'the knight on f6 already checks e8');
    var p = move(R.createInitialState(), 'f2f3');
    ok(p.move.teleported, '1.f3 sends the pawn through pair B');
    eq(at(p.state, 'f3'), 0);
    eq(at(p.state, 'c6'), P(W, R.PAWN));
  });

  test('Pawn teleport keeps its colour direction', function () {
    var s = play(R.createInitialState(), 'c2c3');
    eq(at(s, 'f6'), P(W, R.PAWN), 'white pawn emerged on f6');
    s = play(s, 'a7a6');
    ok(isLegal(s, 'f6e7'), 'white pawn on f6 captures toward rank 8');
    ok(!isLegal(s, 'f6f5'), 'pawn does not move backwards');
    var t = fen('4k3/8/8/8/1P6/8/8/4K3 w - - 0 1');
    ok(!isLegal(t, 'b4b6'), 'no double move away from the start rank');
  });

  test('Friendly occupied exit blocks teleport', function () {
    var r = move(fen('4k3/8/5P2/8/8/8/8/1N2K3 w - - 0 1'), 'b1c3');
    ok(!r.move.teleported && r.move.portalBlocked);
    eq(at(r.state, 'c3'), P(W, R.KNIGHT), 'stays on entry');
    eq(at(r.state, 'f6'), P(W, R.PAWN));
  });

  test('Enemy occupied exit blocks teleport and is never captured', function () {
    var r = move(fen('4k3/8/5p2/8/8/8/8/1N2K3 w - - 0 1'), 'b1c3');
    ok(r.move.portalBlocked);
    eq(at(r.state, 'c3'), P(W, R.KNIGHT));
    eq(at(r.state, 'f6'), P(B, R.PAWN), 'no capture at the exit');
    ok(!r.move.capture);
  });

  test('Capture at entry followed by teleport', function () {
    var r = move(fen('4k3/8/8/8/8/2p5/8/1N2K3 w - - 3 1'), 'b1c3');
    ok(r.move.capture && r.move.teleported);
    eq(r.move.capturedName, 'pawn');
    eq(at(r.state, 'c3'), 0);
    eq(at(r.state, 'f6'), P(W, R.KNIGHT));
    eq(r.state.halfmove, 0);
  });

  test('No teleport loops and standing on a portal does nothing', function () {
    var s = play(R.createInitialState(), 'b1c3'); // knight now on f6
    eq(at(s, 'f6'), P(W, R.KNIGHT));
    eq(at(s, 'c3'), 0, 'did not bounce back to c3');
    s = play(fen('k7/8/5N2/8/8/8/P7/4K3 w - - 0 1'), 'a2a3', 'a8b8');
    eq(at(s, 'f6'), P(W, R.KNIGHT), 'still on f6 after a later turn');
    // Bishop on f6 moving to c3 vacates its own square, so it returns to f6 once.
    var t = move(fen('4k3/8/5B2/8/8/2p5/8/4K3 w - - 0 1'), 'f6c3');
    ok(t.move.capture && t.move.teleported);
    eq(t.move.exit, S('f6'));
    eq(at(t.state, 'f6'), P(W, R.BISHOP));
    eq(at(t.state, 'c3'), 0);
  });

  test('Passing across a portal does not activate it', function () {
    var r = move(fen('4k3/8/8/8/8/8/8/B3K3 w - - 0 1'), 'a1d4');
    ok(!r.move.teleported);
    eq(at(r.state, 'd4'), P(W, R.BISHOP));
    var p = move(R.createInitialState(), 'c2c4');
    eq(at(p.state, 'c4'), P(W, R.PAWN), 'double move passes c3 without teleport');
  });

  test('Kings never teleport', function () {
    var r = move(fen('4k3/8/8/8/8/8/3K4/8 w - - 0 1'), 'd2c3');
    ok(!r.move.teleported);
    eq(at(r.state, 'c3'), P(W, R.KING));
    eq(at(r.state, 'f6'), 0);
  });

  test('A king on the exit blocks teleportation', function () {
    var r = move(fen('8/8/5k2/8/8/8/8/1N2K3 w - - 0 1'), 'b1c3');
    ok(r.move.portalBlocked);
    eq(at(r.state, 'c3'), P(W, R.KNIGHT));
    eq(at(r.state, 'f6'), P(B, R.KING));
  });

  /* ------------------------------------------------------------ king safety */

  test('Portal moves that expose their own king are illegal', function () {
    var s = fen('7k/8/8/8/8/KR5r/8/8 w - - 0 1');
    ok(!isLegal(s, 'b3c3'), 'Rc3 would teleport to f6 and expose the king');
    ok(!isLegal(s, 'b3f3'), 'Rf3 would teleport to c6 and expose the king');
    ok(isLegal(s, 'b3d3') && isLegal(s, 'b3e3') && isLegal(s, 'b3h3'));
    ok(!isLegal(s, 'b3b4'), 'ordinary pin');
  });

  test('Check can be escaped by a completed portal move', function () {
    var s = fen('8/8/K6r/8/8/8/8/1N5k w - - 0 1');
    ok(R.inCheck(s));
    var m = movesFrom(s, 'b1');
    eq(m.length, 1, 'only Nc3 (emerging on f6) blocks');
    eq(m[0].exit, S('f6'));
    // The position on c3 alone (before the mandatory teleport) would still be check.
  });

  test('Interposing on a portal fails when the piece is forced through', function () {
    var s = fen('7k/8/8/8/8/K6r/8/1N6 w - - 0 1');
    ok(R.inCheck(s));
    ok(!isLegal(s, 'b1c3'), 'Nc3 would block on c3 but teleports away');
    var t = fen('7k/8/5p2/8/8/K6r/8/1N6 w - - 0 1');
    ok(isLegal(t, 'b1c3'), 'with f6 occupied the knight stays on c3 and blocks');
  });

  test('Check delivered from the final exit square', function () {
    var r = move(fen('4k3/8/8/8/8/8/8/1N2K3 w - - 0 1'), 'b1c3');
    ok(r.move.check, 'knight on f6 checks e8');
    ok(R.inCheck(r.state));
    eq(r.move.notation, 'Nb1-c3→f6+');
  });

  test('No fictitious remote attacks through portals', function () {
    var s = fen('8/8/5k2/8/8/8/8/1N2K3 b - - 0 1');
    ok(!R.inCheck(s), 'a knight attacking c3 does not attack f6');
    ok(R.isSquareAttacked(s, 'c3', W));
    ok(!R.isSquareAttacked(s, 'f6', W));
    var t = fen('8/8/8/8/8/8/8/1N2K2k b - - 0 1');
    ok(!R.isSquareAttacked(t, 'f6', W));
  });

  test('Pawn attack geometry', function () {
    var s = fen('4k3/8/8/8/4P3/8/8/4K3 b - - 0 1');
    ok(R.isSquareAttacked(s, 'd5', W) && R.isSquareAttacked(s, 'f5', W));
    ok(!R.isSquareAttacked(s, 'e5', W), 'pawns do not attack forward');
    var b = fen('4k3/8/8/4p3/8/8/8/4K3 w - - 0 1');
    ok(R.isSquareAttacked(b, 'd4', B) && R.isSquareAttacked(b, 'f4', B) && !R.isSquareAttacked(b, 'd6', B));
  });

  test('Pinned pieces still give check for king-safety purposes', function () {
    // The black knight on e6 is pinned to its king by Re1, yet it still guards d4.
    var s = fen('4k3/8/4n3/8/8/3K4/8/4R3 w - - 0 1');
    ok(R.isSquareAttacked(s, 'd4', B));
    ok(!isLegal(s, 'd3d4'), 'king may not step onto a square a pinned piece attacks');
    ok(isLegal(s, 'd3d2'));
  });

  test('Kings may not stand adjacent', function () {
    var s = fen('8/8/4k3/8/4K3/8/8/8 w - - 0 1');
    ok(!isLegal(s, 'e4e5') && !isLegal(s, 'e4d5') && !isLegal(s, 'e4f5'));
    ok(isLegal(s, 'e4e3'));
  });

  /* --------------------------------------------------------------- castling */

  test('Castling in both directions', function () {
    var s = fen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    var k = move(s, 'e1g1');
    ok(k.move.castle);
    eq(at(k.state, 'g1'), P(W, R.KING)); eq(at(k.state, 'f1'), P(W, R.ROOK)); eq(at(k.state, 'h1'), 0);
    eq(k.state.castling & (R.CASTLE_WK | R.CASTLE_WQ), 0, 'white rights gone');
    eq(k.move.notation, 'O-O');
    var q = move(s, 'e1c1');
    eq(at(q.state, 'c1'), P(W, R.KING)); eq(at(q.state, 'd1'), P(W, R.ROOK)); eq(at(q.state, 'a1'), 0);
    var bs = fen('r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1');
    var bk = move(bs, 'e8g8'), bq = move(bs, 'e8c8');
    eq(at(bk.state, 'f8'), P(B, R.ROOK)); eq(at(bq.state, 'd8'), P(B, R.ROOK));
  });

  test('Castling out of, through, or into check is illegal', function () {
    ok(!isLegal(fen('5r1k/8/8/8/8/8/8/R3K2R w KQ - 0 1'), 'e1g1'), 'through f1');
    ok(isLegal(fen('5r1k/8/8/8/8/8/8/R3K2R w KQ - 0 1'), 'e1c1'));
    ok(!isLegal(fen('6rk/8/8/8/8/8/8/R3K2R w KQ - 0 1'), 'e1g1'), 'into g1');
    var inCheck = fen('4r2k/8/8/8/8/8/8/R3K2R w KQ - 0 1');
    ok(!isLegal(inCheck, 'e1g1') && !isLegal(inCheck, 'e1c1'), 'out of check');
    ok(isLegal(fen('1r5k/8/8/8/8/8/8/R3K2R w KQ - 0 1'), 'e1c1'), 'b1 attacked does not matter');
    ok(!isLegal(fen('7k/8/8/8/8/8/8/RN2K2R w KQ - 0 1'), 'e1c1'), 'blocked by b1 knight');
  });

  test('Castling rights are lost permanently when king or rook moves', function () {
    var s = fen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    var a = play(s, 'e1f1', 'a8b8', 'f1e1', 'b8a8');
    ok(!isLegal(a, 'e1g1') && !isLegal(a, 'e1c1'), 'king returned but rights gone');
    eq(a.castling & (R.CASTLE_BK | R.CASTLE_BQ), R.CASTLE_BK, 'black lost only queenside');
    var b = play(s, 'h1h2', 'e8e7', 'h2h1', 'e7e8');
    ok(!isLegal(b, 'e1g1') && isLegal(b, 'e1c1'));
  });

  test('Captured original rook cannot be replaced by a promoted rook', function () {
    var s = fen('k7/6P1/8/8/8/8/6b1/4K2R b K - 0 1');
    s = play(s, 'g2h1');
    eq(s.castling & R.CASTLE_WK, 0, 'capturing the rook removes the right');
    s = play(s, 'g7g8r', 'a8a7', 'g8g1', 'a7a8', 'g1h1', 'a8a7');
    eq(at(s, 'h1'), P(W, R.ROOK));
    ok(!isLegal(s, 'e1g1'), 'promoted rook on h1 does not restore castling');
  });

  /* ------------------------------------------------------------- en passant */

  test('En passant capture', function () {
    var s = play(fen('4k3/3p4/8/4P3/8/8/8/4K3 b - - 0 1'), 'd7d5');
    eq(s.epTarget, S('d6')); eq(s.epPawn, S('d5'));
    var r = move(s, 'e5d6');
    ok(r.move.enPassant && r.move.capture);
    eq(at(r.state, 'd5'), 0, 'captured pawn removed');
    eq(at(r.state, 'd6'), P(W, R.PAWN));
    eq(r.state.halfmove, 0);
  });

  test('En passant onto a portal then teleports', function () {
    var s = play(fen('4k3/8/8/8/1p6/8/2P5/4K3 w - - 0 1'), 'c2c4');
    eq(at(s, 'c4'), P(W, R.PAWN));
    var r = move(s, 'b4c3');
    ok(r.move.enPassant && r.move.teleported);
    eq(at(r.state, 'c4'), 0); eq(at(r.state, 'c3'), 0);
    eq(at(r.state, 'f6'), P(B, R.PAWN), 'capturing pawn emerged on f6');
    var w = play(fen('4k3/2p5/8/1P6/8/8/8/4K3 b - - 0 1'), 'c7c5');
    var r2 = move(w, 'b5c6');
    eq(at(r2.state, 'f3'), P(W, R.PAWN), 'white pawn landed on c6 and emerged on f3');
    eq(at(r2.state, 'c5'), 0);
  });

  test('En passant that exposes the king is illegal', function () {
    var s = play(fen('7k/2p5/8/KP5r/8/8/8/8 b - - 0 1'), 'c7c5');
    ok(!isLegal(s, 'b5c6'), 'removing both pawns opens the rank');
    eq(R.positionKeyOf(s).slice(-1), '-', 'illegal en passant is not part of the identity');
  });

  test('En passant rights expire after one turn', function () {
    var s = play(fen('4k3/3p4/8/4P3/8/8/8/K7 b - - 0 1'), 'd7d5', 'a1a2', 'e8e7');
    ok(!isLegal(s, 'e5d6'));
    eq(s.epTarget, -1);
  });

  /* -------------------------------------------------------------- promotion */

  test('All four promotion choices', function () {
    var s = fen('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
    var promos = movesFrom(s, 'a7').filter(function (m) { return m.to === S('a8'); }).map(function (m) { return m.promo; }).sort();
    deepEq(promos, [R.KNIGHT, R.BISHOP, R.ROOK, R.QUEEN].sort());
    [['q', R.QUEEN], ['r', R.ROOK], ['b', R.BISHOP], ['n', R.KNIGHT]].forEach(function (x) {
      var r = move(s, 'a7a8' + x[0]);
      eq(at(r.state, 'a8'), P(W, x[1]));
    });
    eq(R.findMove(s, { from: 'a7', to: 'a8' }), null, 'promotion piece must be chosen');
    var c = move(fen('1r2k3/P7/8/8/8/8/8/4K3 w - - 0 1'), 'a7b8n');
    ok(c.move.capture); eq(at(c.state, 'b8'), P(W, R.KNIGHT));
  });

  /* -------------------------------------------------------- game end states */

  test('Variant checkmate: interposing on a portal fails', function () {
    var s = fen('8/8/8/b5K1/8/R6k/6pp/8 b - - 0 1');
    var st = R.getStatus(s);
    eq(st.reason, 'checkmate'); eq(st.result, '1-0');
    // Same position with f6 occupied: Bc3 now blocks, so it is not mate.
    var t = fen('8/8/5P2/b5K1/8/R6k/6pp/8 b - - 0 1');
    eq(R.getStatus(t).over, false);
    ok(isLegal(t, 'a5c3'));
  });

  test('Variant stalemate: the only pawn move would teleport out of a pin', function () {
    var s = fen('5k2/3K4/8/4N3/5p2/8/8/5RR1 b - - 0 1');
    ok(!R.inCheck(s));
    eq(R.legalMoves(s).length, 0);
    eq(R.getStatus(s).reason, 'stalemate');
    var t = fen('5k2/3K4/2P5/4N3/5p2/8/8/5RR1 b - - 0 1');
    ok(isLegal(t, 'f4f3'), 'with c6 occupied the pawn stays on f3 and keeps blocking');
  });

  test('Ordinary checkmate (portal-aware)', function () {
    var s = play(R.createInitialState(), 'f2f4', 'e7e5', 'g2g4');
    var r = move(s, 'd8h4');
    ok(r.move.mate);
    eq(R.getStatus(r.state).reason, 'checkmate');
    eq(R.getStatus(r.state).result, '0-1');
  });

  test('Threefold repetition is claimable, fivefold is automatic', function () {
    var cycle = ['b1a3', 'g8h6', 'a3b1', 'h6g8'];
    var s = R.createInitialState();
    for (var i = 0; i < 7; i++) s = play(s, cycle[i % 4]);
    var c = R.getDrawClaims(s);
    eq(c.now.length, 0, 'not yet three occurrences');
    ok(c.viaMove.some(function (x) { return x.move.uci === 'h6g8' && x.reasons[0] === 'threefold'; }), 'claim by intended move');
    var viaClaim = R.claimDraw(s, R.findMove(s, spec('h6g8')));
    ok(viaClaim.ok); eq(at(viaClaim.state, 'g8'), P(B, R.KNIGHT));
    s = play(s, 'h6g8');
    eq(R.getStatus(s).over, false, 'threefold is not automatic');
    deepEq(R.getDrawClaims(s).now, ['threefold']);
    ok(R.claimDraw(s, null).ok);
    for (i = 8; i < 16; i++) s = play(s, cycle[i % 4]);
    eq(R.countOccurrences(s.history, s.history[s.history.length - 1]), 5);
    eq(R.getStatus(s).reason, 'fivefold');
  });

  test('Invalid claims are refused', function () {
    var s = R.createInitialState();
    eq(R.claimDraw(s, null).ok, false);
    eq(R.claimDraw(s, R.findMove(s, spec('e2e4'))).ok, false);
  });

  test('Position identity includes castling rights', function () {
    var s = fen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    var t = play(s, 'h1h2', 'h8h7', 'h2h1', 'h7h8');
    eq(t.board.join(), s.board.join(), 'same placement');
    ok(R.positionKeyOf(t) !== R.positionKeyOf(s), 'different castling rights');
    eq(R.countOccurrences(t.history, t.history[t.history.length - 1]), 1);
  });

  test('Only legally relevant en passant enters the repetition identity', function () {
    var irrelevant = play(fen('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1'), 'e2e4');
    eq(irrelevant.epTarget, S('e3'));
    eq(R.positionKeyOf(irrelevant), R.positionKeyOf(fen('4k3/8/8/8/4P3/8/8/4K3 b - - 0 1')));
    var relevant = play(fen('4k3/8/8/8/3p4/8/4P3/4K3 w - - 0 1'), 'e2e4');
    eq(R.positionKeyOf(relevant).slice(-2), 'e3');
    ok(R.positionKeyOf(relevant) !== R.positionKeyOf(fen('4k3/8/8/8/3pP3/8/8/4K3 b - - 0 1')));
  });

  test('Fifty-move rule claims (now and by intended move)', function () {
    var s = fen('4k3/8/8/8/8/8/8/R3K3 w - - 99 60');
    var c = R.getDrawClaims(s);
    eq(c.now.length, 0);
    ok(c.viaMove.some(function (x) { return x.move.uci === 'a1a2' && x.reasons.indexOf('fifty') >= 0; }));
    ok(!c.viaMove.some(function (x) { return x.move.capture; }), 'captures reset the clock and do not qualify');
    var t = play(s, 'a1a2');
    eq(t.halfmove, 100);
    eq(R.getStatus(t).over, false, 'fifty-move rule is not automatic');
    deepEq(R.getDrawClaims(t).now, ['fifty']);
  });

  test('Seventy-five-move rule is automatic', function () {
    var s = play(fen('4k3/8/8/8/8/8/8/R3K3 w - - 149 90'), 'a1a2');
    eq(s.halfmove, 150);
    eq(R.getStatus(s).reason, 'seventy-five');
  });

  test('Halfmove clock resets and portal moves', function () {
    var s = fen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 7 5');
    eq(play(s, 'b1c3').halfmove, 8, 'quiet knight teleport does not reset');
    eq(play(s, 'c2c3').halfmove, 0, 'pawn move (even teleporting) resets');
    eq(play(s, 'e2e4').halfmove, 0);
    eq(play(s, 'g1h3').halfmove, 8);
  });

  test('Checkmate takes precedence over the seventy-five-move rule', function () {
    var r = move(fen('7k/8/6K1/8/8/8/8/R7 w - - 149 100'), 'a1a8');
    eq(r.state.halfmove, 150);
    eq(R.getStatus(r.state).reason, 'checkmate');
  });

  test('Dead positions recognised', function () {
    eq(R.getStatus(fen('8/8/8/4k3/8/8/8/4K3 w - - 0 1')).reason, 'dead', 'K v K');
    eq(R.getStatus(fen('8/8/8/4k3/8/8/8/4KN2 w - - 0 1')).reason, 'dead', 'KN v K');
    eq(R.getStatus(fen('8/8/8/4k3/8/8/8/4KB2 w - - 0 1')).reason, 'dead', 'KB v K');
    eq(R.getStatus(fen('8/8/8/4k3/8/8/8/3bKB2 w - - 0 1')).reason, 'dead', 'same-colour bishops');
    eq(R.getStatus(fen('8/8/8/4k3/8/8/8/2b1KB2 w - - 0 1')).over, false, 'opposite-colour bishops');
    eq(R.getStatus(fen('8/8/8/4k3/8/8/8/3NKN2 w - - 0 1')).over, false, 'two knights');
    eq(R.getStatus(fen('8/8/8/4k3/8/8/8/3nKN2 w - - 0 1')).over, false, 'knight each');
    eq(R.getStatus(fen('8/8/8/4k3/8/8/4P3/4K3 w - - 0 1')).over, false, 'pawn');
    var r = move(fen('8/8/8/8/8/8/3r4/4K2k w - - 0 1'), 'e1d2');
    eq(R.getStatus(r.state).reason, 'dead', 'capture leaves K v K');
    // Both portal pairs connect squares of the same colour.
    eq(R.squareColor(S('c3')), R.squareColor(S('f6')));
    eq(R.squareColor(S('f3')), R.squareColor(S('c6')));
  });

  /* ------------------------------------------------------ controller / undo */

  test('Undo restores all special state', function () {
    var g = syncGame({ noRestore: true });
    g.setMode('local');
    var start = JSON.stringify(g._record().game);
    ['e2e4', 'd7d5', 'e4e5', 'f7f5'].forEach(function (u) { ok(g.playMove(spec(u)), u); });
    var beforeEp = JSON.stringify(g._record().game);
    var beforeMoves = g._record().moves.length;
    eq(g._record().game.epTarget, S('f6'));
    ok(g.playMove(spec('e5f6')), 'en passant (lands on portal f6, exit c3 empty -> teleports)');
    eq(g._record().game.board[S('c3')], P(W, R.PAWN));
    ok(g.undo());
    eq(JSON.stringify(g._record().game), beforeEp, 'board, rights, ep, clocks, repetition history');
    eq(g._record().moves.length, beforeMoves);
    ok(g.playMove(spec('g1h3')) && g.playMove(spec('e8f7')) && g.playMove(spec('a2a3')));
    g.resign();
    ok(g._record().result);
    ok(g.undo(), 'undo after game over');
    eq(g._record().result, null, 'result cleared');
    while (g.undo()) { /* back to start */ }
    eq(JSON.stringify(g._record().game), start);
    eq(g._record().moves.length, 0);
  });

  test('Undo of castling and promotion restores rights', function () {
    var g = syncGame({ noRestore: true });
    g.setMode('local');
    ['e2e4', 'e7e5', 'g1h3', 'g8h6', 'f1e2', 'f8e7'].forEach(function (u) { ok(g.playMove(spec(u)), u); });
    var before = JSON.stringify(g._record().game);
    ok(g.playMove(spec('e1g1')));
    eq(g._record().game.castling & (R.CASTLE_WK | R.CASTLE_WQ), 0);
    g.undo();
    eq(JSON.stringify(g._record().game), before);
    eq(g._record().game.castling, 15);
  });

  test('Computer mode undo removes the human move and the reply', function () {
    var runner = fakeRunner();
    var g = syncGame({ noRestore: true, aiRunner: runner });
    g.start();
    ok(g.playMove(spec('e2e4')));
    eq(runner.pending.length, 1, 'search requested');
    ok(g.getView().thinking);
    var req = runner.pending[0];
    var reply = AI.think(req.state, 'easy', { timeMs: 30 });
    req.cb(reply);
    eq(g._record().moves.length, 2);
    eq(g._record().game.turn, W);
    ok(g.undo());
    eq(g._record().moves.length, 0, 'both plies undone');
    eq(g.getView().thinking, false);
  });

  test('Cancelled AI searches never apply stale moves', function () {
    var runner = fakeRunner();
    var g = syncGame({ noRestore: true, aiRunner: runner });
    g.start();
    g.playMove(spec('e2e4'));
    var stale = runner.pending[0];
    var staleReply = AI.think(stale.state, 'easy', { timeMs: 30 });
    ok(g.undo(), 'undo while computer is thinking');
    eq(g.getView().thinking, false, 'board unlocked');
    ok(g.getView().humanTurn);
    stale.cb(staleReply); // arrives late
    eq(g._record().moves.length, 0, 'stale reply ignored after undo');
    g.playMove(spec('d2d4'));
    var second = runner.pending[1];
    g.newGame();
    second.cb(AI.think(second.state, 'easy', { timeMs: 30 }));
    eq(g._record().moves.length, 0, 'stale reply ignored after new game');
    g.playMove(spec('d2d4'));
    var third = runner.pending[2];
    g.setMode('local');
    third.cb(AI.think(third.state, 'easy', { timeMs: 30 }));
    eq(g._record().moves.length, 0, 'stale reply ignored after mode change');
    ok(runner.pending.cancelled >= 3, 'runner cancelled');
  });

  test('Computer claims a valid draw when worse', function () {
    var runner = fakeRunner();
    var g = syncGame({ noRestore: true, aiRunner: runner });
    // Build a position where Black (computer) can claim threefold.
    g.start();
    var cycle = ['b1a3', 'g8h6', 'a3b1', 'h6g8'];
    for (var i = 0; i < 8; i++) {
      if (i % 2 === 0) ok(g.playMove(spec(cycle[i % 4])), 'human ' + i);
      else {
        var req = runner.pending[runner.pending.length - 1];
        var mv = R.legalMoves(req.state).filter(function (m) { return m.uci === cycle[i % 4]; })[0];
        req.cb({ move: mv, score: i === 7 ? -200 : 0 });
      }
    }
    var r = g._record().result;
    ok(r, 'game ended');
    eq(r.reason, 'claim-threefold');
    eq(r.result, '1/2-1/2');
  });

  test('Draw by agreement in local mode only', function () {
    var g = syncGame({ noRestore: true });
    eq(g.offerDraw(), false, 'no offers in computer mode');
    g.setMode('local');
    ok(g.offerDraw());
    ok(g.respondToDraw(false));
    eq(g._record().result, null);
    ok(g.offerDraw());
    ok(g.respondToDraw(true));
    eq(g._record().result.reason, 'agreement');
  });

  test('Resignation names the correct winner', function () {
    var g = syncGame({ noRestore: true });
    g.setMode('local');
    g.playMove(spec('e2e4'));
    g.resign(); // Black (to move) resigns
    eq(g._record().result.result, '1-0');
    var h = syncGame({ noRestore: true });
    h.resign(); // human (White) resigns in computer mode
    eq(h._record().result.result, '0-1');
    eq(h.playMove(spec('e2e4')), null, 'no moves after game over');
  });

  /* ------------------------------------------------------------ persistence */

  test('Save and restore', function () {
    var store = memoryStorage();
    var g = syncGame({ storage: store, noRestore: true });
    g.setMode('local');
    g.setLevel('hard');
    ['e2e4', 'd7d5', 'e4d5', 'd8d5'].forEach(function (u) { ok(g.playMove(spec(u))); });
    var rec = g._record();
    var h = syncGame({ storage: store });
    ok(h.restored, 'restored flag');
    var rec2 = h._record();
    eq(JSON.stringify(rec2.game), JSON.stringify(rec.game));
    eq(rec2.moves.length, 4); eq(rec2.undo.length, 4);
    eq(rec2.mode, 'local'); eq(rec2.level, 'hard');
    ok(h.undo());
    eq(h._record().moves.length, 3, 'undo history survived');
    var data = JSON.parse(store.data[G.STORAGE_KEY]);
    eq(data.version, G.SAVE_VERSION);
    ok(!('thinking' in data), 'no search state persisted');
  });

  test('Restore restarts the computer when it is its turn', function () {
    var store = memoryStorage();
    var g = syncGame({ storage: store, noRestore: true, aiRunner: fakeRunner() });
    g.start();
    g.playMove(spec('e2e4')); // computer to move, search never finished
    var runner = fakeRunner();
    var h = syncGame({ storage: store, aiRunner: runner });
    h.start();
    eq(runner.pending.length, 1, 'new search started after restore');
  });

  test('Malformed or unavailable storage does not crash', function () {
    var bad = memoryStorage(); bad.setItem(G.STORAGE_KEY, '{not json');
    var g = syncGame({ storage: bad });
    eq(g.restored, false);
    eq(g._record().moves.length, 0);
    var wrong = memoryStorage(); wrong.setItem(G.STORAGE_KEY, JSON.stringify({ version: 1, mode: 'ai', level: 'easy', humanColor: 0, game: { board: [1, 2, 3] }, moves: [], undo: [] }));
    eq(syncGame({ storage: wrong }).restored, false);
    var tampered = memoryStorage();
    var g2 = syncGame({ storage: tampered, noRestore: true }); g2.setMode('local'); g2.playMove(spec('e2e4'));
    var d = JSON.parse(tampered.data[G.STORAGE_KEY]); d.game.board[S('e4')] = 0;
    tampered.setItem(G.STORAGE_KEY, JSON.stringify(d));
    eq(syncGame({ storage: tampered }).restored, false, 'inconsistent board rejected');
    var throwing = { getItem: function () { throw new Error('denied'); }, setItem: function () { throw new Error('denied'); }, removeItem: function () { throw new Error('denied'); } };
    var t = syncGame({ storage: throwing });
    t.setMode('local');
    ok(t.playMove(spec('e2e4')), 'plays without storage');
    var n = syncGame({ storage: null });
    ok(n.getView());
  });

  test('New Game resets the saved position', function () {
    var store = memoryStorage();
    var g = syncGame({ storage: store, noRestore: true });
    g.setMode('local'); g.playMove(spec('e2e4'));
    g.newGame();
    var d = JSON.parse(store.data[G.STORAGE_KEY]);
    eq(d.moves.length, 0); eq(d.undo.length, 0);
    eq(R.toFEN(d.game), R.START_FEN);
  });

  /* --------------------------------------------------------------------- AI */

  var AI_POSITIONS = [
    R.START_FEN,
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    '4k3/P7/8/8/8/8/8/4K3 w - - 0 1',
    '7k/8/8/8/8/KR5r/8/8 w - - 0 1',
    '8/8/K6r/8/8/8/8/1N5k w - - 0 1',
    '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1',
    'r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1'
  ];

  ['easy', 'medium', 'hard'].forEach(function (level) {
    test('AI returns legal moves (' + level + ')', function () {
      AI_POSITIONS.forEach(function (f) {
        var s = fen(f), before = JSON.stringify(s);
        var r = AI.think(s, level, { timeMs: level === 'easy' ? undefined : 120 });
        ok(r && r.move, 'move for ' + f);
        ok(R.legalMoves(s).some(function (m) { return m.id === r.move.id; }), 'legal in ' + f);
        eq(JSON.stringify(s), before, 'search did not mutate the state');
      });
    });
  });

  test('AI finds a portal checkmate at every level', function () {
    var s = fen('3qkb2/3pnp2/8/8/8/8/8/1N2K3 w - - 0 1');
    ['easy', 'medium', 'hard'].forEach(function (level) {
      var r = AI.think(s, level, { timeMs: 200 });
      eq(r.move.uci, 'b1c3', level);
      ok(r.move.mate, level + ' mate');
    });
  });

  test('AI considers underpromotion', function () {
    // g7-g8=N is mate (the bishop on e5 covers g7 through the empty f6 portal); g8=Q is not.
    var s = fen('8/6Pp/6pk/4B1pp/8/8/8/4K3 w - - 0 1');
    ['medium', 'hard'].forEach(function (level) {
      var r = AI.think(s, level, { timeMs: 300 });
      eq(r.move.uci, 'g7g8n', level);
      ok(r.move.mate);
    });
    var t = fen('2b3k1/3P4/8/8/8/8/8/4K3 w - - 0 1');
    var all = R.legalMoves(t).filter(function (m) { return m.from === S('d7'); });
    eq(all.length, 8, 'd7-d8 and d7xc8, four promotion choices each');
  });

  test('AI runner (worker or fallback) delivers a legal move asynchronously', function () {
    var runner = G.createAIRunner();
    var s = R.createInitialState();
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new AssertError('timeout')); }, 8000);
      runner.request(s, 'easy', function (r) {
        clearTimeout(timer);
        try {
          ok(r && r.move, 'result');
          ok(R.legalMoves(s).some(function (m) { return m.id === r.move.id; }));
          resolve('worker: ' + runner.usesWorker());
        } catch (e) { reject(e); }
      });
    });
  });

  test('AI runner cancel prevents the callback', function () {
    var runner = G.createAIRunner();
    var called = false;
    runner.request(R.createInitialState(), 'easy', function () { called = true; });
    runner.cancel();
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        if (called) reject(new AssertError('cancelled search delivered a result')); else resolve();
      }, 900);
    });
  });

  /* ------------------------------------------------------------------ runner */

  function run(onResult) {
    var results = [], i = 0;
    return new Promise(function (resolve) {
      function next() {
        if (i >= tests.length) { resolve(results); return; }
        var t = tests[i++], t0 = Date.now();
        var done = function (err, note) {
          var r = { name: t.name, ok: !err, error: err ? (err.message || String(err)) : null, ms: Date.now() - t0, note: note || '' };
          results.push(r);
          if (onResult) onResult(r);
          setTimeout(next, 0);
        };
        try {
          var v = t.fn();
          if (v && typeof v.then === 'function') v.then(function (n) { done(null, n); }, function (e) { done(e || new Error('rejected')); });
          else done(null);
        } catch (e) { done(e); }
      }
      next();
    });
  }

  global.RiftTests = { tests: tests, run: run };
})(typeof window !== 'undefined' ? window : this);
