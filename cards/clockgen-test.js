// clockgen-test.js: the clock and reset generator against an independent oracle (Kehai Interim, 2026-11-20). MIT.
// Steps half-slots (SCLK high, SCLK low). On each step every flip-flop half whose own clock net rose is clocked with
// the values settled just before that edge (so CLK and SCLK rising together both see pre-edge data).
// Checks: HALT stops CLK until a reset (2026-11-21); /CEDGE low exactly one slot per CPU cycle (4 slots, 8 when STRETCH); /WSTB low exactly in the slot before it; CLK rises only at the end of a /CEDGE
// slot and is high only during the SCLK-high half right after it (no glitches); RESET asserts at once on POR or LOAD and
// releases on exactly the 2nd CPU edge after both drop; the slot counter locks from all 16 power-up states; every
// mutant in clockgen.MUTANTS is caught. Usage: node clockgen-test.js [all|mutants]
'use strict';
const { Card } = require('./netlist.js'); const { P } = require('./parts.js'); const G = require('./clockgen.js');
function make(mutant, q0 = 0) { const c = G.build(new Card('clockgen'), { mutant }); c.input('HALTED', 'CW_/ATF'); c.check();
  for (const ch of c.chips) if (ch.part === 'LVC74') ch.q = [0, 0, 0]; else if (ch.part === 'LVC574') ch.q = [0, 1, 1, 1, 1, 1, 1, 1, 1]; /* panel synchronizer: powers up 'run, released' */ c.chips.find(ch => ch.ref === 'U200').q = q0; return c; }
