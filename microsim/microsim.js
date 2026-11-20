// microsim.js: signal-level model of the Triton card computer's microcoded datapath (Kehai Interim, 2026-11-17). MIT.
// Datapath and microword fields follow ../CONTROL-SIGNALS.md. The emulator (triton3.html / triton4.html) is the
// answer key: diff.js runs both and compares architected state after every instruction.
'use strict';

const FB_BASE = 15000000, FB_SIZE = 354294; // MMIO framebuffer (ISA-3 section 2.3)
const W27 = 3 ** 27, H27 = (W27 - 1) / 2, TM = 19683, TH = 9841;
const balRem = (x, m, h) => { let r = ((x % m) + m) % m; return r > h ? r - m : r; };
const wrap27 = x => { // exact for |x| < 2^53
  let r = x % W27; if (r > H27) r -= W27; if (r < -H27) r += W27; return r; };
const toTrits = (v, n) => { const t = []; for (let i = 0; i < n; i++) { const d = balRem(v, 3, 1); t.push(d); v = (v - d) / 3; } return t; };
const fromTrits = t => t.reduce((a, d, i) => a + d * 3 ** i, 0);
const sign = v => (v > 0) - (v < 0);
const word3 = v => { const t0 = balRem(v, TM, TH); const r = (v - t0) / TM; const t1 = balRem(r, TM, TH); return [t0, t1, (r - t1) / TM]; };

// ---------------- LUT ALU: 9 slices of 3 trits, each slice one table lookup ----------------
// Slice input: a (3 trits, -13..13), b (3 trits), cin (-1..1). Output: r (3 trits), cout.
const ALU_FNS = ['ADD', 'PASSA', 'PASSB', 'MIN', 'MAX', 'CON', 'ANY', 'XOR', 'UNARY', 'NEGA', 'INCA'];
const LUT = {};
for (const fn of ALU_FNS) {
  const tab = new Int8Array(27 * 27 * 3 * 2);
  for (let a = -13; a <= 13; a++) for (let b = -13; b <= 13; b++) for (let c = -1; c <= 1; c++) {
    let r, co = 0;
    if (fn === 'ADD') { const s = a + b + c; r = balRem(s, 27, 13); co = (s - r) / 27; }
    else if (fn === 'PASSA') r = a; else if (fn === 'PASSB') r = b;
    else if (fn === 'NEGA') r = -a;
    else if (fn === 'INCA') { const s = a + c; r = balRem(s, 27, 13); co = (s - r) / 27; }
    else { const ta = toTrits(a, 3), tb = toTrits(b, 3);
      const f = { MIN: (x, y) => Math.min(x, y), MAX: (x, y) => Math.max(x, y), CON: (x, y) => x === y ? x : 0,
        ANY: (x, y) => sign(x + y), XOR: (x, y) => balRem(x + y, 3, 1), UNARY: (x) => tb[x + 1] }[fn]; // UNARY: b holds the 3-trit truth table
      r = fromTrits(ta.map((x, i) => f(x, tb[i]))); }
    const i = (((a + 13) * 27 + (b + 13)) * 3 + (c + 1)) * 2; tab[i] = r; tab[i + 1] = co;
  }
  LUT[fn] = tab;
}
function alu(fn, A, B, cin, bcast = false) { // ripple through 9 slices exactly as the card does
  const ta = toTrits(A, 27), tb = toTrits(B, 27), tab = LUT[fn]; let c = cin, out = 0;
  for (let s = 0; s < 9; s++) {
    const sb = bcast ? 0 : s; // B_BCAST: every slice sees B's low slice (one mux per slice)
    const a = fromTrits(ta.slice(3 * s, 3 * s + 3)), b = fromTrits(tb.slice(3 * sb, 3 * sb + 3));
    const i = (((a + 13) * 27 + (b + 13)) * 3 + (c + 1)) * 2; out += tab[i] * 27 ** s; c = tab[i + 1];
  }
  return { r: out, cout: c };
}

// ---------------- microword fields (widths from CONTROL-SIGNALS.md) ----------------
const ENUM = {
  SEQ: ['NEXT', 'JUMP', 'DISPATCH', 'BR', 'BRN', 'FETCH', 'WAIT', 'HALT'],
  COND: ['SFN', 'SFZ', 'SFP', 'CFNZ', 'CNTZ', 'QTZ', 'BTOPZ', 'IORDY', 'IRQ', 'USER', 'T2', 'DIV0', 'BADADDR', 'PROT', 'ALIAS'], // BADADDR: MAR..MAR+2 not all in RAM (vector fetch)
  PC: ['NONE', 'INC', 'DEC'],
  RF_SEL: ['RD', 'RS1', 'RS2', 'CONST', 'IMM', 'SP', 'T0', 'T1', 'SPR', 'FPC'], // SPR: the SPR named by imm9 (RF slot or latch); FPC: fetch PC
  BUS: ['NONE', 'RF', 'ALU', 'MDR', 'MDR0', 'PC', 'IMM', 'CONST', 'IO', 'ZERO', 'FADDR', 'OPC', 'ESRV', 'MAR', 'IRQV'], // IRQV: 7 + the highest-priority pending enabled IRQ
  ALU_FN: ALU_FNS, CIN: ['0', 'CF', 'ONE', 'LINK'], SHIFT: ['NONE', 'L1', 'L3', 'L9', 'R1', 'R3', 'R9', 'R1C', 'R1L', 'L1L', 'R1O'],
  B_NEG: ['0', '1', 'QT'], UCNT: ['NONE', 'LOAD', 'DEC', 'INC'],
  FLAGS: ['KEEP', 'ARITH', 'CMP', 'LOGIC', 'MULHI', 'OFDIV0', 'SHOUTL', 'SHOUTR'], PSW: ['KEEP', 'ENTER', 'RESTORE'], MEM: ['IDLE', 'RD', 'WR', 'CHK3'], IO: ['IDLE', 'IN', 'OUT'],
  MDR_LANE: ['0', '1', '2', 'ALL'],
};
const FIELDS = [ // [name, bits]
  ['SEQ', 3], ['COND', 4], ['CONST', 14], ['RF_SEL', 4], ['RF_RD', 1], ['RF_WR', 1], ['BUS', 4],
  ['LD_A', 1], ['LD_B', 1], ['LD_MAR', 1], ['LD_MDR', 1], ['LD_PC', 1], ['LD_IR', 1], ['MDR_LANE', 2], ['PC', 2], ['MAR_INC', 1], ['RETIRE', 1],
  ['ALU_FN', 5], ['ALU_FN_SRC', 1], ['B_NEG', 2], ['B_BCAST', 1], ['CIN', 2], ['SHIFT', 4], ['WIDTH9', 1], ['LD_QT', 1], ['UCNT', 2],
  ['FLAGS', 3], ['PSW', 2], ['MEM', 2], ['IO', 2], ['IRQ_ACK', 1],
];
const WORD_BITS = FIELDS.reduce((a, f) => a + f[1], 0);
function encode(mu) { // pack a microinstruction into its bit fields; throws if anything doesn't fit
  let bits = 0n, pos = 0n;
  for (const [name, w] of FIELDS) {
    let v = mu[name]; if (v === undefined) v = 0;
    else if (ENUM[name]) { const k = ENUM[name].indexOf(String(v)); if (k < 0) throw new Error(`${name}=${v} not in enum`); v = k; }
    else if (typeof v === 'boolean') v = v ? 1 : 0;
    if (!(Number.isInteger(v) && v >= 0 && v < 2 ** w)) throw new Error(`${name}=${v} does not fit ${w} bits`);
    bits |= BigInt(v) << pos; pos += BigInt(w);
  }
  return bits;
}

