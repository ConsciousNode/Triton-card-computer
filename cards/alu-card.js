// alu-card.js: the ALU card, chip by chip (Kehai Interim, 2026-11-18). MIT.
// From: CONTROL-SIGNALS.md, TIMING-BUDGET.md, SHIFTER.md, BACKPLANE-PINOUT.md, roms/alu.bin.
// Nets: D{k}+/- backplane bus; A{k}, B{k} latches; BS{k} B after broadcast; R{k} slice results; C{s} slice carries
// (C0 carry in, C9 carry out); S{k} shifter out; UA0..9 micro-address; CW_* this card's own decoded control word.
// Flags block (added 2026-11-18): a sign detector on the bus (3 tryte-sign tables), a flag table (flag-tables.js), a
// final select (table / shadow / bus trits 0..2) and an 18-bit register holding SF CF OF and their fetch-time shadow.
// ESRV (the exception-status value) is driven from here too, with PRIV and IE from the Control card.
'use strict';
const { Card } = require('./netlist.js');
const T = (k, r) => `${k}${r ? '-' : '+'}`;                    // T('A3',0) = 'A3+'
// the card's control word: bit index -> name (active-low names start with /)
const CW = ['/A_CE', '/B_CE', 'FN0', 'FN1', 'FN2', 'FN3', 'NEG0', 'NEG1', 'CIN0', 'CIN1', 'BCAST', 'SHS0', 'SHS1', '/SHOE', '/L9OE',
  'FILL0', 'FILL1', 'LINK0', 'LINK1', 'LDQT', 'W9', '/BUSOE',
  '/FL_CE', '/SH_CE', 'FSEL0', 'FSEL1', 'FOP0', 'FOP1', 'FOP2', '/SHOE_LO', '/ESRV', 'spare31'];

