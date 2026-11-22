'use strict';
// program-lockstep.js: integration stage 2, the whole machine running real programs beside the microsim (Kehai Interim,
// 2026-11-20). MIT.
//
// The program is assembled once and put in both machines' RAM: the microsim's mem[], and the Memory card's RAM chips in
// the card's declared storage layout (MEMORY-CARD.md; the layout code is copied from cards/memory-card-test.js, marked
// below). That preload is the one declared exception: in the real machine the copy engine or a loader puts it there.
// After that the netlist runs alone. The microsim only checks; nothing it computes is fed to the netlist.
//
// Compared:
//   - every microcycle: the executing micro-address (UPC), the next address on the backplane (UA), the bus, and the
//     MODE/PRIV/IE/PROTEN lines (as lockstep.js does);
//   - every instruction boundary: all 32 register-RAM slots (read from the Registers card's RAM chips), the PC
//     register (Control card), and every memory write since the last boundary, both ways: each microsim write must be
//     in the right RAM chips with the right value, and each RAM-chip write must decode to an address the microsim
//     wrote, holding the microsim's value;
//   - at the end: a full audit of every RAM row against the microsim's memory.
// Power-up: register RAM has no reset, so its contents are undefined in hardware. Both machines start it at zero here
// (the microsim's constructor sets ULIMIT = ramSize; that slot is zeroed to match). Then both run the RESET routine
// (microsim.js, since 2026-11-20): the netlist gets there through its reset vector, the microsim is started there. It
// writes the ISA's reset values of ULIMIT and SP, so the programs need no prologue. (Before the routine existed, every
// program began with a BOOT prologue; that was finding 4 in INTEGRATION-PLAN.md.)
//
// Usage: node program-lockstep.js [directed|random] [programs] [seed]
//   MACHINE_MUTANT=Card:NAME  build the machine with one card mutant (the run must fail)
const path = require('path');
const { compose } = require('./integrate.js'); const { MachineSim } = require('./machine-sim.js');
const { MicroMachine, SLOT } = require('../microsim/microsim.js'); const { trit, rails } = require('../cards/netlist.js');
const { rowsFor } = require('../cards/memory-card.js'); const { ld, PRNUM } = require('../microsim/bare-drivers.js'); const { BareIO, SdCard } = require('../microsim/bareio.js');
const { Timing } = require('./sta.js'); const { TimingSim } = require('./timing-sim.js');
// STA=table|cycle: time every slot's settled paths (sta.js). STA_SCALE=PART:factor slows one part (a positive control).
const STA_SCALE = process.env.STA_SCALE ? Object.fromEntries([process.env.STA_SCALE.split(':').map((x, i) => i ? +x : x)]) : {}; let STA = null;
const { loadHtmlModule } = require(path.join(require('../triton-dir.js'), 'tests/t3-common.js')); const { T } = loadHtmlModule('triton3.html');

const WHICH = process.argv[2] || 'directed', NPROG = +(process.argv[3] || 1); let seed = +(process.argv[4] || 20261120) >>> 0;
const MUT = process.env.MACHINE_MUTANT ? Object.fromEntries([process.env.MACHINE_MUTANT.split(':')]) : {};
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 2 ** 32; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1)), pick = a => a[Math.floor(rnd() * a.length)];

// ---- the Memory card's declared storage layout. Lifted from cards/memory-card-test.js (Kehai Interim, 2026-11-18),
// lines 30 and 42-48, unchanged except that ROWS is passed in.
const toT = (v, n) => { const t = []; let x = v; for (let i = 0; i < n; i++) { let r = ((x % 3) + 3) % 3; if (r === 2) r = -1; t.push(r); x = (x - r) / 3; } return t; };
const sumT = (t, lo, hi) => { let r = 0; for (let i = hi - 1; i >= lo; i--) r = 3 * r + t[i]; return r; };
const loc = x => { const t = toT(x, 27), T = sumT(t, 10, 16); return { row: T >> 5, addr: (T & 31) * 65536 + (sumT(t, 5, 10) + 128) * 256 + sumT(t, 0, 5) + 128 }; };
const unloc = (row, addr) => ((addr & 255) - 128) + 243 * (((addr >> 8) & 255) - 128) + 59049 * ((row << 5) | (addr >> 16));
const enc = (v, n) => { let b = 0; toT(v, n).forEach((x, i) => { const [p, q] = rails(x); b += p * 2 ** (2 * i) + q * 2 ** (2 * i + 1); }); return b; };
const dec = (b, n) => { let x = 0; for (let i = n - 1; i >= 0; i--) { const p = Math.floor(b / 2 ** (2 * i)) & 1, q = Math.floor(b / 2 ** (2 * i + 1)) & 1; if (p && q) return NaN; x = 3 * x + trit(p, q); } return x; };
// ---- end of lift

// ---- programs. No I/O instructions here (stage 3 brings the I/O card's programs); no user mode or traps yet.
const DIRECTED = `
${ld('R1', 581130733)}
  ADDI R3, R1, #1
  SUBI R4, R3, #1
  NEG R5, R1
  SUBI R5, R5, #1
  LI R0, #0
${ld('R6', 3812798742493)}
  ADDI R6, R6, #1
  ADC R3, R1, R0
  ADD R3, R1, R1
  SUB R4, R3, R1
  MUL R5, R4, R1
  LI R1, #1234
  LI R2, #-567
  ADD R3, R1, R2
  SUB R4, R1, R2
  MUL R5, R1, R2
  LUI R6, #77
  ADDI R6, R6, #-9841
  LI R8, #5000
  ST R3, R8, #0
  ST R4, R8, #1
  SW R5, R8, #3
  LT R0, R8, #1
  LW R1, R8, #3
  PUSH R3
  PUSH R4
  POP R2
  CMP R2, R4
  JZ same
  HALT
same:
  LI R0, #5
loop:
  SUBI R0, R0, #1
  CMPI R0, #0
  JNZ loop
  CALL sub
  TMIN R7, R1, R2
  TXOR R7, R7, R5
  HALT
sub:
  ADDI R1, R1, #1
  RET
`;
function genRandom() {
  const n = ri(12, 40), lines = [];
  const R = () => 'R' + ri(0, 6), imm = () => pick([0, 1, -1, 9841, -9841, ri(-9841, 9841), ri(-50, 50)]);
  // jump targets are labels L0..Ln (line i is label Li, Ln the HALT), so a line can sit in front
  for (let i = 0; i < n; i++) { const k = rnd(), fwd = () => 'L' + ri(i + 1, n);
    if (k < 0.30) lines.push(`${pick(['ADD', 'ADC', 'SUB', 'SBC', 'TMIN', 'TMAX', 'TCON', 'TANY', 'TXOR', 'MUL', 'DIV', 'MOD'])} ${R()}, ${R()}, ${R()}`);
    else if (k < 0.42) lines.push(`${pick(['ADDI', 'SUBI', 'MULI', 'TUNARY'])} ${R()}, ${R()}, #${imm()}`);
    else if (k < 0.50) lines.push(`${pick(['LI', 'LUI'])} ${R()}, #${imm()}`);
    else if (k < 0.55) lines.push(`${pick(['MOV', 'NEG'])} ${R()}, ${R()}`);
    else if (k < 0.60) lines.push(rnd() < 0.5 ? `CMP ${R()}, ${R()}` : `CMPI ${R()}, #${imm()}`);
    else if (k < 0.62) lines.push(`${pick(['SHLI', 'SHRI'])} ${R()}, ${R()}, #${ri(-30, 30)}`);
    else if (k < 0.76) lines.push(`${pick(['LT', 'ST', 'LW', 'SW'])} ${R()}, R8, #${ri(-300, 300)}`);
    else if (k < 0.84) lines.push(rnd() < 0.5 ? `PUSH ${R()}` : `POP ${R()}`);
    else if (k < 0.94) lines.push(`${pick(['JMP', 'JN', 'JZ', 'JP', 'JNZ', 'JNP', 'JNN'])} ${fwd()}`);
    else lines.push(`CALL L${i + 1}`); }
  lines.push('HALT'); return '  LI R8, #5000\n' + lines.map((l, i) => `L${i}: ${l}`).join('\n');
}

