// control-card-test.js: differential test of the Control card (stage 1) against the microsim, microcycle by
// microcycle. The card is one cycle behind the microsim: the "interrupt pending at the coming boundary" input (IRQN)
// is only known once the microsim has started its next step. After each simulated edge we compare the card's
// micro-address, PC, IR, micro-counter (and its zero flag) with the microsim's state at the start of the next cycle,
// and, during the cycle, whatever the card drives onto the bus, the register slot, the port number and ALIAS.
// Usage: node control-card-test.js [random|desktop|tritos21|directed|fetchfault] [maxCycles] [programs]
'use strict';
const fs = require('fs'), path = require('path');
const { build, cardWord, CW } = require('./control-card.js');
const { rails, trit } = require('./netlist.js');
const { P } = require('./parts.js');
const { decodeWord } = require('../microsim/roms.js');
const { MicroMachine, WORD_BITS, SLOT } = require('../microsim/microsim.js');
const ROMS = path.join(__dirname, '../roms');
const chips = Array.from({ length: Math.ceil(WORD_BITS / 8) }, (_, k) => fs.readFileSync(path.join(ROMS, `cs${k}.bin`)));
const fixed = (() => { const m = new MicroMachine(); return { FETCH: m.cs.addr.FETCH }; })();
const nCS = Math.ceil(CW.length / 8), cs = Array.from({ length: nCS }, () => Buffer.alloc(1024));
for (let w = 0; w < 1024; w++) { let b = 0n; for (let k = 0; k < chips.length; k++) b |= BigInt(chips[k][w]) << BigInt(8 * k);
  let mu; try { mu = decodeWord(b); } catch { continue; } const cw = cardWord(mu, w, fixed); for (let j = 0; j < nCS; j++) cs[j][w] = Number((cw >> BigInt(8 * j)) & 255n); }
const MUT = process.env.CTL_MUTANT; const card = build(ROMS, cs, MUT).check();
console.log('Control card BOM:', JSON.stringify(card.bom()), `= ${card.chips.length} chips`); if (MUT) console.log('MUTANT', MUT);

const toT = (v, n) => { const t = []; let x = v; for (let i = 0; i < n; i++) { let r = ((x % 3) + 3) % 3; if (r === 2) r = -1; t.push(r); x = (x - r) / 3; } return t; };
const word = (prefix, n, src) => { let x = 0; for (let k = n - 1; k >= 0; k--) x = 3 * x + trit(src(`${prefix}${k}+`), src(`${prefix}${k}-`)); return x; };
const chip = ref => card.chips.find(c => c.ref === ref);
const qOf = (ref, h, i) => ((chip(ref).q || [])[h * 9 + i] | 0);
const state = () => {
  const pcT = []; for (const r of ['U20', 'U21', 'U22']) for (const h of [1, 2]) for (let i = 0; i < 9; i++) pcT.push(qOf(r, h, i));
  let pc = 0; for (let k = 26; k >= 0; k--) pc = 3 * pc + trit(pcT[2 * k], pcT[2 * k + 1]);
  const ir = [0, 1].map(t => { const b = []; for (const h of [1, 2]) for (let i = 0; i < 9; i++) b.push(qOf(`U${17 + t}`, h, i)); let x = 0; for (let k = 8; k >= 0; k--) x = 3 * x + trit(b[2 * k], b[2 * k + 1]); return x; });
  const ua = [0, 1].flatMap(j => [...Array(8).keys()].map(i => (chip(`U${14 + j}`).q || [])[i + 1] | 0)).slice(0, 10).reduce((a, b, i) => a | b << i, 0);
  const u = (chip('U19').q || []); const ucnt = [1, 2, 3, 4, 5, 6].reduce((a, i, k) => a | (u[i] | 0) << k, 0);
  const L = i => qOf('U89', i < 9 ? 1 : 2, i % 9) ^ ((i === 0 || i === 3) && MUT !== 'LATCH_NO_RESET' ? 1 : 0);   // MODE, PROTEN stored inverted
  const lat = { mode: L(0), priv: L(1), ie: L(2), protEn: L(3), trapDiv0: L(4), imask: [5, 6, 7, 8, 9].reduce((a, i, k) => a | L(i) << k, 0), ipend: [10, 11, 12, 13, 14].reduce((a, i, k) => a | L(i) << k, 0) };
  return { pc, ir, ua, ucnt, ucz: u[7] | 0, lat }; };
