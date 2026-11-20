// video-tables.js: the Video card's lookup tables, stage 1 (CPU side) (Kehai Interim, 2026-11-18). MIT.
// From iocard.js ports 2-5 (displayX, displayY, pixel, fill) and the Memory card's framebuffer layout (MEMORY-CARD.md).
'use strict';
const T = require('./control-tables.js');
const enc = t => t === 1 ? 1 : t === -1 ? 2 : 0, dec = b => b === 1 ? 1 : b === 2 ? -1 : 0;
const valid = (bits, n) => { for (let i = 0; i < n; i++) if (((bits >> (2 * i)) & 3) === 3) return false; return true; };
const decT = (bits, n) => Array.from({ length: n }, (_, i) => dec((bits >> (2 * i)) & 3));
const fromT = t => t.reduceRight((a, d) => 3 * a + d, 0);
const encRails = (v, n) => { let b = 0; T.toT(v, n).forEach((t, i) => { b += enc(t) * 2 ** (2 * i); }); return b; };
const FB_BASE = 15000000, FB_SIZE = 354294;
const B19 = () => Buffer.alloc(1 << 19), B21 = () => Buffer.alloc(1 << 21);
// the Memory card's VRAM address for framebuffer pixel p: (T - 254, c1 + 128, c0 + 128) of a = FB_BASE + p
function fbAddr(p) { const t = T.toT(FB_BASE + p, 27), v = (lo, hi) => fromT(t.slice(lo, hi)); return (v(10, 16) - 254) * 65536 + (v(5, 10) + 128) * 256 + v(0, 5) + 128; }
// --- port decode at the CPU edge. addr PORT(6) | /IN << 6 | /OUT << 7 | /CEDGE << 8
// data: /LDX (OUT 2) | /LDY << 1 (OUT 3) | /LDP << 2 (OUT 4) | /LDC << 3 (OUT 5) | SETPW << 4 (OUT 4) | SETFL << 5 (OUT 5)
//       | SETPR << 6 (IN 4) | /LDIO << 7 (IN 2, 3, 5: the answer is ready at once)
function pdTable() { const m = B19(); for (let x = 0; x < 512; x++) { const port = x & 63, inn = !((x >> 6) & 1), out = !((x >> 7) & 1), edge = !((x >> 8) & 1);
    const o = edge && out && !inn, i = edge && inn && !out; let d = 0b10001111;
    if (o && port === 2) d &= ~1; if (o && port === 3) d &= ~2; if (o && port === 4) { d &= ~4; d |= 16; } if (o && port === 5) { d &= ~8; d |= 32; }
    if (i && port === 4) d |= 64; if (i && (port === 2 || port === 3 || port === 5)) d &= ~128; m[x] = d; } return m; }
// --- answer source and the "selected for BUS = IO" latch. addr PORT(6) | R2 << 6 | /IN << 7 | /CEDGE << 8
// data: SEL0..1 (0 coordinate, 1 fill colour, 2 pixel read from J2) | VSELD << 2 | /VSLD << 3 | YSEL << 4
function pd2Table() { const m = B19(); for (let x = 0; x < 512; x++) { const port = x & 63, r2 = (x >> 6) & 1, inn = !((x >> 7) & 1), edge = !((x >> 8) & 1);
    const sel = r2 ? 2 : port === 5 ? 1 : 0, mine = port >= 2 && port <= 5;
    m[x] = sel | (mine ? 4 : 0) | (edge && inn ? 0 : 8) | (port === 3 ? 16 : 0); } return m; }
