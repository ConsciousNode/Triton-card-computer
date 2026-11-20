// powerup-sim.js: the whole power-up, flash to tables (Kehai Interim, 2026-11-19). MIT. See COPY-ENGINE.md.
// 1. Build the five cards with their load paths (loadpath.js, cardId = position) and keep every table's intended
//    image; fill every table with garbage.
// 2. Generate the flash stream: per table, 16 SHIFT entries (the select word, MSB first), then one WE entry per address
//    (every reachable address for tables up to FULL entries, else SAMPLE random ones plus the first and last), each
//    entry's 96 lines computed from the card's colouring; then one END entry. Encode it into the two flash images.
// 3. Run the copy engine's netlist (io-copy-engine.js) clock by clock from /POR. Its outputs (the 96 lines, LOAD,
//    LOAD_WE, LOAD_SEL0/1) are the backplane. On each LOAD_SEL1 rising edge, every card settles and its select shift
//    registers clock. While LOAD_WE is high, the cards settle and every table with /WE low stores what its pins see.
//    The first write after each select settles all five cards and requires exactly one table on the whole backplane
//    with /WE low; later writes to the same table settle only that card (nothing can change the selection without a
//    LOAD_SEL1 edge).
// 4. When the engine raises DONE: LOAD must have dropped, and every written entry of every table must match its image.
// Mutants (ENG_MUTANT): WORD_SWAP, STROBE_EARLY, END_IGNORED (io-copy-engine.js).
'use strict';
const { cards } = require('./table-inventory.js'); const { addLoadPath, LINES, selectWord } = require('./loadpath.js');
const { buildEngine, encode } = require('./io-copy-engine.js'); const { P } = require('./parts.js');
const FULL = +(process.env.FULL || 1024), SAMPLE = +(process.env.SAMPLE || 200), MUT = process.env.ENG_MUTANT;
let seed = 777; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const t0 = Date.now(), all = [];
Object.entries(cards).forEach(([name, mk], cardId) => { const card = mk(); addLoadPath(card, { cardId }); card.check();
  for (const t of card.loadPath.tables) t.mem = t.mem.BYTES_PER_ELEMENT === 1 ? new Uint8Array(t.mem) : new Uint16Array(t.mem);
  const images = new Map(card.loadPath.tables.map(t => [t, t.mem.BYTES_PER_ELEMENT === 1 ? new Uint8Array(t.mem) : new Uint16Array(t.mem)]));
  for (const t of card.loadPath.tables) for (let i = 0; i < t.mem.length; i++) t.mem[i] = Math.floor(rnd() * 65536) & (t.mem.BYTES_PER_ELEMENT === 1 ? 255 : 65535);
  all.push({ name, card, cardId, images }); });
// ---- the stream ----
const entries = [], written = []; const lineIdx = new Map(LINES.map((n, i) => [n, i]));
for (const { card, cardId, images } of all) { const L = card.loadPath;
  L.tables.forEach((t, k) => { const word = selectWord(cardId, k);
    for (let b = 15; b >= 0; b--) entries.push({ lines: new Uint8Array(96), shift: 1, sdata: (word >> b) & 1 });
    const apins = Object.keys(t.pins).filter(p => /^A\d+$/.test(p)), dpins = Object.keys(t.pins).filter(p => /^IO\d+$/.test(p) && t.pins[p]);
    const hi = Math.max(...apins.filter(p => !['GND', 'VCC'].includes(t.pins[p])).map(p => +p.slice(1))), range = 2 ** (hi + 1), img = images.get(t);
    const reachable = a => { const seen = new Map(); for (const p of apins) { const n = t.pins[p], bit = Math.floor(a / 2 ** +p.slice(1)) % 2;
        if (n === 'GND' && bit) return false; if (n === 'VCC' && !bit) return false; if (seen.has(n) && seen.get(n) !== bit) return false; seen.set(n, bit); } return true; };
    let addrs = []; if (range <= FULL) { for (let a = 0; a < range; a++) addrs.push(a); } else { addrs = [0, range - 1]; for (let i = 0; i < SAMPLE; i++) addrs.push(Math.floor(rnd() * range)); }
    for (const a of addrs.filter(reachable)) { const lines = new Uint8Array(96);
      for (const p of apins) { const n = t.pins[p]; if (n === 'GND' || n === 'VCC') continue; lines[L.colour.get(n)] = Math.floor(a / 2 ** +p.slice(1)) % 2; }
      for (const p of dpins) lines[L.colour.get(t.pins[p])] = (img[a] >> +p.slice(2)) & 1;
      entries.push({ lines, we: 1 }); written.push([card, t, a]); } }); }
