// load-paths.js: table address/data nets per card, their drivers, and the load-bus colouring (Kehai Interim, 2026-11-18). MIT. See COPY-ENGINE.md.
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
const ROMS = ''+path.join(__dirname,'../roms')+'';
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

const { P } = require('./parts.js');
for (const [name, mk] of Object.entries(cards)) { const card = mk(); const drv = new Map();
  for (const c of card.chips) for (const o of (P[c.part].out || [])) if (c.pins[o]) drv.set(c.pins[o], c);
  const addr = new Set(), data = new Set(); let tables = 0;
  for (const c of card.chips) { if (!c.mem || c.pins['/WE'] !== 'VCC') continue; tables++;
    for (const [p, n] of Object.entries(c.pins)) { if (/^A\d+$/.test(p) && n !== 'GND' && n !== 'VCC') addr.add(n); if (/^IO\d+$/.test(p)) data.add(n); } }
  const kinds = {}; for (const n of addr) { const d = drv.get(n); const k = !d ? 'card input' : P[d.part].tri ? 'tristate ' + d.part : d.part; kinds[k] = (kinds[k] || 0) + 1; }
  console.log(name.padEnd(14), tables, 'tables;', addr.size, 'distinct address nets;', data.size, 'data nets; address drivers:', JSON.stringify(kinds)); }
// coloring: every net on a table chip (address + data) needs a load-bus line distinct from the chip's other nets
console.log('--- coloring (DSATUR): load-bus lines needed per card');
for (const [name, mk] of Object.entries(cards)) { const card = mk(); const adj = new Map(); const add = n => { if (!adj.has(n)) adj.set(n, new Set()); return adj.get(n); };
  let widest = 0;
  for (const c of card.chips) { if (!c.mem || c.pins['/WE'] !== 'VCC') continue;
    const nets = [...new Set(Object.entries(c.pins).filter(([p, n]) => (/^A\d+$/.test(p) || /^IO\d+$/.test(p)) && n !== 'GND' && n !== 'VCC').map(([, n]) => n))];
    widest = Math.max(widest, nets.length); for (const a of nets) { const s = add(a); for (const b of nets) if (a !== b) s.add(b); } }
  const col = new Map(); const left = new Set(adj.keys());
  while (left.size) { let best = null, bs = -1, bd = -1; for (const v of left) { const sat = new Set([...adj.get(v)].filter(u => col.has(u)).map(u => col.get(u))).size, d = adj.get(v).size; if (sat > bs || (sat === bs && d > bd)) { best = v; bs = sat; bd = d; } }
    const used = new Set([...adj.get(best)].filter(u => col.has(u)).map(u => col.get(u))); let k = 0; while (used.has(k)) k++; col.set(best, k); left.delete(best); }
  console.log(name.padEnd(14), 'nets', adj.size, '| widest table chip', widest, 'nets | colors needed', Math.max(...col.values()) + 1); }
