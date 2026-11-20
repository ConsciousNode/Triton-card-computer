// load-sim.js: power-up loading through the resistor-coupled load bus, simulated on the real card netlists
// (Kehai Interim, 2026-11-18). MIT. See COPY-ENGINE.md, option B.
// For each card: build it, add the load path (loadpath.js), keep each table's intended image, then BLANK every table
// (random garbage) and load it the way the copy engine would: LOAD = 1, the card's LOAD_SEL, the chip index on
// LDB32..38, the address and data bits routed onto the chip's load lines (its colouring), LOAD_WE = 1, settle the whole
// card, and let the chip with /WE low store what its pins see. Checks at every write:
//   - exactly one table on the card has /WE low, the right one;
//   - every address and data pin of that chip reads the value the copy engine meant (no driver left on, no contention);
// Per chip:
//   - routing proof: walking-one and walking-zero over the chip's lines. Every pin follows its own line and nothing
//     else. Because each pin is a pure copy of one line, that covers every pattern;
//   - writes with a full settle: every reachable entry for small tables (<= FULL entries), a random sample for big
//     ones (SAMPLE entries, always including 0 and the last);
//   - after loading: each written entry read back from the chip's memory against the image, bit for bit.
// Mutants (LP_MUTANT): WRONG_COLOUR, DRIVER_LEFT_ON, WE_SWAP (loadpath.js); STUCK_LINE (one load line stuck at 0).
'use strict';
const { cards } = require('./table-inventory.js'); const { addLoadPath, tableNets, LINES, selectWord } = require('./loadpath.js'); const { P } = require('./parts.js');
const MUT = process.env.LP_MUTANT, FULL = +(process.env.FULL || 4096), SAMPLE = +(process.env.SAMPLE || 600), which = process.argv.slice(2);
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const results = []; let totalBad = 0;
for (const [name, mk] of Object.entries(cards)) {
  if (which.length && !which.some(w => name.startsWith(w))) continue;
  const t0 = Date.now(), card = mk(); const cardId = Object.keys(cards).indexOf(name);
  addLoadPath(card, { cardId, mutant: MUT, worldLoad: { RESET: 1 } }); card.check();
  const L = card.loadPath, col = L.colour, msgs = []; let writes = 0, settles = 0, proved = 0;
  // every table gets its own memory (the builders share one buffer between chips with the same image), then a copy of
  // its intended image is kept, then the chip is filled with garbage
  for (const t of L.tables) t.mem = Uint8Array.prototype.slice.call(t.mem.BYTES_PER_ELEMENT === 1 ? new Uint8Array(t.mem) : t.mem) ;
  const images = new Map(L.tables.map(t => [t.ref, (t.mem.BYTES_PER_ELEMENT === 1 ? new Uint8Array(t.mem) : new Uint16Array(t.mem))]));
  for (const t of L.tables) for (let i = 0; i < t.mem.length; i++) t.mem[i] = Math.floor(rnd() * 65536) & (t.mem.BYTES_PER_ELEMENT === 1 ? 255 : 65535);
  const freeNet = [...L.colour.keys()].filter(n => !LINES.includes(n)).sort()[0], stuck = MUT === 'STUCK_LINE' ? LINES[L.colour.get(freeNet)] : null;
  // LOAD: the copy engine drives every engine line on the backplane; everything else from other cards is quiet (0)
  const base = new Map(); for (const n of card.inputs) if (n !== 'GND' && n !== 'VCC') base.set(n, 0);
  base.set('LOAD', 1); base.set('LOAD_WE', 0); base.set('LOAD_SEL0', 0); base.set('LOAD_SEL1', 0);
  const engine = LINES.filter(n => card.inputs.has(n));
  const lineOfNet = n => LINES[L.colour.get(n)];
  const settle = (k, lines, we) => { const w = new Map(base); for (const n of engine) w.set(n, 0);
    for (const [ln, x] of lines) w.set(ln, x); w.set('LOAD_WE', we); if (stuck) w.set(stuck, 0); settles++; const v = card.settle(w);
    for (const n of engine) if (v.get(n) !== w.get(n)) throw new Error(`the card drove engine line ${n} during LOAD`); return v; };
  // select: 16 bits shifted into the card's '164 pair, MSB first (LOAD_SEL0 data, LOAD_SEL1 clock)
  const sh = ['LP_SH0', 'LP_SH1'].map(r => card.chips.find(c => c.ref === r));
  const select = k => { const word = selectWord(cardId, k); for (let b = 15; b >= 0; b--) { base.set('LOAD_SEL0', (word >> b) & 1); const v = settle(k, [], 0);
      for (const c of sh) P[c.part].clock(c, p => v.get(c.pins[p])); } base.set('LOAD_SEL0', 0); };
  L.tables.forEach((t, k) => {
    if (msgs.length > 6) return;
    const apins = Object.keys(t.pins).filter(p => /^A\d+$/.test(p)).sort((a, b) => a.slice(1) - b.slice(1)), dpins = Object.keys(t.pins).filter(p => /^IO\d+$/.test(p));
    const hi = Math.max(...apins.filter(p => !['GND', 'VCC'].includes(t.pins[p])).map(p => +p.slice(1))), range = 2 ** (hi + 1), img = images.get(t.ref);
    const dmask = dpins.reduce((m, p) => t.pins[p] ? m | (1 << +p.slice(2)) : m, 0);   // data bits the chip actually has wired
    select(k);
    const lineOf = p => lineOfNet(t.pins[p]), myLines = [...new Set([...apins, ...dpins].filter(p => !['GND', 'VCC'].includes(t.pins[p])).map(lineOf))];
    const readPins = v => { let a = 0, d = 0; apins.forEach(p => { a += (t.pins[p] === 'VCC' ? 1 : t.pins[p] === 'GND' ? 0 : v.get(t.pins[p])) * 2 ** +p.slice(1); }); dpins.forEach(p => { if (t.pins[p]) d |= v.get(t.pins[p]) << +p.slice(2); }); return [a, d]; };
    // routing proof: walking one and walking zero over this chip's lines
    try { for (const ln of myLines) for (const pol of [1, 0]) { const lines = myLines.map(l => [l, l === ln ? pol : 1 - pol]); const v = settle(k, lines, 0);
        for (const p of [...apins, ...dpins]) { const n = t.pins[p]; if (n === 'GND' || n === 'VCC') continue; const want = lineOf(p) === ln ? pol : 1 - pol;
          if (v.get(n) !== want) throw new Error(`${t.ref}.${p} (${n}) reads ${v.get(n)} with ${ln}=${pol}, others ${1 - pol}`); } }
      proved++;
    } catch (e) { msgs.push('routing: ' + e.message.slice(0, 200)); return; }
    // writes: which addresses are reachable (pins sharing a net must agree; a pin on VCC must be 1)
    const reachable = a => { const seen = new Map(); for (const p of apins) { const n = t.pins[p], bit = Math.floor(a / 2 ** +p.slice(1)) % 2;
        if (n === 'GND' && bit) return false; if (n === 'VCC' && !bit) return false; if (seen.has(n) && seen.get(n) !== bit) return false; seen.set(n, bit); } return true; };
    let addrs = []; if (range <= FULL) { for (let a = 0; a < range; a++) addrs.push(a); } else { addrs = [0, range - 1]; for (let i = 0; i < SAMPLE; i++) addrs.push(Math.floor(rnd() * range)); }
    addrs = addrs.filter(reachable);
    for (const a of addrs) { const lines = new Map();
      for (const p of apins) { const n = t.pins[p]; if (n === 'GND' || n === 'VCC') continue; lines.set(lineOf(p), Math.floor(a / 2 ** +p.slice(1)) % 2); }
      dpins.forEach(p => { if (t.pins[p]) lines.set(lineOf(p), (img[a] >> +p.slice(2)) & 1); });   // IO pin number = data bit
      let v; try { v = settle(k, lines, 1); } catch (e) { msgs.push(`${t.ref} @${a}: ${e.message.slice(0, 160)}`); return; }
      const low = L.tables.filter(u => v.get(u.pins['/WE']) === 0).map(u => u.ref);
      if (low.length !== 1 || low[0] !== t.ref) { msgs.push(`${t.ref} @${a}: /WE low on [${low.join(', ')}]`); return; }
      const [ra, rd] = readPins(v); if (ra !== a || rd !== (img[a] & dmask)) { msgs.push(`${t.ref} @${a}: pins read address ${ra}, data ${rd} (meant ${img[a] & dmask})`); return; }
      for (const u of L.tables) P[u.part].write(u, p => v.get(u.pins[p])); writes++; }
    for (const a of addrs) if ((t.mem[a] & dmask) !== (img[a] & dmask)) { msgs.push(`${t.ref} @${a}: memory ${t.mem[a]} vs image ${img[a]}`); break; }
  });
  const line = `${name}${MUT ? ' [' + MUT + ']' : ''}: ${L.tables.length} tables, routing proved on ${proved}, ${writes.toLocaleString()} writes in ${settles.toLocaleString()} settles, ${((Date.now() - t0) / 1000).toFixed(0)} s; ${msgs.length ? 'FAIL: ' + msgs.slice(0, 3).join(' | ') : 'every written entry matches its image'}`;
  console.log(line); results.push({ card: name, mutant: MUT || null, tables: L.tables.length, proved, writes, settles, ok: !msgs.length, msgs: msgs.slice(0, 5) }); totalBad += msgs.length;
}
require('fs').appendFileSync(require('path').join(__dirname, 'RESULTS-load-sim.jsonl'), JSON.stringify({ date: new Date().toISOString(), FULL, SAMPLE, results }) + '\n');
process.exitCode = totalBad ? 1 : 0;
