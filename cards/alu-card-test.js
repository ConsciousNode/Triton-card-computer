// alu-card-test.js: differential twin #3 for the ALU card. The chip-level netlist (alu-card.js), with its slice tables
// loaded from roms/alu.bin and its control store built from the ROM images (roms/cs*.bin, decoded, then repacked for
// this card), runs beside the microsim on a real workload. Every microcycle: the card gets the micro-address, CF and
// (when it isn't driving) the bus value the rest of the machine put there; we compare what it drives onto the bus and
// its A, B, LINK and QT registers with the microsim's. Usage: node alu-card-test.js [desktop|tritos21|random] [maxCycles] [programs]
'use strict';
const fs = require('fs'), path = require('path');
const { build, cardWord } = require('./alu-card.js');
const { rails, trit } = require('./netlist.js');
const { decodeWord } = require('../microsim/roms.js');
const { MicroMachine, WORD_BITS } = require('../microsim/microsim.js');
const ROMS = path.join(__dirname, '../roms');
const alu = fs.readFileSync(path.join(ROMS, 'alu.bin'));
// card control store, from the shared ROM images only
const chips = Array.from({ length: Math.ceil(WORD_BITS / 8) }, (_, k) => fs.readFileSync(path.join(ROMS, `cs${k}.bin`)));
const cs = [Buffer.alloc(1024), Buffer.alloc(1024), Buffer.alloc(1024), Buffer.alloc(1024)];
const fixed = (() => { const m = new MicroMachine(); return { FETCH: m.cs.addr.FETCH, FETCH2: m.cs.addr.FETCH2 }; })();   // wired entry points, as roms.js
for (let w = 0; w < 1024; w++) { let b = 0n; for (let k = 0; k < chips.length; k++) b |= BigInt(chips[k][w]) << BigInt(8 * k);
  let mu; try { mu = decodeWord(b); } catch { continue; } const cw = cardWord(mu, w, fixed); for (let j = 0; j < 4; j++) cs[j][w] = (cw >> (8 * j)) & 255; }
const card = build(alu, cs, process.env.ALU_MUTANT).check();
if (process.env.ALU_MUTANT) console.log('MUTANT', process.env.ALU_MUTANT);
console.log('ALU card BOM:', JSON.stringify(card.bom()), `= ${card.chips.length} chips`);

const toT = (v, n) => { const t = []; let x = v; for (let i = 0; i < n; i++) { let r = ((x % 3) + 3) % 3; if (r === 2) r = -1; t.push(r); x = (x - r) / 3; } return t; };
const fromNets = (v, name) => { let x = 0; for (let k = 26; k >= 0; k--) x = 3 * x + trit(v.get(`${name}${k}+`), v.get(`${name}${k}-`)); return x; };
const regs = () => { const q = c => c.q || [];
  const word = refs => { let x = 0; const t = []; refs.forEach(r => { const ch = card.chips.find(c => c.ref === r); for (const h of [1, 2]) for (let i = 0; i < 9; i++) t.push(q(ch)[h * 9 + i] | 0); });
    for (let k = 26; k >= 0; k--) x = 3 * x + trit(t[2 * k], t[2 * k + 1]); return x; };
  const l = q(card.chips.find(c => c.ref === 'U111')), f = q(card.chips.find(c => c.ref === 'U119')); return { sf: trit(f[9] | 0, f[10] | 0), cf: trit(f[11] | 0, f[12] | 0), of: trit(f[13] | 0, f[14] | 0), sh: [trit(f[18] | 0, f[19] | 0), trit(f[20] | 0, f[21] | 0), trit(f[22] | 0, f[23] | 0)], A: word(['U1', 'U2', 'U3']), B: word(['U4', 'U5', 'U6']), link: trit(l[9] | 0, l[10] | 0), qt: trit(l[11] | 0, l[12] | 0) }; };

