// io-ports.js: the I/O card's port side, chip by chip: the bare ports 40-47 (SPI to an SD card, two PS/2 ports) and
// the port bridge (Kehai Interim, 2026-11-19). MIT. Spec: microsim/bareio.js. Design and results: IO-CARD.md.
// No microcontroller, no program: shift registers, counters, flip-flops and SRAM tables. The CPU runs every driver.
// The copy engine (io-copy-engine.js) is the other half of this card. The timer and RTC (ports 48..53) and the console
// (OUT 0) were added 2026-11-19. IORDY is now an open-drain wired-AND: each thing that can stall drives it through a
// 74LVC07, against one pull-up.
// Clocks: SCLK (40 MHz, 4 slots per microcycle, /CEDGE low in the last). The SPI shift registers are clocked by SCK
// and /SCK (a counter bit, so glitch-free); each PS/2 data latch by its capture flip-flop.
'use strict';
const { Card } = require('./netlist.js');
const TB = require('./io-ports-tables.js');
const T = (k, r) => `${k}${r ? '-' : '+'}`;
const CW = ['/IN', '/OUT', '/BIO'];

function build(csImage, mutant) {
  const c = new Card('I/O ports');
  c.input('SCLK', 'CLK', 'RESET', '/CEDGE', ...[...Array(10).keys()].map(i => `UA${i}`), ...[...Array(6).keys()].map(i => `PORT${i}`),
    'SD_MISO', 'SD_CD', 'K_CLK', 'K_DATA', 'M_CLK', 'M_DATA', 'RTC_OSC');
  for (let k = 0; k < 27; k++) c.input(T(`D${k}`, 0), T(`D${k}`, 1));
  const bits = (name, n) => [...Array(n).keys()].map(i => `${name}${i}`);
  const rails = (name, n) => { const w = []; for (let k = 0; k < n; k++) w.push(T(`${name}${k}`, 0), T(`${name}${k}`, 1)); return w; };
  const sram = (ref, part, addr, data, mem) => { const na = part === 'IS61WV5128' ? 19 : 21, pins = { '/CE': 'GND', '/OE': 'GND', '/WE': 'VCC' };
    for (let i = 0; i < na; i++) pins[`A${i}`] = addr[i] || 'GND'; data.forEach((n, i) => { if (n) pins[`IO${i}`] = n; }); c.add(ref, part, pins, { mem }); };
  const reg18 = (ref, d, q, clken1, clken2 = clken1, oe = 'GND', clr = 'VCC', clk = 'SCLK') => { const pins = {};
    for (const h of [1, 2]) Object.assign(pins, { [`${h}/OE`]: oe, [`${h}/CLKEN`]: h === 1 ? clken1 : clken2, [`${h}CLK`]: clk, [`${h}/CLR`]: clr });
    for (let i = 0; i < 18; i++) { const h = i < 9 ? 1 : 2, j = i % 9; pins[`${h}D${j}`] = d[i] || 'GND'; if (q[i]) pins[`${h}Q${j}`] = q[i]; } c.add(ref, 'ALVCH16823', pins); };
  const r574 = (ref, d, q, clk = 'SCLK', oe = 'GND') => { const pins = { CLK: clk, '/OE': oe }; for (let i = 1; i <= 8; i++) { pins[`D${i}`] = d[i - 1] || 'GND'; if (q[i - 1]) pins[`Q${i}`] = q[i - 1]; } c.add(ref, 'LVC574', pins); };
  const ctr = (ref, q, cep, cet, pe, tc) => { const pins = { CLK: 'SCLK', MR_N: 'VCC', PE_N: pe, CEP: cep, CET: cet, D0: 'GND', D1: 'GND', D2: 'GND', D3: 'GND' };
    q.forEach((n, i) => { if (n) pins[`Q${i}`] = n; }); if (tc) pins.TC = tc; c.add(ref, 'LVC161', pins); };

  // --- own control store (IN, OUT, BUS = IO), pipeline off in RESET, pull-ups = idle (as on the Video card) ---
  sram('U1', 'IS61WV5128', bits('UA', 10), ['CSD0', 'CSD1', 'CSD2'], csImage);
  reg18('U2', ['CSD0', 'CSD1', 'CSD2'], CW.map(n => `CW_${n}`), 'GND', 'GND', 'RESET', 'VCC', 'CLK');   // the CPU clock
  c.add('RN1', 'RPACK8', { P1: 'CW_/IN', P2: 'CW_/OUT', P3: 'CW_/BIO' });
  c.add('U3', 'LVC04', { '1A': 'RESET', '1Y': '/RESET', '2A': 'SCK', '2Y': '/SCK', '3A': 'TRST', '3Y': '/PEPRE' });
  c.add('U4', 'LVC32', { '1A': 'CW_/BIO', '1B': '/ISEL', '1Y': '/BOE', '2A': 'KA', '2B': '/KB', '2Y': '/KSH', '3A': 'MA', '3B': '/MB', '3Y': '/MSH', '4A': 'TICK', '4B': 'RESET', '4Y': 'TRST' });

  // --- port decode at the CPU edge, and "the last IN was mine" (who answers BUS = IO) ---
  const dAddr = [...bits('PORT', 6), 'CW_/IN', 'CW_/OUT', '/CEDGE', 'ISEL'];
  sram('U5', 'IS61WV5128', dAddr, ['/START', 'WR41', '/LDANS', 'ISELD', 'RDK', 'RDM', '/OE_RX', '/OE_KD'], TB.dt1(mutant));
  sram('U6', 'IS61WV5128', dAddr, ['/OE_MD', '/OE_ST', '/CSTART'], TB.dt2());
  c.add('U7', 'LVC74', { '1D': 'ISELD', '1CLK': 'SCLK', '1/CLR': '/RESET', '1/PRE': 'VCC', '1Q': 'ISEL', '1/Q': '/ISEL',
    '2D': 'FASTD', '2CLK': 'SCLK', '2/CLR': '/RESET', '2/PRE': 'VCC', '2Q': 'FAST' });

  // --- THE PORT BRIDGE, outbound: the low tryte -> 16 bits (T->B), latched when an exchange starts ---
  const tbAddr = [...rails('D', 9), 'PORT0', 'PORT1', 'PORT2'];
  sram('U8', 'IS61WV20488', tbAddr, bits('TB', 8), TB.t2b(0, mutant));
  sram('U9', 'IS61WV20488', tbAddr, bits('TB', 16).slice(8), TB.t2b(1, mutant));
  reg18('U10', bits('TB', 16), bits('TX', 16), '/START');

  // --- SPI: chip select and clock speed (OUT 41 bits 0 and 1 = TB8, TB9), the sequencer, the shift registers ---
  c.add('U11', 'LVC157', { S: 'WR41', '/E': 'GND', '1I0': 'CS', '1I1': 'TB8', '1Y': 'CSD', '2I0': 'FAST', '2I1': 'TB9', '2Y': 'FASTD',
    '3I0': 'GND', '3I1': 'GND', '4I0': 'GND', '4I1': 'GND' });
  c.add('U12', 'LVC74', { '1D': 'CSD', '1CLK': 'SCLK', '1/CLR': '/RESET', '1/PRE': 'VCC', '1Q': 'CS', '1/Q': 'SD_/CS',
    '2D': 'GND', '2CLK': 'GND', '2/CLR': 'VCC', '2/PRE': 'VCC' });
  sram('U13', 'IS61WV5128', [...bits('PRE', 6), 'SCK', ...bits('PH', 6).slice(1), 'BUSY', 'N16', 'FAST', '/START', 'PORT1', 'RESET'],
    ['BUSYD', 'N16D', 'SHLDD', 'PHCE', '/PHLD', '/PRELD', 'PRECE', 'READYD'], TB.spiTable(mutant));
  r574('U14', ['BUSYD', 'N16D', 'SHLDD', 'READYD'], ['BUSY', 'N16', 'SH/LD', 'SREADY']);
  ctr('U15', ['SCK', 'PH1', 'PH2', 'PH3'], 'PHCE', 'PHCE', '/PHLD', 'PHTC');
  ctr('U16', ['PH4', 'PH5'], 'PHCE', 'PHTC', '/PHLD');
  ctr('U17', bits('PRE', 4), 'PRECE', 'PRECE', '/PRELD', 'PRETC');
  ctr('U18', ['PRE4', 'PRE5'], 'PRECE', 'PRETC', '/PRELD');
  const sh = (ref, d, ser, qh) => { const pins = { 'SH/LD': 'SH/LD', CLK: '/SCK', CLKINH: 'GND', SER: ser, QH: qh };
    'ABCDEFGH'.split('').forEach((p, i) => { pins[p] = d[i]; }); c.add(ref, 'LVC165', pins); };
  sh('U19', bits('TX', 16).slice(8), 'QL', 'SD_MOSI');                 // high byte: its H (TX15) goes out first
  sh('U20', bits('TX', 8), 'VCC', 'QL');
  const rx = (ref, a, q) => { const pins = { A: a, B: a, CLK: 'SCK', '/CLR': 'VCC' }; q.forEach((n, i) => { pins[`Q${i}`] = n; }); c.add(ref, 'LV164', pins); };
  rx('U21', 'SD_MISO', bits('RX', 8));                                 // MSB first: the first bit ends at RX15
  rx('U22', 'RX7', bits('RX', 16).slice(8));
  const buf244 = (ref, a, y, oe1, oe2 = oe1) => { const pins = { '1/OE': oe1, '2/OE': oe2 }; for (let i = 0; i < 8; i++) { const h = i < 4 ? 1 : 2, j = (i % 4) + 1;
      pins[`${h}A${j}`] = a[i] || 'GND'; pins[`${h}Y${j}`] = y[i]; } c.add(ref, 'LVC244', pins); };
  buf244('U23', bits('RX', 8), bits('ANS', 8), '/OE_RX');
  buf244('U24', bits('RX', 16).slice(8), bits('ANS', 16).slice(8), '/OE_RX');

  // --- PS/2: synchronisers, inverted shift registers, state tables, data latches ---
  c.add('U25', 'LVC74', { '1D': 'K_CLK', '1CLK': 'SCLK', '1/CLR': 'VCC', '1/PRE': 'VCC', '1Q': 'KA', '2D': 'KA', '2CLK': 'SCLK', '2/CLR': 'VCC', '2/PRE': 'VCC', '2Q': 'KB', '2/Q': '/KB' });
  c.add('U26', 'LVC74', { '1D': 'M_CLK', '1CLK': 'SCLK', '1/CLR': 'VCC', '1/PRE': 'VCC', '1Q': 'MA', '2D': 'MA', '2CLK': 'SCLK', '2/CLR': 'VCC', '2/PRE': 'VCC', '2Q': 'MB', '2/Q': '/MB' });
  c.add('U27', 'LVC74', { '1D': 'K_DATA', '1CLK': 'SCLK', '1/CLR': 'VCC', '1/PRE': 'VCC', '1/Q': '/KC', '2D': 'M_DATA', '2CLK': 'SCLK', '2/CLR': 'VCC', '2/PRE': 'VCC', '2/Q': '/MC' });
  for (const [x, base, irq] of [['K', 28, 'IRQSET1'], ['M', 32, 'IRQSET2']]) {
    const S = bits(`${x}S`, 11);
    reg18(`U${base}`, [`/${x}C`, ...S.slice(0, 10)], S, `/${x}SH`, `/${x}SH`, 'GND', `/${x}CLR`);   // a falling PS/2 clock shifts
    sram(`U${base + 1}`, 'IS61WV5128', [...S, `${x}RDY`, irq, `${x}CAPQ`, x === 'K' ? 'RDK' : 'RDM', 'RESET', '/CEDGE', `${x}PERR`, `${x}FERR`],
      [`${x}RDYD`, `${x}IRQD`, `${x}CAPD`, `/${x}CLRD`, `${x}PERRD`, `${x}FERRD`, `/${x}RDYD`], TB.ps2Table(mutant === `${x}_NO_IRQ` ? 'NO_IRQ' : null));
    r574(`U${base + 2}`, [`${x}RDYD`, `${x}IRQD`, `${x}CAPD`, `/${x}CLRD`, `${x}PERRD`, `${x}FERRD`, `/${x}RDYD`],
      [`${x}RDY`, irq, `${x}CAPQ`, `/${x}CLR`, `${x}PERR`, `${x}FERR`, `/${x}RDY`]);
    r574(`U${base + 3}`, S.slice(2, 10).reverse(), bits('ANS', 8), `${x}CAPQ`, x === 'K' ? '/OE_KD' : '/OE_MD');   // !d0..!d7
  }
  c.add('U36', 'LVC125', { '1A': 'GND', '1/OE': '/KRDY', '1Y': 'K_HOLD', '2A': 'GND', '2/OE': mutant === 'NO_INHIBIT' ? 'VCC' : '/MRDY', '2Y': 'M_HOLD',
    '3A': 'GND', '3/OE': 'VCC', '4A': 'GND', '4/OE': 'VCC' });
  const ST = TB.STATUS, st = []; st[ST.CD] = 'SD_CD'; st[ST.KRDY] = 'KRDY'; st[ST.KPERR] = 'KPERR'; st[ST.KFERR] = 'KFERR';
  st[ST.MRDY] = 'MRDY'; st[ST.MPERR] = 'MPERR'; st[ST.MFERR] = 'MFERR';
  buf244('U37', st, bits('ANS', 8), '/OE_ST');
  c.add('RN2', 'RPACK8', Object.fromEntries(bits('ANS', 8).map((n, i) => [`P${i + 1}`, n])));
  c.add('RN3', 'RPACK8', Object.fromEntries(bits('ANS', 16).slice(8).map((n, i) => [`P${i + 1}`, n])));

  // --- THE PORT BRIDGE, inbound: the answer bus -> 11 trits (B->T), the answer register, BUS = IO ---
  const bt = bits('BT', 22);
  for (let k = 0; k < 3; k++) sram(`U${38 + k}`, 'IS61WV5128', [...bits('ANS', 16), 'PORT0', 'PORT1', 'PORT2'], bt.slice(8 * k, 8 * k + 8), TB.b2t(k, mutant));
  const dr = rails('D', 27);
  for (let k = 0; k < 3; k++) reg18(`U${41 + k}`, bt.slice(18 * k, 18 * k + 18), dr.slice(18 * k, 18 * k + 18), '/LDANS', '/LDANS', '/BOE');

  // --- THE TIMER AND THE RTC (ports 48..53; IO-CARD.md). Plain counters: the CPU's driver does the arithmetic. ---
  // 200 kHz: an 8-bit prescaler counts 56..255 (200 SCLK slots) and loads 56 on its terminal count or in RESET.
  // TICK is that terminal count: one slot in every 200.
  const ctrD = (ref, q, d, cep, cet, pe, tc, mr = 'VCC') => { const pins = { CLK: 'SCLK', MR_N: mr, PE_N: pe, CEP: cep, CET: cet };
    for (let i = 0; i < 4; i++) pins[`D${i}`] = d[i]; q.forEach((n, i) => { if (n) pins[`Q${i}`] = n; }); if (tc) pins.TC = tc; c.add(ref, 'LVC161', pins); };
  const nib = v => [0, 1, 2, 3].map(i => (v >> i) & 1 ? 'VCC' : 'GND'), PRESET = mutant === 'PRESCALE_199' ? 57 : 56;
  ctrD('U44', [], nib(PRESET & 15), 'VCC', 'VCC', '/PEPRE', 'TPTC');
  ctrD('U45', [], nib(PRESET >> 4), 'VCC', 'TPTC', '/PEPRE', 'TICK');
  // flip-flops: TICKQ (the tick counter's clock, glitch-free), the IRQ flag, the held snapshot request, RCLK
  c.add('U46', 'LVC74', { '1D': 'TICK', '1CLK': 'SCLK', '1/CLR': '/RESET', '1/PRE': 'VCC', '1Q': 'TICKQ',
    '2D': 'IRQ0D', '2CLK': 'SCLK', '2/CLR': '/RESET', '2/PRE': 'VCC', '2Q': 'IRQSET0' });
  c.add('U47', 'LVC74', { '1D': 'SNAPPD', '1CLK': 'SCLK', '1/CLR': '/RESET', '1/PRE': 'VCC', '1Q': 'SNAPP',
    '2D': 'RCLKD', '2CLK': 'SCLK', '2/CLR': '/RESET', '2/PRE': 'VCC', '2Q': 'RCLKQ' });
  // the 200 kHz tick count: one 'LV8154 as a 32-bit counter (CLKA = CLKB, RCOA -> CLKBEN), cleared by RESET
  const g8154 = (ref, clk, clr, gates) => { const pins = { CLKA: clk, CLKB: clk, CLKBEN: `${ref}_RCOA`, RCOA: `${ref}_RCOA`, RCLK: 'RCLKQ', CCLR: clr,
      GAL: gates[0], GAU: gates[1], GBL: gates[2], GBU: gates[3] }; for (let i = 0; i < 8; i++) pins[`Y${i}`] = `ANS${i}`; c.add(ref, 'LV8154', pins); };
  g8154('U48', 'TICKQ', '/RESET', ['/G0', '/G1', '/G2', '/G3']);
  // the period counter: 16 bits of '161, loaded from the period latch (arm, or each time it fires); counts on TICK
  // while the timer is enabled. TC4 = all ones and enabled.
  const PL = bits('TPL', 8), PH = bits('TPH', 8);
  ctrD('U49', [], PL.slice(0, 4), 'TICK', 'TEN', '/PE_PER', 'PTC0', '/RESET');
  ctrD('U50', [], PL.slice(4, 8), 'TICK', 'PTC0', '/PE_PER', 'PTC1', '/RESET');
  ctrD('U51', [], PH.slice(0, 4), 'TICK', 'PTC1', '/PE_PER', 'PTC2', '/RESET');
  ctrD('U52', [], PH.slice(4, 8), 'TICK', 'PTC2', '/PE_PER', 'TC4', '/RESET');
  // latches: the period's two bytes; the read select and the timer enable (all from the bridge's byte, TB8..TB15)
  const TBH = bits('TB', 16).slice(8);
  reg18('U53', [...TBH, 'GND', ...TBH, 'GND'], [...PL, null, ...PH, null], '/WRPL', '/WRPH', 'GND', '/RESET');
  reg18('U54', [...TBH.slice(0, 4)], ['SEL0', 'SEL1', 'SEL2', 'TEN'], '/WRSEL', 'VCC', 'GND', '/RESET');
  // which stored byte goes on the answer bus for IN 48: a '138 on the select latch, enabled by /OE_T
  const sel = mutant === 'SEL_SWAP' ? ['SEL2', 'SEL1', 'SEL0'] : ['SEL0', 'SEL1', 'SEL2'];
  c.add('U55', 'LVC138', { A: sel[0], B: sel[1], C: sel[2], G1: 'VCC', '/G2A': '/OE_T', '/G2B': 'GND',
    ...Object.fromEntries([...Array(8).keys()].map(i => [`/Y${i}`, `/G${i}`])) });
  // the timer's decode and glue: one more table
  sram('U56', 'IS61WV5128', [...bits('PORT', 6), 'CW_/IN', 'CW_/OUT', '/CEDGE', 'TC4', 'TICK', 'IRQSET0', 'SNAPP', 'RESET'],
    ['/WRPL', '/WRPH', '/WRSEL', '/OE_T', '/PE_PER', 'IRQ0D', 'SNAPPD', 'RCLKD'], TB.dt3(mutant));
  // the RTC, on the coin cell: a CD4060 divides the 32.768 kHz crystal to 2 Hz (Q14), and a second 'LV8154 counts
  // half-seconds (32 bits: 68 years). It is never cleared: the OS keeps the offset to real time. See IO-CARD.md for the
  // power domain (the battery side, and why the snapshot can still race the RTC's own clock).
  c.add('U57', 'CD4060', { PHI1: 'RTC_OSC', MR: 'GND', Q14: 'RTC_2HZ' });
  g8154('U58', 'RTC_2HZ', 'VCC', ['/G4', '/G5', '/G6', '/G7']);

  // --- THE CONSOLE (OUT 0): 115,200 baud 8N1 on CON_TX (IO-CARD.md) ---
  const BAUD = mutant === 'CON_BAUD_2X' ? 3923 : 3749;                     // 4096 - 347 (the mutant: 173, twice the rate)
  ctrD('U59', [], nib(BAUD & 15), 'VCC', 'VCC', '/BLD', 'BTC0');
  ctrD('U60', [], nib((BAUD >> 4) & 15), 'VCC', 'BTC0', '/BLD', 'BTC1');
  ctrD('U61', [], nib(BAUD >> 8), 'VCC', 'BTC1', '/BLD', 'BTC');
  ctrD('U62', ['CB0', 'CB1', 'CB2', 'CB3'], ['VCC', 'GND', 'GND', 'GND'], 'BTC', 'CBUSY', '/CSTART', null, '/RESET');
  reg18('U63', [...TBH], bits('CS', 8), '/CSTART', 'VCC', 'GND', '/RESET');
  sram('U64', 'IS61WV5128', [...bits('CS', 8), 'CB0', 'CB1', 'CB2', 'CB3', 'BTC', '/CSTART'],
    ['TXD_D', '/CBUSY', '/BLD', 'CBUSY'], TB.conTable(mutant));
  c.add('U65', 'LVC74', { '1D': 'TXD_D', '1CLK': 'SCLK', '1/CLR': 'VCC', '1/PRE': '/RESET', '1Q': 'CON_TX',
    '2D': 'GND', '2CLK': 'SCLK', '2/CLR': 'VCC', '2/PRE': 'VCC' });
  // IORDY: the SPI sequencer's READY and the console's /CBUSY, each through an open-drain buffer; RN4 pulls it up
  c.add('U66', 'LVC07', { '1A': 'SREADY', '1Y': 'IORDY', '2A': mutant === 'CON_NO_STALL' ? 'VCC' : '/CBUSY', '2Y': 'IORDY',
    '3A': 'VCC', '4A': 'VCC', '5A': 'VCC', '6A': 'VCC' });
  c.add('RN4', 'RPACK8', { P1: 'IORDY' });
  return c;
}
function cardWord(mu) { return (mu.IO === 'IN' ? 0 : 1) | (mu.IO === 'OUT' ? 0 : 1) << 1 | (mu.BUS === 'IO' ? 0 : 1) << 2; }
// which net clocks each register chip (everything else on SCLK)
const DERIVED = { U2: 'CLK', U19: '/SCK', U20: '/SCK', U21: 'SCK', U22: 'SCK', U31: 'KCAPQ', U35: 'MCAPQ' };
module.exports = { build, cardWord, CW, DERIVED };
