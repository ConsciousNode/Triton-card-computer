// video-card-test.js: the Video card (stage 1, CPU side) beside the microsim (Kehai Interim, 2026-11-18). MIT.
// Per microcycle the card gets 4 slots of its 40 MHz clock (/CEDGE low in the last one: the CPU edge). J2 is played by
// the harness as the Memory card does it: VRAM-S in the Memory card's declared layout, preset from the machine's
// framebuffer, SO latched one slot after SA, a write at the slot edge while /SWR is low, and the CPU's own framebuffer
// writes landing too (VBUSY high in the second half of those cycles).
// Compared:
//   - BUS = IO after an IN to ports 2-5: the card drives exactly the microsim's ioData; after any other IN it stays off;
//   - every J2 write: an OUT 4 makes exactly one, at the pixel the microsim wrote, with its value; an OUT 5 makes one
//     per pixel of the fill (354,294 in T3, 59,049 in T2) and leaves VRAM-S equal to the microsim's framebuffer; no
//     write at any other time;
//   - READY: when it comes back, the answer (IN) is already in the card's register and the writes (OUT) are done;
//   - a full VRAM-S audit at the end.
// Declared: the card's registers start at the machine's values (X, Y, fill colour); the CPU waits on IORDY as long as
// the card needs (a fill is ~354k slots), where the microsim's stand-in latency is 10 microcycles: the extra cycles are
// counted ("extra wait") and the microsim is simply not stepped meanwhile.
'use strict';
const fs = require('fs'), path = require('path');
const { build, cardWord } = require('./video-card.js');
const V = require('./video-tables.js');
const { trit } = require('./netlist.js');
const { P } = require('./parts.js');
const { decodeWord } = require('../microsim/roms.js');
const { MicroMachine, WORD_BITS } = require('../microsim/microsim.js');
const ROMS = path.join(__dirname, '../roms');
const chips = Array.from({ length: Math.ceil(WORD_BITS / 8) }, (_, k) => fs.readFileSync(path.join(ROMS, `cs${k}.bin`)));
const cs = Buffer.alloc(1 << 19);
for (let w = 0; w < 1024; w++) { let b = 0n; for (let k = 0; k < chips.length; k++) b |= BigInt(chips[k][w]) << BigInt(8 * k); let mu; try { mu = decodeWord(b); } catch { continue; } cs[w] = cardWord(mu); }
const MUT = process.env.VID_MUTANT;
const toT = (v, n) => { const t = []; let x = v; for (let i = 0; i < n; i++) { let r = ((x % 3) + 3) % 3; if (r === 2) r = -1; t.push(r); x = (x - r) / 3; } return t; };
const decR = (b, n) => { let x = 0; for (let i = n - 1; i >= 0; i--) { const p = Math.floor(b / 2 ** (2 * i)) & 1, q = Math.floor(b / 2 ** (2 * i + 1)) & 1; if (p && q) return NaN; x = 3 * x + trit(p, q); } return x; };
const FB_BASE = V.FB_BASE, FB_SIZE = V.FB_SIZE;
// the layout, computed here independently of the card's tables
const sumT = (t, lo, hi) => { let r = 0; for (let i = hi - 1; i >= lo; i--) r = 3 * r + t[i]; return r; };
const fbLoc = p => { const t = toT(FB_BASE + p, 27); return (sumT(t, 10, 16) - 254) * 65536 + (sumT(t, 5, 10) + 128) * 256 + sumT(t, 0, 5) + 128; };
const LOC = new Int32Array(FB_SIZE); for (let p = 0; p < FB_SIZE; p++) LOC[p] = fbLoc(p);
let card = null; const chip = r => card.chips.find(c => c.ref === r);
const setBits = (ref, vals) => { const c = chip(ref); c.q = c.q || []; vals.forEach((b, i) => { c.q[(i < 9 ? 1 : 2) * 9 + (i % 9)] = b; }); };
const getBits = (ref, n) => { const c = chip(ref); return [...Array(n).keys()].map(i => ((c.q || [])[(i < 9 ? 1 : 2) * 9 + (i % 9)]) | 0); };
const num = bs => bs.reduce((a, b, i) => a + b * 2 ** i, 0);
const COV = {}; const cov = (k, d = 1) => { COV[k] = (COV[k] || 0) + d; };
let n = 0, bad = 0, first = null, lastMachine = null, machines = 0, vramS = null, SO = 0, extra = 0, drove = 0, lastInPort = -1;
let op = null;   // the I/O operation in flight: { kind, port, p, exp, writes: [] }
const which = process.argv[2] || 'directed', MAXC = +(process.argv[3] || 3e5);
const fail = msg => { bad++; if (!first) first = msg; if (bad > 20) { report(); reported = true; realExit(1); } };
const proto = MicroMachine.prototype, orig = proto.cycle;
function slot(w, cedge, vbusyHalf, msgs) {
  w.set('/CEDGE', cedge ? 0 : 1); w.set('VBUSY', vbusyHalf); for (let i = 0; i < 12; i++) w.set(`SO${i}`, (SO >> i) & 1);
  const v = card.settle(w);
  const sa = num([...Array(19).keys()].map(i => v.get(`SA${i}`))), soNext = vramS[sa];
  if (v.get('/SWR') === 0) { const si = num([...Array(12).keys()].map(i => v.get(`SI${i}`))); vramS[sa] = si;
    if (op) op.writes.push(sa); else msgs.push(`J2 write at ${sa} with no I/O operation in flight`); }
  for (const c of card.chips) if (P[c.part].reg && c.ref !== 'U2') P[c.part].clock(c, p => v.get(c.pins[p]));
  SO = soNext; return v;
}
function finishOp(m, msgs) {   // READY is back: everything the operation promised must be in place
  if (!op) return; const o = op; op = null;
  if (o.kind === 'IN') { const iod = decR(num(getBits('U52', 18)), 9); if (iod !== o.exp) msgs.push(`IN ${o.port}: answer ${iod} vs ${o.exp} when READY returned`); cov(`IN ${o.port}`); }
  if (o.kind === 'OUT' && o.port === 4) { if (o.writes.length !== 1 || o.writes[0] !== LOC[o.p]) msgs.push(`OUT 4: J2 writes ${JSON.stringify(o.writes.slice(0, 3))} vs one at ${LOC[o.p]} (pixel ${o.p})`);
    else if (decR(vramS[LOC[o.p]], 8) !== m.vram[o.p]) msgs.push(`OUT 4 pixel ${o.p}: ${decR(vramS[LOC[o.p]], 8)} vs ${m.vram[o.p]}`); cov('OUT 4 pixel'); }
  if (o.kind === 'OUT' && o.port === 5) { const N = m.mode === 0 ? 59049 : FB_SIZE; if (o.writes.length !== N) msgs.push(`fill: ${o.writes.length} J2 writes vs ${N}`);
    for (let p = 0; p < FB_SIZE; p++) if (decR(vramS[LOC[p]], 8) !== m.vram[p]) { msgs.push(`fill: pixel ${p} ${decR(vramS[LOC[p]], 8)} vs ${m.vram[p]}`); break; } cov(`fill T${m.mode ? 3 : 2}`); }
  if (o.kind === 'OUT' && o.writes.length && o.port !== 4 && o.port !== 5) msgs.push(`OUT ${o.port} wrote J2`);
}
let auditedAtStop = false;
const audit = m => { for (let p = 0; p < FB_SIZE; p++) if (decR(vramS[LOC[p]], 8) !== m.vram[p]) { bad++; if (!first) first = `audit: pixel ${p} ${decR(vramS[LOC[p]], 8)} vs ${m.vram[p]}`; break; } };
proto.cycle = function () {
  if (n >= MAXC) { if (!auditedAtStop && lastMachine) { auditedAtStop = true; audit(lastMachine); } return orig.call(this); }   // the workload runs on untracked
  if (this !== lastMachine) { lastMachine = this; machines++; op = null; lastInPort = -1;
    if (!card) { card = build(cs, MUT).check(); vramS = new Uint16Array(1 << 19); console.log('Video card (stage 1) BOM:', JSON.stringify(card.bom()), `= ${card.chips.length} chips`); if (MUT) console.log('MUTANT', MUT); }
    for (const c of card.chips) if (c.q) c.q = [];
    vramS.fill(0); for (let p = 0; p < FB_SIZE; p++) if (this.vram[p]) vramS[LOC[p]] = V.encRails(this.vram[p], 8); SO = 0;
    // declared preset: X, Y, the fill colour as the machine has them; no operation pending, /SWR high
    const io = this.io; setBits('U13', [...Array(10).keys()].map(i => (io.displayX >> i) & 1)); setBits('U14', [...Array(9).keys()].map(i => (io.displayY >> i) & 1));
    { const r = V.encRails(io.displayCmd || 0, 6); setBits('U16', [...Array(12).keys()].map(i => (r >> i) & 1)); }
    chip('U10').q = [0, 0, 0, 0, 1, 0, 0, 0, 0];
  }
  const mu = this.cs.store[this.upc], d = this.decode(), upc = this.upc, mode = this.mode;
  let fbWrite = false; const mw = this.memWrite; this.memWrite = function (a, v) { if (this.mode === 1 && a >= FB_BASE && a < FB_BASE + FB_SIZE) fbWrite = a - FB_BASE; return mw.call(this, a, v); };
  const exIn = mu.IO === 'IN' ? d.imm : null, exOut = mu.IO === 'OUT' ? d.imm : null;
  const pre = { x: this.io.displayX, y: this.io.displayY };
  const res = orig.call(this); delete this.memWrite;
  const msgs = [];
  const port = d.imm >= 0 && d.imm <= 62 ? d.imm : 63;
  const videoDrives = mu.BUS === 'IO' && lastInPort >= 2 && lastInPort <= 5;
  const w = new Map([['RESET', 0], ['MODE', mode]]); for (let i = 0; i < 10; i++) w.set(`UA${i}`, (upc >> i) & 1); for (let i = 0; i < 6; i++) w.set(`PORT${i}`, (port >> i) & 1);
  if (!videoDrives) toT(this.lastBus === undefined ? 0 : this.lastBus, 27).forEach((x, k) => { w.set(`D${k}+`, x === 1 ? 1 : 0); w.set(`D${k}-`, x === -1 ? 1 : 0); });
  try {
    { const pw = new Map(w); for (let k = 0; k < 27; k++) if (!pw.has(`D${k}+`)) { pw.set(`D${k}+`, 0); pw.set(`D${k}-`, 0); } pw.set('/CEDGE', 1); pw.set('VBUSY', 0); for (let i = 0; i < 12; i++) pw.set(`SO${i}`, (SO >> i) & 1);
      card.settle(pw); P.ALVCH16823.clock(chip('U2'), p => card.v.get(chip('U2').pins[p])); }
    if (exIn !== null) { lastInPort = exIn; if (exIn >= 2 && exIn <= 5) op = { kind: 'IN', port: exIn, exp: this.ioData, writes: [] }; }
    if (exOut !== null && exOut >= 2 && exOut <= 5) { const stride = mode === 0 ? 243 : 729; op = { kind: 'OUT', port: exOut, p: pre.y * stride + pre.x, writes: [] }; }
    for (let s = 0; s < 4; s++) { const v = slot(w, s === 3, fbWrite !== false && s >= 2 ? 1 : 0, msgs);
      if (s === 0 && videoDrives) { drove++; let x = 0; for (let k = 26; k >= 0; k--) x = 3 * x + trit(v.get(`D${k}+`), v.get(`D${k}-`)); if (x !== this.lastBus) msgs.push(`BUS=IO after IN ${lastInPort}: ${x} vs ${this.lastBus}`); }
      if (s === 0 && !videoDrives) for (let k = 0; k < 27; k++) if (v.get(`D${k}+`) !== w.get(`D${k}+`) || v.get(`D${k}-`) !== w.get(`D${k}-`)) { msgs.push('card drove the bus when it should not'); break; } }
    if (fbWrite !== false) { vramS[LOC[fbWrite]] = V.encRails(this.vram[fbWrite], 8); cov('CPU framebuffer write (VBUSY)'); }
    // the WAIT ends in the microsim now; the CPU really waits for READY
    if (mu.SEQ === 'WAIT' && this.upc !== upc) { let k = 0;
      while (card.v.get('READY') !== 1) { for (let s = 0; s < 4; s++) slot(w, s === 3, 0, msgs); k++; if (k > 200000) { msgs.push('READY never returned'); break; } }
      extra += k; if (k) cov('extra wait microcycles', k); finishOp(this, msgs); }
  } catch (e) { msgs.push('netlist stopped: ' + e.message); }
  if (msgs.length) fail(`cycle ${n} upc ${upc} (${mu._r || ''}) T${mode ? 3 : 2}: ${msgs.join('; ')}`);
  n++; return res;
};
function report() { if (lastMachine && !reported && !auditedAtStop) audit(lastMachine);
  const line = `Video card vs microsim (${which}): ${n.toLocaleString()} microcycles (+${extra.toLocaleString()} extra wait), drove BUS=IO ${drove} times, ${machines} machine power-up(s), ${bad} mismatches${first ? '; first: ' + first : ''}`;
  console.log(line); console.log('coverage:', JSON.stringify(COV)); fs.appendFileSync(path.join(__dirname, 'RESULTS-video-card.jsonl'), JSON.stringify({ date: new Date().toISOString(), stage: 1, which, mutant: MUT || null, cycles: n, extra, drove, bad, first, cov: COV }) + '\n'); }
const realExit = process.exit; let reported = false; process.exit = c => { if (!reported) { report(); reported = true; } realExit(bad ? 1 : 0); };
const W = { directed: './directed-video.js', fb: './directed-fb.js', prot: './directed-prot.js', spr: './directed-spr.js' };
if (W[which]) require(W[which]);
else if (which === 'random') { process.argv[2] = require(__dirname+'/../triton-dir.js')+'/triton3.html'; process.argv[3] = String(+(process.argv[4] || 100)); process.argv.length = 4; require('../microsim/diff.js'); }
else { process.argv[2] = require(__dirname+'/../triton-dir.js')+''; process.argv.length = 3; require(which === 'desktop' ? '../microsim/boot-desktop.js' : '../microsim/boot-tritos21.js'); }
if (!reported) { report(); reported = true; }