// ---- stage 3, part 1 (2026-11-20, late): traps, user mode and protection on the whole machine. No I/O devices.
// Vector table at VBR = 9000 (13 words, ISA-4 section 4): faults (vectors 0-5) go to H, which skips the faulting
// instruction (EPC + 2) and IRETs; SYSCALL and the IRQ vectors go to HS, a supervisor HALT (a user-mode program ends
// with SYSCALL; HALT itself is privileged). KSP = 60000 so a trap from user mode has a stack. H also copies EADDR into
// R6, so the faulting address the hardware recorded is compared with every register at the next boundary.
const VBR = 9000, DATA = 5000, w3 = v => { const t0 = ((v % 19683) + 19683 + 9841) % 19683 - 9841, r = (v - t0) / 19683, t1 = ((r % 19683) + 19683 + 9841) % 19683 - 9841; return [t0, t1, (r - t1) / 19683]; };
const vectors = sym => { const out = []; for (let v = 0; v < 13; v++) { const w = w3(v <= 5 ? sym.H : sym.HS); for (let j = 0; j < 3; j++) out.push([VBR + 3 * v + j, w[j]]); } return out; };
const HANDLERS = `H: MFSPR R7, #9
  MFSPR R6, #13
  ADDI R7, R7, #2
  MTSPR R7, #9
  IRET
HS: HALT
`;
const TRAPS = `${ld('R0', VBR)}
  MTSPR R0, #5
${ld('R0', 60000)}
  MTSPR R0, #14
  LI R8, #${DATA}
${ld('R1', 581130733)}
ILL: NOP
  LI R2, #-5
  LT R3, R2, #0
  ST R1, R8, #4
  LI R3, #1
  MTSPR R3, #15
  LI R4, #0
  DIV R5, R1, R4
  MOD R5, R1, R4
  LI R3, #0
  MTSPR R3, #15
  DIV R5, R1, R4
  MTSPR R3, #6
${ld('R3', 6000)}
  MTSPR R3, #7
${ld('R3', 5998)}
  MTSPR R3, #10
  LI R3, #0
  MTSPR R3, #11
  LI R3, #spset
  MTSPR R3, #9
  IRET
spset:
  LI R3, #1
  MTSPR R3, #1
  POP R5
${ld('R4', 7000)}
  ST R1, R4, #0
${ld('R4', 5999)}
  SW R1, R4, #0
  LW R5, R8, #3
  MFSPR R6, #1
  PUSH R1
  IN R6, #40
  SYSCALL #7
${HANDLERS}`;
// ILL is patched to an unallocated opcode (56: vector 1). Then: a bad address (-5, vector 4); DIV and MOD by zero with
// TRAP_DIV0 = 1 (vector 5) and then = 0 (no trap, a defined result); user mode with [0, 6000): a store to 7000
// (vector 3) after SP = 5998 is set through IRET and a POP's third tryte (6000) faults in the same word that writes SP
// (vector 3; SP must not change), a word store at 5999 whose last tryte (6001) is outside (vector 3, the whole-word check), MFSPR and IN (vector 2), a PUSH (SP 5998, inside: no fault); SYSCALL ends it.
const trapOpts = { patch: (c, sym) => { c[sym.ILL] = 56 * 81; }, preload: vectors };
const SAFE_MTSPR = [0, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 14, 15, 15, 16, -1];   // as microsim/diff.js
function genTraps() {
  const n = ri(15, 45), lines = [], R = () => 'R' + ri(0, 6), imm = () => pick([0, 1, -1, 9841, -9841, ri(-9841, 9841), ri(-50, 50)]);
  const off = () => rnd() < 0.15 ? pick([997, 998, 999, 1000, -1001, -1002, -1000]) : ri(-2000, 2000);
  for (let i = 0; i < n; i++) { const k = rnd(), fwd = () => 'L' + ri(i + 1, n);
    if (k < 0.05) lines.push(`SYSCALL #${pick([0, 1, -3])}`);
    else if (k < 0.10) lines.push(`MFSPR ${R()}, #${ri(-1, 16)}`);
    else if (k < 0.15) lines.push(`MTSPR ${R()}, #${pick(SAFE_MTSPR)}`);
    else if (k < 0.17) lines.push('IRET');
    // (no IN/OUT: in supervisor mode they reach the devices, and the I/O wait isn't synchronized with the microsim's
    // device model yet; that is stage 3 part 2. The directed TRAPS program has IN in user mode, which traps.)
    else if (k < 0.36) lines.push(`${pick(['ADD', 'ADC', 'SUB', 'SBC', 'TMIN', 'TXOR', 'MUL', 'DIV', 'MOD', 'DIV', 'MOD'])} ${R()}, ${R()}, ${R()}`);
    else if (k < 0.45) lines.push(`${pick(['ADDI', 'SUBI', 'ADDM', 'ADDH', 'MULI', 'TUNARY'])} ${R()}, ${R()}, #${imm()}`);
    else if (k < 0.52) lines.push(`${pick(['LI', 'LUI', 'LMI', 'LHI'])} ${R()}, #${imm()}`);
    else if (k < 0.56) lines.push(rnd() < 0.5 ? `CMP ${R()}, ${R()}` : `CMPI ${R()}, #${imm()}`);
    else if (k < 0.72) lines.push(`${pick(['LT', 'ST', 'LW', 'SW', 'LDX', 'STX', 'LWX', 'SWX'])} ${R()}, ${rnd() < 0.85 ? 'R8' : R()}, #${off()}`);
    else if (k < 0.78) lines.push(rnd() < 0.5 ? `PUSH ${R()}` : `POP ${R()}`);
    else if (k < 0.88) lines.push(`${pick(['JMP', 'JN', 'JZ', 'JP', 'JNZ', 'JNP', 'JNN'])} ${fwd()}`);
    else if (k < 0.92) lines.push(`CALL L${i + 1}`);
    else lines.push(`${pick(['NEG', 'MOV'])} ${R()}, ${R()}`); }
  const user = rnd() < 0.4, ub = user ? pick([0, 0, 1000]) : 0, ul = user ? pick([60000, 6000, 50001]) : 4782969;
  const pro = [ld('R0', VBR), 'MTSPR R0, #5', ld('R0', pick([0, 60000])), 'MTSPR R0, #14', `LI R0, #${pick([0, 1])}`, 'MTSPR R0, #15',
    `LI R8, #${DATA}`, ...[0, 1, 2, 3, 4, 5, 6].map(r => ld(`R${r}`, r < 3 ? DATA + ri(-1500, 1500) : pick([ri(-3, 20), ri(-9841, 9841), ri(-3e12, 3e12), 0]))),
    ld('R7', ub), 'MTSPR R7, #6', ld('R7', ul), 'MTSPR R7, #7', ...(user ? ['LI R7, #1', 'MTSPR R7, #1'] : [])];
  const ill = rnd() < 0.3 ? ri(0, n - 1) : -1;
  const src = pro.join('\n') + '\n' + lines.map((l, i) => `L${i}: ${i === ill ? 'ILLX: ' : ''}${l}`).join('\n') + `\nL${n}: SYSCALL #0\n  HALT\n` + HANDLERS;
  const data = []; for (let a = DATA - 2100; a < DATA + 2100; a += 7) data.push([a, ri(-9841, 9841)]);   // a sparse data window
  return { src, user, opts: { capOk: true, cap: 2500, preload: sym => [...vectors(sym), ...data],
    patch: (c, sym) => { if (sym.ILLX !== undefined) c[sym.ILLX] = pick([56, 57, 80, 121, -14, -50, -121]) * 81 + ri(-4, 4) * 9 + ri(-4, 4); } } };
}

// ---- stage 3, part 2 (2026-11-21): I/O. The microsim runs BareIO (microsim/bareio.js), the model the I/O card was
// built against; the netlist's I/O card talks to the world at its pins. Declared, as in cards/io-ports-test.js: the
// microsim waits on a WAIT word exactly as long as the netlist holds IORDY low (the model has no wait of its own).
// The world's serial terminal on CON_TX: a UART receiver at 115,200 baud, sampling mid-bit from the start bit's edge.
// Lifted from cards/io-ports-test.js (Kehai Interim, 2026-11-19), uartSlot, unchanged except that errors are
// collected instead of failing the run and the slot counter is passed in.
const UB = 40e6 / 115200;
function uart() { const ux = { st: 'idle', t0: 0, k: 0, byte: 0, prev: 1, text: '', framing: 0, lastStop: 0 };
  ux.slot = (tx, G) => { if (ux.st === 'idle') { if (ux.prev === 1 && tx === 0) { ux.st = 'rx'; ux.t0 = G; ux.k = 0; ux.byte = 0; } }
    else { const due = ux.t0 + Math.round(UB * (ux.k + 0.5));
      if (G === due) { if (ux.k === 0) { if (tx !== 0) { ux.st = 'idle'; ux.framing++; } }
        else if (ux.k <= 8) ux.byte |= tx << (ux.k - 1);
        else { if (tx !== 1) ux.framing++; ux.text += String.fromCharCode(ux.byte); ux.st = 'idle'; ux.lastStop = G; }
        ux.k++; } }
    ux.prev = tx; };
  return ux; }
const say = t => [...t].map(ch => `LI R1, #${ch.charCodeAt(0)}\nOUT R1, #0`).join('\n');
const POOP = `${say('POOP OK\r\n')}\n  HALT\n`;
const CONSOLE = `${say('POOP OK\r\n')}
${[0, 7, -1, 42, -9841, 1234567].map(v => `${ld('R1', v)}\n  CALLX PRNUM\n  LI R1, #32\n  OUT R1, #0`).join('\n')}
  HALT
