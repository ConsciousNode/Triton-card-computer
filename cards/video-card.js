// video-card.js: the Video card, stage 1 (CPU side), chip by chip (Kehai Interim, 2026-11-18). MIT.
// Ports 2-5 of iocard.js: OUT 2 / OUT 3 set the drawing position (X mod 729 / Y mod 486 in T3, mod 243 in T2), OUT 4
// writes a pixel there, OUT 5 fills the framebuffer with a colour (and remembers it), IN 2 / 3 / 4 / 5 read them back.
// The framebuffer itself is on the Memory card (VRAM-S), reached over connector J2: SA0..18 (address), SI0..11 (write
// data), /SWR (write), SO0..11 (read data, latched on the Memory card one slot after the address), VBUSY (a CPU write
// owns VRAM-S). The card runs on the 40 MHz slot clock (4 slots per 100 ns microcycle); CPU-facing registers load at
// the CPU edge (/CEDGE low in the last slot). Stage 2: scan-out (VGA timing tables, the fetch engine with priority
// over port/fill operations, ping-pong line buffers, palette table, DAC drive register, sync). See VIDEO-CARD.md.
'use strict';
const { Card } = require('./netlist.js');
const V = require('./video-tables.js');
const T = (k, r) => `${k}${r ? '-' : '+'}`;
const CW = ['/IN', '/OUT', '/BIO'];