// --- the sequencer, one 40 MHz slot at a time.
// addr SETPW | SETFL << 1 | SETPR << 2 | PW << 3 | PR << 4 | FL << 5 | FDONE << 6 | FREE << 7 | R1 << 8 | R2 << 9 | RESET << 10
// data: PW' | PR' << 1 | FL' << 2 | /SWRD << 3 | R1D << 4 | CNTADV << 5 | CNTRST << 6 | READY << 7
// One J2 operation per free slot: the fill, a pending pixel write, or a pending pixel read (fill first; the CPU waits
// in WAIT for all of them, so they never overlap in practice).
function seqTable(mutant) { const m = B19(); for (let x = 0; x < 1 << 11; x++) { const b = i => (x >> i) & 1;
    const [spw, sfl, spr, pw, pr, fl, done, free, r1, r2, rst] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(b);
    if (rst) { m[x] = 8 | 128; continue; }
    let npw = pw, npr = pr, nfl = fl, swr = 1, r1d = 0, adv = 0, crst = 0;
    if (free && fl) { swr = 0; adv = 1; if (done || mutant === 'FILL_ONE_PIXEL') nfl = 0; }
    else if (free && pw) { swr = 0; npw = 0; }
    else if (free && pr) { r1d = 1; npr = 0; }
    if (spw) npw = 1; if (sfl) { nfl = 1; crst = 1; } if (spr) npr = 1;
    const busy = npw || npr || (mutant === 'READY_IGNORES_FILL' ? 0 : nfl) || r1d || r1 || (mutant === 'READY_EARLY' ? 0 : r2);   // READY_EARLY: equivalent (BUS = IO is a whole microcycle later), kept as a record
    m[x] = npw | npr << 1 | nfl << 2 | swr << 3 | r1d << 4 | adv << 5 | crst << 6 | (busy ? 0 : 128); } return m; }
// --- fill counters. fxn: addr FX(10) | MODE << 10 | RST << 11 -> next FX (10 bits) | WRAP << 10, split over 2 chips
// fyn: addr FY(9) | MODE << 9 | WRAPX << 10 | RST << 11 -> next FY (9 bits) | DONE << 9
function fxnTable(half) { const m = B19(); for (let x = 0; x < 1 << 12; x++) { const fx = x & 1023, w = (x >> 10) & 1 ? 729 : 243, rst = (x >> 11) & 1;
    const wrap = fx === w - 1 ? 1 : 0, nx = rst ? 0 : (wrap ? 0 : fx + 1) & 1023, d = nx | wrap << 10; m[x] = half ? d >> 8 : d & 255; } return m; }
function fynTable(half) { const m = B19(); for (let x = 0; x < 1 << 12; x++) { const fy = x & 511, h = (x >> 9) & 1 ? 486 : 243, wx = (x >> 10) & 1, rst = (x >> 11) & 1;
    const last = fy === h - 1, ny = rst ? 0 : wx ? (last ? 0 : fy + 1) & 511 : fy, d = ny | (wx && last ? 1 : 0) << 9; m[x] = half ? d >> 8 : d & 255; } return m; }
// --- coordinate in: addr tryte 0 of the bus (18 rails) | MODE << 18 | PORT0 << 19 (0: port 2, X; 1: port 3, Y)
// -> the coordinate, w0 mod 729 / 486 (T3) or mod 243 (T2), 10 bits over 2 chips (2M x 8)
function ciTable(half, mutant) { const m = B21(); for (let x = 0; x < 1 << 20; x++) { const r = x & 0x3ffff; if (!valid(r, 9)) continue;
    const w0 = fromT(decT(r, 9)), t3 = (x >> 18) & 1, isY = (x >> 19) & 1, w = t3 ? (isY ? 486 : 729) : (mutant === 'T2_COORD_729' ? 729 : 243);
    const v = ((w0 % w) + w) % w; m[x] = half ? v >> 8 : v & 255; } return m; }