${PRNUM}`;


// ---- stage 3 part 2 (2026-11-21, afternoon): the timer, the RTC and timer interrupts on the whole machine.
// The program is the I/O card's own timer workload, lifted from cards/io-ports-test.js (Kehai Interim, 2026-11-19/20,
// workload C), unchanged: a snapshot reader, interrupts at periods of 23 and 5 ticks, a 1-tick period with interrupts
// off (the firings collapse into one pending IRQ), the timer off and on, a snapshot loop walking across the tick grid,
// and the ports around 48..53 that nothing answers. Here nobody stands in for the Control card: the IRQSET0 pulse goes
// over the backplane, Control's pending latch takes it, and the interrupt is taken by the real microcode. The lockstep
// compares every microcycle, so an interrupt taken one instruction early or late fails at once.
// Declared, as at card level: RTC_OSC toggles every slot (a fast test crystal; the CD4060 is the real divider), and
// the RTC chip's counter starts at RTC0 in both machines (the coin cell kept it running).
const TCOUNT = 24000, RING = 24010, RTC0 = 0x1234FFFE;
const TIMER = `
MAIN: ${ld('R1', VBR)}
MTSPR R1, #5
LI R1, #1
MTSPR R1, #3
LI R1, #1
MTSPR R1, #2
LI R6, #0
LI R7, #0
CALLX SNAPREAD
LI R1, #233
OUT R1, #50
LI R1, #255
OUT R1, #51
OUT R1, #49
LI R7, #8
OUT R7, #53
L1: CALLX SNAPREAD
${ld('R2', TCOUNT)}
LW R3, R2, #0
CMPI R3, #6
JNX L1
LI R7, #0
OUT R7, #53
LI R5, #6
L2: CALLX SNAPREAD
SUBI R5, R5, #1
CMPI R5, #0
JNZX L2
LI R1, #251
OUT R1, #50
OUT R1, #49
LI R7, #8
OUT R7, #53
L3: CALLX SNAPREAD
${ld('R2', TCOUNT)}
LW R3, R2, #0
CMPI R3, #20
JNX L3
LI R1, #0
MTSPR R1, #2
LI R1, #255
OUT R1, #50
OUT R1, #49
CALLX SNAPREAD
CALLX SNAPREAD
LI R7, #0
OUT R7, #53
LI R1, #1
MTSPR R1, #2
L4: ${ld('R2', TCOUNT)}
LW R3, R2, #0
CMPI R3, #21
JNX L4
LI R7, #0
OUT R7, #53
LI R5, #61
L5: OUT R7, #52
IN R2, #48
SUBI R5, R5, #1
CMPI R5, #0
JNZX L5
IN R1, #49
IN R1, #50
IN R1, #53
IN R1, #55
LI R1, #77
OUT R1, #48
OUT R1, #54
OUT R1, #55
LI R5, #3
L6: CALLX SNAPREAD
SUBI R5, R5, #1
CMPI R5, #0
JNZX L6
HALT
; SNAPREAD: snapshot, read the 8 stored bytes (select | enable in R7), assemble two 32-bit values, keep the last 4 pairs
SNAPREAD: PUSH R1
PUSH R2
PUSH R3
PUSH R4
OUT R7, #52
LI R4, #0
LI R3, #3
SR1: ADD R1, R3, R7
OUT R1, #53
IN R2, #48
MULI R4, R4, #256
ADD R4, R4, R2
SUBI R3, R3, #1
CMPI R3, #0
JNNX SR1
${ld('R2', RING)}
ADD R2, R2, R6
SW R4, R2, #0
LI R4, #0
LI R3, #7
SR2: ADD R1, R3, R7
OUT R1, #53
IN R2, #48
MULI R4, R4, #256
ADD R4, R4, R2
SUBI R3, R3, #1
CMPI R3, #3
JNZX SR2
${ld('R2', RING)}
ADD R2, R2, R6
SW R4, R2, #3
ADDI R6, R6, #6
CMPI R6, #24
JNX SRX
LI R6, #0
SRX: OUT R7, #53
POP R4
POP R3
POP R2
POP R1
RET
TISR: PUSH R2
PUSH R3
${ld('R2', TCOUNT)}
LW R3, R2, #0
ADDI R3, R3, #1
SW R3, R2, #0
POP R3
POP R2
IRET
`;

// ---- stage 3 part 2 (2026-11-21, evening): the SD card on the whole machine. The program is the bare drivers' own
// test (microsim/bare-drivers.js testProgram, nKeys 0): SD init, read sector 5 to RAM 20000, write RAM 21000 to sector
// 7, read sector 7 back to 22000, PRNUM after each (the console must print "0000"). The microsim runs BareIO with one
// SdCard; the machine's I/O card talks to a second SdCard, same image, at its pins (SD_MISO in; SD_MOSI, the card's
// own SCK and SD_/CS out). Compared beyond the lockstep: the SPI byte streams (MOSI:MISO pairs and chip-select changes)
// are identical, and so are both SD images at the end.
// SdPins is lifted from cards/io-ports-test.js (Kehai Interim, 2026-11-19), unchanged except that a mismatch is
// collected instead of failing the run.
const sdBad = [];
class SdPins {
  constructor(sd) { this.sd = sd; this.cs = 0; this.n = 0; this.inb = 0; this.r = 0xFF; this.log = []; }
  miso() { if (!this.cs) return 1; const r = this.n === 0 ? this.sd.peek() : this.r; return (r >> (7 - this.n)) & 1; }
  setCs(on) { if (on !== this.cs) { this.sd.setCs(on); this.cs = on; this.n = 0; this.log.push(`cs${on}`); } }
  rise(mosi) { if (this.n === 0) { this.sd.tickWrite(); this.r = this.cs ? this.sd.peek() : 0xFF; }
    this.inb = ((this.inb << 1) | mosi) & 255; if (++this.n < 8) return;
    const got = this.sd.xfer(this.inb); if (got !== this.r) sdBad.push(`SD pins: xfer answered ${got} where peek said ${this.r}`);
    this.log.push(`${this.inb}:${got}`); this.n = 0; }
}
// ---- one program on a fresh machine
const m = compose({ mutants: MUT }); const chip = new Map(m.chips.map(c => [c.ref, c]));
if (process.env.STA) STA = new Timing(m, { scale: STA_SCALE, mode: process.env.STA });   // STA=table or STA=cycle
let TS = null; if (process.env.TSIM) TS = new TimingSim(m, { scale: STA_SCALE });          // TSIM=1: the delay simulation (timing-sim.js)
const RAMSIZE = 4782969;
const ROWS = []; for (let r = 0; r < rowsFor(RAMSIZE); r++) ROWS.push([chip.get(`Memory.U${240 + 2 * r}`), chip.get(`Memory.U${241 + 2 * r}`)]);
const VT = require('../cards/video-tables.js'), VRC = chip.get('Memory.U256'), VRS = chip.get('Memory.U257');
const PIX = new Map(); for (let v = -364; v <= 364; v++) PIX.set(VT.encRails(v, 8), v);
const pixOf = e => PIX.has(e) ? PIX.get(e) : `raw ${e}`;
const vramAudit = mm => { for (let p = 0; p < VT.FB_SIZE; p++) { const e = VT.encRails(mm.vram[p], 8), ad = VT.fbAddr(p);
  if (VRC.mem[ad] !== e || VRS.mem[ad] !== e) return `VRAM audit: pixel ${p} (row ${Math.floor(p / 729)}, column ${p % 729}): VRAM-C ${pixOf(VRC.mem[ad])}, VRAM-S ${pixOf(VRS.mem[ad])}, microsim ${mm.vram[p]}`; } return null; };
const ROWREF = new Map(); ROWS.forEach(([a, b], r) => { ROWREF.set(a.ref, r); ROWREF.set(b.ref, r); });
const ramGet = x => { const { row, addr } = loc(x); if (!ROWS[row]) return NaN; return dec(ROWS[row][0].mem[addr] + ROWS[row][1].mem[addr] * 65536, 9); };
const ramPut = (x, v) => { const { row, addr } = loc(x); const b = enc(v, 9); ROWS[row][0].mem[addr] = b % 65536; ROWS[row][1].mem[addr] = Math.floor(b / 65536); };
const RFCHIPS = [10, 11, 12, 13, 14, 15, 16].map(i => chip.get(`Registers.U${i}`));
const slotVal = s => { const bits = []; for (const c of RFCHIPS) for (let i = 0; i < 8; i++) bits.push((c.mem[s] >> i) & 1); let x = 0; for (let k = 26; k >= 0; k--) x = 3 * x + trit(bits[2 * k], bits[2 * k + 1]); return x; };
const qOf = (ref, h, i) => ((chip.get(ref).q || [])[h * 9 + i] | 0);
const pcOf = () => { const b = []; for (const r of ['Control.U20', 'Control.U21', 'Control.U22']) for (const h of [1, 2]) for (let i = 0; i < 9; i++) b.push(qOf(r, h, i));
  let x = 0; for (let k = 26; k >= 0; k--) x = 3 * x + trit(b[2 * k], b[2 * k + 1]); return x; };
const ABORTED = Symbol('aborted');
const word = (v, pfx) => { let x = 0; for (let i = 9; i >= 0; i--) x = 2 * x + (v.get(`${pfx}${i}`) | 0); return x; };
const busOf = v => { let x = 0; for (let k = 26; k >= 0; k--) { const p = v.get(`D${k}+`), q = v.get(`D${k}-`); if (p && q) return NaN; x = 3 * x + trit(p, q); } return x; };

// opts.patch(trytes, symbols): change the assembled image (e.g. an unallocated opcode the assembler won't write);
// opts.preload(symbols) -> [[address, tryte], ...]: data put in RAM with the program (the same declared preload);
// opts.cap: microcycles before a program that hasn't halted counts as "ran to the cap" (a pass when opts.capOk)
function runOne(src, label, opts = {}) {
  const asm = T.assemble(src, { mode: 'T3' }), code = asm.trytes; if (opts.patch) opts.patch(code, asm.symbols);
  // fresh state on the same composed netlist: every register, RAM and status bit back to its power-up value
  for (const c of m.chips) { if (c.q) c.q = c.part === 'LVC74' ? [0, 0, 0] : []; }
  for (const [a, b] of ROWS) { a.mem.fill(0); b.mem.fill(0); } for (const c of RFCHIPS) c.mem.fill(0);
  const mm = new MicroMachine(RAMSIZE); mm.rf[SLOT.ULIMIT] = 0; mm.upc = mm.cs.addr.RESET;   // power-on: the RESET routine first
  if (opts.io) mm.io = new BareIO(mm, opts.sd ? opts.sd(mm) : new SdCard(4));
  const term = uart(); let G = 0, waited = 0, edgeNow = -1, edgePrev = -1;
  // the microsim's timer runs on this machine's slot clock (stage 3 part 2, 2026-11-21): an OUT happens at the edge
  // of the cycle just run (edgeNow), an instruction boundary is the edge before it (edgePrev), as the card-level
  // harness has them (cards/io-ports-test.js machine(): now = G + 3, boundary = G - 1, run before the slots)
  if (opts.timer) { mm.io.clk = { r0: null, now: () => edgeNow, boundary: () => edgePrev, oscFalls: s2 => Math.floor(s2 / 2) }; opts.timer(mm, () => G); }
  code.forEach((v, i) => { mm.mem[i] = v; ramPut(i, v); });
  if (opts.preload) for (const [a, v] of opts.preload(asm.symbols)) { mm.mem[a] = v; ramPut(a, v); }
  const CAP = opts.cap || 20000;
  // CPU stores to the framebuffer (FB_BASE..) live in mm.vram and in the Memory card's VRAM-C/VRAM-S (U256/U257), not
  // in main RAM; they're checked in both chips at the boundary (2026-11-21, stage 3 video)
  const mmWrites = new Set(), fbWrites = new Set(); const mw = mm.memWrite.bind(mm);
  mm.memWrite = (a, v) => { const x = mm.phys(a); if (x >= VT.FB_BASE && x < VT.FB_BASE + VT.FB_SIZE) fbWrites.add(x - VT.FB_BASE); else mmWrites.add(x); mw(a, v); };
  if (opts.vramPreload) { const vr = opts.vramPreload(); for (let p = 0; p < VT.FB_SIZE; p++) if (vr[p]) { mm.vram[p] = vr[p]; const e = VT.encRails(vr[p], 8), ad = VT.fbAddr(p); VRC.mem[ad] = e; VRS.mem[ad] = e; } }
  const s = new MachineSim(m); const POR = 12;
  for (let k = 0; k < POR; k++) s.microcycle(); s.set('POR', 0);
  let cyc = 0, instr = 0, fail = null, pendingPc = null, prevLo = null, atBoundary = false; const t0 = Date.now(); const trace = [];
  const bad = msg => { if (!fail) fail = { cyc, instr, msg }; };
  while (!fail && !mm.halted && cyc < CAP) {
    // one microcycle, slot by slot (as MachineSim.microcycle does), so the timing pass sees every slot
    let v = null; for (let j = 0; ; j++) { if (opts.timer) s.set('RTC_OSC', G & 1); if (opts.beforeSlot) opts.beforeSlot(s, G);
      const { hi, lo } = s.slot(); const last = hi.get('/CEDGE') === 0; term.slot(lo.get('CON_TX'), G++);
      if (opts.onSlot) opts.onSlot(hi, lo, G - 1, last);
      if (STA && lo.get('RESET') !== 1) STA.analyze(lo, mm.upc, { j, last });
      if (TS && prevLo && lo.get('RESET') !== 1) TS.analyze(prevLo, lo, mm.upc, { j, last }); prevLo = lo;
      if (last) { v = lo; break; } if (j > 16) throw new Error('no CPU edge'); }
    edgePrev = edgeNow; edgeNow = G - 1;
    if (v.get('RESET') === 1) continue;
    if (pendingPc !== null) { const g = pcOf(); if (g !== pendingPc) bad(`PC ${g} vs ${pendingPc}`); pendingPc = null; }
    const modeWant = { MODE: mm.mode, PRIV: mm.priv, IE: mm.ie, PROTEN: mm.protEn };
    const want = mm.upc, got = word(v, 'Control:UPC'), mu = mm.cs.store[mm.upc];
    if (mu.SEQ === 'WAIT') { mm.ioWait = v.get('IORDY') === 1 ? 0 : 1; waited += mm.ioWait; }   // declared: the card's wait
    // the devices' instruction-boundary tick: MicroMachine.step() calls io.tick() before an instruction's first cycle;
    // this harness drives cycle() directly, so it ticks here, at the same point (2026-11-21: without it the timer model
    // never raised its IRQ and the whole machine, correctly, took one the microsim didn't)
    if (opts.io && atBoundary) { mm.io.tick(); if (opts.onTick) opts.onTick(mm); atBoundary = false; }
    mm.lastBus = ABORTED; const r = mm.cycle(); cyc++;
    const aborted = mm.lastBus === ABORTED; if (aborted) mm.lastBus = undefined;
    // an instruction fetch puts the tryte on the bus (the Memory card drives it, the Control card's IR loads from it);
    // the microsim loads IR straight from memory, so the expected bus value is the tryte it fetched
    // a flag word with BUS = NONE: the ALU card drives its result on the idle bus (alu-card.js, /BUSOE), so the flag
    // tables see its sign; nobody loads it. The expected value is the microsim's ALU output.
    const flagIdle = (!mu.BUS || mu.BUS === 'NONE') && mu.FLAGS && mu.FLAGS !== 'KEEP' && !aborted;
    const lane = mu.MDR_LANE === undefined ? 0 : +mu.MDR_LANE, irFetch = mu.MEM === 'RD' && mu.LD_IR && !aborted;
    const wantNext = mm.upc, gotNext = word(v, 'UA'), wb = irFetch ? mm.IR[lane] : flagIdle ? mm.lastAlu : mm.lastBus === undefined ? 0 : mm.lastBus, gb = busOf(v);
    trace.push(`${cyc}: UPC ${got}/${want} UA ${gotNext}/${wantNext} bus ${gb}/${mm.lastBus === undefined ? '-' : mm.lastBus}`); if (trace.length > 12) trace.shift();
    if (got !== want) bad(`UPC ${got} vs upc ${want}`); else if (gotNext !== wantNext && !mm.halted) bad(`UA ${gotNext} vs next ${wantNext}`);
    // an aborted cycle (the address unit faulted it): the microsim stops before its bus; the cards still drive what the
    // word asked for (e.g. PUSH's register read), with every load and write blocked by ABORT. The bus is a don't-care
    // there; any damage would show in the registers, PC or memory at the next boundary.
    else if (gb !== wb && !aborted) bad(`bus ${gb} vs ${wb}`);
    for (const [k, x] of Object.entries(modeWant)) if (v.get(k) !== x) bad(`${k} ${v.get(k)} vs ${x}`);
    if (r === 'END') { instr++; atBoundary = true;
      for (let sl = 0; sl < 32; sl++) { const g = slotVal(sl); if (g !== mm.rf[sl]) { bad(`register slot ${sl}: ${g} vs ${mm.rf[sl]}`); break; } }
      for (const x of mmWrites) if (ramGet(x) !== mm.mem[x]) { bad(`RAM ${x}: chips ${ramGet(x)} vs ${mm.mem[x]}`); break; }
      for (const [ref, a] of s.writes) { if (!ROWREF.has(ref)) continue; const x = unloc(ROWREF.get(ref), a);
        if (!mmWrites.has(x)) { bad(`chip ${ref} wrote address ${x}, which the microsim did not write`); break; }
        if (ramGet(x) !== mm.mem[x]) { bad(`RAM ${x}: chips ${ramGet(x)} vs ${mm.mem[x]}`); break; } }
      for (const p of fbWrites) { const e = VT.encRails(mm.vram[p], 8), ad = VT.fbAddr(p);
        if (VRC.mem[ad] !== e || VRS.mem[ad] !== e) { bad(`framebuffer pixel ${p}: VRAM-C ${pixOf(VRC.mem[ad])}, VRAM-S ${pixOf(VRS.mem[ad])} vs ${mm.vram[p]}`); break; } }
      mmWrites.clear(); fbWrites.clear(); s.writes.length = 0; pendingPc = mm.pc; }
  }
  if (!fail) for (const [a, b] of ROWS) for (let i = 0; i < a.mem.length; i++) if (a.mem[i] || b.mem[i]) {
    const x = unloc(ROWREF.get(a.ref), i); if (dec(a.mem[i] + b.mem[i] * 65536, 9) !== mm.mem[x]) { fail = { cyc, instr, msg: `final audit: RAM ${x}` }; break; } }
  const capped = !fail && !mm.halted; if (capped && !opts.capOk) fail = { cyc, instr, msg: `did not halt in ${CAP} microcycles` };
  // the terminal: after HALT the last character may still be on the wire; run on until the line has been quiet for
  // two character times, then the terminal must hold exactly what the microsim's console printed
  // after HALT the machine must stay stopped (integration finding 5, 2026-11-21: HALT didn't halt; the halt latch in
  // clockgen.js): the PC and the executing micro-address frozen, no RAM written, for 64 slots (and the terminal's drain)
  // (8 slots first: the edge that ends the HALT word still happens, and parks the micro-address at FETCH, where the
  // microsim's HALT leaves its upc; that must agree too)
  let frozen = null; if (!fail && mm.halted) { for (let k = 0; k < 8; k++) { const { lo } = s.slot(); term.slot(lo.get('CON_TX'), G++); }
    frozen = { pc: pcOf(), upc: word(s.v, 'Control:UPC'), w: s.writes.length };
    // only the CPU's state counts: main RAM and the register file (the Video card's scan-out keeps writing its line
    // buffer while the CPU is halted, as it should: a halted machine still shows its screen)
    if (frozen.upc !== mm.upc) fail = { cyc, instr, msg: `halted at micro-address ${frozen.upc}, the microsim at ${mm.upc}` }; }
  if (frozen) { for (let k = 0; k < 64; k++) { const { lo } = s.slot(); term.slot(lo.get('CON_TX'), G++); } }
  if (opts.io && !fail) { let k = 0; while (k++ < 16000 && !(term.st === 'idle' && G - term.lastStop > 2 * 10 * UB)) { const { lo } = s.slot(); term.slot(lo.get('CON_TX'), G++); }
    if (term.text !== mm.io.consoleOut) fail = { cyc, instr, msg: `terminal received ${JSON.stringify(term.text)}, the microsim printed ${JSON.stringify(mm.io.consoleOut)}` };
    else if (term.framing) fail = { cyc, instr, msg: `${term.framing} framing errors` };
    console.log(`  terminal: ${JSON.stringify(term.text)} (${term.text.length} bytes, ${term.framing} framing errors); the CPU waited ${waited} microcycles on IORDY`); }
  if (frozen && !fail) { const pc = pcOf(), upc = word(s.v, 'Control:UPC');
    const cpuW = s.writes.slice(frozen.w).filter(([r]) => ROWREF.has(r) || RFCHIPS.some(c => c.ref === r));
    if (pc !== frozen.pc || upc !== frozen.upc || cpuW.length) fail = { cyc, instr, msg: `after HALT the machine kept running: PC ${frozen.pc} -> ${pc}, UPC ${frozen.upc} -> ${upc}, ${cpuW.length} main/register RAM writes (${[...new Set(cpuW.map(([r, a]) => `${r}@${a}`))].slice(0, 6).join(' ')})` }; }
  if (opts.postHalt && frozen && !fail) { const msg = opts.postHalt(() => { const r = s.slot(); G++; return r; }, mm); if (msg) fail = { cyc, instr, msg }; }
  if (opts.stats) opts.stats(mm);
  if (opts.finish && !fail) { const msg = opts.finish(mm, asm.symbols); if (msg) fail = { cyc, instr, msg }; }
  if (fail) { console.log(trace.join('\n'));
    // who drives the bus right now (diagnostics only): every chip whose output pin on a D rail is high
    const who = new Set(), v = s.v; const { P } = require('../cards/parts.js');
    for (const c of m.chips) P[c.part].eval(c, pin => v.get(c.pins[pin]) ?? 0, (pin, x) => { const n = c.pins[pin]; if (n && /^D\d+[+-]$/.test(n) && x === 1) who.add(`${c.ref}.${pin}->${n}`); }, pin => v.get(c.pins[pin]) ?? 'Z');
    console.log('bus drivers high:', [...who].slice(0, 12).join(' ') || 'none'); }
  console.log(`${label}: ${instr} instructions, ${cyc} microcycles, ${(Date.now() - t0) / 1000 | 0} s: ${fail ? `FAIL at microcycle ${fail.cyc} (instruction ${fail.instr}): ${fail.msg}` : capped ? 'match (ran to the cap)' : 'match'}`);
  return !fail;
}

if (Object.keys(MUT).length) console.log('MUTANT', JSON.stringify(MUT));
let ok = 0, n = 0;
if (WHICH === 'directed') { n = 1; ok += runOne(DIRECTED, 'directed'); }
else if (WHICH === 'traps') { n = 1; ok += runOne(TRAPS, 'traps', { ...trapOpts, stats: mm => console.log(`  traps taken: ECAUSE ${mm.sprRead(12)}, final PRIV ${mm.priv}, halted ${mm.halted}`) }); }
else if (WHICH === 'trapsrandom') for (let p = 0; p < NPROG; p++) { n++; const g = genTraps(); if (runOne(g.src, `traps ${p}${g.user ? ' (user mode)' : ''}`, g.opts)) ok++; else { console.log(g.src); break; } }
else if (WHICH === 'poop') { n = 1; ok += runOne(POOP, 'POOP OK', { io: true, cap: 20000 }); }
else if (WHICH === 'console') { n = 1; ok += runOne(CONSOLE, 'console', { io: true, cap: 60000 }); }
else if (WHICH === 'timer') { n = 1;
  const fires = [], pulses = [], edges = []; let tickSlots = 0, firstTick = null, mmRef = null;
  const opts = { io: true, timer: true, cap: 60000,
    preload: sym => [[VBR + 21, sym.TISR], [VBR + 22, 0], [VBR + 23, 0]],
    timer: (mm) => { mmRef = mm; mm.io.timer.rtc0 = RTC0; const rtc = chip.get('IO.U58'); rtc.a = RTC0 % 65536; rtc.b = Math.floor(RTC0 / 65536); rtc.r = 0;
      for (const c of m.chips) if (c.part === 'CD4060') c.q = 0; },
    onSlot: (hi, lo, g, last) => { const clk = mmRef.io.clk;
      if (clk.r0 === null && hi.get('RESET') === 0 && lo.get('RESET') === 0) clk.r0 = g;
      if (lo.get('IO:TICK') === 1) { tickSlots++; if (firstTick === null) firstTick = g; }
      if (lo.get('IO:TC4') === 1 && lo.get('IO:TICK') === 1) fires.push(g);
      if (last) { edges.push(g); if (lo.get('IRQSET0') === 1) pulses.push(g); } },
    finish: (mm) => { const tm = mm.io.timer, r0 = mm.io.clk.r0;
      if (firstTick !== r0 + 199) return `first TICK at slot ${firstTick}, expected r0 + 199 = ${r0 + 199}`;
      if (tm.fires.length !== fires.length || tm.fires.some((t, i) => t !== fires[i])) { const i = tm.fires.findIndex((t, j) => t !== fires[j]);
        return `timer firings differ at #${i}: model ${tm.fires.slice(i, i + 3)} vs machine ${fires.slice(i, i + 3)} (${tm.fires.length}/${fires.length})`; }
      let k = 0; const want = []; for (const t of fires) { while (k < edges.length && edges[k] < t + 1) k++; if (k < edges.length && want[want.length - 1] !== edges[k]) want.push(edges[k]); }
      if (want.length !== pulses.length || want.some((p, i) => p !== pulses[i])) return `IRQSET0 pulses: expected ${want.length} at the first edge after each firing, got ${pulses.length}`;
      const word = a => mm.mem[a] + 19683 * mm.mem[a + 1] + 19683 * 19683 * mm.mem[a + 2]; let found = false;
      for (let i = 0; i < 24; i += 6) if (word(RING + i) === tm.snapT && word(RING + i + 3) === tm.snapR) found = true;
      if (!found) return `the CPU's assembled values don't include the last snapshot (${tm.snapT}, ${tm.snapR})`;
      console.log(`  timer: r0 slot ${r0}, ${tickSlots} TICK slots, ${fires.length} firings = model's, ${pulses.length} IRQSET0 pulses (one per firing, first edge after), ${mm.mem[TCOUNT]} timer interrupts taken; last snapshot ticks ${tm.snapT}, RTC ${tm.snapR.toString(16)} (counted ${tm.snapR - RTC0})`); } };
  ok += runOne(TIMER, 'timer', opts); }
