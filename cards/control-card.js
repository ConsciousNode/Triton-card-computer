// control-card.js: the Control card, stage 1, chip by chip (Kehai Interim, 2026-11-18). MIT.
// Stage 1 = the sequencer and everything it needs: micro-address register, next-address select (a table decides,
// muxes carry it out), condition table, dispatch tables, IR + decode, register-slot and port tables, the ternary PC
// (9 slice tables), the micro-counter, and Control's bus sources (PC, IMM, CONST, OPC).
// Stage 2: the status latches (MODE PRIV IE PROT_EN TRAP_DIV0 IMASK IPEND) in one 18-bit register, their next-state
// tables, bus mod-32 / nonzero tables for SPR writes, interrupt priority and pending (now and at the coming boundary),
// SPR reads onto the bus, and SPRNR: the line that tells the Registers card to stand aside for a latch SPR.
'use strict';
const { Card } = require('./netlist.js');
const T = (k, r) => `${k}${r ? '-' : '+'}`;
const CW = ['SQ0', 'SQ1', 'SQ2', 'CFETCH', 'RET', 'CD0', 'CD1', 'CD2', 'CD3', ...[...Array(14).keys()].map(i => `C${i}`),
  'SLS0', 'SLS1', ...[...Array(5).keys()].map(i => `FS${i}`), 'RSK0', 'RSK1', '/IR0CE', '/IR1CE', 'PCOP0', 'PCOP1', 'PCC+', 'PCC-',
  'UOP0', 'UOP1', 'BS0', 'BS1', '/CBUSOE', '/UPEN', 'SPRWR', 'SPR', 'RFBUS', 'PSW0', 'PSW1', 'ACK', 'BT0', 'BT1'];
const TBL = require('./control-tables.js');

