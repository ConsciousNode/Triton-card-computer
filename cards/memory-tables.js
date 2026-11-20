// memory-tables.js: the Memory card's lookup tables (Kehai Interim, 2026-11-18), from the microsim's check / check3 /
// MAR rules. Comparisons are chains of "a + k - b" slices rippling from the low end, each passing carry and "sign so far".
'use strict';
const T = require('./control-tables.js');
const enc = t => t === 1 ? 1 : t === -1 ? 2 : 0, dec = b => b === 1 ? 1 : b === 2 ? -1 : 0;
const valid = (bits, n) => { for (let i = 0; i < n; i++) if (((bits >> (2 * i)) & 3) === 3) return false; return true; };
const decT = (bits, n) => Array.from({ length: n }, (_, i) => dec((bits >> (2 * i)) & 3));
const fromT = t => t.reduceRight((a, d) => 3 * a + d, 0);
const bal = (r, m) => { let x = ((r % m) + m) % m; if (x > (m - 1) / 2) x -= m; return x; };
const B19 = () => Buffer.alloc(1 << 19);
// one step of the chain: slice value r (already a - b + cin + k), width n trits -> [carry, sign]
const step = (r, n, sgn) => { const m = 3 ** n, d = bal(r, m), c = (r - d) / m; return [c, d !== 0 ? Math.sign(d) : sgn]; };
const out = (c, s) => { const fin = c !== 0 ? c : s; return enc(c) | enc(s) << 2 | (fin < 0 ? 1 : 0) << 4; };   // data: carry, sign, "final < 0"
// VARIABLE slice (3 trits of a, 3 of b). addr: a(6) | b(6)<<6 | carry(2)<<12 | sign(2)<<14 | K2<<16
function subSlice() { const m = B19();
  for (let x = 0; x < (1 << 17); x++) { const a = x & 63, b = (x >> 6) & 63, ci = (x >> 12) & 3, si = (x >> 14) & 3, k2 = (x >> 16) & 1;
    if (!valid(a, 3) || !valid(b, 3) || ci === 3 || si === 3) continue;
    const [c, s] = step(fromT(decT(a, 3)) - fromT(decT(b, 3)) + dec(ci) + (k2 ? 2 : 0), 3, dec(si)); m[x] = out(c, s); }
  return m; }
// CONSTANT slice: n trits of a against the constant's slice cs (baked in). addr: a(2n) | carry(2)<<2n | sign(2)<<2n+2
function constSlice(n, cs, k) { const m = B19(), w = 2 * n;
  for (let x = 0; x < (1 << (w + 4)); x++) { const a = x & ((1 << w) - 1), ci = (x >> w) & 3, si = (x >> (w + 2)) & 3;
    if (!valid(a, n) || ci === 3 || si === 3) continue;
    const [c, s] = step(fromT(decT(a, n)) - cs + dec(ci) + k, n, dec(si)); m[x] = out(c, s); }
  return m; }
const CHUNKS = [[0, 7], [7, 7], [14, 7], [21, 6]];
function constChain(value, k) { const t = T.toT(value, 27); return CHUNKS.map(([lo, n], i) => constSlice(n, fromT(t.slice(lo, lo + n)), i === 0 ? k : 0)); }
// FAULT table. addr: MODE | PRIV<<1 | PROTEN<<2 | MK(2)<<3 (1 single, 2 CHK3) | n1..n9 <<5 (the chains' "< 0" bits)
// chains: n1 a-UB, n2 a-UL, n3 a+2-UL, n4 a, n5 a-RAM, n6 a+2-RAM, n7 a-FBB, n8 a-FBE, n9 a+2-FBE
// data: FAULT | FK<<1 (1 = protection) | ESEL(2)<<2 (0 MAR, 1 ULIMIT, 2 RAMSIZE) | BADADDR<<4 | INFB<<5
function faultTable() { const m = B19();
  for (let x = 0; x < (1 << 14); x++) { const b = i => (x >> i) & 1, mode = b(0), priv = b(1), pe = b(2), mk = (x >> 3) & 3, n = i => b(4 + i);
    let fault = 0, fk = 0, esel = 0; const prot = priv && pe;
    const infb = !n(7) && n(8), infb3 = !n(7) && n(9);
    if (mode === 1 && mk === 1) {
      if (prot && (n(1) || !n(2))) { fault = 1; fk = 1; }
      else if (!infb && (n(4) || !n(5))) { fault = 1; } }
    if (mode === 1 && mk === 2) {
      if (prot && (n(1) || !n(3))) { fault = 1; fk = 1; esel = n(1) ? 0 : (!n(2) ? 0 : 1); }
      else if (!infb3 && (n(4) || !n(6))) { fault = 1; esel = n(4) ? 0 : (!n(5) ? 0 : 2); } }
    m[x] = fault | fk << 1 | esel << 2 | (n(4) || !n(6) ? 1 : 0) << 4 | (infb ? 1 : 0) << 5; }
  return m; }