// ---------------- microcode source ----------------
// Each instruction is a list of microinstructions. A label may be referenced as CONST (next address).
// Register RAM slots: 0..8 = R0..R8, 9 = SP, 10..25 = SPR 0..15, 26..31 = T0..T5.
const SLOT = { SP: 9, T0: 26, T1: 27, T2: 28, FPC: 30, VBR: 15, UBASE: 16, ULIMIT: 17, EPC: 19, ESP: 20, ESR: 21, ECAUSE: 22, EADDR: 23, KSP: 24 };
const U = (o) => o;
const MICRO = {
  FETCH: [U({ BUS: 'PC', LD_MAR: 1, RF_SEL: 'FPC', RF_WR: 1, SEQ: 'BR', COND: 'IRQ', CONST: 'IRQ_ENTRY' }), // FPC = own address; IRQ taken here
          U({ MEM: 'RD', LD_IR: 1, MDR_LANE: '0', MAR_INC: 1, PC: 'INC' }),
          U({ MEM: 'RD', LD_IR: 1, MDR_LANE: '1', PC: 'INC', SEQ: 'DISPATCH' })],
  HALT: [U({ SEQ: 'BR', COND: 'USER', CONST: 'TRAP_PRIV0' }), U({ SEQ: 'HALT' })],
  NOP: [U({ SEQ: 'FETCH' })],
  LI: [U({ BUS: 'IMM', RF_SEL: 'RD', RF_WR: 1, FLAGS: 'LOGIC', SEQ: 'FETCH' })],
  MOV: [U({ RF_SEL: 'RS1', RF_RD: 1, BUS: 'RF', LD_A: 1 }), U({ ALU_FN: 'PASSA', BUS: 'ALU', RF_SEL: 'RD', RF_WR: 1, FLAGS: 'LOGIC', SEQ: 'FETCH' })],
  LUI: [U({ RF_SEL: 'RD', RF_RD: 1, BUS: 'RF', LD_A: 1 }), U({ BUS: 'IMM', LD_B: 1 }),
        U({ ALU_FN: 'PASSA', SHIFT: 'L9', BUS: 'ALU', LD_A: 1 }),
        U({ ALU_FN: 'ADD', BUS: 'ALU', RF_SEL: 'RD', RF_WR: 1, FLAGS: 'LOGIC', SEQ: 'FETCH' })],
  LMI: [U({ RF_SEL: 'RD', RF_RD: 1, BUS: 'RF', LD_MDR: 1, MDR_LANE: 'ALL' }), U({ BUS: 'IMM', LD_MDR: 1, MDR_LANE: '1' }),
        U({ BUS: 'MDR', RF_SEL: 'RD', RF_WR: 1, FLAGS: 'LOGIC', SEQ: 'FETCH' })],
  LHI: [U({ RF_SEL: 'RD', RF_RD: 1, BUS: 'RF', LD_MDR: 1, MDR_LANE: 'ALL' }), U({ BUS: 'IMM', LD_MDR: 1, MDR_LANE: '2' }),
        U({ BUS: 'MDR', RF_SEL: 'RD', RF_WR: 1, FLAGS: 'LOGIC', SEQ: 'FETCH' })],
  NEG: [U({ RF_SEL: 'RS1', RF_RD: 1, BUS: 'RF', LD_B: 1 }), U({ ALU_FN: 'PASSB', B_NEG: 1, BUS: 'ALU', RF_SEL: 'RD', RF_WR: 1, FLAGS: 'LOGIC', SEQ: 'FETCH' })],
};
// arithmetic family: [name, B source ('RS2'|'IMM'|'IMM_M'|'IMM_H'), negate, carry-in, write rd?]
for (const [name, bsrc, neg, cin, write] of [
  ['ADD', 'RS2', 0, '0', 1], ['ADDI', 'IMM', 0, '0', 1], ['ADC', 'RS2', 0, 'CF', 1], ['SUB', 'RS2', 1, '0', 1], ['SUBI', 'IMM', 1, '0', 1],
  ['SBC', 'RS2', 1, 'CF', 1], ['CMP', 'RS2', 1, '0', 0], ['CMPI', 'IMM', 1, '0', 0], ['ADDM', 'IMM_M', 0, '0', 1], ['ADDH', 'IMM_H', 0, '0', 1]]) {
  const loadB = bsrc === 'RS2' ? [U({ RF_SEL: 'RS2', RF_RD: 1, BUS: 'RF', LD_B: 1 })]
    : bsrc === 'IMM' ? [U({ BUS: 'IMM', LD_B: 1 })]
    : [U({ BUS: 'IMM', LD_B: 1 }), U({ ALU_FN: 'PASSB', SHIFT: 'L9', BUS: 'ALU', LD_B: 1 }),
       ...(bsrc === 'IMM_H' ? [U({ ALU_FN: 'PASSB', SHIFT: 'L9', BUS: 'ALU', LD_B: 1 })] : [])];
  MICRO[name] = [U({ RF_SEL: 'RS1', RF_RD: 1, BUS: 'RF', LD_A: 1 }), ...loadB,
    U({ ALU_FN: 'ADD', B_NEG: neg, CIN: cin, BUS: 'ALU', ...(write ? { RF_SEL: 'RD', RF_WR: 1 } : {}), FLAGS: write ? 'ARITH' : 'CMP', SEQ: 'FETCH' })];
}
for (const [name, fn] of [['TMIN', 'MIN'], ['TMAX', 'MAX']])
  MICRO[name] = [U({ RF_SEL: 'RS1', RF_RD: 1, BUS: 'RF', LD_A: 1 }), U({ RF_SEL: 'RS2', RF_RD: 1, BUS: 'RF', LD_B: 1 }),
    U({ ALU_FN: fn, BUS: 'ALU', RF_SEL: 'RD', RF_WR: 1, FLAGS: 'LOGIC', SEQ: 'FETCH' })];
const EA = [U({ RF_SEL: 'RS1', RF_RD: 1, BUS: 'RF', LD_A: 1 }), U({ BUS: 'IMM', LD_B: 1 }), U({ ALU_FN: 'ADD', BUS: 'ALU', LD_MAR: 1 })];
for (const n of ['LT', 'LDX']) MICRO[n] = [...EA, U({ MEM: 'RD', MDR_LANE: '0' }), U({ BUS: 'MDR0', RF_SEL: 'RD', RF_WR: 1, FLAGS: 'LOGIC', SEQ: 'FETCH' })];
for (const n of ['ST', 'STX']) MICRO[n] = [...EA, U({ RF_SEL: 'RD', RF_RD: 1, BUS: 'RF', LD_MDR: 1, MDR_LANE: 'ALL' }), U({ MEM: 'WR', MDR_LANE: '0', SEQ: 'FETCH' })];
for (const n of ['LW', 'LWX']) MICRO[n] = [...EA, U({ MEM: 'RD', MDR_LANE: '0', MAR_INC: 1 }), U({ MEM: 'RD', MDR_LANE: '1', MAR_INC: 1 }), U({ MEM: 'RD', MDR_LANE: '2' }),
  U({ BUS: 'MDR', RF_SEL: 'RD', RF_WR: 1, FLAGS: 'LOGIC', SEQ: 'FETCH' })];
for (const n of ['SW', 'SWX']) MICRO[n] = [...EA, U({ RF_SEL: 'RD', RF_RD: 1, BUS: 'RF', LD_MDR: 1, MDR_LANE: 'ALL', MEM: 'CHK3' }),
  U({ MEM: 'WR', MDR_LANE: '0', MAR_INC: 1 }), U({ MEM: 'WR', MDR_LANE: '1', MAR_INC: 1 }), U({ MEM: 'WR', MDR_LANE: '2', SEQ: 'FETCH' })];
// Word pushes: MAR = SP-3, the address unit checks all three trytes (CHK3) in the cycle that loads MDR, and SP is
// written only after the check passed (a failed check aborts the instruction with nothing changed, as the emulator).
const PUSH_FROM = (src, lane1extra = {}) => [U({ RF_SEL: 'SP', RF_RD: 1, BUS: 'RF', LD_A: 1 }), U({ BUS: 'CONST', CONST: 3, LD_B: 1 }),
  U({ ALU_FN: 'ADD', B_NEG: 1, BUS: 'ALU', LD_MAR: 1 }), U({ ...src, MEM: 'CHK3' }),
  U({ MEM: 'WR', MDR_LANE: '0', MAR_INC: 1, ALU_FN: 'ADD', B_NEG: 1, BUS: 'ALU', RF_SEL: 'SP', RF_WR: 1 }),
  U({ MEM: 'WR', MDR_LANE: '1', MAR_INC: 1, ...lane1extra })];
MICRO.PUSH = [...PUSH_FROM(U({ RF_SEL: 'RS1', RF_RD: 1, BUS: 'RF', LD_MDR: 1, MDR_LANE: 'ALL' })), U({ MEM: 'WR', MDR_LANE: '2', SEQ: 'FETCH' })];
MICRO.CALL = [...PUSH_FROM(U({ BUS: 'PC', LD_MDR: 1, MDR_LANE: 'ALL' })), U({ MEM: 'WR', MDR_LANE: '2', BUS: 'IMM', LD_PC: 1, SEQ: 'FETCH' })];
MICRO.CALLX = [...PUSH_FROM(U({ BUS: 'PC', LD_MDR: 1, MDR_LANE: 'ALL' }), { BUS: 'PC', LD_A: 1 }), U({ MEM: 'WR', MDR_LANE: '2', BUS: 'IMM', LD_B: 1 }),
  U({ ALU_FN: 'ADD', BUS: 'ALU', LD_PC: 1, SEQ: 'FETCH' })];
const POP_TO = (last) => [U({ RF_SEL: 'SP', RF_RD: 1, BUS: 'RF', LD_MAR: 1, LD_A: 1 }), U({ MEM: 'RD', MDR_LANE: '0', MAR_INC: 1, BUS: 'CONST', CONST: 3, LD_B: 1 }),
  U({ MEM: 'RD', MDR_LANE: '1', MAR_INC: 1 }), U({ MEM: 'RD', MDR_LANE: '2', ALU_FN: 'ADD', BUS: 'ALU', RF_SEL: 'SP', RF_WR: 1 }), last];
MICRO.POP = POP_TO(U({ BUS: 'MDR', RF_SEL: 'RD', RF_WR: 1, FLAGS: 'LOGIC', SEQ: 'FETCH' }));
MICRO.RET = POP_TO(U({ BUS: 'MDR', LD_PC: 1, SEQ: 'FETCH' }));
MICRO.JMP = [U({ BUS: 'IMM', LD_PC: 1, SEQ: 'FETCH' })];
MICRO.JR = [U({ RF_SEL: 'RS1', RF_RD: 1, BUS: 'RF', LD_PC: 1, SEQ: 'FETCH' })];
MICRO.JMPX = [U({ BUS: 'PC', LD_A: 1 }), U({ BUS: 'IMM', LD_B: 1 }), U({ ALU_FN: 'ADD', BUS: 'ALU', LD_PC: 1, SEQ: 'FETCH' })];
// conditional jumps: skip (back to fetch) unless the condition holds
for (const [n, seq, cond] of [['JN', 'BRN', 'SFN'], ['JZ', 'BRN', 'SFZ'], ['JP', 'BRN', 'SFP'], ['JNZ', 'BR', 'SFZ'], ['JNP', 'BR', 'SFP'], ['JNN', 'BR', 'SFN']]) {
  MICRO[n] = [U({ SEQ: seq, COND: cond, CONST: 'FETCH' }), U({ BUS: 'IMM', LD_PC: 1, SEQ: 'FETCH' })];
  MICRO[n + 'X'] = [U({ SEQ: seq, COND: cond, CONST: 'FETCH', BUS: 'PC', LD_A: 1 }), U({ BUS: 'IMM', LD_B: 1 }), U({ ALU_FN: 'ADD', BUS: 'ALU', LD_PC: 1, SEQ: 'FETCH' })];
}
MICRO.JALR = [U({ RF_SEL: 'RS1', RF_RD: 1, BUS: 'RF', LD_A: 1 }), U({ BUS: 'IMM', LD_B: 1 }), U({ ALU_FN: 'ADD', BUS: 'ALU', RF_SEL: 'CONST', CONST: SLOT.T0, RF_WR: 1 }),
  U({ BUS: 'PC', RF_SEL: 'RD', RF_WR: 1, FLAGS: 'LOGIC' }), U({ RF_SEL: 'CONST', CONST: SLOT.T0, RF_RD: 1, BUS: 'RF', LD_PC: 1, SEQ: 'FETCH' })];
