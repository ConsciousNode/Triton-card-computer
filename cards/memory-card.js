// memory-card.js: the Memory card, stage 1, chip by chip (Kehai Interim, 2026-11-18). MIT.
// Stage 1: MAR (load / +1 / load+1, ternary slice tables), MDR (3 trytes; lanes from the bus or from a RAM read),
// the address check (9 comparison chains + a fault table -> ABORT, FK, BADADDR, which framebuffer), FADDR, the
// UBASE/ULIMIT shadow registers (snooping the Registers card's writes), and the card's bus sources (MAR, MDR, MDR0,
// FADDR, and the fetched tryte during LD_IR reads).
// Stage 2: the RAM itself (MAR -> binary address in one level of tables, no carries; rows of 2M x 16 + 2M x 8 holding
// a tryte as 18 dual-rail bits), the framebuffer (VRAM-C for the CPU, VRAM-S as the scan-out copy behind the J2
// connector to the Video card), the write path (MDR lane -> RAM or VRAM, blocked by ABORT) and the read mux.
// See MEMORY-CARD.md, "Stage 2".
'use strict';
const { Card } = require('./netlist.js');
const M = require('./memory-tables.js');
const T = (k, r) => `${k}${r ? '-' : '+'}`, T_ = T;
const CW = ['MOP0', 'MOP1', 'MARC', 'MS0_0', 'MS0_1', 'MS1_0', 'MS1_1', 'MS2_0', 'MS2_1', 'MK0', 'MK1', 'BS0_0', 'BS0_1', 'BS1_0', 'BS1_1', 'BS2_0', 'BS2_1', '/MBUSOE', 'RFWR', '/MWR', 'WL0', 'WL1'];
const FB_BASE = 15000000, FB_SIZE = 354294;

