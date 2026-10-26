# Rift Chess

Rift Chess is standard chess plus two pairs of permanent portals. If a piece ends its move on a portal, it emerges on the twin square, provided that square is empty. That one rule creates surprise attacks, escapes and combinations, while everything else stays familiar chess.

Portal chess variants are not a new idea. This is simply one carefully specified, fully playable version.

The game runs entirely in your browser. There is no server, account, build step, analytics or network access.

---

## Launching

**Option 1: open the file directly**

Double-click `index.html`, or drag it into any modern browser (Chrome, Edge, Firefox or Safari).

**Option 2: static hosting**

Upload the folder to any static web host, or run a local server from inside the folder:

```
npx serve .            # or
python -m http.server  # then open http://localhost:8000
```

**Embedding**

The page works inside an `<iframe>`, for example:

```html
<iframe src="rift-chess/index.html" title="Rift Chess" style="width:100%;height:900px;border:0"></iframe>
```

If the embedding page blocks storage, the game still runs; it just isn't saved.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page structure and dialogs |
| `styles.css` | All styling (dark theme, responsive layout, reduced-motion support) |
| `rules.js` | Pure rules engine: move generation, portals, check, draws, repetition (no DOM) |
| `ai.js` | Computer opponent search and evaluation (no DOM) |
| `game.js` | Game orchestration: undo, persistence, draw workflow, AI worker management (no DOM) |
| `ui.js` | Rendering and input |
| `pieces.js` | Bundled SVG chess pieces (see `LICENSES.md`) |
| `tests.html`, `tests.js` | Automated test suite (browser) |
| `run-tests.js` | Runs the same test suite under Node.js |

The DOM is never the source of truth. All state lives in `game.js` and `rules.js`, and `ui.js` only draws it. The AI runs in a Web Worker built from the in-page source code, so it works even from `file://` and needs no extra file.

## Running the tests

- **Browser:** open `tests.html`. It runs all tests and shows pass/fail for each.
- **Node.js (optional):** `node run-tests.js` from this folder. It exits with code 1 if anything fails.

The suite covers portal behaviour, legality and king safety, castling, en passant, promotion, every draw rule, checkmate precedence, dead positions, undo, save/restore, AI legality at every level, and cancellation of stale AI searches. It also checks the base move generator against known perft node counts, with portals temporarily disabled.

---

## Portal rules

| Pair | Squares | Marker |
|---|---|---|
| A | **c3 ↔ f6** | cyan diamond, tag "A" |
| B | **f3 ↔ c6** | violet circle, tag "B" |

1. A non-king piece makes an ordinary chess move.
2. Any capture on the landing square happens normally.
3. If the piece lands on a portal and the twin square is empty, it automatically teleports there.
4. If the twin square holds any piece (friendly, enemy or a king), there is no teleport and the piece stays on the entry square.
5. Nothing is ever captured at the exit.
6. A piece teleports at most once per move and never immediately teleports back.
7. Teleporting is mandatory when the exit is empty.
8. Sliding *across* a portal without stopping there does nothing.
9. Standing on a portal at the start of a turn does nothing.
10. The teleport is part of the same move, not an extra turn.
11. **Kings never teleport.** They may stand on portals, and a king on an exit blocks that portal.

**Clarification: the round trip.** The exit's emptiness is judged after the moving piece has left its starting square. Say a bishop or queen standing on one portal moves along the diagonal to its twin (f6→c3 or f3→c6). It has just vacated the exit, so it teleports straight back to its starting square. If something stood on the far portal, it was captured; otherwise the move changes only the side to move. This follows directly from the rules above, and the interface marks it with a "(back)" badge.

**Opening consequences.** In the starting position f6 and c6 are empty. So 1.Nc3 puts the knight on f6 with check, 1.c3 puts the c-pawn on f6, and 1.f3 puts the f-pawn on c6.

Both squares of each pair have the same colour (c3/f6 are dark, f3/c6 are light), so bishops never change square colour.

## Standard chess rules and how they adapt

