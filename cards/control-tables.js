// control-tables.js: the Control card's lookup tables (Kehai Interim, 2026-11-18). Each one is written from the
// microsim's own rules (microsim.js cycle(), decode()) or repacked from the ROM images; none of them is a program.
'use strict';
const fs = require('fs'), path = require('path');
const enc = t => t === 1 ? 1 : t === -1 ? 2 : 0, dec = b => b === 1 ? 1 : b === 2 ? -1 : 0;
const toT = (v, n) => { const t = []; let x = v; for (let i = 0; i < n; i++) { let r = ((x % 3) + 3) % 3; if (r === 2) r = -1; t.push(r); x = (x - r) / 3; } return t; };
const fromT = t => t.reduceRight((a, d) => 3 * a + d, 0);
const encT = t => t.reduce((a, d, i) => a | enc(d) << (2 * i), 0);
const decT = (bits, n) => Array.from({ length: n }, (_, i) => dec((bits >> (2 * i)) & 3));
const valid = (bits, n) => { for (let i = 0; i < n; i++) if (((bits >> (2 * i)) & 3) === 3) return false; return true; };
const B19 = () => Buffer.alloc(1 << 19);
const SEQK = ['NEXT', 'JUMP', 'DISPATCH', 'BR', 'BRN', 'FETCH', 'WAIT', 'HALT'];
const CONDK = ['SFN', 'SFZ', 'SFP', 'CFNZ', 'CNTZ', 'QTZ', 'BTOPZ', 'IORDY', 'IRQ', 'USER', 'T2', 'DIV0', 'BADADDR', 'PROT', 'ALIAS'];

// NEXT-ADDRESS table. addr: SEQK(3) | cond<<3 | ABORT<<4 | FK<<5 (1 = protection) | RETIRE<<6 | CONSTFETCH<<7 | IRQN<<8 | IORDY<<9
// data: MSEL(2: 0 INC/HOLD table, 1 CONST, 2 DISPATCH, 3 FIXED) | FIX(2: 0 FETCH, 1 TRAP_PROT, 2 TRAP_BAD, 3 RESET)<<2 | HOLD<<4 | HALT<<5
function naTable() { const m = B19();
  for (let a = 0; a < 1024; a++) {
    const seq = SEQK[a & 7], cond = (a >> 3) & 1, abort = (a >> 4) & 1, fk = (a >> 5) & 1, ret = (a >> 6) & 1, cfetch = (a >> 7) & 1, irqn = (a >> 8) & 1, iordy = (a >> 9) & 1;
    let msel = 0, fix = 0, hold = 0, halt = 0, toFetch = false;
    if (abort) { msel = 3; fix = fk ? 1 : 2; }
    else { switch (seq) {
      case 'NEXT': break;
      case 'JUMP': msel = 1; toFetch = !!cfetch; break;
      case 'DISPATCH': msel = 2; break;                                          // dispatch never targets FETCH (checked)
      case 'BR': if (cond) { msel = 1; toFetch = !!cfetch; } break;
      case 'BRN': if (!cond) { msel = 1; toFetch = !!cfetch; } break;
      case 'FETCH': msel = 3; fix = 0; toFetch = true; break;
      case 'WAIT': if (!iordy) hold = 1; break;
      // during RESET the pipeline's outputs are off and pulled up: the word reads as HALT with RETIRE and CFETCH set.
      // No real word has that (CFETCH is only set on JUMP/BR/BRN to FETCH), so it is the reset vector: fixed address 3,
      // the RESET routine (microsim.js), not a halt.
      case 'HALT': if (ret && cfetch) { msel = 3; fix = 3; toFetch = true; } else { msel = 3; fix = 0; halt = 1; toFetch = true; } break; }
      // the step-boundary redirect: a RETIRE word ends a step; if an interrupt is pending at the boundary, go to FETCH
      if (ret && !toFetch && irqn && !halt) { msel = 3; fix = 0; hold = 0; } }
    m[a] = msel | fix << 2 | hold << 4 | halt << 5; }
  return m; }
