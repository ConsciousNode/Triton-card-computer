'use strict';
// program-lockstep.js: integration stage 2, the whole machine running real programs beside the microsim (Kehai Interim,
// 2026-11-20). MIT.
//
// The program is assembled once and put in both machines' RAM: the microsim's mem[], and the Memory card's RAM chips in
// the card's declared storage layout (MEMORY-CARD.md; the layout code is copied from cards/memory-card-test.js, marked
// below). That preload is the one declared exception: in the real machine the copy engine or a loader puts it there.
// After that the netlist runs alone. The microsim only checks; nothing it computes is fed to the netlist.
//
// Compared:
//   - every microcycle: the executing micro-address (UPC), the next address on the backplane (UA), the bus, and the
//     MODE/PRIV/IE/PROTEN lines (as lockstep.js does);
//   - every instruction boundary: all 32 register-RAM slots (read from the Registers card's RAM chips), the PC
//     register (Control card), and every memory write since the last boundary, both ways: each microsim write must be
//     in the right RAM chips with the right value, and each RAM-chip write must decode to an address the microsim
//     wrote, holding the microsim's value;
//   - at the end: a full audit of every RAM row against the microsim's memory.
// Power-up: register RAM has no reset, so its contents are undefined in hardware. Both machines start it at zero here
// (the microsim's constructor sets ULIMIT = ramSize; that slot is zeroed to match). Then both run the RESET routine
// (microsim.js, since 2026-11-20): the netlist gets there through its reset vector, the microsim is started there. It
// writes the ISA's reset values of ULIMIT and SP, so the programs need no prologue. (Before the routine existed, every
// program began with a BOOT prologue; that was finding 4 in INTEGRATION-PLAN.md.)
//
// Usage: node program-lockstep.js [directed|random] [programs] [seed]
//   MACHINE_MUTANT=Card:NAME  build the machine with one card mutant (the run must fail)
const path = require('path');
const { compose } = require('./integrate.js'); const { MachineSim } = require('./machine-sim.js');
const { MicroMachine, SLOT } = require('../microsim/microsim.js'); const { trit, rails } = require('../cards/netlist.js');
const { rowsFor } = require('../cards/memory-card.js'); const { ld } = require('../microsim/bare-drivers.js');
const { Timing } = require('./sta.js'); const { TimingSim } = require('./timing-sim.js');
// STA=table|cycle: time every slot's settled paths (sta.js). STA_SCALE=PART:factor slows one part (a positive control).
const STA_SCALE = process.env.STA_SCALE ? Object.fromEntries([process.env.STA_SCALE.split(':').map((x, i) => i ? +x : x)]) : {}; let STA = null;
const { loadHtmlModule } = require(path.join(require('../triton-dir.js'), 'tests/t3-common.js')); const { T } = loadHtmlModule('triton3.html');

const WHICH = process.argv[2] || 'directed', NPROG = +(process.argv[3] || 1); let seed = +(process.argv[4] || 20261120) >>> 0;
const MUT = process.env.MACHINE_MUTANT ? Object.fromEntries([process.env.MACHINE_MUTANT.split(':')]) : {};
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 2 ** 32; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1)), pick = a => a[Math.floor(rnd() * a.length)];

// ---- the Memory card's declared storage layout. Lifted from cards/memory-card-test.js (Kehai Interim, 2026-11-18),
// lines 30 and 42-48, unchanged except that ROWS is passed in.
const toT = (v, n) => { const t = []; let x = v; for (let i = 0; i < n; i++) { let r = ((x % 3) + 3) % 3; if (r === 2) r = -1; t.push(r); x = (x - r) / 3; } return t; };
const sumT = (t, lo, hi) => { let r = 0; for (let i = hi - 1; i >= lo; i--) r = 3 * r + t[i]; return r; };
const loc = x => { const t = toT(x, 27), T = sumT(t, 10, 16); return { row: T >> 5, addr: (T & 31) * 65536 + (sumT(t, 5, 10) + 128) * 256 + sumT(t, 0, 5) + 128 }; };
const unloc = (row, addr) => ((addr & 255) - 128) + 243 * (((addr >> 8) & 255) - 128) + 59049 * ((row << 5) | (addr >> 16));
const enc = (v, n) => { let b = 0; toT(v, n).forEach((x, i) => { const [p, q] = rails(x); b += p * 2 ** (2 * i) + q * 2 ** (2 * i + 1); }); return b; };
const dec = (b, n) => { let x = 0; for (let i = n - 1; i >= 0; i--) { const p = Math.floor(b / 2 ** (2 * i)) & 1, q = Math.floor(b / 2 ** (2 * i + 1)) & 1; if (p && q) return NaN; x = 3 * x + trit(p, q); } return x; };
// ---- end of lift