// BCOPY rd(dst), rs1(src), rs2(count): one tryte per instruction step, re-executed until count = 0 (as the emulator).
// New values go to temporaries first, then are written rd, rs1, rs2 in that order, so aliased registers end as in the emulator.
MICRO.BCOPY_SLOW = [
  U({ RF_SEL: 'RS2', RF_RD: 1, BUS: 'RF', LD_A: 1, FLAGS: 'LOGIC' }),
  U({ RF_SEL: 'RS1', RF_RD: 1, BUS: 'RF', LD_MAR: 1, SEQ: 'BRN', COND: 'SFP', CONST: 'BC_ZERO' }),
  U({ MEM: 'RD', MDR_LANE: '0', BUS: 'CONST', CONST: 1, LD_B: 1 }),
  U({ RF_SEL: 'RD', RF_RD: 1, BUS: 'RF', LD_MAR: 1 }),
  U({ MEM: 'WR', MDR_LANE: '0', ALU_FN: 'ADD', B_NEG: 1, BUS: 'ALU', RF_SEL: 'CONST', CONST: SLOT.T0, RF_WR: 1, FLAGS: 'LOGIC' }),
  U({ RF_SEL: 'RS1', RF_RD: 1, BUS: 'RF', LD_A: 1 }), U({ ALU_FN: 'ADD', BUS: 'ALU', RF_SEL: 'CONST', CONST: SLOT.T1, RF_WR: 1 }),
  U({ RF_SEL: 'RD', RF_RD: 1, BUS: 'RF', LD_A: 1 }), U({ ALU_FN: 'ADD', BUS: 'ALU', RF_SEL: 'RD', RF_WR: 1 }),
  U({ RF_SEL: 'CONST', CONST: SLOT.T1, RF_RD: 1, BUS: 'RF', LD_A: 1 }), U({ ALU_FN: 'PASSA', BUS: 'ALU', RF_SEL: 'RS1', RF_WR: 1 }),
  U({ RF_SEL: 'CONST', CONST: SLOT.T0, RF_RD: 1, BUS: 'RF', LD_A: 1 }), U({ ALU_FN: 'PASSA', BUS: 'ALU', RF_SEL: 'RS2', RF_WR: 1, SEQ: 'BRN', COND: 'SFP', CONST: 'FETCH' }),
  U({ BUS: 'PC', LD_A: 1 }), U({ BUS: 'CONST', CONST: 2, LD_B: 1 }), U({ ALU_FN: 'ADD', B_NEG: 1, BUS: 'ALU', LD_PC: 1, SEQ: 'FETCH' }),
];
// BCOPY fast path (registers distinct): the loop stays inside the instruction. Between trytes PC holds the
// instruction's own address (as the emulator's re-execution leaves it); each pass RETIREs one step; with an IRQ
// pending it goes back to fetch instead, which re-runs BCOPY after the interrupt.
const RD = (sel) => ({ RF_SEL: sel, RF_RD: 1, BUS: 'RF' });
// Entry guard (once per BCOPY entry, not per tryte): if the destination range [dst, dst+cnt-1] covers the
// instruction's own two trytes, the copy rewrites BCOPY itself and the emulator would refetch the new code, so
// take the slow (refetching) path. Found by the differential: self-modifying copy diverged without this.
MICRO.BCOPY = [
  U({ ...RD('RS2'), LD_A: 1, FLAGS: 'LOGIC', SEQ: 'BR', COND: 'ALIAS', CONST: 'BCOPY_SLOW' }),
  U({ ...RD('RS1'), LD_MAR: 1, SEQ: 'BRN', COND: 'SFP', CONST: 'BC_ZERO' }),
  U({ ...RD('RD'), LD_A: 1 }),                                                    // A = dst
  U({ BUS: 'PC', LD_B: 1 }),                                                      // B = PC = own address + 2
  U({ ALU_FN: 'ADD', B_NEG: 1, FLAGS: 'ARITH' }),                                 // sign(dst - PC)
  U({ ...RD('RS2'), LD_B: 1, SEQ: 'BRN', COND: 'SFN', CONST: 'BC_OK' }),          // dst >= PC: range starts past us
  U({ ALU_FN: 'ADD', BUS: 'ALU', LD_A: 1 }),                                      // A = dst + cnt
  U({ BUS: 'PC', LD_B: 1 }),
  U({ ALU_FN: 'ADD', B_NEG: 1, CIN: 'ONE', FLAGS: 'ARITH' }),                     // dst + cnt - PC + 1
  U({ SEQ: 'BRN', COND: 'SFN', CONST: 'BCOPY_SLOW' }),                            // >= 0: overlaps our own trytes
];
MICRO.BC_OK = [
  U({ ...RD('RS2'), LD_A: 1 }),
  U({ MEM: 'RD', MDR_LANE: '0', BUS: 'CONST', CONST: 1, LD_B: 1, PC: 'DEC' }),
  U({ ...RD('RD'), LD_MAR: 1, PC: 'DEC' }),
];
MICRO.BC_BODY = [
  U({ MEM: 'WR', MDR_LANE: '0', ALU_FN: 'ADD', B_NEG: 1, BUS: 'ALU', RF_SEL: 'RS2', RF_WR: 1, FLAGS: 'LOGIC' }), // cnt-1
  U({ ...RD('RS1'), LD_A: 1, SEQ: 'BRN', COND: 'SFP', CONST: 'BC_FIN' }),
  U({ ALU_FN: 'ADD', BUS: 'ALU', RF_SEL: 'RS1', RF_WR: 1 }),
  U({ ...RD('RD'), LD_A: 1 }),
  U({ ALU_FN: 'ADD', BUS: 'ALU', RF_SEL: 'RD', RF_WR: 1, RETIRE: 1, SEQ: 'BRN', COND: 'IRQ', CONST: 'BC_LOOP' }),
  U({ SEQ: 'FETCH' }),
];
MICRO.BC_LOOP = [
  U({ ...RD('RS2'), LD_A: 1, FLAGS: 'LOGIC' }),
  U({ ...RD('RS1'), LD_MAR: 1 }),
  U({ MEM: 'RD', MDR_LANE: '0' }),
  U({ ...RD('RD'), LD_MAR: 1, SEQ: 'JUMP', CONST: 'BC_BODY' }),
];
MICRO.BC_FIN = [
  U({ ALU_FN: 'ADD', BUS: 'ALU', RF_SEL: 'RS1', RF_WR: 1, PC: 'INC' }),
  U({ ...RD('RD'), LD_A: 1, PC: 'INC' }),
  U({ ALU_FN: 'ADD', BUS: 'ALU', RF_SEL: 'RD', RF_WR: 1, SEQ: 'FETCH' }),
];
MICRO.BC_ZERO = [U({ BUS: 'ZERO', RF_SEL: 'RS2', RF_WR: 1, FLAGS: 'LOGIC', SEQ: 'FETCH' })];


// ---- tritwise (one LUT pass) ----
for (const [name, fn] of [['TCON', 'CON'], ['TANY', 'ANY'], ['TXOR', 'XOR']])
  MICRO[name] = [U({ ...RD('RS1'), LD_A: 1 }), U({ ...RD('RS2'), LD_B: 1 }), U({ ALU_FN: fn, BUS: 'ALU', RF_SEL: 'RD', RF_WR: 1, FLAGS: 'LOGIC', SEQ: 'FETCH' })];
MICRO.TUNARY = [U({ ...RD('RS1'), LD_A: 1 }), U({ BUS: 'IMM', LD_B: 1 }),
  U({ ALU_FN: 'UNARY', B_BCAST: 1, BUS: 'ALU', RF_SEL: 'RD', RF_WR: 1, FLAGS: 'LOGIC', SEQ: 'FETCH' })];

// ---- MUL / MULI: 27 steps, least significant multiplier trit first. B = multiplicand; T2 = multiplier;
// (T0:T1) = 54-trit product. Each step: P_hi += digit*X, then the pair shifts right one trit (R1C keeps the carry
// as the 28th trit, the trit falling out of P_hi enters P_lo's top through LINK). Balanced: no sign fix-up. ----
const T0 = SLOT.T0, T1 = SLOT.T1, T2s = SLOT.T2, T3s = 29;
const sel = slot => slot === T0 ? { RF_SEL: 'T0' } : slot === T1 ? { RF_SEL: 'T1' } : { RF_SEL: 'CONST', CONST: slot };
const W = (slot, extra) => U({ ...sel(slot), RF_WR: 1, ...extra });
const R_ = (slot, extra) => U({ ...sel(slot), RF_RD: 1, BUS: 'RF', ...extra });
// MUL runs 27 passes. MULI's multiplier is imm9 (9 trits): 9 passes, then the remaining 18 all-zero passes are
// replaced by wiring: low = (P_hi << 9, top 9 dropped) + (P_lo >> 18), high = P_hi >> 18.
function mulRoutines(P, passes, tail) {
  const L = x => P + '_' + x;
  MICRO[L('C')] = [U({ ALU_FN: 'PASSA', BUS: 'ALU', ...W(T2s) }), U({ BUS: 'ZERO', ...W(T0) }), U({ BUS: 'ZERO', ...W(T1) }),
    U({ BUS: 'CONST', CONST: passes, UCNT: 'LOAD' })];
  MICRO[L('LOOP')] = [
    R_(T2s, { LD_A: 1 }),
    U({ ALU_FN: 'PASSA', SHIFT: 'R1', BUS: 'ALU', ...W(T2s), LD_QT: 1 }),            // next digit -> QT
    R_(T0, { LD_A: 1, SEQ: 'BR', COND: 'QTZ', CONST: L('SKIP') }),
    U({ ALU_FN: 'ADD', B_NEG: 'QT', SHIFT: 'R1C', BUS: 'ALU', ...W(T0) }),
  ];
  MICRO[L('LO')] = [R_(T1, { LD_A: 1 }), U({ ALU_FN: 'PASSA', SHIFT: 'R1L', BUS: 'ALU', ...W(T1), UCNT: 'DEC' }),
    U({ SEQ: 'BRN', COND: 'CNTZ', CONST: L('LOOP') })];
  if (tail) MICRO[L('TAIL')] = [
    R_(T1, { LD_A: 1 }), U({ ALU_FN: 'PASSA', SHIFT: 'R9', BUS: 'ALU', LD_A: 1 }), U({ ALU_FN: 'PASSA', SHIFT: 'R9', BUS: 'ALU', ...W(T1) }),
    R_(T0, { LD_A: 1 }), U({ ALU_FN: 'PASSA', SHIFT: 'L9', BUS: 'ALU', LD_B: 1 }),
    R_(T1, { LD_A: 1 }), U({ ALU_FN: 'ADD', BUS: 'ALU', ...W(T1) }),
    R_(T0, { LD_A: 1 }), U({ ALU_FN: 'PASSA', SHIFT: 'R9', BUS: 'ALU', LD_A: 1 }), U({ ALU_FN: 'PASSA', SHIFT: 'R9', BUS: 'ALU', ...W(T0) })];
  MICRO[L('END')] = [R_(T1, { LD_A: 1 }), U({ ALU_FN: 'PASSA', BUS: 'ALU', RF_SEL: 'RD', RF_WR: 1, FLAGS: 'LOGIC' }),
    R_(T0, { FLAGS: 'MULHI', SEQ: 'FETCH' })];
  MICRO[L('SKIP')] = [U({ ALU_FN: 'PASSA', SHIFT: 'R1C', BUS: 'ALU', ...W(T0), SEQ: 'JUMP', CONST: L('LO') })];
}
MICRO.MUL = [U({ ...RD('RS1'), LD_B: 1 }), U({ ...RD('RS2'), LD_A: 1 })];
mulRoutines('MUL', 27, false);
MICRO.MULI = [U({ ...RD('RS1'), LD_B: 1 }), U({ BUS: 'IMM', LD_A: 1 })];
mulRoutines('MULI', 9, true);

