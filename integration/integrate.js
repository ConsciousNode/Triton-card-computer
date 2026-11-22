'use strict';
// integrate.js: the whole machine in one netlist (integration stage 1, part 2; Kehai Interim, 2026-11-20). MIT.
// Builds the six cards from the same ROM images their own tests use, adds the clock/reset generator to the Control
// card, and merges them into one Card:
//   - backplane nets (from backplane.js) and the J2 ribbon (Video <-> Memory) are shared by name;
//   - every other net is local to its card and gets the card's prefix ("IO:BUSY");
//   - chip references get the prefix too ("Memory.U120").
// J2 has one name that differs between the ends: the Memory card's VWEH is the Video card's VBUSY. It is joined here,
// by name, and listed in J2_ALIAS so nothing is hidden. Nothing in this file drives a net: the world's parts (the
// oscillator, the MAX812, SD, PS/2, the RTC crystal) are inputs, listed in WORLD.
const fs = require('fs'), path = require('path');
const C = path.join(__dirname, '../cards/'), R = path.join(__dirname, '../roms');
const { Card } = require(C + 'netlist.js'); const { P } = require(C + 'parts.js');
const { decodeWord } = require('../microsim/roms.js');
const { MicroMachine, WORD_BITS, SLOT } = require('../microsim/microsim.js');

// ---- the backplane signal list, read from backplane.js (the same way integration/backplane-check.js does)
const src = fs.readFileSync(path.join(__dirname, '../backplane.js'), 'utf8');
const sig = []; eval(src.slice(src.indexOf('const sig = [];'), src.indexOf('// ---- 2. connector')).replace('const sig = [];', ''));
const BACKPLANE = new Set(sig.map(s => s[0]));
const J2 = new Set([...[...Array(19).keys()].map(i => `SA${i}`), ...[...Array(12).keys()].map(i => `SI${i}`),
  ...[...Array(12).keys()].map(i => `SO${i}`), '/SWR', 'VBUSY']);
const J2_ALIAS = { Memory: { VWEH: 'VBUSY' } };   // card -> { its local name: the J2 name }
// the world: inputs the machine reads from parts with no simulator model, and outputs it gives to the world
const WORLD_IN = ['SCLK', 'POR', 'LOAD', 'FP_RUN', 'FP_STEP', 'FP_STEPMODE', 'SD_MISO', 'SD_CD', 'K_CLK', 'K_DATA', 'M_CLK', 'M_DATA', 'RTC_OSC'];
const WORLD_OUT = { IO: ['CON_TX', 'SD_MOSI', 'SD_SCK', 'SD_/CS', 'K_CLK_OUT', 'K_DATA_OUT', 'M_CLK_OUT', 'M_DATA_OUT'] };
const RAILS = new Set(['GND', 'VCC']);

// ---- control-store images, exactly as each card's own test makes them
const romChips = Array.from({ length: Math.ceil(WORD_BITS / 8) }, (_, k) => fs.readFileSync(path.join(R, `cs${k}.bin`)));
const words = [...Array(1024).keys()].map(w => { let b = 0n; for (let k = 0; k < romChips.length; k++) b |= BigInt(romChips[k][w]) << BigInt(8 * k);
  try { return decodeWord(b); } catch { return null; } });
const fixed = (() => { const m = new MicroMachine(); return { FETCH: m.cs.addr.FETCH, FETCH2: m.cs.addr.FETCH2 }; })();
function packed(cardWord, n, wide = false) { const cs = Array.from({ length: n }, () => Buffer.alloc(1024));
  words.forEach((mu, w) => { if (!mu) return; const cw = cardWord(mu, w, fixed);
    for (let j = 0; j < n; j++) cs[j][w] = wide ? Number((BigInt(cw) >> BigInt(8 * j)) & 255n) : (cw >> (8 * j)) & 255; }); return cs; }
function flat(cardWord) { const cs = Buffer.alloc(1 << 19); words.forEach((mu, w) => { if (mu) cs[w] = cardWord(mu); }); return cs; }