else if (WHICH === 'sd') { n = 1;
  const { testProgram, VBR: DVBR } = require('../microsim/bare-drivers.js');
  let sd0 = 77; const r0 = () => (sd0 = (sd0 * 1103515245 + 12345) % 2147483648) / 2147483648;
  const sector5 = Array.from({ length: 729 }, () => Math.floor(r0() * 19683) - 9841);
  const image = new SdCard(64); const bytes = new Uint8Array(1536); sector5.forEach((t, i) => { const u = t + 9841; bytes[2 * i] = u >> 8; bytes[2 * i + 1] = u & 255; }); image.data.set(bytes, 5 * 1536);
  const pattern = Array.from({ length: 729 }, (_, i) => ((i * 37) % 19683) - 9841 + (i % 3));
  let msd = null, msLog = [], msCs = 0; const pins = new SdPins((() => { const c = new SdCard(64); c.data.set(image.data); if (process.env.SD_CONTROL === 'flip9') c.data[9 * 1536 + 100] ^= 1; return c; })()); // positive control: an unread sector differs only machine-side, so only the image check can see it
  let prevSck = 0;
  const opts = { io: true, cap: 600000,
    sd: () => { msd = new SdCard(64); msd.data.set(image.data); const x = msd.xfer.bind(msd), sc = msd.setCs.bind(msd);
      msd.xfer = b => { const r = x(b); msLog.push(`${b & 255}:${r}`); return r; };
      msd.setCs = on => { const v = on ? 1 : 0; if (v !== msCs) { msCs = v; msLog.push(`cs${v}`); } sc(on); }; return msd; },
    onTick: () => pins.sd.tickWrite(),
    preload: () => pattern.map((v, i) => [21000 + i, v]),
    beforeSlot: (sim) => sim.set('SD_MISO', pins.miso()),
    onSlot: (hi, lo) => { const sck = hi.get('IO:SCK'); if (prevSck === 0 && sck === 1) pins.rise(hi.get('SD_MOSI')); prevSck = lo.get('IO:SCK');
      pins.setCs(lo.get('SD_/CS') === 0 ? 1 : 0); },
    finish: (mm) => {
      if (sdBad.length) return sdBad[0];
      if (pins.log.length !== msLog.length || pins.log.some((e, i) => e !== msLog[i])) { const i = pins.log.findIndex((e, j) => e !== msLog[j]);
        return `SPI stream differs at entry ${i}: machine ${pins.log.slice(i, i + 3)} vs microsim ${msLog.slice(i, i + 3)} (lengths ${pins.log.length}/${msLog.length})`; }
      if (!pins.sd.data.every((v, i) => v === msd.data[i])) return 'the SD images differ';
      if (mm.io.consoleOut !== '0000') return `console printed ${JSON.stringify(mm.io.consoleOut)}, expected "0000"`;
      for (let i = 0; i < 729; i++) { if (mm.mem[20000 + i] !== sector5[i]) return `sector 5 word ${i} read wrong`; if (mm.mem[22000 + i] !== pattern[i]) return `sector 7 read-back word ${i} wrong`; }
      console.log(`  SD: ${pins.log.length} SPI log entries identical (${pins.log.filter(e => !e.startsWith('cs')).length} bytes), images identical, sector 5 read, sector 7 written and read back, console "0000"`); } };
  ok += runOne(testProgram({ nKeys: 0 }), 'sd', opts); }