// ---- programs. No I/O instructions here (stage 3 brings the I/O card's programs); no user mode or traps yet.
const DIRECTED = `
${ld('R1', 581130733)}
  ADDI R3, R1, #1
  SUBI R4, R3, #1
  NEG R5, R1
  SUBI R5, R5, #1
  LI R0, #0
${ld('R6', 3812798742493)}
  ADDI R6, R6, #1
  ADC R3, R1, R0
  ADD R3, R1, R1
  SUB R4, R3, R1
  MUL R5, R4, R1
  LI R1, #1234
  LI R2, #-567
  ADD R3, R1, R2
  SUB R4, R1, R2
  MUL R5, R1, R2
  LUI R6, #77
  ADDI R6, R6, #-9841
  LI R8, #5000
  ST R3, R8, #0
  ST R4, R8, #1
  SW R5, R8, #3
  LT R0, R8, #1
  LW R1, R8, #3
  PUSH R3
  PUSH R4
  POP R2
  CMP R2, R4
  JZ same
  HALT
same:
  LI R0, #5
loop:
  SUBI R0, R0, #1
  CMPI R0, #0
  JNZ loop
  CALL sub
  TMIN R7, R1, R2
  TXOR R7, R7, R5
  HALT
sub:
  ADDI R1, R1, #1
  RET
`;
function genRandom() {
  const n = ri(12, 40), lines = [];
  const R = () => 'R' + ri(0, 6), imm = () => pick([0, 1, -1, 9841, -9841, ri(-9841, 9841), ri(-50, 50)]);
  // jump targets are labels L0..Ln (line i is label Li, Ln the HALT), so a line can sit in front
  for (let i = 0; i < n; i++) { const k = rnd(), fwd = () => 'L' + ri(i + 1, n);
    if (k < 0.30) lines.push(`${pick(['ADD', 'ADC', 'SUB', 'SBC', 'TMIN', 'TMAX', 'TCON', 'TANY', 'TXOR', 'MUL', 'DIV', 'MOD'])} ${R()}, ${R()}, ${R()}`);
    else if (k < 0.42) lines.push(`${pick(['ADDI', 'SUBI', 'MULI', 'TUNARY'])} ${R()}, ${R()}, #${imm()}`);
    else if (k < 0.50) lines.push(`${pick(['LI', 'LUI'])} ${R()}, #${imm()}`);
    else if (k < 0.55) lines.push(`${pick(['MOV', 'NEG'])} ${R()}, ${R()}`);
    else if (k < 0.60) lines.push(rnd() < 0.5 ? `CMP ${R()}, ${R()}` : `CMPI ${R()}, #${imm()}`);
    else if (k < 0.62) lines.push(`${pick(['SHLI', 'SHRI'])} ${R()}, ${R()}, #${ri(-30, 30)}`);
    else if (k < 0.76) lines.push(`${pick(['LT', 'ST', 'LW', 'SW'])} ${R()}, R8, #${ri(-300, 300)}`);
    else if (k < 0.84) lines.push(rnd() < 0.5 ? `PUSH ${R()}` : `POP ${R()}`);
    else if (k < 0.94) lines.push(`${pick(['JMP', 'JN', 'JZ', 'JP', 'JNZ', 'JNP', 'JNN'])} ${fwd()}`);
    else lines.push(`CALL L${i + 1}`); }
  lines.push('HALT'); return '  LI R8, #5000\n' + lines.map((l, i) => `L${i}: ${l}`).join('\n');
}