function build(csImage, mutant) {
  const c = new Card('Video');
  c.input('SCLK', 'CLK', 'RESET', '/CEDGE', 'MODE', 'VBUSY', ...[...Array(10).keys()].map(i => `UA${i}`), ...[...Array(6).keys()].map(i => `PORT${i}`), ...[...Array(12).keys()].map(i => `SO${i}`));
  for (let k = 0; k < 27; k++) c.input(T(`D${k}`, 0), T(`D${k}`, 1));
  const sram = (ref, part, addr, data, mem) => { const na = part === 'IS61WV5128' ? 19 : 21, pins = { '/CE': 'GND', '/OE': 'GND', '/WE': 'VCC' };
    for (let i = 0; i < na; i++) pins[`A${i}`] = addr[i] || 'GND'; data.forEach((n, i) => { if (n) pins[`IO${i}`] = n; }); c.add(ref, part, pins, { mem }); };
  const reg18 = (ref, d, q, clken1, clken2 = clken1, oe = 'GND', clk = 'SCLK') => { const pins = {};
    for (const h of [1, 2]) Object.assign(pins, { [`${h}/OE`]: oe, [`${h}/CLKEN`]: h === 1 ? clken1 : clken2, [`${h}CLK`]: clk, [`${h}/CLR`]: 'VCC' });
    for (let i = 0; i < 18; i++) { const h = i < 9 ? 1 : 2, j = i % 9; pins[`${h}D${j}`] = d[i] || 'GND'; if (q[i]) pins[`${h}Q${j}`] = q[i]; } c.add(ref, 'ALVCH16823', pins); };
  const mux157 = (ref, s, i0, i1, y) => { const pins = { S: s, '/E': 'GND' }; for (let ch = 1; ch <= 4; ch++) { const k = ch - 1;
      Object.assign(pins, { [`${ch}I0`]: i0[k] || 'GND', [`${ch}I1`]: i1[k] || 'GND' }); if (y[k]) pins[`${ch}Y`] = y[k]; } c.add(ref, 'LVC157', pins); };
  const bits = (name, n) => [...Array(n).keys()].map(i => `${name}${i}`);
  const rails = (name, n) => { const w = []; for (let k = 0; k < n; k++) w.push(T(`${name}${k}`, 0), T(`${name}${k}`, 1)); return w; };
  // --- own control store (IN, OUT, BUS = IO), pipeline off in RESET, pull-ups = idle ---
  sram('U1', 'IS61WV5128', bits('UA', 10), ['CSD0', 'CSD1', 'CSD2'], csImage);
  // the pipeline register on the CPU clock, as on every other card (2026-11-21, found at integration: it was drawn on
  // SCLK, so it took the NEXT microword one slot after UA changed and strobed the ports a cycle early, while the bus was
  // empty; the card harnesses clocked U2 by hand at the CPU edge and so tested the intended design, not the drawing)
  reg18('U2', ['CSD0', 'CSD1', 'CSD2'], CW.map(n => `CW_${n}`), 'GND', 'GND', 'RESET', mutant === 'PIPE_ON_SCLK' ? 'SCLK' : 'CLK');
  c.add('RN1', 'RPACK8', { P1: 'CW_/IN', P2: 'CW_/OUT', P3: 'CW_/BIO' });
  // --- glue first (gates feed table addresses) ---
  c.add('U3', 'LVC04', { '1A': 'VBUSY', '1Y': 'FREE', '2A': 'R2', '2Y': '/R2', '3A': 'VSEL', '3Y': '/VSEL', '4A': 'FCNT', '4Y': '/FCE' });
  c.add('U4', 'LVC32', { '1A': 'CW_/BIO', '1B': '/VSEL', '1Y': '/BOE', '2A': '/SWRQ', '2B': 'RESET', '2Y': '/SWR', '3A': 'CNTADV', '3B': 'CNTRST', '3Y': 'FCNT', '4A': 'GND', '4B': 'GND' });
  c.add('U5', 'LVC08', { '1A': '/LDIO', '1B': mutant === 'IN4_NEVER_LOADS' ? 'VCC' : '/R2', '1Y': '/IOCE', '2A': T('D3', 0), '2B': 'MODE', '2Y': 'PV6', '3A': T('D3', 1), '3B': 'MODE', '3Y': 'PV7', '4A': T('D4', 0), '4B': 'MODE', '4Y': 'PV8' });
  c.add('U6', 'LVC08', { '1A': T('D4', 1), '1B': 'MODE', '1Y': 'PV9', '2A': T('D5', 0), '2B': 'MODE', '2Y': 'PV10', '3A': T('D5', 1), '3B': mutant === 'T2_PIXEL_NOT_MASKED' ? 'VCC' : 'MODE', '3Y': 'PV11', '4A': 'GND', '4B': 'GND' });
  // the pixel / colour value: trits 0..2 straight from the bus, trits 3..5 only in T3 (T2 pixels are 3 trits)
  const PV = [T('D0', 0), T('D0', 1), T('D1', 0), T('D1', 1), T('D2', 0), T('D2', 1), 'PV6', 'PV7', 'PV8', 'PV9', 'PV10', 'PV11'];
  // --- decode tables (CPU edge) and the sequencer ---
  sram('U7', 'IS61WV5128', [...bits('PORT', 6), 'CW_/IN', 'CW_/OUT', '/CEDGE'], ['/LDX', '/LDY', '/LDP', '/LDC', 'SETPW', 'SETFL', 'SETPR', '/LDIO'], V.pdTable());
  sram('U8', 'IS61WV5128', [...bits('PORT', 6), 'R2', 'CW_/IN', '/CEDGE'], ['SEL0', 'SEL1', 'VSELD', '/VSLD', 'YSEL'], V.pd2Table());
  sram('U9', 'IS61WV5128', ['SETPW', 'SETFL', 'SETPR', 'PW', 'PR', 'FL', 'FDONE', mutant === 'FETCH_LOSES_PRIORITY' ? 'FREE' : 'FREEOP', 'R1', 'R2', 'RESET'], ['NPW', 'NPR', 'NFL', '/SWRD', 'R1D', 'CNTADV', 'CNTRST', 'READY'], V.seqTable(mutant));
  c.add('U10', 'LVC574', { CLK: 'SCLK', '/OE': 'GND', D1: 'NPW', D2: 'NPR', D3: 'NFL', D4: '/SWRD', D5: 'R1D', D6: 'R1', D7: 'GND', D8: 'GND', Q1: 'PW', Q2: 'PR', Q3: 'FL', Q4: '/SWRQ', Q5: 'R1', Q6: 'R2' });
  // --- X, Y (and the BUS = IO select latch) from the coordinate-in table ---
  sram('U11', 'IS61WV20488', [...rails('D', 9), 'MODE', 'PORT0'], bits('CI', 8), V.ciTable(0, mutant));
  sram('U12', 'IS61WV20488', [...rails('D', 9), 'MODE', 'PORT0'], ['CI8', 'CI9'], V.ciTable(1, mutant));
  reg18('U13', bits('CI', 10), bits('X', 10), '/LDX');
  reg18('U14', [...bits('CI', 9), 'VSELD'], [...bits('Y', 9), 'VSEL'], '/LDY', '/VSLD');
  // --- pixel value (OUT 4) and fill colour (OUT 5) ---
  reg18('U15', PV, bits('PX', 12), '/LDP');
  reg18('U16', PV, bits('FC', 12), '/LDC');
  // --- fill counters ---
  reg18('U17', bits('FXN', 10), bits('FX', 10), '/FCE');
  reg18('U18', bits('FYN', 9), bits('FY', 9), '/FCE');
  sram('U19', 'IS61WV5128', [...bits('FX', 10), 'MODE', 'CNTRST'], bits('FXN', 8), V.fxnTable(0));
  sram('U20', 'IS61WV5128', [...bits('FX', 10), 'MODE', 'CNTRST'], ['FXN8', 'FXN9', 'WRAPX'], V.fxnTable(1));
  sram('U21', 'IS61WV5128', [...bits('FY', 9), 'MODE', 'WRAPX', 'CNTRST'], bits('FYN', 8), V.fynTable(0));
  sram('U22', 'IS61WV5128', [...bits('FY', 9), 'MODE', 'WRAPX', 'CNTRST'], ['FYN8', 'FDONE'], V.fynTable(1));
  // --- coordinates for J2: the drawing position, or the fill counters while filling ---
  const XY = [...bits('X', 10), ...bits('Y', 9)], FXY = [...bits('FX', 10), ...bits('FY', 9)], CO = bits('CO', 19);
  for (let q = 0; q < 5; q++) mux157(`U${23 + q}`, 'FL', XY.slice(4 * q, 4 * q + 4), FXY.slice(4 * q, 4 * q + 4), CO.slice(4 * q, 4 * q + 4));
  // --- pixel address table (MODE, X, Y -> the Memory card's VRAM address), then the SA register driving J2 ---
  // stage 2: the fetch engine takes the table in the slots it wins (screen coordinates, SCREEN = FNOW)
  const FCO = [...bits('FXC', 10), ...bits('PY', 9)], CO2 = bits('CQ', 19);
  for (let q = 0; q < 5; q++) mux157(`U${70 + q}`, 'FNOW', CO.slice(4 * q, 4 * q + 4), FCO.slice(4 * q, 4 * q + 4), CO2.slice(4 * q, 4 * q + 4));
  const pa = V.paTables(mutant);
  for (let k = 0; k < 3; k++) sram(`U${28 + k}`, 'IS61WV20488', [...CO2, 'MODE', 'FNOW'], bits('PA', 19).slice(8 * k, 8 * k + 8), pa[k]);
  reg18('U31', bits('PA', 18), bits('SA', 18), 'GND');
  reg18('U32', ['PA18'], ['SA18'], 'GND');
  // --- write data for J2: the pixel, or the fill colour while filling, registered with the address ---
  const SIN = bits('SIN', 12);
  for (let q = 0; q < 3; q++) mux157(`U${33 + q}`, 'FL', bits('PX', 12).slice(4 * q, 4 * q + 4), bits('FC', 12).slice(4 * q, 4 * q + 4), SIN.slice(4 * q, 4 * q + 4));
  reg18('U36', SIN, bits('SI', 12), 'GND');
  // --- the answer to IN: coordinate (X or Y, through the coordinate-out table), fill colour, or a pixel from J2 ---
  const CX = bits('CX', 10);
  for (let q = 0; q < 3; q++) mux157(`U${37 + q}`, 'YSEL', bits('X', 10).slice(4 * q, 4 * q + 4), [...bits('Y', 9), 'GND'].slice(4 * q, 4 * q + 4), CX.slice(4 * q, 4 * q + 4));
  for (let k = 0; k < 3; k++) sram(`U${40 + k}`, 'IS61WV5128', CX, bits('CT', 18).slice(8 * k, 8 * k + 8), V.ctTable(k));
  for (let i = 0; i < 9; i++) { const pins = { S0: 'SEL0', S1: 'SEL1', '1/E': 'GND', '2/E': 'GND' };
    for (const r of [0, 1]) { const h = r + 1, w = 2 * i + r; Object.assign(pins, { [`${h}I0`]: `CT${w}`, [`${h}I1`]: w < 12 ? `FC${w}` : 'GND', [`${h}I2`]: w < 12 ? `SO${w}` : 'GND', [`${h}I3`]: 'GND', [`${h}Y`]: `ION${w}` }); }
    c.add(`U${43 + i}`, 'LVC153', pins); }
  reg18('U52', bits('ION', 18), bits('IOD', 18), '/IOCE');
  // --- bus drivers: the answer on D0..8 (tryte 0), 0 on D9..26, while BUS = IO and this card was the one asked ---
  for (let j = 0; j < 7; j++) { const pins = { DIR: 'VCC', '/OE': '/BOE' };
    for (let i = 1; i <= 8; i++) { const w = 8 * j + i - 1; if (w >= 54) { pins[`A${i}`] = 'GND'; continue; } pins[`A${i}`] = w < 18 ? `IOD${w}` : 'GND'; pins[`B${i}`] = T(`D${w >> 1}`, w & 1); }
    c.add(`U${53 + j}`, 'LVC245', pins); }
  // ===== stage 2: scan-out =====
  // timing: HC (11 bits) and VC (10 bits) registers with next-count tables that also give the registered flags
  const ht = V.hTables(mutant), vt = V.vTables(mutant);
  reg18('U80', bits('HN', 11), bits('HC', 11), 'GND');
  for (let k = 0; k < 4; k++) sram(`U${81 + k}`, 'IS61WV5128', bits('HC', 11), [bits('HN', 8), ['HN8', 'HN9', 'HN10', 'HS', 'HPIC', 'LEND', 'XD8', 'XD9'], bits('XD', 8), ['FWIN']][k], ht[k]);
  reg18('U85', bits('VN', 10), bits('VC', 10), 'GND');
  for (let k = 0; k < 3; k++) sram(`U${86 + k}`, 'IS61WV5128', [...bits('VC', 10), 'LEND'], [bits('VN', 8), ['VN8', 'VN9', 'VS', 'VPIC', 'FLINE', 'DB', 'FB', 'PY8'], bits('PY', 8)][k], vt[k]);
  // the fetch counter (picture column of the next fetch) and its "more to fetch" flag, registered
  reg18('U89', [...bits('FXN', 10).map(n => 'F' + n), 'NFACT'], [...bits('FXC', 10), 'FACT'], 'GND');
  for (let k = 0; k < 2; k++) sram(`U${90 + k}`, 'IS61WV5128', [...bits('FXC', 10), 'LEND', 'FNOW'], k ? ['FFXN8', 'FFXN9', 'NFACT'] : bits('FFXN', 8), V.fxcTables(k));
  // FACTV = FACT & FLINE & FWIN; FNOW = FACTV & FREE (a fetch this slot); FREEOP = FREE & !FACTV (ports and fill only
  // get slots the fetch doesn't want)
  c.add('U92', 'LVC08', { '1A': 'FACT', '1B': 'FLINE', '1Y': 'FACT2', '2A': 'FACT2', '2B': 'FWIN', '2Y': 'FACTV', '3A': 'FACTV', '3B': 'FREE', '3Y': 'FNOW', '4A': 'FREE', '4B': '/FACTV', '4Y': 'FREEOP' });
  c.add('U93', 'LVC04', { '1A': 'FACTV', '1Y': '/FACTV', '2A': 'F2B', '2Y': '/F2B', '3A': 'WEA', '3Y': '/WEA', '4A': 'WEB', '4Y': '/WEB', '5A': 'ADB', '5Y': '/ADB' });
  // fetch pipeline: F1 = (column, bank, valid) at the issue edge, F2 a slot later, when SO carries the pixel
  reg18('U94', [...bits('FXC', 10), 'FB', 'FNOW'], [...bits('F1X', 10), 'F1B', 'F1V'], 'GND');
  reg18('U95', [...bits('F1X', 10), 'F1B', 'F1V'], [...bits('F2X', 10), 'F2B', 'F2V'], 'GND');
  c.add('U96', 'LVC08', { '1A': 'F2V', '1B': '/F2B', '1Y': 'WEA', '2A': 'F2V', '2B': 'F2B', '2Y': 'WEB', '3A': 'HPIC', '3B': 'VPIC', '3Y': 'PIC', '4A': 'GND', '4B': 'GND' });
  // display stage A: the picture column, display bank, picture flag and syncs, registered
  reg18('U98', [...bits('XD', 10), 'DB', 'PIC', 'HS', 'VS'], [...bits('AX', 10), 'ADB', 'APIC', 'AHS', 'AVS'], 'GND');
  // line buffers: bank A and bank B (IS61WV51216, 12 of 16 bits). The bank on display reads at AX; the other bank
  // is written at F2X from SO when F2 says so. Bank select of each chip's address: '157s on ADB.
  const LAA = bits('LAA', 10), LBA = bits('LBA', 10);
  for (let q = 0; q < 3; q++) { mux157(`U${100 + q}`, 'ADB', bits('AX', 10).slice(4 * q, 4 * q + 4), bits('F2X', 10).slice(4 * q, 4 * q + 4), LAA.slice(4 * q, 4 * q + 4));
    mux157(`U${103 + q}`, 'ADB', bits('F2X', 10).slice(4 * q, 4 * q + 4), bits('AX', 10).slice(4 * q, 4 * q + 4), LBA.slice(4 * q, 4 * q + 4)); }
  for (const [ref, ad, io, oe, we] of [['U106', LAA, 'LA', 'ADB', '/WEA'], ['U107', LBA, 'LB', '/ADB', '/WEB']]) {
    const pins = { '/CE': 'GND', '/OE': oe, '/WE': we, '/UB': 'GND', '/LB': 'GND' }; for (let i = 0; i < 19; i++) pins[`A${i}`] = ad[i] || 'GND'; for (let i = 0; i < 12; i++) pins[`IO${i}`] = `${io}${i}`;
    c.add(ref, 'IS61WV51216', pins, { mem: new Uint16Array(1 << 19) }); }
  const drvSO = (ref, to, oe) => { for (let j = 0; j < 2; j++) { const pins = { DIR: 'VCC', '/OE': oe }; for (let i = 1; i <= 8; i++) { const w = 8 * j + i - 1; if (w >= 12) { pins[`A${i}`] = 'GND'; continue; } pins[`A${i}`] = `SO${w}`; pins[`B${i}`] = `${to}${w}`; }
      c.add(`U${ref + j}`, 'LVC245', pins); } };
  drvSO(109, 'LA', '/WEA'); drvSO(111, 'LB', '/WEB');
  for (let q = 0; q < 3; q++) mux157(`U${113 + q}`, 'ADB', bits('LA', 12).slice(4 * q, 4 * q + 4), bits('LB', 12).slice(4 * q, 4 * q + 4), bits('LR', 12).slice(4 * q, 4 * q + 4));
  // display stage B: the pixel, registered with the picture flag and syncs
  reg18('U116', [...bits('LR', 12), 'APIC', 'AHS', 'AVS'], [...bits('BP', 12), 'BPIC', 'BHS', 'BVS'], 'GND');
  // palette table -> DAC drive (p_hi, !n_hi, p_lo, !n_lo per channel: B, G, R), stage C register drives the resistors
  const pt = V.palTables(mutant);
  sram('U117', 'IS61WV5128', [...bits('BP', 12), 'MODE', 'BPIC'], bits('PD', 8), pt[0]);
  sram('U118', 'IS61WV5128', [...bits('BP', 12), 'MODE', 'BPIC'], ['PD8', 'PD9', 'PD10', 'PD11'], pt[1]);
  reg18('U119', [...bits('PD', 12), 'BHS', 'BVS'], [...bits('DAC', 12), 'HSYNC', 'VSYNC'], 'GND');
  // READY onto the backplane's IORDY (2026-11-21, found at integration: the card-level harnesses let the CPU wait on
  // READY directly, so nothing ever stalled the real machine's CPU). IORDY is a wired-AND, pulled up on the I/O card
  // (RN4); every source of a stall drives it through an open-drain buffer. Mutant VID_NO_STALL: never pulls it low.
  c.add('U120', 'LVC1G07', { A: mutant === 'VID_NO_STALL' ? 'VCC' : 'READY', Y: 'IORDY' });
  if (process.env.LOADPATH) require('./loadpath.js').addLoadPath(c, { worldLoad: { RESET: 1 } });   // COPY-ENGINE.md option B
  return c;
}
function cardWord(mu) { return (mu.IO === 'IN' ? 0 : 1) | (mu.IO === 'OUT' ? 0 : 1) << 1 | (mu.BUS === 'IO' ? 0 : 1) << 2; }
module.exports = { build, cardWord, CW };
