// registers-card.js: the Registers card, chip by chip (Kehai Interim, 2026-11-18). MIT.
// 32 slots x 27 trits of register RAM (R0..R8, SP, the register-RAM SPRs, temporaries) in 7 x 10 ns SRAM, addressed by
// RSLOT0..4 from the Control card; one bank of bidirectional 245s between the RAM and the backplane bus.
// Read: RF_RD and not SPRNR. Write: RF_WR and not SPRNR and not ABORT. (SPRNR: the Control card is handling a latch
// SPR; ABORT: the Memory card faulted the cycle.) The write strobe is the clock's second half in hardware.
'use strict';
const { Card } = require('./netlist.js');
const T = (k, r) => `${k}${r ? '-' : '+'}`;
const CW = ['/RD', '/WR'];
function build(csImage, mutant) {
  const c = new Card('Registers');
  c.input('CLK', 'RESET', 'ABORT', 'SPRNR', '/WSTB', ...[0, 1, 2, 3, 4].map(i => `RSLOT${i}`), ...[...Array(10).keys()].map(i => `UA${i}`));
  for (let k = 0; k < 27; k++) c.input(T(`D${k}`, 0), T(`D${k}`, 1));
  // own control store (2 bits used) + pipeline (574, outputs off in RESET) + pull-ups = "neither read nor write"
  { const pins = { '/CE': 'GND', '/OE': 'GND', '/WE': 'VCC', IO0: 'CSD0', IO1: 'CSD1' }; for (let i = 0; i < 19; i++) pins[`A${i}`] = i < 10 ? `UA${i}` : 'GND';
    c.add('U1', 'IS61WV5128', pins, { mem: csImage }); }
  c.add('U2', 'LVC574', { CLK: 'CLK', '/OE': 'RESET', D1: 'CSD0', D2: 'CSD1', D3: 'GND', D4: 'GND', D5: 'GND', D6: 'GND', D7: 'GND', D8: 'GND', Q1: 'CW_/RD', Q2: 'CW_/WR' });
  c.add('RN1', 'RPACK8', { P1: 'CW_/RD', P2: 'CW_/WR' });
  // enables: /RDE = /RD or SPRNR; /WRE = /WR or SPRNR or ABORT; transceivers on when either; DIR = reading
  c.add('U3', 'LVC32', { '1A': 'CW_/RD', '1B': mutant === 'SPRNR_IGNORED' ? 'GND' : 'SPRNR', '1Y': '/RDE', '2A': 'CW_/WR', '2B': mutant === 'SPRNR_IGNORED' ? 'GND' : 'SPRNR', '2Y': '/WRA',
    '3A': '/WRA', '3B': mutant === 'ABORT_IGNORED' ? 'GND' : 'ABORT', '3Y': '/WRE', '4A': '/WRE', '4B': '/WSTB', '4Y': '/WEP' });
  // /WEP (2026-11-20): the RAM's /WE is /WRE gated by the backplane write strobe (one slot, ending 25 ns before the CPU
  // edge), so the slot address (RSLOT, settled ~16 ns) and the data are still while it writes. Before, /WE was /WRE
  // itself: low across the CPU edge into the next word (integration/TIMING-GATE-LEVEL.md, finding 1).
  c.add('U4', 'LVC08', { '1A': '/RDE', '1B': '/WRE', '1Y': '/XOE', '2A': 'GND', '2B': 'GND', '3A': 'GND', '3B': 'GND', '4A': 'GND', '4B': 'GND' });
  c.add('U5', 'LVC04', { '1A': '/RDE', '1Y': 'XDIR' });
  // the RAM: 7 chips x 8 bits = 56 >= 54 wires
  for (let j = 0; j < 7; j++) { const pins = { '/CE': 'GND', '/OE': '/RDE', '/WE': '/WEP' };
    for (let i = 0; i < 19; i++) pins[`A${i}`] = i < 5 ? (mutant === 'SLOT_BITS_SWAPPED' && i < 2 ? `RSLOT${1 - i}` : `RSLOT${i}`) : 'GND';
    for (let i = 0; i < 8; i++) { const w = 8 * j + i; if (w < 54) pins[`IO${i}`] = T(`M${w >> 1}`, w & 1); }
    c.add(`U${10 + j}`, 'IS61WV5128', pins, { mem: Buffer.alloc(1 << 19) }); }
  // the transceivers: A = RAM side, B = bus
  for (let j = 0; j < 7; j++) { const pins = { DIR: 'XDIR', '/OE': '/XOE' };
    for (let i = 1; i <= 8; i++) { const w = 8 * j + i - 1; if (w >= 54) { pins[`A${i}`] = 'GND'; continue; } pins[`A${i}`] = T(`M${w >> 1}`, w & 1); pins[`B${i}`] = T(`D${w >> 1}`, w & 1); }
    c.add(`U${20 + j}`, 'LVC245', pins); }
  if (process.env.LOADPATH) require('./loadpath.js').addLoadPath(c, { worldLoad: { RESET: 1 } });   // COPY-ENGINE.md option B
  return c;
}
function cardWord(mu) { return (mu.RF_RD ? 0 : 1) | (mu.RF_WR ? 0 : 1) << 1; }
module.exports = { build, cardWord, CW };
