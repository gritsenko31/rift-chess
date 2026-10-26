/*
 * Rift Chess — pure rules engine.
 *
 * No DOM access. Everything here is deterministic and shared by the human
 * interface, the AI search (also inside a Web Worker), previews and tests.
 *
 * The whole module is a single factory function so that the AI worker can be
 * built from its source text (Function.prototype.toString) and still work when
 * index.html is opened directly from disk.
 */
function RiftRulesFactory() {
  'use strict';

  var WHITE = 0, BLACK = 1;
  var PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;

  var FLAG_CAPTURE = 1, FLAG_DOUBLE = 2, FLAG_EP = 4, FLAG_CASTLE = 8, FLAG_PROMO = 16;
  var CASTLE_WK = 1, CASTLE_WQ = 2, CASTLE_BK = 4, CASTLE_BQ = 8;

  var FILES = 'abcdefgh';
  var PIECE_CHARS = '.PNBRQK..pnbrqk.';
  var TYPE_NAMES = ['', 'pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];
  var TYPE_LETTERS = ['', '', 'N', 'B', 'R', 'Q', 'K'];

  function makePiece(color, type) { return color * 8 + type; }
  function colorOf(p) { return p >> 3; }
  function typeOf(p) { return p & 7; }
  function fileOf(s) { return s & 7; }
  function rankOf(s) { return s >> 3; }
  function sqName(s) { return FILES[s & 7] + ((s >> 3) + 1); }
  function sqIndex(name) {
    if (typeof name !== 'string' || name.length !== 2) return -1;
    var f = FILES.indexOf(name[0]), r = name.charCodeAt(1) - 49;
    if (f < 0 || r < 0 || r > 7) return -1;
    return r * 8 + f;
  }
  function squareColor(s) { return ((s & 7) + (s >> 3)) & 1; } // 0 = dark, 1 = light

  /* ---------------------------------------------------------------------
   * Portals: two permanent pairs. Pair A: c3 <-> f6, Pair B: f3 <-> c6.
   * ------------------------------------------------------------------- */
  var PORTAL_PAIRS = [
    { id: 'A', squares: ['c3', 'f6'] },
    { id: 'B', squares: ['f3', 'c6'] }
  ];
  var PORTAL_EXIT = [];
  var PORTAL_ID = [];
  for (var i0 = 0; i0 < 64; i0++) { PORTAL_EXIT.push(-1); PORTAL_ID.push(null); }
  PORTAL_PAIRS.forEach(function (pair) {
    var a = sqIndex(pair.squares[0]), b = sqIndex(pair.squares[1]);
    PORTAL_EXIT[a] = b; PORTAL_EXIT[b] = a;
    PORTAL_ID[a] = pair.id; PORTAL_ID[b] = pair.id;
  });

  /* ---------------------------------------------------------------------
   * Precomputed geometry.
   * ------------------------------------------------------------------- */
  var KNIGHT_MOVES = [], KING_MOVES = [], RAYS = [];
  var DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  (function buildTables() {
    var kn = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
    for (var d = 0; d < 8; d++) RAYS.push([]);
    for (var s = 0; s < 64; s++) {
      var f = s & 7, r = s >> 3, list, k;
      list = [];
      for (k = 0; k < 8; k++) {
        var nf = f + kn[k][0], nr = r + kn[k][1];
        if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) list.push(nr * 8 + nf);
      }
      KNIGHT_MOVES.push(list);
      list = [];
      for (k = 0; k < 8; k++) {
        var kf = f + DIRS[k][0], kr = r + DIRS[k][1];
        if (kf >= 0 && kf < 8 && kr >= 0 && kr < 8) list.push(kr * 8 + kf);
      }
      KING_MOVES.push(list);
      for (d = 0; d < 8; d++) {
        var ray = [], rf = f + DIRS[d][0], rr = r + DIRS[d][1];
        while (rf >= 0 && rf < 8 && rr >= 0 && rr < 8) {
          ray.push(rr * 8 + rf); rf += DIRS[d][0]; rr += DIRS[d][1];
        }
        RAYS[d].push(ray);
      }
    }
  })();

  // Castling-right masks, applied to both the origin and the ordinary landing square.
  var CASTLE_MASK = [];
  for (var i1 = 0; i1 < 64; i1++) CASTLE_MASK.push(15);
  CASTLE_MASK[0] = 15 & ~CASTLE_WQ;   // a1
  CASTLE_MASK[7] = 15 & ~CASTLE_WK;   // h1
  CASTLE_MASK[4] = 15 & ~(CASTLE_WK | CASTLE_WQ); // e1
  CASTLE_MASK[56] = 15 & ~CASTLE_BQ;  // a8
  CASTLE_MASK[63] = 15 & ~CASTLE_BK;  // h8
  CASTLE_MASK[60] = 15 & ~(CASTLE_BK | CASTLE_BQ); // e8

  /* ---------------------------------------------------------------------
   * Move encoding: from | to << 6 | promo << 12 | flags << 15.
   * "to" is always the ordinary landing square chosen by the player; the
   * final square after any teleport is computed when the move is made.
   * ------------------------------------------------------------------- */
  function encode(from, to, promo, flags) { return from | (to << 6) | (promo << 12) | (flags << 15); }
  function mFrom(m) { return m & 63; }
  function mTo(m) { return (m >> 6) & 63; }
  function mPromo(m) { return (m >> 12) & 7; }
  function mFlags(m) { return (m >> 15) & 31; }

  /* ---------------------------------------------------------------------
   * Attack detection — ordinary capture geometry from each piece's current
   * square. Portals never create remote attacks. Pinned pieces still attack.
   * ------------------------------------------------------------------- */
  function isAttacked(b, s, by) {
    var f = s & 7, r = s >> 3, k, list, d, ray, p;
    if (by === WHITE) {
      if (r > 0) {
        if (f > 0 && b[s - 9] === 1) return true;
        if (f < 7 && b[s - 7] === 1) return true;
      }
    } else if (r < 7) {
      if (f > 0 && b[s + 7] === 9) return true;
      if (f < 7 && b[s + 9] === 9) return true;
    }
    var base = by * 8;
    var kn = base + KNIGHT, kg = base + KING, bs = base + BISHOP, rk = base + ROOK, qn = base + QUEEN;
    list = KNIGHT_MOVES[s];
    for (k = 0; k < list.length; k++) if (b[list[k]] === kn) return true;
    list = KING_MOVES[s];
    for (k = 0; k < list.length; k++) if (b[list[k]] === kg) return true;
    for (d = 0; d < 4; d++) {
      ray = RAYS[d][s];
      for (k = 0; k < ray.length; k++) {
        p = b[ray[k]];
        if (p) { if (p === rk || p === qn) return true; break; }
      }
    }
    for (d = 4; d < 8; d++) {
      ray = RAYS[d][s];
      for (k = 0; k < ray.length; k++) {
        p = b[ray[k]];
        if (p) { if (p === bs || p === qn) return true; break; }
      }
    }
    return false;
  }

  function inCheck(pos) { return isAttacked(pos.board, pos.kings[pos.turn], 1 - pos.turn); }

  /* ---------------------------------------------------------------------
   * Pseudo-legal move generation (ordinary chess geometry).
   * capturesOnly also keeps promotions (used by quiescence search).
   * ------------------------------------------------------------------- */
  function addPromotions(out, from, to, flags) {
    out.push(encode(from, to, QUEEN, flags | FLAG_PROMO));
    out.push(encode(from, to, KNIGHT, flags | FLAG_PROMO));
    out.push(encode(from, to, ROOK, flags | FLAG_PROMO));
    out.push(encode(from, to, BISHOP, flags | FLAG_PROMO));
  }

  function genPseudo(pos, out, capturesOnly) {
    var b = pos.board, us = pos.turn, them = 1 - us;
    var s, p, t, k, list, to, target, d, ray;
    for (s = 0; s < 64; s++) {
      p = b[s];
      if (!p || (p >> 3) !== us) continue;
      t = p & 7;
      if (t === PAWN) {
        var dir = us === WHITE ? 8 : -8;
        var startRank = us === WHITE ? 1 : 6;
        var promoRank = us === WHITE ? 7 : 0;
        var one = s + dir, f = s & 7;
        if (one < 0 || one > 63) continue; // cannot happen in legal positions
        var promoting = (one >> 3) === promoRank;
        if (b[one] === 0) {
          if (promoting) addPromotions(out, s, one, 0);
          else if (!capturesOnly) {
            out.push(encode(s, one, 0, 0));
            if ((s >> 3) === startRank && b[one + dir] === 0) out.push(encode(s, one + dir, 0, FLAG_DOUBLE));
          }
        }
        for (k = -1; k <= 1; k += 2) {
          if (f + k < 0 || f + k > 7) continue;
          to = one + k;
          target = b[to];
          if (target) {
            if ((target >> 3) === them && (target & 7) !== KING) {
              if (promoting) addPromotions(out, s, to, FLAG_CAPTURE);
              else out.push(encode(s, to, 0, FLAG_CAPTURE));
            }
          } else if (to === pos.epTarget && pos.epPawn === s + k && b[pos.epPawn] === makePiece(them, PAWN)) {
            // The captured pawn must stand on the ordinary adjacent square.
            out.push(encode(s, to, 0, FLAG_EP | FLAG_CAPTURE));
          }
        }
      } else if (t === KNIGHT || t === KING) {
        list = t === KNIGHT ? KNIGHT_MOVES[s] : KING_MOVES[s];
        for (k = 0; k < list.length; k++) {
          to = list[k]; target = b[to];
          if (!target) { if (!capturesOnly) out.push(encode(s, to, 0, 0)); }
          else if ((target >> 3) === them && (target & 7) !== KING) out.push(encode(s, to, 0, FLAG_CAPTURE));
        }
        if (t === KING && !capturesOnly) genCastling(pos, s, out);
      } else {
        var d0 = t === ROOK ? 0 : (t === BISHOP ? 4 : 0);
        var d1 = t === ROOK ? 4 : 8;
        for (d = d0; d < d1; d++) {
          ray = RAYS[d][s];
          for (k = 0; k < ray.length; k++) {
            to = ray[k]; target = b[to];
            if (!target) { if (!capturesOnly) out.push(encode(s, to, 0, 0)); continue; }
            if ((target >> 3) === them && (target & 7) !== KING) out.push(encode(s, to, 0, FLAG_CAPTURE));
            break;
          }
        }
      }
    }
    return out;
  }

  function genCastling(pos, s, out) {
    var b = pos.board, us = pos.turn, them = 1 - us;
    var home = us === WHITE ? 4 : 60;
    if (s !== home) return;
    var king = makePiece(us, KING), rook = makePiece(us, ROOK);
    var kRight = us === WHITE ? CASTLE_WK : CASTLE_BK;
    var qRight = us === WHITE ? CASTLE_WQ : CASTLE_BQ;
    if (!(pos.castling & (kRight | qRight))) return;
    if (b[home] !== king || isAttacked(b, home, them)) return; // cannot castle out of check
    if ((pos.castling & kRight) && b[home + 3] === rook && b[home + 1] === 0 && b[home + 2] === 0) {
      // Transit square, with the king actually standing on it.
      if (!transitAttacked(b, home, home + 1, them)) out.push(encode(home, home + 2, 0, FLAG_CASTLE));
    }
    if ((pos.castling & qRight) && b[home - 4] === rook && b[home - 1] === 0 && b[home - 2] === 0 && b[home - 3] === 0) {
      if (!transitAttacked(b, home, home - 1, them)) out.push(encode(home, home - 2, 0, FLAG_CASTLE));
    }
    // The destination square is checked by the full legality test after the move.
  }

  function transitAttacked(b, home, transit, them) {
    var king = b[home];
    b[home] = 0; b[transit] = king;
    var att = isAttacked(b, transit, them);
    b[transit] = 0; b[home] = king;
    return att;
  }

  /* ---------------------------------------------------------------------
   * Make / unmake on a mutable position. A move is completed in order:
   * ordinary move -> capture -> promotion -> castling rook -> teleport.
   * ------------------------------------------------------------------- */
  function makeMove(pos, m) {
    var b = pos.board;
    var from = m & 63, to = (m >> 6) & 63, promo = (m >> 12) & 7, flags = (m >> 15) & 31;
    var us = pos.turn, piece = b[from];
    var u = {
      m: m, piece: piece, captured: 0, capSq: -1, final: to, teleported: false, blocked: false,
      rookFrom: -1, rookTo: -1,
      castling: pos.castling, epTarget: pos.epTarget, epPawn: pos.epPawn,
      halfmove: pos.halfmove, fullmove: pos.fullmove
    };
    if (flags & FLAG_EP) {
      u.capSq = pos.epPawn; u.captured = b[u.capSq]; b[u.capSq] = 0;
    } else if (b[to]) {
      u.capSq = to; u.captured = b[to];
    }
    b[from] = 0;
    var placed = promo ? makePiece(us, promo) : piece;
    b[to] = placed;
    if (flags & FLAG_CASTLE) {
      if (to > from) { u.rookFrom = from + 3; u.rookTo = from + 1; }
      else { u.rookFrom = from - 4; u.rookTo = from - 1; }
      b[u.rookTo] = b[u.rookFrom]; b[u.rookFrom] = 0;
    }
    if ((piece & 7) === KING) {
      pos.kings[us] = to; // kings never teleport
    } else {
      var exit = PORTAL_EXIT[to];
      if (exit >= 0) {
        if (b[exit] === 0) { b[exit] = placed; b[to] = 0; u.final = exit; u.teleported = true; }
        else u.blocked = true;
      }
    }
    pos.castling &= CASTLE_MASK[from] & CASTLE_MASK[to];
    pos.epTarget = -1; pos.epPawn = -1;
    if ((flags & FLAG_DOUBLE) && u.final === to) { pos.epTarget = (from + to) >> 1; pos.epPawn = to; }
    pos.halfmove = ((piece & 7) === PAWN || u.captured) ? 0 : pos.halfmove + 1;
    if (us === BLACK) pos.fullmove++;
    pos.turn = 1 - us;
    pos.undo.push(u);
    return u;
  }

  function unmakeMove(pos) {
    var u = pos.undo.pop(), b = pos.board, m = u.m;
    var from = m & 63, to = (m >> 6) & 63;
    pos.turn = 1 - pos.turn;
    if (u.rookFrom >= 0) { b[u.rookFrom] = b[u.rookTo]; b[u.rookTo] = 0; }
    b[u.final] = 0; b[to] = 0;
    b[from] = u.piece;
    if (u.captured) b[u.capSq] = u.captured;
    if ((u.piece & 7) === KING) pos.kings[pos.turn] = from;
    pos.castling = u.castling; pos.epTarget = u.epTarget; pos.epPawn = u.epPawn;
    pos.halfmove = u.halfmove; pos.fullmove = u.fullmove;
    return u;
  }

  // Legal moves: simulate the complete move, then test the mover's king.
  function genLegal(pos, capturesOnly) {
    var pseudo = genPseudo(pos, [], capturesOnly), out = [], us = pos.turn, b = pos.board;
    for (var i = 0; i < pseudo.length; i++) {
      makeMove(pos, pseudo[i]);
      if (!isAttacked(b, pos.kings[us], 1 - us)) out.push(pseudo[i]);
      unmakeMove(pos);
    }
    return out;
  }

  function hasLegalMove(pos) {
    var pseudo = genPseudo(pos, [], false), us = pos.turn, b = pos.board;
    for (var i = 0; i < pseudo.length; i++) {
      makeMove(pos, pseudo[i]);
      var ok = !isAttacked(b, pos.kings[us], 1 - us);
      unmakeMove(pos);
      if (ok) return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------------
   * Repetition identity: placement, side to move, castling rights and
   * en passant only when an en passant capture is actually legal.
   * ------------------------------------------------------------------- */
  function epIsLegal(pos) {
    if (pos.epTarget < 0) return false;
    var b = pos.board, us = pos.turn, pawn = makePiece(us, PAWN);
    if (b[pos.epPawn] !== makePiece(1 - us, PAWN)) return false;
    for (var k = -1; k <= 1; k += 2) {
      var s = pos.epPawn + k;
      if (s < 0 || s > 63 || (s >> 3) !== (pos.epPawn >> 3) || b[s] !== pawn) continue;
      var m = encode(s, pos.epTarget, 0, FLAG_EP | FLAG_CAPTURE);
      makeMove(pos, m);
      var ok = !isAttacked(b, pos.kings[us], 1 - us);
      unmakeMove(pos);
      if (ok) return true;
    }
    return false;
  }

  function castlingString(c) {
    var s = (c & CASTLE_WK ? 'K' : '') + (c & CASTLE_WQ ? 'Q' : '') + (c & CASTLE_BK ? 'k' : '') + (c & CASTLE_BQ ? 'q' : '');
    return s || '-';
  }

  function positionKey(pos) {
    var s = '', b = pos.board;
    for (var i = 0; i < 64; i++) s += PIECE_CHARS[b[i]];
    return s + ' ' + (pos.turn ? 'b' : 'w') + ' ' + castlingString(pos.castling) + ' ' + (epIsLegal(pos) ? sqName(pos.epTarget) : '-');
  }

  /* ---------------------------------------------------------------------
   * Dead positions recognised automatically (see README for reasoning):
   *  - king vs king;
   *  - king + one knight vs king;
   *  - kings plus any number of bishops, all on squares of one colour
   *    (includes king + bishop vs king). Both portal pairs join squares of
   *    the same colour, so bishops can never change square colour.
   * ------------------------------------------------------------------- */
  function isDeadBoard(b) {
    var knights = 0, others = 0, bishopColors = 0; // bit 1 = dark, bit 2 = light
    for (var s = 0; s < 64; s++) {
      var p = b[s];
      if (!p) continue;
      var t = p & 7;
      if (t === KING) continue;
      if (t === KNIGHT) knights++;
      else if (t === BISHOP) bishopColors |= (squareColor(s) ? 2 : 1);
      else others++;
    }
    if (others) return false;
    if (knights === 0) return bishopColors !== 3;
    return knights === 1 && bishopColors === 0;
  }

  /* ---------------------------------------------------------------------
   * Public, JSON-friendly state.
   * ------------------------------------------------------------------- */
  var START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  function toPos(state) {
    var board = new Int8Array(64), kings = [-1, -1];
    for (var i = 0; i < 64; i++) {
      board[i] = state.board[i];
      if ((board[i] & 7) === KING) kings[board[i] >> 3] = i;
    }
    return {
      board: board, turn: state.turn, castling: state.castling,
      epTarget: state.epTarget, epPawn: state.epPawn,
      halfmove: state.halfmove, fullmove: state.fullmove, kings: kings, undo: []
    };
  }

  function fromPos(pos, history) {
    return {
      board: Array.prototype.slice.call(pos.board), turn: pos.turn, castling: pos.castling,
      epTarget: pos.epTarget, epPawn: pos.epPawn, halfmove: pos.halfmove, fullmove: pos.fullmove,
      history: history
    };
  }

  function cloneState(state) {
    return {
      board: state.board.slice(), turn: state.turn, castling: state.castling,
      epTarget: state.epTarget, epPawn: state.epPawn, halfmove: state.halfmove,
      fullmove: state.fullmove, history: state.history.slice()
    };
  }

  function parseFEN(fen) {
    var parts = String(fen).trim().split(/\s+/);
    if (parts.length < 4) throw new Error('Bad FEN');
    var board = [], rows = parts[0].split('/');
    for (var i = 0; i < 64; i++) board.push(0);
    if (rows.length !== 8) throw new Error('Bad FEN rows');
    for (var r = 0; r < 8; r++) {
      var f = 0, row = rows[r];
      for (var c = 0; c < row.length; c++) {
        var ch = row[c];
        if (/[1-8]/.test(ch)) { f += +ch; continue; }
        var idx = PIECE_CHARS.indexOf(ch);
        if (idx <= 0 || f > 7) throw new Error('Bad FEN piece');
        board[(7 - r) * 8 + f] = idx; f++;
      }
      if (f !== 8) throw new Error('Bad FEN row length');
    }
    var turn = parts[1] === 'b' ? BLACK : WHITE;
    var castling = 0;
    if (parts[2].indexOf('K') >= 0) castling |= CASTLE_WK;
    if (parts[2].indexOf('Q') >= 0) castling |= CASTLE_WQ;
    if (parts[2].indexOf('k') >= 0) castling |= CASTLE_BK;
    if (parts[2].indexOf('q') >= 0) castling |= CASTLE_BQ;
    var epTarget = parts[3] === '-' ? -1 : sqIndex(parts[3]), epPawn = -1;
    if (epTarget >= 0) epPawn = turn === WHITE ? epTarget - 8 : epTarget + 8;
    var state = {
      board: board, turn: turn, castling: castling, epTarget: epTarget, epPawn: epPawn,
      halfmove: parts[4] ? parseInt(parts[4], 10) || 0 : 0,
      fullmove: parts[5] ? parseInt(parts[5], 10) || 1 : 1, history: []
    };
    state.history.push(positionKey(toPos(state)));
    return state;
  }

  function toFEN(state) {
    var out = '';
    for (var r = 7; r >= 0; r--) {
      var empty = 0;
      for (var f = 0; f < 8; f++) {
        var p = state.board[r * 8 + f];
        if (!p) { empty++; continue; }
        if (empty) { out += empty; empty = 0; }
        out += PIECE_CHARS[p];
      }
      if (empty) out += empty;
      if (r) out += '/';
    }
    return out + ' ' + (state.turn ? 'b' : 'w') + ' ' + castlingString(state.castling) + ' ' +
      (state.epTarget >= 0 ? sqName(state.epTarget) : '-') + ' ' + state.halfmove + ' ' + state.fullmove;
  }

  function createInitialState() { return parseFEN(START_FEN); }

  // Rich description of a move, computed by actually performing it.
  function describe(pos, m) {
    var from = mFrom(m), to = mTo(m), promo = mPromo(m), flags = mFlags(m);
    var piece = pos.board[from], mover = pos.turn;
    var u = makeMove(pos, m);
    var check = inCheck(pos);
    var mate = check && !hasLegalMove(pos);
    unmakeMove(pos);
    var text;
    if (flags & FLAG_CASTLE) text = to > from ? 'O-O' : 'O-O-O';
    else {
      text = TYPE_LETTERS[piece & 7] + sqName(from) + (u.captured ? 'x' : '-') + sqName(to);
      if (promo) text += '=' + TYPE_LETTERS[promo];
      if (flags & FLAG_EP) text += ' e.p.';
      if (u.teleported) text += '→' + sqName(u.final);
    }
    if (mate) text += '#'; else if (check) text += '+';
    return {
      id: m, from: from, to: to, exit: u.final, promo: promo, flags: flags,
      fromName: sqName(from), toName: sqName(to), exitName: sqName(u.final),
      color: mover, piece: piece, pieceType: piece & 7, pieceName: TYPE_NAMES[piece & 7],
      captured: u.captured, capturedName: u.captured ? TYPE_NAMES[u.captured & 7] : '',
      capSq: u.capSq, capture: !!u.captured, enPassant: !!(flags & FLAG_EP),
      castle: !!(flags & FLAG_CASTLE), doublePush: !!(flags & FLAG_DOUBLE),
      teleported: u.teleported, portalBlocked: u.blocked, portal: PORTAL_ID[to],
      check: check, mate: mate, notation: text,
      uci: sqName(from) + sqName(to) + (promo ? 'nbrq'[[KNIGHT, BISHOP, ROOK, QUEEN].indexOf(promo)] : '')
    };
  }

  function legalMoves(state) {
    var pos = toPos(state);
    return genLegal(pos, false).map(function (m) { return describe(pos, m); });
  }

  function findMove(state, spec) {
    var pos = toPos(state), list = genLegal(pos, false);
    var from = typeof spec.from === 'string' ? sqIndex(spec.from) : spec.from;
    var to = typeof spec.to === 'string' ? sqIndex(spec.to) : spec.to;
    var promo = spec.promo || 0;
    if (typeof promo === 'string') promo = ' pnbrqk'.indexOf(promo.toLowerCase());
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (mFrom(m) === from && mTo(m) === to && mPromo(m) === promo) return m;
    }
    return null;
  }

  // Returns { state, move } or throws if the move is not legal.
  function applyMove(state, spec) {
    var m = typeof spec === 'number' ? spec : findMove(state, spec);
    var pos = toPos(state);
    if (m === null || genLegal(pos, false).indexOf(m) < 0) throw new Error('Illegal move');
    var info = describe(pos, m);
    makeMove(pos, m);
    var history = state.history.slice();
    history.push(positionKey(pos));
    return { state: fromPos(pos, history), move: info };
  }

  function countOccurrences(history, key) {
    var n = 0;
    for (var i = 0; i < history.length; i++) if (history[i] === key) n++;
    return n;
  }

  // Automatic game-ending conditions. Checkmate takes precedence.
  function getStatus(state) {
    var pos = toPos(state);
    var check = inCheck(pos);
    var any = hasLegalMove(pos);
    var winner = pos.turn === WHITE ? 'Black' : 'White';
    if (!any) {
      if (check) return { over: true, result: pos.turn === WHITE ? '0-1' : '1-0', reason: 'checkmate', winner: 1 - pos.turn, inCheck: true, text: 'Checkmate — ' + winner + ' wins' };
      return { over: true, result: '1/2-1/2', reason: 'stalemate', winner: -1, inCheck: false, text: 'Draw by stalemate' };
    }
    var key = state.history[state.history.length - 1];
    if (countOccurrences(state.history, key) >= 5) return { over: true, result: '1/2-1/2', reason: 'fivefold', winner: -1, inCheck: check, text: 'Draw by fivefold repetition' };
    if (state.halfmove >= 150) return { over: true, result: '1/2-1/2', reason: 'seventy-five', winner: -1, inCheck: check, text: 'Draw by the seventy-five-move rule' };
    if (isDeadBoard(pos.board)) return { over: true, result: '1/2-1/2', reason: 'dead', winner: -1, inCheck: check, text: 'Draw — dead position (no checkmate is possible)' };
    return { over: false, result: null, reason: null, winner: -1, inCheck: check, text: '' };
  }

  // Draw claims available to the side to move: now, or by declaring a legal move.
  function getDrawClaims(state) {
    var res = { now: [], viaMove: [] };
    if (getStatus(state).over) return res;
    var key = state.history[state.history.length - 1];
    if (countOccurrences(state.history, key) >= 3) res.now.push('threefold');
    if (state.halfmove >= 100) res.now.push('fifty');
    var moves = legalMoves(state);
    for (var i = 0; i < moves.length; i++) {
      var next = applyMove(state, moves[i].id).state;
      if (getStatus(next).over) continue; // mate/stalemate/automatic draw decide by themselves
      var reasons = [];
      if (countOccurrences(next.history, next.history[next.history.length - 1]) >= 3) reasons.push('threefold');
      if (next.halfmove >= 100) reasons.push('fifty');
      if (reasons.length) res.viaMove.push({ move: moves[i], reasons: reasons });
    }
    return res;
  }

  var CLAIM_TEXT = { threefold: 'threefold repetition', fifty: 'the fifty-move rule' };

  // Validate a claim. Returns { ok, state, move, reasons, text }.
  function claimDraw(state, spec) {
    var claims = getDrawClaims(state);
    if (spec == null) {
      if (!claims.now.length) return { ok: false };
      return { ok: true, state: state, move: null, reasons: claims.now, text: 'Draw claimed by ' + CLAIM_TEXT[claims.now[0]] };
    }
    var m = typeof spec === 'number' ? spec : findMove(state, spec);
    for (var i = 0; i < claims.viaMove.length; i++) {
      if (claims.viaMove[i].move.id === m) {
        var r = applyMove(state, m);
        return { ok: true, state: r.state, move: r.move, reasons: claims.viaMove[i].reasons, text: 'Draw claimed by ' + CLAIM_TEXT[claims.viaMove[i].reasons[0]] };
      }
    }
    return { ok: false };
  }

  // Structural validation for restored data. Returns a clean state or null.
  function validateState(s) {
    try {
      if (!s || !Array.isArray(s.board) || s.board.length !== 64) return null;
      var kings = [0, 0];
      for (var i = 0; i < 64; i++) {
        var p = s.board[i];
        if (typeof p !== 'number' || p < 0 || p > 14 || p === 7 || p === 8 || (p !== 0 && (p & 7) === 0)) return null;
        if ((p & 7) === KING) kings[p >> 3]++;
        if ((p & 7) === PAWN && ((i >> 3) === 0 || (i >> 3) === 7)) return null;
      }
      if (kings[0] !== 1 || kings[1] !== 1) return null;
      if (s.turn !== 0 && s.turn !== 1) return null;
      if (!(s.castling >= 0 && s.castling <= 15)) return null;
      if (typeof s.epTarget !== 'number' || typeof s.epPawn !== 'number' || s.epTarget < -1 || s.epTarget > 63 || s.epPawn < -1 || s.epPawn > 63) return null;
      if (!(s.halfmove >= 0) || !(s.fullmove >= 1)) return null;
      if (!Array.isArray(s.history) || !s.history.length) return null;
      for (var h = 0; h < s.history.length; h++) if (typeof s.history[h] !== 'string') return null;
      var clean = cloneState(s);
      var pos = toPos(clean);
      // The side that just moved must not be in check.
      if (isAttacked(pos.board, pos.kings[1 - pos.turn], pos.turn)) return null;
      if (clean.history[clean.history.length - 1] !== positionKey(pos)) return null;
      return clean;
    } catch (e) { return null; }
  }

  return {
    WHITE: WHITE, BLACK: BLACK, PAWN: PAWN, KNIGHT: KNIGHT, BISHOP: BISHOP, ROOK: ROOK, QUEEN: QUEEN, KING: KING,
    FLAG_CAPTURE: FLAG_CAPTURE, FLAG_DOUBLE: FLAG_DOUBLE, FLAG_EP: FLAG_EP, FLAG_CASTLE: FLAG_CASTLE, FLAG_PROMO: FLAG_PROMO,
    CASTLE_WK: CASTLE_WK, CASTLE_WQ: CASTLE_WQ, CASTLE_BK: CASTLE_BK, CASTLE_BQ: CASTLE_BQ,
    PORTAL_PAIRS: PORTAL_PAIRS, PORTAL_EXIT: PORTAL_EXIT, PORTAL_ID: PORTAL_ID, TYPE_NAMES: TYPE_NAMES,
    START_FEN: START_FEN,
    makePiece: makePiece, colorOf: colorOf, typeOf: typeOf, sqName: sqName, sqIndex: sqIndex, squareColor: squareColor,
    createInitialState: createInitialState, cloneState: cloneState, parseFEN: parseFEN, toFEN: toFEN,
    legalMoves: legalMoves, findMove: findMove, applyMove: applyMove, getStatus: getStatus,
    getDrawClaims: getDrawClaims, claimDraw: claimDraw, validateState: validateState,
    countOccurrences: countOccurrences,
    isSquareAttacked: function (state, sq, by) { return isAttacked(state.board, typeof sq === 'string' ? sqIndex(sq) : sq, by); },
    inCheck: function (state) { return inCheck(toPos(state)); },
    positionKeyOf: function (state) { return positionKey(toPos(state)); },
    isDeadPosition: function (state) { return isDeadBoard(state.board); },
    // Low-level access for the AI search (same generator, same make/unmake).
    internal: {
      toPos: toPos, fromPos: fromPos, genLegal: genLegal, genPseudo: genPseudo, hasLegalMove: hasLegalMove,
      makeMove: makeMove, unmakeMove: unmakeMove, isAttacked: isAttacked, inCheck: inCheck,
      positionKey: positionKey, epIsLegal: epIsLegal, isDeadBoard: isDeadBoard, describe: describe,
      encode: encode, mFrom: mFrom, mTo: mTo, mPromo: mPromo, mFlags: mFlags,
      KNIGHT_MOVES: KNIGHT_MOVES, KING_MOVES: KING_MOVES, RAYS: RAYS, PIECE_CHARS: PIECE_CHARS
    }
  };
}

var RiftRules = RiftRulesFactory();
if (typeof module !== 'undefined' && module.exports) module.exports = RiftRules;