entries.push({ lines: new Uint8Array(96), end: 1 });
const flash = encode(entries);
console.log(`stream: ${entries.length.toLocaleString()} entries (${written.length.toLocaleString()} writes), ${(entries.length * 16 / 1048576).toFixed(1)} MB of flash; built in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
// ---- run ----
const eng = buildEngine(flash, MUT).check(); const regs = eng.chips.filter(c => P[c.part].reg);
const cardWorld = all.map(({ card }) => { const w = new Map(); for (const n of card.inputs) if (n !== 'GND' && n !== 'VCC') w.set(n, 0); return w; });
let cyc = 0, writes = 0, shifts = 0, prevSck = 0, selected = null, msgs = [], doneAt = -1, cardSettles = 0;
const fromEngine = (v, w) => { for (const n of LINES) if (w.has(n)) w.set(n, v.get(n)); for (const n of ['LOAD', 'LOAD_WE', 'LOAD_SEL0', 'LOAD_SEL1']) w.set(n, v.get(n)); };
const settleCard = i => { cardSettles++; fromEngine(eng.v, cardWorld[i]); const v = all[i].card.settle(cardWorld[i]);
  for (const n of LINES) if (cardWorld[i].has(n) && v.get(n) !== cardWorld[i].get(n)) throw new Error(`${all[i].name} drove ${n} during LOAD`); return v; };
const MAXC = (entries.length + 4) * 16 + 64;
try {
  for (cyc = 0; cyc < MAXC && msgs.length < 5; cyc++) {
    const v = eng.settle(new Map([['ECLK', 0], ['/POR', cyc < 3 ? 0 : 1]]));
    if (v.get('DONE') === 1) { doneAt = cyc; break; }
    const sck = v.get('LOAD_SEL1');
    if (sck && !prevSck) { shifts++; selected = null; all.forEach((x, i) => { const cv = settleCard(i); for (const r of ['LP_SH0', 'LP_SH1']) { const c = x.card.chips.find(c => c.ref === r); P[c.part].clock(c, p => cv.get(c.pins[p])); } }); }
    prevSck = sck;
    if (v.get('LOAD_WE') === 1) {
      const which = selected === null ? all.map((_, i) => i) : [selected]; const low = [];
      for (const i of which) { const cv = settleCard(i); for (const t of all[i].card.loadPath.tables) if (cv.get(t.pins['/WE']) === 0) low.push([i, t, cv]); }
      if (low.length !== 1) { msgs.push(`cycle ${cyc}: ${low.length} tables with /WE low (${low.map(([i, t]) => all[i].name + ':' + t.ref).join(', ')})`); }
      else { const [i, t, cv] = low[0]; selected = i; P[t.part].write(t, p => cv.get(t.pins[p])); writes++; } }
    for (const c of regs) P[c.part].clock(c, p => v.get(c.pins[p]));
    if (cyc % 200000 === 0 && cyc) process.stderr.write(`  cycle ${cyc.toLocaleString()} (${((Date.now() - t0) / 1000).toFixed(0)} s), ${writes.toLocaleString()} writes\n`);
  }
} catch (e) { msgs.push(`cycle ${cyc}: ${e.message.slice(0, 200)}`); }
// ---- verdict ----
if (doneAt < 0 && !msgs.length) msgs.push(`DONE never rose in ${MAXC.toLocaleString()} cycles`);
if (doneAt >= 0) { const v = eng.settle(new Map([['ECLK', 0], ['/POR', 1]])); if (v.get('LOAD') !== 0) msgs.push('LOAD still high after DONE');
  for (const n of LINES.slice(0, 4)) if (v.get(n) !== undefined && v.get(n) !== 'Z') msgs.push(`engine still drives ${n} after DONE`); }
let bad = 0, firstBad = null; for (const [card, t, a] of written) { const x = all.find(y => y.card === card), img = x.images.get(t); const mask = Object.keys(t.pins).filter(p => /^IO\d+$/.test(p) && t.pins[p]).reduce((m, p) => m | (1 << +p.slice(2)), 0);
  if ((t.mem[a] & mask) !== (img[a] & mask)) { bad++; if (!firstBad) firstBad = `${x.name}:${t.ref}@${a} ${t.mem[a] & mask} vs ${img[a] & mask}`; } }
if (bad) msgs.push(`${bad} entries wrong after loading (first ${firstBad})`);
const line = `Power-up${MUT ? ' [' + MUT + ']' : ''}: ${entries.length.toLocaleString()} entries, ${cyc.toLocaleString()} engine clocks (${(cyc * 0.125 / 1000).toFixed(1)} ms at 8 MHz), ${shifts} select shifts, ${writes.toLocaleString()} writes, ${cardSettles.toLocaleString()} card settles, ${((Date.now() - t0) / 1000).toFixed(0)} s; ${msgs.length ? 'FAIL: ' + msgs.join(' | ') : 'DONE rose, LOAD dropped, every written entry matches its image'}`;
console.log(line);
require('fs').appendFileSync(require('path').join(__dirname, 'RESULTS-powerup.jsonl'), JSON.stringify({ date: new Date().toISOString(), FULL, SAMPLE, mutant: MUT || null, entries: entries.length, clocks: cyc, writes, ok: !msgs.length, msgs }) + '\n');
process.exitCode = msgs.length ? 1 : 0;