function build(csImages, ramSize, slots, mutant) {
  const c = new Card('Memory');
  c.input('CLK', 'RESET', 'MODE', 'PRIV', 'PROTEN', 'SPRNR', '/WSTB', ...[0, 1, 2, 3, 4].map(i => `RSLOT${i}`), ...[...Array(10).keys()].map(i => `UA${i}`), ...[...Array(19).keys()].map(i => `SA${i}`), ...[...Array(12).keys()].map(i => `SI${i}`), '/SWR', 'SCLK');
  for (let k = 0; k < 27; k++) c.input(T(`D${k}`, 0), T(`D${k}`, 1));
  const sram = (ref, addr, data, mem) => { const pins = { '/CE': 'GND', '/OE': 'GND', '/WE': 'VCC' };
    for (let i = 0; i < 19; i++) pins[`A${i}`] = addr[i] || 'GND'; data.forEach((n, i) => { if (n) pins[`IO${i}`] = n; }); c.add(ref, 'IS61WV5128', pins, { mem }); };
  const reg18 = (ref, d, q, clken, oe = 'GND') => { const pins = {};
    for (const h of [1, 2]) Object.assign(pins, { [`${h}/OE`]: oe, [`${h}/CLKEN`]: clken, [`${h}CLK`]: 'CLK', [`${h}/CLR`]: 'VCC' });
    for (let i = 0; i < 18; i++) { const h = i < 9 ? 1 : 2, j = i % 9; pins[`${h}D${j}`] = d[i] || 'GND'; if (q[i]) pins[`${h}Q${j}`] = q[i]; } c.add(ref, 'ALVCH16823', pins); };
  const word = (name, from, to) => { const w = []; for (let k = from; k < to; k++) w.push(T(`${name}${k}`, 0), T(`${name}${k}`, 1)); return w; };
  // --- own control store, pipeline, pull-ups ---
  for (let j = 0; j < 3; j++) sram(`U${1 + j}`, [...Array(10).keys()].map(i => `UA${i}`), [...Array(8).keys()].map(i => `CSD${8 * j + i}`), csImages[j]);
  for (let j = 0; j < 2; j++) reg18(`U${4 + j}`, [...Array(18).keys()].map(i => 18 * j + i < CW.length ? `CSD${18 * j + i}` : null), [...Array(18).keys()].map(i => 18 * j + i < CW.length ? `CW_${CW[18 * j + i]}` : null), 'GND', 'RESET');
  for (let j = 0; j < 3; j++) { const pins = {}; for (let i = 1; i <= 8; i++) { const b = 8 * j + i - 1; if (b < CW.length) pins[`P${i}`] = `CW_${CW[b]}`; } c.add(`RN${1 + j}`, 'RPACK8', pins); }
  // --- MAR (stage 1b): 3 x 16823, clock enable = ABORT (hold on a fault); 9 slice tables whose carries come from a
  // lookahead table, so nothing ripples. A +1 carries out of a 3-trit slice only when that slice is +13 (all trits +1).
  for (let j = 0; j < 3; j++) reg18(`U${6 + j}`, word('MN', 9 * j, 9 * j + 9), word('MAR', 9 * j, 9 * j + 9), mutant === 'MAR_IGNORES_ABORT' ? 'GND' : 'ABORT');
  const and3 = (ref, gates) => { const pins = {}; gates.forEach(([a, b, cc, y], i) => Object.assign(pins, { [`${i + 1}A`]: a, [`${i + 1}B`]: b, [`${i + 1}C`]: cc, [`${i + 1}Y`]: y })); c.add(ref, 'LVC11', pins); };
  const pg = []; for (let s = 0; s < 8; s++) pg.push([`MAR${3 * s}+`, `MAR${3 * s + 1}+`, `MAR${3 * s + 2}+`, `PM${s}`]);
  for (let s = 0; s < 8; s++) pg.push([`D${3 * s}+`, `D${3 * s + 1}+`, `D${3 * s + 2}+`, `PB${s}`]);
  for (let j = 0; j < 6; j++) and3(`U${300 + j}`, pg.slice(3 * j, 3 * j + 3));
  for (let q = 0; q < 2; q++) { const pins = { S: 'CW_MOP1', '/E': 'GND' }; for (let ch = 1; ch <= 4; ch++) { const s = 4 * q + ch - 1; Object.assign(pins, { [`${ch}I0`]: `PM${s}`, [`${ch}I1`]: `PB${s}`, [`${ch}Y`]: `PS${s}` }); }
    c.add(`U${306 + q}`, 'LVC157', pins); }
  sram('U308', [...[...Array(8).keys()].map(s => `PS${s}`), 'CW_MARC'], [...Array(8).keys()].map(k => `MC${k + 1}`), M.marLook(mutant));
  const ms = M.marSlice2();
  for (let s = 0; s < 9; s++) sram(`U${10 + s}`, [...word('MAR', 3 * s, 3 * s + 3), ...word('D', 3 * s, 3 * s + 3), s === 0 ? 'CW_MARC' : `MC${s}`, 'CW_MOP0', 'CW_MOP1'], word('MN', 3 * s, 3 * s + 3), ms);
  // --- address check (stage 1b): every comparison is "a < X", slice signs in parallel, then one combine table ---
  const cmpS = M.cmpSlice(), cmpC = M.cmpCombine(); let ref = 20;
  const sl4 = (name, s) => { const w = word(name, 4 * s, Math.min(4 * s + 4, 27)); while (w.length < 8) w.push('GND'); return w; };
  const varCmp = (id, other, flag) => { for (let s = 0; s < 7; s++) sram(`U${ref++}`, [...sl4('MAR', s), ...sl4(other, s)], [`${id}s${s}+`, `${id}s${s}-`], cmpS);
    sram(`U${ref++}`, [...[...Array(7).keys()].flatMap(s => [`${id}s${s}+`, `${id}s${s}-`]), flag], [`N_${id}`], cmpC); };
  varCmp('V1', 'UB', 'GND'); varCmp('V2', 'UL', 'GND'); varCmp('V3', 'ULM', 'UL2UF');     // a < UBASE, a < ULIMIT, a + 2 < ULIMIT
  // constants n4..n9: a < 0, a < RAMSIZE, a + 2 < RAMSIZE, a < FB_BASE, a < FB_END, a + 2 < FB_END (the 2 folded in)
  const K = [0, mutant === 'RAMSIZE_OFF_BY_ONE' ? ramSize + 1 : ramSize, ramSize - 2, FB_BASE, FB_BASE + FB_SIZE, FB_BASE + FB_SIZE - 2];
  const kn = (j, k) => [`K${4 + j}_${k}+`, `K${4 + j}_${k}-`];
  M.CHUNKS.forEach(([lo, n], k) => { sram(`U${ref++}`, word('MAR', lo, lo + n), [0, 1, 2, 3].flatMap(j => kn(j, k)), M.constCmpChunk(k, K.slice(0, 4)));
    sram(`U${ref++}`, word('MAR', lo, lo + n), [4, 5].flatMap(j => kn(j, k)), M.constCmpChunk(k, K.slice(4))); });
  const cc = M.constCombine();
  for (let p = 0; p < 3; p++) sram(`U${ref++}`, [2 * p, 2 * p + 1].flatMap(j => [0, 1, 2, 3].flatMap(k => kn(j, k))), [`N_K${4 + 2 * p}`, `N_K${5 + 2 * p}`], cc);
  sram('U120', ['MODE', 'PRIV', 'PROTEN', 'CW_MK0', 'CW_MK1', 'N_V1', 'N_V2', mutant === 'CHK3_USES_SINGLE' ? 'N_V2' : 'N_V3', 'N_K4', 'N_K5', 'N_K6', 'N_K7', 'N_K8', 'N_K9'],
    ['ABORT', mutant === 'FK_INVERTED' ? 'FKX' : 'FK', 'ES0', 'ES1', 'BADADDR', 'INFB'], M.faultTable());
  if (mutant === 'FK_INVERTED') c.add('U121', 'LVC04', { '1A': 'FKX', '1Y': 'FK' });
  // --- UBASE / ULIMIT shadows, loaded when the Registers card writes those slots ---
  sram('U122', ['RSLOT0', 'RSLOT1', 'RSLOT2', 'RSLOT3', 'RSLOT4', 'CW_RFWR', 'SPRNR', 'ABORT'], ['/UBLD', '/ULLD'], M.snoopTable(slots.UBASE, mutant === 'SNOOP_WRONG_SLOT' ? slots.UBASE : slots.ULIMIT));
  for (let j = 0; j < 3; j++) { reg18(`U${123 + j}`, word('D', 9 * j, 9 * j + 9), word('UB', 9 * j, 9 * j + 9), '/UBLD'); reg18(`U${126 + j}`, word('D', 9 * j, 9 * j + 9), word('UL', 9 * j, 9 * j + 9), '/ULLD'); }
  // --- UL2 = ULIMIT - 2 (stage 1b), loaded with the ULIMIT shadow from the bus through a lookahead "minus 2":
  // N flags (slice s of D is -13) on 3 x 74LVC11, borrow lookahead table, 9 slice tables, 3 x 16823; the spare gate
  // makes the underflow flag (D - 2 below the 27-trit range: then "a + 2 < ULIMIT" is false for every a)
  { const g = []; for (let s = 1; s <= 8; s++) g.push([`D${3 * s}-`, `D${3 * s + 1}-`, `D${3 * s + 2}-`, `DN${s}`]); g.push(['DB8', 'DN8', 'VCC', 'UL2UFN']);
    for (let j = 0; j < 3; j++) and3(`U${310 + j}`, g.slice(3 * j, 3 * j + 3));
    sram('U313', [...word('D', 0, 3), ...[1, 2, 3, 4, 5, 6, 7].map(s => `DN${s}`)], [...Array(8).keys()].map(k => `DB${k + 1}`), M.dec2Look(mutant));
    const ds = M.dec2Slice(); for (let s = 0; s < 9; s++) sram(`U${314 + s}`, [...word('D', 3 * s, 3 * s + 3), s === 0 ? 'GND' : `DB${s}`, s === 0 ? 'VCC' : 'GND'], word('DM', 3 * s, 3 * s + 3), ds);
    for (let j = 0; j < 3; j++) reg18(`U${323 + j}`, word('DM', 9 * j, 9 * j + 9), word('ULM', 9 * j, 9 * j + 9), '/ULLD');
    reg18('U326', ['UL2UFN'], ['UL2UF'], '/ULLD'); }
  // --- FADDR: loads on a fault, from MAR / ULIMIT / RAMSIZE (wired constant) ---
  const rs = require('./control-tables.js').toT(ramSize, 27);
  for (let k = 0; k < 27; k++) { const pins = { S0: 'ES0', S1: 'ES1', '1/E': 'GND', '2/E': 'GND' };
    for (const r of [0, 1]) { const h = r + 1; const cb = r ? rs[k] === -1 : rs[k] === 1;
      Object.assign(pins, { [`${h}I0`]: T(`MAR${k}`, r), [`${h}I1`]: T(`UL${k}`, r), [`${h}I2`]: cb ? 'VCC' : 'GND', [`${h}I3`]: 'GND', [`${h}Y`]: T(`FN${k}`, r) }); }
    c.add(`U${130 + k}`, 'LVC153', pins); }
  c.add('U157', 'LVC04', { '1A': 'ABORT', '1Y': '/FALD' });
  for (let j = 0; j < 3; j++) reg18(`U${158 + j}`, word('FN', 9 * j, 9 * j + 9), word('FA', 9 * j, 9 * j + 9), '/FALD');
  // --- MDR: per tryte, hold / bus tryte k / bus tryte 0 / RAM read; holds on ABORT ---
  for (let t = 0; t < 3; t++) { for (let i = 0; i < 9; i++) { const k = 9 * t + i, pins = { S0: `CW_MS${t}_0`, S1: `CW_MS${t}_1`, '1/E': 'GND', '2/E': 'GND' };
      for (const r of [0, 1]) { const h = r + 1; Object.assign(pins, { [`${h}I0`]: T(`MDR${k}`, r), [`${h}I1`]: T(`D${k}`, r), [`${h}I2`]: T(`D${i}`, mutant === 'MDR_LANE_RAILS' && t === 1 && i === 0 ? 1 - r : r), [`${h}I3`]: `RD${2 * i + r}`, [`${h}Y`]: T(`MDN${k}`, r) }); }
      c.add(`U${161 + k}`, 'LVC153', pins); }
    reg18(`U${188 + t}`, word('MDN', 9 * t, 9 * t + 9), word('MDR', 9 * t, 9 * t + 9), 'ABORT'); }
  // --- bus sources: per tryte select MAR / MDR / FADDR / (tryte 0: the RAM read tryte, else 0), FET switches ---
  for (let k = 0; k < 27; k++) { const t = Math.floor(k / 9), pins = { S0: `CW_BS${t}_0`, S1: `CW_BS${t}_1`, '1/OE': 'GND', '2/OE': 'GND' };
    for (const r of [0, 1]) { const h = r + 1; Object.assign(pins, { [`${h}B1`]: T(`MAR${k}`, r), [`${h}B2`]: T(`MDR${k}`, r), [`${h}B3`]: T(`FA${k}`, r), [`${h}B4`]: k < 9 ? `RD${2 * k + r}` : 'GND', [`${h}A`]: T(`MB${k}`, r) }); }
    c.add(`U${191 + k}`, 'CBTLV3253', pins); }
  for (let j = 0; j < 7; j++) { const pins = { DIR: 'VCC', '/OE': 'CW_/MBUSOE' };
    for (let i = 1; i <= 8; i++) { const w = 8 * j + i - 1; if (w >= 54) { pins[`A${i}`] = 'GND'; continue; } pins[`A${i}`] = T(`MB${w >> 1}`, w & 1); pins[`B${i}`] = T(`D${w >> 1}`, w & 1); }
    c.add(`U${218 + j}`, 'LVC245', pins); }
  // ===== stage 2 =====
  // --- address conversion: 5 tables, all reading MAR directly (one 10 ns level) ---
  // (the glue inverter is listed first so MODEN exists before the chunk-1 tables pick their /OE)
  c.add('U235', 'LVC04', { '1A': 'CW_/MWR', '1Y': 'MWRH', '2A': '/VWE', '2Y': 'VWEH', '3A': 'FBSEL', '3Y': 'FBN', '4A': 'MODE', '4Y': 'MODEN', '5A': '/SWR', '5Y': 'SWRH' });
  const cvt = (ref, addr, data, mem) => sram(ref, addr, data, mem);
  const A = i => `RA${i}`;
  cvt('U230', word('MAR', 0, 5), [0, 1, 2, 3, 4, 5, 6, 7].map(A), M.cv0());
  { const t3in = mutant === 'CHUNK_OFF_BY_ONE' ? word('MAR', 4, 9) : word('MAR', 5, 10);
    const pins = { '/CE': 'GND', '/OE': 'MODEN', '/WE': 'VCC' }; for (let i = 0; i < 19; i++) pins[`A${i}`] = t3in[i] || 'GND';
    for (let i = 0; i < 8; i++) pins[`IO${i}`] = A(8 + i); c.add('U231', 'IS61WV5128', pins, { mem: M.cv1t3() });
    const pins2 = { '/CE': 'GND', '/OE': 'MODE', '/WE': 'VCC' }; const t2in = word('MAR', 0, 9); for (let i = 0; i < 19; i++) pins2[`A${i}`] = t2in[i] || 'GND';
    for (let i = 0; i < 8; i++) pins2[`IO${i}`] = A(8 + i); c.add('U232', 'IS61WV5128', pins2, { mem: M.cv1t2(mutant) }); }
  cvt('U233', [...word('MAR', 10, 16), 'MODE'], [16, 17, 18, 19, 20].map(A).concat(['FBSEL']), M.cv2a());
  cvt('U234', [...word('MAR', 10, 16), 'MODE'], [...Array(8).keys()].map(r => `/CE${r}`), M.cv2b());
  // --- glue: /RWE = /MWR | ABORT | FBSEL; /VWE = /MWR | ABORT | !FBSEL (OR CLK in hardware: the second half of the cycle)
  // J2 writes (the Video card's ports 4/5: a pixel, or its fill counter) reach both VRAM copies: /VXWE = /VWE AND /SWR
  c.add('U286', 'LVC08', { '1A': '/VWE', '1B': mutant === 'J2_WRITE_ONE_COPY' ? 'VCC' : '/SWR', '1Y': '/VXWE', '2A': '/VWE', '2B': '/SWR', '2Y': '/VSWE', '3A': 'GND', '3B': 'GND', '4A': 'GND', '4B': 'GND' });
  c.add('U287', 'LVC32', { '1A': 'MWRH', '1B': 'SWRH', '1Y': 'VCOE', '2A': 'VWEH', '2B': 'SWRH', '2Y': 'VSOE', '3A': 'GND', '3B': 'GND', '4A': 'GND', '4B': 'GND' });
  // /WAS (2026-11-20): main RAM's write is /WA gated by the backplane write strobe (one slot, ending 25 ns before the
  // CPU edge; integration/TIMING-GATE-LEVEL.md finding 1). The framebuffer path (/VWE, VBUSY on J2) keeps the unstrobed
  // /WA for now: the Video card's protocol reads VBUSY a slot ahead, and that timing is still to be drawn (open item).
  c.add('U236', 'LVC32', { '1A': 'CW_/MWR', '1B': mutant === 'WRITE_NOT_BLOCKED' ? 'GND' : 'ABORT', '1Y': '/WA', '2A': '/WAS', '2B': 'FBSEL', '2Y': '/RWE',
    '3A': '/WA', '3B': 'FBN', '3Y': '/VWE', '4A': '/WA', '4B': '/WSTB', '4Y': '/WAS' });
  // --- RAM rows: 2M x 16 (rails 0..15) + 2M x 8 (rails 16..17), sharing RA0..20 and the RAMD bus; /CE from the top table
  const toT = require('./control-tables.js').toT; const tt = toT(ramSize - 1, 27); let Tmax = 0; for (let i = 15; i >= 10; i--) Tmax = 3 * Tmax + tt[i];
  const rows = (Tmax >> 5) + 1;
  for (let r = 0; r < rows; r++) {
    const pw = { '/CE': `/CE${r}`, '/OE': 'MWRH', '/WE': '/RWE', '/UB': 'GND', '/LB': 'GND' }, pn = { '/CE': `/CE${r}`, '/OE': 'MWRH', '/WE': '/RWE' };
    for (let i = 0; i < 21; i++) { pw[`A${i}`] = A(i); pn[`A${i}`] = A(i); }
    for (let i = 0; i < 16; i++) pw[`IO${i}`] = `RAMD${i}`; pn.IO0 = 'RAMD16'; pn.IO1 = 'RAMD17';
    c.add(`U${240 + 2 * r}`, 'IS61WV204816', pw, { mem: new Uint16Array(1 << 21) }); c.add(`U${241 + 2 * r}`, 'IS61WV20488', pn, { mem: new Uint8Array(1 << 21) }); }
  // RAMD pull-downs: with no row selected (a faulting address, or a framebuffer access) the bus reads as trit 0, never
  // floating CMOS inputs or the illegal "both rails high"
  for (let j = 0; j < 3; j++) { const pins = {}; for (let i = 1; i <= 8; i++) { const b = 8 * j + i - 1; if (b < 18) pins[`P${i}`] = `RAMD${b}`; } c.add(`RN${4 + j}`, 'RPACK8G', pins); }
  // --- framebuffer: VRAM-C (CPU side) and VRAM-S (scan-out copy, J2); a pixel is 6 trits = 12 rails
  const NV = mutant === 'VRAM_NOT_TRUNCATED' ? 14 : 12;
  { const pc = { '/CE': 'GND', '/OE': 'VCOE', '/WE': '/VXWE', '/UB': 'GND', '/LB': 'GND' }, ps = { '/CE': 'GND', '/OE': 'VSOE', '/WE': '/VSWE', '/UB': 'GND', '/LB': 'GND' };
    for (let i = 0; i < 19; i++) { pc[`A${i}`] = `VCA${i}`; ps[`A${i}`] = `VSA${i}`; } for (let i = 0; i < NV; i++) { pc[`IO${i}`] = `VD${i}`; ps[`IO${i}`] = `SD${i}`; }
    c.add('U256', 'IS61WV51216', pc, { mem: new Uint16Array(1 << 19) }); c.add('U257', 'IS61WV51216', ps, { mem: new Uint16Array(1 << 19) }); }
  // VRAM-S address: the Video card's SA0..18, except while a CPU framebuffer write owns the chip (VWEH = VBUSY on J2)
  // (74CBTLV3257 FET switches: J2 runs 25 ns slots, and a '157 here would push the read path past one slot)
  for (let q = 0; q < 5; q++) { const pins = { S: mutant === 'SCAN_MUX_INVERTED' ? '/VWE' : 'VWEH', '/OE': 'GND' };
    for (let ch = 1; ch <= 4; ch++) { const i = 4 * q + ch - 1; if (i < 19) Object.assign(pins, { [`${ch}B1`]: `SA${i}`, [`${ch}B2`]: A(i), [`${ch}A`]: `VSA${i}` }); }
    c.add(`U${258 + q}`, 'CBTLV3257', pins); }
  // VRAM-C address: the CPU's RA0..18, except during a J2 write (SA0..18)
  for (let q = 0; q < 5; q++) { const pins = { S: 'SWRH', '/E': 'GND' };
    for (let ch = 1; ch <= 4; ch++) { const i = 4 * q + ch - 1; if (i < 19) Object.assign(pins, { [`${ch}I0`]: A(i), [`${ch}I1`]: `SA${i}`, [`${ch}Y`]: `VCA${i}` }); else Object.assign(pins, { [`${ch}I0`]: 'GND', [`${ch}I1`]: 'GND' }); }
    c.add(`U${288 + q}`, 'LVC157', pins); }
  // --- read mux: RD = FBSEL ? (VRAM-C pixel, upper 3 trits 0) : RAMD
  for (let q = 0; q < 5; q++) { const pins = { S: mutant === 'FB_STEER_INVERTED' ? 'FBN' : 'FBSEL', '/E': 'GND' };
    for (let ch = 1; ch <= 4; ch++) { const j = 4 * q + ch - 1; if (j < 18) Object.assign(pins, { [`${ch}I0`]: `RAMD${j}`, [`${ch}I1`]: j < NV ? `VD${j}` : 'GND', [`${ch}Y`]: `RD${j}` }); else Object.assign(pins, { [`${ch}I0`]: 'GND', [`${ch}I1`]: 'GND' }); }
    c.add(`U${263 + q}`, 'LVC157', pins); }
  // --- write data: MDR tryte WL (0..2), one 153 per trit (both rails)
  for (let i = 0; i < 9; i++) { const pins = { S0: 'CW_WL0', S1: 'CW_WL1', '1/E': 'GND', '2/E': 'GND' };
    for (const r of [0, 1]) { const h = r + 1; Object.assign(pins, { [`${h}I0`]: T_(`MDR${i}`, r), [`${h}I1`]: T_(`MDR${9 + i}`, r), [`${h}I2`]: T_(`MDR${18 + i}`, r), [`${h}I3`]: 'GND', [`${h}Y`]: `WD${2 * i + r}` }); }
    c.add(`U${268 + i}`, 'LVC153', pins); }
  // --- write drivers: WD -> RAMD (any write), WD -> VD (any write), WD -> SD (framebuffer write only)
  const drv = (ref, n, from, to, oe) => { for (let j = 0; j * 8 < n; j++) { const pins = { DIR: 'VCC', '/OE': oe };
      for (let i = 1; i <= 8; i++) { const w = 8 * j + i - 1; if (w >= n) { pins[`A${i}`] = 'GND'; continue; } pins[`A${i}`] = `${from}${w}`; pins[`B${i}`] = `${to}${w}`; }
      c.add(`U${ref + j}`, 'LVC245', pins); } };
  drv(277, 18, 'WD', 'RAMD', 'CW_/MWR'); drv(280, NV, 'WD', 'VD', 'CW_/MWR'); drv(282, NV, 'WD', 'SD', '/VWE');
  // --- J2 read data: VRAM-S's output latched by the slot clock (SCLK, 40 MHz, from the Video card over J2) into
  // 2 x 74LVC574 driving SO0..11: a pixel read is SA in one slot, SO valid the next. VBUSY = VWEH.
  for (let j = 0; j < 2; j++) { const pins = { CLK: 'SCLK', '/OE': 'GND' }; for (let i = 1; i <= 8; i++) { const w = 8 * j + i - 1; pins[`D${i}`] = w < 12 ? `SD${w}` : 'GND'; if (w < 12) pins[`Q${i}`] = `SO${w}`; }
    c.add(`U${284 + j}`, 'LVC574', pins); }
  // --- J2 write data: SI -> VD and SI -> SD while /SWR
  drv(293, 12, 'SI', 'VD', '/SWR'); drv(295, 12, 'SI', 'SD', '/SWR');
  if (process.env.LOADPATH) require('./loadpath.js').addLoadPath(c, { worldLoad: { RESET: 1 } });   // COPY-ENGINE.md option B
  return c;
}
function cardWord(mu) {
  const f = {}; const lane = mu.MDR_LANE === undefined ? 0 : (mu.MDR_LANE === 'ALL' ? -1 : +mu.MDR_LANE);
  const mop = mu.LD_MAR ? (mu.MAR_INC ? 3 : 2) : (mu.MAR_INC ? 1 : 0); f.MOP0 = mop & 1; f.MOP1 = mop >> 1; f.MARC = mu.MAR_INC ? 1 : 0;
  for (let t = 0; t < 3; t++) { let s = 0;
    if (mu.MEM === 'RD' && !mu.LD_IR && lane === t) s = 3;
    if (mu.LD_MDR) { if (lane === -1) s = 1; else if (lane === t) s = t === 0 ? 1 : 2; }
    f[`MS${t}_0`] = s & 1; f[`MS${t}_1`] = s >> 1; }
  const mk = (mu.MEM === 'RD' || mu.MEM === 'WR') ? 1 : mu.MEM === 'CHK3' ? 2 : 0; f.MK0 = mk & 1; f.MK1 = mk >> 1;
  const irRead = mu.MEM === 'RD' && mu.LD_IR;
  const src = irRead ? [3, 3, 3] : { MAR: [0, 0, 0], MDR: [1, 1, 1], MDR0: [1, 3, 3], FADDR: [2, 2, 2] }[mu.BUS] || [0, 0, 0];
  for (let t = 0; t < 3; t++) { f[`BS${t}_0`] = src[t] & 1; f[`BS${t}_1`] = src[t] >> 1; }
  f['/MBUSOE'] = (irRead || ['MAR', 'MDR', 'MDR0', 'FADDR'].includes(mu.BUS)) ? 0 : 1; f.RFWR = mu.RF_WR ? 1 : 0;
  f['/MWR'] = mu.MEM === 'WR' ? 0 : 1; if (mu.MEM === 'WR') { f.WL0 = lane & 1; f.WL1 = lane >> 1; }
  let w = 0; CW.forEach((n, i) => { if (f[n]) w |= 1 << i; }); return w;
}
module.exports = { build, cardWord, CW, FB_BASE, FB_SIZE, rowsFor: ramSize => { const t = require('./control-tables.js').toT(ramSize - 1, 27); let x = 0; for (let i = 15; i >= 10; i--) x = 3 * x + t[i]; return (x >> 5) + 1; } };