function buildCards({ ramSize = 4782969, mutants = {} } = {}) {
  const alu = require(C + 'alu-card.js'), ctl = require(C + 'control-card.js'), reg = require(C + 'registers-card.js'),
    mem = require(C + 'memory-card.js'), vid = require(C + 'video-card.js'), io = require(C + 'io-ports.js'), clk = require(C + 'clockgen.js');
  const control = ctl.build(R, packed(ctl.cardWord, Math.ceil(ctl.CW.length / 8), true), mutants.Control);
  clk.build(control, { mutant: mutants.clockgen });
  return {
    ALU: alu.build(fs.readFileSync(path.join(R, 'alu.bin')), packed(alu.cardWord, 4), mutants.ALU),
    Control: control,
    Registers: reg.build(flat(reg.cardWord), mutants.Registers),
    Memory: mem.build(packed(mem.cardWord, 3), ramSize, SLOT, mutants.Memory),
    Video: vid.build(flat(vid.cardWord), mutants.Video),
    IO: io.build(flat(io.cardWord), mutants.IO) };
}

// shared by name, or local to the card?
function netName(card, n) {
  if (RAILS.has(n) || BACKPLANE.has(n) || WORLD_IN.includes(n)) return n;
  const a = J2_ALIAS[card] && J2_ALIAS[card][n]; if (a) return a;
  if (J2.has(n) && (card === 'Memory' || card === 'Video')) return n;
  if (WORLD_OUT[card] && WORLD_OUT[card].includes(n)) return n;
  return `${card}:${n}`;
}

