// loadpath.js: give a card its power-up load path, option B of COPY-ENGINE.md (Kehai Interim, 2026-11-18). MIT.
// addLoadPath(card, opts) rewires a built card in place:
//   1. Every table SRAM (/WE tied high) gets /OE = LOAD and its own /WE, decoded from the load bus.
//   2. Every driver of a table net (address or data) lets go during LOAD:
//      - parts with an output enable get it ORed with LOAD (one '32 gate per distinct original enable net);
//      - '157s and '153s with their enables tied low become '257s / '253s (same pinout, 3-state);
//      - anything else (gates, '157s really using /E) gets a '125 buffer after it;
//      - bussed pull networks on table nets get their common pin switched off by a '125 during LOAD.
//      - Card inputs that are table nets must be let go by the card driving them (checked when cards are combined).
//   3. Each table net gets a 10k resistor (RLINK8, 8 per network) to one load-bus line, LDB<colour>. The colouring puts
//      all the nets of one table chip on different lines (DSATUR, at most 32).
//   4. The chip select for /WE: LDB32..LDB38 (chip index), LOAD_SEL0..2 (card), LOAD_WE (strobe). LDB32..38 get weak
//      pull-downs, so they're defined at run time when the card's bus switch is open.
//   5. Nets left with no driver at all during LOAD get a weak pull-up (so no CMOS input floats); that list is found
//      by settling the card in LOAD mode until it's clean.
// The bus switch that joins LDB0..LDB38 to the backplane D wires is off-card in this model: LB lines are card inputs,
// driven during LOAD and floating ('Z' / absent) at run time.
'use strict';
const { P } = require('./parts.js');
const isTable = c => c.mem && c.pins['/WE'] === 'VCC';
const tableNets = c => [...new Set(Object.entries(c.pins).filter(([p, n]) => (/^A\d+$/.test(p) || /^IO\d+$/.test(p)) && n !== 'GND' && n !== 'VCC').map(([, n]) => n))];
const WIRES = [...Array(27).keys()].flatMap(k => [`D${k}+`, `D${k}-`]);   // the backplane D bus, wire index 0..53
// Every backplane signal the copy engine drives during LOAD: the D bus, then the control and status lines that feed a
// table somewhere (their drivers on the cards let go in LOAD). A table net that is one of these lines needs no
// resistor: the engine drives it, and its colour is its line index. Free nets are coloured with any line index.
// (These are the backplane's own spellings since integration stage 1, 2026-11-20: IRQSET0..4, MODE, PROTEN, RESET.)
const LINES = [...WIRES, ...[...Array(10).keys()].map(i => `UA${i}`), ...[...Array(6).keys()].map(i => `PORT${i}`), ...[...Array(5).keys()].map(i => `RSLOT${i}`),
  'RESET', '/CEDGE', 'MODE', 'PRIV', 'PROTEN', 'IE', 'SPRNR', 'ABORT', 'FK', 'SF+', 'SF-', 'QT+', 'QT-', 'BTOPNZ', 'BADADDR', 'IORDY', ...[...Array(5).keys()].map(i => `IRQSET${i}`)];
