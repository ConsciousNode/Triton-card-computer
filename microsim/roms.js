// roms.js: the card computer's ROM images, exported from the microsim, and a machine that runs FROM those images
// (Kehai Interim, 2026-11-18). MIT.
//
//   node roms.js export [dir]   writes the images + MANIFEST.md (sha256 of each) into dir (default ../roms)
//   require('./roms.js').romMachine(dir, ramSize) -> a MicroMachine whose control store, dispatch table and ALU are
//                                decoded from the image bytes alone (used by verify-roms.js)
//
// Images (all byte-wide; a dual-rail trit is two bits: p = "is +", n = "is -", 0 = both low):
//   cs0.bin .. cs8.bin  control store, 1,024 words; chip k holds microword bits 8k..8k+7 (72 bits = 9 chips)
//   dispatch.bin        2 x 243 entries x 2 bytes: [mode T2/T3][opcode + 121] -> 10-bit microaddress (lo, hi)
//                       (unallocated opcodes point at TRAP_ILL in T3 and at T2_HALT in T2, as the emulator)
//   alu.bin             one ALU slice, 512K x 8 (19 address bits), the same image in all 9 slice chips:
//                       address = a(6) | b(6) << 6 | cin(2) << 12 | fn(4) << 14 | neg(1) << 18
//                       data    = r(6) | cout(2) << 6     (3 result trits and the carry, dual-rail)
//                       B negation is folded into the table (neg bit), so no rail-swap mux sits in the ripple path.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ms = require('./microsim.js');
const { MicroMachine, buildStore, FIELDS, WORD_BITS, ENUM, ALU_FNS, LUT, OPC } = ms;
const CS_WORDS = 1024, ALU_SIZE = 1 << 19;
const enc1 = t => t === 1 ? 1 : t === -1 ? 2 : 0;                 // trit -> (p, n) bits
const dec1 = b => (b & 1) && !(b & 2) ? 1 : (b & 2) && !(b & 1) ? -1 : 0;
const toTrits = (v, n) => { const t = []; for (let i = 0; i < n; i++) { let d = ((v % 3) + 3) % 3; if (d === 2) d = -1; t.push(d); v = (v - d) / 3; } return t; };
const encTrits = t => t.reduce((a, d, i) => a | (enc1(d) << (2 * i)), 0);
const decTrits = (bits, n) => { const t = []; for (let i = 0; i < n; i++) t.push(dec1((bits >> (2 * i)) & 3)); return t; };

function buildImages() {
  if (process.env.MICROSIM_MUTANT) throw new Error('refusing to export ROMs with a planted mutant');
  const cs = buildStore();
  if (cs.store.length > CS_WORDS) throw new Error('control store overflow');
  const csChips = Array.from({ length: Math.ceil(WORD_BITS / 8) }, () => Buffer.alloc(CS_WORDS));
  cs.bits.forEach((b, w) => { for (let k = 0; k < csChips.length; k++) csChips[k][w] = Number((b >> BigInt(8 * k)) & 0xFFn); });
  const disp = Buffer.alloc(2 * 243 * 2);
  for (let mode = 0; mode < 2; mode++) for (let op = -121; op <= 121; op++) {
    let a = mode === 1 ? cs.dispatch.get(op) : cs.dispatchT2.get(op);
    if (a === undefined) a = mode === 1 ? cs.addr.TRAP_ILL : cs.addr.T2_HALT;
    const i = (mode * 243 + op + 121) * 2; disp[i] = a & 0xFF; disp[i + 1] = a >> 8; }
  const alu = Buffer.alloc(ALU_SIZE);
  for (let fi = 0; fi < ALU_FNS.length; fi++) for (let neg = 0; neg < 2; neg++) for (let a = -13; a <= 13; a++) for (let b = -13; b <= 13; b++) for (let c = -1; c <= 1; c++) {
    const bb = neg ? -b : b, i = (((a + 13) * 27 + (bb + 13)) * 3 + (c + 1)) * 2, tab = LUT[ALU_FNS[fi]];
    const r = tab[i], co = tab[i + 1];
    const addr = encTrits(toTrits(a, 3)) | encTrits(toTrits(b, 3)) << 6 | enc1(c) << 12 | fi << 14 | neg << 18;
    alu[addr] = encTrits(toTrits(r, 3)) | enc1(co) << 6; }
  return { cs, csChips, disp, alu };
}

