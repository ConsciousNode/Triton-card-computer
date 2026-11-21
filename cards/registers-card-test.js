// registers-card-test.js: the Registers card beside the microsim, every microcycle. Inputs from the other cards come
// from the microsim: RSLOT and SPRNR (Control), ABORT (Memory), and the bus when this card isn't driving it. Compared:
// what it drives onto the bus, and all 32 register slots after every edge (read from the RAM chips for observation
// only). Declared exception: at each machine start the RAM is preset to the microsim's starting register values (the
// test programs set registers directly). Usage: node registers-card-test.js [workload] [maxCycles] [programs]
'use strict';
// /WSTB (2026-11-20): the backplane write strobe. This harness writes at the edge with settled values, so it holds the
// strobe active (low); its timing is checked on the whole machine (integration/timing-sim.js).
const fs = require('fs'), path = require('path');
const { build, cardWord } = require('./registers-card.js');
const { rails, trit } = require('./netlist.js');
const { P } = require('./parts.js');
const { decodeWord } = require('../microsim/roms.js');
const { MicroMachine, WORD_BITS, SLOT } = require('../microsim/microsim.js');
const ROMS = path.join(__dirname, '../roms');
const chips = Array.from({ length: Math.ceil(WORD_BITS / 8) }, (_, k) => fs.readFileSync(path.join(ROMS, `cs${k}.bin`)));
const cs = Buffer.alloc(1 << 19);
for (let w = 0; w < 1024; w++) { let b = 0n; for (let k = 0; k < chips.length; k++) b |= BigInt(chips[k][w]) << BigInt(8 * k); let mu; try { mu = decodeWord(b); } catch { continue; } cs[w] = cardWord(mu); }
const MUT = process.env.REG_MUTANT; const card = build(cs, MUT).check();
console.log('Registers card BOM:', JSON.stringify(card.bom()), `= ${card.chips.length} chips`); if (MUT) console.log('MUTANT', MUT);
const toT = (v, n) => { const t = []; let x = v; for (let i = 0; i < n; i++) { let r = ((x % 3) + 3) % 3; if (r === 2) r = -1; t.push(r); x = (x - r) / 3; } return t; };
const RAM = [10, 11, 12, 13, 14, 15, 16].map(i => card.chips.find(c => c.ref === `U${i}`));
const slotVal = s => { const bits = []; for (const c of RAM) for (let i = 0; i < 8; i++) bits.push((c.mem[s] >> i) & 1); let x = 0; for (let k = 26; k >= 0; k--) x = 3 * x + trit(bits[2 * k], bits[2 * k + 1]); return x; };
const preset = rf => { for (const c of RAM) c.mem.fill(0); rf.forEach((v, s) => { const t = toT(v, 27); t.forEach((x, k) => { const [p, q] = rails(x); for (const [b, val] of [[2 * k, p], [2 * k + 1, q]]) { const c = RAM[b >> 3]; c.mem[s] |= val << (b & 7); } }); }); };
const ABORTED = Symbol('aborted'); const COV = {}; const cov = k => { COV[k] = (COV[k] || 0) + 1; };
let n = 0, bad = 0, first = null, lastMachine = null, machines = 0, driven = 0;
const which = process.argv[2] || 'random', MAXC = +(process.argv[3] || 3e5);
const proto = MicroMachine.prototype, orig = proto.cycle;
proto.cycle = function () {
  if (n >= MAXC) return orig.call(this);
  if (this !== lastMachine) { lastMachine = this; machines++; preset(this.rf); card.chips.find(c => c.ref === 'U2').q = [];
    const w0 = new Map([['CLK', 0], ['/WSTB', 0], ['RESET', 1], ['ABORT', 0], ['SPRNR', 0]]); for (let i = 0; i < 5; i++) w0.set(`RSLOT${i}`, 0); for (let i = 0; i < 10; i++) w0.set(`UA${i}`, 0);
    for (let k = 0; k < 27; k++) { w0.set(`D${k}+`, 0); w0.set(`D${k}-`, 0); } card.settle(w0); const u2 = card.chips.find(c => c.ref === 'U2'); P.LVC574.clock(u2, p => card.v.get(u2.pins[p])); }
  const mu = this.cs.store[this.upc], d = this.decode(), upc = this.upc;
  const rs = mu.RF_SEL || 'RD';
  const slot = { RD: d.rd, RS1: d.rs1, RS2: d.rs2, CONST: mu.CONST, SP: SLOT.SP, T0: SLOT.T0, T1: SLOT.T1, FPC: SLOT.FPC }[rs] ?? (d.imm >= 5 && d.imm <= 14 && d.imm !== 8 ? 10 + d.imm : 0);
  const sprnr = rs === 'SPR' && !(d.imm >= 5 && d.imm <= 14 && d.imm !== 8) ? 1 : 0;
  this.lastBus = ABORTED; const res = orig.call(this); const aborted = this.lastBus === ABORTED;
  const w = new Map([['CLK', 0], ['/WSTB', 0], ['RESET', 0], ['ABORT', aborted ? 1 : 0], ['SPRNR', sprnr]]);
  for (let i = 0; i < 5; i++) w.set(`RSLOT${i}`, (slot >> i) & 1); for (let i = 0; i < 10; i++) w.set(`UA${i}`, (upc >> i) & 1);
  const cardDrives = mu.RF_RD && !sprnr;
  if (!cardDrives) toT(this.lastBus === undefined || aborted ? 0 : this.lastBus, 27).forEach((x, k) => { const [p, q] = rails(x); w.set(`D${k}+`, p); w.set(`D${k}-`, q); });
  const msgs = [];
  try {
    const pre = new Map(w); for (let k = 0; k < 27; k++) if (!pre.has(`D${k}+`)) { pre.set(`D${k}+`, 0); pre.set(`D${k}-`, 0); }
    card.settle(pre); P.LVC574.clock(card.chips.find(c => c.ref === 'U2'), p => card.v.get(card.chips.find(c => c.ref === 'U2').pins[p]));
    const v = card.settle(w);
    if (cardDrives && !aborted) { driven++; let x = 0; for (let k = 26; k >= 0; k--) x = 3 * x + trit(v.get(`D${k}+`), v.get(`D${k}-`)); if (x !== this.lastBus) msgs.push(`bus ${x} vs ${this.lastBus}`); }
    if (!cardDrives) for (let k = 0; k < 27; k++) if (v.get(`D${k}+`) !== w.get(`D${k}+`) || v.get(`D${k}-`) !== w.get(`D${k}-`)) { msgs.push('card drove the bus when it should not'); break; }
    for (const c of RAM) P.IS61WV5128.write(c, p => v.get(c.pins[p]));
    for (let s = 0; s < 32; s++) if (slotVal(s) !== this.rf[s]) { msgs.push(`slot ${s}: ${slotVal(s)} vs ${this.rf[s]}`); break; }
  } catch (e) { msgs.push('netlist stopped: ' + e.message); }
  if (mu.RF_RD) cov('read'); if (mu.RF_WR) cov('write'); if (sprnr) cov('SPRNR'); if (aborted) cov('ABORT'); if (aborted && mu.RF_WR) cov('aborted write');
  if (msgs.length) { bad++; if (!first) first = `cycle ${n} upc ${upc} (${mu._r || ''}): ${msgs.join('; ')}`; if (bad > 20) { report(); reported = true; realExit(1); } }
  n++; return res;
};
function report() { const line = `Registers card vs microsim (${which}): ${n.toLocaleString()} microcycles, card drove the bus ${driven.toLocaleString()} times, ${machines} machine power-up(s), ${bad} mismatches${first ? '; first: ' + first : ''}`;
  console.log(line); console.log('coverage:', JSON.stringify(COV)); fs.appendFileSync(path.join(__dirname, 'RESULTS-registers-card.jsonl'), JSON.stringify({ date: new Date().toISOString(), which, mutant: MUT || null, cycles: n, driven, bad, first, cov: COV }) + '\n'); }
const realExit = process.exit; let reported = false; process.exit = c => { if (!reported) { reported = true; report(); } realExit(bad ? 1 : 0); };
if (which === 'directed') require('./directed-alu.js');
else if (which === 'fetchfault') require('./directed-fetchfault.js');
else if (which === 'irqbm') require('./directed-irq-blockmove.js');
else if (which === 'spr') require('./directed-spr.js');
else if (which === 'bcfault') require('./directed-bcfault.js');
else if (which === 'random') { process.argv[2] = require(__dirname+'/../triton-dir.js')+'/triton3.html'; process.argv[3] = String(+(process.argv[4] || 100)); process.argv.length = 4; require('../microsim/diff.js'); }
else { process.argv[2] = require(__dirname+'/../triton-dir.js')+''; process.argv.length = 3; require(which === 'desktop' ? '../microsim/boot-desktop.js' : '../microsim/boot-tritos21.js'); }
if (!reported) { reported = true; report(); }