// ---- DIV / MOD: magnitudes, divisor aligned left (shift while its top trit is 0), then one quotient digit per
// position by repeated subtraction (0..2 times), Q = 3Q + digit, divisor shifted back right (exact). Truncating,
// remainder takes the dividend's sign, as the emulator. T0 = r, T1 = Q, T3 = original a. ----
for (const isMod of [false, true]) {
  const N = isMod ? 'MOD' : 'DIV', L = x => N + '_' + x;
  MICRO[N] = [
    U({ ...RD('RS2'), LD_B: 1, FLAGS: 'LOGIC' }),                       // B = b, SF = sign b
    U({ ...RD('RS1'), LD_A: 1, SEQ: 'BR', COND: 'SFZ', CONST: L('Z') }), // A = a; b == 0 ->
    U({ SEQ: 'BRN', COND: 'SFN', CONST: L('B') }),
    U({ ALU_FN: 'PASSB', B_NEG: 1, BUS: 'ALU', LD_B: 1 }),              // B = |b|
  ];
  MICRO[L('B')] = [
    U({ ALU_FN: 'PASSA', BUS: 'ALU', ...W(T3s), FLAGS: 'LOGIC' }),      // T3 = a, SF = sign a
    U({ SEQ: 'BR', COND: 'SFZ', CONST: L('A0') }),
    U({ SEQ: 'BRN', COND: 'SFN', CONST: L('ABS') }),
    U({ ALU_FN: 'NEGA', BUS: 'ALU', LD_A: 1 }),
  ];
  MICRO[L('ABS')] = [U({ ALU_FN: 'PASSA', BUS: 'ALU', ...W(T0) }), U({ BUS: 'ZERO', ...W(T1) }), U({ BUS: 'ZERO', UCNT: 'LOAD' })];
  MICRO[L('AL')] = [U({ SEQ: 'BRN', COND: 'BTOPZ', CONST: L('DIG') }),
    U({ ALU_FN: 'PASSB', SHIFT: 'L1', BUS: 'ALU', LD_B: 1, UCNT: 'INC', SEQ: 'JUMP', CONST: L('AL') })];
  MICRO[L('DIG')] = [R_(T1, { LD_A: 1 }), U({ ALU_FN: 'PASSA', SHIFT: 'L1', BUS: 'ALU', ...W(T1) }), R_(T0, { LD_A: 1 })];
  MICRO[L('TRY')] = [U({ ALU_FN: 'ADD', B_NEG: 1, FLAGS: 'ARITH' }), U({ SEQ: 'BR', COND: 'SFN', CONST: L('NXT') }),
    U({ ALU_FN: 'ADD', B_NEG: 1, BUS: 'ALU', ...W(T0) }), R_(T1, { LD_A: 1 }), U({ ALU_FN: 'INCA', CIN: 'ONE', BUS: 'ALU', ...W(T1) }),
    R_(T0, { LD_A: 1, SEQ: 'JUMP', CONST: L('TRY') })];
  MICRO[L('NXT')] = [U({ SEQ: 'BR', COND: 'CNTZ', CONST: L('END') }),
    U({ ALU_FN: 'PASSB', SHIFT: 'R1', BUS: 'ALU', LD_B: 1, UCNT: 'DEC', SEQ: 'JUMP', CONST: L('DIG') })];
  MICRO[L('END')] = isMod
    ? [R_(T3s, { FLAGS: 'LOGIC' }), R_(T0, { LD_A: 1, SEQ: 'BRN', COND: 'SFN', CONST: L('W') }), U({ ALU_FN: 'NEGA', BUS: 'ALU', LD_A: 1 })]
    : [U({ ...RD('RS2'), FLAGS: 'LOGIC' }), R_(T1, { LD_A: 1, SEQ: 'BRN', COND: 'SFN', CONST: L('S2') }), U({ ALU_FN: 'NEGA', BUS: 'ALU', LD_A: 1 })];
  if (!isMod) MICRO[L('S2')] = [R_(T3s, { FLAGS: 'LOGIC' }), U({ SEQ: 'BRN', COND: 'SFN', CONST: L('W') }), U({ ALU_FN: 'NEGA', BUS: 'ALU', LD_A: 1 })];
  MICRO[L('W')] = [U({ ALU_FN: 'PASSA', BUS: 'ALU', RF_SEL: 'RD', RF_WR: 1, FLAGS: 'LOGIC', SEQ: 'FETCH' })];
  MICRO[L('A0')] = [U({ BUS: 'ZERO', RF_SEL: 'RD', RF_WR: 1, FLAGS: 'LOGIC', SEQ: 'FETCH' })];
  MICRO[L('Z')] = isMod   // divide by zero: traps (vector 5) if TRAP_DIV0, else rd = a (MOD) or 0 (DIV); OF = sign a, or 1
    ? [U({ SEQ: 'BR', COND: 'DIV0', CONST: 'TRAP_DIV0' }), U({ ALU_FN: 'PASSA', BUS: 'ALU', RF_SEL: 'RD', RF_WR: 1, FLAGS: 'LOGIC' }), U({ ALU_FN: 'PASSA', BUS: 'ALU', FLAGS: 'OFDIV0', SEQ: 'FETCH' })]
    : [U({ SEQ: 'BR', COND: 'DIV0', CONST: 'TRAP_DIV0' }), U({ BUS: 'ZERO', RF_SEL: 'RD', RF_WR: 1, FLAGS: 'LOGIC' }), U({ ALU_FN: 'PASSA', BUS: 'ALU', FLAGS: 'OFDIV0', SEQ: 'FETCH' })];
}


// ---- BFILL rd(dst), rs1(value), rs2(count): writes value's low tryte, one per step. Fast path (registers distinct,
// range not covering its own instruction): value sits in MDR lane 0 for the whole fill; the count is decremented
// first so the continue/finish decision is ready one cycle later; 4 µcycles per tryte in steady state. ----
MICRO.BFILL = [
  U({ ...RD('RS2'), LD_A: 1, FLAGS: 'LOGIC', SEQ: 'BR', COND: 'ALIAS', CONST: 'BF_SLOW' }),
  U({ ...RD('RS1'), LD_MDR: 1, MDR_LANE: 'ALL', SEQ: 'BRN', COND: 'SFP', CONST: 'BF_ZERO' }),
  U({ ...RD('RD'), LD_A: 1 }),
  U({ BUS: 'PC', LD_B: 1 }),
  U({ ALU_FN: 'ADD', B_NEG: 1, FLAGS: 'ARITH' }),
  U({ ...RD('RS2'), LD_B: 1, SEQ: 'BRN', COND: 'SFN', CONST: 'BF_OK' }),
  U({ ALU_FN: 'ADD', BUS: 'ALU', LD_A: 1 }),
  U({ BUS: 'PC', LD_B: 1 }),
  U({ ALU_FN: 'ADD', B_NEG: 1, CIN: 'ONE', FLAGS: 'ARITH' }),
  U({ SEQ: 'BRN', COND: 'SFN', CONST: 'BF_SLOW' }),
];
MICRO.BF_OK = [U({ BUS: 'CONST', CONST: 1, LD_B: 1, PC: 'DEC' }), U({ ...RD('RS2'), LD_A: 1, PC: 'DEC' })];
// A = count. The new count is computed into A first (its sign decides finish/continue one cycle later) but only
// written to rs2 in the write cycle; rd+1 comes back from MAR (MAR_INC), so A keeps the count across passes.
MICRO.BF_BODY = [
  U({ ALU_FN: 'ADD', B_NEG: 1, BUS: 'ALU', LD_A: 1, FLAGS: 'LOGIC' }),                            // A = cnt - 1
  U({ ...RD('RD'), LD_MAR: 1, SEQ: 'BRN', COND: 'SFP', CONST: 'BF_FIN' }),
  U({ MEM: 'WR', MDR_LANE: '0', MAR_INC: 1, ALU_FN: 'PASSA', BUS: 'ALU', RF_SEL: 'RS2', RF_WR: 1 }),
  U({ BUS: 'MAR', RF_SEL: 'RD', RF_WR: 1, RETIRE: 1, SEQ: 'BRN', COND: 'IRQ', CONST: 'BF_BODY' }),
  U({ SEQ: 'FETCH' }),
];
MICRO.BF_FIN = [U({ MEM: 'WR', MDR_LANE: '0', MAR_INC: 1, ALU_FN: 'PASSA', BUS: 'ALU', RF_SEL: 'RS2', RF_WR: 1, PC: 'INC' }),
  U({ BUS: 'MAR', RF_SEL: 'RD', RF_WR: 1, PC: 'INC', SEQ: 'FETCH' })];
