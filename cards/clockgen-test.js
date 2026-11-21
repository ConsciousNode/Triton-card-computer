// clockgen-test.js: the clock and reset generator against an independent oracle (Kehai Interim, 2026-11-20). MIT.
// Steps half-slots (SCLK high, SCLK low). On each step every flip-flop half whose own clock net rose is clocked with
// the values settled just before that edge (so CLK and SCLK rising together both see pre-edge data).
// Checks: /CEDGE low exactly one slot per CPU cycle (4 slots, 8 when STRETCH); /WSTB low exactly in the slot before it; CLK rises only at the end of a /CEDGE
// slot and is high only during the SCLK-high half right after it (no glitches); RESET asserts at once on POR or LOAD and
// releases on exactly the 2nd CPU edge after both drop; the slot counter locks from all 16 power-up states; every
// mutant in clockgen.MUTANTS is caught. Usage: node clockgen-test.js [all|mutants]
'use strict';
const { Card } = require('./netlist.js'); const { P } = require('./parts.js'); const G = require('./clockgen.js');
function make(mutant, q0 = 0) { const c = G.build(new Card('clockgen'), { mutant }); c.check();
  for (const ch of c.chips) if (ch.part === 'LVC74') ch.q = [0, 0, 0]; c.chips.find(ch => ch.ref === 'U200').q = q0; return c; }
