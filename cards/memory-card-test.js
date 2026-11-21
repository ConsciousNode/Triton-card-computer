// memory-card-test.js: the Memory card (stages 1 + 2) beside the microsim, every microcycle (Kehai Interim, 2026-11-18).
// Inputs from elsewhere come from the microsim: MODE / PRIV / PROTEN (Control), RSLOT / SPRNR (Control), and the bus
// when this card isn't driving. Since stage 2 the card holds memory itself: RAM rows, VRAM-C and VRAM-S.
// Compared every cycle:
//   ABORT, FK, BADADDR, what the card drives onto the bus (MAR, MDR, MDR0, FADDR, the fetched tryte), and after the
//   edge MAR, MDR, FADDR and the UBASE/ULIMIT shadows (stage 1). Reads now come from the card's own RAM chips.
//   Every write the card makes, in both directions: each microsim write must land in exactly the right chips at the
//   right place with the right value, and any chip write the microsim didn't make is a mismatch.
//   VBUSY on J2, and a scan-out probe (a pixel read through J2 SA -> SO) whenever VRAM-S is free.
//   The Video card's port-4 pixel writes go through J2 (SA, SI, /SWR) in the netlist.
// After each machine: a full audit of the RAM rows and both VRAM copies against the microsim's memory.
// Declared exceptions:
//   - at each machine start, the card's registers are preset to the machine's starting values, and its RAM / VRAM to
//     the machine's memory (the storage layout used for the preset is the card's declared layout, MEMORY-CARD.md);
//   - off-card writers that aren't drawn yet (the legacy I/O model's disk DMA, the Video card's port-5 fill engine)
//     change the microsim's memory directly; the harness finds those changes on I/O cycles and copies them into the
//     card's chips, counted under "sync" in the coverage.
'use strict';
// /WSTB (2026-11-20): the backplane write strobe. This harness writes at the edge with settled values, so it holds the
// strobe active (low); its timing is checked on the whole machine (integration/timing-sim.js).
const fs = require('fs'), path = require('path');
const { build, cardWord, FB_BASE, FB_SIZE, rowsFor } = require('./memory-card.js');
const { rails, trit } = require('./netlist.js');
const { P } = require('./parts.js');
const { decodeWord } = require('../microsim/roms.js');
const { MicroMachine, WORD_BITS, SLOT } = require('../microsim/microsim.js');
const ROMS = path.join(__dirname, '../roms');
const chips = Array.from({ length: Math.ceil(WORD_BITS / 8) }, (_, k) => fs.readFileSync(path.join(ROMS, `cs${k}.bin`)));
const cs = [0, 1, 2].map(() => Buffer.alloc(1024));
for (let w = 0; w < 1024; w++) { let b = 0n; for (let k = 0; k < chips.length; k++) b |= BigInt(chips[k][w]) << BigInt(8 * k); let mu; try { mu = decodeWord(b); } catch { continue; }
  const cw = cardWord(mu); for (let j = 0; j < 3; j++) cs[j][w] = (cw >> (8 * j)) & 255; }
