// io-copy-engine.js: the I/O card's copy engine, a counter playing a flash image onto the backplane at power-up
// (Kehai Interim, 2026-11-19). MIT. See COPY-ENGINE.md.
// No program, no branching: a 32-bit counter (8 x '161) steps through the flash; a '138 decodes its low 4 bits (the
// phase); seven '16823 latches catch the entry's words; two flip-flops make the strobes. Each entry is 8 flash words
// (16 phases of ECLK):
//   phases 0..6  latch word k at the end of phase k (words 0..5 = the 96 engine lines, word 6 = flags, word 7 unused)
//   phases 7..13 the lines settle through the cards' resistors
//   phase 14     LOAD_WE high (flag WE) or LOAD_SEL1 high (flag SHIFT: clock the cards' select shift registers,
//                LOAD_SEL0 = flag SDATA)
//   phase 15     strobes low; if flag END, DONE sets: the counter stops, the latches let go of the backplane and
//                LOAD drops, so the CPU leaves reset
// Flash: two S70GL02GS (2 Gbit, 128M x 16 each). Word address = entry * 8 + (phase & 7); entry bit 24 picks the chip.
// /POR (power-on reset) clears the counter and the flip-flops.
'use strict';
const { Card } = require('./netlist.js');
const { LINES } = require('./loadpath.js');
const FLAGS = { WE: 0, SHIFT: 1, SDATA: 2, END: 3 };
function buildEngine(images, mutant) {
  const c = new Card('I/O copy engine'); c.input('ECLK', '/POR');
  // the counter: Q bits CQ0..CQ31 (CQ0..3 = phase, CQ4.. = entry)
  for (let k = 0; k < 8; k++) c.add(`CE_CNT${k}`, 'LVC161', { MR_N: '/POR', CP: 'ECLK', PE_N: 'VCC', CEP: '/DONE', CET: k ? `CTC${k - 1}` : '/DONE',
    D0: 'GND', D1: 'GND', D2: 'GND', D3: 'GND', Q0: `CQ${4 * k}`, Q1: `CQ${4 * k + 1}`, Q2: `CQ${4 * k + 2}`, Q3: `CQ${4 * k + 3}`, TC: `CTC${k}` });
  // flash: A0..2 = phase bits 0..2 (the word), A3..26 = entry bits 0..23; entry bit 24 (CQ28) picks the chip
  for (let f = 0; f < 2; f++) { const pins = { '/CE': f ? '/CQ28' : 'CQ28', '/OE': 'DONE' };
    for (let i = 0; i < 3; i++) pins[`A${i}`] = `CQ${i}`; for (let i = 3; i < 27; i++) pins[`A${i}`] = `CQ${i + 1}`;
    for (let i = 0; i < 16; i++) pins[`DQ${i}`] = `FD${i}`; c.add(`CE_FLASH${f}`, 'S70GL02GS', pins, { image: images[f] }); }
  c.add('CE_INV', 'LVC04', { '1A': 'CQ28', '1Y': '/CQ28', '2A': '/Y13', '2Y': 'P13', '3A': '/Y15', '3Y': 'P15', '4A': 'GND', '5A': 'GND', '6A': 'GND' });
  // phase decode: '138 #1 phases 0..7 (word latch enables), '138 #2 phases 8..15
  const lat = mutant === 'WORD_SWAP' ? [1, 0, 2, 3, 4, 5, 6] : [0, 1, 2, 3, 4, 5, 6];
  c.add('CE_DEC0', 'LVC138', { A: 'CQ0', B: 'CQ1', C: 'CQ2', G1: 'VCC', '/G2A': 'CQ3', '/G2B': 'DONE', ...Object.fromEntries(lat.map((w, k) => [`/Y${k}`, `/LE${w}`])) });
  const strobeAt = mutant === 'STROBE_EARLY' ? 3 : 13;   // the mutant strobes before the lines are all latched
  if (strobeAt === 13) c.add('CE_DEC1', 'LVC138', { A: 'CQ0', B: 'CQ1', C: 'CQ2', G1: 'CQ3', '/G2A': 'GND', '/G2B': 'GND', '/Y5': '/Y13', '/Y7': '/Y15' });
  else { c.add('CE_DEC1', 'LVC138', { A: 'CQ0', B: 'CQ1', C: 'CQ2', G1: 'CQ3', '/G2A': 'GND', '/G2B': 'GND', '/Y7': '/Y15' });
    c.add('CE_DEC2', 'LVC138', { A: 'CQ0', B: 'CQ1', C: 'CQ2', G1: 'VCC', '/G2A': 'CQ3', '/G2B': 'GND', '/Y3': '/Y13' }); }
  // the latches: word k -> chip CE_LATk (16 of 18 bits), /CLKEN = /LEk; the line latches let go when DONE (the flags
  // latch stays on: it's internal)
  for (let k = 0; k < 7; k++) { const pins = {};
    for (const h of [1, 2]) Object.assign(pins, { [`${h}/OE`]: k < 6 ? 'DONE' : 'GND', [`${h}/CLKEN`]: `/LE${k}`, [`${h}CLK`]: 'ECLK', [`${h}/CLR`]: 'VCC' });
    for (let i = 0; i < 18; i++) { const h = i < 9 ? 1 : 2, j = i % 9; if (i >= 16) { pins[`${h}D${j}`] = 'GND'; continue; } pins[`${h}D${j}`] = `FD${i}`;
      const line = k * 16 + i; pins[`${h}Q${j}`] = k < 6 ? (line < LINES.length ? LINES[line] : `ESPARE${line}`) : `FLAG${i}`; }
    c.add(`CE_LAT${k}`, 'ALVCH16823', pins); }
  // strobes and DONE
  c.add('CE_AND', 'LVC08', { '1A': `FLAG${FLAGS.WE}`, '1B': 'P13', '1Y': 'WE_D', '2A': `FLAG${FLAGS.SHIFT}`, '2B': 'P13', '2Y': 'SCK_D', '3A': `FLAG${FLAGS.END}`, '3B': 'P15', '3Y': 'END_NOW', '4A': 'GND', '4B': 'GND' });
  c.add('CE_OR', 'LVC32', { '1A': 'DONE', '1B': mutant === 'END_IGNORED' ? 'GND' : 'END_NOW', '1Y': 'DONE_D', '2A': 'GND', '2B': 'GND', '3A': 'GND', '3B': 'GND', '4A': 'GND', '4B': 'GND' });
  c.add('CE_FF0', 'LVC74', { '1D': 'WE_D', '1CLK': 'ECLK', '1/CLR': '/POR', '1/PRE': 'VCC', '1Q': 'LOAD_WE', '2D': 'SCK_D', '2CLK': 'ECLK', '2/CLR': '/POR', '2/PRE': 'VCC', '2Q': 'LOAD_SEL1' });
  c.add('CE_FF1', 'LVC74', { '1D': 'DONE_D', '1CLK': 'ECLK', '1/CLR': '/POR', '1/PRE': 'VCC', '1Q': 'DONE', '1/Q': '/DONE', '2CLK': 'GND', '2D': 'GND', '2/CLR': 'VCC', '2/PRE': 'VCC' });
  c.add('CE_BUF', 'LVC125', { '1A': `FLAG${FLAGS.SDATA}`, '1/OE': 'DONE', '1Y': 'LOAD_SEL0', '2A': '/DONE', '2/OE': 'GND', '2Y': 'LOAD' });
  return c;
}
// ---- the flash image generator ----
// entries: { lines: Uint8Array(96) } with flags. Words: 0..5 the lines, 6 the flags, 7 zero.
function encode(entries) { const imgs = [new Map(), new Map()]; const PER = 2 ** 24;
  entries.forEach((e, n) => { const f = n >= PER ? 1 : 0, base = (n % PER) * 8;
    for (let w = 0; w < 6; w++) { let v = 0; for (let b = 0; b < 16; b++) v |= (e.lines[w * 16 + b] | 0) << b; imgs[f].set(base + w, v); }
    imgs[f].set(base + 6, (e.we ? 1 : 0) | (e.shift ? 2 : 0) | (e.sdata ? 4 : 0) | (e.end ? 8 : 0)); imgs[f].set(base + 7, 0); });
  return imgs; }
module.exports = { buildEngine, encode, FLAGS };