// --- coordinate out (IN 2, IN 3): addr a value 0..1023 (10 bits) -> its tryte as 18 rails, over 3 chips
function ctTable(k) { const m = B19(); for (let v = 0; v < 1024; v++) m[v] = (encRails(v, 9) / 2 ** (8 * k)) & 255; return m; }
// --- pixel address: addr X(10) | Y(9) << 10 | MODE << 19 -> the Memory card's 19-bit VRAM address, over 3 chips (2M x 8)
// pixel index p = Y * 729 + X (T3) or Y * 243 + X (T2), exactly as iocard.js computes it
// Stage 2 adds address bit 20, SCREEN: the coordinates are screen pixels (0..728, 0..485) from the fetch engine, so T2's
// 243 x 243 picture is scaled here, 3 wide and 2 tall (X / 3, Y / 2), exactly as the emulator's renderDisplay does.
function paTables(mutant) { const ms = [B21(), B21(), B21()];
  for (let x = 0; x < 1 << 21; x++) { let X = x & 1023, Y = (x >> 10) & 511; const t3 = (x >> 19) & 1, scr = (x >> 20) & 1;
    if (scr && !t3) { X = Math.floor(X / (mutant === 'T2_SCALE_OFF' ? 2 : 3)); Y = Math.floor(Y / 2); }
    const p = Y * (t3 ? 729 : 243) + X;
    if (p >= FB_SIZE) continue; const a = fbAddr(mutant === 'PA_STRIDE_T2' && !t3 ? Y * 729 + X : p); ms[0][x] = a & 255; ms[1][x] = (a >> 8) & 255; ms[2][x] = a >> 16; }
  return ms; }
// ===== stage 2: scan-out, VESA 800 x 600 at 60 Hz, 40 MHz (one slot per pixel) =====
// H: 800 visible + 40 front + 128 sync + 88 back = 1056; V: 600 + 1 + 4 + 23 = 628; both syncs positive.
// The 729 x 486 picture is centred 1:1: columns 35..763, rows 57..542. During screen line VC the fetch engine reads
// picture row VC - 56 (the next line) into the idle line-buffer bank, stopping 3 slots before the line ends so its
// 2-slot pipeline never spills into the next line (when that bank becomes the one on display).
const H = { TOT: 1056, SYNC0: 840, SYNC1: 968, PIC0: 35, PIC1: 764, FSTOP: 1053 }, VV = { TOT: 628, SYNC0: 601, SYNC1: 605, PIC0: 57, PIC1: 543 };
// H tables, addr HC (11 bits). h0: next HC 0..7. h1: next 8..10 | HS << 3 | HPIC << 4 | LEND << 5 | XD8 << 6 | XD9 << 7.
// h2: XD 0..7 (the picture column HC - 35). h3: FWIN (HC < 1053).
function hTables(mutant) { const t = [B19(), B19(), B19(), B19()];
  for (let hc = 0; hc < 2048; hc++) { const nx = hc >= H.TOT - 1 ? 0 : hc + 1, hs = hc >= H.SYNC0 && hc < (mutant === 'HSYNC_SHORT' ? H.SYNC1 - 1 : H.SYNC1) ? 1 : 0;
    const pic = hc >= H.PIC0 && hc < H.PIC1 ? 1 : 0, lend = hc === H.TOT - 1 ? 1 : 0, xd = pic ? hc - H.PIC0 : 0;
    t[0][hc] = nx & 255; t[1][hc] = (nx >> 8) | hs << 3 | pic << 4 | lend << 5 | ((xd >> 8) & 3) << 6; t[2][hc] = xd & 255; t[3][hc] = hc < H.FSTOP ? 1 : 0; }
  return t; }
// V tables, addr VC (10 bits) | LEND << 10. v0: next VC 0..7. v1: next 8..9 | VS << 2 | VPIC << 3 | FLINE << 4 | DB << 5 | FB << 6 | PY8 << 7.
// v2: PY 0..7 (the picture row being fetched, VC - 56). DB = display bank, (VC - 57) & 1; FB = fetch bank, (VC - 56) & 1.
function vTables(mutant) { const t = [B19(), B19(), B19()];
  for (let x = 0; x < 2048; x++) { const vc = x & 1023, lend = (x >> 10) & 1, nx = lend ? (vc >= VV.TOT - 1 ? 0 : vc + 1) : vc;
    const vs = vc >= VV.SYNC0 && vc < VV.SYNC1 ? 1 : 0, vpic = vc >= VV.PIC0 && vc < VV.PIC1 ? 1 : 0;
    const off = mutant === 'FETCH_ROW_OFF' ? 57 : 56, fline = vc >= VV.PIC0 - 1 && vc < VV.PIC1 - 1 ? 1 : 0, py = fline ? vc - off : 0;
    const db = ((vc - 57) % 2 + 2) % 2, fb = mutant === 'BANK_FLIP' ? db : ((vc - 56) % 2 + 2) % 2;
    t[0][x] = nx & 255; t[1][x] = (nx >> 8) | vs << 2 | vpic << 3 | fline << 4 | db << 5 | fb << 6 | ((py >> 8) & 1) << 7; t[2][x] = py & 255; }
  return t; }
