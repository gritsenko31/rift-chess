/*
 * Rift Chess — rendering and input.
 * Reads everything from the game controller (game.js); the DOM is never the
 * source of truth.
 */
(function () {
  'use strict';

  var R = window.RiftRules;
  var runner = window.RiftGame.createAIRunner();
  var game = window.RiftGame.createGame({ aiRunner: runner });

  var $ = function (id) { return document.getElementById(id); };
  var boardEl = $('board');
  var squares = [];
  var ui = {
    selected: -1,
    targets: {},      // sq -> [moves]
    hover: -1,
    focusSq: 12,      // e2
    posKey: '',
    movesSeen: -1,
    promo: null,
    drawDialogShown: false
  };

  var PIECE_KEYS = { 1: 'P', 2: 'N', 3: 'B', 4: 'R', 5: 'Q', 6: 'K' };
  var COLOR_NAMES = ['White', 'Black'];
  var LEVEL_LABELS = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

  function pieceSvg(code) {
    if (!code) return '';
    return window.RIFT_PIECES[(code >> 3 ? 'b' : 'w') + PIECE_KEYS[code & 7]];
  }
  function pieceLabel(code) { return COLOR_NAMES[code >> 3].toLowerCase() + ' ' + R.TYPE_NAMES[code & 7]; }
  function sqName(s) { return R.sqName(s); }
  function pairClass(sq) { var id = R.PORTAL_ID[sq]; return id ? 'pair-' + id.toLowerCase() : ''; }

  var PORTAL_SVG = {
    A: '<svg viewBox="0 0 100 100" aria-hidden="true"><rect class="core" x="26" y="26" width="48" height="48" rx="6" transform="rotate(45 50 50)"/><rect class="ring" x="20" y="20" width="60" height="60" rx="8" transform="rotate(45 50 50)"/></svg>',
    B: '<svg viewBox="0 0 100 100" aria-hidden="true"><circle class="core" cx="50" cy="50" r="27"/><circle class="ring" cx="50" cy="50" r="36"/></svg>'
  };

  /* ---------------------------------------------------------------- board */

  function buildBoard() {
    boardEl.setAttribute('role', 'group');
    for (var s = 0; s < 64; s++) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'sq' + (R.squareColor(s) === 0 ? ' dark' : '');
      b.dataset.sq = s;
      b.tabIndex = -1;
      squares.push(b);
      boardEl.appendChild(b);
    }
    boardEl.addEventListener('click', function (e) {
      var t = e.target.closest('.sq');
      if (t) onSquare(+t.dataset.sq);
    });
    boardEl.addEventListener('mouseover', function (e) {
      var t = e.target.closest('.sq');
      setHover(t ? +t.dataset.sq : -1);
    });
    boardEl.addEventListener('mouseleave', function () { setHover(-1); });
    boardEl.addEventListener('focusin', function (e) {
      var t = e.target.closest('.sq');
      if (t) { ui.focusSq = +t.dataset.sq; setHover(ui.focusSq); }
    });
    boardEl.addEventListener('keydown', onBoardKey);
  }

  function setHover(sq) {
    if (ui.hover === sq) return;
    ui.hover = sq;
    if (ui.selected >= 0) renderBoard(game.getView()); // hover only matters for portal previews
  }

  function onBoardKey(e) {
    var view = game.getView();
    var flipped = view.flipped;
    var f = ui.focusSq & 7, r = ui.focusSq >> 3;
    var df = 0, dr = 0;
    if (e.key === 'ArrowLeft') df = -1;
    else if (e.key === 'ArrowRight') df = 1;
    else if (e.key === 'ArrowUp') dr = 1;
    else if (e.key === 'ArrowDown') dr = -1;
    else if (e.key === 'Escape') { clearSelection(); render(); return; }
    else return;
    e.preventDefault();
    if (flipped) { df = -df; dr = -dr; }
    f = Math.min(7, Math.max(0, f + df)); r = Math.min(7, Math.max(0, r + dr));
    ui.focusSq = r * 8 + f;
    updateTabStops();
    squares[ui.focusSq].focus();
  }

  function updateTabStops() {
    for (var s = 0; s < 64; s++) squares[s].tabIndex = s === ui.focusSq ? 0 : -1;
  }

  function clearSelection() { ui.selected = -1; ui.targets = {}; }

  function onSquare(sq) {
    ui.focusSq = sq;
    var view = game.getView();
    if (!view.humanTurn) return;
    var board = view.state.board;
    if (ui.selected >= 0 && ui.targets[sq]) {
      var list = ui.targets[sq];
      if (list.length > 1 || list[0].promo) { openPromotion(list); return; }
      var from = ui.selected;
      clearSelection();
      game.playMove({ from: from, to: sq, promo: 0 });
      return;
    }
    var p = board[sq];
    if (p && (p >> 3) === view.state.turn && sq !== ui.selected) {
      var moves = game.legalMovesFrom(sq);
      ui.selected = sq;
      ui.targets = {};
      moves.forEach(function (m) { (ui.targets[m.to] = ui.targets[m.to] || []).push(m); });
    } else clearSelection();
    render();
  }

  function renderBoard(view) {
    var st = view.state, board = st.board, flipped = view.flipped;
    var last = view.lastMove;
    var checkSq = -1;
    if (view.inCheck && !(view.result && view.result.reason !== 'checkmate')) {
      for (var k = 0; k < 64; k++) if (board[k] === R.makePiece(st.turn, R.KING)) checkSq = k;
    }
    var hoverMoves = ui.hover >= 0 && ui.targets[ui.hover] ? ui.targets[ui.hover] : null;
    var exitMarks = {};
    Object.keys(ui.targets).forEach(function (t) {
      var m = ui.targets[t][0];
      if (m.teleported) exitMarks[m.exit] = m;
    });

    for (var s = 0; s < 64; s++) {
      var el = squares[s];
      var file = s & 7, rank = s >> 3;
      var row = flipped ? rank : 7 - rank, col = flipped ? 7 - file : file;
      el.style.gridRow = String(row + 1);
      el.style.gridColumn = String(col + 1);

      var cls = ['sq'];
      if (R.squareColor(s) === 0) cls.push('dark');
      if (s === ui.selected) cls.push('selected');
      var tm = ui.targets[s];
      if (tm) { cls.push('target'); if (tm[0].capture) cls.push('capture'); }
      if (last) {
        if (s === last.from) cls.push('last-from');
        if (s === last.to) cls.push('last-to');
        if (last.teleported && s === last.exit) cls.push('last-exit');
      }
      if (s === checkSq) cls.push('in-check');
      if (exitMarks[s] !== undefined) { cls.push('exit-preview'); cls.push(pairClass(exitMarks[s].to)); }
      el.className = cls.join(' ');

      var html = '<span class="shade"></span>';
      var pid = R.PORTAL_ID[s];
      if (pid) html += '<span class="portal ' + pairClass(s) + '">' + PORTAL_SVG[pid] + '<span class="tag">' + pid + '</span></span>';
      if (row === 7) html += '<span class="coord file">' + 'abcdefgh'[file] + '</span>';
      if (col === 0) html += '<span class="coord rank">' + (rank + 1) + '</span>';
      if (board[s]) html += '<span class="piece">' + pieceSvg(board[s]) + '</span>';
      if (hoverMoves && hoverMoves[0].teleported && hoverMoves[0].exit === s && s !== hoverMoves[0].from) {
        html += '<span class="ghost">' + pieceSvg(hoverMoves[0].promo ? R.makePiece(hoverMoves[0].color, hoverMoves[0].promo) : hoverMoves[0].piece) + '</span>';
      }
      if (tm && tm[0].portal && (tm[0].pieceType !== R.KING)) {
        var m0 = tm[0];
        if (m0.teleported) html += '<span class="badge ' + pairClass(s) + '">→ ' + sqName(m0.exit) + (m0.exit === m0.from ? ' (back)' : '') + '</span>';
        else if (m0.portalBlocked) html += '<span class="badge blocked">stays</span>';
      }
      el.innerHTML = html;
      el.setAttribute('aria-label', squareLabel(s, board[s], tm));
      el.tabIndex = s === ui.focusSq ? 0 : -1;
    }
  }

  function squareLabel(s, p, tm) {
    var parts = [sqName(s)];
    parts.push(p ? pieceLabel(p) : 'empty');
    if (R.PORTAL_ID[s]) parts.push('portal ' + R.PORTAL_ID[s] + ' to ' + sqName(R.PORTAL_EXIT[s]));
    if (s === ui.selected) parts.push('selected');
    if (tm) {
      var m = tm[0];
      parts.push(m.capture ? 'capture available' : 'move available');
      if (m.teleported) parts.push('teleports to ' + sqName(m.exit));
      else if (m.portalBlocked) parts.push('exit blocked, piece stays here');
    }
    return parts.join(', ');
  }

  function animateLastMove(view) {
    var last = view.lastMove;
    if (!last || !view.lastEvent || (view.lastEvent.type !== 'move' && view.lastEvent.type !== 'claim')) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var target = last.teleported ? last.exit : last.to;
    var pieceEl = squares[target].querySelector('.piece');
    if (!pieceEl) return;
    if (last.teleported) {
      pieceEl.classList.add('anim-emerge');
      [last.to, last.exit].forEach(function (sq) {
        var p = squares[sq].querySelector('.portal');
        if (p) p.classList.add('pulse');
      });
    } else {
      var size = boardEl.clientWidth / 8;
      var flip = view.flipped ? -1 : 1;
      var dx = ((last.from & 7) - (last.to & 7)) * size * flip;
      var dy = -((last.from >> 3) - (last.to >> 3)) * size * flip;
      pieceEl.style.setProperty('--dx', dx + 'px');
      pieceEl.style.setProperty('--dy', dy + 'px');
      pieceEl.classList.add('anim-slide');
    }
  }

  /* --------------------------------------------------------------- panels */

  function materialOf(board, color) {
    var v = [0, 1, 3, 3, 5, 9, 0], sum = 0;
    for (var s = 0; s < 64; s++) if (board[s] && (board[s] >> 3) === color) sum += v[board[s] & 7];
    return sum;
  }

  function renderBars(view) {
    var topColor = view.flipped ? R.WHITE : R.BLACK;
    [['bar-top', topColor], ['bar-bottom', 1 - topColor]].forEach(function (pair) {
      var el = $(pair[0]), color = pair[1];
      var name = COLOR_NAMES[color];
      if (view.mode === 'ai') {
        name = color === view.humanColor ? 'You (' + name + ')' : 'Computer (' + name + ') · ' + LEVEL_LABELS[view.level];
      }
      var nameEl = el.querySelector('.player-name');
      nameEl.textContent = name;
      nameEl.classList.toggle('active', !view.result && view.state.turn === color);
      var caps = view.moves.filter(function (m) { return m.color === color && m.captured; })
        .map(function (m) { return m.captured; }).sort(function (a, b) { return (b & 7) - (a & 7); });
      var html = caps.map(pieceSvg).join('');
      var adv = materialOf(view.state.board, color) - materialOf(view.state.board, 1 - color);
      if (adv > 0) html += '<span class="adv">+' + adv + '</span>';
      el.querySelector('.captures').innerHTML = html;
    });
  }

  function whoseText(rec, view) {
    if (view.mode === 'ai') return rec.byComputer ? "The computer's" : 'Your';
    return COLOR_NAMES[rec.color] + "'s";
  }

  function describeMove(rec, view) {
    var who = whoseText(rec, view), piece = rec.pieceName;
    var to = sqName(rec.to), exit = sqName(rec.exit), from = sqName(rec.from);
    if (rec.castle) return who + ' king castled ' + (rec.to > rec.from ? 'kingside.' : 'queenside.');
    var capture = rec.captured ? (rec.enPassant ? ' captured a pawn en passant on ' : ' captured a ' + rec.capturedName + ' on ') : '';
    var promo = rec.promo ? ' and promoted to a ' + R.TYPE_NAMES[rec.promo] : '';
    var text;
    if (rec.teleported) {
      text = capture ? who + ' ' + piece + capture + to + promo + ' and emerged on ' + exit + '.'
        : who + ' ' + piece + ' entered ' + to + promo + ' and emerged on ' + exit + '.';
      if (rec.exit === rec.from) text += ' (It returned to its own square.)';
    } else if (rec.portalBlocked) {
      var exitSq = sqName(R.PORTAL_EXIT[rec.to]);
      text = who + ' ' + piece + (capture ? capture : ' landed on portal ') + to + promo + '. The ' + exitSq + ' exit is occupied, so it stays on ' + to + '.';
    } else {
      text = capture ? who + ' ' + piece + capture + to + promo + '.' : who + ' ' + piece + ' moved ' + from + '–' + to + promo + '.';
    }
    return text;
  }

  function renderStatus(view) {
    var turn = view.state.turn;
    var turnText;
    if (view.result) turnText = 'Game over';
    else if (view.mode === 'ai') turnText = turn === view.humanColor ? 'Your move (' + COLOR_NAMES[turn] + ')' : "Computer's move (" + COLOR_NAMES[turn] + ')';
    else turnText = COLOR_NAMES[turn] + ' to move';
    $('turn-text').textContent = turnText;
    var dot = $('turn-dot');
    dot.className = 'turn-dot ' + (view.result ? '' : (turn === R.WHITE ? 'white' : 'black'));
    $('thinking').hidden = !view.thinking;

    var st = $('status-text');
    st.className = 'status-text';
    if (view.result) { st.textContent = view.result.text; st.classList.add('over'); }
    else if (view.inCheck) { st.textContent = COLOR_NAMES[turn] + ' is in check!'; st.classList.add('check'); }
    else if (view.drawOffer != null) st.textContent = COLOR_NAMES[view.drawOffer] + ' has offered a draw.';
    else st.textContent = '';

    var msg = '', ev = view.lastEvent;
    if (ev) {
      if ((ev.type === 'move' || ev.type === 'claim') && ev.move) msg = describeMove(ev.move, view);
      if (ev.type === 'claim') msg = (msg ? msg + ' ' : '') + (ev.byComputer ? 'The computer claimed a draw.' : 'Draw claimed.');
      else if (ev.type === 'undo') msg = 'Move undone.';
      else if (ev.type === 'restored') msg = 'Your saved game was restored.' + (view.lastMove ? ' Last move: ' + view.lastMove.notation : '');
      else if (ev.type === 'new') msg = 'New game. White moves first.';
      else if (ev.type === 'declined') msg = 'Draw offer declined. Play on.';
      else if (ev.type === 'agreement') msg = 'Both players agreed to a draw.';
    }
    if (!msg && !view.result && !view.moves.length) {
      msg = 'Select a piece to see its moves. A badge on a portal shows where the piece will come out.';
    }
    $('message').textContent = msg;
    $('result-actions').hidden = !view.result;
  }

  function renderControls(view) {
    $('btn-undo').disabled = !view.canUndo;
    $('btn-resign').disabled = !!view.result;
    $('btn-offer-draw').hidden = !(view.mode === 'local' && !view.result && view.drawOffer == null);
    var c = view.claims;
    $('btn-claim-draw').hidden = !(view.humanTurn && (c.now.length || c.viaMove.length));
    setSegment('seg-mode', view.mode);
    setSegment('seg-level', view.level);
    setSegment('seg-color', String(view.humanColor));
    $('setting-level').hidden = view.mode !== 'ai';
    $('setting-color').hidden = view.mode !== 'ai';
  }

  function setSegment(id, value) {
    var btns = $(id).querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].dataset.value === value;
      btns[i].setAttribute('aria-checked', on ? 'true' : 'false');
      btns[i].tabIndex = on ? 0 : -1;
    }
  }

  function renderHistory(view) {
    var list = $('move-list');
    var html = '';
    for (var i = 0; i < view.moves.length; i += 2) {
      html += '<li><span class="num">' + (i / 2 + 1) + '.</span>' + moveCell(view.moves[i], i, view) +
        (view.moves[i + 1] ? moveCell(view.moves[i + 1], i + 1, view) : '<span></span>') + '</li>';
    }
    list.innerHTML = html;
    $('empty-history').hidden = view.moves.length > 0;
    list.scrollTop = list.scrollHeight;
  }

  function moveCell(m, idx, view) {
    var cls = 'mv' + (idx === view.moves.length - 1 ? ' last' : '') + (m.teleported ? ' tp' : '');
    return '<span class="' + cls + '">' + escapeHtml(m.notation) + '</span>';
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ---------------------------------------------------------------- render */

  function render() {
    var view = game.getView();
    var key = view.state.history.length + '|' + view.state.history[view.state.history.length - 1];
    if (key !== ui.posKey || !view.humanTurn) {
      if (key !== ui.posKey) closeDialog($('dlg-promo'));
      ui.posKey = key;
      if (!view.humanTurn || ui.selected < 0 || view.state.board[ui.selected] === 0) clearSelection();
      else {
        // Re-derive targets for a still-valid selection.
        var sel = ui.selected; clearSelection();
        if ((view.state.board[sel] >> 3) === view.state.turn) {
          ui.selected = sel;
          game.legalMovesFrom(sel).forEach(function (m) { (ui.targets[m.to] = ui.targets[m.to] || []).push(m); });
        }
      }
    }
    renderBoard(view);
    if (view.moves.length !== ui.movesSeen) {
      if (ui.movesSeen >= 0 && view.moves.length === ui.movesSeen + 1) animateLastMove(view);
      ui.movesSeen = view.moves.length;
    }
    renderBars(view);
    renderStatus(view);
    renderControls(view);
    renderHistory(view);
    maybeShowDrawOffer(view);
  }

  /* --------------------------------------------------------------- dialogs */

  function openDialog(d) {
    if (d.open) return;
    if (typeof d.showModal === 'function') { try { d.showModal(); return; } catch (e) { /* fall through */ } }
    d.setAttribute('open', '');
  }
  function closeDialog(d) {
    if (!d.open) return;
    if (typeof d.close === 'function') d.close(); else d.removeAttribute('open');
  }

  var confirmCb = null, cancelCb = null;
  function confirmDialog(title, text, yesLabel, onYes, noLabel, onNo) {
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    $('confirm-yes').textContent = yesLabel || 'OK';
    $('confirm-no').textContent = noLabel || 'Cancel';
    confirmCb = onYes; cancelCb = onNo || null;
    openDialog($('dlg-confirm'));
    $('confirm-yes').focus();
  }

  function openPromotion(list) {
    ui.promo = list;
    var color = list[0].color, wrap = $('promo-choices');
    wrap.innerHTML = '';
    [R.QUEEN, R.ROOK, R.BISHOP, R.KNIGHT].forEach(function (t) {
      var m = list.filter(function (x) { return x.promo === t; })[0];
      if (!m) return;
      var b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = pieceSvg(R.makePiece(color, t)) + '<span>' + R.TYPE_NAMES[t][0].toUpperCase() + R.TYPE_NAMES[t].slice(1) + '</span>';
      b.setAttribute('aria-label', 'Promote to ' + R.TYPE_NAMES[t]);
      b.addEventListener('click', function () {
        ui.promo = null;
        closeDialog($('dlg-promo'));
        clearSelection();
        game.playMove({ from: m.from, to: m.to, promo: t });
      });
      wrap.appendChild(b);
    });
    openDialog($('dlg-promo'));
    var first = wrap.querySelector('button');
    if (first) first.focus();
  }

  function openClaims() {
    var view = game.getView(), c = view.claims, wrap = $('claim-list');
    var names = { threefold: 'threefold repetition', fifty: 'fifty-move rule' };
    wrap.innerHTML = '';
    function add(label, fn) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'btn'; b.textContent = label;
      b.addEventListener('click', function () { closeDialog($('dlg-claim')); fn(); });
      wrap.appendChild(b);
    }
    if (c.now.length) add('Claim now (' + c.now.map(function (r) { return names[r]; }).join(', ') + ')', function () { game.claimDraw(null); });
    c.viaMove.forEach(function (x) {
      add('Play ' + x.move.notation + ' and claim (' + x.reasons.map(function (r) { return names[r]; }).join(', ') + ')', function () { game.claimDraw(x.move.id); });
    });
    if (!wrap.children.length) return;
    openDialog($('dlg-claim'));
  }

  function maybeShowDrawOffer(view) {
    if (view.mode !== 'local' || view.drawOffer == null || view.result) { ui.drawDialogShown = false; return; }
    if (ui.drawDialogShown) return;
    ui.drawDialogShown = true;
    var offerer = COLOR_NAMES[view.drawOffer], responder = COLOR_NAMES[1 - view.drawOffer];
    confirmDialog('Draw offered', offerer + ' offers a draw. ' + responder + ', do you accept?', 'Accept draw',
      function () { game.respondToDraw(true); }, 'Decline', function () { game.respondToDraw(false); });
  }

  /* --------------------------------------------------------------- actions */

  function onAction(action) {
    var view = game.getView();
    switch (action) {
      case 'new':
        if (game.isInProgress()) confirmDialog('Start a new game?', 'The current game will be discarded.', 'New Game', function () { game.newGame(); });
        else game.newGame();
        break;
      case 'undo': clearSelection(); game.undo(); break;
      case 'flip': game.flip(); break;
      case 'rules':
        openDialog($('dlg-rules'));
        $('dlg-rules').scrollTop = 0;
        $('rules-title').focus();
        break;
      case 'resign':
        if (view.result) return;
        var who = view.mode === 'ai' ? 'You' : COLOR_NAMES[view.state.turn];
        confirmDialog('Resign?', who + (view.mode === 'ai' ? ' will lose this game.' : ' will resign and lose this game.'), 'Resign', function () { game.resign(); });
        break;
      case 'offer-draw': game.offerDraw(); break;
      case 'claim-draw': openClaims(); break;
    }
  }

  function bindControls() {
    document.addEventListener('click', function (e) {
      var a = e.target.closest('[data-action]');
      if (a) { onAction(a.dataset.action); return; }
      var c = e.target.closest('[data-close]');
      if (c) closeDialog(c.closest('dialog'));
    });

    $('confirm-yes').addEventListener('click', function () {
      var cb = confirmCb; confirmCb = null; cancelCb = null;
      closeDialog($('dlg-confirm'));
      if (cb) cb();
    });
    $('confirm-no').addEventListener('click', function () {
      var cb = cancelCb; confirmCb = null; cancelCb = null;
      closeDialog($('dlg-confirm'));
      if (cb) cb();
    });
    $('dlg-confirm').addEventListener('cancel', function () {
      var cb = cancelCb; confirmCb = null; cancelCb = null;
      if (cb) setTimeout(cb, 0);
    });
    $('dlg-promo').addEventListener('close', function () { ui.promo = null; });

    segment('seg-mode', function (value) {
      var view = game.getView();
      if (value === view.mode) return;
      var go = function () { game.setMode(value); };
      if (game.isInProgress()) confirmDialog('Change game mode?', 'Switching mode starts a new game. The current game will be discarded.', 'Switch and restart', go);
      else go();
    });
    segment('seg-level', function (value) { game.setLevel(value); });
    segment('seg-color', function (value) {
      var color = +value, view = game.getView();
      if (color === view.humanColor) return;
      var go = function () { game.setHumanColor(color); };
      if (game.isInProgress()) confirmDialog('Switch sides?', 'Changing your colour starts a new game.', 'Switch and restart', go);
      else go();
    });
  }

  function segment(id, onPick) {
    var el = $(id);
    el.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-value]');
      if (b) onPick(b.dataset.value);
    });
    el.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      var btns = Array.prototype.slice.call(el.querySelectorAll('button'));
      var i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      var j = (i + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length;
      btns[j].focus();
    });
  }

  buildBoard();
  bindControls();
  game.onChange(render);
  render();
  game.start();
  window.RiftApp = { game: game, runner: runner, render: render }; // handy for debugging and automation
})();