const which = process.argv[2] || 'desktop', maxC = +(process.argv[3] || 3e6);
const proto = MicroMachine.prototype, orig = proto.cycle;
const ABORTED = Symbol('aborted'); const COV = {}; let lastMachine = null, machines = 0; let n = 0, driven = 0, bad = 0, first = null, resetDone = false; const t0 = Date.now();
proto.cycle = function () {
  if (n >= maxC) return orig.call(this);
  const upc = this.upc, cf = this.cf, mu = this.cs.store[upc]; const prePriv = this.priv, preIe = this.ie;
  const regsBefore = regs(); const mmBefore = { A: this.A, B: this.B, link: this.link, qt: this.qt };
  this.lastBus = ABORTED; const res = orig.call(this); const aborted = this.lastBus === ABORTED;                                  // the microsim does the cycle; we learn its bus value
  const world = new Map(); for (let i = 0; i < 10; i++) world.set(`UA${i}`, (upc >> i) & 1); world.set('CLK', 0); world.set('RESET', 0); world.set('ABORT', aborted ? 1 : 0); if (aborted) COV.ABORT = (COV.ABORT || 0) + 1;
  world.set('PRIV', prePriv === 1 ? 1 : 0); world.set('IE', preIe === 1 ? 1 : 0);
  const cardDrives = mu.BUS === 'ALU' || mu.BUS === 'ESRV' || mu.BUS === 'ZERO' || ((!mu.BUS || mu.BUS === 'NONE') && mu.FLAGS && mu.FLAGS !== 'KEEP'); const checkBus = mu.BUS === 'ALU' || mu.BUS === 'ESRV' || mu.BUS === 'ZERO';
  if (!cardDrives) { const t = toT(this.lastBus === undefined || aborted ? 0 : this.lastBus, 27); t.forEach((x, k) => { const [p, q] = rails(x); world.set(`D${k}+`, p); world.set(`D${k}-`, q); }); }
  if (this !== lastMachine) { lastMachine = this; resetDone = false;           // a new machine (the boot script starts a second one): power-up the card again
    for (const ch of card.chips) if (ch.q) ch.q = []; machines++; }
  if (!resetDone) {                                             // power-up: RESET held for one cycle, no bus fight allowed
    const w0 = new Map(world); w0.set('RESET', 1); for (let k = 0; k < 27; k++) { w0.set(`D${k}+`, 0); w0.set(`D${k}-`, 0); }
    card.settle(w0); for (const ch of card.chips) if (ch.ref === 'U33' || ch.ref === 'U34') require('./parts.js').P.ALVCH16823.clock(ch, p => card.v.get(ch.pins[p]));
    resetDone = true; }
  // pipeline register first (clocked at the start of the cycle with this micro-address), then the datapath
  const pre = new Map(world); for (let k = 0; k < 27; k++) if (!pre.has(`D${k}+`)) { pre.set(`D${k}+`, 0); pre.set(`D${k}-`, 0); }   // before the edge: last cycle's word; the bus value doesn't matter yet
  card.settle(pre); for (const ch of card.chips) if (ch.ref === 'U33' || ch.ref === 'U34') { const g = p => card.v.get(ch.pins[p]); require('./parts.js').P.ALVCH16823.clock(ch, g); }
  const v = card.settle(world);
  const msgs = []; const cov = (k) => { COV[k] = (COV[k] || 0) + 1; };
  cov('SHIFT ' + (mu.SHIFT || 'NONE')); if (mu.B_BCAST) cov('BCAST'); if (mu.B_NEG === 'QT') cov('NEG=QT'); if (mu.WIDTH9) cov('WIDTH9'); if (mu.LD_QT) cov('LD_QT'); cov('CIN ' + (mu.CIN || '0')); cov('FN ' + (mu.ALU_FN || 'ADD'));
  if (!cardDrives && !aborted) for (let k = 0; k < 27; k++) if (v.get(`D${k}+`) !== world.get(`D${k}+`) || v.get(`D${k}-`) !== world.get(`D${k}-`)) { msgs.push('card drove the bus when BUS != ALU'); break; }
  // BTOPNZ (backplane, to Control): B's top trit nonzero, from B as it stands before this cycle's edge
  { const b26 = toT(mmBefore.B, 27)[26] !== 0 ? 1 : 0; if (v.get('BTOPNZ') !== b26) msgs.push(`BTOPNZ ${v.get('BTOPNZ')} vs ${b26}`); cov('BTOPNZ=' + b26); }
  if (checkBus && !aborted) { driven++; const out = fromNets(v, 'D'); if (out !== this.lastBus) msgs.push(`bus ${out} vs ${this.lastBus}`); }
  for (const ch of card.chips) if (ch.ref !== 'U33' && ch.ref !== 'U34') { const P = require('./parts.js').P[ch.part]; if (P.reg) P.clock(ch, p => v.get(ch.pins[p])); }
  const r = regs(); if (r.A !== this.A) msgs.push(`A ${r.A} vs ${this.A}`); if (r.B !== this.B) msgs.push(`B ${r.B} vs ${this.B}`);
  if (r.sf !== this.sf || r.cf !== this.cf || r.of !== this.of) msgs.push(`flags ${r.sf},${r.cf},${r.of} vs ${this.sf},${this.cf},${this.of}`);
  if (r.sh.join() !== this.shadow.join()) msgs.push(`shadow ${r.sh} vs ${this.shadow}`);
  if (r.link !== this.link) msgs.push(`link ${r.link} vs ${this.link}`); if (r.qt !== this.qt) msgs.push(`qt ${r.qt} vs ${this.qt}`);
  if (msgs.length) { bad++; if (!first) { first = `cycle ${n} upc ${upc} (${mu._r || ''}): ${msgs.join('; ')}`; if (process.env.DBG) console.log('DBG', JSON.stringify(mu), 'pre-cycle card', JSON.stringify(regsBefore), 'mm after A', this.A, 'B', this.B, 'cf', cf, 'link', this.link, 'mm before', JSON.stringify(mmBefore)); } if (bad > 20) { console.log('FIRST:', first); process.exit(1); } }
  n++; if (n % 200000 === 0) console.log(`  ${n.toLocaleString()} cycles, ${bad} mismatches, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return res;
};
const report = () => { const line = `ALU card vs microsim (${which}): ${n.toLocaleString()} microcycles, card drove the bus ${driven.toLocaleString()} times, ${machines} machine power-up(s), ${bad} mismatches${first ? '; first: ' + first : ''}`;
  console.log(line); console.log('coverage:', JSON.stringify(COV)); fs.appendFileSync(path.join(__dirname, 'RESULTS-alu-card.jsonl'), JSON.stringify({ date: new Date().toISOString(), which, mutant: process.env.ALU_MUTANT || null, cycles: n, driven, bad, first, cov: COV }) + '\n'); };
const realExit = process.exit; process.exit = (c) => { report(); realExit(bad ? 1 : 0); };
if (which === 'directed') require('./directed-alu.js');
else if (which === 'fetchfault') require('./directed-fetchfault.js');
else if (which === 'irqbm') require('./directed-irq-blockmove.js');
else if (which === 'random') { process.argv[2] = require(__dirname+'/../triton-dir.js')+'/triton3.html'; process.argv[3] = String(+(process.argv[4] || 150)); process.argv.length = 4; require('../microsim/diff.js'); }
else { process.argv[2] = require(__dirname+'/../triton-dir.js')+''; process.argv.length = 3; require(which === 'desktop' ? '../microsim/boot-desktop.js' : '../microsim/boot-tritos21.js'); }
report();