// µPC + 1 (or hold). addr: µPC(10) | HOLD<<10. data: two chips, low 8 / high 2 bits
function incTables() { const lo = B19(), hi = B19();
  for (let a = 0; a < 2048; a++) { const u = a & 1023, n = (a >> 10) ? u : (u + 1) & 1023; lo[a] = n & 255; hi[a] = n >> 8; } return [lo, hi]; }
// CONDITION table. addr: COND(4) | SF(2)<<4 | QT(2)<<6 | BTOPNZ<<8 (B's top trit nonzero, from the ALU card) | CNTZ<<9 | IRQP<<10 | PRIV<<11 | MODE<<12 | TRAPDIV0<<13 | BADADDR<<14 | ALIAS<<15
function condTable() { const m = B19();
  for (let a = 0; a < (1 << 16); a++) { const c = CONDK[a & 15]; if (!c) continue; const sf = dec((a >> 4) & 3), qt = dec((a >> 6) & 3);
    const b = k => (a >> k) & 1;
    const v = { SFN: sf === -1, SFZ: sf === 0, SFP: sf === 1, IRQ: !!b(10), USER: !!b(11), DIV0: b(12) === 1 && b(13) === 1, BADADDR: !!b(14),
      ALIAS: !!b(15), QTZ: qt === 0, CNTZ: !!b(9), BTOPZ: !b(8) }[c];               // CFNZ, IORDY, T2, PROT: false, as the microsim
    m[a] = v ? 1 : 0; }
  return m; }
// DISPATCH, repacked from roms/dispatch.bin. addr: op trits dual-rail (10 bits) | MODE<<10. data: lo 8 / hi 2 bits.
function dispatchTables(romsDir) { const d = fs.readFileSync(path.join(romsDir, 'dispatch.bin')), lo = B19(), hi = B19();
  for (let a = 0; a < 2048; a++) { const bits = a & 1023; if (!valid(bits, 5)) continue; const op = fromT(decT(bits, 5)), mode = a >> 10;
    const i = (mode * 243 + op + 121) * 2; lo[a] = d[i]; hi[a] = d[i + 1]; } return [lo, hi]; }
// REGISTER-SLOT from instruction diads, and ALIAS. addr: RSK(2: rd, rs1, rs2) | IR0 trits 0..3 <<2 | IR1 trits 0..1 <<10
// data: slot(5) | ALIAS<<5. Diad v (-4..4) names register (v + 9) % 9, as decode() does.
function diadTable() { const m = B19();
  for (let a = 0; a < (1 << 14); a++) { const rsk = a & 3, i0 = (a >> 2) & 255, i1 = (a >> 10) & 15; if (rsk > 2 || !valid(i0, 4) || !valid(i1, 2)) continue;
    const t0 = decT(i0, 4), t1 = decT(i1, 2); const r = v => (v + 9) % 9;
    const rs1 = r(fromT(t0.slice(0, 2))), rd = r(fromT(t0.slice(2, 4))), rs2 = r(fromT(t1));
    m[a] = [rd, rs1, rs2][rsk] | ((rd === rs1 || rd === rs2 || rs1 === rs2) ? 1 : 0) << 5; }
  return m; }
// SPR index decode. addr: IR1 (imm9, 18 bits). data: slot(5) (10 + i for the register-RAM SPRs 5..14) | ISREG<<5 | LATCH<<6
function sprTable() { const m = B19();
  for (let a = 0; a < (1 << 18); a++) { if (!valid(a, 9)) continue; const i = fromT(decT(a, 9));
    const isReg = i >= 5 && i <= 14 && i !== 8, isLatch = [0, 1, 2, 3, 4, 8, 15].includes(i);
    m[a] = (isReg ? 10 + i : 0) | (isReg ? 1 : 0) << 5 | (isLatch ? 1 : 0) << 6; }
  return m; }
// I/O PORT number. addr: IR1 (imm9). data: port 0..62, or 63 for anything else
function portTable() { const m = B19(); for (let a = 0; a < (1 << 18); a++) { if (!valid(a, 9)) continue; const i = fromT(decT(a, 9)); m[a] = i >= 0 && i < 63 ? i : 63; } return m; }
// CONST (14-bit binary from the control word) -> 9 trits dual-rail, over 3 chips (bits 0-7, 8-15, 16-17)
function constTables() { const t = [B19(), B19(), B19()];
  for (let a = 0; a < (1 << 14); a++) { const w = encT(toT(a, 9)); t[0][a] = w & 255; t[1][a] = (w >> 8) & 255; t[2][a] = (w >> 16) & 3; } return t; }