const MUT = process.env.MEM_MUTANT; let card = null, cardRam = null;
const toT = (v, n) => { const t = []; let x = v; for (let i = 0; i < n; i++) { let r = ((x % 3) + 3) % 3; if (r === 2) r = -1; t.push(r); x = (x - r) / 3; } return t; };
const chip = r => card.chips.find(c => c.ref === r);
const regWord = refs => { const b = []; for (const r of refs) for (const h of [1, 2]) for (let i = 0; i < 9; i++) b.push(((chip(r).q || [])[h * 9 + i]) | 0); let x = 0; for (let k = b.length / 2 - 1; k >= 0; k--) x = 3 * x + trit(b[2 * k], b[2 * k + 1]); return x; };
const setWord = (refs, v) => { const t = toT(v, 9 * refs.length); refs.forEach((r, j) => { const c = chip(r); c.q = []; for (let i = 0; i < 18; i++) { const k = 9 * j + (i >> 1), [p, q] = rails(t[k]); c.q[(i < 9 ? 1 : 2) * 9 + (i % 9)] = (i & 1) ? q : p; } }); };
const PIPE = ['U4', 'U5'];
// ULIMIT - 2 as the UL2 shadow holds it: wrapped into 27 trits, with the underflow flag when it leaves the range
const MAXW = (3 ** 27 - 1) / 2; const ulm = u => { const m = u - 2; return m < -MAXW ? [m + 3 ** 27, 1] : [m, 0]; };
// ---- the card's declared storage layout (MEMORY-CARD.md, stage 2), computed here with plain arithmetic ----
const sumT = (t, lo, hi) => { let r = 0; for (let i = hi - 1; i >= lo; i--) r = 3 * r + t[i]; return r; };
const loc = x => { const t = toT(x, 27), T = sumT(t, 10, 16); return { row: T >> 5, addr: (T & 31) * 65536 + (sumT(t, 5, 10) + 128) * 256 + sumT(t, 0, 5) + 128 }; };
const fbLoc = p => { const t = toT(FB_BASE + p, 27); return (sumT(t, 10, 16) - 254) * 65536 + (sumT(t, 5, 10) + 128) * 256 + sumT(t, 0, 5) + 128; };
const unloc = (row, addr) => ((addr & 255) - 128) + 243 * (((addr >> 8) & 255) - 128) + 59049 * ((row << 5) | (addr >> 16));
const unfb = addr => ((addr & 255) - 128) + 243 * (((addr >> 8) & 255) - 128) + 59049 * ((addr >> 16) + 254) - FB_BASE;
const enc = (v, n) => { let b = 0; toT(v, n).forEach((x, i) => { const [p, q] = rails(x); b += p * 2 ** (2 * i) + q * 2 ** (2 * i + 1); }); return b; };
const dec = (b, n) => { let x = 0; for (let i = n - 1; i >= 0; i--) { const p = Math.floor(b / 2 ** (2 * i)) & 1, q = Math.floor(b / 2 ** (2 * i + 1)) & 1; if (p && q) return NaN; x = 3 * x + trit(p, q); } return x; };
const phys = (mode, a) => { if (mode === 0) { const r = a % 19683; return r < 0 ? r + 19683 : r; } return a; };
let ROWS = [], VC = null, VS = null, MEMCHIPS = [];
const ramGet = x => { const { row, addr } = loc(x); if (!ROWS[row]) return NaN; return dec(ROWS[row][0].mem[addr] + ROWS[row][1].mem[addr] * 65536, 9); };
const ramPut = (x, v) => { const { row, addr } = loc(x); const b = enc(v, 9); ROWS[row][0].mem[addr] = b % 65536; ROWS[row][1].mem[addr] = Math.floor(b / 65536); };
const vPut = (p, v) => { const a = fbLoc(p), b = enc(v, 8); VC.mem[a] = b; VS.mem[a] = b; };
let shadow = null, vshadow = null, auditMsgs = [];
function audit(m) {   // full compare of the card's memory with the machine's, both directions
  const out = []; if (!m) return out;
  for (let x = 0; x < m.ramSize && out.length < 3; x++) if (m.mem[x] !== 0 && ramGet(x) !== m.mem[x]) out.push(`RAM ${x}: card ${ramGet(x)} vs ${m.mem[x]}`);
  ROWS.forEach(([hi, lo], row) => { for (let a = 0; a < hi.mem.length && out.length < 3; a++) if (hi.mem[a] || lo.mem[a]) { const x = unloc(row, a), v = dec(hi.mem[a] + lo.mem[a] * 65536, 9);
      if (!(x >= 0 && x < m.ramSize) || m.mem[x] !== v) out.push(`RAM chip row ${row} addr ${a} holds ${v} (address ${x}, machine ${m.mem[x]})`); } });
  for (const [nm, ch] of [['VRAM-C', VC], ['VRAM-S', VS]]) {
    for (let p = 0; p < FB_SIZE && out.length < 3; p++) if (m.vram[p] !== 0 && dec(ch.mem[fbLoc(p)], 8) !== m.vram[p]) out.push(`${nm} pixel ${p}: ${dec(ch.mem[fbLoc(p)], 8)} vs ${m.vram[p]}`);
    for (let a = 0; a < ch.mem.length && out.length < 3; a++) if (ch.mem[a]) { const p = unfb(a); if (!(p >= 0 && p < FB_SIZE) || dec(ch.mem[a], 8) !== m.vram[p]) out.push(`${nm} addr ${a} holds ${dec(ch.mem[a], 8)} (pixel ${p})`); } }
  return out;
}
const ABORTED = Symbol('aborted'); const COV = {}; const cov = (k, d = 1) => { COV[k] = (COV[k] || 0) + d; };
let n = 0, bad = 0, first = null, lastMachine = null, machines = 0, driven = 0, lastPix = -1, rng = 12345;
const rand = () => (rng = (rng * 1103515245 + 12345) >>> 0) / 4294967296;
const which = process.argv[2] || 'random', MAXC = +(process.argv[3] || 3e5);
const proto = MicroMachine.prototype, orig = proto.cycle;
const fail = msg => { bad++; if (!first) first = msg; if (bad > 20) { report(); reported = true; realExit(1); } };
let auditedAtStop = false;
proto.cycle = function () {
  if (n >= MAXC) {   // tracking stops here; the workload may run on, so audit the card's memory now, not at the end
    if (!auditedAtStop && lastMachine) { auditedAtStop = true; for (const m of audit(lastMachine)) { bad++; if (!first) first = `audit at stop: ${m}`; } }
    return orig.call(this); }
  if (this !== lastMachine) {
    if (lastMachine) for (const m of audit(lastMachine)) fail(`audit after machine ${machines}: ${m}`);
    lastMachine = this; machines++;
    if (!card || cardRam !== this.ramSize) { card = build(cs, this.ramSize, SLOT, MUT).check(); cardRam = this.ramSize;
      ROWS = []; for (let r = 0; r < rowsFor(this.ramSize); r++) ROWS.push([chip(`U${240 + 2 * r}`), chip(`U${241 + 2 * r}`)]); VC = chip('U256'); VS = chip('U257');
      MEMCHIPS = [...ROWS.flat(), VC, VS];
      if (machines === 1) { console.log('Memory card (stages 1+2) BOM:', JSON.stringify(card.bom()), `= ${card.chips.length} chips`); if (MUT) console.log('MUTANT', MUT); } }
    for (const c of card.chips) if (c.q) c.q = [];
    // declared preset: registers and memory start where the machine starts
    setWord(['U6', 'U7', 'U8'], this.MAR); for (let t = 0; t < 3; t++) setWord([`U${188 + t}`], this.MDR[t]); setWord(['U158', 'U159', 'U160'], this.faultAddr || 0);
    setWord(['U123', 'U124', 'U125'], this.rf[SLOT.UBASE]); setWord(['U126', 'U127', 'U128'], this.rf[SLOT.ULIMIT]);
    { const [m2, uf] = ulm(this.rf[SLOT.ULIMIT]); setWord(['U323', 'U324', 'U325'], m2); const f = chip('U326'); f.q = []; f.q[9] = uf; }
    for (const c of MEMCHIPS) c.mem.fill(0);
    for (let x = 0; x < this.ramSize; x++) if (this.mem[x]) ramPut(x, this.mem[x]);
    for (let p = 0; p < FB_SIZE; p++) if (this.vram[p]) vPut(p, this.vram[p]);
    shadow = Int16Array.from(this.mem); vshadow = Int16Array.from(this.vram); lastPix = -1;
    const w0 = new Map([['CLK', 0], ['/WSTB', 0], ['RESET', 1], ['MODE', 0], ['PRIV', 0], ['PROTEN', 0], ['SPRNR', 0], ['/SWR', 1], ['SCLK', 0]]);
    for (let i = 0; i < 5; i++) w0.set(`RSLOT${i}`, 0); for (let i = 0; i < 10; i++) w0.set(`UA${i}`, (this.upc >> i) & 1);
    for (let i = 0; i < 19; i++) w0.set(`SA${i}`, 0); for (let i = 0; i < 12; i++) w0.set(`SI${i}`, 0);
    for (let k = 0; k < 27; k++) { w0.set(`D${k}+`, 0); w0.set(`D${k}-`, 0); } card.settle(w0); for (const r of PIPE) P.ALVCH16823.clock(chip(r), p => card.v.get(chip(r).pins[p])); }
  const mu = this.cs.store[this.upc], d = this.decode(), upc = this.upc;
  const pre = { mode: this.mode, priv: this.priv, protEn: this.protEn, MAR: this.MAR, ramSize: this.ramSize };
  const rs = mu.RF_SEL || 'RD'; const isRegSpr = d.imm >= 5 && d.imm <= 14 && d.imm !== 8;
  const slot = { RD: d.rd, RS1: d.rs1, RS2: d.rs2, CONST: mu.CONST, SP: SLOT.SP, T0: SLOT.T0, T1: SLOT.T1, FPC: SLOT.FPC }[rs] ?? (isRegSpr ? 10 + d.imm : 0);
  const sprnr = rs === 'SPR' && !isRegSpr ? 1 : 0;
  // scan-out probe: half the time the last pixel written, else anywhere
  const sp = lastPix >= 0 && rand() < 0.5 ? lastPix : Math.floor(rand() * FB_SIZE), spExp = this.vram[sp];
  let memVal = 0; const mr = this.memRead; this.memRead = function (a) { memVal = mr.call(this, a); return memVal; };
  const writes = []; const mw = this.memWrite; this.memWrite = function (a, v) { writes.push(phys(this.mode, a)); return mw.call(this, a, v); };
  this.lastBus = ABORTED; const res = orig.call(this); delete this.memRead; delete this.memWrite; const aborted = this.lastBus === ABORTED;
  // what the microsim wrote this cycle, then (I/O cycles only) what off-card writers changed
  const expect = []; for (const x of writes) { if (x >= FB_BASE && x < FB_BASE + FB_SIZE) { const p = x - FB_BASE; expect.push({ fb: p }); vshadow[p] = this.vram[p]; lastPix = p; } else { expect.push({ x }); shadow[x] = this.mem[x]; } }
  const offMem = [], offFb = [];
  if (mu.IO) { for (let x = 0; x < this.ramSize; x++) if (this.mem[x] !== shadow[x]) { offMem.push(x); shadow[x] = this.mem[x]; }
    for (let p = 0; p < FB_SIZE; p++) if (this.vram[p] !== vshadow[p]) { offFb.push(p); vshadow[p] = this.vram[p]; } }
  const j2 = mu.IO === 'OUT' && d.imm === 4 && offFb.length === 1 && offMem.length === 0 ? offFb.pop() : -1;   // the Video card's pixel write
  const w = new Map([['CLK', 0], ['/WSTB', 0], ['RESET', 0], ['MODE', pre.mode], ['PRIV', pre.priv], ['PROTEN', pre.protEn], ['SPRNR', sprnr], ['/SWR', j2 >= 0 ? 0 : 1], ['SCLK', 0]]);
  for (let i = 0; i < 5; i++) w.set(`RSLOT${i}`, (slot >> i) & 1); for (let i = 0; i < 10; i++) w.set(`UA${i}`, (upc >> i) & 1);
  const sa = fbLoc(j2 >= 0 ? j2 : sp); for (let i = 0; i < 19; i++) w.set(`SA${i}`, (sa >> i) & 1);
  const si = j2 >= 0 ? enc(this.vram[j2], 6) : 0; for (let i = 0; i < 12; i++) w.set(`SI${i}`, (si >> i) & 1);
  if (j2 >= 0) { expect.push({ fb: j2, j2: true }); lastPix = j2; }
  const irRead = mu.MEM === 'RD' && mu.LD_IR, memWord = irRead || ['MAR', 'MDR', 'MDR0', 'FADDR'].includes(mu.BUS);
  if (!memWord) toT(this.lastBus === undefined || aborted ? 0 : this.lastBus, 27).forEach((x, k) => { const [p, q] = rails(x); w.set(`D${k}+`, p); w.set(`D${k}-`, q); });
  const msgs = [];
  try {
    const pw = new Map(w); for (let k = 0; k < 27; k++) if (!pw.has(`D${k}+`)) { pw.set(`D${k}+`, 0); pw.set(`D${k}-`, 0); }
    pw.set('/SWR', 1); card.settle(pw); for (const r of PIPE) P.ALVCH16823.clock(chip(r), p => card.v.get(chip(r).pins[p]));
    const v = card.settle(w);
    if (v.get('ABORT') !== (aborted ? 1 : 0)) msgs.push(`ABORT ${v.get('ABORT')} vs ${aborted ? 1 : 0}`);
    if (aborted && v.get('FK') !== (this.upc === 430 ? 1 : 0)) msgs.push(`FK ${v.get('FK')} vs ${this.upc === 430 ? 1 : 0}`);
    const expBad = !(pre.MAR >= 0 && pre.MAR + 2 < pre.ramSize) ? 1 : 0; if (v.get('BADADDR') !== expBad) msgs.push(`BADADDR ${v.get('BADADDR')} vs ${expBad}`);
    if (memWord && !aborted) { driven++; let x = 0; for (let k = 26; k >= 0; k--) x = 3 * x + trit(v.get(`D${k}+`), v.get(`D${k}-`));
      const exp = irRead ? memVal : this.lastBus; if (x !== exp) msgs.push(`bus ${x} vs ${exp} (${irRead ? 'IR read' : mu.BUS})`); }
    if (!memWord) for (let k = 0; k < 27; k++) if (v.get(`D${k}+`) !== w.get(`D${k}+`) || v.get(`D${k}-`) !== w.get(`D${k}-`)) { msgs.push('card drove the bus when it should not'); break; }
    // J2: VBUSY while a CPU framebuffer write owns VRAM-S; otherwise the probe pixel comes out on SO
    const fbW = expect.some(e => e.fb !== undefined && !e.j2); if (v.get('VWEH') !== (fbW ? 1 : 0)) msgs.push(`VBUSY ${v.get('VWEH')} vs ${fbW ? 1 : 0}`);
    for (const c of card.chips) if (P[c.part].reg && !PIPE.includes(c.ref)) P[c.part].clock(c, p => v.get(c.pins[p]));
    // the SO latch (U284-285, clocked by the slot clock; here once per microcycle) now holds the probe pixel
    if (!fbW && j2 < 0) { const q = [...(chip('U284').q || []).slice(1, 9), ...(chip('U285').q || []).slice(1, 5)]; let b = 0; for (let i = 0; i < 12; i++) b += (q[i] | 0) * 2 ** i;
      const got = dec(b, 6); cov('scan probe'); if (got !== spExp) msgs.push(`scan-out pixel ${sp}: ${got} vs ${spExp}`); }
    // the write edge: account for every chip that writes
    const wrote = new Map(); for (const c of MEMCHIPS) { const a = P[c.part].write(c, p => v.get(c.pins[p])); if (a >= 0) wrote.set(c.ref, a); }
    for (const e of expect) {
      if (e.fb !== undefined) { const a = fbLoc(e.fb);
        for (const ch of [VC, VS]) { if (wrote.get(ch.ref) !== a) msgs.push(`${ch.ref === 'U256' ? 'VRAM-C' : 'VRAM-S'} not written at pixel ${e.fb}${e.j2 ? ' (J2)' : ''}`);
          else if (dec(ch.mem[a], 8) !== this.vram[e.fb]) msgs.push(`pixel ${e.fb} stored ${dec(ch.mem[a], 8)} vs ${this.vram[e.fb]}`); wrote.delete(ch.ref); }
        cov(e.j2 ? 'J2 pixel write' : 'FB write'); }
      else { const { row, addr } = loc(e.x), pair = ROWS[row];
        if (!pair || wrote.get(pair[0].ref) !== addr || wrote.get(pair[1].ref) !== addr) msgs.push(`RAM ${e.x} not written (row ${row})`);
        else if (ramGet(e.x) !== this.mem[e.x]) msgs.push(`RAM ${e.x} stored ${ramGet(e.x)} vs ${this.mem[e.x]}`);
        if (pair) { wrote.delete(pair[0].ref); wrote.delete(pair[1].ref); } cov(`RAM write row ${row}`); } }
    for (const [ref, a] of wrote) msgs.push(`unexpected write: ${ref} at ${a}${aborted ? ' (aborted cycle)' : ''}`);
    const MAR = regWord(['U6', 'U7', 'U8']), MDR = [0, 1, 2].map(t => regWord([`U${188 + t}`])), FA = regWord(['U158', 'U159', 'U160']);
    const UB = regWord(['U123', 'U124', 'U125']), UL = regWord(['U126', 'U127', 'U128']);
    if (MAR !== this.MAR) msgs.push(`MAR ${MAR} vs ${this.MAR}`); if (MDR.join() !== this.MDR.join()) msgs.push(`MDR ${MDR} vs ${this.MDR}`);
    if (FA !== (this.faultAddr || 0)) msgs.push(`FADDR ${FA} vs ${this.faultAddr}`);
    if (UB !== this.rf[SLOT.UBASE] || UL !== this.rf[SLOT.ULIMIT]) msgs.push(`shadows ${UB},${UL} vs ${this.rf[SLOT.UBASE]},${this.rf[SLOT.ULIMIT]}`);
    { const [m2, uf] = ulm(this.rf[SLOT.ULIMIT]), got = regWord(['U323', 'U324', 'U325']), gf = (chip('U326').q || [])[9] | 0;
      if (got !== m2 || gf !== uf) msgs.push(`UL2 shadow ${got}/${gf} vs ${m2}/${uf}`); }
  } catch (e) { msgs.push('netlist stopped: ' + e.message); }
  // off-card writers not drawn yet: copy their changes into the card (declared, counted)
  for (const x of offMem) ramPut(x, this.mem[x]); for (const p of offFb) vPut(p, this.vram[p]);
  if (offMem.length) cov('sync RAM trytes (off-card DMA)', offMem.length); if (offFb.length) cov('sync pixels (off-card fill)', offFb.length);
  if (mu.MEM) cov('MEM ' + mu.MEM); if (aborted) cov(this.upc === 430 ? 'fault PROT' : 'fault BAD'); if (memWord) cov('bus ' + (irRead ? 'IR' : mu.BUS)); if (mu.LD_MDR) cov('LD_MDR ' + (mu.MDR_LANE ?? 0)); if (mu.MAR_INC) cov(mu.LD_MAR ? 'LD+INC' : 'MAR_INC');
  if (mu.MEM === 'RD' && !aborted) { const x = phys(pre.mode, pre.MAR); cov(x >= FB_BASE ? 'FB read' : pre.mode === 0 ? 'T2 RAM read' : 'T3 RAM read'); if (pre.mode === 0 && pre.MAR !== x) cov('T2 wrapped read'); }
  if (mu.MEM === 'WR' && aborted) cov('aborted write');
  if (mu.RF_WR && (slot === SLOT.UBASE || slot === SLOT.ULIMIT) && !sprnr) cov('shadow snoop'); if (pre.mode === 0) cov('T2');
  if (msgs.length) fail(`cycle ${n} upc ${upc} (${mu._r || ''}): ${msgs.join('; ')}`);
  n++; return res;
};
function report() { if (lastMachine && !reported && !auditedAtStop) { for (const m of audit(lastMachine)) { bad++; if (!first) first = `final audit: ${m}`; } }
  const line = `Memory card vs microsim (${which}): ${n.toLocaleString()} microcycles, card drove the bus ${driven.toLocaleString()} times, ${machines} machine power-up(s), ${bad} mismatches${first ? '; first: ' + first : ''}`;
  console.log(line); console.log('coverage:', JSON.stringify(COV)); fs.appendFileSync(path.join(__dirname, 'RESULTS-memory-card.jsonl'), JSON.stringify({ date: new Date().toISOString(), stage: 2, which, mutant: MUT || null, cycles: n, driven, bad, first, cov: COV }) + '\n'); }
const realExit = process.exit; let reported = false; process.exit = c => { if (!reported) { report(); reported = true; } realExit(bad ? 1 : 0); };
const W = { directed: './directed-alu.js', fetchfault: './directed-fetchfault.js', irqbm: './directed-irq-blockmove.js', spr: './directed-spr.js', bcfault: './directed-bcfault.js', prot: './directed-prot.js', fb: './directed-fb.js' };
if (W[which]) require(W[which]);
else if (which === 'random') { process.argv[2] = require(__dirname+'/../triton-dir.js')+'/triton3.html'; process.argv[3] = String(+(process.argv[4] || 100)); process.argv.length = 4; require('../microsim/diff.js'); }
else { process.argv[2] = require(__dirname+'/../triton-dir.js')+''; process.argv.length = 3; require(which === 'desktop' ? '../microsim/boot-desktop.js' : '../microsim/boot-tritos21.js'); }
if (!reported) { report(); reported = true; }