function exportImages(dir) {
  const { cs, csChips, disp, alu } = buildImages(); fs.mkdirSync(dir, { recursive: true });
  const files = [...csChips.map((b, k) => [`cs${k}.bin`, b]), ['dispatch.bin', disp], ['alu.bin', alu]];
  const rows = files.map(([n, b]) => { fs.writeFileSync(path.join(dir, n), b); return `| \`${n}\` | ${b.length.toLocaleString()} | \`${crypto.createHash('sha256').update(b).digest('hex')}\` |`; });
  const src = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'microsim.js'))).digest('hex');
  fs.writeFileSync(path.join(dir, 'MANIFEST.md'), `# Triton card computer ROM images\nExported by \`microsim/roms.js\` from \`microsim.js\` (sha256 \`${src}\`) on ${new Date().toISOString().slice(0, 10)}.\n` +
    `Control store: ${cs.store.length} of ${CS_WORDS} words used, ${WORD_BITS}-bit microword. Layouts are documented at the top of roms.js.\n` +
    `Verified by \`microsim/verify-roms.js\` (a machine built from these bytes alone runs the differential and boots TritOS).\n\n| File | Bytes | sha256 |\n| --- | --- | --- |\n${rows.join('\n')}\n`);
  return files.length;
}

// ---- reading the images back: nothing below looks at MICRO, the labels or the LUT ----
function decodeWord(bits) {
  const mu = {}; let pos = 0n;
  for (const [name, w] of FIELDS) {
    const v = Number((bits >> pos) & ((1n << BigInt(w)) - 1n)); pos += BigInt(w);
    if (ENUM[name]) { const e = ENUM[name][v]; if (e === undefined) throw new Error(`bad ${name} code ${v}`);
      mu[name] = name === 'B_NEG' ? (e === '0' ? 0 : e === '1' ? 1 : 'QT') : e; }   // every enum field, default codes included
    else if (v) mu[name] = v; }
  if (mu.CONST === undefined) mu.CONST = 0;
  return mu;
}
function romMachine(dir, ramSize) {
  const rd = n => fs.readFileSync(path.join(dir, n));
  const chips = Array.from({ length: Math.ceil(WORD_BITS / 8) }, (_, k) => rd(`cs${k}.bin`));
  const disp = rd('dispatch.bin'), alu = rd('alu.bin');
  const m = new MicroMachine(ramSize);
  const ref = m.cs;                        // keep only the named entry points the hardware has as fixed addresses
  const store = [];
  for (let w = 0; w < CS_WORDS; w++) { let b = 0n; for (let k = 0; k < chips.length; k++) b |= BigInt(chips[k][w]) << BigInt(8 * k); store.push({ ...decodeWord(b), _r: 'rom' }); }
  const dispatch = new Map(), dispatchT2 = new Map();
  for (let op = -121; op <= 121; op++) { dispatch.set(op, disp[(243 + op + 121) * 2] | disp[(243 + op + 121) * 2 + 1] << 8);
    dispatchT2.set(op, disp[(op + 121) * 2] | disp[(op + 121) * 2 + 1] << 8); }
  // fixed addresses the sequencer/fault/interrupt hardware jumps to (wired, like a reset vector)
  const addr = {}; for (const k of ['FETCH', 'FETCH2', 'TRAP_PROT', 'TRAP_BAD', 'TRAP_ILL', 'T2_HALT', 'IRQ_ENTRY']) addr[k] = ref.addr[k];
  m.cs = { store, addr, dispatch, dispatchT2 };
  m.aluImpl = (fn, A, B, neg, cin, bcast) => {   // 9 slice lookups, carry rippling from slice to slice
    const fi = ALU_FNS.indexOf(fn), ta = toTrits(A, 27), tb = toTrits(B, 27); let c = cin, out = 0;
    for (let s = 0; s < 9; s++) { const sb = bcast ? 0 : s;
      const addr = encTrits(ta.slice(3 * s, 3 * s + 3)) | encTrits(tb.slice(3 * sb, 3 * sb + 3)) << 6 | enc1(c) << 12 | fi << 14 | (neg ? 1 : 0) << 18;
      const d = alu[addr], r = decTrits(d & 63, 3); out += (r[0] + 3 * r[1] + 9 * r[2]) * 27 ** s; c = dec1(d >> 6); }
    return { r: out, cout: c };
  };
  return m;
}
module.exports = { exportImages, romMachine, decodeWord, buildImages };
if (require.main === module && process.argv[2] === 'export') {
  const dir = process.argv[3] || path.join(__dirname, '../roms'); console.log(`wrote ${exportImages(dir)} images to ${dir}`); }
