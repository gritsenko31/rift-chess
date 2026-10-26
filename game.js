/*
 * Rift Chess — game orchestration and persistence.
 *
 * Owns the authoritative game record (rules state, move list, undo stack,
 * result, settings), saves it to localStorage and drives the computer
 * opponent. No DOM access: the interface (ui.js) reads getView() and calls
 * the action methods.
 */
(function (global) {
  'use strict';

  var Rules = global.RiftRules;
  var SAVE_VERSION = 1;
  var STORAGE_KEY = 'riftChess.save.v1';
  var MODES = ['ai', 'local'];
  var LEVEL_NAMES = ['easy', 'medium', 'hard'];
  var AI_CLAIM_THRESHOLD = -30; // the computer claims a valid draw when it is at least this much worse
  var AI_MIN_DISPLAY_MS = 350;  // keeps very fast replies from feeling instantaneous

  /* ------------------------------------------------------------ AI runner */

  function buildWorkerSource() {
    return [
      'var RiftRulesFactory = ' + global.RiftRulesFactory.toString() + ';',
      'var RiftRules = RiftRulesFactory();',
      'var RiftAIFactory = ' + global.RiftAIFactory.toString() + ';',
      'var RiftAI = RiftAIFactory(RiftRules);',
      'self.onmessage = function (e) {',
      '  var d = e.data;',
      '  if (d && d.ping) { self.postMessage({ pong: true }); return; }',
      '  try { self.postMessage({ id: d.id, ok: true, result: RiftAI.think(d.state, d.level) }); }',
      '  catch (err) { self.postMessage({ id: d.id, ok: false, error: String(err && err.message || err) }); }',
      '};'
    ].join('\n');
  }

  /*
   * Runs searches in a Web Worker built from a Blob (works from file://).
   * Falls back to a short main-thread search when workers are unavailable.
   * Only one search is ever live; cancel() terminates it.
   */
  function createAIRunner(options) {
    options = options || {};
    var forceFallback = !!options.forceFallback;
    var worker = null, workerUrl = null, workerBroken = forceFallback || typeof Worker === 'undefined' || typeof Blob === 'undefined';
    var current = null; // { id, onDone, timer }

    function ensureWorker() {
      if (workerBroken) return null;
      if (worker) return worker;
      try {
        if (!workerUrl) workerUrl = URL.createObjectURL(new Blob([buildWorkerSource()], { type: 'text/javascript' }));
        worker = new Worker(workerUrl);
        worker.onmessage = function (e) {
          var d = e.data;
          if (!current || !d || d.id !== current.id) return;
          var job = current; current = null;
          if (d.ok) job.onDone(d.result); else runFallback(job);
        };
        worker.onerror = function (ev) {
          if (ev && ev.preventDefault) ev.preventDefault();
          workerBroken = true;
          try { worker.terminate(); } catch (e) { /* ignore */ }
          worker = null;
          if (current) { var job = current; current = null; runFallback(job); }
        };
        return worker;
      } catch (e) {
        workerBroken = true; worker = null;
        return null;
      }
    }

    function runFallback(job) {
      current = job;
      job.timer = setTimeout(function () {
        if (current !== job) return;
        var level = global.RiftAI.LEVELS[job.level] || global.RiftAI.LEVELS.medium;
        var r;
        try { r = global.RiftAI.think(job.state, job.level, { timeMs: Math.min(level.timeMs, 400) }); }
        catch (e) { r = null; }
        if (current !== job) return;
        current = null;
        job.onDone(r);
      }, 30);
    }

    var nextId = 1;
    return {
      usesWorker: function () { return !workerBroken; },
      busy: function () { return !!current; },
      request: function (state, level, onDone) {
        this.cancel();
        var job = { id: nextId++, state: state, level: level, onDone: onDone, timer: null };
        var w = ensureWorker();
        if (w) {
          current = job;
          try { w.postMessage({ id: job.id, state: state, level: level }); }
          catch (e) { workerBroken = true; current = null; runFallback(job); }
        } else runFallback(job);
        return job.id;
      },
      cancel: function () {
        if (!current) return;
        var job = current; current = null;
        if (job.timer) clearTimeout(job.timer);
        if (worker) { try { worker.terminate(); } catch (e) { /* ignore */ } worker = null; }
      }
    };
  }

  /* ---------------------------------------------------------- Persistence */

  function safeStorage(storage) {
    return {
      get: function (key) { try { return storage ? storage.getItem(key) : null; } catch (e) { return null; } },
      set: function (key, value) { try { if (storage) storage.setItem(key, value); return true; } catch (e) { return false; } },
      remove: function (key) { try { if (storage) storage.removeItem(key); } catch (e) { /* ignore */ } }
    };
  }

  function defaultStorage() {
    try { return global.localStorage || null; } catch (e) { return null; }
  }

  /* ----------------------------------------------------------- Controller */

  function createGame(opts) {
    opts = opts || {};
    var store = safeStorage(opts.storage !== undefined ? opts.storage : defaultStorage());
    var storageKey = opts.storageKey || STORAGE_KEY;
    var ai = opts.aiRunner || null;
    var listeners = [];
    var now = opts.now || function () { return Date.now(); };
    var setTimer = opts.setTimeout || function (f, ms) { return setTimeout(f, ms); };
    var clearTimer = opts.clearTimeout || function (t) { clearTimeout(t); };

    var s = null;           // persisted record
    var thinking = false;   // computer search in progress
    var aiToken = 0;        // increments to invalidate stale searches
    var pendingApply = null;
    var cache = { key: null, moves: null, status: null, claims: null };
    var lastEvent = null;   // transient message for the UI

    function freshRecord(settings) {
      var st = Rules.createInitialState();
      return {
        version: SAVE_VERSION,
        mode: settings.mode, level: settings.level, humanColor: settings.humanColor,
        flipped: settings.humanColor === Rules.BLACK && settings.mode === 'ai',
        game: st, moves: [], undo: [], result: null, drawOffer: null
      };
    }

    function snapshot() {
      var g = s.game;
      return {
        board: g.board.slice(), turn: g.turn, castling: g.castling, epTarget: g.epTarget, epPawn: g.epPawn,
        halfmove: g.halfmove, fullmove: g.fullmove, histLen: g.history.length, movesLen: s.moves.length,
        result: s.result, drawOffer: s.drawOffer
      };
    }

    function restoreSnapshot(snap) {
      s.game = {
        board: snap.board.slice(), turn: snap.turn, castling: snap.castling, epTarget: snap.epTarget,
        epPawn: snap.epPawn, halfmove: snap.halfmove, fullmove: snap.fullmove,
        history: s.game.history.slice(0, snap.histLen)
      };
      s.moves = s.moves.slice(0, snap.movesLen);
      s.result = snap.result;
      s.drawOffer = snap.drawOffer;
    }

    function positionInfo() {
      var key = s.game.history.length + '|' + s.game.history[s.game.history.length - 1];
      if (cache.key !== key) {
        cache.key = key;
        cache.moves = Rules.legalMoves(s.game);
        cache.status = Rules.getStatus(s.game);
        cache.claims = null;
      }
      return cache;
    }

    function claims() {
      var info = positionInfo();
      if (!info.claims) info.claims = s.result ? { now: [], viaMove: [] } : Rules.getDrawClaims(s.game);
      return info.claims;
    }

    function isHumanTurn() {
      if (s.result) return false;
      return s.mode === 'local' || s.game.turn === s.humanColor;
    }

    function save() {
      store.set(storageKey, JSON.stringify(s));
    }

    function emit() {
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](); } catch (e) { if (global.console) console.error(e); }
      }
    }

    function cancelAI() {
      aiToken++;
      if (pendingApply) { clearTimer(pendingApply); pendingApply = null; }
      if (ai) ai.cancel();
      thinking = false;
    }

    function recordMove(info, extra) {
      var rec = {
        notation: info.notation, color: info.color, from: info.from, to: info.to, exit: info.exit,
        promo: info.promo, piece: info.piece, pieceName: info.pieceName, captured: info.captured,
        capturedName: info.capturedName, capSq: info.capSq, teleported: info.teleported,
        portalBlocked: info.portalBlocked, castle: info.castle, enPassant: info.enPassant,
        check: info.check, mate: info.mate, byComputer: !!(extra && extra.byComputer)
      };
      s.moves.push(rec);
      return rec;
    }

    function finishIfOver() {
      if (s.result) return;
      var st = Rules.getStatus(s.game);
      if (st.over) s.result = { result: st.result, reason: st.reason, text: st.text, winner: st.winner };
    }

    function commitMove(spec, extra) {
      var res = Rules.applyMove(s.game, spec);
      s.undo.push(snapshot());
      s.game = res.state;
      s.drawOffer = null;
      var rec = recordMove(res.move, extra);
      finishIfOver();
      lastEvent = { type: 'move', move: rec };
      return rec;
    }

    function afterChange() {
      save();
      emit();
      maybeStartAI();
    }

    function maybeStartAI() {
      if (!ai || s.mode !== 'ai' || s.result || s.game.turn === s.humanColor || thinking) return;
      thinking = true;
      var token = ++aiToken;
      var started = now();
      var expectKey = s.game.history.length + '|' + s.game.history[s.game.history.length - 1];
      var stateCopy = Rules.cloneState(s.game);
      var level = s.level;
      emit();
      ai.request(stateCopy, level, function (result) {
        if (token !== aiToken) return; // stale
        var delay = Math.max(0, AI_MIN_DISPLAY_MS - (now() - started));
        var apply = function () {
          pendingApply = null;
          if (token !== aiToken) return;
          thinking = false;
          var key = s.game.history.length + '|' + s.game.history[s.game.history.length - 1];
          if (key !== expectKey || s.result || s.mode !== 'ai' || s.game.turn === s.humanColor) { emit(); return; }
          applyComputerResult(result);
        };
        if (delay > 0) pendingApply = setTimer(apply, delay); else apply();
      });
    }

    function applyComputerResult(result) {
      var legal = positionInfo().moves;
      var chosen = null;
      if (result && result.move) {
        for (var i = 0; i < legal.length; i++) if (legal[i].id === result.move.id) { chosen = legal[i]; break; }
      }
      if (!chosen) chosen = legal[0]; // defensive: never apply an unverified move
      if (!chosen) { emit(); return; }
      // Draw-claim policy: claim a valid rule-based draw when clearly worse.
      if (result && typeof result.score === 'number' && result.score <= AI_CLAIM_THRESHOLD) {
        var c = claims();
        if (c.now.length) {
          var r0 = Rules.claimDraw(s.game, null);
          if (r0.ok) { endByClaim(r0, true); return; }
        } else if (c.viaMove.length) {
          var pickClaim = c.viaMove[0];
          for (var j = 0; j < c.viaMove.length; j++) if (c.viaMove[j].move.id === chosen.id) pickClaim = c.viaMove[j];
          var r1 = Rules.claimDraw(s.game, pickClaim.move.id);
          if (r1.ok) { endByClaim(r1, true); return; }
        }
      }
      commitMove(chosen.id, { byComputer: true });
      afterChange();
    }

    function endByClaim(claim, byComputer) {
      s.undo.push(snapshot());
      if (claim.move) {
        s.game = claim.state;
        recordMove(claim.move, { byComputer: byComputer });
      }
      s.drawOffer = null;
      s.result = { result: '1/2-1/2', reason: 'claim-' + claim.reasons[0], text: claim.text, winner: -1 };
      // A move that ends the game by itself (e.g. checkmate) is never offered as a claim.
      lastEvent = { type: 'claim', byComputer: byComputer, move: claim.move ? s.moves[s.moves.length - 1] : null };
      afterChange();
    }

    /* ------------------------------------------------ load / validation */

    function validRecord(r) {
      if (!r || r.version !== SAVE_VERSION) return null;
      if (MODES.indexOf(r.mode) < 0 || LEVEL_NAMES.indexOf(r.level) < 0) return null;
      if (r.humanColor !== 0 && r.humanColor !== 1) return null;
      var game = Rules.validateState(r.game);
      if (!game) return null;
      if (!Array.isArray(r.moves) || !Array.isArray(r.undo)) return null;
      if (r.moves.length !== game.history.length - 1) return null;
      for (var i = 0; i < r.moves.length; i++) {
        var m = r.moves[i];
        if (!m || typeof m.notation !== 'string' || (m.color !== 0 && m.color !== 1)) return null;
      }
      var undo = [];
      for (var k = 0; k < r.undo.length; k++) {
        var u = r.undo[k];
        if (!u || !(u.histLen >= 1) || u.histLen > game.history.length || !(u.movesLen >= 0) || u.movesLen > r.moves.length) return null;
        var st = Rules.validateState({
          board: u.board, turn: u.turn, castling: u.castling, epTarget: u.epTarget, epPawn: u.epPawn,
          halfmove: u.halfmove, fullmove: u.fullmove, history: game.history.slice(0, u.histLen)
        });
        if (!st) return null;
        if (u.result != null && !validResult(u.result)) return null;
        undo.push(u);
      }
      if (r.result != null && !validResult(r.result)) return null;
      if (r.drawOffer != null && r.drawOffer !== 0 && r.drawOffer !== 1) return null;
      return {
        version: SAVE_VERSION, mode: r.mode, level: r.level, humanColor: r.humanColor, flipped: !!r.flipped,
        game: game, moves: r.moves, undo: undo, result: r.result || null, drawOffer: r.drawOffer == null ? null : r.drawOffer
      };
    }

    function validResult(x) {
      return x && typeof x === 'object' && ['1-0', '0-1', '1/2-1/2'].indexOf(x.result) >= 0 && typeof x.text === 'string';
    }

    function load() {
      var raw = store.get(storageKey);
      if (!raw) return false;
      var parsed;
      try { parsed = JSON.parse(raw); } catch (e) { return false; }
      var rec = validRecord(parsed);
      if (!rec) return false;
      s = rec;
      return true;
    }

    var defaults = { mode: 'ai', level: 'medium', humanColor: Rules.WHITE };
    var restored = opts.noRestore ? false : load();
    if (!restored) { s = freshRecord(defaults); }
    lastEvent = restored ? { type: 'restored' } : null;

    /* ---------------------------------------------------------- public API */

    var api = {
      restored: restored,
      onChange: function (fn) { listeners.push(fn); },

      start: function () {
        // Called once the UI is ready: resume the computer if it is its turn.
        save();
        emit();
        maybeStartAI();
      },

      getView: function () {
        var info = positionInfo();
        var c = (isHumanTurn() && !thinking) ? claims() : { now: [], viaMove: [] };
        return {
          mode: s.mode, level: s.level, humanColor: s.humanColor, flipped: s.flipped,
          state: s.game, moves: s.moves, result: s.result, drawOffer: s.drawOffer,
          legalMoves: info.moves, status: info.status, inCheck: info.status.inCheck,
          thinking: thinking, humanTurn: isHumanTurn() && !thinking,
          canUndo: api.canUndo(), claims: c,
          lastMove: s.moves.length ? s.moves[s.moves.length - 1] : null,
          lastEvent: lastEvent, usesWorker: ai ? ai.usesWorker() : false
        };
      },

      legalMovesFrom: function (sq) {
        if (!isHumanTurn() || thinking) return [];
        return positionInfo().moves.filter(function (m) { return m.from === sq; });
      },

      playMove: function (spec) {
        if (!isHumanTurn() || thinking) return null;
        var m = Rules.findMove(s.game, spec);
        if (m === null) return null;
        var rec = commitMove(m, null);
        afterChange();
        return rec;
      },

      canUndo: function () {
        if (!s.undo.length) return false;
        if (s.mode === 'local') return true;
        for (var i = s.undo.length - 1; i >= 0; i--) if (s.undo[i].turn === s.humanColor) return true;
        return false;
      },

      undo: function () {
        if (!api.canUndo()) return false;
        cancelAI();
        restoreSnapshot(s.undo.pop());
        if (s.mode === 'ai') {
          while (s.undo.length && s.game.turn !== s.humanColor) restoreSnapshot(s.undo.pop());
        }
        lastEvent = { type: 'undo' };
        afterChange();
        return true;
      },

      newGame: function (settings) {
        cancelAI();
        settings = settings || {};
        s = freshRecord({
          mode: settings.mode || s.mode,
          level: settings.level || s.level,
          humanColor: settings.humanColor != null ? settings.humanColor : s.humanColor
        });
        lastEvent = { type: 'new' };
        afterChange();
      },

      isInProgress: function () { return s.moves.length > 0 && !s.result; },

      setMode: function (mode) {
        if (MODES.indexOf(mode) < 0 || mode === s.mode) return;
        api.newGame({ mode: mode });
      },

      setHumanColor: function (color) {
        if ((color !== 0 && color !== 1) || color === s.humanColor) return;
        api.newGame({ humanColor: color });
      },

      setLevel: function (level) {
        if (LEVEL_NAMES.indexOf(level) < 0) return;
        s.level = level; // applies to the next search
        save(); emit();
      },

      flip: function () { s.flipped = !s.flipped; save(); emit(); },

      resign: function () {
        if (s.result) return false;
        cancelAI();
        var loser = s.mode === 'ai' ? s.humanColor : s.game.turn;
        var winner = 1 - loser;
        s.undo.push(snapshot());
        s.result = {
          result: winner === Rules.WHITE ? '1-0' : '0-1', reason: 'resignation', winner: winner,
          text: (loser === Rules.WHITE ? 'White' : 'Black') + ' resigned — ' + (winner === Rules.WHITE ? 'White' : 'Black') + ' wins'
        };
        s.drawOffer = null;
        lastEvent = { type: 'resign' };
        afterChange();
        return true;
      },

      // Draw by agreement: local two-player mode only.
      offerDraw: function () {
        if (s.mode !== 'local' || s.result) return false;
        s.drawOffer = s.game.turn;
        save(); emit();
        return true;
      },

      respondToDraw: function (accept) {
        if (s.mode !== 'local' || s.drawOffer == null || s.result) return false;
        if (accept) {
          s.undo.push(snapshot());
          s.result = { result: '1/2-1/2', reason: 'agreement', text: 'Draw by agreement', winner: -1 };
          s.drawOffer = null;
          lastEvent = { type: 'agreement' };
        } else {
          s.drawOffer = null;
          lastEvent = { type: 'declined' };
        }
        afterChange();
        return true;
      },

      claimDraw: function (moveId) {
        if (!isHumanTurn() || thinking) return false;
        var r = Rules.claimDraw(s.game, moveId == null ? null : moveId);
        if (!r.ok) return false;
        endByClaim(r, false);
        return true;
      },

      // Testing hooks.
      _record: function () { return s; },
      _cancelAI: cancelAI
    };
    return api;
  }

  global.RiftGame = {
    SAVE_VERSION: SAVE_VERSION, STORAGE_KEY: STORAGE_KEY,
    createGame: createGame, createAIRunner: createAIRunner, buildWorkerSource: buildWorkerSource
  };
})(typeof window !== 'undefined' ? window : this);