// power-up preset of the latch register: the test programs set SPRs in both machines before they run (diff.js,
// the boot scripts), so the card's latch register starts from the microsim's starting values. Declared, and the only
// place the harness writes a register: everything after this goes through the card's own pins.
const presetLatches = m => { const c = chip('U89'); c.q = []; const v = [m.mode, m.priv, m.ie, m.protEn, m.trapDiv0, ...[0, 1, 2, 3, 4].map(b => (m.imask >> b) & 1), ...[0, 1, 2, 3, 4].map(b => (m.ipend >> b) & 1)];
  const inv = MUT === 'LATCH_NO_RESET' ? [] : [0, 3];   // MODE and PROTEN are stored inverted (U104)
  v.forEach((x, i) => { c.q[(i < 9 ? 1 : 2) * 9 + (i % 9)] = (x ? 1 : 0) ^ (inv.includes(i) ? 1 : 0); }); };
const clockAll = (only) => { for (const ch of card.chips) if (P[ch.part].reg && (!only || only.includes(ch.ref))) P[ch.part].clock(ch, p => card.v.get(ch.pins[p])); };
const PIPE = card.chips.filter(c => c.part === 'ALVCH16823' && /^RESET(\|LOAD)?$/.test(c.pins['1/OE'])).map(c => c.ref);   // the load path ORs LOAD in