- **Legality** is judged on the *completed* move: ordinary move, capture, promotion, castling rook and teleport. A move is illegal if it leaves the mover's king attacked. A non-king move is never rejected because an intermediate position, before the mandatory teleport, would expose the king. For example, a knight may answer a rank check by landing on c3 and emerging on f6 to block the check.
- **Attacks** use ordinary capture geometry from each piece's current square. Pinned pieces still attack. Pawns attack diagonally forward, kings attack adjacent squares, and kings may never stand adjacent. Portals never create remote attacks: a knight that could land on c3 does *not* attack f6. A piece that teleports attacks from its final square, so a teleport can deliver check.
- **Pawns** keep their colour's direction after teleporting. Double steps are allowed only from the original pawn rank, and both squares must be empty. Portal squares are never promotion squares.
- **Promotion** offers queen, rook, bishop or knight through a dialog. Nothing is chosen automatically for a human player.
- **Castling** rights are tracked explicitly. They are lost when the king or the relevant original rook moves or is captured, and they never come back, even if a promoted rook reaches the corner. You cannot castle out of, through or into check. The transit square is tested with the king actually standing on it. No castling square is a portal.
- **En passant** is available only immediately after an enemy double step. The engine records the passed-over square and the pawn's real square, and the captured pawn must stand on the ordinary adjacent square. The captured pawn is removed before king safety is checked. If the capturing pawn lands on a portal (possible on c3, f3, c6 and f6), it then teleports normally.
- **Check, checkmate and stalemate** use the portal-aware move generator. The test suite includes a checkmate that is not mate in orthodox chess (the only block would land on a portal and be forced away). It also includes a stalemate that orthodox chess would not have.

### Draws

| Rule | How it works here |
|---|---|
| Stalemate | Automatic |
| Threefold repetition | **Claimable** with *Claim Draw*, either for the current position or by naming a legal move that would create the third occurrence |
| Fivefold repetition | Automatic |
| Fifty-move rule | **Claimable** at 100 half-moves, or by naming a move that reaches 100 |
| Seventy-five-move rule | Automatic at 150 half-moves. Checkmate on that move takes precedence |
| Dead position | Automatic for the cases listed below |
| Agreement | Two-player mode only: *Offer Draw*, then the opponent accepts or declines |

The repetition identity includes piece placement, side to move, castling rights and en passant. En passant counts only when an en passant capture is actually legal. Move numbers and clocks are excluded.

The half-move clock resets on pawn moves and on captures, including en passant. A non-pawn teleport without a capture does **not** reset it.

The *Claim Draw* button appears only when a claim is valid. The computer claims a valid draw when its search says it is worse off by at least 0.3 pawns. In computer mode there is no "Offer Draw" button, because the computer has no policy for accepting or making offers.

### Dead positions: what is recognised

A position is dead when no sequence of legal moves can ever lead to checkmate. Portals change which positions are reachable, so orthodox shortcuts were rechecked rather than copied. The game recognises exactly these cases:

1. **King vs king.**
2. **King + one knight vs lone king.** Checkmate depends only on the final position. A lone king never teleports, so its escape options are exactly orthodox, and orthodox chess has no position at all where K+N mates a bare king.
3. **Kings plus any number of bishops, all on squares of one colour** (including K+B vs K). Bishops can never change colour, because both portal pairs join same-coloured squares. A king checked by such a bishop stands on that colour. All of its orthogonal neighbours are the other colour, and only the attacking king could cover or occupy those, which it cannot do without standing next to the defending king. So no checkmate position exists, with or without portals.

Everything else, such as fortress-like pawn blockades, is **not** detected automatically. Those games continue until another rule ends them (for example the 75-move rule or fivefold repetition). The detection is deliberately conservative and is **not** exhaustive.

### Resignation

*Resign* asks for confirmation. In computer mode, you resign. In two-player mode, the side to move resigns.

---

## Playing