// MAR slice: addr p(6) | bus(6)<<6 | cin(2)<<12 | op(2)<<14 (0 hold, 1 +cin, 2 load, 3 load+cin) | ABORT<<16. data: next(6) | cout<<6
function marSlice() { const m = B19();
  for (let x = 0; x < (1 << 17); x++) { const p = x & 63, b = (x >> 6) & 63, ci = (x >> 12) & 3, op = (x >> 14) & 3, ab = (x >> 16) & 1;
    if (!valid(p, 3) || !valid(b, 3) || ci === 3) continue; if (ab) { m[x] = p; continue; }
    const base = op >= 2 ? fromT(decT(b, 3)) : fromT(decT(p, 3)); if (op === 0) { m[x] = p; continue; }
    const s = base + (op === 2 ? 0 : dec(ci)), r = bal(s, 27), co = (s - r) / 27; m[x] = T.encT(T.toT(r, 3)) | enc(co) << 6; }
  return m; }
// shadow snoop: addr RSLOT(5) | RFWR<<5 | SPRNR<<6 | ABORT<<7. data: /UB_LD | /UL_LD<<1
function snoopTable(ub, ul) { const m = B19(); for (let x = 0; x < 256; x++) { const s = x & 31, w = (x >> 5) & 1 && !((x >> 6) & 1) && !((x >> 7) & 1);
    m[x] = (w && s === ub ? 0 : 1) | (w && s === ul ? 0 : 1) << 1; } return m; }
// ---- stage 2: MAR -> RAM / framebuffer address, one level of tables, no carries ----
// a = c0 + 243*c1 + 59049*T, where c0 = trits 0..4, c1 = trits 5..9 (balanced, -121..121) and T = trits 10..15. Balanced
// digits are unique, so (c0, c1, T) names one tryte with no borrow between chunks: each address byte comes from its
// own trits only. Bytes are excess-128 (c + 128 = 7..249). Valid RAM addresses (0 <= a < ramSize <= 3^15) give
// T = 0..243 (row = T >> 5, A16..20 = T & 31); framebuffer addresses give T = 254..260, disjoint from RAM, so the top
// table also says "framebuffer" (FBSEL) and puts T - 254 on A16..18 for the 512K-deep VRAM.
// T2 (MODE = 0): the physical address is (low 9 trits) mod 3^9. Its chunk 1 is trits 5..8 plus 81 when the low 9 trits
// are negative (3^9 = 81 * 243 moves into trit 9), so T2 gets its own chunk-1 table (18 address bits); T = 0.
const val = (bits, lo, n) => fromT(decT(bits >> (2 * lo), n));
function cv0() { const m = B19(); for (let x = 0; x < 1 << 10; x++) if (valid(x, 5)) m[x] = val(x, 0, 5) + 128; return m; }
function cv1t3() { const m = B19(); for (let x = 0; x < 1 << 10; x++) if (valid(x, 5)) m[x] = val(x, 0, 5) + 128; return m; }
function cv1t2(mutant) { const m = B19(); for (let x = 0; x < 1 << 18; x++) { if (!valid(x, 9)) continue;
    const L = val(x, 0, 9), c1 = val(x, 5, 4) + (L < 0 && mutant !== 'T2_NO_WRAP' ? 81 : 0); m[x] = c1 + 128; } return m; }
// top tables. addr: trits 10..15 (12 bits) | MODE << 12. cv2a data: A16..20 | FBSEL << 5. cv2b data: /CE0..7 (rows)
const top = x => { if (!((x >> 12) & 1)) return { T: 0, fb: 0 }; const T = val(x, 0, 6); return { T, fb: T >= 254 && T <= 260 ? 1 : 0 }; };
function cv2a() { const m = B19(); for (let x = 0; x < 1 << 13; x++) { if (!valid(x & 4095, 6)) continue; const { T, fb } = top(x);
    m[x] = (fb ? T - 254 : T >= 0 ? T & 31 : 0) | fb << 5; } return m; }
function cv2b() { const m = B19(); for (let x = 0; x < 1 << 13; x++) { if (!valid(x & 4095, 6)) continue; const { T, fb } = top(x);
    m[x] = !fb && T >= 0 && T < 256 ? 255 & ~(1 << (T >> 5)) : 255; } return m; }
// ---- stage 1b: the address check and MAR without ripple (2026-11-18) ----
// Balanced numbers compare lexicographically: the sign of a - b is the sign of (a_k - b_k) at the most significant trit
// where they differ, because the trits below can't make up a whole unit of 3^k. So every comparison is: slice tables
// in parallel (each gives <, =, >), then one table that takes the first non-equal slice from the top. No carries.
// The "+2" comparisons fold the 2 into the other side: a + 2 < X  <=>  a < X - 2 (constants baked; ULIMIT - 2 is a
// third shadow register, UL2, loaded with ULIMIT through a lookahead "minus 2").
const sgnEnc = d => enc(Math.sign(d));
// variable compare slice: addr a(4 trits) | b(4 trits) << 8 -> data sign(a - b) (2 bits)
function cmpSlice() { const m = B19(); for (let x = 0; x < 1 << 16; x++) { const a = x & 255, b = x >> 8; if (!valid(a, 4) || !valid(b, 4)) continue;
    m[x] = sgnEnc(fromT(decT(a, 4)) - fromT(decT(b, 4))); } return m; }
