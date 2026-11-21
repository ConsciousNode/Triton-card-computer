'use strict';
// timing-sim.js: a worst-case gate-level timing simulation of the composed card computer (Kehai Interim, 2026-11-20).
// MIT. The dynamic half of the timing story; sta.js (table mode) is the static, conservative half.
//
// Each 25 ns slot is replayed with delays, as a gate-level simulator with worst-case (max) delays would:
//   - start from the previous slot's settled values;
//   - SCLK rises at 25 j and falls at 25 j + 12.5; every chip is evaluated when one of its inputs changes, and its
//     outputs change after that part's max delay for the input that changed (transport delay: a newer evaluation
//     cancels anything it scheduled later than its own result);
//   - a register's outputs change tco after its own clock net rises in this simulation (so CLK, which is SCLK through
//     the '08 gate, launches that gate's delay late: the clock lag is modelled, not assumed);
//   - register state comes from machine-sim.js (it already clocked this slot); this file only decides WHEN things
//     change. After the slot, every net must have reached the value machine-sim settled to: that is checked, and any
//     difference is counted and reported (a self-test of the delay model's plumbing).
// Endpoints: every pin a register's clock() reads, for registers whose clock rises at the start of the next slot
// (SCLK registers every slot; CLK registers after the /CEDGE slot). Arrival = the time of the net's last change in
// this slot, glitches included. Required = that register's next clock rise minus its setup time.
// Limits: max delays only (no hold check, which needs min delays); SRAM writes inside the slot are not timed (their
// contents are already the slot's final contents); wiring and loading not included; delays as in sta.js (several not
// re-verified against datasheets in this session).
const path = require('path'); const { P } = require(path.join(__dirname, '../cards/parts.js'));
const { T, delay } = require('./sta.js');
const CK = { LVC74: ['1CLK', '2CLK'], ALVCH16823: ['1CLK', '2CLK'], LVC161: ['CP', 'CLK'], LVC574: ['CLK'], LVC164: ['CLK'], LV164: ['CLK'], LVC165: ['CLK'] };
const SL = 25;

class Heap { constructor() { this.a = []; } push(e) { const a = this.a; a.push(e); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p].t <= e.t) break; a[i] = a[p]; i = p; } a[i] = e; }
  pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { let i = 0; for (;;) { let l = 2 * i + 1, r = l + 1, m = i; if (l < a.length && a[l].t < (m === i ? last.t : a[m].t)) m = l;
    if (r < a.length && a[r].t < (m === i ? last.t : a[m].t)) m = r; if (m === i) break; a[i] = a[m]; i = m; } a[i] = last; } return top; } get size() { return this.a.length; } }