function compose(opts = {}) {
  const cards = buildCards(opts); const m = new Card('machine'); m.cardOf = new Map(); m.local = new Map();
  for (const [tag, card] of Object.entries(cards)) {
    for (const ch of card.chips) { const pins = {}; for (const [p, n] of Object.entries(ch.pins)) pins[p] = netName(tag, n);
      const { ref, part, pins: _p, ...extra } = ch;               // carry table images / memories (mem, img...) as they are
      m.add(`${tag}.${ref}`, part, pins, extra); m.cardOf.set(`${tag}.${ref}`, tag); }
    if (card.defaults) { m.defaults = m.defaults || new Map(); for (const [k, x] of card.defaults) m.defaults.set(netName(tag, k), x); }
  }
  m.input(...WORLD_IN);
  // Backplane termination (found by the first integrated run, 2026-11-20: on a microcycle where no card drives the bus,
  // the ALU card's tables read a floating D0+). Every backplane line whose drivers are all three-state gets a pull-down
  // on the backplane board, so an idle line reads inactive: 0 for the active-high controls, and the trit 0 on the
  // dual-rail bus (both rails low). The card tests' harnesses assumed exactly this (an undriven bus read as 0).
  { const triOnly = []; const byNet = new Map();
    for (const c of m.chips) for (const o of P[c.part].out) { const n = c.pins[o]; if (!n || !BACKPLANE.has(n)) continue;
      const k = c.part === 'LVC245' ? ((c.pins.DIR === 'VCC' && o[0] === 'A') || (c.pins.DIR === 'GND' && o[0] === 'B') ? null : 'tri')
        : c.part === 'ALVCH16823' ? (c.pins[`${o[0]}/OE`] === 'GND' ? 'strong' : 'tri') : c.part === 'LVC574' ? (c.pins['/OE'] === 'GND' ? 'strong' : 'tri')
        : P[c.part].weak ? 'weak' : P[c.part].tri ? 'tri' : 'strong';
      if (!k) continue; if (!byNet.has(n)) byNet.set(n, new Set()); byNet.get(n).add(k); }
    for (const [n, ks] of byNet) if (ks.has('tri') && !ks.has('strong') && !ks.has('weak')) triOnly.push(n);
    triOnly.sort(); m.termination = triOnly;
    for (let i = 0; i < triOnly.length; i += 8) { const pins = {}; triOnly.slice(i, i + 8).forEach((n, j) => { pins[`P${j + 1}`] = n; });
      m.add(`BP.RN${i / 8 + 1}`, 'RPACK8G', pins); m.cardOf.set(`BP.RN${i / 8 + 1}`, 'BP'); } }
  // nets a card took as an input from its harness: every one must now be driven inside the machine or be a world input
  const unresolved = [];
  { const drv = new Set(); for (const c of m.chips) for (const o of P[c.part].out) if (c.pins[o]) drv.add(c.pins[o]);
    for (const [tag, card] of Object.entries(cards)) for (const n of card.inputs) { const nn = netName(tag, n);
      if (!RAILS.has(nn) && !drv.has(nn) && !WORLD_IN.includes(nn)) unresolved.push(`${tag}: ${n}${nn !== n ? ` (as ${nn})` : ''}`); } }
  m.unresolved = unresolved; m.cards = cards;
  return m;
}
// Precise static check for the composed machine. Card.check() is conservative: it counts both sides of every '245 as
// drivers and treats registers with an output enable as always on. Here a '245 with DIR tied to VCC drives only B (and
// to GND only A); a '16823 half or '574 is three-state unless its /OE is tied to GND. Rules: every read net has a driver
// or is a world input; a net with an always-on driver has no other driver of any kind; weak (resistor) drivers are fine
// with three-state ones.
function staticCheck(m) {
  const kind = (c, o) => { const p = P[c.part]; if (c.part === 'LVC07') return 'od'; if (p.weak) return 'weak';
    if (c.part === 'LVC245') { const d = c.pins.DIR; if ((d === 'VCC' && o[0] === 'A') || (d === 'GND' && o[0] === 'B')) return null; return c.pins['/OE'] === 'GND' && (d === 'VCC' || d === 'GND') ? 'strong' : 'tri'; }
    if (c.part === 'ALVCH16823') return c.pins[`${o[0]}/OE`] === 'GND' ? 'strong' : 'tri';
    if (c.part === 'LVC574') return c.pins['/OE'] === 'GND' ? 'strong' : 'tri';
    return p.tri ? 'tri' : 'strong'; };
  const drv = new Map(); for (const c of m.chips) for (const o of P[c.part].out) { const n = c.pins[o]; if (!n) continue; const k = kind(c, o); if (!k) continue;
    if (!drv.has(n)) drv.set(n, []); drv.get(n).push({ ref: c.ref, k }); }
  const problems = [];
  for (const [n, ds] of drv) { if (RAILS.has(n)) continue; const strong = ds.filter(d => d.k === 'strong');
    if (strong.length && ds.length > 1) problems.push(`${n}: always-on ${strong.map(d => d.ref).join(', ')} shares the net with ${ds.filter(d => !strong.includes(d)).map(d => `${d.ref} (${d.k})`).join(', ') || 'another always-on driver'}`); }
  const inputs = new Set([...m.inputs]);
  for (const c of m.chips) for (const [pin, n] of Object.entries(c.pins)) { if (P[c.part].out.includes(pin) && kind(c, pin)) continue; if (!drv.has(n) && !inputs.has(n) && !RAILS.has(n)) problems.push(`${c.ref}.${pin}: ${n} has no driver`); }
  return problems;
}
module.exports = { staticCheck, compose, BACKPLANE, J2, J2_ALIAS, WORLD_IN, WORLD_OUT, netName };

if (require.main === module) {
  const t0 = Date.now(); const m = compose();
  const per = {}; for (const [ref] of m.cardOf) { const t = ref.split('.')[0]; per[t] = (per[t] || 0) + 1; }
  console.log(`machine: ${m.chips.length} chips (${Object.entries(per).map(([k, v]) => `${k} ${v}`).join(', ')}), built in ${Date.now() - t0} ms`);
  console.log(`backplane termination: ${m.termination.length} three-state lines pulled down (${Math.ceil(m.termination.length / 8)} x RPACK8G): ${m.termination.join(' ')}`);
  console.log(`card inputs not driven inside the machine: ${m.unresolved.length}`); m.unresolved.forEach(u => console.log('  ' + u));
  const pr = staticCheck(m); console.log(`static check: ${pr.length ? pr.length + ' problem(s)' : 'every read net has a driver or is a world input; no always-on driver shares a net'}`);
  pr.slice(0, 30).forEach(x => console.log('  ' + x)); if (pr.length) process.exitCode = 1;
}