// ---- one program on a fresh machine
const m = compose({ mutants: MUT }); const chip = new Map(m.chips.map(c => [c.ref, c]));
if (process.env.STA) STA = new Timing(m, { scale: STA_SCALE, mode: process.env.STA });   // STA=table or STA=cycle
let TS = null; if (process.env.TSIM) TS = new TimingSim(m, { scale: STA_SCALE });          // TSIM=1: the delay simulation (timing-sim.js)
const RAMSIZE = 4782969;
const ROWS = []; for (let r = 0; r < rowsFor(RAMSIZE); r++) ROWS.push([chip.get(`Memory.U${240 + 2 * r}`), chip.get(`Memory.U${241 + 2 * r}`)]);
const ROWREF = new Map(); ROWS.forEach(([a, b], r) => { ROWREF.set(a.ref, r); ROWREF.set(b.ref, r); });
const ramGet = x => { const { row, addr } = loc(x); if (!ROWS[row]) return NaN; return dec(ROWS[row][0].mem[addr] + ROWS[row][1].mem[addr] * 65536, 9); };
const ramPut = (x, v) => { const { row, addr } = loc(x); const b = enc(v, 9); ROWS[row][0].mem[addr] = b % 65536; ROWS[row][1].mem[addr] = Math.floor(b / 65536); };
const RFCHIPS = [10, 11, 12, 13, 14, 15, 16].map(i => chip.get(`Registers.U${i}`));
const slotVal = s => { const bits = []; for (const c of RFCHIPS) for (let i = 0; i < 8; i++) bits.push((c.mem[s] >> i) & 1); let x = 0; for (let k = 26; k >= 0; k--) x = 3 * x + trit(bits[2 * k], bits[2 * k + 1]); return x; };
const qOf = (ref, h, i) => ((chip.get(ref).q || [])[h * 9 + i] | 0);
const pcOf = () => { const b = []; for (const r of ['Control.U20', 'Control.U21', 'Control.U22']) for (const h of [1, 2]) for (let i = 0; i < 9; i++) b.push(qOf(r, h, i));
  let x = 0; for (let k = 26; k >= 0; k--) x = 3 * x + trit(b[2 * k], b[2 * k + 1]); return x; };
const ABORTED = Symbol('aborted');
const word = (v, pfx) => { let x = 0; for (let i = 9; i >= 0; i--) x = 2 * x + (v.get(`${pfx}${i}`) | 0); return x; };
const busOf = v => { let x = 0; for (let k = 26; k >= 0; k--) { const p = v.get(`D${k}+`), q = v.get(`D${k}-`); if (p && q) return NaN; x = 3 * x + trit(p, q); } return x; };