// fetch counter, addr FXC (10 bits) | LEND << 10 | FNOW << 11 -> next FXC (10) | NFACT << 10 (more of this line to fetch)
function fxcTables(half) { const m = B19(); for (let x = 0; x < 4096; x++) { const f = x & 1023, lend = (x >> 10) & 1, now = (x >> 11) & 1;
    const nx = lend ? 0 : now ? Math.min(f + 1, 1023) : f, d = nx | (nx < 729 ? 1 : 0) << 10; m[x] = half ? d >> 8 : d & 255; } return m; }
// palette -> DAC drive. addr the pixel's 12 rails | MODE << 12 | PIC << 13. Per channel (B = trits 0-1, G = 2-3, R = 4-5)
// 4 drive bits p_hi, !n_hi, p_lo, !n_lo (DAC sum = 3(th + 1) + (tl + 1) = level 0..8). T3: the diad itself.
// T2: one trit per channel (B = trit 0, G = 1, R = 2) at the emulator's 28 / 132 / 242, mapped to the nearest of the
// 9 levels 0, 32, ..., 224, 255 (levels 1, 4, 8); a T2 value outside -13..13 is black, as in the emulator.
// Outside the picture: black (level 0). pal0: B and G, pal1: R.
const LV9 = [0, 32, 64, 96, 128, 160, 192, 224, 255], LV3 = [28, 132, 242];
const near9 = L => LV9.reduce((b, v, i) => Math.abs(v - L) < Math.abs(LV9[b] - L) ? i : b, 0);
const drive = lvl => { const v = lvl - 4, tl = ((v % 3) + 4) % 3 - 1, th = (v - tl) / 3; return (th === 1 ? 1 : 0) | (th !== -1 ? 1 : 0) << 1 | (tl === 1 ? 1 : 0) << 2 | (tl !== -1 ? 1 : 0) << 3; };
function palTables(mutant) { const t = [B19(), B19()];
  for (let x = 0; x < 1 << 14; x++) { const rails = x & 4095, t3 = (x >> 12) & 1, pic = (x >> 13) & 1; if (!valid(rails, 6)) continue;
    const tr = decT(rails, 6); let lv;
    if (!pic) lv = [0, 0, 0];
    else if (t3) lv = [tr[0] + 3 * tr[1] + 4, tr[2] + 3 * tr[3] + 4, tr[4] + 3 * tr[5] + 4];
    else if (tr[3] || tr[4] || tr[5]) lv = [0, 0, 0];   // T2 shows values outside -13..13 as black (PALETTE_27[c] || [0, 0, 0])
    else lv = [near9(LV3[tr[0] + 1]), near9(LV3[tr[1] + 1]), near9(LV3[tr[2] + 1])];
    if (mutant === 'PALETTE_RB_SWAP') lv = [lv[2], lv[1], lv[0]];
    const d = drive(lv[0]) | drive(lv[1]) << 4 | drive(lv[2]) << 8; t[0][x] = d & 255; t[1][x] = d >> 8; }
  return t; }
module.exports = { hTables, vTables, fxcTables, palTables, H, VV, LV9, LV3, near9, pdTable, pd2Table, seqTable, fxnTable, fynTable, ciTable, ctTable, paTables, fbAddr, encRails, FB_BASE, FB_SIZE };