- **Click or tap** a piece, then a highlighted square. Dots are quiet moves and rings are captures.
- If the target is a portal, a badge shows **"→ f6"** for the exit. The exit square is outlined, and hovering or focusing the entry shows a ghost piece there. If the exit is occupied, the badge says **"stays"**.
- You always choose the **entry** square, never the exit.
- To castle, select the king and its destination square. To capture en passant, select the destination square as normal.
- The last move is highlighted (origin, entry, and exit if it teleported). A king in check glows red.
- **Keyboard:** Tab to the board, use the arrow keys to move, and press Enter or Space to select. Escape clears the selection.
- **Undo** restores the complete previous state. In computer mode it removes your move and the computer's reply together, and it can also take back a finished game. If the computer is thinking, the search is cancelled and its result is discarded.
- **Flip Board** turns the board around. **Rules** shows a summary in the game.

### Move notation

The move list uses a **custom coordinate notation, not standard SAN**:

| Example | Meaning |
|---|---|
| `e2-e4` | pawn moves (no piece letter for pawns) |
| `Nb1-c3→f6` | knight moved to portal c3 and emerged on f6 |
| `Bf6xc3→f6` | bishop captured on c3 and returned to f6 (round trip) |
| `e5xd6 e.p.` | en passant |
| `a7-a8=N` | promotion to a knight |
| `O-O`, `O-O-O` | castling |
| `+`, `#` | check, checkmate |

## Game modes and difficulty

- **vs Computer** (default): you play White, and you can switch to Black. Difficulty can be changed at any time and applies to the computer's next search.
- **Two Players**: pass-and-play on one device, with draw offers.

Changing the mode or your colour starts a new game and asks for confirmation first if a game is in progress.

All levels use the same legal-move generator as the rules engine. They evaluate positions after portal effects and score mate, stalemate and draws correctly.

| Level | Target time | Search |
|---|---|---|
| Easy | ~100–300 ms | Exact 2-ply scores with quiescence, then a randomised pick among moves within ~1.2 pawns of the best; about 12% of the time it picks from a wider pool (within 3 pawns), so it makes occasional imperfect choices. Always takes a forced mate; avoids moves that walk into mate. Material + piece-square evaluation only. |
| Medium | ~500–1,000 ms | Iterative deepening alpha-beta (up to 5 plies plus extensions), quiescence search, transposition table, full evaluation. |
| Hard | ~1,500–3,000 ms | Same search with no fixed depth cap, limited only by the time budget. |

The full evaluation covers:

- material and piece-square tables (pawn advancement included)
- mobility and the bishop pair
- passed, doubled and isolated pawns
- king pawn shield and attacks on the king zone
- a **portal term** that rewards controlling portal entries whose exits are open, especially exits next to the enemy king.

The search uses:

- principal variation search, TT-move, MVV-LVA, killer and history ordering, and a check extension
- all four promotion choices, with underpromotion in the main search
- castling, en passant, the half-move clock and repetition history
- transposition-table entries whose scores depended on a repetition are not stored, and positions near the move-count thresholds are keyed by the half-move clock.

The time targets live in `RiftAI.LEVELS` in `ai.js` and can be changed. Actual speed depends on the device, and no Elo rating is claimed.

The search runs in a **Web Worker**, so the interface stays responsive and shows "Computer is thinking…". If workers are unavailable, a **fallback** runs a shorter (≤400 ms) search on the main thread. During that search the page may pause briefly.

## Saving

The current game is saved to `localStorage` after every change. The save includes the board, side to move, castling rights, en passant, both clocks, repetition history, move list, undo history, mode, difficulty, your colour, the board orientation, the result and a format version.

A search in progress is never saved. If it is the computer's turn when the page reloads, it starts thinking again.

Saved data that is malformed or inconsistent is ignored, and a new game starts. If storage is unavailable, the game still works without saving. *New Game* replaces the saved game.

---

## Known limitations

- **Dead-position detection is not exhaustive.** Only the cases listed above are recognised automatically.
- **The notation is custom**, not SAN, and there is no PGN import/export.
- **AI timings are targets.** Slower devices search less deeply. The no-worker fallback uses a shorter budget and can briefly block the page.
- The computer never offers or accepts draws by agreement. It only claims rule-based draws.
- Threefold and fifty-move claims "by intended move" are made by playing that move through the claim dialog, which then ends the game.
- No chess clock or time controls (by design).
- The round-trip interpretation described above is this implementation's reading of the portal rules.
- Save data lives in this browser only.
