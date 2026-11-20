// parts.js: functional pin-level models of the real chips on the card computer (Kehai Interim, 2026-11-18). MIT.
// Pin NAMES follow each datasheet's function names; pin NUMBERS get attached when the KiCad symbols are drawn.
// Functional only: timing comes from TIMING-BUDGET.md, not from here. 'Z' = not driven.
'use strict';
const sec = (n) => Array.from({ length: n }, (_, i) => i + 1);
function sramModel(na, nd) { return { out: [...Array(nd).keys()].map(i => `IO${i}`), tri: true,
  eval(c, g, s) { const en = !g('/CE') && !g('/OE') && g('/WE'); let a = 0; for (let i = 0; i < na; i++) a += g(`A${i}`) * 2 ** i;
    const d = c.mem[a]; for (let i = 0; i < nd; i++) if (c.pins[`IO${i}`]) s(`IO${i}`, en ? (d >> i) & 1 : 'Z'); },
  write(c, g) { if (g('/CE') || g('/WE')) return -1; let a = 0; for (let i = 0; i < na; i++) a += g(`A${i}`) * 2 ** i;
    let d = 0; for (let i = 0; i < nd; i++) if (c.pins[`IO${i}`]) d |= g(`IO${i}`) << i; c.mem[a] = d; return a; } }; }