else if (WHICH === 'ps2') { n = 1;
  // ---- stage 3 part 2: PS/2 on the whole machine (2026-11-21, night).
  // The card-level harness froze the CPU and clocked a whole frame in at an instruction boundary. The whole machine
  // can't freeze, so here the frames are clocked in at the pins in real time by a world device per port, and the
  // DECLARED SYNC RULE is: the microsim's Ps2Port learns of a frame when the card latches it (IO:KRDY / IO:MRDY rises at
  // slot L), delivered at the first instruction boundary whose instruction's last edge B (clk.boundary(), edgePrev at
  // the tick: edgeNow there is already the edge of the FETCH about to run) has L <= B. Derived from the card's path, and
  // checked below on every frame: KRDY is a registered output, IRQSET1 pulses at the first CPU edge E >= L, the Control
  // card latches IPEND on E, and a FETCH branches on IPEND as latched at the edge before it. So an interrupt source
  // whose pulse is at edge E is taken at the first FETCH after an instruction ending at B >= E. The timer's rule is the
  // same statement: its firing slot is combinational and pulses at the first edge >= fire + 1, hence fire <= B - 1.
  // (2026-11-21, two wrong tries first, both caught by the lockstep at the first frame they got wrong: the timer's
  // formula copied as is, one instruction late when L = B, microcycle 7,431; then L <= edgeNow, one early, 3,033.) A device only starts a frame while the card isn't holding its clock low (K_HOLD /
  // M_HOLD), as a real PS/2 device waits out an inhibit. Bit timing is accelerated (half-period H slots, 50 kHz at
  // H = 400, against PS/2's 10-16.7 kHz); the card samples K_CLK on SCLK, so only the frames' place in the instruction
  // stream changes with H, and it moves anyway from frame to frame. The ps2Bits framing is lifted from
  // cards/io-ports-test.js (Kehai Interim, 2026-11-19).
  // Workload: keyboard frames by interrupt (the drivers' KBD_ISR, IRQ 1), two pairs back to back so the second of each
  // waits out the card's inhibit until the ISR reads; one bad parity. (Measured: they never wait. The card latches on
  // the 11th falling clock, mid stop bit, and the ISR reads within about 260 slots, before the stop bit ends.) The
  // mouse (IRQ 2) starts masked: its bad-parity frame latches and the card holds the clock, so the second frame waits;
  // after the keys the CPU reads the mouse status (3: ready, parity error) and unmasks IRQ 2; a small ISR here reads the
  // held byte, the card releases, the device resumes after the idle interval and the second frame comes in by
  // interrupt too. Then both status ports are read once more (0, 0).
  const { drivers, ld, KCOUNT: KC, KBUF: KB, VBR: DVBR, PRNUM: PRN } = require('../microsim/bare-drivers.js');
  const ps2Bits = (byte, parityOk) => { const d = [...Array(8).keys()].map(i => (byte >> i) & 1), ones = d.reduce((a, b) => a + b, 0);
    return [0, ...d, (ones % 2 === 0 ? 1 : 0) ^ (parityOk ? 0 : 1), 1]; };
  const H = +(process.env.PS2_H || 400), ST = 23100, MC = 23200;
  // [byte, parityOk, gap in slots after this device's previous frame ended (0 = back to back)]
  const KEYS = [[0x1C, true, 6000], [0xF0, true, 3000], [0x1C, true, 0], [0x01, false, 5000], [0xE0, true, 4000], [0x12, true, 0], [0xAA, true, 7000]];
  const MICE = [[0x5A, false, 2500], [0x33, true, 0]];
  const N = KEYS.length;
  const src = `
MAIN: ${ld('R1', DVBR)}
MTSPR R1, #5
LI R1, #2
MTSPR R1, #3
LI R1, #1
MTSPR R1, #2
WAITK: ${ld('R2', KC)}
LW R3, R2, #0
CMPI R3, #${N}
JNX WAITK
${ld('R2', ST)}
IN R1, #45
ST R1, R2, #0
LI R1, #6
MTSPR R1, #3
WAITM: ${ld('R2', MC)}
LW R3, R2, #0
CMPI R3, #2
JNX WAITM
${ld('R2', ST)}
IN R1, #45
ST R1, R2, #1
IN R1, #43
ST R1, R2, #2
HALT
MOUSE_ISR: PUSH R1
PUSH R2
PUSH R3
IN R1, #44
${ld('R2', MC)}
LW R3, R2, #0
ADD R2, R2, R3
ST R1, R2, #3
${ld('R2', MC)}
ADDI R3, R3, #1
SW R3, R2, #0
POP R3
POP R2
POP R1
IRET
${PRN}
${drivers({})}
VECS: .word #0
`;
  const mkDev = (x, list) => ({ x, list: list.slice(), cur: null, bit: 0, t: 0, clk: 1, data: 1, endAt: 0, waitedHeld: 0, idle: 0, aborts: 0, sent: [], latched: [] });
  const dev = { K: mkDev('K', KEYS), M: mkDev('M', MICE) };
  const held = { K: 0, M: 0 }, prevRdy = { K: 0, M: 0 }, pendingIn = { K: [], M: [] }, pulses = { 1: 0, 2: 0 }, msDeliv = { K: [], M: [] };
  let mmRef = null; const heldSlots = { K: 0, M: 0 }; const edgesAll = [], pulseEdges = { K: [], M: [] }, latchSlots = { K: [], M: [] };
  // A device as the PS/2 protocol has it: it starts a frame only after the clock line has been released (high) for
  // an idle interval (here H slots; the spec's 50 us at real speed); if the host pulls the clock low mid-frame, before
  // the 11th clock, it aborts and sends the same byte again once the line is idle (2026-11-21: the first version
  // started on the slot after a stop bit, before the card's synchronizer had latched, and so got inhibited mid-frame).
  const step = (d, g) => {                                   // one slot of a world PS/2 device
    if (held[d.x]) d.idle = 0; else d.idle++;
    if (d.cur && held[d.x] && d.bit < d.cur.bits.length - 1) {    // inhibited mid-frame: abort, resend later
      d.list.unshift([d.cur.b, d.cur.okp, 0]); d.sent.pop(); d.cur = null; d.clk = 1; d.data = 1; d.endAt = g; d.aborts++; return; }
    if (!d.cur) { if (!d.list.length || g < d.endAt + d.list[0][2]) return;
      if (held[d.x]) { d.waitedHeld++; return; }               // inhibited: hold the byte
      if (d.idle < H) return;
      const [b, okp] = d.list.shift(); d.cur = { b, okp, bits: ps2Bits(b, okp) }; d.bit = 0; d.t = 0; d.sent.push(b); }
    const bits = d.cur.bits; d.data = bits[d.bit]; d.clk = d.t < H ? 1 : 0;
    if (++d.t === 2 * H) { d.t = 0; if (++d.bit === bits.length) { d.cur = null; d.clk = 1; d.data = 1; d.endAt = g; } } };
  const opts = { io: true, timer: (mm) => { mmRef = mm; }, cap: 400000,
    preload: sym => [[DVBR + 24, sym.KBD_ISR], [DVBR + 25, 0], [DVBR + 26, 0], [DVBR + 27, sym.MOUSE_ISR], [DVBR + 28, 0], [DVBR + 29, 0]],
    beforeSlot: (sim, g) => { for (const x of ['K', 'M']) { const d = dev[x]; step(d, g); sim.set(`${x}_CLK`, d.clk && !held[x] ? 1 : 0); sim.set(`${x}_DATA`, d.data); } },
    onSlot: (hi, lo, g, last) => { for (const x of ['K', 'M']) { held[x] = lo.get(`IO:${x}_HOLD`) === 0 ? 1 : 0; if (held[x]) heldSlots[x]++;
        if (process.env.PS2_DEBUG && g % 4000 === 0) console.log(`  [dbg] slot ${g} ${x}: HOLD ${lo.get(`IO:${x}_HOLD`)} RDY ${lo.get(`IO:${x}RDY`)} CLK ${lo.get(`${x}_CLK`)} dev cur ${!!dev[x].cur} list ${dev[x].list.length} idle ${dev[x].idle}`); const r = lo.get(`IO:${x}RDY`);
        if (r === 1 && prevRdy[x] === 0) { const d = dev[x], b = d.sent[d.latched.length]; d.latched.push(b); latchSlots[x].push(g); pendingIn[x].push({ L: g, b, okp: (x === 'K' ? KEYS : MICE)[d.latched.length - 1][1] }); }
        prevRdy[x] = r; }
      if (last) { edgesAll.push(g); if (lo.get('IRQSET1') === 1) pulseEdges.K.push(g); if (lo.get('IRQSET2') === 1) pulseEdges.M.push(g);
        if (lo.get('IRQSET1') === 1) { pulses[1]++; if (process.env.PS2_DEBUG) console.log(`  [dbg] IRQSET1 at edge slot ${g}`); } if (lo.get('IRQSET2') === 1) pulses[2]++; } },
    onTick: (mm) => { const B = mm.io.clk.boundary();
      if (process.env.PS2_DEBUG) for (const x of ['K', 'M']) if (pendingIn[x].length) console.log(`  [dbg] tick ucycle ${mm.ucycles} upc ${mm.upc}: ${x} pending L ${pendingIn[x][0].L}, edgePrev ${mm.io.clk.boundary()}, edgeNow ${B}`);
      for (const [x, port] of [['K', mm.io.kbd], ['M', mm.io.mouse]]) while (pendingIn[x].length && pendingIn[x][0].L <= B) {
        const f = pendingIn[x].shift(); if (process.env.PS2_DEBUG) console.log(`  [dbg] ${x} latched at slot ${f.L}, delivered at boundary B ${B} (edgeNow ${mm.io.clk.now()}), microcycle ${mm.ucycles}`); port.send(f.b, mm.io.steps, f.okp); port.tick(mm.io.steps, mm); msDeliv[x].push(f.b); } },
    finish: (mm) => {
      if (dev.K.latched.length !== N || dev.K.latched.some((b, i) => b !== KEYS[i][0])) return `keyboard: the card latched ${dev.K.latched} for ${KEYS.map(k => k[0])}`;
      for (let i = 0; i < N; i++) if (mm.mem[KB + i] !== KEYS[i][0]) return `KBUF[${i}] = ${mm.mem[KB + i]}, sent ${KEYS[i][0]}`;
      for (const x of ['K', 'M']) { let k = 0; const want = latchSlots[x].map(L => { while (k < edgesAll.length && edgesAll[k] < L) k++; return edgesAll[k]; });
        if (want.length !== pulseEdges[x].length || want.some((e, i) => e !== pulseEdges[x][i])) return `${x}: IRQ pulses at edges ${pulseEdges[x]}, the rule says the first edge >= each latch: ${want}`; }
      if (pulses[1] !== N) return `${pulses[1]} IRQSET1 pulses for ${N} keyboard frames`;
      if (process.env.PS2_DEBUG) console.log(`  [dbg] held slots K ${heldSlots.K} M ${heldSlots.M}, waited K ${dev.K.waitedHeld} M ${dev.M.waitedHeld}`);
      if (dev.M.latched.length !== 2 || dev.M.latched.some((b, i) => b !== MICE[i][0]) || pulses[2] !== 2) return `mouse: latched ${dev.M.latched}, ${pulses[2]} IRQSET2 pulses (want ${MICE.map(m => m[0])}, 2)`;
      for (let i = 0; i < 2; i++) if (mm.mem[MC + 3 + i] !== MICE[i][0]) return `MBUF[${i}] = ${mm.mem[MC + 3 + i]}, sent ${MICE[i][0]}`;
      if (dev.M.list.length || held.M || dev.M.waitedHeld === 0) return 'mouse: the second frame did not wait out the inhibit and then come in';
      if (mm.mem[ST] !== 3 || mm.mem[ST + 1] !== 0 || mm.mem[ST + 2] !== 0) return `status reads: mouse ${mm.mem[ST]} then ${mm.mem[ST + 1]} (want 3 then 0), keyboard ${mm.mem[ST + 2]} (want 0)`;
      console.log(`  PS/2: ${N} keyboard frames by interrupt (KBUF ${KEYS.map(k => '0x' + k[0].toString(16)).join(' ')}), ${pulses[1]} IRQSET1 pulses; keyboard inhibit waited ${dev.K.waitedHeld} slots; ${dev.K.aborts + dev.M.aborts} mid-frame aborts;`);
      console.log(`  mouse: bad-parity frame latched while masked (status 3), the second held off ${dev.M.waitedHeld} slots, released by the ISR's read, then in by interrupt (MBUF 0x5a 0x33, statuses 0 0); H = ${H} slots`); } };
  ok += runOne(src, 'ps2', opts); }