// MICRO-COUNTER next state. addr: count(6) | UOP(2: none, load, dec, inc)<<6 | load value(6)<<8 | ABORT<<14. data: next(6) | zero<<6
function counterTable() { const m = B19();
  for (let a = 0; a < (1 << 15); a++) { const c = a & 63, op = (a >> 6) & 3, lv = (a >> 8) & 63, ab = (a >> 14) & 1;
    let n = ab ? c : [c, lv, (c - 1) & 63, (c + 1) & 63][op]; m[a] = n | (n === 0 ? 1 : 0) << 6; }
  return m; }
// counter LOAD value: bus trits 0..3 dual-rail (8 bits) -> 6-bit binary (the microcode only loads 0..63)
function loadTable() { const m = B19(); for (let a = 0; a < 256; a++) { if (!valid(a, 4)) continue; const v = fromT(decT(a, 4)); m[a] = ((v % 64) + 64) % 64; } return m; }
// PC slice. addr: PC trits(6) | bus trits(6)<<6 | cin(2)<<12 | PCOP(2: hold, count, load)<<14 | WRAP<<16 | ABORT<<17
// data: next trits(6) | cout(2)<<6. WRAP (slices 3..8 in T2 mode) forces 0, after any load or count.
function pcSlice() { const m = B19();
  for (let a = 0; a < (1 << 18); a++) { const p = a & 63, b = (a >> 6) & 63, c = (a >> 12) & 3, op = (a >> 14) & 3, wrap = (a >> 16) & 1, ab = (a >> 17) & 1;
    if (!valid(p, 3) || !valid(b, 3) || c === 3 || op === 3) continue;
    const pv = fromT(decT(p, 3)), bv = fromT(decT(b, 3)), cv = dec(c);
    if (ab) { m[a] = p; continue; }                                            // aborted cycle: hold (no carry)
    let r, co = 0;
    if (op === 0) r = pv; else if (op === 2) r = bv;
    else { const s = pv + cv; r = ((s + 13) % 27 + 27) % 27 - 13; co = (s - r) / 27; }
    if (wrap) { r = 0; co = 0; }
    m[a] = encT(toT(r, 3)) | enc(co) << 6; }
  return m; }
// ---- stage 2: status latches, interrupts, SPR port ----
// latch ids (from the SPR index): 0 none, 1 MODE(0), 2 PRIV(1), 3 IE(2), 4 IMASK(3), 5 IPEND(4), 6 PROT_EN(8), 7 TRAP_DIV0(15)
const LATCH_OF = { 0: 1, 1: 2, 2: 3, 3: 4, 4: 5, 8: 6, 15: 7 };
// SPR table 2. addr: IR1 (18) | SPR<<18. data: LATCHID(3) | SPRNR<<3 (an SPR access the Registers card must stand aside for)
function sprTable2() { const m = B19();
  for (let a = 0; a < (1 << 19); a++) { const imm = a & 0x3FFFF; if (!valid(imm, 9)) continue; const i = fromT(decT(imm, 9)), spr = a >> 18;
    const isReg = i >= 5 && i <= 14 && i !== 8; m[a] = (LATCH_OF[i] || 0) | (spr && !isReg ? 1 : 0) << 3; }
  return m; }
// bus value mod 32 and "nonzero", per tryte. addr: 9 trits dual-rail. data: (tryte value mod 32)(5) | nonzero<<5
function tryteMod() { const m = B19(); for (let a = 0; a < (1 << 18); a++) { if (!valid(a, 9)) continue; const v = fromT(decT(a, 9)); m[a] = (((v % 32) + 32) % 32) | (v !== 0 ? 1 : 0) << 5; } return m; }
// combine: addr m0(5) | m1(5)<<5 | m2(5)<<10 | nz0<<15 | nz1<<16 | nz2<<17. 3^9 = 3 (mod 32), 3^18 = 9 (mod 32)
function combineMod() { const m = B19(); for (let a = 0; a < (1 << 18); a++) { const m0 = a & 31, m1 = (a >> 5) & 31, m2 = (a >> 10) & 31, nz = (a >> 15) & 7;
    m[a] = ((m0 + 3 * m1 + 9 * m2) % 32) | (nz ? 1 : 0) << 5; } return m; }