MICRO.BF_ZERO = [U({ BUS: 'ZERO', RF_SEL: 'RS2', RF_WR: 1, FLAGS: 'LOGIC', SEQ: 'FETCH' })];
// Slow path: emulator order exactly (value read first; rd written, then rs2), refetching every step.
MICRO.BF_SLOW = [
  U({ ...RD('RS2'), LD_A: 1, FLAGS: 'LOGIC' }),
  U({ ...RD('RS1'), LD_MDR: 1, MDR_LANE: 'ALL', SEQ: 'BRN', COND: 'SFP', CONST: 'BF_ZERO' }),
  U({ BUS: 'CONST', CONST: 1, LD_B: 1 }),
  U({ ALU_FN: 'ADD', B_NEG: 1, BUS: 'ALU', RF_SEL: 'T0', RF_WR: 1, FLAGS: 'LOGIC' }),
  U({ ...RD('RD'), LD_MAR: 1, LD_A: 1 }),
  U({ MEM: 'WR', MDR_LANE: '0', ALU_FN: 'INCA', CIN: 'ONE', BUS: 'ALU', RF_SEL: 'RD', RF_WR: 1 }),
  U({ RF_SEL: 'T0', RF_RD: 1, BUS: 'RF', LD_A: 1 }),
  U({ ALU_FN: 'PASSA', BUS: 'ALU', RF_SEL: 'RS2', RF_WR: 1, SEQ: 'BRN', COND: 'SFP', CONST: 'FETCH' }),
  U({ BUS: 'PC', LD_A: 1 }), U({ BUS: 'CONST', CONST: 2, LD_B: 1 }),
  U({ ALU_FN: 'ADD', B_NEG: 1, BUS: 'ALU', LD_PC: 1, SEQ: 'FETCH' }),
];

// ---- SHL / SHLI / SHR / SHRI: one trit per pass through the shifter's out wire (L1L / R1O), so CF = the last trit
// out and, for left shifts, OF = the first non-zero trit out (FLAGS SHOUTL keeps OF once it is non-zero). The count
// comes from rs2 or imm9; a negative count shifts the other way; the count is clamped to 28 (from 28 on, everything
// has left and the emulator's results stop changing: a register count with non-zero high trytes acts as 28*sign).
// 2 µcycles per trit. ----
for (const [dir, other, shift, fl] of [['SHL', 'SHR', 'L1L', 'SHOUTL'], ['SHR', 'SHL', 'R1O', 'SHOUTR']]) {
  const L = x => dir + '_' + x;
  const entry = (loadK) => [U({ ...loadK, LD_B: 1, FLAGS: 'LOGIC' }),            // B = k; SF = sign k; CF = OF = 0
    U({ SEQ: 'BR', COND: 'SFZ', CONST: L('K0') }),
    U({ SEQ: 'BR', COND: 'SFN', CONST: other + '_NEGK' })];
  MICRO[L('NEGK')] = [U({ ALU_FN: 'PASSB', B_NEG: 1, BUS: 'ALU', LD_B: 1, SEQ: 'JUMP', CONST: L('P') })]; // entered from the other direction
  MICRO[dir] = [...entry(RD('RS2')), U({ SEQ: 'JUMP', CONST: L('P') })];
  MICRO[dir + 'I'] = entry({ BUS: 'IMM' });  // falls straight into P (TritOS's shifts are all SHLI/SHRI)
  MICRO[L('P')] = [
    U({ BUS: 'CONST', CONST: 28, LD_A: 1 }),
    U({ ALU_FN: 'ADD', B_NEG: 1, FLAGS: 'ARITH' }),                              // sign(28 - k); OF = CF = 0 (no carry)
    U({ SEQ: 'BR', COND: 'SFN', CONST: L('CLAMP') }),
    U({ ALU_FN: 'PASSB', BUS: 'ALU', UCNT: 'LOAD', SEQ: 'JUMP', CONST: L('GO') })];
  MICRO[L('CLAMP')] = [U({ BUS: 'CONST', CONST: 28, UCNT: 'LOAD' })];
  MICRO[L('GO')] = [U({ ...RD('RS1'), LD_A: 1 })];
  MICRO[L('LOOP')] = [U({ ALU_FN: 'PASSA', SHIFT: shift, BUS: 'ALU', LD_A: 1, FLAGS: fl, UCNT: 'DEC' }),
    U({ SEQ: 'BRN', COND: 'CNTZ', CONST: L('LOOP') })];
  MICRO[L('END')] = [U({ ALU_FN: 'PASSA', BUS: 'ALU', RF_SEL: 'RD', RF_WR: 1, SEQ: 'FETCH' })];
  MICRO[L('K0')] = [U({ ...RD('RS1'), LD_A: 1 }), U({ ALU_FN: 'PASSA', BUS: 'ALU', RF_SEL: 'RD', RF_WR: 1, FLAGS: 'LOGIC', SEQ: 'FETCH' })];
}

// ---- Traps (ISA-3 section 4.2). Entry routines set ECAUSE, EADDR, B = 3*vector and A = the saved PC, then share
// TRAP_COMMON. A memory fault is detected by the address unit before the access: the cycle is aborted (nothing in it
// takes effect) and the sequencer is forced to TRAP_PROT / TRAP_BAD with the address in the FADDR latch. ESR packs the
// flags as they were when the instruction started (a latch loaded at fetch and at every RETIRE), and PSW ENTER puts
// those flags back, so whatever a faulting instruction did to the flags before its fault is undone, as the emulator. ----
const S = SLOT;
function trapEntry(name, vec, cause, eaddr, saved) {
  MICRO[name] = [
    ...(cause === 'IMM' ? [U({ BUS: 'IMM', ...W(S.ECAUSE) })] : [U({ BUS: 'CONST', CONST: vec, LD_A: 1 }), U({ ALU_FN: 'PASSA', BUS: 'ALU', ...W(S.ECAUSE) })]),
    U({ BUS: eaddr, ...W(S.EADDR) }),
    U({ BUS: 'CONST', CONST: 3 * vec, LD_B: 1 }),
    saved === 'PC' ? U({ BUS: 'PC', LD_A: 1, SEQ: 'JUMP', CONST: 'TRAP_COMMON' })
                   : U({ RF_SEL: 'FPC', RF_RD: 1, BUS: 'RF', LD_A: 1, SEQ: 'JUMP', CONST: 'TRAP_COMMON' })];
  // (TRAP_COMMON / TRAP_VEC are laid out by trapTail below)
}
trapEntry('TRAP_ILL', 1, 'VEC', 'OPC', 'FPC');
trapEntry('TRAP_PRIV0', 2, 'VEC', 'ZERO', 'FPC');
trapEntry('TRAP_PRIVI', 2, 'VEC', 'IMM', 'FPC');
trapEntry('TRAP_PROT', 3, 'VEC', 'FADDR', 'FPC');
trapEntry('TRAP_BAD', 4, 'VEC', 'FADDR', 'FPC');
trapEntry('TRAP_DIV0', 5, 'VEC', 'ZERO', 'FPC');
trapEntry('SYSCALL', 6, 'IMM', 'IMM', 'PC');            // ECAUSE = EADDR = imm9; EPC = the next instruction
// The shared tail. Traps end the instruction step (SEQ FETCH); an interrupt is taken at the start of a step and the
// handler's first instruction runs in that same step (as the emulator), so its tail jumps into FETCH2 instead.
function trapTail(P, last) {
  MICRO[P + 'COMMON'] = [
    U({ ALU_FN: 'PASSA', BUS: 'ALU', ...W(S.EPC) }),
    U({ RF_SEL: 'SP', RF_RD: 1, BUS: 'RF', LD_A: 1 }), U({ ALU_FN: 'PASSA', BUS: 'ALU', ...W(S.ESP) }),
    U({ BUS: 'ESRV', ...W(S.ESR) }),
    R_(S.KSP, { LD_A: 1, FLAGS: 'LOGIC' }),                                      // (flags are put back by ENTER)
    U({ SEQ: 'BRN', COND: 'USER', CONST: P + 'VEC' }),                           // from user mode
    U({ SEQ: 'BR', COND: 'SFZ', CONST: P + 'VEC' }),                             // and KSP != 0:
    U({ ALU_FN: 'PASSA', BUS: 'ALU', RF_SEL: 'SP', RF_WR: 1 })];                 //   SP = KSP
  MICRO[P + 'VEC'] = [
    R_(S.VBR, { LD_A: 1, PSW: 'ENTER' }),                                        // PRIV = 0, IE = 0, flags back
    U({ ALU_FN: 'ADD', BUS: 'ALU', LD_MAR: 1 }),
    U({ SEQ: 'BR', COND: 'BADADDR', CONST: 'TRAP_HALT' }),                       // vector outside RAM: the emulator halts
    U({ MEM: 'RD', MDR_LANE: '0', MAR_INC: 1 }), U({ MEM: 'RD', MDR_LANE: '1', MAR_INC: 1 }), U({ MEM: 'RD', MDR_LANE: '2' }),
    U({ BUS: 'MDR', LD_PC: 1, ...last })];
}
trapTail('TRAP_', { SEQ: 'FETCH' });
trapTail('IRQ_', { SEQ: 'JUMP', CONST: 'FETCH2' });
// Interrupt entry: ECAUSE = vector (7 + IRQ number from the priority encoder), B = 3*vector (the shifter's L1 is x3),
// IRQ_ACK clears that pending bit, EADDR = 0, saved PC = the instruction about to run.
MICRO.IRQ_ENTRY = [
  U({ BUS: 'IRQV', LD_A: 1 }),
  U({ ALU_FN: 'PASSA', BUS: 'ALU', ...W(S.ECAUSE) }),
  U({ ALU_FN: 'PASSA', SHIFT: 'L1', BUS: 'ALU', LD_B: 1, IRQ_ACK: 1 }),
  U({ BUS: 'ZERO', ...W(S.EADDR) }),
  U({ BUS: 'PC', LD_A: 1, SEQ: 'JUMP', CONST: 'IRQ_COMMON' })];
MICRO.FETCH2 = [U({ BUS: 'PC', LD_MAR: 1, RF_SEL: 'FPC', RF_WR: 1 }),
  U({ MEM: 'RD', LD_IR: 1, MDR_LANE: '0', MAR_INC: 1, PC: 'INC' }),
  U({ MEM: 'RD', LD_IR: 1, MDR_LANE: '1', PC: 'INC', SEQ: 'DISPATCH' })];
MICRO.TRAP_HALT = [U({ SEQ: 'HALT' })];
MICRO.IRET = [U({ SEQ: 'BR', COND: 'USER', CONST: 'TRAP_PRIV0' }),
  R_(S.EPC, { LD_PC: 1 }), R_(S.ESP, { LD_A: 1 }), U({ ALU_FN: 'PASSA', BUS: 'ALU', RF_SEL: 'SP', RF_WR: 1 }),
  R_(S.ESR, { PSW: 'RESTORE', SEQ: 'FETCH' })];                                  // flags, PRIV, IE unpacked last