class TimingSim {
  constructor(m, { scale = {} } = {}) {
    this.m = m; this.scale = scale; this.worst = new Map(); this.slots = 0; this.cycles = 0; this.mismatch = 0; this.mismatchEx = []; this.lag = {};
    this.fan = new Map(); this.drv = new Map();
    for (const c of m.chips) { c._outs = new Set(P[c.part].out); const ck = CK[c.part] ? new Set(CK[c.part]) : new Set();
      for (const [p, n] of Object.entries(c.pins)) { if (n === 'GND' || n === 'VCC') continue;
        if (c._outs.has(p)) { if (!this.drv.has(n)) this.drv.set(n, []); this.drv.get(n).push([c, p]); }
        if (!c._outs.has(p) || c.part === 'LVC245') { if (!this.fan.has(n)) this.fan.set(n, []); this.fan.get(n).push([c, p, ck.has(p)]); } } }
    this.regs = m.chips.filter(c => P[c.part].reg);
    this.clockNet = new Map(); for (const c of this.regs) this.clockNet.set(c, CK[c.part].map(k => c.pins[k]).filter(n => n && n !== 'GND'));
    this.clockNets = new Set([...this.clockNet.values()].flat());
    // writable SRAMs: a write is the window where /WE and /CE are both low; it ends when either rises
    this.wnet = new Map(); this.wopen = new Map(); this.wsram = m.chips.filter(c => P[c.part].write && c.pins['/WE'] !== 'VCC');
    for (const c of this.wsram) for (const k of ['/WE', '/CE']) { const n = c.pins[k]; if (!n || n === 'GND') continue; if (!this.wnet.has(n)) this.wnet.set(n, []); this.wnet.get(n).push(c); }
    this.wworst = new Map(); this.writes = 0; this.glitch = new Map(); this.abs = new Map();
    this.wpins = new Set(); for (const c of this.wsram) for (const [p, n] of Object.entries(c.pins)) if (/^(IO|A)\d+$/.test(p)) this.wpins.add(n);
  }
  d(part, pin) { return delay(part, pin) * (this.scale[part] || 1); }
  tco(c) { return T[c.part].tco * (this.scale[c.part] || 1); }
  // prev: settled values at the end of the previous slot; cur: settled values at the end of this one
  analyze(prev, cur, upc, { j = 3, last = true } = {}) {
    this.slots++; if (last) this.cycles++;
    if (j === 0) { this.base = (this.base ?? -SL * 4) + SL * (this.nPrev || 4); } this.nPrev = j + 1;   // absolute time of this microcycle's CPU edge
    const val = new Map(prev), dv = new Map(), pend = new Map(), arr = new Map(), pred = new Map(), hist = new Map(), windows = []; const q = new Heap(); let seq = 0;
    const key = (c, p) => c.ref + '|' + p;
    // driver values consistent with prev: evaluate every chip once on prev
    // an output the model doesn't write this time (a '245 that is off, or its A side while it drives B) is released
    const evalChip = (c, get) => { const o = {}; for (const p of c._outs) if (c.pins[p]) o[p] = { x: 'Z', weak: false };
      P[c.part].eval(c, get, (pin, x, weak) => { o[pin] = { x, weak: !!weak }; }, pin => get(pin, true)); return o; };
    const g0 = c => (pin, z) => { const x = prev.get(c.pins[pin]); return x === undefined || x === 'Z' ? (z ? 'Z' : 0) : x; };
    for (const c of this.m.chips) { if (P[c.part].reg) continue; const o = evalChip(c, g0(c)); for (const [p, r] of Object.entries(o)) if (c.pins[p]) dv.set(key(c, p), r); }
    for (const c of this.regs) { for (const p of c._outs) if (c.pins[p]) { const x = prev.get(c.pins[p]); dv.set(key(c, p), { x: x === undefined ? 'Z' : x, weak: false }); } }
    const netVal = n => { const ds = this.drv.get(n); if (!ds) return val.get(n); let weakX;
      for (const [c, p] of ds) { const r = dv.get(key(c, p)); if (!r || r.x === 'Z') continue; if (!r.weak) return r.x; weakX = r.x; }
      return weakX !== undefined ? weakX : 'Z'; };
    const schedule = (t, c, p, x, weak, why) => { const k = key(c, p); const lst = pend.get(k) || []; for (const e of lst) if (e.t >= t) e.dead = true;
      const e = { t, kind: 'drv', c, p, x, weak, why, s: seq++ }; lst.push(e); pend.set(k, lst.filter(z => !z.dead)); q.push(e); };
    const world = (t, n, x) => q.push({ t, kind: 'world', n, x, s: seq++ });
    world(SL * j, 'SCLK', 1); world(SL * j + SL / 2, 'SCLK', 0);
    let guard = 0;
    while (q.size) { const e = q.pop(); if (e.dead) continue; if (++guard > 2e6) throw new Error('timing-sim: no quiescence');
      let n, before, after;
      if (e.kind === 'world') { n = e.n; before = val.get(n); val.set(n, e.x); after = e.x; }
      else { const k = key(e.c, e.p); const cur0 = dv.get(k); if (cur0 && cur0.x === e.x && cur0.weak === e.weak) continue; dv.set(k, { x: e.x, weak: e.weak });
        n = e.c.pins[e.p]; before = val.get(n); after = netVal(n); val.set(n, after); }
      if (before === after) continue;
      arr.set(n, e.t); pred.set(n, e.why || null); if (!hist.has(n)) hist.set(n, []); hist.get(n).push([e.t, after, e.why || null]);
      for (const c of this.wnet.get(n) || []) { const on = val.get(c.pins['/WE']) === 0 && (c.pins['/CE'] === 'GND' || val.get(c.pins['/CE']) === 0);
        if (on && !this.wopen.has(c)) this.wopen.set(c, this.base + e.t); else if (!on && this.wopen.has(c)) { windows.push([c, this.wopen.get(c), this.base + e.t, upc, j]); this.wopen.delete(c); } }
      if (before === 0 && after === 1 && this.clockNets.has(n)) { const l = e.t - SL * j; if (l >= 0 && l < SL / 2 && (!(n in this.lag) || l > this.lag[n])) this.lag[n] = l; }
      for (const [c, p, isClk] of this.fan.get(n) || []) {
        if (P[c.part].reg) {
          if (isClk) { if (before === 0 && after === 1) { // its state is machine-sim's: outputs move tco later
              // a part with two clocks ('74, '16823 halves): only the outputs of the half whose clock rose
              const half = c.part === 'LVC74' || c.part === 'ALVCH16823' ? p[0] : null;
              const o = evalChip(c, (pin, z) => { const x = val.get(c.pins[pin]); return x === undefined || x === 'Z' ? (z ? 'Z' : 0) : x; });
              for (const [op, r] of Object.entries(o)) if (c.pins[op] && (!half || op[0] === half)) schedule(e.t + this.tco(c), c, op, r.x, false, [c.ref, p, n, e.t]); } continue; }
          // /OE (three-state registers) or an async clear: outputs follow
          const o = evalChip(c, (pin, z) => { const x = val.get(c.pins[pin]); return x === undefined || x === 'Z' ? (z ? 'Z' : 0) : x; });
          const dl = /OE/.test(p) ? (T[c.part].oe || this.tco(c)) : this.tco(c);
          for (const [op, r] of Object.entries(o)) if (c.pins[op]) schedule(e.t + dl, c, op, r.x, false, [c.ref, p, n, e.t]); continue; }
        if (c._outs.has(p) && c.part !== 'LVC245') continue;
        const o = evalChip(c, (pin, z) => { const x = val.get(c.pins[pin]); return x === undefined || x === 'Z' ? (z ? 'Z' : 0) : x; });
        const dl = this.d(c.part, p);
        for (const [op, r] of Object.entries(o)) { if (!c.pins[op]) continue; const k = key(c, op), lst = pend.get(k), lastSched = lst && lst.length ? lst[lst.length - 1] : null;
          const will = lastSched && !lastSched.dead ? lastSched : dv.get(k); if (will && will.x === r.x && !!will.weak === r.weak) continue;
          schedule(r.weak ? e.t : e.t + dl, c, op, r.x, r.weak, [c.ref, p, n, e.t]); } }
    }
    if (process.env.TSIM_WATCH) { const w = process.env.TSIM_WATCH.split(','); const ch = w.filter(n => hist.has(n)).map(n => `${n}:${hist.get(n).map(z => z[0].toFixed(1) + '=' + z[1]).join('/')}`);
      if (ch.length) console.log(`WATCH µword ${upc} slot ${j}: ${ch.join(' ')}`); }
    // the microcycle's history: every slot's changes, in absolute time from the CPU edge (CLK captures need it: what
    // the CPU edge launched usually settles slots before the next edge)
    if (j === 0 || !this.cyc) this.cyc = new Map();
    for (const [n, h] of hist) { if (!this.cyc.has(n)) this.cyc.set(n, []); this.cyc.get(n).push(...h);
      if (this.wpins.has(n)) { if (!this.abs.has(n)) this.abs.set(n, []); const a = this.abs.get(n); for (const z of h) a.push([this.base + z[0], z[1], z[2] && [...z[2].slice(0, 3), this.base + z[2][3]]]);
        while (a.length > 1 && a[1][0] < this.base - 250) a.shift(); } }
    // SRAM writes that ended in this slot: data must be still for tDW before the end (5 ns), the address for the whole
    // window and tAW (8 ns) before its end (IS61WV 10 ns parts; Kehai's reading, not re-verified here)
    for (const [c, t0, t1, wu, wj] of windows) {
      // a window narrower than 1 ns is not a write the part would take: it is two edges of /WE (or /CE) racing in a
      // max-delay simulation. On a board, delay spread could make it a real runt pulse: a write-enable glitch. Listed.
      if (t1 - t0 < 1) { const k = c.ref; const g = this.glitch.get(k) || { k, n: 0, at: [] }; g.n++; if (g.at.length < 3) g.at.push(`µword ${wu} slot ${wj} at ${(t0 - this.base).toFixed(1)}`); this.glitch.set(k, g); continue; }
      this.writes++;
      for (const [pin, n] of Object.entries(c.pins)) { const isD = /^IO\d+$/.test(pin), isA = /^A\d+$/.test(pin); if (!(isD || isA) || n === 'GND' || n === 'VCC') continue;
        const h = this.abs.get(n); if (!h) continue; const lastBefore = h.filter(z => z[0] <= t1).pop(); if (!lastBefore) continue;
        const need = isD ? t1 - 5 : Math.min(t0, t1 - 8), slack = need - lastBefore[0], k = `${c.ref}.${isD ? 'data' : 'addr'}`, w = this.wworst.get(k);
        // times reported relative to the CPU edge of the microcycle the window ended in
        if (!w || slack < w.slack) this.wworst.set(k, { k, slack, arr: lastBefore[0] - this.base, req: need - this.base, start: t0 - this.base, end: t1 - this.base, net: n, upc: wu, slot: wj, path: this.trace(this.abs, n, lastBefore[0]).map(x => x.replace(/@(-?[\d.]+)/g, (m0, t) => '@' + (+t - this.base).toFixed(1))) }); } }
    // the self-test: every net where machine-sim settled
    let mis = 0; for (const [n, x] of cur) { const y = val.get(n); if (y !== x && !(y === undefined && x === 'Z')) { mis++; if (this.mismatchEx.length < 8) this.mismatchEx.push(`${n}: ${y} vs ${x} (slot ${j}, µword ${upc})`);
      if (process.env.TSIM_DEBUG && this.mismatchEx.length <= 2) console.log('DEBUG', n, 'drivers', (this.drv.get(n) || []).map(([c, p]) => `${c.ref}.${p}=${JSON.stringify(dv.get(key(c, p)))}`).join(' '), 'hist', JSON.stringify(hist.get(n))); } }
    this.mismatch += mis; this.mismatchSlots = (this.mismatchSlots || 0) + (mis ? 1 : 0);
    // endpoints
    for (const c of this.regs) { const ck = this.clockNet.get(c)[0]; if (ck !== 'SCLK' && !(ck === 'CLK' && last)) continue;
      const reads = new Set(); const probe = Object.create(c); probe.q = Array.isArray(c.q) ? c.q.slice() : c.q;
      try { P[c.part].clock(probe, pin => { reads.add(pin); return cur.get(c.pins[pin]) ?? 0; }); } catch (e) { }
      const su0 = T[c.part].su, lag = this.lag[ck] || 0;
      for (const pin of reads) { if (CK[c.part].includes(pin) || /CLR|PRE|MR/.test(pin)) continue; const n = c.pins[pin]; const h = this.cyc.get(n); if (!h) continue;
        const a = h[h.length - 1][0]; if (ck === 'SCLK' && a <= SL * j) continue;   // an SCLK register: changes since its last edge
        const su = /CLKEN|\/LD|EN[PT]/.test(pin) && T[c.part].suEn ? T[c.part].suEn : su0;
        const req = SL * (j + 1) + lag - su, slack = req - a, k = `${c.ref}.${pin}`, w = this.worst.get(k);
        if (!w || slack < w.slack) this.worst.set(k, { slack, arr: a, req, capture: ck, net: n, upc, slot: j, path: this.trace(this.cyc, n) }); } }
  }
  // the chain of changes back from n's last change, oldest first: "net@time -(chip.pin)-> net@time ..."; each step
  // follows the input change that actually triggered the output change (by its time)
  trace(hist, n, at) { let h = hist.get(n); if (!h) return [n]; let ev = at === undefined ? h[h.length - 1] : h.filter(z => z[0] <= at).pop(); const out = [`${n}@${ev[0].toFixed(1)}`]; let k = 0;
    while (ev && ev[2] && k++ < 60) { const [ref, pin, inN, tIn] = ev[2]; out.unshift(`${inN}@${tIn.toFixed(1)} -(${ref}.${pin})->`);
      const hi = hist.get(inN); ev = hi && hi.find(z => z[0] === tIn); }
    return out; }
  report() { return [...this.worst.entries()].map(([k, w]) => ({ k, ...w })).sort((a, b) => a.slack - b.slack); }
  writeReport() { return [...this.wworst.values()].sort((a, b) => a.slack - b.slack); }
}
module.exports = { TimingSim };