// single-bit latches. addr: SPRWR | LID(3)<<1 | PSW(2)<<4 | ABORT<<6 | NZ<<7 | D3+<<8 | D3-<<9 | D4+<<10 | D4-<<11 |
// cur MODE<<12 PRIV<<13 IE<<14 PROTEN<<15 TRAPDIV0<<16. data: next MODE PRIV IE PROTEN TRAPDIV0
function bitLatches() { const m = B19();
  for (let a = 0; a < (1 << 17); a++) { const b = k => (a >> k) & 1, lid = (a >> 1) & 7, psw = (a >> 4) & 3; if (psw === 3) continue;
    let [mode, priv, ie, pe, td] = [b(12), b(13), b(14), b(15), b(16)];
    if (!b(6)) {
      if (b(0)) { const nz = b(7); if (lid === 1) mode = nz; else if (lid === 2) priv = nz; else if (lid === 3) ie = nz; else if (lid === 6) pe = nz; else if (lid === 7) td = nz; }
      if (psw === 1) { priv = 0; ie = 0; } else if (psw === 2) { priv = (b(8) || b(9)) ? 1 : 0; ie = (b(10) || b(11)) ? 1 : 0; } }
    m[a] = mode | priv << 1 | ie << 2 | pe << 3 | td << 4; }
  return m; }
// 5-bit latch after an SPR write (IMASK with id 4, IPEND with id 5). addr: SPRWR | LID(3)<<1 | ABORT<<4 | MOD(5)<<5 | cur(5)<<10
function wordLatch(id) { const m = B19(); for (let a = 0; a < (1 << 15); a++) { const w = (a & 1) && ((a >> 1) & 7) === id && !((a >> 4) & 1); m[a] = w ? (a >> 5) & 31 : (a >> 10) & 31; } return m; }
// IPEND after IRQ_ACK and device/timer sets. addr: ipendA(5) | imaskN(5)<<5 | ACK<<10 | ABORT<<11 | IRQSET(5)<<12
function ipendNext() { const m = B19(); for (let a = 0; a < (1 << 17); a++) { let p = a & 31; const mk = (a >> 5) & 31, ack = (a >> 10) & 1, ab = (a >> 11) & 1, set = (a >> 12) & 31;
    if (ab) { m[a] = p; continue; } if (ack) { const x = p & mk; let b = 0; while (b < 5 && !(x & (1 << b))) b++; p &= ~(1 << b); } m[a] = (p | set) & 31; } return m; }
// interrupt status. addr: ipend(5) | imask(5)<<5 | MODE<<10 | IE<<11. data: IRQV trits 0..2 dual-rail (6) | pending<<6
function irqTable() { const m = B19(); for (let a = 0; a < (1 << 12); a++) { const x = a & (a >> 5) & 31; let b = 0; while (b < 5 && !(x & (1 << b))) b++;
    m[a] = encT(toT(7 + b, 3)) | ((a >> 10) & 1 && (a >> 11) & 1 && x ? 1 : 0) << 6; } return m; }
// SPR read value. addr: LID(3) | MODE<<3 PRIV<<4 IE<<5 PROTEN<<6 TRAPDIV0<<7 | IMASK(5)<<8 | IPEND(5)<<13. data: trits 0..3 dual-rail
function sprValue() { const m = B19(); for (let a = 0; a < (1 << 18); a++) { const lid = a & 7, b = k => (a >> k) & 1;
    const v = [0, b(3), b(4), b(5), (a >> 8) & 31, (a >> 13) & 31, b(6), b(7)][lid]; m[a] = encT(toT(v, 4)); } return m; }
module.exports = { sprTable2, tryteMod, combineMod, bitLatches, wordLatch, ipendNext, irqTable, sprValue, naTable, incTables, condTable, dispatchTables, diadTable, sprTable, portTable, constTables, counterTable, loadTable, pcSlice, SEQK, CONDK, toT, encT };