MICRO.MFSPR = [U({ SEQ: 'BR', COND: 'USER', CONST: 'TRAP_PRIVI' }), U({ RF_SEL: 'SPR', RF_RD: 1, BUS: 'RF', LD_A: 1 }),
  U({ ALU_FN: 'PASSA', BUS: 'ALU', RF_SEL: 'RD', RF_WR: 1, FLAGS: 'LOGIC', SEQ: 'FETCH' })];
MICRO.MTSPR = [U({ SEQ: 'BR', COND: 'USER', CONST: 'TRAP_PRIVI' }), U({ ...RD('RS1'), LD_A: 1 }),
  U({ ALU_FN: 'PASSA', BUS: 'ALU', RF_SEL: 'SPR', RF_WR: 1, SEQ: 'FETCH' })];
// IN / OUT: the mailbox to the I/O card (iocard.js). IO IN/OUT hands the card the port (imm9) and, for OUT, the bus
// value; the sequencer then WAITs until the card raises IORDY (it holds the CPU while it does disk DMA or a framebuffer
// fill as bus master); IN then takes the card's answer from the bus (BUS IO). Privileged in T3 (vector 2, EADDR = port).
const IO_IN = [U({ IO: 'IN' }), U({ SEQ: 'WAIT' }), U({ BUS: 'IO', RF_SEL: 'RD', RF_WR: 1, FLAGS: 'LOGIC', SEQ: 'FETCH' })];
const IO_OUT = [U({ ...RD('RD'), IO: 'OUT' }), U({ SEQ: 'WAIT' }), U({ SEQ: 'FETCH' })];
MICRO.IN = [U({ SEQ: 'BR', COND: 'USER', CONST: 'TRAP_PRIVI' }), ...IO_IN.map(m => ({ ...m }))];
MICRO.OUT = [U({ SEQ: 'BR', COND: 'USER', CONST: 'TRAP_PRIVI' }), ...IO_OUT.map(m => ({ ...m }))];

// ---- T2 mode (SPR_MODE = 0, Triton 2.1): 9-trit PC and SP that wrap, 1-tryte CALL/RET, no protection, faults,
// interrupts or timer counting, and anything T2 doesn't have halts. Hardware: the mode latch is one more address bit
// of the dispatch ROM; the address unit maps the low 9 trits of MAR onto 0..19,682 (the 5+4-trit conversion ROMs);
// the PC counter's carry stops at 9 trits; WIDTH9 confines an ALU result to 9 trits (the SP arithmetic). Loads and
// stores reuse the T3 microcode unchanged: (rs1 + imm) and (low tryte of rs1 + imm) are the same address mod 3^9. ----
MICRO.T2_HALT = [U({ SEQ: 'HALT' })];
MICRO.T2_PUSH = MICRO.PUSH.map((mu, i) => i === 4 ? { ...mu, WIDTH9: 1 } : { ...mu });
MICRO.T2_POP = MICRO.POP.map((mu, i) => i === 3 ? { ...mu, WIDTH9: 1 } : { ...mu });
MICRO.T2_CALL = [U({ RF_SEL: 'SP', RF_RD: 1, BUS: 'RF', LD_A: 1 }), U({ BUS: 'CONST', CONST: 1, LD_B: 1 }),
  U({ ALU_FN: 'ADD', B_NEG: 1, WIDTH9: 1, BUS: 'ALU', LD_MAR: 1, RF_SEL: 'SP', RF_WR: 1 }),
  U({ BUS: 'PC', LD_MDR: 1, MDR_LANE: 'ALL' }),
  U({ MEM: 'WR', MDR_LANE: '0', BUS: 'IMM', LD_PC: 1, SEQ: 'FETCH' })];
MICRO.T2_RET = [U({ RF_SEL: 'SP', RF_RD: 1, BUS: 'RF', LD_MAR: 1, LD_A: 1 }), U({ MEM: 'RD', MDR_LANE: '0', BUS: 'CONST', CONST: 1, LD_B: 1 }),
  U({ ALU_FN: 'ADD', WIDTH9: 1, BUS: 'ALU', RF_SEL: 'SP', RF_WR: 1 }), U({ BUS: 'MDR0', LD_PC: 1, SEQ: 'FETCH' })];
MICRO.T2_IN = IO_IN.map(m => ({ ...m }));      // T2: no privilege check
MICRO.T2_OUT = IO_OUT.map(m => ({ ...m }));
// T2 opcode -> routine (anything absent halts, as the emulator's T2 default)
const T2_MAP = { HALT: 'T2_HALT', PUSH: 'T2_PUSH', POP: 'T2_POP', CALL: 'T2_CALL', RET: 'T2_RET', IN: 'T2_IN', OUT: 'T2_OUT' };
for (const n of ['NOP', 'LI', 'LUI', 'MOV', 'ADD', 'ADDI', 'ADC', 'SUB', 'SUBI', 'SBC', 'MUL', 'MULI', 'DIV', 'MOD', 'NEG', 'LT', 'ST', 'LW', 'SW',
  'JMP', 'JN', 'JZ', 'JP', 'JNZ', 'JNP', 'JNN', 'JR', 'MTSPR', 'CMP', 'CMPI', 'TMIN', 'TMAX', 'TCON', 'TANY', 'TXOR', 'TUNARY', 'SHL', 'SHLI', 'SHR', 'SHRI'])
  T2_MAP[n] = n;

// Positive controls: MICROSIM_MUTANT=<name> plants one known microcode bug; diff.js must catch each.
const MUTANTS = {
  ADC_NO_CARRY: () => { MICRO.ADC[MICRO.ADC.length - 1].CIN = '0'; },
  CMP_AS_ARITH: () => { MICRO.CMP[MICRO.CMP.length - 1].FLAGS = 'ARITH'; },
  BCOPY_WRITE_ORDER: () => { const b = MICRO.BCOPY_SLOW; [b[9], b[10], b[11], b[12]] = [b[11], b[12], b[9], b[10]]; b[10].SEQ = undefined; b[12].SEQ = 'BRN'; b[12].COND = 'SFP'; b[12].CONST = 'FETCH'; delete b[10].COND; delete b[10].CONST; b[10].SEQ = 'NEXT'; },
  BCOPY_FAST_PC: () => { MICRO.BC_FIN[1].PC = 'NONE'; },
  BCOPY_FAST_NO_SELFMOD_GUARD: () => { const g = MICRO.BCOPY[MICRO.BCOPY.length - 1]; g.SEQ = 'NEXT'; },
  BCOPY_FAST_NO_ALIAS_GUARD: () => { delete MICRO.BCOPY[0].SEQ; delete MICRO.BCOPY[0].COND; delete MICRO.BCOPY[0].CONST; },
  MUL_NO_CARRY_TRIT: () => { MICRO.MUL_LOOP[3].SHIFT = 'R1'; },
  MULI_TAIL_SHIFT_WRONG: () => { MICRO.MULI_TAIL[4].SHIFT = 'L3'; },
  MUL_26_PASSES: () => { MICRO.MUL_C[3].CONST = 26; },
  DIV_ROUND_NOT_TRUNC: () => { MICRO.DIV_END.length = 1; MICRO.DIV_END.push(U({ RF_SEL: 'T1', RF_RD: 1, BUS: 'RF', LD_A: 1, SEQ: 'JUMP', CONST: 'DIV_S2' })); },
  MOD_SIGN_OF_DIVISOR: () => { MICRO.MOD_END[0] = U({ ...RD('RS2'), FLAGS: 'LOGIC' }); },
  TUNARY_NO_BCAST: () => { MICRO.TUNARY[2].B_BCAST = 0; },
  BFILL_FAST_PC: () => { MICRO.BF_FIN[1].PC = 'NONE'; },
  BFILL_NO_ALIAS_GUARD: () => { delete MICRO.BFILL[0].SEQ; delete MICRO.BFILL[0].COND; delete MICRO.BFILL[0].CONST; },
  BFILL_NO_SELFMOD_GUARD: () => { MICRO.BFILL[MICRO.BFILL.length - 1].SEQ = 'NEXT'; },
  LUI_SHIFT_8: () => { MICRO.LUI[2].SHIFT = 'L3'; },
  SHL_OF_NOT_STICKY: () => { MICRO.SHL_LOOP[0].FLAGS = 'SHOUTR'; },
  SHR_FILLS_FROM_LINK: () => { MICRO.SHR_LOOP[0].SHIFT = 'R1L'; },
  SHIFT_CLAMP_27: () => { MICRO.SHL_P[0].CONST = 27; MICRO.SHL_CLAMP[0].CONST = 27; },
  SHIFT_NEG_NO_SWAP: () => { MICRO.SHL[2].CONST = 'SHL_NEGK'; },
  SHIFT_K0_KEEPS_FLAGS: () => { MICRO.SHR_K0[1].FLAGS = 'KEEP'; },
  TRAP_NO_KSP_SWITCH: () => { MICRO.TRAP_COMMON[7].RF_WR = 0; },
  TRAP_NO_ENTER: () => { MICRO.TRAP_VEC[0].PSW = 'KEEP'; },
  IRQ_NO_ACK: () => { MICRO.IRQ_ENTRY[2].IRQ_ACK = 0; },
  IN_NO_FLAGS: () => { MICRO.IN[3].FLAGS = 'KEEP'; },
  OUT_SENDS_RS1: () => { MICRO.OUT[1].RF_SEL = 'RS1'; },
  IN_NO_PRIV_CHECK: () => { MICRO.IN[0].SEQ = 'NEXT'; },
  T2_OUT_PRIV_CHECKED: () => { MICRO.T2_OUT.unshift(U({ SEQ: 'BR', COND: 'USER', CONST: 'TRAP_PRIVI' })); },
  T2_PUSH_NO_WRAP: () => { MICRO.T2_PUSH[4].WIDTH9 = 0; },
  T2_CALL_PUSHES_WORD: () => { MICRO.T2_CALL = MICRO.CALL; },
  T2_RET_SP_PLUS_3: () => { MICRO.T2_RET[1].CONST = 3; },
  T2_MFSPR_ALLOWED: () => { T2_MAP.MFSPR = 'MFSPR'; },            // an op T2 doesn't have must halt
  IRQ_ENDS_STEP: () => { const w = MICRO.IRQ_VEC[MICRO.IRQ_VEC.length - 1]; w.SEQ = 'FETCH'; delete w.CONST; },
  IRQ_VECTOR_NOT_TIMES_3: () => { MICRO.IRQ_ENTRY[2].SHIFT = undefined; },
  IRQ_NOT_AT_FETCH: () => { const w = MICRO.FETCH[0]; delete w.SEQ; delete w.COND; delete w.CONST; },
  TRAP_ENTER_TOO_EARLY: () => { MICRO.TRAP_COMMON[3].PSW = 'ENTER'; },
  PUSH_SP_BEFORE_CHECK: () => { MICRO.PUSH[2].RF_SEL = 'SP'; MICRO.PUSH[2].RF_WR = 1; },
  SW_NO_WORD_CHECK: () => { MICRO.SW[3].MEM = undefined; },
  SYSCALL_EPC_IS_FETCH_PC: () => { const w = MICRO.SYSCALL[MICRO.SYSCALL.length - 1]; w.BUS = 'RF'; w.RF_SEL = 'FPC'; w.RF_RD = 1; },
  MTSPR_NO_PRIV_CHECK: () => { MICRO.MTSPR[0].SEQ = 'NEXT'; },
  IRET_NO_SP_RESTORE: () => { MICRO.IRET[3].RF_WR = 0; },
  BFILL_COUNT_BEFORE_WRITE: () => { const b = MICRO.BF_BODY; b[0].RF_SEL = 'RS2'; b[0].RF_WR = 1; },
};
if (process.env.MICROSIM_MUTANT) MUTANTS[process.env.MICROSIM_MUTANT]();