function build(aluImage, csImages, mutant, flagImages = null) {
  const ft = flagImages || (() => { const t = require('./flag-tables.js'); return { sign: t.tryteSign(), flags: t.flagTable() }; })();   // mutant: a deliberate wiring error, for the positive controls
  const c = new Card('ALU');
  c.input('CLK', 'RESET', 'ABORT', ...[...Array(10).keys()].map(i => `UA${i}`), 'PRIV', 'IE');
  for (let k = 0; k < 27; k++) c.input(T(`D${k}`, 0), T(`D${k}`, 1));
  // --- control store (3 chips, 1K words used) and its pipeline register (2 x 16823) ---
  for (let j = 0; j < 4; j++) { const pins = { '/CE': 'GND', '/OE': 'GND', '/WE': 'VCC' };
    for (let i = 0; i < 19; i++) pins[`A${i}`] = i < 10 ? `UA${i}` : 'GND';
    for (let i = 0; i < 8; i++) pins[`IO${i}`] = `CSD${8 * j + i}`; c.add(j < 3 ? `U${30 + j}` : 'U29', 'IS61WV5128', pins, { mem: csImages[j] }); }
  for (let j = 0; j < 2; j++) { const pins = {}; for (const h of [1, 2]) { pins[`${h}/OE`] = 'RESET'; pins[`${h}/CLKEN`] = 'GND'; pins[`${h}CLK`] = 'CLK'; pins[`${h}/CLR`] = 'VCC';
      for (let i = 0; i < 9; i++) { const b = 18 * j + 9 * (h - 1) + i; if (b < 32) { pins[`${h}D${i}`] = `CSD${b}`; pins[`${h}Q${i}`] = `CW_${CW[b]}`; } else { pins[`${h}D${i}`] = 'GND'; } } }
    c.add(`U${33 + j}`, 'ALVCH16823', pins); }
  // during RESET the pipeline outputs are off and these pull every control line high: no loads, no switch enabled,
  // not driving the bus. (Without them, a power-up pipeline of random bits can turn on two switch banks at once.)
  for (let j = 0; j < 4; j++) { const pins = {}; for (let i = 1; i <= 8; i++) pins[`P${i}`] = `CW_${CW[8 * j + i - 1]}`; c.add(`RN${1 + j}`, 'RPACK8', pins); }
  // --- A and B latches: 3 x 16823 each, D from the bus, clock enable from the control word ---
  const latch = (name, ce, refBase) => { for (let j = 0; j < 3; j++) { const pins = {};
    for (const h of [1, 2]) { pins[`${h}/OE`] = 'GND'; pins[`${h}/CLKEN`] = `/${name}_LD`; pins[`${h}CLK`] = 'CLK'; pins[`${h}/CLR`] = 'VCC';
      for (let i = 0; i < 9; i++) { const w = 18 * j + 9 * (h - 1) + i, k = w >> 1, r = w & 1; pins[`${h}D${i}`] = T(`D${k}`, r); pins[`${h}Q${i}`] = T(`${name}${k}`, r); } }
    c.add(`U${refBase + j}`, 'ALVCH16823', pins); } };
  // clock enables come from the control word (already active-low), ORed with ABORT: when the Memory card's address
  // check faults a cycle, nothing on any card may load (BACKPLANE: ABORT).
  c.add('U35', 'LVC32', { '1A': 'CW_/A_CE', '1B': 'ABORT', '1Y': '/A_LD', '2A': 'CW_/B_CE', '2B': 'ABORT', '2Y': '/B_LD', '3A': 'CW_/FL_CE', '3B': 'ABORT', '3Y': '/FL_LD',
    // BTOPNZ (2026-11-20, found by the integration's backplane check): B's top trit is not zero, for the Control card's
    // BTOPZ condition (DIV/MOD align the divisor on it). The spare OR gate: B26+ or B26-. Nobody drove it before.
    '4A': mutant === 'BTOP_FROM_B25' ? T('B25', 0) : T('B26', 0), '4B': mutant === 'BTOP_FROM_B25' ? T('B25', 1) : T('B26', 1), '4Y': 'BTOPNZ' });
  // (the shadow needs no ABORT gate: it loads only on FETCH/FETCH2 and the two RETIRE words, none of which access memory)
  latch('A', 'A', 1); latch('B', 'B', 4);
  // --- carry in, negation, fill selects ---
  c.add('U39', 'LVC153', { S0: 'CW_CIN0', S1: 'CW_CIN1', '1/E': 'GND', '2/E': 'GND',
    '1I0': 'GND', '1I1': 'CF+', '1I2': 'VCC', '1I3': 'LINK+', '1Y': 'C0+', '2I0': 'GND', '2I1': 'CF-', '2I2': 'GND', '2I3': 'LINK-', '2Y': 'C0-' });
  c.add('U40', 'LVC153', { S0: 'CW_NEG0', S1: 'CW_NEG1', '1/E': 'GND', '2/E': 'VCC',
    '1I0': 'GND', '1I1': 'VCC', '1I2': 'QT-', '1I3': 'GND', '1Y': 'NEG', '2I0': 'GND', '2I1': 'GND', '2I2': 'GND', '2I3': 'GND' });
  // upper six slices see function 11 (an all-zero table page) in WIDTH9 mode
  c.add('U41', 'LVC157', { S: 'CW_W9', '/E': 'GND', '1I0': 'CW_FN0', '1I1': 'VCC', '1Y': 'FNU0', '2I0': 'CW_FN1', '2I1': 'VCC', '2Y': 'FNU1',
    '3I0': 'CW_FN2', '3I1': 'GND', '3Y': 'FNU2', '4I0': 'CW_FN3', '4I1': 'VCC', '4Y': 'FNU3' });
  // --- B broadcast: slices 1..8 see B's slice 0 when BCAST (12 x 157) ---
  const bw = []; for (let k = 3; k < 27; k++) for (const r of [0, 1]) bw.push([T(`B${k}`, r), T(`B${mutant === 'BCAST_FROM_SLICE1' ? 3 + (k % 3) : k % 3}`, r), T(`BS${k}`, r)]);
  for (let j = 0; j < 12; j++) { const pins = { S: 'CW_BCAST', '/E': 'GND' };
    for (let i = 1; i <= 4; i++) { const [i0, i1, y] = bw[4 * j + i - 1]; pins[`${i}I0`] = i0; pins[`${i}I1`] = i1; pins[`${i}Y`] = y; }
    c.add(`U${42 + j}`, 'LVC157', pins); }
  // --- 9 slice tables (alu.bin), carry rippling C0 -> C9 ---
  for (let s = 0; s < 9; s++) { const pins = { '/CE': 'GND', '/OE': 'GND', '/WE': 'VCC' };
    for (let t = 0; t < 3; t++) for (const r of [0, 1]) { const k = 3 * s + t;
      pins[`A${2 * t + r}`] = T(`A${k}`, r); pins[`A${6 + 2 * t + r}`] = s === 0 ? T(`B${k}`, r) : T(`BS${k}`, r); pins[`IO${2 * t + r}`] = T(`R${k}`, r); }
    pins.A12 = `C${mutant === 'CARRY_SKIP' && s === 4 ? 3 : s}+`; pins.A13 = `C${mutant === 'CARRY_SKIP' && s === 4 ? 3 : s}-`; for (let i = 0; i < 4; i++) pins[`A${14 + i}`] = s < 3 ? `CW_FN${i}` : `FNU${i}`;
    pins.A18 = 'NEG'; pins.IO6 = `C${s + 1}+`; pins.IO7 = `C${s + 1}-`;
    c.add(`U${60 + s}`, 'IS61WV5128', pins, { mem: aluImage }); }
  // --- link / QT register: 153 picks the link source, 157 picks QT, one 574 holds both ---
  c.add('U37', 'LVC153', { S0: 'CW_LINK0', S1: 'CW_LINK1', '1/E': 'GND', '2/E': 'GND',
    '1I0': 'LINK+', '1I1': 'R0+', '1I2': 'R26+', '1I3': 'GND', '1Y': 'LN+', '2I0': 'LINK-', '2I1': 'R0-', '2I2': 'R26-', '2I3': 'GND', '2Y': 'LN-' });
  c.add('U38', 'LVC157', { S: 'CW_LDQT', '/E': 'GND', '1I0': 'QT+', '1I1': mutant === 'QT_FROM_A1' ? 'A1+' : 'A0+', '1Y': 'QN+', '2I0': 'QT-', '2I1': 'A0-', '2Y': 'QN-', '3I0': 'GND', '3I1': 'GND', '4I0': 'GND', '4I1': 'GND' });
  // top-trit fill for right shifts by one: 0, carry out, or link
  c.add('U69', 'LVC153', { S0: 'CW_FILL0', S1: 'CW_FILL1', '1/E': 'GND', '2/E': 'GND',
    '1I0': 'GND', '1I1': mutant === 'FILL_LINK_FOR_CARRY' ? 'LINK+' : 'C9+', '1I2': 'LINK+', '1I3': 'GND', '1Y': 'FILL+', '2I0': 'GND', '2I1': 'C9-', '2I2': 'LINK-', '2I3': 'GND', '2Y': 'FILL-' });
  // --- shifter: 27 x 3253 (none, L1, R1, R9), 7 x 3245 (L9) ---
  for (let k = 0; k < 27; k++) { const oe = k < 5 ? 'CW_/SHOE_LO' : 'CW_/SHOE'; const pins = { S0: 'CW_SHS0', S1: 'CW_SHS1', '1/OE': oe, '2/OE': oe };
    for (const r of [0, 1]) { const h = r + 1;
      pins[`${h}B1`] = T(`R${k}`, mutant === 'RAILS_SWAPPED_R7' && k === 7 ? 1 - r : r); pins[`${h}B2`] = k > 0 ? T(`R${k - 1}`, r) : 'GND';
      pins[`${h}B3`] = k < 26 ? T(`R${k + 1}`, r) : T('FILL', r); pins[`${h}B4`] = k < 18 ? T(`R${k + 9}`, r) : 'GND'; pins[`${h}A`] = T(`S${k}`, r); }
    c.add(`U${70 + k}`, 'CBTLV3253', pins); }
  for (let j = 0; j < 7; j++) { const pins = { '/OE': 'CW_/L9OE' };
    for (let i = 1; i <= 8; i++) { const w = 8 * j + i - 1; if (w >= 54) { pins[`A${i}`] = 'GND'; continue; } const k = w >> 1, r = w & 1;
      pins[`A${i}`] = k >= 9 ? T(`R${k - (mutant === 'L9_IS_L8' ? 8 : 9)}`, r) : 'GND'; pins[`B${i}`] = T(`S${k}`, r); }
    c.add(`U${97 + j}`, 'CBTLV3245', pins); }
  // --- ESRV onto trits 0..4: shadow SF CF OF, PRIV, IE (2 x 3245); the rest of the word is 0 from the zero table page ---
  { const src = ['SSF+', 'SSF-', 'SCF+', 'SCF-', 'SOF+', 'SOF-', ...(mutant === 'ESRV_PRIV_IE_SWAPPED' ? ['IE', 'GND', 'PRIV', 'GND'] : ['PRIV', 'GND', 'IE', 'GND'])];
    for (let j = 0; j < 2; j++) { const pins = { '/OE': 'CW_/ESRV' };
      for (let i = 1; i <= 8; i++) { const w = 8 * j + i - 1; if (w >= 10) { pins[`A${i}`] = 'GND'; continue; } pins[`A${i}`] = src[w]; pins[`B${i}`] = T(`S${w >> 1}`, w & 1); }
      c.add(`U${120 + j}`, 'CBTLV3245', pins); } }
  // --- bus drivers: 7 x 245 ---
  for (let j = 0; j < 7; j++) { const pins = { DIR: 'VCC', '/OE': 'CW_/BUSOE' };
    for (let i = 1; i <= 8; i++) { const w = 8 * j + i - 1; if (w >= 54) { pins[`A${i}`] = 'GND'; continue; } const k = w >> 1, r = w & 1;
      pins[`A${i}`] = T(`S${k}`, r); pins[`B${i}`] = T(`D${k}`, r); }
    c.add(`U${104 + j}`, 'LVC245', pins); }
  // link and QT live in one half of an 18-bit register whose clock enable is ABORT (an aborted cycle holds them)
  { const pins = { '1/OE': 'GND', '1/CLKEN': 'ABORT', '1CLK': 'CLK', '1/CLR': 'VCC', '2/OE': 'VCC', '2/CLKEN': 'VCC', '2CLK': 'CLK', '2/CLR': 'VCC' };
    const d = ['LN+', 'LN-', 'QN+', 'QN-']; const q = ['LINK+', 'LINK-', 'QT+', 'QT-'];
    for (let i = 0; i < 9; i++) { pins[`1D${i}`] = d[i] || 'GND'; if (q[i]) pins[`1Q${i}`] = q[i]; pins[`2D${i}`] = 'GND'; }
    c.add('U111', 'ALVCH16823', pins); }
  // --- flags block ---
  for (let t = 0; t < 3; t++) { const pins = { '/CE': 'GND', '/OE': 'GND', '/WE': 'VCC', A18: 'GND' };
    for (let i = 0; i < 9; i++) for (const r of [0, 1]) pins[`A${2 * i + r}`] = T(`D${9 * t + i}`, r);
    pins.IO0 = `TS${t}+`; pins.IO1 = `TS${t}-`; c.add(`U${112 + t}`, 'IS61WV5128', pins, { mem: ft.sign }); }
  { const a = ['CW_FOP0', 'CW_FOP1', 'CW_FOP2', 'SF+', 'SF-', 'OF+', 'OF-', 'TS0+', 'TS0-', ...(mutant === 'SIGN_TRYTES_SWAPPED' ? ['TS2+', 'TS2-', 'TS1+', 'TS1-'] : ['TS1+', 'TS1-', 'TS2+', 'TS2-']), 'C9+', 'C9-', 'LN+', 'LN-', 'GND', 'GND'];
    const pins = { '/CE': 'GND', '/OE': 'GND', '/WE': 'VCC' }; a.forEach((n, i) => { pins[`A${i}`] = n; });
    ['TSF+', 'TSF-', 'TCF+', 'TCF-', 'TOF+', 'TOF-'].forEach((n, i) => { pins[`IO${i}`] = n; }); c.add('U115', 'IS61WV5128', pins, { mem: ft.flags }); }
  // final select: 0 = table, 1 = shadow (PSW ENTER), 2 = bus trits 0..2 (PSW RESTORE)
  [['SF', 0], ['CF', 1], ['OF', 2]].forEach(([f, k], j) => c.add(`U${116 + j}`, 'LVC153', { S0: 'CW_FSEL0', S1: 'CW_FSEL1', '1/E': 'GND', '2/E': 'GND',
    '1I0': `T${f}+`, '1I1': `S${f}+`, '1I2': `D${mutant === 'RESTORE_TRIT_SHIFT' ? k + 1 : k}+`, '1I3': 'GND', '1Y': `N${f}+`, '2I0': `T${f}-`, '2I1': `S${f}-`, '2I2': `D${k}-`, '2I3': 'GND', '2Y': `N${f}-` }));
  { const pins = { '1/OE': 'GND', '1/CLKEN': '/FL_LD', '1CLK': 'CLK', '1/CLR': 'VCC', '2/OE': 'GND', '2/CLKEN': mutant === 'SHADOW_EVERY_CYCLE' ? 'GND' : 'CW_/SH_CE', '2CLK': 'CLK', '2/CLR': 'VCC' };
    const fl = ['SF+', 'SF-', 'CF+', 'CF-', 'OF+', 'OF-'];
    for (let i = 0; i < 9; i++) { pins[`1D${i}`] = i < 6 ? 'N' + fl[i] : 'GND'; if (i < 6) pins[`1Q${i}`] = fl[i]; pins[`2D${i}`] = i < 6 ? fl[i] : 'GND'; if (i < 6) pins[`2Q${i}`] = 'S' + fl[i]; }
    c.add('U119', 'ALVCH16823', pins); }
  if (process.env.LOADPATH) require('./loadpath.js').addLoadPath(c, { worldLoad: { RESET: 1 } });   // COPY-ENGINE.md option B
  return c;
}