else if (WHICH === 'video' || WHICH === 'videoscan') { n = 1;
  // ---- stage 3 part 2, the Video ports on the whole machine (2026-11-21, night). Ports 2-5 (X, Y, pixel, fill) and
  // CPU framebuffer stores (FB_BASE..), against the microsim's IOCard ports and mm.vram. The CPU waits on IORDY, which
  // the Video card now drives through U120 (found here: READY was never on IORDY).
  //   video:     an OUT 5 fill first (the whole 354,294-pixel framebuffer, about 20 ms of waiting), IN 5; then pixel
  //              writes and reads at edge coordinates (negative, wrapping, the last row and column) and out-of-range
  //              values (truncated to 6 trits); CPU stores and loads through FB_BASE; then a full audit of VRAM-C and
  //              VRAM-S against mm.vram.
  //   videoscan: a random T3 picture preloaded in mm.vram and both VRAM chips (declared, like the RAM preload), a few
  //              hundred random pixel writes and reads over it, HALT, then the machine keeps running (halted: the
  //              scan-out doesn't stop) until one whole VGA frame has been captured at the DAC and sync pins; checked
  //              with video-scan-test.js's rules, lifted below.
  const { ld } = require('../microsim/bare-drivers.js');
  let sv = WHICH === 'video' ? 5 : 6; const rv = () => (sv = (sv * 1103515245 + 12345) % 2147483648) / 2147483648;
  const ri = (lo, hi) => lo + Math.floor(rv() * (hi - lo + 1));
  const px = (x, y, v) => `${ld('R1', x)}\nOUT R1, #2\n${ld('R1', y)}\nOUT R1, #3\n${ld('R1', v)}\nOUT R1, #4\nIN R2, #4\nIN R3, #2\nIN R4, #3`;
  let body = '';
  if (WHICH === 'video') {
    const edge = [[0, 0, 1], [728, 485, -1], [729, 486, 364], [-1, -1, -364], [-730, 1000, 365], [364, 243, -365], [1, 485, 9841], [728, 0, -9841], [12345, -6789, 4321]];
    body = `LI R1, #200\nOUT R1, #5\nIN R2, #5\n` + edge.map(([x, y, v]) => px(x, y, v)).join('\n') + '\n'
      + Array.from({ length: 40 }, () => px(ri(-2000, 2000), ri(-2000, 2000), ri(-9841, 9841))).join('\n') + '\n'
      // CPU framebuffer stores and loads (VBUSY on J2), including one value that must truncate
      + [[0, 77], [729 * 100 + 5, -300], [354293, 500], [200000, 364]].map(([q, v]) => `${ld('R2', VT.FB_BASE + q)}\n${ld('R1', v)}\nST R1, R2, #0\nLT R3, R2, #0`).join('\n') + '\n'
      + `LI R1, #-77\nOUT R1, #5\nIN R2, #5\n${px(10, 10, 5)}`.replace(/OUT R1, #5\nIN R2, #5\n/, 'OUT R1, #5\nIN R2, #5\n');
  } else body = Array.from({ length: 300 }, () => px(ri(0, 728), ri(0, 485), ri(-364, 364))).join('\n');
  const src = `MAIN: ${body}\nHALT\n`;
  let pic = null; if (WHICH === 'videoscan') { pic = new Int16Array(VT.FB_SIZE); for (let p = 0; p < VT.FB_SIZE; p++) pic[p] = ri(-364, 364); }
  // ---- video-scan-test.js's frame check, lifted (Kehai Interim, 2026-11-18); changes: reads a capture array passed
  // in, T3 only (the machine boots in T3), and reports instead of pushing to its msgs
  const toT3 = (v, k) => { const t = []; let x = v; for (let i = 0; i < k; i++) { let r = ((x % 3) + 3) % 3; if (r === 2) r = -1; t.push(r); x = (x - r) / 3; } return t; };
  const expLv = (r, c, vr) => { const t = toT3(vr[r * 729 + c], 6); return [t[0] + 3 * t[1] + 4, t[2] + 3 * t[3] + 4, t[4] + 3 * t[5] + 4]; };
  const lvOf = (d, ch) => { const b = (d >> (4 * ch)) & 15; return 3 * ((b & 1) + ((b >> 1) & 1)) + ((b >> 2) & 1) + ((b >> 3) & 1); };
  const checkFrame = (cap, NS, v0, vr) => { let bad = 0, first = null; const pix = new Uint8Array(628 * 1056); const base = v0 - 601 * 1056;
    for (let r = 0; r < 486; r++) for (let c = 0; c < 729; c++) { const at = v0 + (57 + r - 601) * 1056 + 35 + c; pix[at - base] = 1; const d = cap[at] & 4095;
      const got = [0, 1, 2].map(ch => lvOf(d, ch)), e = expLv(r, c, vr); if (got.join() !== e.join()) { bad++; if (!first) first = `pixel (${r}, ${c}): levels ${got} vs ${e}`; } }
    let blankBad = 0; for (let i = 0; i < 628 * 1056; i++) if (!pix[i] && base + i < NS && base + i >= 0 && (cap[base + i] & 4095)) { blankBad++; if (!first) first = `non-black outside the picture at capture slot ${base + i}`; }
    return { bad, blankBad, first }; };
  const DACN = [...Array(12).keys()].map(i => `Video:DAC${i}`);
  let dbgN = 0; const num = (v, pre, k) => { let x = 0; for (let i = 0; i < k; i++) x += (v.get(`${pre}${i}`) | 0) * 2 ** i; return x; };
  const WN = ['Video:/LDC', 'Video:FL', 'Video:R2', 'Video:VSEL', 'Video:READY', 'Video:/LDIO', 'Video:SETFL', 'Video:CW_/IN', 'Video:CW_/OUT', 'Video:CW_/BIO'];
  let wPrev = null, wN = 0;
  const watch = (lo, g) => { const fc = [...Array(12).keys()].reduce((a, i) => a + (lo.get('Video:FC' + i) << i), 0), cur = WN.map(n => lo.get(n)).join('') + ' FC ' + fc;
    if (cur !== wPrev && wN++ < 400) console.log(`  [w] slot ${g}: ${WN.map(n => n.slice(6) + '=' + lo.get(n)).join(' ')} FC ${fc} PORT ${[0,1,2,3,4,5].reduce((a, i) => a + (lo.get('PORT' + i) << i), 0)}`); wPrev = cur; };
  const opts = { io: true, cap: WHICH === "video" ? 400000 : 150000, vramPreload: pic ? () => pic : undefined,
    onSlot: process.env.VID_WATCH ? (hi, lo, g) => watch(lo, g) : !process.env.VID_DEBUG ? undefined : (hi, lo, g, last) => { if (dbgN++ < 4 * +process.env.VID_DEBUG && (lo.get('Video:CW_/OUT') === 0 || lo.get('Video:CW_/IN') === 0 || last))
      console.log(`  [vdbg] slot ${g}${last ? ' EDGE' : ''}: D0 ${lo.get('D0+')}${lo.get('D0-')} D1 ${lo.get('D1+')}${lo.get('D1-')} D2 ${lo.get('D2+')}${lo.get('D2-')} hiD0 ${hi.get('D0+')}${hi.get('D0-')} CI ${num(lo, 'Video:CI', 10)} X ${num(lo, 'Video:X', 10)} PX ${num(lo, 'Video:PX', 12)} /OUT ${lo.get('Video:CW_/OUT')} /IN ${lo.get('Video:CW_/IN')} /CEDGE ${lo.get('/CEDGE')} PORT ${num(lo, 'PORT', 6)} UA ${num(lo, 'UA', 10)} /LDX ${lo.get('Video:/LDX')} /LDP ${lo.get('Video:/LDP')} RESET ${lo.get('RESET')} READY ${lo.get('Video:READY')} IORDY ${lo.get('IORDY')} SA ${num(lo, 'SA', 19)} /SWR ${lo.get('/SWR')} SO ${num(lo, 'SO', 12)} SI ${num(lo, 'SI', 12)} VBUSY ${lo.get('VBUSY')} UPC ${num(lo, 'Control:UPC', 0)}`); },
    postHalt: WHICH !== 'videoscan' ? undefined : (slot, mm) => {
      const MAXS = 2 * 663168 + 40000, cap = new Uint16Array(MAXS); let k = 0, v0 = -1; const t1 = Date.now();
      while (k < MAXS) { const { lo } = slot(); let d = 0; for (let i = 0; i < 12; i++) d |= lo.get(DACN[i]) << i; cap[k] = d | lo.get('Video:HSYNC') << 12 | lo.get('Video:VSYNC') << 13;
        if (k && v0 < 0 && (cap[k] >> 13 & 1) && !(cap[k - 1] >> 13 & 1) && k - 601 * 1056 >= 0) v0 = k;
        k++; if (v0 >= 0 && k >= v0 + 27 * 1056) break; if (k % 100000 === 0) process.stderr.write(`  scan capture: ${k} slots (${((Date.now() - t1) / 1000) | 0} s)\n`); }
      if (v0 < 0) return `no VSYNC with a whole frame before it in ${k} slots`;
      const hs = []; for (let i = 1; i < k; i++) if ((cap[i] >> 12 & 1) && !(cap[i - 1] >> 12 & 1)) hs.push(i);
      for (let i = 1; i < hs.length; i++) if (hs[i] - hs[i - 1] !== 1056) return `HSYNC period ${hs[i] - hs[i - 1]} at capture slot ${hs[i]}`;
      const f = checkFrame(cap, k, v0, mm.vram); if (f.bad || f.blankBad) return `scan-out frame: ${f.bad} picture pixels wrong, ${f.blankBad} border slots not black (first: ${f.first})`;
      console.log(`  scan-out: one whole frame captured after HALT (${k.toLocaleString()} slots, ${hs.length} HSYNC), all 354,294 picture pixels at the right DAC levels, the border black`); },
    finish: (mm) => { const a = vramAudit(mm); if (a) return a;
      console.log(`  VRAM-C and VRAM-S both equal the microsim's framebuffer (354,294 pixels; ${mm.vram.filter(v => v).length} non-zero); the CPU waited ${mm.io ? '' : ''}on IORDY as shown above`); } };
  ok += runOne(src, WHICH, opts); }
else if (WHICH === 'vprobe') { n = 1;   // diagnostic: IN 5 with the fill colour preset (no fill), then OUT 5 / IN 5 is NOT run
  const VTp = require('../cards/video-tables.js'), e = VTp.encRails(200, 8), u16 = chip.get('Video.U16');
  const opts = { io: true, cap: 2000, timer: (mm) => { mm.io.displayCmd = 200; u16.q = []; for (let i = 0; i < 12; i++) u16.q[i < 9 ? 9 + i : 18 + i - 9] = (e >> i) & 1; } ,
    onSlot: (hi, lo, g, last) => { if (process.env.VID_DEBUG && lo.get('Video:CW_/IN') === 0 || process.env.VID_DEBUG && last) console.log(`  [p] slot ${g}${last ? ' EDGE' : ''} /IN ${lo.get('Video:CW_/IN')} /BIO ${lo.get('Video:CW_/BIO')} VSEL ${lo.get('Video:VSEL')} SEL ${lo.get('Video:SEL0')}${lo.get('Video:SEL1')} /LDIO ${lo.get('Video:/LDIO')} /IOCE ${lo.get('Video:/IOCE')} R2 ${lo.get('Video:R2')} FC ${[...Array(12).keys()].reduce((a, i) => a + (lo.get('Video:FC' + i) << i), 0)} PORT ${[0,1,2,3,4,5].reduce((a, i) => a + (lo.get('PORT' + i) << i), 0)}`); } };
  ok += runOne(`MAIN: IN R2, #5\nIN R3, #2\nIN R4, #5\nHALT\n`, 'vprobe', opts); }
else if (WHICH === 'file') { n = 1; ok += runOne(require('fs').readFileSync(process.argv[3], 'utf8'), process.argv[3]); }
else for (let p = 0; p < NPROG; p++) { n++; const src = genRandom(); if (runOne(src, `random ${p}`)) ok++; else { console.log(src); break; } }
console.log(`program-lockstep: ${ok}/${n} programs match`);
if (TS) { const all = TS.report(), out = [];
  out.push(`timing simulation: ${TS.cycles} microcycles, ${TS.slots} slots, ${all.length} endpoints that changed; scale ${JSON.stringify(TS.scale)}`);
  out.push(`self-test: ${TS.mismatch} net values differ from machine-sim's settled values, in ${TS.mismatchSlots || 0} slots ${TS.mismatchEx.slice(0, 6).join('; ')}`);
  out.push(`clock lag (latest rise after SCLK, per clock net): ${JSON.stringify(Object.fromEntries(Object.entries(TS.lag).map(([k, x]) => [k, +x.toFixed(2)])))}`);
  const groups = {}; for (const w of all) (groups[w.capture] = groups[w.capture] || []).push(w);
  for (const [g, ws] of Object.entries(groups)) { const neg = ws.filter(w => w.slack < 0);
    out.push(`\n## captured on ${g}: ${ws.length} endpoints, ${neg.length} with negative slack; worst ${ws[0].slack.toFixed(1)} ns`);
    const seen = new Set(); let k = 0; for (const w of ws) { const sig = w.path.slice(0, -1).join(' '); if (seen.has(sig)) continue; seen.add(sig); if (k++ >= 8) break;
      out.push(`  ${w.k}: arrival ${w.arr.toFixed(1)} required ${w.req.toFixed(1)} slack ${w.slack.toFixed(1)} (µword ${w.upc}, slot ${w.slot})\n     ${w.path.join(' ')}`); } }
  const wr = TS.writeReport(), wneg = wr.filter(w => w.slack < 0);
  out.push(`\n## SRAM writes: ${TS.writes} write windows ended, ${wr.length} chip pin groups checked, ${wneg.length} with negative slack; worst ${wr.length ? wr[0].slack.toFixed(1) : '-'} ns`);
  for (const w of wr.slice(0, 10)) out.push(`  ${w.k}: last change ${w.arr.toFixed(1)}, needed by ${w.req.toFixed(1)} (window ${w.start.toFixed(1)}..${w.end.toFixed(1)}) slack ${w.slack.toFixed(1)} (µword ${w.upc})\n     ${w.path.join(' ')}`);
  out.push(`\n## write-enable races (windows under 1 ns): ${[...TS.glitch.values()].reduce((a, g) => a + g.n, 0)} on ${TS.glitch.size} chips`);
  for (const g of [...TS.glitch.values()].slice(0, 8)) out.push(`  ${g.k}: ${g.n}x, e.g. ${g.at[0]}`);
  console.log(out.join('\n'));
  if (process.env.TSIM_OUT) require('fs').writeFileSync(process.env.TSIM_OUT, JSON.stringify(all)); }
if (STA) { const { all, groups } = STA.report(); const out = [];
  out.push(`timing (${STA.mode} mode): ${STA.cycles} microcycles, ${STA.slots} slots analysed, ${all.length} endpoints reached, scale ${JSON.stringify(STA.scale)}`);
  for (const [g, ws] of Object.entries(groups)) { const neg = ws.filter(w => w.slack < 0);
    out.push(`\n## ${g}: ${ws.length} endpoints, ${neg.length} with negative slack; worst ${ws[0].slack.toFixed(1)} ns`);
    for (const w of ws.slice(0, 8)) out.push(`  ${w.k}: arrival ${w.arr.toFixed(1)} required ${w.req.toFixed(1)} slack ${w.slack.toFixed(1)} (µword ${w.upc}, slot ${w.slot})\n     ${w.path.join(' ')}`); }
  console.log(out.join('\n'));
  if (process.env.STA_OUT) require('fs').writeFileSync(process.env.STA_OUT, JSON.stringify(all.map(({ path, ...w }) => ({ ...w, path })), null, 0)); }
process.exitCode = ok === n ? 0 : 1;