// opcode numbers (ISA-3.md section 6)
const OPC = { HALT: -1, NOP: 0, LI: 1, LUI: 2, MOV: 3, ADD: 4, ADDI: 5, ADC: 6, SUB: 7, SUBI: 8, SBC: 9, NEG: 14, LT: 15, ST: 16, LW: 17, SW: 18,
  PUSH: 19, POP: 20, JMP: 21, JN: 22, JZ: 23, JP: 24, JNZ: 25, JNP: 26, JNN: 27, JR: 28, CALL: 29, RET: 30, CMP: -2, CMPI: -3, TMIN: -4, TMAX: -5,
  LMI: 33, LHI: 34, ADDM: 35, ADDH: 36, LDX: 37, STX: 38, LWX: 39, SWX: 40, JMPX: 41, JNX: 42, JZX: 43, JPX: 44, JNZX: 45, JNPX: 46, JNNX: 47,
  CALLX: 48, JALR: 49, BCOPY: 50, MUL: 10, MULI: 11, DIV: 12, MOD: 13, TCON: -6, TANY: -7, TXOR: -8, TUNARY: -9, BFILL: 51, SHL: -10, SHLI: -11, SHR: -12, SHRI: -13,
  IN: 31, OUT: 32, SYSCALL: 52, IRET: 53, MFSPR: 54, MTSPR: 55 };

// assemble the control store: lay out routines, resolve labels, encode every word
function buildStore() {
  const addr = {}, store = []; const order = ['FETCH', ...Object.keys(MICRO).filter(k => k !== 'FETCH')];
  for (const k of order) { addr[k] = store.length; for (const mu of MICRO[k]) store.push({ ...mu, _r: k }); }
  for (const mu of store) {
    const uses = [mu.RF_SEL === 'CONST', mu.BUS === 'CONST', ['JUMP', 'BR', 'BRN'].includes(mu.SEQ)].filter(Boolean).length;
    if (uses > 1) throw new Error(`CONST field asked to do ${uses} jobs at once in ${mu._r}`);
    if (typeof mu.CONST === 'string') { if (!(mu.CONST in addr)) throw new Error('no label ' + mu.CONST); mu.CONST = addr[mu.CONST]; }
  }
  const bits = store.map(encode);
  const dispatch = new Map(Object.entries(OPC).map(([n, op]) => [op, addr[n]]));
  const dispatchT2 = new Map(Object.entries(T2_MAP).map(([n, r]) => [OPC[n], addr[r]]));
  return { store, bits, addr, dispatch, dispatchT2 };
}

