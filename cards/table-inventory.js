// table-inventory.js: every lookup-table SRAM on every card, and what the copy engine has to load (Kehai Interim,
// 2026-11-18). MIT.
// A "table" is an SRAM whose /WE is tied high on the card (read-only after power-up). Writable SRAMs (RAM rows, VRAM,
// line buffers, register files) are left out: the copy engine doesn't fill them.
// For each table: the address range actually wired (highest connected address pin), the data width (connected IO
// pins) and a content hash over that range. Identical images are counted once: the copy engine can write every chip
// that holds the same image in the same pass (they share LOAD_SEL), so flash holds each distinct image once.
// The control-store SRAMs are included; their content comes from the ROM images, as in the card tests.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { decodeWord } = require('../microsim/roms.js');
const { MicroMachine, WORD_BITS, SLOT } = require('../microsim/microsim.js');
const ROMS = path.join(__dirname, '../roms');
const romChips = Array.from({ length: Math.ceil(WORD_BITS / 8) }, (_, k) => fs.readFileSync(path.join(ROMS, `cs${k}.bin`)));
const words = []; for (let w = 0; w < 1024; w++) { let b = 0n; for (let k = 0; k < romChips.length; k++) b |= BigInt(romChips[k][w]) << BigInt(8 * k); let mu = null; try { mu = decodeWord(b); } catch { } words.push(mu); }
const m0 = new MicroMachine(), fixedA = { FETCH: m0.cs.addr.FETCH, FETCH2: m0.cs.addr.FETCH2 }, fixedC = { FETCH: m0.cs.addr.FETCH };
const cards = {
  ALU: () => { const C = require('./alu-card.js'); const cs = [0, 1, 2, 3].map(() => Buffer.alloc(1024));
    words.forEach((mu, w) => { if (!mu) return; const cw = C.cardWord(mu, w, fixedA); for (let j = 0; j < 4; j++) cs[j][w] = (cw >> (8 * j)) & 255; });
    return C.build(fs.readFileSync(path.join(ROMS, 'alu.bin')), cs); },
  Registers: () => { const C = require('./registers-card.js'); const cs = Buffer.alloc(1 << 19); words.forEach((mu, w) => { if (mu) cs[w] = C.cardWord(mu); }); return C.build(cs); },
  Control: () => { const C = require('./control-card.js'); const n = Math.ceil(C.CW.length / 8), cs = Array.from({ length: n }, () => Buffer.alloc(1024));
    words.forEach((mu, w) => { if (!mu) return; const cw = C.cardWord(mu, w, fixedC); for (let j = 0; j < n; j++) cs[j][w] = Number((cw >> BigInt(8 * j)) & 255n); }); return C.build(ROMS, cs); },
  'Memory (3^14)': () => { const C = require('./memory-card.js'); const cs = [0, 1, 2].map(() => Buffer.alloc(1024));
    words.forEach((mu, w) => { if (!mu) return; const cw = C.cardWord(mu); for (let j = 0; j < 3; j++) cs[j][w] = (cw >> (8 * j)) & 255; }); return C.build(cs, 4782969, SLOT); },
  Video: () => { const C = require('./video-card.js'); const cs = Buffer.alloc(1 << 19); words.forEach((mu, w) => { if (mu) cs[w] = C.cardWord(mu); }); return C.build(cs); },
};
module.exports = { cards };
if (require.main === module) {
const all = new Map(); let grand = { chips: 0, raw: 0 }; const per = [];
for (const [name, mk] of Object.entries(cards)) {
  const card = mk(); let n = 0, raw = 0; const local = new Map();
  for (const c of card.chips) { if (!c.mem || c.pins['/WE'] !== 'VCC') continue;
    let hi = -1; for (const [p, net] of Object.entries(c.pins)) { const m = /^A(\d+)$/.exec(p); if (m && net !== 'GND' && net !== 'VCC') hi = Math.max(hi, +m[1]); }
    const width = Object.keys(c.pins).filter(p => /^IO\d+$/.test(p)).length, bytes = width > 8 ? 2 : 1, range = 2 ** (hi + 1);
    const img = Buffer.from(c.mem.buffer, c.mem.byteOffset, range * c.mem.BYTES_PER_ELEMENT);
    const h = crypto.createHash('sha256').update(img).update(String(bytes)).digest('hex'), size = range * bytes;
    n++; raw += size; if (!local.has(h)) local.set(h, { size, refs: [] }); local.get(h).refs.push(c.ref);
    if (!all.has(h)) all.set(h, { size, refs: [] }); all.get(h).refs.push(`${name}:${c.ref}`); }
  const distinct = [...local.values()].reduce((a, x) => a + x.size, 0); grand.chips += n; grand.raw += raw;
  const big = [...local.values()].sort((a, b) => b.size - a.size).slice(0, 4).map(x => `${x.refs.slice(0, 3).join('/')}${x.refs.length > 3 ? '…' : ''} ${(x.size / 1024).toFixed(0)} KB`);
  per.push({ name, n, raw, distinct, imgs: local.size, big });
  console.log(`${name.padEnd(14)} ${String(n).padStart(3)} table chips, ${local.size} distinct images, ${(distinct / 1048576).toFixed(2)} MB distinct (${(raw / 1048576).toFixed(2)} MB if every chip had its own). Largest: ${big.join('; ')}`);
}
const tot = [...all.values()].reduce((a, x) => a + x.size, 0);
console.log(`\nAll cards: ${grand.chips} table chips, ${all.size} distinct images, ${(tot / 1048576).toFixed(2)} MB distinct (${(grand.raw / 1048576).toFixed(2)} MB raw). The planned flash: 2 x SST39SF040 = 1.00 MB.`);
fs.writeFileSync(path.join(__dirname, 'table-inventory.json'), JSON.stringify({ date: new Date().toISOString(), perCard: per, distinctImages: all.size, distinctBytes: tot, rawBytes: grand.raw }, null, 1));
}