function build(romsDir, csImages, mutant) {
  const c = new Card('Control');
  c.input('CLK', 'RESET', 'ABORT', 'FK', 'SF+', 'SF-', 'QT+', 'QT-', 'BTOPNZ', 'BADADDR', 'IORDY', 'IRQSET0', 'IRQSET1', 'IRQSET2', 'IRQSET3', 'IRQSET4');
  for (let k = 0; k < 27; k++) c.input(T(`D${k}`, 0), T(`D${k}`, 1));
  const sram = (ref, addr, data, mem) => { const pins = { '/CE': 'GND', '/OE': 'GND', '/WE': 'VCC' };
    for (let i = 0; i < 19; i++) pins[`A${i}`] = addr[i] || 'GND'; data.forEach((n, i) => { if (n) pins[`IO${i}`] = n; }); c.add(ref, 'IS61WV5128', pins, { mem }); };
  const nCS = Math.ceil(CW.length / 8), nPipe = Math.ceil(CW.length / 18);
  // --- own control store + pipeline register (outputs off in RESET, pulled to safe values) ---
  for (let j = 0; j < nCS; j++) sram(`U${1 + j}`, [...Array(10).keys()].map(i => `UA${i}`), [...Array(8).keys()].map(i => `CSD${8 * j + i}`), csImages[j]);
  for (let j = 0; j < nPipe; j++) { const pins = {}; for (const h of [1, 2]) { Object.assign(pins, { [`${h}/OE`]: 'RESET', [`${h}/CLKEN`]: 'GND', [`${h}CLK`]: 'CLK', [`${h}/CLR`]: 'VCC' });
      for (let i = 0; i < 9; i++) { const b = 18 * j + 9 * (h - 1) + i; if (b < CW.length) { pins[`${h}D${i}`] = `CSD${b}`; pins[`${h}Q${i}`] = `CW_${CW[b]}`; } else pins[`${h}D${i}`] = 'GND'; } }
    c.add(`U${10 + j}`, 'ALVCH16823', pins); }
  for (let j = 0; j < nCS; j++) { const pins = {}; for (let i = 1; i <= 8; i++) { const b = 8 * j + i - 1; if (b < CW.length) pins[`P${i}`] = `CW_${CW[b]}`; } c.add(`RN${1 + j}`, 'RPACK8', pins); }
  // --- micro-address register (2 x 574) ---
  // Integration stage 2 (2026-11-20): the backplane UA is the NEXT address (NA, through U105/U106 '244 buffers that let go in
  // LOAD), so every card's pipeline register latches the word the µPC is moving to at the same CPU edge. Before, UA was
  // the µPC register's output: with one clock edge that's a three-stage loop (µPC -> store -> pipeline) and every taken
  // branch ran one extra word (a delay slot the microsim doesn't have; each card test hid it by clocking its pipeline
  // mid-cycle or comparing a cycle behind). The µPC register now keeps the executing word's address (UPC) for the
  // incrementer only. Mutant UA_IS_UPC restores the old wiring.
  const oldUA = mutant === 'UA_IS_UPC';
  for (let j = 0; j < 2; j++) { const pins = { CLK: 'CLK', '/OE': 'GND' };
    for (let i = 1; i <= 8; i++) { const b = 8 * j + i - 1; pins[`D${i}`] = b < 10 ? `NA${b}` : 'GND'; if (b < 10) pins[`Q${i}`] = oldUA ? `UA${b}` : `UPC${b}`; }
    c.add(`U${14 + j}`, 'LVC574', pins); }
  if (!oldUA) for (let j = 0; j < 2; j++) { const pins = { '1/OE': 'GND', '2/OE': 'GND' };
    for (let k = 0; k < 8; k++) { const b = 8 * j + k, h = k < 4 ? 1 : 2, i = k % 4 + 1; if (b < 10) { pins[`${h}A${i}`] = `NA${b}`; pins[`${h}Y${i}`] = `UA${b}`; } else pins[`${h}A${i}`] = 'GND'; }
    c.add(`U${105 + j}`, 'LVC244', pins); }
  // --- IR: two trytes from bus trits 0..8 (2 x 16823, one per tryte), loads gated by ABORT ---
  c.add('U16', 'LVC32', { '1A': 'CW_/IR0CE', '1B': 'ABORT', '1Y': '/IR0LD', '2A': 'CW_/IR1CE', '2B': 'ABORT', '2Y': '/IR1LD', '3A': 'GND', '3B': 'GND', '4A': 'GND', '4B': 'GND' });
  for (const t of [0, 1]) { const pins = {};
    for (const h of [1, 2]) { Object.assign(pins, { [`${h}/OE`]: 'GND', [`${h}/CLKEN`]: `/IR${t}LD`, [`${h}CLK`]: 'CLK', [`${h}/CLR`]: 'VCC' });
      for (let i = 0; i < 9; i++) { const w = 9 * (h - 1) + i, k = w >> 1, r = w & 1; pins[`${h}D${i}`] = T(`D${k}`, r); pins[`${h}Q${i}`] = T(`IR${t}_${k}`, r); } }
    c.add(`U${17 + t}`, 'ALVCH16823', pins); }
  const IR = (t, k, r) => T(`IR${t}_${k}`, r);
  // --- micro-counter: register (574) + next-state table + load-value table ---
  c.add('U19', 'LVC574', { CLK: 'CLK', '/OE': 'GND', D1: 'UN0', D2: 'UN1', D3: 'UN2', D4: 'UN3', D5: 'UN4', D6: 'UN5', D7: 'UNZ', D8: 'GND',
    Q1: 'U0', Q2: 'U1', Q3: 'U2', Q4: 'U3', Q5: 'U4', Q6: 'U5', Q7: 'UCZ' });
  // --- PC register: 3 x 16823, always clocked (the slice tables hold, count, load and wrap) ---
  for (let j = 0; j < 3; j++) { const pins = {};
    for (const h of [1, 2]) { Object.assign(pins, { [`${h}/OE`]: 'GND', [`${h}/CLKEN`]: 'GND', [`${h}CLK`]: 'CLK', [`${h}/CLR`]: 'VCC' });
      for (let i = 0; i < 9; i++) { const w = 18 * j + 9 * (h - 1) + i, k = w >> 1, r = w & 1; pins[`${h}D${i}`] = T(`PN${k}`, r); pins[`${h}Q${i}`] = T(`PC${k}`, r); } }
    c.add(`U${20 + j}`, 'ALVCH16823', pins); }
  // --- decode tables on the IR ---
  const ir0 = k => [IR(0, k, 0), IR(0, k, 1)], ir1 = k => [IR(1, k, 0), IR(1, k, 1)];
  sram('U23', ['CW_RSK0', 'CW_RSK1', ...ir0(0), ...ir0(1), ...ir0(2), ...ir0(3), ...ir1(0), ...ir1(1)], ['DS0', 'DS1', 'DS2', 'DS3', 'DS4', 'ALIAS'], TBL.diadTable());
  const imm = [...Array(9).keys()].flatMap(k => ir1(k));
  sram('U24', imm, ['SS0', 'SS1', 'SS2', 'SS3', 'SS4', 'ISREG', 'ISLATCH'], TBL.sprTable());
  sram('U25', imm, ['PORT0', 'PORT1', 'PORT2', 'PORT3', 'PORT4', 'PORT5'], TBL.portTable());
  const op = [4, 5, 6, 7, 8].flatMap(k => ir0(k));
  const [dlo, dhi] = TBL.dispatchTables(romsDir);
  sram('U26', [...op, 'MODE'], [...Array(8).keys()].map(i => `DP${i}`), dlo);
  sram('U27', [...op, 'MODE'], ['DP8', 'DP9'], dhi);
  // --- condition table ---
  sram('U28', ['CW_CD0', 'CW_CD1', 'CW_CD2', 'CW_CD3', 'SF+', 'SF-', 'QT+', 'QT-', 'BTOPNZ', 'UCZ', 'IRQP', 'PRIV', 'MODE', 'TRAPDIV0', 'BADADDR', 'ALIAS'], ['COND'], TBL.condTable());
  // --- next-address table + incrementer + muxes ---
  sram('U29', ['CW_SQ0', 'CW_SQ1', 'CW_SQ2', mutant === 'COND_IGNORED' ? 'GND' : 'COND', 'ABORT', 'FK', 'CW_RET', 'CW_CFETCH', mutant === 'NO_REDIRECT' ? 'GND' : 'IRQN', 'IORDY'], ['MS0', 'MS1', 'FX0', 'FX1', 'HOLD', 'HALTED'], TBL.naTable());
  const [ilo, ihi] = TBL.incTables();
  const ua = [...Array(10).keys()].map(i => oldUA ? `UA${i}` : `UPC${i}`);   // the incrementer counts from the executing word's address
  sram('U30', [...ua, 'HOLD'], [...Array(8).keys()].map(i => `INC${i}`), ilo);
  sram('U31', [...ua, 'HOLD'], ['INC8', 'INC9'], ihi);
  const fixed = [0, 430, 435, 0];                                       // FETCH, TRAP_PROT, TRAP_BAD (wired constants, as roms.js)
  if (mutant === 'TRAP_BAD_WIRED_WRONG') fixed[2] = 436;
  for (let j = 0; j < 5; j++) { const pins = { S0: 'FX0', S1: 'FX1', '1/E': 'GND', '2/E': 'GND' };
    for (const h of [1, 2]) { const b = 2 * j + h - 1; for (let s = 0; s < 4; s++) pins[`${h}I${s}`] = (fixed[s] >> b) & 1 ? 'VCC' : 'GND'; pins[`${h}Y`] = `FIX${b}`; }
    c.add(`U${32 + j}`, 'LVC153', pins); }
  for (let j = 0; j < 5; j++) { const pins = { S0: 'MS0', S1: 'MS1', '1/E': 'GND', '2/E': 'GND' };
    for (const h of [1, 2]) { const b = 2 * j + h - 1; Object.assign(pins, { [`${h}I0`]: `INC${b}`, [`${h}I1`]: `CW_C${b}`, [`${h}I2`]: mutant === 'DISPATCH_BIT_SWAP' && b < 2 ? `DP${1 - b}` : `DP${b}`, [`${h}I3`]: `FIX${b}`, [`${h}Y`]: `NA${b}` }); }
    c.add(`U${37 + j}`, 'LVC153', pins); }
  // --- register slot: fixed (from the word) / instruction diad / SPR index ---
  for (let j = 0; j < 3; j++) { const pins = { S0: 'CW_SLS0', S1: 'CW_SLS1', '1/E': 'GND', '2/E': j === 2 ? 'VCC' : 'GND' };
    for (const h of [1, 2]) { const b = 2 * j + h - 1; if (b > 4) { for (let s = 0; s < 4; s++) pins[`${h}I${s}`] = 'GND'; continue; }
      Object.assign(pins, { [`${h}I0`]: `CW_FS${b}`, [`${h}I1`]: `DS${b}`, [`${h}I2`]: `SS${b}`, [`${h}I3`]: 'GND', [`${h}Y`]: `RSLOT${b}` }); }
    c.add(`U${42 + j}`, 'LVC153', pins); }
  // --- micro-counter tables ---
  sram('U45', ['D0+', 'D0-', 'D1+', 'D1-', 'D2+', 'D2-', 'D3+', 'D3-'], ['LV0', 'LV1', 'LV2', 'LV3', 'LV4', 'LV5'], TBL.loadTable());
  sram('U46', ['U0', 'U1', 'U2', 'U3', 'U4', 'U5', 'CW_UOP0', 'CW_UOP1', 'LV0', 'LV1', 'LV2', 'LV3', 'LV4', 'LV5', 'ABORT'], ['UN0', 'UN1', 'UN2', 'UN3', 'UN4', 'UN5', 'UNZ'], TBL.counterTable());
  // WRAP = T2 mode = NOT MODE: one section of a 157 used as an inverter
  c.add('U59', 'LVC157', { S: 'MODE', '/E': 'GND', '1I0': 'VCC', '1I1': 'GND', '1Y': 'WRAP', '2I0': 'GND', '2I1': 'GND', '3I0': 'GND', '3I1': 'GND', '4I0': 'GND', '4I1': 'GND' });
  // --- PC: 9 slice tables, carry rippling; slice 0's carry-in comes from the word (+1 for INC, -1 for DEC) ---
  const pcs = TBL.pcSlice();
  for (let s = 0; s < 9; s++) { const a = [];
    for (let t = 0; t < 3; t++) a.push(T(`PC${3 * s + t}`, 0), T(`PC${3 * s + t}`, 1));
    for (let t = 0; t < 3; t++) a.push(T(`D${3 * s + t}`, 0), T(`D${3 * s + t}`, 1));
    const ci = s === 0 ? ['CW_PCC+', 'CW_PCC-'] : [`PCY${mutant === 'PC_CARRY_SKIP' && s === 2 ? s - 1 : s}+`, `PCY${mutant === 'PC_CARRY_SKIP' && s === 2 ? s - 1 : s}-`];
    a.push(...ci, 'CW_PCOP0', 'CW_PCOP1', s >= 3 ? 'WRAP' : 'GND', 'ABORT');
    const d = []; for (let t = 0; t < 3; t++) d.push(T(`PN${3 * s + t}`, 0), T(`PN${3 * s + t}`, 1)); d.push(`PCY${s + 1}+`, `PCY${s + 1}-`);
    sram(`U${50 + s}`, a, d, pcs); }
  // --- bus sources: CONST -> trits (3 tables); low 9 trits picked from PC / IMM / CONST / OPC; upper 18 trits PC or 0 ---
  const ct = TBL.constTables(), cbits = [...Array(14).keys()].map(i => `CW_C${i}`);
  sram('U60', cbits, [...Array(8).keys()].map(i => `KV${i}`), ct[0]);
  sram('U61', cbits, [...Array(8).keys()].map(i => `KV${8 + i}`), ct[1]);
  sram('U62', cbits, ['KV16', 'KV17'], ct[2]);
  for (let k = 0; k < 9; k++) { const pins = { S0: 'CW_BS0', S1: 'CW_BS1', '1/E': 'GND', '2/E': 'GND' };
    for (const r of [0, 1]) { const h = r + 1; Object.assign(pins, { [`${h}I0`]: T(`PC${k}`, r), [`${h}I1`]: IR(1, k, r), [`${h}I2`]: `KV${2 * k + r}`, [`${h}I3`]: k < 5 ? IR(0, k + 4, r) : 'GND', [`${h}Y`]: T(`CA${k}`, r) }); }
    c.add(`U${63 + k}`, 'LVC153', pins); }
  // second level for the low trits: first level / IRQV / SPR value / 0
  for (let k = 0; k < 9; k++) { const pins = { S0: 'CW_BT0', S1: 'CW_BT1', '1/E': 'GND', '2/E': 'GND' };
    for (const r of [0, 1]) { const h = r + 1; Object.assign(pins, { [`${h}I0`]: T(`CA${k}`, r), [`${h}I1`]: k < 3 ? T(`IV${k}`, r) : 'GND', [`${h}I2`]: k < 4 ? T(`SV${k}`, r) : 'GND', [`${h}I3`]: 'GND', [`${h}Y`]: T(`CB${k}`, r) }); }
    c.add(`U${120 + k}`, 'LVC153', pins); }
  for (let j = 0; j < 9; j++) { const pins = { S: 'GND', '/E': 'CW_/UPEN' };
    for (let i = 1; i <= 4; i++) { const w = 4 * j + i - 1, k = 9 + (w >> 1), r = w & 1; Object.assign(pins, { [`${i}I0`]: T(`PC${k}`, r), [`${i}I1`]: 'GND', [`${i}Y`]: T(`CB${k}`, r) }); }
    c.add(`U${72 + j}`, 'LVC157', pins); }
  for (let j = 0; j < 7; j++) { const pins = { DIR: 'VCC', '/OE': '/CBUSOE_F' };
    for (let i = 1; i <= 8; i++) { const w = 8 * j + i - 1; if (w >= 54) { pins[`A${i}`] = 'GND'; continue; } pins[`A${i}`] = T(`CB${w >> 1}`, w & 1); pins[`B${i}`] = T(`D${w >> 1}`, w & 1); }
    c.add(`U${81 + j}`, 'LVC245', pins); }
  // ---------------- stage 2 ----------------
  // latch register: MODE PRIV IE PROTEN TRAPDIV0 IM0..4 IP0..4 (one 16823, clocked every cycle; the tables hold)
  { const q = ['MODE', 'PRIV', 'IE', 'PROTEN', 'TRAPDIV0', 'IM0', 'IM1', 'IM2', 'IM3', 'IM4', 'IP0', 'IP1', 'IP2', 'IP3', 'IP4'];
    const pins = {}; for (const h of [1, 2]) Object.assign(pins, { [`${h}/OE`]: 'GND', [`${h}/CLKEN`]: 'GND', [`${h}CLK`]: 'CLK', [`${h}/CLR`]: 'VCC' });
    for (let b = 0; b < 18; b++) { const h = b < 9 ? 1 : 2, i = b % 9; pins[`${h}D${i}`] = q[b] ? `${q[b]}_N` : 'GND'; if (q[b]) pins[`${h}Q${i}`] = q[b]; }
    // Reset state (integration stage 2, 2026-11-20: the first integrated run came up in MODE 0 and dispatched NOP to
    // HALT, because this register had no reset and every card test preset it from outside). ISA-4 reset values:
    // MODE 1, PROTEN 1, everything else 0. Both halves clear asynchronously while RESET; MODE and PROTEN are stored
    // inverted (U104), so "cleared" is 1 for those two. 'LATCH_NO_RESET' is the mutant.
    if (mutant !== 'LATCH_NO_RESET') { for (const h of [1, 2]) pins[`${h}/CLR`] = '/RESET_C';
      pins['1D0'] = 'MODE_NI'; pins['1Q0'] = 'MODE_I'; pins['1D3'] = 'PROTEN_NI'; pins['1Q3'] = 'PROTEN_I';
      c.add('U104', 'LVC04', { '1A': 'MODE_N', '1Y': 'MODE_NI', '2A': 'MODE_I', '2Y': 'MODE', '3A': 'PROTEN_N', '3Y': 'PROTEN_NI',
        '4A': 'PROTEN_I', '4Y': 'PROTEN', '5A': 'RESET', '5Y': '/RESET_C', '6A': 'GND' }); }
    c.add('U89', 'ALVCH16823', pins); }
  // bus value mod 32 and nonzero (for SPR writes): 3 tryte tables + a combiner
  const tm = TBL.tryteMod();
  for (let t = 0; t < 3; t++) sram(`U${90 + t}`, [...Array(9).keys()].flatMap(i => [T(`D${9 * t + i}`, 0), T(`D${9 * t + i}`, 1)]), [0, 1, 2, 3, 4].map(i => `TM${t}_${i}`).concat([`TNZ${t}`]), tm);
  sram('U93', [...[0, 1, 2].flatMap(t => [0, 1, 2, 3, 4].map(i => `TM${t}_${i}`)), 'TNZ0', 'TNZ1', 'TNZ2'], ['MOD0', 'MOD1', 'MOD2', 'MOD3', 'MOD4', 'NZ'], TBL.combineMod());
  sram('U94', [...imm, 'CW_SPR'], ['LID0', 'LID1', 'LID2', 'SPRNR'], TBL.sprTable2());
  sram('U95', ['CW_SPRWR', 'LID0', 'LID1', 'LID2', mutant === 'PSW_ENTER_IGNORED' ? 'GND' : 'CW_PSW0', 'CW_PSW1', 'ABORT', 'NZ', 'D3+', 'D3-', 'D4+', 'D4-', 'MODE', 'PRIV', 'IE', 'PROTEN', 'TRAPDIV0'],
    ['MODE_N', 'PRIV_N', 'IE_N', 'PROTEN_N', 'TRAPDIV0_N'], TBL.bitLatches());
  const mod = ['MOD0', 'MOD1', 'MOD2', 'MOD3', 'MOD4'], im = [0, 1, 2, 3, 4].map(i => `IM${i}`), ip = [0, 1, 2, 3, 4].map(i => `IP${i}`);
  sram('U96', ['CW_SPRWR', 'LID0', 'LID1', 'LID2', 'ABORT', ...mod, ...im], im.map(n => `${n}_N`), TBL.wordLatch(4));
  sram('U97', ['CW_SPRWR', 'LID0', 'LID1', 'LID2', 'ABORT', ...mod, ...ip], ip.map(n => `${n}_A`), TBL.wordLatch(5));
  sram('U98', [...ip.map(n => `${n}_A`), ...im.map(n => `${n}_N`), mutant === 'ACK_IGNORED' ? 'GND' : 'CW_ACK', 'ABORT', 'IRQSET0', 'IRQSET1', 'IRQSET2', 'IRQSET3', 'IRQSET4'], ip.map(n => `${n}_N`), TBL.ipendNext());
  const irq = TBL.irqTable();
  sram('U99', [...(mutant === 'IRQ_PRIORITY_REVERSED' ? [...ip].reverse() : ip), ...(mutant === 'IRQ_PRIORITY_REVERSED' ? [...im].reverse() : im), 'MODE', 'IE'], ['IV0+', 'IV0-', 'IV1+', 'IV1-', 'IV2+', 'IV2-', 'IRQP'], irq);
  sram('U100', [...ip.map(n => `${n}_N`), ...im.map(n => `${n}_N`), 'MODE_N', 'IE_N'], [null, null, null, null, null, null, 'IRQN'], irq);
  sram('U101', ['LID0', 'LID1', 'LID2', 'MODE', 'PRIV', 'IE', 'PROTEN', 'TRAPDIV0', ...im, ...ip], ['SV0+', 'SV0-', 'SV1+', 'SV1-', 'SV2+', 'SV2-', 'SV3+', 'SV3-'], TBL.sprValue());
  // Control also drives the bus for an SPR read that isn't a register-RAM SPR
  c.add('U102', 'LVC08', { '1A': 'SPRNR', '1B': 'CW_RFBUS', '1Y': 'SPRDRV', '2A': 'GND', '2B': 'GND', '3A': 'GND', '3B': 'GND', '4A': 'GND', '4B': 'GND' });
  c.add('U103', 'LVC157', { S: 'SPRDRV', '/E': 'GND', '1I0': 'CW_/CBUSOE', '1I1': 'GND', '1Y': '/CBUSOE_F', '2I0': 'GND', '2I1': 'GND', '3I0': 'GND', '3I1': 'GND', '4I0': 'GND', '4I1': 'GND' });
  if (process.env.LOADPATH) require('./loadpath.js').addLoadPath(c, { worldLoad: { RESET: 1 } });   // COPY-ENGINE.md option B
  return c;
}