const P = {
  // ISSI IS61WV5128EDBLL-10: 512K x 8 async SRAM
  IS61WV5128: { out: [...Array(8).keys()].map(i => `IO${i}`), tri: true,   // 3-state outputs (/OE)
    eval(c, g, s) { const en = !g('/CE') && !g('/OE') && g('/WE');
      let a = 0; for (let i = 0; i < 19; i++) a |= g(`A${i}`) << i; const d = c.mem ? c.mem[a] : 0;
      for (let i = 0; i < 8; i++) s(`IO${i}`, en ? (d >> i) & 1 : 'Z'); },
    // a write: /CE and /WE low at the clock edge (the card's write strobe is timed inside the cycle; see REGISTERS-CARD.md)
    write(c, g) { if (g('/CE') || g('/WE')) return; let a = 0; for (let i = 0; i < 19; i++) a |= g(`A${i}`) << i;
      let d = 0; for (let i = 0; i < 8; i++) if (c.pins[`IO${i}`]) d |= g(`IO${i}`) << i; c.mem[a] = d; } },
  // Main RAM and framebuffer parts (stage 2 of the Memory card). Same async pattern as IS61WV5128: reads while /CE and
  // /OE are low and /WE is high; write() stores what the IO pins carry when /CE and /WE are low at the clock edge
  // (in hardware /WE = enable OR CLK, a pulse in the cycle's second half). /UB and /LB are tied low on this card.
  // write() returns the address written, or -1, so the harness can account for every write the card makes.
  // ISSI IS61WV204816BLL-10: 2M x 16
  IS61WV204816: sramModel(21, 16),
  // ISSI IS61WV20488FBLL-10: 2M x 8
  IS61WV20488: sramModel(21, 8),
  // ISSI IS61WV51216EDBLL-10: 512K x 16
  IS61WV51216: sramModel(19, 16),
  // 74ALVCH16823: 18-bit D flip-flop, two 9-bit halves, active-low clock enable and output enable
  // x/CLR is asynchronous (low: that half's flip-flops go to 0 at once); cards that don't use it tie it to VCC.
  ALVCH16823: { out: [1, 2].flatMap(h => [...Array(9).keys()].map(i => `${h}Q${i}`)), reg: true,
    eval(c, g, s) { for (const h of [1, 2]) { const clr = c.pins[`${h}/CLR`] && !g(`${h}/CLR`);
        for (let i = 0; i < 9; i++) s(`${h}Q${i}`, g(`${h}/OE`) ? 'Z' : clr ? 0 : ((c.q || [])[h * 9 + i] | 0)); } },
    // asynchronous inputs act on the settled values (netlist.settle calls this, then settles again if state changed)
    async(c, g) { let ch = false; for (const h of [1, 2]) if (c.pins[`${h}/CLR`] && !g(`${h}/CLR`)) { c.q = c.q || [];
        for (let i = 0; i < 9; i++) if (c.q[h * 9 + i]) { c.q[h * 9 + i] = 0; ch = true; } } return ch; },
    clock(c, g) { c.q = c.q || []; const nq = c.q.slice();
      for (const h of [1, 2]) { if (c.pins[`${h}/CLR`] && !g(`${h}/CLR`)) { for (let i = 0; i < 9; i++) nq[h * 9 + i] = 0; continue; }
        if (!g(`${h}/CLKEN`)) for (let i = 0; i < 9; i++) nq[h * 9 + i] = g(`${h}D${i}`); } c.q = nq; } },
  // 74LVC574: octal D flip-flop
  LVC574: { out: sec(8).map(i => `Q${i}`), reg: true, tri: true,   // 3-state (/OE)
    eval(c, g, s) { for (const i of sec(8)) s(`Q${i}`, g('/OE') ? 'Z' : ((c.q || [])[i] | 0)); },
    clock(c, g) { c.q = c.q || []; const nq = []; for (const i of sec(8)) nq[i] = g(`D${i}`); c.q = nq; } },
  // 74LVC157A: quad 2:1 mux, common select S and active-low enable /E
  LVC157: { out: sec(4).map(i => `${i}Y`),
    eval(c, g, s) { for (const i of sec(4)) s(`${i}Y`, g('/E') ? 0 : g(g('S') ? `${i}I1` : `${i}I0`)); } },
  // 74LVC153: dual 4:1 mux, common selects S0 S1, per-section /E
  LVC153: { out: ['1Y', '2Y'],
    eval(c, g, s) { const k = g('S0') | (g('S1') << 1); for (const h of [1, 2]) s(`${h}Y`, g(`${h}/E`) ? 0 : g(`${h}I${k}`)); } },
  // 74CBTLV3253: dual 1-of-4 FET mux/demux; xA connects to xB(sel+1) while x/OE is low
  CBTLV3253: { out: ['1A', '2A'], tri: true,
    eval(c, g, s) { const k = g('S0') | (g('S1') << 1); for (const h of [1, 2]) s(`${h}A`, g(`${h}/OE`) ? 'Z' : g(`${h}B${k + 1}`)); } },
  // 74CBTLV3257: quad 1-of-2 FET mux (Memory card J2: the VRAM-S address, ~0.25 ns instead of a '157's 5.2 ns);
  // xA connects to xB1 (S = 0) or xB2 (S = 1) while /OE is low
  CBTLV3257: { out: sec(4).map(i => `${i}A`), tri: true,
    eval(c, g, s) { const k = g('S') ? 2 : 1; for (const i of sec(4)) if (c.pins[`${i}A`]) s(`${i}A`, g('/OE') ? 'Z' : g(`${i}B${k}`)); } },
  // 74CBTLV3245: octal FET bus switch; A <-> B while /OE is low (used A -> B here)
  CBTLV3245: { out: sec(8).map(i => `B${i}`), tri: true,
    eval(c, g, s) { for (const i of sec(8)) s(`B${i}`, g('/OE') ? 'Z' : g(`A${i}`)); } },
  // 74LVC245A: octal bus transceiver, DIR = 1 drives A -> B
  LVC245: { out: [...sec(8).map(i => `B${i}`), ...sec(8).map(i => `A${i}`)], tri: true,
    eval(c, g, s) { const off = g('/OE'), dir = off ? 0 : g('DIR');
      for (const i of sec(8)) { if (off) continue; if (dir) { if (c.pins[`B${i}`]) s(`B${i}`, g(`A${i}`)); } else if (c.pins[`A${i}`] && c.pins[`B${i}`]) s(`A${i}`, g(`B${i}`)); } } },
  // 74LVC04: hex inverter
  LVC04: { out: sec(6).map(i => `${i}Y`), eval(c, g, s) { for (const i of sec(6)) if (c.pins[`${i}A`]) s(`${i}Y`, g(`${i}A`) ? 0 : 1); } },
  // 74LVC08: quad 2-input AND
  LVC08: { out: sec(4).map(i => `${i}Y`), eval(c, g, s) { for (const i of sec(4)) s(`${i}Y`, g(`${i}A`) & g(`${i}B`)); } },
  // 74LVC11: triple 3-input AND (stage 1b lookahead flags: "this slice is all +1" / "all -1")
  LVC11: { out: sec(3).map(i => `${i}Y`), eval(c, g, s) { for (const i of sec(3)) if (c.pins[`${i}A`]) s(`${i}Y`, g(`${i}A`) & g(`${i}B`) & g(`${i}C`)); } },
  // 74LVC32: quad 2-input OR
  LVC32: { out: sec(4).map(i => `${i}Y`), eval(c, g, s) { for (const i of sec(4)) s(`${i}Y`, g(`${i}A`) | g(`${i}B`)); } },
  // 8 x 4.7k bussed resistor network to VCC (e.g. Bourns 4609X-101-472): a weak 1 on any net nothing else drives
  RPACK8: { out: sec(8).map(i => `P${i}`), weak: true,
    eval(c, g, s) { for (const i of sec(8)) s(`P${i}`, 1, true); } },
  // ---- copy engine, option B (COPY-ENGINE.md): parts for the resistor-coupled load bus ----
  // 74LVC257A: quad 2:1 mux with 3-state outputs (same pinout as the '157; /OE high = outputs off)
  LVC257: { out: sec(4).map(i => `${i}Y`), tri: true,
    eval(c, g, s) { const off = g('/OE'); for (const i of sec(4)) if (c.pins[`${i}Y`]) s(`${i}Y`, off ? 'Z' : g(g('S') ? `${i}I1` : `${i}I0`)); } },
  // 74LVC253A: dual 4:1 mux with 3-state outputs (same pinout as the '153; per-section /OE)
  LVC253: { out: ['1Y', '2Y'], tri: true,
    eval(c, g, s) { const k = g('S0') | (g('S1') << 1); for (const h of [1, 2]) if (c.pins[`${h}Y`]) s(`${h}Y`, g(`${h}/OE`) ? 'Z' : g(`${h}I${k}`)); } },
  // 74LVC125A: quad buffer, 3-state, per-gate active-low /OE
  LVC125: { out: sec(4).map(i => `${i}Y`), tri: true,
    eval(c, g, s) { for (const i of sec(4)) if (c.pins[`${i}Y`]) s(`${i}Y`, g(`${i}/OE`) ? 'Z' : g(`${i}A`)); } },
  // 74LVC138A: 3-to-8 decoder, enabled when G1 = 1, /G2A = 0, /G2B = 0; outputs active low
  LVC138: { out: [...Array(8).keys()].map(i => `/Y${i}`),
    eval(c, g, s) { const en = g('G1') && !g('/G2A') && !g('/G2B'), k = g('A') | (g('B') << 1) | (g('C') << 2);
      for (let i = 0; i < 8; i++) if (c.pins[`/Y${i}`]) s(`/Y${i}`, en && k === i ? 0 : 1); } },
  // 8 isolated resistors (e.g. Bourns 4608X-102-103, 10k): Ni <-> Li. Each table net Ni is pulled weakly to its load
  // line Li. When the line floats (run time: the card's bus switch is open) the resistor drives nothing: gz('L') = 'Z'.
  // Two resistors pulling one net different ways is a weak contention, which settle() reports as a fight.
  RLINK8: { out: sec(8).map(i => `N${i}`), weak: true,
    eval(c, g, s, gz) { for (const i of sec(8)) { if (!c.pins[`N${i}`]) continue; const x = gz(`L${i}`); if (x !== 'Z') s(`N${i}`, x, true); } } },
  // a bussed pull network whose common pin is switched (driven by a 3-state buffer): weak COM, or nothing when COM floats
  RPACK8S: { out: sec(8).map(i => `P${i}`), weak: true,
    eval(c, g, s, gz) { const x = gz('COM'); if (x === 'Z') return; for (const i of sec(8)) if (c.pins[`P${i}`]) s(`P${i}`, x, true); } },
  // ---- copy engine (I/O card) ----
  // 74LVC161: 4-bit synchronous binary counter. MR_N (async clear), PE_N (sync load), CEP & CET (count enables),
  // TC = Q3..0 all ones & CET. clock(): the rising edge.
  LVC161: { out: ['Q0', 'Q1', 'Q2', 'Q3', 'TC'], reg: true,
    eval(c, g, s) { const q = g('MR_N') ? (c.q | 0) : 0; for (let i = 0; i < 4; i++) s(`Q${i}`, (q >> i) & 1); s('TC', q === 15 && g('CET') ? 1 : 0); },
    clock(c, g) { if (!g('MR_N')) { c.q = 0; return; } const q = c.q | 0;
      if (!g('PE_N')) c.q = g('D0') | (g('D1') << 1) | (g('D2') << 2) | (g('D3') << 3); else if (g('CEP') && g('CET')) c.q = (q + 1) & 15; } },
  // 74LVC74: dual D flip-flop with async /CLR and /PRE (per half: xD, xCLK edge, x/CLR, x/PRE -> xQ, x/Q)
  LVC74: { out: ['1Q', '1/Q', '2Q', '2/Q'], reg: true,
    eval(c, g, s) { c.q = c.q || [0, 0, 0]; for (const h of [1, 2]) { let q = c.q[h] | 0; if (!g(`${h}/CLR`)) q = 0; else if (!g(`${h}/PRE`)) q = 1;
        if (c.pins[`${h}Q`]) s(`${h}Q`, q); if (c.pins[`${h}/Q`]) s(`${h}/Q`, q ^ 1); } },
    clock(c, g) { c.q = c.q || [0, 0, 0]; for (const h of [1, 2]) { if (!c.pins[`${h}CLK`] || c.pins[`${h}CLK`] === 'GND') continue;
        c.q[h] = !g(`${h}/CLR`) ? 0 : !g(`${h}/PRE`) ? 1 : g(`${h}D`); } } },
  // 74LVC164: 8-bit serial-in parallel-out shift register. Serial in = A & B, shifts on the CLK rising edge, /CLR async.
  LVC164: { out: [...Array(8).keys()].map(i => `Q${i}`), reg: true,
    eval(c, g, s) { const q = g('/CLR') ? (c.q | 0) : 0; for (let i = 0; i < 8; i++) if (c.pins[`Q${i}`]) s(`Q${i}`, (q >> i) & 1); },
    clock(c, g) { if (!g('/CLR')) { c.q = 0; return; } c.q = (((c.q | 0) << 1) | (g('A') & g('B'))) & 255; } },
  // The real part is the 74LV164 (Nexperia) / SN74LV164A (TI), 2-5.5 V: there is no 74LVC164. Same function; the
  // model keeps its old key for the copy-engine files and LV164 is the name to use. [corrected 2026-11-19]
  // ---- I/O card ports (IO-CARD.md) ----
  // SN74LVC165A: 8-bit parallel-load shift register. SH/LD low loads A..H asynchronously (H is the one at QH);
  // CLK rising with CLKINH low shifts toward QH, SER entering at A.
  LVC165: { out: ['QH', '/QH'], reg: true,
    eval(c, g, s) { const h = !g('SH/LD') ? g('H') : ((c.q | 0) >> 7) & 1; if (c.pins.QH) s('QH', h); if (c.pins['/QH']) s('/QH', h ^ 1); },
    async(c, g) { if (g('SH/LD')) return false; let q = 0; 'ABCDEFGH'.split('').forEach((p, i) => { q |= g(p) << i; }); const ch = q !== (c.q | 0); c.q = q; return ch; },
    clock(c, g) { if (!g('SH/LD') || g('CLKINH')) return; c.q = (((c.q | 0) << 1) | g('SER')) & 255; } },
  // 74LVC244A: octal buffer, 3-state, two 4-bit halves with active-low 1/OE, 2/OE
  LVC244: { out: [1, 2].flatMap(h => sec(4).map(i => `${h}Y${i}`)), tri: true,
    eval(c, g, s) { for (const h of [1, 2]) for (const i of sec(4)) if (c.pins[`${h}Y${i}`]) s(`${h}Y${i}`, g(`${h}/OE`) ? 'Z' : g(`${h}A${i}`)); } },
  // Infineon S70GL02GS (2 Gbit, 128M x 16, A0..A26) / S29GL01GS (1 Gbit, A0..A25): parallel NOR flash, x16, 3.3 V, 100 ns.
  // Read-only here.
  // The image is a sparse Map (word address -> 16-bit word); erased words read 0xFFFF.
  S70GL02GS: { out: [...Array(16).keys()].map(i => `DQ${i}`), tri: true,
    eval(c, g, s) { const en = !g('/CE') && !g('/OE'); let a = 0; for (let i = 0; i < 27; i++) if (c.pins[`A${i}`]) a += g(`A${i}`) * 2 ** i;
      const d = c.image.has(a) ? c.image.get(a) : 0xFFFF; for (let i = 0; i < 16; i++) if (c.pins[`DQ${i}`]) s(`DQ${i}`, en ? (d >> i) & 1 : 'Z'); } },
  // 74CBTLV16211: 24-bit FET bus switch, two 12-bit halves (xAi <-> xBi while x/OE is low). Modelled A -> B: the
  // backplane D wires (A) onto a card's load lines (B) during LOAD; open (B floats) at run time.
  CBTLV16211: { out: [1, 2].flatMap(h => [...Array(12).keys()].map(i => `${h}B${i + 1}`)), tri: true,
    eval(c, g, s) { for (const h of [1, 2]) { const off = g(`${h}/OE`); for (let i = 1; i <= 12; i++) if (c.pins[`${h}B${i}`]) s(`${h}B${i}`, off ? 'Z' : g(`${h}A${i}`)); } } },
  // the same bussed network with its common pin to GND: a weak 0 (Memory card: the RAM data bus when no row is selected)
  RPACK8G: { out: sec(8).map(i => `P${i}`), weak: true,
    eval(c, g, s) { for (const i of sec(8)) s(`P${i}`, 0, true); } },
  // ---- I/O card: timer and RTC (IO-CARD.md, 2026-11-19) ----
  // TI SN74LV8154: dual 16-bit binary counter with a 32-bit storage register and an 8-bit 3-state read bus.
  // Pins (datasheet SCLS589B): CLKA, CLKB (rising-edge count clocks), CLKBEN (active low: lets CLKB count; tie to RCOA
  // for one 32-bit counter, with CLKA and CLKB tied together), RCOA (low while counter A is at full count), RCLK (rising
  // edge stores both counters into the register), CCLR (asynchronous, active low: both counters to 0), GAL/GAU/GBL/GBU
  // (active low: put that byte of the STORED register on Y0..Y7). There is no clock-enable pin. Clocks here are derived
  // nets, so the part has `edges` instead of `reg`: the harness calls edge() with the pins that rose, using the values
  // from before the edge (all of an edge's effects happen together, as in the chip).
  LV8154: { out: [...Array(8).keys()].map(i => `Y${i}`).concat(['RCOA']), tri: true, edges: { CLKA: 'rise', CLKB: 'rise', RCLK: 'rise' },
    eval(c, g, s) { const a = c.a | 0, r = c.r || 0; if (c.pins.RCOA) s('RCOA', a === 0xFFFF ? 0 : 1);
      const gs = ['GAL', 'GAU', 'GBL', 'GBU'].map(p => !g(p)); const k = gs.indexOf(true);
      // (two gates low at once is the datasheet's "don't"; the '138 here never does it once settled, and an early
      // settle pass can see unsettled gates, so the model just drives the first)
      for (let i = 0; i < 8; i++) if (c.pins[`Y${i}`]) s(`Y${i}`, k < 0 ? 'Z' : (Math.floor(r / 2 ** (8 * k)) >> i) & 1); },
    async(c, g) { if (g('CCLR')) return false; const ch = (c.a | 0) !== 0 || (c.b | 0) !== 0; c.a = 0; c.b = 0; return ch; },
    edge(c, g, rose) { if (!g('CCLR')) return; const a = c.a | 0, b = c.b | 0;
      if (rose.has('RCLK')) c.r = b * 65536 + a;
      if (rose.has('CLKA')) c.a = (a + 1) & 0xFFFF;
      if (rose.has('CLKB') && !g('CLKBEN')) c.b = (b + 1) & 0xFFFF; } },
  // CD4060B (TI / Nexperia HEF4060B): 14-stage ripple counter with oscillator. Counts on the FALLING edge of PHI1; MR
  // (active high) clears. Q1..Q3 and Q11 aren't pinned out. Here PHI1 is the oscillator node, driven by the harness
  // (the 32.768 kHz crystal is the world, not a chip); the counter is modelled as one count per falling edge.
  CD4060: { out: [4, 5, 6, 7, 8, 9, 10, 12, 13, 14].map(i => `Q${i}`), edges: { PHI1: 'fall' },
    eval(c, g, s) { const q = g('MR') ? 0 : (c.q | 0); for (const i of [4, 5, 6, 7, 8, 9, 10, 12, 13, 14]) if (c.pins[`Q${i}`]) s(`Q${i}`, (q >> (i - 1)) & 1); },
    edge(c, g, fell) { if (g('MR')) { c.q = 0; return; } if (fell.has('PHI1')) c.q = ((c.q | 0) + 1) & 0x3FFF; } },
  // TI SN74LVC07A: hex buffer with open-drain outputs. Y is pulled low when A is low, otherwise released (Z); a pull-up
  // resistor makes the wired-AND (2026-11-19: the I/O card's IORDY, one open-drain source per thing that can stall)
  LVC07: { out: sec(6).map(i => `${i}Y`), tri: true,
    eval(c, g, s) { for (const i of sec(6)) if (c.pins[`${i}Y`]) s(`${i}Y`, g(`${i}A`) ? 'Z' : 0); } },
};
P.LV164 = P.LVC164;
module.exports = { P };