// the card's control word, decoded from a microword at ROM-generation time (no decode logic on the card)
const { ALU_FNS } = require('../microsim/microsim.js');
function cardWord(mu, addr = -1, fixed = {}) {
  const f = {}; const sh = mu.SHIFT || 'NONE';
  f['/A_CE'] = mu.LD_A ? 0 : 1; f['/B_CE'] = mu.LD_B ? 0 : 1;
  const fi = ALU_FNS.indexOf(mu.ALU_FN || 'ADD'); for (let i = 0; i < 4; i++) f[`FN${i}`] = (fi >> i) & 1;
  const neg = mu.B_NEG === 'QT' ? 2 : (mu.B_NEG === 1 || mu.B_NEG === '1') ? 1 : 0; f.NEG0 = neg & 1; f.NEG1 = neg >> 1;
  const cin = { '0': 0, CF: 1, ONE: 2, LINK: 3 }[mu.CIN || '0']; f.CIN0 = cin & 1; f.CIN1 = cin >> 1;
  f.BCAST = mu.B_BCAST ? 1 : 0;
  const sel = { NONE: 0, L1: 1, L1L: 1, R1: 2, R1C: 2, R1L: 2, R1O: 2, R9: 3 }[sh];
  if (sh === 'L3' || sh === 'R3') throw new Error('L3/R3 are not built (SHIFTER.md)');
  f['/SHOE'] = sh === 'L9' ? 1 : 0; f['/L9OE'] = sh === 'L9' ? 0 : 1; f.SHS0 = (sel || 0) & 1; f.SHS1 = (sel || 0) >> 1;
  const fill = { R1C: 1, R1L: 2 }[sh] || 0; f.FILL0 = fill & 1; f.FILL1 = fill >> 1;
  const link = { R1C: 1, R1L: 1, R1O: 1, L1L: 2 }[sh] || 0; f.LINK0 = link & 1; f.LINK1 = link >> 1;
  f.LDQT = mu.LD_QT ? 1 : 0; f.W9 = mu.WIDTH9 ? 1 : 0;
  const bus = mu.BUS || 'NONE';
  // an idle bus is driven only when a flag rule needs the result's sign (8 ARITH words with BUS = NONE); otherwise the
  // idle bus is left free, because the Memory card puts instruction trytes on it during fetch (LD_IR, BUS = NONE)
  f['/BUSOE'] = (bus === 'ALU' || bus === 'ESRV' || bus === 'ZERO' || (bus === 'NONE' && mu.FLAGS && mu.FLAGS !== 'KEEP')) ? 0 : 1;
  // BUS = ZERO: the ALU card drives 0 from the all-zero table page (no ZERO word uses the ALU result; checked)
  if (bus === 'ZERO') { for (let i = 0; i < 4; i++) f[`FN${i}`] = (11 >> i) & 1; f.SHS0 = f.SHS1 = 0; f['/SHOE'] = 0; f['/SHOE_LO'] = 0; f['/L9OE'] = 1; f.W9 = 0; }
  f['/SHOE_LO'] = f['/SHOE']; f['/ESRV'] = 1;
  if (bus === 'ESRV') { for (let i = 0; i < 4; i++) f[`FN${i}`] = (11 >> i) & 1; f.SHS0 = f.SHS1 = 0; f['/SHOE'] = 0; f['/SHOE_LO'] = 1; f['/ESRV'] = 0; f['/L9OE'] = 1; }
  const fop = require('./flag-tables.js').FOPS.indexOf(mu.FLAGS); const psw = mu.PSW || 'KEEP';
  for (let i = 0; i < 3; i++) f[`FOP${i}`] = ((fop < 0 ? 0 : fop) >> i) & 1;
  f['/FL_CE'] = (fop >= 0 || psw === 'ENTER' || psw === 'RESTORE') ? 0 : 1;
  const fsel = psw === 'ENTER' ? 1 : psw === 'RESTORE' ? 2 : 0; f.FSEL0 = fsel & 1; f.FSEL1 = fsel >> 1;
  f['/SH_CE'] = (addr === fixed.FETCH || addr === fixed.FETCH2 || mu.RETIRE) ? 0 : 1;   // RETIRE words (block-move steps) snapshot too; they keep flags, so old = new
  let w = 0; CW.forEach((n, i) => { w |= (f[n] | 0) << i; }); return w;
}
module.exports = { build, cardWord, CW };