// the card's control word, decoded from a microword at ROM-generation time
const { SLOT } = require('../microsim/microsim.js');
function cardWord(mu, addr, fixed) {
  const f = {}; const seq = TBL.SEQK.indexOf(mu.SEQ || 'NEXT'); f.SQ0 = seq & 1; f.SQ1 = (seq >> 1) & 1; f.SQ2 = seq >> 2;
  f.CFETCH = ['JUMP', 'BR', 'BRN'].includes(mu.SEQ) && mu.CONST === fixed.FETCH ? 1 : 0; f.RET = mu.RETIRE ? 1 : 0;
  const cd = mu.COND ? TBL.CONDK.indexOf(mu.COND) : 0; for (let i = 0; i < 4; i++) f[`CD${i}`] = (cd >> i) & 1;
  const k = mu.CONST | 0; for (let i = 0; i < 14; i++) f[`C${i}`] = (k >> i) & 1;
  const rs = mu.RF_SEL || 'RD'; let sls = 0, fs = 0, rsk = 0;
  if (rs === 'RD' || rs === 'RS1' || rs === 'RS2') { sls = 1; rsk = { RD: 0, RS1: 1, RS2: 2 }[rs]; }
  else if (rs === 'SPR') sls = 2; else fs = rs === 'CONST' ? k : SLOT[rs];
  f.SLS0 = sls & 1; f.SLS1 = sls >> 1; for (let i = 0; i < 5; i++) f[`FS${i}`] = (fs >> i) & 1; f.RSK0 = rsk & 1; f.RSK1 = rsk >> 1;
  const lane = mu.MDR_LANE === undefined ? 0 : +mu.MDR_LANE, ir = mu.MEM === 'RD' && mu.LD_IR;
  f['/IR0CE'] = ir && lane === 0 ? 0 : 1; f['/IR1CE'] = ir && lane === 1 ? 0 : 1;
  const pcop = mu.LD_PC ? 2 : (mu.PC === 'INC' || mu.PC === 'DEC') ? 1 : 0; f.PCOP0 = pcop & 1; f.PCOP1 = pcop >> 1;
  f['PCC+'] = !mu.LD_PC && mu.PC === 'INC' ? 1 : 0; f['PCC-'] = !mu.LD_PC && mu.PC === 'DEC' ? 1 : 0;
  const uop = { LOAD: 1, DEC: 2, INC: 3 }[mu.UCNT] || 0; f.UOP0 = uop & 1; f.UOP1 = uop >> 1;
  if (mu.BUS === 'CONST' && k > 9841) throw new Error('CONST bus value needs more than 9 trits');
  const bs = { PC: 0, IMM: 1, CONST: 2, OPC: 3 }[mu.BUS]; f.BS0 = (bs || 0) & 1; f.BS1 = (bs || 0) >> 1;
  f['/CBUSOE'] = (bs === undefined && mu.BUS !== 'IRQV') ? 1 : 0; f['/UPEN'] = mu.BUS === 'PC' ? 0 : 1;
  const bt = mu.BUS === 'IRQV' ? 1 : (mu.BUS === 'RF' && rs === 'SPR') ? 2 : 0; f.BT0 = bt & 1; f.BT1 = bt >> 1;
  f.SPRWR = mu.RF_WR && rs === 'SPR' ? 1 : 0; f.SPR = rs === 'SPR' ? 1 : 0; f.RFBUS = mu.BUS === 'RF' ? 1 : 0;
  const psw = { ENTER: 1, RESTORE: 2 }[mu.PSW] || 0; f.PSW0 = psw & 1; f.PSW1 = psw >> 1; f.ACK = mu.IRQ_ACK ? 1 : 0;
  let w = 0n; CW.forEach((n, i) => { if (f[n]) w |= 1n << BigInt(i); }); return w;
}
module.exports = { build, cardWord, CW };