function colour(tables, maxColours = LINES.length, mutant) {
  const adj = new Map(); const add = n => { if (!adj.has(n)) adj.set(n, new Set()); return adj.get(n); };
  for (const c of tables) { const nets = tableNets(c); for (const a of nets) { const s = add(a); for (const b of nets) if (a !== b) s.add(b); } }
  // a table net that IS a backplane D wire is driven by the copy engine directly: its colour is its wire index
  const col = new Map(), left = new Set(adj.keys()); for (const n of adj.keys()) { const w = LINES.indexOf(n); if (w >= 0) { col.set(n, w); left.delete(n); } }
  for (const c of tables) { const seen = new Map(); for (const n of tableNets(c)) if (col.has(n)) { if (seen.has(col.get(n))) throw new Error(`${c.ref}: two engine lines on one colour?`); seen.set(col.get(n), n); } }
  while (left.size) { let best = null, bs = -1, bd = -1;
    for (const v of left) { const sat = new Set([...adj.get(v)].filter(u => col.has(u)).map(u => col.get(u))).size, d = adj.get(v).size;
      if (sat > bs || (sat === bs && d > bd) || (sat === bs && d === bd && v < best)) { best = v; bs = sat; bd = d; } }
    const used = new Set([...adj.get(best)].filter(u => col.has(u)).map(u => col.get(u))); let k = 0; while (used.has(k)) k++;
    if (k >= maxColours) throw new Error(`colouring needs more than ${maxColours} load lines (net ${best}, on ${tables.filter(c => tableNets(c).includes(best)).map(c => c.ref).join(",")})`); col.set(best, k); left.delete(best); }
  if (mutant === 'WRONG_COLOUR') { const [a] = [...col.keys()].filter(n => !LINES.includes(n)).sort(); const nb = [...adj.get(a)].sort()[0]; col.set(a, col.get(nb)); }   // clash on one chip
  return col;
}
function addLoadPath(card, opts = {}) {
  const { cardId = 0, mutant, worldLoad = {} } = opts, added = {}, note = (part, k = 1) => added[part] = (added[part] || 0) + k;
  // the new nets must not collide with the card's own (the Video card has LB0..LB11 for its line buffer)
  const existing = new Set(card.chips.flatMap(c => Object.values(c.pins)));
  for (const n of existing) if (/^(LDB\d|LOAD|\/WE_|\/LP_|PULL_)/.test(n) || /\|LOAD$|~pre$/.test(n)) throw new Error(`net name ${n} collides with the load path's names`);
  const tables = card.chips.filter(isTable); if (tables.length > 128) throw new Error('more than 128 tables on one card');
  const tnets = new Set(tables.flatMap(tableNets)), col = colour(tables, LINES.length, mutant);
  for (const n of tnets) if (card.inputs.has(n) && !LINES.includes(n)) throw new Error(`table net ${n} is a card input but not an engine line`);
  for (const n of tnets) if (LINES.includes(n)) card.input(n);   // the engine reaches it through the backplane connector
  const drivers = new Map(); for (const c of card.chips) for (const o of P[c.part].out) { const n = c.pins[o]; if (n && tnets.has(n)) { if (!drivers.has(n)) drivers.set(n, []); drivers.get(n).push([c, o]); } }
  // --- 2. drivers let go during LOAD ---
  const orNets = new Map(), orGates = [];             // original enable net -> net of (original OR LOAD)
  const orLoad = n => { if (n === 'VCC') return 'VCC'; if (n === 'GND') return 'LOAD'; if (!orNets.has(n)) { orNets.set(n, `${n}|LOAD`); orGates.push(n); } return orNets.get(n); };
  const buffered = [], swaps = [], switchedPacks = new Map(); let skipped = null;
  const done = new Set();
  for (const [n, list] of drivers) for (const [c, o] of list) {
    const key = c.ref + ':' + o; if (done.has(key)) continue; done.add(key); if (skipped === c.ref) continue;   // the mutant skips the whole chip
    // mutant: leave one driver on during LOAD. Pick one whose enable is tied low: a register whose /OE is RESET is off
    // in LOAD anyway (the CPU is held in reset), so skipping that one would be an equivalent mutant
    if (mutant === 'DRIVER_LEFT_ON' && !skipped && !isTable(c) && (c.pins['/OE'] === 'GND' || c.pins[`${o[0]}/OE`] === 'GND' || (P[c.part].out.length && !P[c.part].tri && !P[c.part].weak && c.part !== 'ALVCH16823' && c.part !== 'LVC574'))) { skipped = c.ref; continue; }
    const pt = c.part;
    if (isTable(c) || /^IS61/.test(pt) || pt === 'LVC574' || pt === 'LVC245' || pt === 'CBTLV3245' || pt === 'CBTLV3257') { if (!c._lp) { c.pins['/OE'] = orLoad(c.pins['/OE']); c._lp = 1; } }   // tables too: some share an output bus by /OE
    else if (pt === 'ALVCH16823') { const h = o[0]; if (!c[`_lp${h}`]) { c.pins[`${h}/OE`] = orLoad(c.pins[`${h}/OE`]); c[`_lp${h}`] = 1; } }
    else if (pt === 'CBTLV3253') { const h = o[0]; if (!c[`_lp${h}`]) { c.pins[`${h}/OE`] = orLoad(c.pins[`${h}/OE`]); c[`_lp${h}`] = 1; } }
    else if (pt === 'LVC157' && c.pins['/E'] === 'GND') { c.part = 'LVC257'; delete c.pins['/E']; c.pins['/OE'] = 'LOAD'; swaps.push(c.ref); }
    else if (pt === 'LVC153' && c.pins['1/E'] === 'GND' && c.pins['2/E'] === 'GND') { c.part = 'LVC253'; delete c.pins['1/E']; delete c.pins['2/E']; c.pins['1/OE'] = 'LOAD'; c.pins['2/OE'] = 'LOAD'; swaps.push(c.ref); }
    else if (P[pt].weak) { const com = pt === 'RPACK8G' ? 'GND' : 'VCC'; c.part = 'RPACK8S'; c.pins.COM = `PULL_${com}_SW`; switchedPacks.set(com, c.pins.COM); }
    else { c.pins[o] = `${n}~pre`; buffered.push([`${n}~pre`, n]); }
  }
  // shared 3-state buses (several drivers on one net, e.g. the Memory card's RAM data bus): every driver lets go during
  // LOAD too, or a select decoder fed by floating/pulled lines could turn two of them on at once
  const nd = new Map(); for (const c of card.chips) if (!P[c.part].weak) for (const o of P[c.part].out) { const n = c.pins[o]; if (n) nd.set(n, (nd.get(n) || 0) + 1); }
  for (const c of card.chips) { if (!P[c.part].tri || isTable(c) || c.ref === skipped) continue; if (!P[c.part].out.some(o => c.pins[o] && nd.get(c.pins[o]) > 1)) continue;
    if (c.pins['/OE'] !== undefined && !c._lp) { c.pins['/OE'] = orLoad(c.pins['/OE']); c._lp = 1; }
    for (const h of ['1', '2']) if (c.pins[`${h}/OE`] !== undefined && !c[`_lp${h}`]) { c.pins[`${h}/OE`] = orLoad(c.pins[`${h}/OE`]); c[`_lp${h}`] = 1; } }
  // every on-card driver of a backplane net (the D bus '245s, ...) lets go during LOAD: the copy engine owns D then
  for (const c of card.chips) { if (isTable(c) || P[c.part].weak || c.ref === skipped) continue; if (!P[c.part].out.some(o => c.pins[o] && card.inputs.has(c.pins[o]) && c.pins[o] !== 'GND' && c.pins[o] !== 'VCC')) continue;
    if (!P[c.part].tri && c.part !== 'ALVCH16823' && c.part !== 'LVC574') throw new Error(`${c.ref} (${c.part}) drives a backplane net and can't let go`);
    if (c.pins['/OE'] !== undefined && !c._lp) { c.pins['/OE'] = orLoad(c.pins['/OE']); c._lp = 1; }
    for (const h of ['1', '2']) if (c.pins[`${h}/OE`] !== undefined && !c[`_lp${h}`]) { c.pins[`${h}/OE`] = orLoad(c.pins[`${h}/OE`]); c[`_lp${h}`] = 1; } }
  for (const [com, net] of switchedPacks) buffered.push([com, net]);
  for (let i = 0; i < orGates.length; i += 4) { const pins = {}; orGates.slice(i, i + 4).forEach((n, k) => Object.assign(pins, { [`${k + 1}A`]: n, [`${k + 1}B`]: 'LOAD', [`${k + 1}Y`]: orNets.get(n) }));
    for (let k = orGates.slice(i, i + 4).length; k < 4; k++) Object.assign(pins, { [`${k + 1}A`]: 'GND', [`${k + 1}B`]: 'GND' }); card.add(`LP_OR${i / 4}`, 'LVC32', pins); note('LVC32'); }
  for (let i = 0; i < buffered.length; i += 4) { const pins = {}; buffered.slice(i, i + 4).forEach(([a, y], k) => Object.assign(pins, { [`${k + 1}A`]: a, [`${k + 1}/OE`]: 'LOAD', [`${k + 1}Y`]: y })); card.add(`LP_BUF${i / 4}`, 'LVC125', pins); note('LVC125'); }
  if (swaps.length) note('swapped to 3-state (same pinout)', swaps.length);
  // --- 3. the resistors ---
  const nets = [...tnets].filter(n => !LINES.includes(n)).sort();   // engine-line nets need no resistor: the engine drives them
  for (let i = 0; i < nets.length; i += 8) { const pins = {}; nets.slice(i, i + 8).forEach((n, k) => Object.assign(pins, { [`N${k + 1}`]: n, [`L${k + 1}`]: `LDB${col.get(n)}` })); card.add(`LP_R${i / 8}`, 'RLINK8', pins); note('RLINK8 (passive)'); }
  // --- 4. /WE select: a 16-bit shift register (2 x '164) loaded serially before each table (LOAD_SEL0 = data,
  // LOAD_SEL1 = clock, MSB first): bits 0..6 the chip index, 7..9 the card. LOAD_WE strobes the chosen chip. ---
  const sel = k => `LP_S${k}`;
  card.add('LP_SH0', 'LV164', { A: 'LOAD_SEL0', B: 'VCC', CLK: 'LOAD_SEL1', '/CLR': 'VCC', ...Object.fromEntries([...Array(8).keys()].map(i => [`Q${i}`, sel(i)])) }); note('LV164');
  card.add('LP_SH1', 'LV164', { A: sel(7), B: 'VCC', CLK: 'LOAD_SEL1', '/CLR': 'VCC', Q0: sel(8), Q1: sel(9) }); note('LV164');
  card.add('LP_CSEL', 'LVC138', { A: sel(7), B: sel(8), C: sel(9), G1: 'LOAD_WE', '/G2A': 'GND', '/G2B': 'GND', [`/Y${cardId}`]: '/LP_CARD' }); note('LVC138');
  const n2 = Math.ceil(tables.length / 8), n1 = Math.ceil(n2 / 8);
  for (let j = 0; j < n1; j++) { const pins = { A: sel(3), B: sel(4), C: sel(5), '/G2A': '/LP_CARD' };
    if (j === 0) Object.assign(pins, { G1: 'VCC', '/G2B': sel(6) }); else Object.assign(pins, { G1: sel(6), '/G2B': 'GND' });
    for (let i = 0; i < 8 && j * 8 + i < n2; i++) pins[`/Y${i}`] = `/LP_G${j * 8 + i}`; card.add(`LP_D1_${j}`, 'LVC138', pins); note('LVC138'); }
  const order = tables.slice(); if (mutant === 'WE_SWAP' && order.length > 1) [order[0], order[1]] = [order[1], order[0]];
  for (let g = 0; g < n2; g++) { const pins = { A: sel(0), B: sel(1), C: sel(2), G1: 'VCC', '/G2A': `/LP_G${g}`, '/G2B': 'GND' };
    for (let i = 0; i < 8 && g * 8 + i < order.length; i++) { const t = order[g * 8 + i]; pins[`/Y${i}`] = `/WE_${t.ref}`; } card.add(`LP_D2_${g}`, 'LVC138', pins); note('LVC138'); }
  tables.forEach(t => { t.pins['/WE'] = `/WE_${t.ref}`; });
  // the bus switch ('16211s): each engine line that a free net's resistor uses, onto LDB<line> while LOAD is high;
  // open (floating) at run time
  const used = [...new Set(nets.map(n => col.get(n)))].sort((a, b) => a - b), wires = LINES;
  if (opts.switch !== false) {
    card.add('LP_INV', 'LVC04', { '1A': 'LOAD', '1Y': '/LOAD' }); note('LVC04');
    for (let j = 0; j * 24 < used.length; j++) { const pins = { '1/OE': '/LOAD', '2/OE': '/LOAD' };
      used.slice(j * 24, j * 24 + 24).forEach((k, i) => { const h = i < 12 ? 1 : 2, m = i % 12 + 1; pins[`${h}A${m}`] = LINES[k]; pins[`${h}B${m}`] = `LDB${k}`; card.input(LINES[k]); });
      card.add(`LP_SW${j}`, 'CBTLV16211', pins); note('CBTLV16211'); } }
  card.input('LOAD', 'LOAD_WE', 'LOAD_SEL0', 'LOAD_SEL1', 'LOAD_SEL2'); if (opts.switch === false) card.input(...used.map(k => `LDB${k}`));
  card.defaults = new Map([['LOAD', 0], ['LOAD_WE', 0], ['LOAD_SEL0', 0], ['LOAD_SEL1', 0], ['LOAD_SEL2', 0]]);
  card.order = null;
  // --- 5. pull-ups for nets that float during LOAD: settle in LOAD mode, add one per undriven net, repeat ---
  // static rule first: a net whose every driver is switched off in LOAD (and which isn't a table net or a card input)
  // floats during LOAD, so it gets a pull-up. The settle loop below catches anything this misses.
  const enPin = (c, o) => { const pt = c.part; if (pt === 'ALVCH16823' || pt === 'CBTLV3253' || pt === 'LVC253' || pt === 'LVC125') return `${o[0]}/OE`;
    if (c.pins['/OE'] !== undefined) return '/OE'; return null; };
  const offInLoad = (c, o) => { const e = enPin(c, o); if (!e) return false; const n = c.pins[e]; return n === 'LOAD' || n === 'VCC' || /\|LOAD$/.test(n); };
  // readers: logic inputs only (a resistor network's common pin or far end is meant to float)
  const readers = new Set(); for (const c of card.chips) if (!P[c.part].weak) for (const [p, n] of Object.entries(c.pins)) if (!P[c.part].out.includes(p)) readers.add(n);
  const allDrv = new Map(); for (const c of card.chips) if (!P[c.part].weak) for (const o of P[c.part].out) { const n = c.pins[o]; if (n) { if (!allDrv.has(n)) allDrv.set(n, []); allDrv.get(n).push([c, o]); } }
  const weakNets = new Set(); for (const c of card.chips) if (P[c.part].weak) for (const o of P[c.part].out) if (c.pins[o]) weakNets.add(c.pins[o]);   // already pulled
  const staticPulls = [...allDrv].filter(([n, l]) => !tnets.has(n) && !weakNets.has(n) && !card.inputs.has(n) && readers.has(n) && l.every(([c, o]) => offInLoad(c, o))).map(([n]) => n).sort();
  const pulls = []; const world = new Map(Object.entries(worldLoad)); world.set('LOAD', 1); world.set('LOAD_WE', 0);
  for (const n of card.inputs) if (!world.has(n) && n !== 'GND' && n !== 'VCC') world.set(n, 0);   // other cards hold the backplane quiet in LOAD


  const addPull = n => { pulls.push(n); const i = pulls.length - 1; if (i % 8 === 0) { card.add(`LP_PU${i / 8}`, 'RPACK8', {}); note('RPACK8 (passive)'); }
    card.chips[card.chips.length - 1].pins[`P${i % 8 + 1}`] = n; card.order = null; };
  staticPulls.forEach(addPull);
  for (let it = 0; it < 2000; it++) { try { card.settle(world); break; } catch (e) { const m = /net (\S+) undriven/.exec(e.message); if (!m) throw new Error('LOAD-mode settle: ' + e.message);
      const n = m[1]; if (tnets.has(n)) throw new Error(`table net ${n} undriven in LOAD (its line?)`); addPull(n); } }
  card.loadPath = { colour: col, tables, tnets, added, pulls, swaps, skipped, cardId, used };
  return card;
}
// the 54 D-wire values that present (address a, data d) to table t: each net on the line of its colour
function entryWires(card, t, a, d) { const col = card.loadPath.colour, w = new Array(LINES.length).fill(0);
  for (const [p, n] of Object.entries(t.pins)) { if (n === 'GND' || n === 'VCC' || !col.has(n)) continue; let m;
    if ((m = /^A(\d+)$/.exec(p))) w[col.get(n)] = Math.floor(a / 2 ** +m[1]) % 2; else if ((m = /^IO(\d+)$/.exec(p))) w[col.get(n)] = (d >> +m[1]) & 1; }
  return w; }
const selectWord = (cardId, k) => (cardId << 7) | k;   // shifted in MSB first, 16 bits
module.exports = { addLoadPath, isTable, tableNets, entryWires, selectWord, WIRES, LINES };