const CLOCK_PINS = { LVC74: ['1CLK', '2CLK'], LVC161: ['CP'] };
// one half-step: set SCLK, find the clock nets that rose, clock exactly those flops with pre-edge values, settle
function step(c, w, sclk) {
  const pre = c.settle(w); const before = new Map(pre);
  w.set('SCLK', sclk); const mid = c.settle(w);
  const rose = n => before.get(n) === 0 && mid.get(n) === 1;
  const g0 = ch => pin => before.get(ch.pins[pin]);
  for (const ch of c.chips) { if (!P[ch.part].reg) continue;
    if (ch.part === 'LVC161') { if (rose(ch.pins.CP)) P.LVC161.clock(ch, g0(ch)); continue; }
    if (ch.part === 'LVC574') { if (rose(ch.pins.CLK)) P.LVC574.clock(ch, g0(ch)); continue; }   // the KERK panel's synchronizer (2026-11-22)
    for (const h of [1, 2]) if (rose(ch.pins[`${h}CLK`])) { const proxy = Object.create(ch); proxy.pins = { ...ch.pins, [`${3 - h}CLK`]: 'GND' }; P.LVC74.clock(proxy, g0(ch)); } }
  return c.settle(w);
}
// run n slots; stretchFor(cycleIndex) gives STRETCH for that CPU cycle; reset schedule: { por: [from, to), load: [from, to) } in slots
function run(mutant, { slots = 400, stretchFor = () => 0, por = null, load = null, q0 = 0, haltCyc = -1 } = {}) {
  const c = make(mutant, q0); const w = new Map([['SCLK', 0], ['POR', 0], ['LOAD', 0], ['STRETCH', 0], ['HALTED', 0], ['FP_RUN', 1], ['FP_STEP', 1], ['FP_STEPMODE', 1], ['CW_/ATF', 1]]);
  const tr = []; let cyc = 0;
  for (let s = 0; s < slots; s++) {
    w.set('POR', por && s >= por[0] && s < por[1] ? 1 : 0); w.set('LOAD', load && s >= load[0] && s < load[1] ? 1 : 0);
    w.set('STRETCH', stretchFor(cyc) ? 1 : 0);
    // HALTED: through one whole CPU cycle, changing just after the edge that starts it (U29 decodes the pipeline
    // register, which loads the HALT word at that edge), so it is set before the edge that ends it, never before the first
    const hi = step(c, w, 1); w.set('HALTED', cyc === haltCyc ? 1 : 0); const lo = step(c, w, 0);
    const rec = { s, wstbHi: hi.get('/WSTB'), wstbLo: lo.get('/WSTB'), cedgeN: hi.get('/CEDGE'), clkHi: hi.get('CLK'), clkLo: lo.get('CLK'), resetHi: hi.get('RESET'), resetLo: lo.get('RESET'), stretch: w.get('STRETCH'), por: w.get('POR'), load: w.get('LOAD'), halted: w.get('HALTED') };
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
// THE HALT LATCH (2026-11-21): HALTED high through one CPU cycle; at the edge that ends it the latch sets, and CLK must
// not rise again (while SCLK and /CEDGE keep going) until a reset; after the reset CLK runs again
function judgeHalt(tr) { const bad = [];
  const hs = tr.filter(r => r.halted).map(r => r.s); if (!hs.length) return ['no HALTED cycle in the run'];
  const endEdge = tr.find(r => r.s > hs[hs.length - 1] && r.clkHi === 1);   // the CPU edge that ends the HALT word
  if (!endEdge) return ['no CPU edge after HALTED'];
  const por0 = tr.find(r => r.s > endEdge.s && r.por); if (!por0) return ['no reset after the halt'];
  const after = tr.filter(r => r.s > endEdge.s && r.s < por0.s);
  if (after.some(r => r.clkHi === 1 || r.clkLo === 1)) bad.push(`CLK rose at slot ${after.find(r => r.clkHi === 1 || r.clkLo === 1).s} while halted`);
  if (!after.some(r => r.cedgeN === 0)) bad.push('/CEDGE stopped too (only CLK should)');
  if (!tr.some(r => r.s > por0.s && !r.por && r.clkHi === 1)) bad.push('CLK did not resume after the reset');
  return bad; }
cases.push(['HALT stops CLK until a reset', { slots: 300, haltCyc: 10, por: [180, 190] }, judgeHalt]);
// THE KERK PANEL (2026-11-22). Its own loop: the harness plays the microcode as instructions of known lengths (CW_/ATF
// low in each instruction's first word, FETCH; it changes only at CPU edges) and drives the debounced panel lines.
// Judged by behaviour, not by restating the gates:
//   - after STOP in instruction mode the CPU parks on a FETCH word and makes no more edges;
//   - each STEP press in instruction mode runs exactly one whole instruction (from FETCH to the next FETCH);
//   - each STEP press in microcycle mode makes exactly one CPU edge;
//   - back to instruction mode mid-instruction, one press finishes that instruction;
//   - RUN resumes the clock; every CPU edge has its /WSTB in the slot before, and no /WSTB comes without an edge;
//   - powered up stopped in microcycle mode, the machine still comes out of reset (then waits).
function panelRun(mutant, script, { slots, por = [0, 20], lens = [3, 5, 2, 4, 6, 3, 7, 2, 4, 5, 3, 3, 6, 2, 4] }) {
  const c = make(mutant); const w = new Map([['SCLK', 0], ['POR', 0], ['LOAD', 0], ['STRETCH', 0], ['HALTED', 0], ['FP_RUN', 1], ['FP_STEP', 1], ['FP_STEPMODE', 1], ['CW_/ATF', 1]]);
  let ins = 0, pos = 0, inReset = true; const ev = []; let pendingW = 0;
  for (let s = 0; s < slots; s++) {
    w.set('POR', s >= por[0] && s < por[1] ? 1 : 0); script(s, w);
    w.set('CW_/ATF', inReset ? 1 : pos === 0 ? 0 : 1);
    const hi = step(c, w, 1), lo = step(c, w, 0);
    const reset = lo.get('RESET') === 1;
    if (hi.get('/WSTB') === 0 || lo.get('/WSTB') === 0) pendingW++;
    if (hi.get('CLK') === 1) { ev.push({ s, ins, pos, reset, w: pendingW }); pendingW = 0;
      if (!inReset) { if (++pos >= lens[ins % lens.length]) { pos = 0; ins++; } } }
    if (inReset && !reset) { inReset = false; ins = 0; pos = 0; }
    ev.at = { s, ins, pos, reset }; }
  return { ev, end: { ins, pos, reset: inReset } }; }
function judgePanel(mutant) { const bad = [];
  const edgesIn = (r, a, b) => r.ev.filter(e => e.s >= a && e.s < b);
  // A: run, stop (instruction mode), 3 steps, micro mode 4 steps, back to instruction mode 1 step, run again
  const presses = [400, 500, 600, 720, 800, 880, 1100];   // 3 instruction steps, 3 microcycle steps (they end mid-instruction), 1 instruction step
  const scriptA = (s, w) => { w.set('FP_RUN', s < 200 || s >= 1300 ? 1 : 0); w.set('FP_STEPMODE', s >= 700 && s < 1050 ? 0 : 1);
    w.set('FP_STEP', presses.some(p => s >= p && s < p + 20) ? 0 : 1); };
  const A = panelRun(mutant, scriptA, { slots: 1500 });
  const after = s => A.ev.filter(e => e.s >= s);
  if (A.ev.some(e => !e.reset && e.w !== 1)) { const e = A.ev.find(e => !e.reset && e.w !== 1); bad.push(`CPU edge at slot ${e.s} had ${e.w} write strobes since the last edge (want exactly 1)`); }
  if (edgesIn(A, 0, 200).length < 30) bad.push('did not run before STOP');
  const parked = A.ev.filter(e => e.s >= 200 && e.s < 400); const last = parked[parked.length - 1];
  if (edgesIn(A, 300, 400).length) bad.push(`still making CPU edges 100 slots after STOP (slot ${edgesIn(A, 300, 400)[0].s})`);
  else if (!last || !(last.pos === (A.ev.indexOf(last) >= 0 ? last.pos : -1))) {}
  const stateAt = s => { const before = A.ev.filter(e => e.s < s); if (!before.length) return null; const e = before[before.length - 1];
    let ins = e.ins, pos = e.pos; return { ins, pos }; };
  // the instruction counter after each edge: recompute from the edge list (ins/pos recorded BEFORE the edge's advance)
  const lens = [3, 5, 2, 4, 6, 3, 7, 2, 4, 5, 3, 3, 6, 2, 4]; const adv = ({ ins, pos }) => (pos + 1 >= lens[ins % lens.length] ? { ins: ins + 1, pos: 0 } : { ins, pos: pos + 1 });
  const at = s => { const b = A.ev.filter(e => e.s < s && !e.reset); return b.length ? adv(b[b.length - 1]) : null; };
  if (process.env.PANEL_DEBUG && !mutant) console.log('panel states', [400, 500, 600, 700, 720, 800, 880, 1050, 1100, 1300].map(x => `${x}:${JSON.stringify(at(x))}`).join(' '));
  const p0 = at(400); if (!p0 || p0.pos !== 0) bad.push(`STOP in instruction mode parked at word ${p0 && p0.pos} of an instruction, not on its FETCH`);
  const win = [[400, 500], [500, 600], [600, 700]];
  for (const [a, b] of win) { const s0 = at(a), s1 = at(b); if (!s0 || !s1 || s1.ins !== s0.ins + 1 || s1.pos !== 0) bad.push(`instruction STEP at ${a}: went from ${JSON.stringify(s0)} to ${JSON.stringify(s1)} (want exactly one instruction)`); }
  for (const [a, b] of [[720, 800], [800, 880], [880, 1050]]) { const n = edgesIn(A, a, b).length; if (n !== 1) bad.push(`microcycle STEP at ${a}: ${n} CPU edges (want 1)`); }
  // back to instruction mode while stopped mid-instruction (slot 1050): the machine finishes that instruction by itself
  // and parks on the next FETCH (in instruction mode a stopped machine always rests on a boundary); the press at 1100
  // then runs exactly one more instruction
  { const m0 = at(1050), s0 = at(1100), s1 = at(1300);
    if (!m0 || m0.pos === 0) bad.push('the micro steps should have left the machine mid-instruction');
    else if (!s0 || s0.ins !== m0.ins + 1 || s0.pos !== 0) bad.push(`instruction mode mid-instruction: ${JSON.stringify(m0)} -> ${JSON.stringify(s0)} (want: finish it and park on the next FETCH)`);
    if (s0 && (!s1 || s1.ins !== s0.ins + 1 || s1.pos !== 0)) bad.push(`instruction STEP mid-instruction: ${JSON.stringify(s0)} -> ${JSON.stringify(s1)} (want: finish this instruction, park on the next FETCH)`); }
  if (edgesIn(A, 1320, 1500).length < 30) bad.push('RUN did not resume the clock');
  // B: powered up stopped in microcycle mode: reset still releases, then no edges
  const B = panelRun(mutant, (s, w) => { w.set('FP_RUN', 0); w.set('FP_STEPMODE', 0); w.set('FP_STEP', 1); }, { slots: 300 });
  if (B.end.reset) bad.push('powered up stopped in microcycle mode: RESET never released');
  else if (B.ev.filter(e => !e.reset && e.s > 120).length) bad.push('powered up stopped in microcycle mode: kept running after reset');
  return bad; }
function suite(mutant) { const fails = []; for (const [name, opt, j] of cases) { const b = (j || judge)(run(mutant, opt)); if (b.length) fails.push(`${name}: ${b[0]}`); }
  const p = judgePanel(mutant); if (p.length) fails.push(`KERK panel: ${p[0]}`); return fails; }
const which = process.argv[2] || 'all';
let ok = true;
if (which === 'all' || which === 'base') { const f = suite(null);
  console.log(`clockgen baseline: ${cases.length + 1 - f.length}/${cases.length + 1} cases pass (the last is the KERK panel)`); f.forEach(x => console.log('  FAIL ' + x)); if (f.length) ok = false; }
if (which === 'all' || which === 'mutants') { let killed = 0;
  for (const m of G.MUTANTS) { const f = suite(m); if (f.length) killed++; console.log(`  mutant ${m}: ${f.length ? 'caught — ' + f[0] : 'SURVIVED'}`); }
  console.log(`clockgen mutants: ${killed}/${G.MUTANTS.length} caught`); if (killed !== G.MUTANTS.length) ok = false; }
process.exit(ok ? 0 : 1);