function runOne(src, label) {
  const code = T.assemble(src, { mode: 'T3' }).trytes;
  // fresh state on the same composed netlist: every register, RAM and status bit back to its power-up value
  for (const c of m.chips) { if (c.q) c.q = c.part === 'LVC74' ? [0, 0, 0] : []; }
  for (const [a, b] of ROWS) { a.mem.fill(0); b.mem.fill(0); } for (const c of RFCHIPS) c.mem.fill(0);
  const mm = new MicroMachine(RAMSIZE); mm.rf[SLOT.ULIMIT] = 0; mm.upc = mm.cs.addr.RESET;   // power-on: the RESET routine first
  code.forEach((v, i) => { mm.mem[i] = v; ramPut(i, v); });
  const mmWrites = new Set(); const mw = mm.memWrite.bind(mm); mm.memWrite = (a, v) => { mmWrites.add(mm.phys(a)); mw(a, v); };
  const s = new MachineSim(m); const POR = 12;
  for (let k = 0; k < POR; k++) s.microcycle(); s.set('POR', 0);
  let cyc = 0, instr = 0, fail = null, pendingPc = null, prevLo = null; const t0 = Date.now(); const trace = [];
  const bad = msg => { if (!fail) fail = { cyc, instr, msg }; };
  while (!fail && !mm.halted && cyc < 20000) {
    // one microcycle, slot by slot (as MachineSim.microcycle does), so the timing pass sees every slot
    let v = null; for (let j = 0; ; j++) { const { hi, lo } = s.slot(); const last = hi.get('/CEDGE') === 0;
      if (STA && lo.get('RESET') !== 1) STA.analyze(lo, mm.upc, { j, last });
      if (TS && prevLo && lo.get('RESET') !== 1) TS.analyze(prevLo, lo, mm.upc, { j, last }); prevLo = lo;
      if (last) { v = lo; break; } if (j > 16) throw new Error('no CPU edge'); }
    if (v.get('RESET') === 1) continue;
    if (pendingPc !== null) { const g = pcOf(); if (g !== pendingPc) bad(`PC ${g} vs ${pendingPc}`); pendingPc = null; }
    const modeWant = { MODE: mm.mode, PRIV: mm.priv, IE: mm.ie, PROTEN: mm.protEn };
    const want = mm.upc, got = word(v, 'Control:UPC'), mu = mm.cs.store[mm.upc]; mm.lastBus = ABORTED; const r = mm.cycle(); cyc++;
    const aborted = mm.lastBus === ABORTED; if (aborted) mm.lastBus = undefined;
    // an instruction fetch puts the tryte on the bus (the Memory card drives it, the Control card's IR loads from it);
    // the microsim loads IR straight from memory, so the expected bus value is the tryte it fetched
    // a flag word with BUS = NONE: the ALU card drives its result on the idle bus (alu-card.js, /BUSOE), so the flag
    // tables see its sign; nobody loads it. The expected value is the microsim's ALU output.
    const flagIdle = (!mu.BUS || mu.BUS === 'NONE') && mu.FLAGS && mu.FLAGS !== 'KEEP' && !aborted;
    const lane = mu.MDR_LANE === undefined ? 0 : +mu.MDR_LANE, irFetch = mu.MEM === 'RD' && mu.LD_IR && !aborted;
    const wantNext = mm.upc, gotNext = word(v, 'UA'), wb = irFetch ? mm.IR[lane] : flagIdle ? mm.lastAlu : mm.lastBus === undefined ? 0 : mm.lastBus, gb = busOf(v);
    trace.push(`${cyc}: UPC ${got}/${want} UA ${gotNext}/${wantNext} bus ${gb}/${mm.lastBus === undefined ? '-' : mm.lastBus}`); if (trace.length > 12) trace.shift();
    if (got !== want) bad(`UPC ${got} vs upc ${want}`); else if (gotNext !== wantNext && !mm.halted) bad(`UA ${gotNext} vs next ${wantNext}`);
    else if (gb !== wb) bad(`bus ${gb} vs ${wb}`);
    for (const [k, x] of Object.entries(modeWant)) if (v.get(k) !== x) bad(`${k} ${v.get(k)} vs ${x}`);
    if (r === 'END') { instr++;
      for (let sl = 0; sl < 32; sl++) { const g = slotVal(sl); if (g !== mm.rf[sl]) { bad(`register slot ${sl}: ${g} vs ${mm.rf[sl]}`); break; } }
      for (const x of mmWrites) if (ramGet(x) !== mm.mem[x]) { bad(`RAM ${x}: chips ${ramGet(x)} vs ${mm.mem[x]}`); break; }
      for (const [ref, a] of s.writes) { if (!ROWREF.has(ref)) continue; const x = unloc(ROWREF.get(ref), a);
        if (!mmWrites.has(x)) { bad(`chip ${ref} wrote address ${x}, which the microsim did not write`); break; }
        if (ramGet(x) !== mm.mem[x]) { bad(`RAM ${x}: chips ${ramGet(x)} vs ${mm.mem[x]}`); break; } }
      mmWrites.clear(); s.writes.length = 0; pendingPc = mm.pc; }
  }
  if (!fail) for (const [a, b] of ROWS) for (let i = 0; i < a.mem.length; i++) if (a.mem[i] || b.mem[i]) {
    const x = unloc(ROWREF.get(a.ref), i); if (dec(a.mem[i] + b.mem[i] * 65536, 9) !== mm.mem[x]) { fail = { cyc, instr, msg: `final audit: RAM ${x}` }; break; } }
  if (!fail && !mm.halted) fail = { cyc, instr, msg: 'did not halt in 20000 microcycles' };
  if (fail) { console.log(trace.join('\n'));
    // who drives the bus right now (diagnostics only): every chip whose output pin on a D rail is high
    const who = new Set(), v = s.v; const { P } = require('../cards/parts.js');
    for (const c of m.chips) P[c.part].eval(c, pin => v.get(c.pins[pin]) ?? 0, (pin, x) => { const n = c.pins[pin]; if (n && /^D\d+[+-]$/.test(n) && x === 1) who.add(`${c.ref}.${pin}->${n}`); }, pin => v.get(c.pins[pin]) ?? 'Z');
    console.log('bus drivers high:', [...who].slice(0, 12).join(' ') || 'none'); }
  console.log(`${label}: ${instr} instructions, ${cyc} microcycles, ${(Date.now() - t0) / 1000 | 0} s: ${fail ? `FAIL at microcycle ${fail.cyc} (instruction ${fail.instr}): ${fail.msg}` : 'match'}`);
  return !fail;
}