const CLOCK_PINS = { LVC74: ['1CLK', '2CLK'], LVC161: ['CP'] };
// one half-step: set SCLK, find the clock nets that rose, clock exactly those flops with pre-edge values, settle
function step(c, w, sclk) {
  const pre = c.settle(w); const before = new Map(pre);
  w.set('SCLK', sclk); const mid = c.settle(w);
  const rose = n => before.get(n) === 0 && mid.get(n) === 1;
  const g0 = ch => pin => before.get(ch.pins[pin]);
  for (const ch of c.chips) { if (!P[ch.part].reg) continue;
    if (ch.part === 'LVC161') { if (rose(ch.pins.CP)) P.LVC161.clock(ch, g0(ch)); continue; }
    for (const h of [1, 2]) if (rose(ch.pins[`${h}CLK`])) { const proxy = Object.create(ch); proxy.pins = { ...ch.pins, [`${3 - h}CLK`]: 'GND' }; P.LVC74.clock(proxy, g0(ch)); } }
  return c.settle(w);
}
// run n slots; stretchFor(cycleIndex) gives STRETCH for that CPU cycle; reset schedule: { por: [from, to), load: [from, to) } in slots
function run(mutant, { slots = 400, stretchFor = () => 0, por = null, load = null, q0 = 0 } = {}) {
  const c = make(mutant, q0); const w = new Map([['SCLK', 0], ['POR', 0], ['LOAD', 0], ['STRETCH', 0]]);
  const tr = []; let cyc = 0;
  for (let s = 0; s < slots; s++) {
    w.set('POR', por && s >= por[0] && s < por[1] ? 1 : 0); w.set('LOAD', load && s >= load[0] && s < load[1] ? 1 : 0);
    w.set('STRETCH', stretchFor(cyc) ? 1 : 0);
    const hi = step(c, w, 1); const lo = step(c, w, 0);
    const rec = { s, wstbHi: hi.get('/WSTB'), wstbLo: lo.get('/WSTB'), cedgeN: hi.get('/CEDGE'), clkHi: hi.get('CLK'), clkLo: lo.get('CLK'), resetHi: hi.get('RESET'), resetLo: lo.get('RESET'), stretch: w.get('STRETCH'), por: w.get('POR'), load: w.get('LOAD') };
    tr.push(rec); if (rec.cedgeN === 0) cyc++;
  }
  return tr;
}
// the oracle, written from the spec in clockgen.js's header, not from its gates
function judge(tr, { lockBy = 16 } = {}) {
  const bad = [];
  const ce = tr.filter(r => r.s >= lockBy && r.cedgeN === 0).map(r => r.s);
  for (let i = 1; i < ce.length; i++) { const want = tr[ce[i - 1] + 1].stretch ? 8 : 4; /* STRETCH as held during the cycle that starts after that edge */ const got = ce[i] - ce[i - 1];
    if (got !== want) { bad.push(`cycle ending slot ${ce[i]}: ${got} slots, expected ${want}`); break; } }
  for (const r of tr) { if (r.s < lockBy) continue; const prevCedge = tr[r.s - 1] && tr[r.s - 1].cedgeN === 0;
    if (r.clkHi !== (prevCedge ? 1 : 0)) { bad.push(`slot ${r.s}: CLK high-half = ${r.clkHi}, expected ${prevCedge ? 1 : 0}`); break; }
    if (r.clkLo !== 0) { bad.push(`slot ${r.s}: CLK high during SCLK-low half (glitch)`); break; } }
  // /WSTB (2026-11-20): low for exactly the slot before each /CEDGE slot, both halves; high in every other slot
  for (const r of tr) { if (r.s < lockBy || !tr[r.s + 1]) continue; const want = tr[r.s + 1].cedgeN === 0 ? 0 : 1;
    if (r.wstbHi !== want || r.wstbLo !== want) { bad.push(`slot ${r.s}: /WSTB ${r.wstbHi}/${r.wstbLo}, expected ${want}`); break; } }
  // reset: high in any slot where POR or LOAD is high (asserted at once); released at the 2nd CPU edge after both drop
  for (const r of tr) if ((r.por || r.load) && (r.resetHi !== 1 || r.resetLo !== 1)) { bad.push(`slot ${r.s}: reset request but RESET=${r.resetHi}`); break; }
  const lastReq = tr.reduce((m, r) => r.por || r.load ? r.s : m, -1);
  if (lastReq >= 0) { const edges = tr.filter(r => r.s > lastReq && r.clkHi === 1).map(r => r.s);
    const releaseAt = edges[1]; const firstLow = tr.find(r => r.s > lastReq && r.resetHi === 0);
    if (!firstLow || firstLow.s !== releaseAt) bad.push(`RESET released at slot ${firstLow && firstLow.s}, expected the 2nd CPU edge after the request (slot ${releaseAt})`);
    if (firstLow && tr.some(r => r.s > firstLow.s && r.resetHi === 1 && !(r.por || r.load))) bad.push('RESET came back without a request'); }
  return bad;
}
const rnd = (seed => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)(20261120);
const stretchSeq = [...Array(1000)].map(() => rnd() < 0.3 ? 1 : 0);
const cases = [
  ['uniform 4-slot cycles', { slots: 400 }],
  ['all stretched (8 slots)', { slots: 400, stretchFor: () => 1 }],
  ['mixed stretch (30% of cycles, seeded)', { slots: 800, stretchFor: k => stretchSeq[k] }],
  ['power-on reset, then run', { slots: 200, por: [0, 37] }],
  ['copy-engine LOAD holds reset', { slots: 300, por: [0, 10], load: [5, 151] }],
  ['reset button mid-run', { slots: 300, por: [120, 133] }],
  ...[...Array(16).keys()].map(q => [`locks from counter state ${q}`, { slots: 80, q0: q, stretchFor: k => k % 2 }])];
function suite(mutant) { const fails = []; for (const [name, opt] of cases) { const b = judge(run(mutant, opt)); if (b.length) fails.push(`${name}: ${b[0]}`); } return fails; }
const which = process.argv[2] || 'all';
let ok = true;
if (which === 'all' || which === 'base') { const f = suite(null);
  console.log(`clockgen baseline: ${cases.length - f.length}/${cases.length} cases pass`); f.forEach(x => console.log('  FAIL ' + x)); if (f.length) ok = false; }
if (which === 'all' || which === 'mutants') { let killed = 0;
  for (const m of G.MUTANTS) { const f = suite(m); if (f.length) killed++; console.log(`  mutant ${m}: ${f.length ? 'caught — ' + f[0] : 'SURVIVED'}`); }
  console.log(`clockgen mutants: ${killed}/${G.MUTANTS.length} caught`); if (killed !== G.MUTANTS.length) ok = false; }
process.exit(ok ? 0 : 1);