// combine 7 slice signs (bits 2k, k = 0 lowest) and a "no such number" flag (bit 14) -> bit 0 "a < b", bit 1 "a > b"
function cmpCombine() { const m = B19(); for (let x = 0; x < 1 << 15; x++) { let s = 0; for (let k = 6; k >= 0 && !s; k--) { const e = (x >> (2 * k)) & 3; if (e === 3) { s = NaN; break; } s = dec(e); }
    if (Number.isNaN(s)) continue; m[x] = (x >> 14) & 1 ? 0 : (s < 0 ? 1 : 0) | (s > 0 ? 2 : 0); } return m; }
// constant compare over 7-trit chunks (CHUNKS: trits 0-6, 7-13, 14-20, 21-26; 14 address bits, 16K entries, so the
// images stay small for the copy engine's flash), up to 4 constants per table -> sign per constant (bits 2j)
function constCmpChunk(k, consts) { const [lo, n] = CHUNKS[k], m = B19(), cs = consts.map(v => fromT(T.toT(v, 27).slice(lo, lo + n)));
  for (let x = 0; x < 1 << (2 * n); x++) { if (!valid(x, n)) continue; const v = fromT(decT(x, n)); let d = 0; cs.forEach((c, j) => { d |= sgnEnc(v - c) << (2 * j); }); m[x] = d; } return m; }
// combine for 2 constants: addr bits 8j + 2k = constant j, chunk k (0..3) -> data bit j = "a < constant j"
function constCombine() { const m = B19(); for (let x = 0; x < 1 << 16; x++) { let d = 0, ok = true;
    for (let j = 0; j < 2; j++) { let s = 0; for (let k = 3; k >= 0 && !s; k--) { const e = (x >> (8 * j + 2 * k)) & 3; if (e === 3) { ok = false; break; } s = dec(e); } if (s < 0) d |= 1 << j; }
    if (ok) m[x] = d; } return m; }
// MAR slice without ripple: addr p(6) | bus(6) << 6 | cin(1) << 12 | op(2) << 13 -> next(6). The carry into each slice
// comes from the lookahead table (a +1 carries out of a 3-trit slice only when the slice is +13, all trits +1).
function marSlice2() { const m = B19(); for (let x = 0; x < 1 << 15; x++) { const p = x & 63, b = (x >> 6) & 63, ci = (x >> 12) & 1, op = (x >> 13) & 3;
    if (!valid(p, 3) || !valid(b, 3)) continue; if (op === 0) { m[x] = p; continue; }
    const base = op >= 2 ? fromT(decT(b, 3)) : fromT(decT(p, 3)); m[x] = T.encT(T.toT(bal(base + (op === 2 ? 0 : ci), 27), 3)); } return m; }
// MAR lookahead: addr P0..P7 (slice s of the source is +13) | MARC << 8 -> data bit k-1 = carry into slice k (1..8)
function marLook(mutant) { const m = B19(); for (let x = 0; x < 1 << 9; x++) { let d = 0, c = (x >> 8) & 1; for (let k = 1; k <= (mutant === 'MAR_SHORT_CARRY' ? 1 : 8); k++) { c = c && (x >> (k - 1)) & 1; if (c) d |= 1 << (k - 1); } m[x] = d; } return m; }
// UL2 = D - 2. Lookahead: addr slice 0 of D (6 bits) | N1..N7 << 6 (slice s of D is -13, all trits -1) -> borrow into
// slices 1..8 (bit k-1). Slice 0 borrows when D0 - 2 < -13, i.e. D0 is -12 or -13; a borrow passes a slice that is -13.
function dec2Look(mutant) { const m = B19(); for (let x = 0; x < 1 << 13; x++) { const v0 = x & 63; if (!valid(v0, 3)) continue;
    let b = fromT(decT(v0, 3)) <= -12, d = 0; for (let k = 1; k <= (mutant === 'UL2_SHORT_BORROW' ? 1 : 8); k++) { if (k > 1) b = b && ((x >> (6 + k - 2)) & 1); if (b) d |= 1 << (k - 1); } m[x] = d; } return m; }
// UL2 slice: addr v(6) | borrow << 6 | slice0 << 7 -> slice 0: v - 2; else v - borrow (balanced, mod 27)
function dec2Slice() { const m = B19(); for (let x = 0; x < 1 << 8; x++) { const v = x & 63; if (!valid(v, 3)) continue;
    const r = fromT(decT(v, 3)) - ((x >> 7) & 1 ? 2 : (x >> 6) & 1); m[x] = T.encT(T.toT(bal(r, 27), 3)); } return m; }
module.exports = { subSlice, constChain, faultTable, marSlice, snoopTable, CHUNKS, cv0, cv1t3, cv1t2, cv2a, cv2b,
  cmpSlice, cmpCombine, constCmpChunk, constCombine, marSlice2, marLook, dec2Look, dec2Slice };