if (Object.keys(MUT).length) console.log('MUTANT', JSON.stringify(MUT));
let ok = 0, n = 0;
if (WHICH === 'directed') { n = 1; ok += runOne(DIRECTED, 'directed'); }
else if (WHICH === 'file') { n = 1; ok += runOne(require('fs').readFileSync(process.argv[3], 'utf8'), process.argv[3]); }
else for (let p = 0; p < NPROG; p++) { n++; const src = genRandom(); if (runOne(src, `random ${p}`)) ok++; else { console.log(src); break; } }
console.log(`program-lockstep: ${ok}/${n} programs match`);
if (TS) { const all = TS.report(), out = [];
  out.push(`timing simulation: ${TS.cycles} microcycles, ${TS.slots} slots, ${all.length} endpoints that changed; scale ${JSON.stringify(TS.scale)}`);
  out.push(`self-test: ${TS.mismatch} net values differ from machine-sim's settled values, in ${TS.mismatchSlots || 0} slots ${TS.mismatchEx.slice(0, 6).join('; ')}`);
  out.push(`clock lag (latest rise after SCLK, per clock net): ${JSON.stringify(Object.fromEntries(Object.entries(TS.lag).map(([k, x]) => [k, +x.toFixed(2)])))}`);
  const groups = {}; for (const w of all) (groups[w.capture] = groups[w.capture] || []).push(w);
  for (const [g, ws] of Object.entries(groups)) { const neg = ws.filter(w => w.slack < 0);
    out.push(`\n## captured on ${g}: ${ws.length} endpoints, ${neg.length} with negative slack; worst ${ws[0].slack.toFixed(1)} ns`);
    const seen = new Set(); let k = 0; for (const w of ws) { const sig = w.path.slice(0, -1).join(' '); if (seen.has(sig)) continue; seen.add(sig); if (k++ >= 8) break;
      out.push(`  ${w.k}: arrival ${w.arr.toFixed(1)} required ${w.req.toFixed(1)} slack ${w.slack.toFixed(1)} (µword ${w.upc}, slot ${w.slot})\n     ${w.path.join(' ')}`); } }
  const wr = TS.writeReport(), wneg = wr.filter(w => w.slack < 0);
  out.push(`\n## SRAM writes: ${TS.writes} write windows ended, ${wr.length} chip pin groups checked, ${wneg.length} with negative slack; worst ${wr.length ? wr[0].slack.toFixed(1) : '-'} ns`);
  for (const w of wr.slice(0, 10)) out.push(`  ${w.k}: last change ${w.arr.toFixed(1)}, needed by ${w.req.toFixed(1)} (window ${w.start.toFixed(1)}..${w.end.toFixed(1)}) slack ${w.slack.toFixed(1)} (µword ${w.upc})\n     ${w.path.join(' ')}`);
  out.push(`\n## write-enable races (windows under 1 ns): ${[...TS.glitch.values()].reduce((a, g) => a + g.n, 0)} on ${TS.glitch.size} chips`);
  for (const g of [...TS.glitch.values()].slice(0, 8)) out.push(`  ${g.k}: ${g.n}x, e.g. ${g.at[0]}`);
  console.log(out.join('\n'));
  if (process.env.TSIM_OUT) require('fs').writeFileSync(process.env.TSIM_OUT, JSON.stringify(all)); }
if (STA) { const { all, groups } = STA.report(); const out = [];
  out.push(`timing (${STA.mode} mode): ${STA.cycles} microcycles, ${STA.slots} slots analysed, ${all.length} endpoints reached, scale ${JSON.stringify(STA.scale)}`);
  for (const [g, ws] of Object.entries(groups)) { const neg = ws.filter(w => w.slack < 0);
    out.push(`\n## ${g}: ${ws.length} endpoints, ${neg.length} with negative slack; worst ${ws[0].slack.toFixed(1)} ns`);
    for (const w of ws.slice(0, 8)) out.push(`  ${w.k}: arrival ${w.arr.toFixed(1)} required ${w.req.toFixed(1)} slack ${w.slack.toFixed(1)} (µword ${w.upc}, slot ${w.slot})\n     ${w.path.join(' ')}`); }
  console.log(out.join('\n'));
  if (process.env.STA_OUT) require('fs').writeFileSync(process.env.STA_OUT, JSON.stringify(all.map(({ path, ...w }) => ({ ...w, path })), null, 0)); }
process.exitCode = ok === n ? 0 : 1;