// ---------------- the machine ----------------
const { IOCard } = require('./iocard.js');
class MicroMachine {
  constructor(ramSize = 4782969, ioLatency = 10) { // ioLatency: µcycles the card takes to answer (assumed: ~1 µs)
    this.cs = buildStore(); this.ramSize = ramSize; this.mem = new Int16Array(ramSize);
    this.rf = new Array(32).fill(0); this.pc = 0; this.A = 0; this.B = 0; this.MAR = 0; this.MDR = [0, 0, 0]; this.IR = [0, 0];
    this.link = 0; this.qt = 0; this.ucnt = 0;
    this.sf = 0; this.cf = 0; this.of = 0; this.halted = false; this.upc = 0; this.ucycles = 0; this.unimpl = null;
    this.vram = new Int16Array(FB_SIZE);
    // status latches (SPRs 0-4, 8, 15); word SPRs live in register RAM slots 10 + index
    this.mode = 1; this.priv = 0; this.ie = 0; this.imask = 0; this.ipend = 0; this.protEn = 1; this.trapDiv0 = 0;
    this.timerPeriod = 0; this.timerCount = 0; this.irqTaken = 0;        // the step timer (mode 0), on the I/O card in hardware
    this.rf[SLOT.ULIMIT] = ramSize;
    this.shadow = [0, 0, 0]; this.faultAddr = 0;
    this.io = new IOCard(this); this.ioLatency = ioLatency; this.ioWait = 0; this.ioData = 0;
    this.irqLines = 5; this.ownTimer = true;          // Triton 4 (iocard4.js): 6 IRQ lines, the timer lives on the I/O card      // flags at instruction start; address of the last fault
  }
  // the SPR port: imm9 picks a latch or a register-RAM slot (16 SPRs; anything else reads 0 and ignores writes)
  sprRead(i) { return { 0: this.mode, 1: this.priv, 2: this.ie, 3: this.imask, 4: this.ipend, 8: this.protEn, 15: this.trapDiv0 }[i]
    ?? ((i >= 5 && i <= 14) ? this.rf[10 + i] : 0); }
  sprWrite(i, v) {
    const L = 1 << this.irqLines, bit = v ? 1 : 0, m32 = ((v % L) + L) % L;   // IMASK / IPEND keep 5 bits (6 on Triton 4), as val & 31 / 63
    if (i === 0) this.mode = bit;
    else if (i === 1) this.priv = bit; else if (i === 2) this.ie = bit; else if (i === 3) this.imask = m32;
    else if (i === 4) this.ipend = m32; else if (i === 8) this.protEn = bit; else if (i === 15) this.trapDiv0 = bit;
    else if (i >= 5 && i <= 14) this.rf[10 + i] = v; }
  // the address unit: user-mode protection, then RAM / framebuffer bounds (ISA-3 sections 2.3 and 4)
  check(a) {
    if (this.mode === 0) return null;                  // T2: every address maps into the 3^9-tryte space
    if (this.priv === 1 && this.protEn === 1 && (a < this.rf[SLOT.UBASE] || a >= this.rf[SLOT.ULIMIT])) return [3, a];
    if (a >= FB_BASE && a < FB_BASE + FB_SIZE) return null;
    if (a < 0 || a >= this.ramSize) return [4, a];
    return null; }
  check3(a) { // a whole word, before any of it is written (EADDR = the first tryte outside the allowed range)
    if (this.mode === 0) return null;
    const lo = this.rf[SLOT.UBASE], hi = this.rf[SLOT.ULIMIT];
    if (this.priv === 1 && this.protEn === 1 && (a < lo || a + 2 >= hi)) return [3, a < lo ? a : Math.max(a, hi)];
    if (!(a >= FB_BASE && a + 2 < FB_BASE + FB_SIZE) && (a < 0 || a + 2 >= this.ramSize)) return [4, a < 0 ? a : Math.max(a, this.ramSize)];
    return null; }
  phys(a) { if (this.mode === 0) { const r = a % 19683; return r < 0 ? r + 19683 : r; } return a; }
  memRead(a) { a = this.phys(a); return (a >= FB_BASE && a < FB_BASE + FB_SIZE) ? this.vram[a - FB_BASE] : this.mem[a]; }
  memWrite(a, v) { a = this.phys(a); if (a >= FB_BASE && a < FB_BASE + FB_SIZE) this.vram[a - FB_BASE] = balRem(v, 729, 364); else this.mem[a] = v; }
  get sp() { return this.rf[SLOT.SP]; } set sp(v) { this.rf[SLOT.SP] = v; }
  decode() { const t0 = this.IR[0], t1 = this.IR[1];
    const e1 = balRem(t0, 9, 4), q1 = (t0 - e1) / 9, ed = balRem(q1, 9, 4), op = (q1 - ed) / 9;
    return { op, rd: (ed + 9) % 9, rs1: (e1 + 9) % 9, rs2: (balRem(t1, 9, 4) + 9) % 9, imm: t1 }; }
  // one microcycle
  cycle() {
    const mu = this.cs.store[this.upc], d = this.decode(); this.ucycles++;
    if (this.upc === this.cs.addr.IRQ_ENTRY) this.irqTaken++; // statistics only
    if (this.upc === this.cs.addr.FETCH || this.upc === this.cs.addr.FETCH2) this.shadow = [this.sf, this.cf, this.of];
    if (mu.NOTYET) { this.unimpl = d.op; this.halted = true; return 'END'; }
    if (mu.MEM === 'RD' || mu.MEM === 'WR' || mu.MEM === 'CHK3') { // the address unit, ahead of the access
      const f = mu.MEM === 'CHK3' ? this.check3(this.MAR) : this.check(this.MAR);
      if (f) { this.faultAddr = f[1]; this.upc = this.cs.addr[f[0] === 3 ? 'TRAP_PROT' : 'TRAP_BAD']; return undefined; } }
    const slot = { RD: d.rd, RS1: d.rs1, RS2: d.rs2, CONST: mu.CONST, SP: SLOT.SP, T0: SLOT.T0, T1: SLOT.T1, FPC: SLOT.FPC, SPR: 'SPR' }[mu.RF_SEL || 'RD'];
    // ALU (combinational from A, B latches)
    const neg = mu.B_NEG === 1 || mu.B_NEG === '1' || (mu.B_NEG === 'QT' && this.qt === -1);
    const Bin = neg ? -this.B : this.B, cin = { '0': 0, CF: this.cf, ONE: 1, LINK: this.link }[mu.CIN || '0'];
    let { r: aluOut, cout } = this.aluImpl   // aluImpl: the table-image ALU (roms.js), negation folded into the table address
      ? this.aluImpl(mu.ALU_FN || 'ADD', this.A, this.B, neg, cin, !!mu.B_BCAST) : alu(mu.ALU_FN || 'ADD', this.A, Bin, cin, !!mu.B_BCAST);
    const sh = mu.SHIFT || 'NONE'; let linkNext = this.link, shOut = 0;
    if (sh !== 'NONE') { // the shifter is wiring: trit i goes to trit i +- k
      const t = toTrits(aluOut, 27);
      if (sh === 'R1C') { linkNext = t[0]; aluOut = fromTrits([...t.slice(1), cout]); }      // 28-trit (cout:sum) >> 1
      else if (sh === 'R1L') { linkNext = t[0]; aluOut = fromTrits([...t.slice(1), this.link]); } // link trit enters at the top
      else if (sh === 'L1L') { linkNext = shOut = t[26]; aluOut = fromTrits([0, ...t.slice(0, 26)]); } // top trit leaves into link
      else if (sh === 'R1O') { linkNext = shOut = t[0]; aluOut = fromTrits([...t.slice(1), 0]); }      // bottom trit leaves, 0 fills the top
      else { const k = +sh.slice(1);
        aluOut = fromTrits(sh[0] === 'L' ? [...Array(k).fill(0), ...t.slice(0, 27 - k)] : [...t.slice(k), ...Array(k).fill(0)]); } }
    if (mu.WIDTH9) aluOut = balRem(aluOut, 19683, 9841);   // confine to 9 trits (T2 SP arithmetic)
    // bus
    let bus;
    switch (mu.BUS || 'NONE') {
      case 'NONE': bus = undefined; break; case 'RF': bus = slot === 'SPR' ? this.sprRead(d.imm) : this.rf[slot]; break; case 'ALU': bus = aluOut; break;
      case 'FADDR': bus = this.faultAddr; break; case 'IO': bus = this.ioData; break; case 'OPC': bus = d.op; break; case 'MAR': bus = this.MAR; break;
      case 'IRQV': { const a = this.ipend & this.imask; let b = 0; while (b < this.irqLines && !(a & (1 << b))) b++; bus = 7 + b; break; } // priority encoder
      case 'ESRV': bus = this.shadow[0] + 3 * this.shadow[1] + 9 * this.shadow[2] + 27 * this.priv + 81 * this.ie; break; // wiring
      case 'MDR': bus = this.MDR[0] + this.MDR[1] * TM + this.MDR[2] * TM * TM; break; case 'MDR0': bus = this.MDR[0]; break;
      case 'PC': bus = this.pc; break; case 'IMM': bus = d.imm; break; case 'CONST': bus = mu.CONST; break; case 'ZERO': bus = 0; break;
      default: throw new Error('bus source ' + mu.BUS);
    }
    this.lastBus = bus;                                    // observation only (card-level differential tests)
    if (mu.RF_RD && mu.BUS !== 'RF') throw new Error('RF_RD without BUS=RF');
    // memory (data path MAR/MDR, separate from the bus)
    const lane = mu.MDR_LANE === undefined ? 0 : (mu.MDR_LANE === 'ALL' ? -1 : +mu.MDR_LANE);
    if (mu.MEM === 'RD') { const v = this.memRead(this.MAR);
      if (mu.LD_IR) this.IR[lane] = v; else { if (lane < 0) throw new Error('read needs a lane'); this.MDR[lane] = v; } }
    if (mu.MEM === 'WR') { if (lane < 0) throw new Error('write needs a lane'); this.memWrite(this.MAR, this.MDR[lane]); }
    const condv = { SFN: this.sf === -1, SFZ: this.sf === 0, SFP: this.sf === 1, IRQ: this.irqPending(),
      USER: this.priv === 1, DIV0: this.mode === 1 && this.trapDiv0 === 1, BADADDR: !(this.MAR >= 0 && this.MAR + 2 < this.ramSize),
      ALIAS: d.rd === d.rs1 || d.rd === d.rs2 || d.rs1 === d.rs2,
      QTZ: this.qt === 0, CNTZ: this.ucnt === 0, BTOPZ: toTrits(this.B, 27)[26] === 0 }[mu.COND]; // latched values
    // flags
    if (mu.FLAGS === 'ARITH') { this.sf = sign(aluOut); this.cf = this.of = cout; }
    else if (mu.FLAGS === 'CMP') { this.sf = cout !== 0 ? cout : sign(aluOut); this.cf = this.of = cout; }
    else if (mu.FLAGS === 'LOGIC') { if (bus === undefined) throw new Error('LOGIC flags need a bus value'); this.sf = sign(bus); this.cf = this.of = 0; }
    else if (mu.FLAGS === 'MULHI') { this.cf = this.of = sign(bus); }                 // high half of a product
    else if (mu.FLAGS === 'OFDIV0') { this.cf = 0; this.of = sign(bus) || 1; }        // divide by zero marker
    else if (mu.FLAGS === 'SHOUTL') { this.sf = sign(aluOut); this.cf = shOut; if (this.of === 0) this.of = shOut; } // OF: first non-zero trit out
    else if (mu.FLAGS === 'SHOUTR') { this.sf = sign(aluOut); this.cf = shOut; this.of = 0; }
    // latches (clock edge: all loads see this cycle's bus)
    const need = () => { if (bus === undefined) throw new Error(`load with idle bus in ${mu._r}`); return bus; };
    if (mu.IO === 'IN') { this.ioData = this.io.portIn(d.imm); this.ioWait = this.ioLatency; }
    else if (mu.IO === 'OUT') { this.io.portOut(d.imm, need()); this.ioWait = this.ioLatency; }
    if (mu.RF_WR) { if (slot === 'SPR') this.sprWrite(d.imm, need()); else this.rf[slot] = need(); }
    if (mu.PSW === 'ENTER') { this.priv = 0; this.ie = 0; [this.sf, this.cf, this.of] = this.shadow; }
    else if (mu.PSW === 'RESTORE') { const t = toTrits(need(), 5); [this.sf, this.cf, this.of] = t; this.priv = t[3] ? 1 : 0; this.ie = t[4] ? 1 : 0; }
    if (mu.LD_A) this.A = need(); if (mu.LD_B) this.B = need(); if (mu.LD_PC) this.pc = need();
    if (mu.LD_MDR) { const w = word3(need()); if (lane < 0) this.MDR = w; else this.MDR[lane] = w[0]; }
    if (mu.LD_MAR) this.MAR = need();
    if (mu.LD_QT) this.qt = toTrits(this.A, 1)[0];   // A latch's low trit (the multiplier digit)
    this.link = linkNext;
    if (mu.UCNT === 'LOAD') { const v = need(); if (!(Number.isInteger(v) && v >= 0 && v < 64)) throw new Error(`counter load ${v} out of range in ${mu._r}`); this.ucnt = v; } else if (mu.UCNT === 'DEC') this.ucnt--; else if (mu.UCNT === 'INC') this.ucnt++;
    if (mu.MAR_INC) this.MAR++; if (!mu.LD_PC) { if (mu.PC === 'INC') this.pc++; else if (mu.PC === 'DEC') this.pc--; }
    if (this.mode === 0) this.pc = balRem(this.pc, 19683, 9841);  // T2: the PC counter's carry stops at 9 trits
    // sequencer
    switch (mu.SEQ || 'NEXT') {
      case 'NEXT': this.upc++; break; case 'JUMP': this.upc = mu.CONST; break; case 'FETCH': this.upc = this.cs.addr.FETCH; return 'END';
      case 'BR': this.upc = condv ? mu.CONST : this.upc + 1; break;
      case 'BRN': this.upc = condv ? this.upc + 1 : mu.CONST; break;
      case 'DISPATCH': { // the mode latch is one more dispatch-ROM address bit
        if (this.mode === 0) { const a = this.cs.dispatchT2.get(d.op); this.upc = a === undefined ? this.cs.addr.T2_HALT : a; break; }
        const a = this.cs.dispatch.get(d.op); this.upc = a === undefined ? this.cs.addr.TRAP_ILL : a; break; } // unallocated: vector 1
      case 'WAIT': if (this.ioWait > 0) this.ioWait--; else this.upc++; break;   // until the I/O card raises IORDY
      case 'HALT': this.halted = true; this.upc = this.cs.addr.FETCH; return 'END';
      default: throw new Error('seq ' + mu.SEQ);
    }
    if (mu.IRQ_ACK) { const a = this.ipend & this.imask; let b = 0; while (b < this.irqLines && !(a & (1 << b))) b++; this.ipend &= ~(1 << b); }
    if (mu.RETIRE) this.shadow = [this.sf, this.cf, this.of];
    return (this.upc === this.cs.addr.FETCH || mu.RETIRE) ? 'END' : undefined; // RETIRE: an instruction step ends without refetch (also drives the step timer)
  }
  // one architectural instruction step (fetch + execute); returns microcycles used
  irqPending() { return this.mode === 1 && this.ie === 1 && (this.ipend & this.imask) !== 0; }
  // one instruction step. The step timer ticks at every instruction boundary; a boundary inside a block move's own
  // loop (after RETIRE) is a real boundary too, so a pending interrupt sends the sequencer back to FETCH there,
  // where the interrupt is taken (PC already holds the block move's own address, so it resumes after IRET).
  step() { const c0 = this.ucycles; this.io.tick();
    if (this.ownTimer && this.mode === 1 && this.timerPeriod > 0 && ++this.timerCount >= this.timerPeriod) { this.timerCount = 0; this.ipend |= 1; }
    if (this.irqPending() && this.upc !== this.cs.addr.FETCH) this.upc = this.cs.addr.FETCH;
    while (this.cycle() !== 'END') if (this.ucycles - c0 > 10000) throw new Error('microcode livelock: no instruction boundary in 10,000 µcycles');
    return this.ucycles - c0; }
}

module.exports = { MicroMachine, buildStore, FIELDS, WORD_BITS, OPC, alu, word3, SLOT, ENUM, ALU_FNS, LUT };