const COV = {}; const cov = k => { COV[k] = (COV[k] || 0) + 1; };
let pending = null, n = 0, bad = 0, first = null, lastMachine = null, machines = 0, driven = 0;
function runCard(rec, stepSet, nowState) {
  const w = new Map(rec.world); const set = rec.midSet | stepSet; for (let b = 0; b < 5; b++) w.set(`IRQSET${b}`, (set >> b) & 1);
  // integration stage 2 (2026-11-20): UA is the next address, so the pipeline already holds this cycle's word (it was
  // latched with every other register at the edge that ended the last cycle). One edge for everything, as on the backplane.
  const v = card.settle(w); const msgs = [];
  if (rec.ctlDrives) { driven++; const out = word('D', 27, x => v.get(x)); if (out !== rec.bus) msgs.push(`bus ${out} vs ${rec.bus} (${rec.mu.BUS})`); }
  else if (!rec.ctlWord) for (let k = 0; k < 27; k++) if (v.get(`D${k}+`) !== w.get(`D${k}+`) || v.get(`D${k}-`) !== w.get(`D${k}-`)) { msgs.push('card drove the bus when it should not'); break; }
  if (rec.slot !== null && !rec.aborted) { const s = [0, 1, 2, 3, 4].reduce((a, i) => a | v.get(`RSLOT${i}`) << i, 0); if (s !== rec.slot) msgs.push(`slot ${s} vs ${rec.slot}`); }
  if (rec.sprnr !== null) { if (v.get('SPRNR') !== rec.sprnr) msgs.push(`SPRNR ${v.get('SPRNR')} vs ${rec.sprnr}`); }
  if (rec.port !== null) { const p = [0, 1, 2, 3, 4, 5].reduce((a, i) => a | v.get(`PORT${i}`) << i, 0); if (p !== rec.port) msgs.push(`port ${p} vs ${rec.port}`); }
  clockAll(null);   // every register, pipeline included, on the same values (one edge, as on the backplane)
  const s = state(), e = nowState;
  if (s.ua !== e.upc) msgs.push(`µPC ${s.ua} vs ${e.upc}`); if (s.pc !== e.pc) msgs.push(`PC ${s.pc} vs ${e.pc}`);
  if (s.ir[0] !== e.ir[0] || s.ir[1] !== e.ir[1]) msgs.push(`IR ${s.ir} vs ${e.ir}`);
  for (const k of ['mode', 'priv', 'ie', 'protEn', 'trapDiv0', 'imask', 'ipend']) if (s.lat[k] !== e[k]) msgs.push(`${k} ${s.lat[k]} vs ${e[k]}`);
  if (s.ucnt !== (((e.ucnt % 64) + 64) % 64)) msgs.push(`ucnt ${s.ucnt} vs ${e.ucnt}`); else if (s.ucz !== (e.ucnt === 0 ? 1 : 0)) msgs.push(`ucnt zero flag ${s.ucz} vs ${e.ucnt}`);
  if (msgs.length) { bad++; if (!first) first = `cycle ${rec.n} upc ${rec.upc} (${rec.mu._r || ''}): ${msgs.join('; ')}`; if (bad > 20) { report(); reported = true; realExit(1); } }
}
const snap = m => ({ upc: m.upc, pc: m.pc, ir: [m.IR[0], m.IR[1]], ucnt: m.ucnt, mode: m.mode, priv: m.priv, ie: m.ie, protEn: m.protEn, trapDiv0: m.trapDiv0, imask: m.imask, ipend: m.ipend });
const proto = MicroMachine.prototype, orig = proto.cycle;
proto.cycle = function () {
  if (this !== lastMachine) { lastMachine = this; pending = null; for (const ch of card.chips) if (ch.q) ch.q = [];
    machines++; const w0 = new Map([['CLK', 0], ['RESET', 1]]);
    // power-up: RESET, then load the pipeline with the first word; the card's registers start where the machine starts
    for (const k of ['ABORT', 'FK', 'SF+', 'SF-', 'QT+', 'QT-', 'BTOPNZ', 'BADADDR', 'IORDY', 'IRQSET0', 'IRQSET1', 'IRQSET2', 'IRQSET3', 'IRQSET4']) w0.set(k, 0);
    for (let k = 0; k < 27; k++) { w0.set(`D${k}+`, 0); w0.set(`D${k}-`, 0); } card.settle(w0); clockAll(PIPE); presetLatches(this);
    const st = snap(this); if (st.upc !== 0 || st.pc !== 0 || st.ucnt !== 0 || st.ir[0] || st.ir[1]) throw new Error('machine did not start from reset');
  }
  if (pending) { try { runCard(pending, this.ipend & ~pending.postIpend & 31, snap(this)); }
    catch (e) { bad++; if (!first) first = `cycle ${pending.n} upc ${pending.upc} (${pending.mu._r || ''}): the card's netlist stopped: ${e.message}`; report(); reported = true; realExit(1); }
    pending = null; }
  if (n >= MAXC || this.halted) return orig.call(this);
  const mu = this.cs.store[this.upc], d = this.decode(), upc = this.upc;
  const B26 = toT(this.B, 27)[26];
  const world = new Map([['CLK', 0], ['RESET', 0]]);
  const [sp, sn] = rails(this.sf), [qp, qn] = rails(this.qt);
  Object.entries({ 'SF+': sp, 'SF-': sn, 'QT+': qp, 'QT-': qn, BTOPNZ: B26 === 0 ? 0 : 1, BADADDR: !(this.MAR >= 0 && this.MAR + 2 < this.ramSize) ? 1 : 0,
    IORDY: this.ioWait === 0 ? 1 : 0 }).forEach(([k, x]) => world.set(k, x));
  let memVal; const mr = this.memRead; this.memRead = function (a) { memVal = mr.call(this, a); return memVal; };
  let midSet = 0; const io = this.io, pin = io.portIn, pout = io.portOut;
  io.portIn = function (...a) { const b = io.m.ipend; const r = pin.apply(io, a); midSet |= io.m.ipend & ~b; return r; };
  io.portOut = function (...a) { const b = io.m.ipend; const r = pout.apply(io, a); midSet |= io.m.ipend & ~b; return r; };
  this.lastBus = ABORTED; const res = orig.call(this); delete this.memRead; delete io.portIn; delete io.portOut;
  const aborted = this.lastBus === ABORTED; world.set('ABORT', aborted ? 1 : 0); world.set('FK', aborted && this.upc === 430 ? 1 : 0);
  const sprLatchRead = mu.BUS === 'RF' && (mu.RF_SEL === 'SPR') && !(d.imm >= 5 && d.imm <= 14 && d.imm !== 8);
  const ctlWord = ['PC', 'IMM', 'CONST', 'OPC', 'IRQV'].includes(mu.BUS) || sprLatchRead, ctlDrives = ctlWord && !aborted;   // an aborted cycle still drives; nothing loads
  if (!ctlWord) { const val = mu.LD_IR && mu.MEM === 'RD' && !aborted ? memVal : (this.lastBus === undefined || aborted ? 0 : this.lastBus);
    toT(val, 27).forEach((x, k) => { const [p, q] = rails(x); world.set(`D${k}+`, p); world.set(`D${k}-`, q); }); }
  const rs = mu.RF_SEL || 'RD';
  const slot = (mu.RF_RD || mu.RF_WR) ? ({ RD: d.rd, RS1: d.rs1, RS2: d.rs2, CONST: mu.CONST, SP: SLOT.SP, T0: SLOT.T0, T1: SLOT.T1, FPC: SLOT.FPC }[rs] ?? (d.imm >= 5 && d.imm <= 14 && d.imm !== 8 ? 10 + d.imm : null)) : null;
  const port = (mu.IO === 'IN' || mu.IO === 'OUT') ? (d.imm >= 0 && d.imm < 63 ? d.imm : 63) : null;
  cov('SEQ ' + (mu.SEQ || 'NEXT')); if (aborted) cov('ABORT'); if (mu.COND) cov('COND ' + mu.COND); if (ctlDrives) cov('BUS ' + mu.BUS); if (mu.UCNT) cov('UCNT ' + mu.UCNT); if (mu.PC || mu.LD_PC) cov('PC ' + (mu.LD_PC ? 'LOAD' : mu.PC));
  if (mu.RETIRE) cov('RETIRE'); if (this.mode === 0) cov('T2 mode');
  const sprnr = (mu.RF_SEL === 'SPR' && (mu.RF_RD || mu.RF_WR || mu.BUS === 'RF')) ? (d.imm >= 5 && d.imm <= 14 && d.imm !== 8 ? 0 : 1) : null;
  if (mu.RF_SEL === 'SPR') cov('SPR ' + (sprnr ? 'latch' : 'reg')); if (mu.IRQ_ACK) cov('IRQ_ACK'); if (mu.PSW) cov('PSW ' + mu.PSW); if (midSet) cov('device IRQ mid-cycle');
  pending = { n, upc, mu, world, ctlDrives, ctlWord, sprnr, midSet, postIpend: this.ipend, bus: this.lastBus, aborted, slot, port };
  n++; return res;
};
const ABORTED = Symbol('aborted');
const which = process.argv[2] || 'random', MAXC = +(process.argv[3] || 3e5);
function report() { const line = `Control card vs microsim (${which}): ${n.toLocaleString()} microcycles, card drove the bus ${driven.toLocaleString()} times, ${machines} machine power-up(s), ${bad} mismatches${first ? '; first: ' + first : ''}`;
  console.log(line); console.log('coverage:', JSON.stringify(COV)); fs.appendFileSync(path.join(__dirname, 'RESULTS-control-card.jsonl'), JSON.stringify({ date: new Date().toISOString(), which, mutant: MUT || null, cycles: n, driven, bad, first, cov: COV }) + '\n'); }
const realExit = process.exit; let reported = false; process.exit = (c) => { if (!reported) { reported = true; report(); } realExit(bad ? 1 : 0); };
if (which === 'directed') require('./directed-alu.js');
else if (which === 'fetchfault') require('./directed-fetchfault.js');
else if (which === 'irqbm') require('./directed-irq-blockmove.js');
else if (which === 'spr') require('./directed-spr.js');
else if (which === 'random') { process.argv[2] = require(__dirname+'/../triton-dir.js')+'/triton3.html'; process.argv[3] = String(+(process.argv[4] || 100)); process.argv.length = 4; require('../microsim/diff.js'); }
else { process.argv[2] = require(__dirname+'/../triton-dir.js')+''; process.argv.length = 3; require(which === 'desktop' ? '../microsim/boot-desktop.js' : '../microsim/boot-tritos21.js'); }
if (!reported) { reported = true; report(); }
