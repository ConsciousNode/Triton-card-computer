// netlist.js: a chip-level netlist and a functional simulator for it (Kehai Interim, 2026-11-18). MIT.
// A card is a list of chips (refdes, part, pin -> net). Nets hold 0/1. The simulator evaluates register outputs first,
// then the other chips, repeating passes until nothing changes; it refuses to continue if two drivers fight on a net, if
// a pin still reads a net nothing drives once everything else has settled, or if the netlist never settles.
'use strict';
const { P } = require('./parts.js');
class Card {
  constructor(name) { this.name = name; this.chips = []; this.inputs = new Set(['GND', 'VCC']); }
  add(ref, part, pins, extra = {}) { if (!P[part]) throw new Error(`no model for ${part}`);
    // 2026-11-22: designators must be unique (the ALU had two U120s; the simulator never minded, a PCB cannot)
    if (this.chips.some(c => c.ref === ref)) throw new Error(`duplicate designator ${ref} (${part})`); this.chips.push({ ref, part, pins, ...extra }); return this; }
  input(...nets) { for (const n of nets) this.inputs.add(n); }
  check() {                                     // static: every pin's net has a driver or is a card input
    const drivers = new Map();
    for (const c of this.chips) for (const o of P[c.part].out) { const n = c.pins[o]; if (!n) continue;
      if (!drivers.has(n)) drivers.set(n, []); drivers.get(n).push(c.ref);
      if (drivers.get(n).length > 1 && !P[c.part].tri && !P[c.part].weak && !drivers.get(n).every(r => P[this.chips.find(x => x.ref === r).part].tri || P[this.chips.find(x => x.ref === r).part].weak)) throw new Error(`net ${n} has several non-3-state drivers`); }
    for (const c of this.chips) for (const [pin, n] of Object.entries(c.pins))
      if (!P[c.part].out.includes(pin) && !drivers.has(n) && !this.inputs.has(n)) throw new Error(`${c.ref}.${pin}: net ${n} has no driver`);
    this.drivers = drivers; return this;
  }
  // settle(): the fast version by default (2026-11-21, integration stage 4); SETTLE=slow runs the original, and
  // SETTLE=check runs both on every call and throws on the first difference (values, presence, or error).
  // 2026-11-21 (stage 4 step 2): the default is now the event-driven settle. SETTLE=fast runs the compiled full-pass
  // settle, SETTLE=check compares event vs fast on every call, SETTLE=checkslow compares fast vs slow (the old check).
  settle(world) {
    const mode = process.env.SETTLE || 'event';
    if (mode === 'slow') return this.settleSlow(world);
    if (mode === 'fast') return this.settleFast(world);
    if (mode === 'check') return this.settleCheckEvent(world);
    if (mode !== 'checkslow') return this.settleEvent(world);
    const snap = this.chips.map(c => [c.q === undefined ? undefined : JSON.stringify(c.q), c.a, c.b]);
    let ef = null, rf = null; try { rf = this.settleFast(world); } catch (e) { ef = e.message; }
    const after = this.chips.map(c => [c.q === undefined ? undefined : JSON.stringify(c.q), c.a, c.b]);
    this.chips.forEach((c, i) => { if (snap[i][0] !== undefined) c.q = JSON.parse(snap[i][0]); else delete c.q; if (snap[i][1] !== undefined) c.a = snap[i][1]; if (snap[i][2] !== undefined) c.b = snap[i][2]; });
    let es = null, rs = null; try { rs = this.settleSlow(world); } catch (e) { es = e.message; }
    const after2 = this.chips.map(c => [c.q === undefined ? undefined : JSON.stringify(c.q), c.a, c.b]);
    if (ef !== es) throw new Error(`SETTLE=check: errors differ: fast ${ef} / slow ${es}`);
    if (JSON.stringify(after) !== JSON.stringify(after2)) throw new Error('SETTLE=check: async state differs');
    if (rs) { if (rs.size !== rf.size) throw new Error(`SETTLE=check: ${rf.size} nets vs ${rs.size}`); for (const [k, x] of rs) if (rf.get(k) !== x) throw new Error(`SETTLE=check: ${k} fast ${rf.get(k)} slow ${x}`); }
    this.settleChecks = (this.settleChecks || 0) + 1;
    if (es) throw new Error(es); return rs;
  }
  // The same algorithm as settleSlow, pass for pass and chip for chip, on integer net ids and typed arrays instead of a
  // new Map per pass. Values: 0, 1, Z = 2, absent = 3.
  _fastIds() {
    const order = this.order || (this.order = [...this.chips.filter(c => P[c.part].reg), ...this.chips.filter(c => P[c.part].weak), ...this.chips.filter(c => !P[c.part].reg && !P[c.part].weak)]);
    let F = this._fast;
    if (!F || F.order !== order || F.nChips !== this.chips.length) {
      const id = new Map(), names = []; const nid = n => { let k = id.get(n); if (k === undefined) { k = names.length; id.set(n, k); names.push(n); } return k; };
      nid('GND'); nid('VCC');
      const chips = order.map((c, ci) => { const pid = {}; for (const [pin, n] of Object.entries(c.pins)) if (n !== undefined) pid[pin] = nid(n); return { c, ci, pid }; });
      F = this._fast = { order, nChips: this.chips.length, id, names, chips, nid };
    }
    return F;
  }
  // ---- the event-driven settle (Kehai Interim, 2026-11-21, integration stage 4 step 2)
  // It keeps every net's settled value between calls and re-evaluates only the chips that could have changed: every
  // chip whose state can change between calls (flip-flops and counters, edge-counted parts, and SRAMs whose /WE isn't
  // tied to VCC), and every chip reading a net whose value changed. Each driven pin holds its last contribution (strong
  // 0/1, weak 0/1 or none), and a net's value is resolved from its drivers the way one pass of settleFast resolves it:
  // strong beats the world, the world beats a resistor, and a resistor beats nothing.
  // It reaches a fixed point of the same equations settleFast solves, so wherever that fixed point is unique (no
  // combinational loop with two stable states) the result is the same. SETTLE=check proves it run by run. Any error
  // (an undriven read, a bus fight, weak contention, no settling) restores the async state and hands the whole call to
  // settleFast, so error messages are settleFast's own, word for word.
  // Assumption, declared: a table SRAM with /WE tied to VCC only changes its contents before the first settle (or the
  // caller calls invalidate()). Nothing in the machine can write it, so only a harness could.
  invalidate() { if (this._ev) this._ev.all = true; }
  // the settled value of a net after a live settleEvent: 0, 1, 'Z' or undefined (nothing drives it)
  liveGet(n) { const E = this._ev, i = E.F.id.get(n); if (i === undefined) return undefined; const x = E.val[i]; return x === 2 ? 'Z' : x === 3 ? undefined : x; }
  liveId(n) { return this._ev.F.id.get(n); }
  _eventBuild() {
    const F = this._fastIds(), { chips, names } = F; const nC = chips.length;
    const slotOf = [], slotNet = [], netDrv = [], netRd = [];
    const ensure = i => { while (netDrv.length <= i) { netDrv.push([]); netRd.push([]); } };
    for (const ch of chips) { const so = {}, pp = P[ch.c.part];
      for (const pin of pp.out) { const i = ch.pid[pin]; if (i === undefined) continue; so[pin] = slotNet.length; ensure(i); netDrv[i].push(slotNet.length); slotNet.push(i); }
      slotOf.push(so);
      const rd = new Set(Object.values(ch.pid)); for (const i of rd) { ensure(i); netRd[i].push(ch.ci); } }
    const slotChip = new Int32Array(slotNet.length); chips.forEach((ch, ci) => { for (const k of Object.values(slotOf[ci])) slotChip[k] = ci; });
    const stateful = new Uint8Array(nC);
    chips.forEach((ch, ci) => { const pp = P[ch.c.part]; if (pp.reg || pp.edges || pp.async || (pp.write && ch.c.pins['/WE'] !== 'VCC')) stateful[ci] = 1; });
    // a chip may drive one net from two pins ('245 A pins tied to GND, the '07's two gates on IORDY); settleFast keeps that
    // chip's last write, so resolve() hands any disagreement between them to settleFast (bad = 4)
    const asyncCi = chips.filter(ch => P[ch.c.part].async).map(ch => ch.ci);
    return this._ev = { F, nC, nNets: names.length, slotOf, slotList: slotOf.map(o => Object.values(o)), slotNet: Int32Array.from(slotNet), slotChip, netDrv, netRd, stateful, asyncCi,
      contrib: new Int8Array(slotNet.length).fill(2), val: null, base: null, baseHas: null, miss: new Uint8Array(nC), missMsg: new Array(nC), all: true,
      queued: new Uint8Array(nC), evals: 0, calls: 0 };
  }
  settleEvent(world) {
    const F = this._fastIds(); let E = this._ev;
    if (!E || E.F !== F) E = this._eventBuild();
    const { id, names, chips, nid } = F; const Z = 2, A = 3;
    for (const k of world.keys()) nid(k); if (this.defaults) for (const k of this.defaults.keys()) nid(k);
    const N = names.length;
    if (N !== E.nNets) { for (let i = E.nNets; i < N; i++) { E.netDrv.push([]); E.netRd.push([]); } E.nNets = N; E.all = true; }
    const enc = x => x === 'Z' ? Z : x === undefined ? A : x, dec = x => x === Z ? 'Z' : x === A ? undefined : x;
    const base = new Int8Array(N).fill(A), baseHas = new Uint8Array(N);
    for (const [k, x] of world) { const i = id.get(k); base[i] = enc(x); baseHas[i] = 1; }
    base[id.get('GND')] = 0; base[id.get('VCC')] = 1; baseHas[id.get('GND')] = 1; baseHas[id.get('VCC')] = 1;
    if (this.defaults) for (const [k, x] of this.defaults) { const i = id.get(k); if (!baseHas[i]) { base[i] = enc(x); baseHas[i] = 1; } }
    const { contrib, slotOf, slotList, slotNet, netDrv, netRd, stateful, miss, missMsg, queued, slotChip } = E;
    // a net's value from its drivers (as one settled pass of settleFast resolves it); bad: 1 fight, 2 weak contention
    let bad = 0;
    const resolve = i => { let strong = -1, sc = -1, weak = -1, wdis = false; const ds = netDrv[i];
      for (let j = 0; j < ds.length; j++) { const x = contrib[ds[j]];
        if (x < 2) { if (strong < 0) { strong = x; sc = slotChip[ds[j]]; } else if (slotChip[ds[j]] !== sc) bad |= 1; else if (x !== strong) bad |= 4; }
        else if (x >= 4) { const w = x - 4; if (weak < 0) weak = w; else if (w !== weak) wdis = true; } }
      if (strong >= 0) return strong;
      if (baseHas[i] && base[i] !== Z) return base[i];
      if (weak >= 0) { if (wdis) bad |= 2; return weak; }
      return base[i]; };
    const queue = []; let qh = 0; const push = ci => { if (!queued[ci]) { queued[ci] = 1; queue.push(ci); } };
    let val = E.val;
    if (E.all || !val) { val = E.val = base.slice(); contrib.fill(2); miss.fill(0); for (let ci = 0; ci < E.nC; ci++) push(ci); E.all = false; }
    else { const ob = E.base, oh = E.baseHas;
      if (process.env.EVENT_MUTANT !== 'no-stateful') for (let ci = 0; ci < E.nC; ci++) if (stateful[ci]) push(ci);   // EVENT_MUTANT: positive control for SETTLE=check
      for (let i = 0; i < N; i++) if (base[i] !== ob[i] || baseHas[i] !== oh[i]) { const nv = resolve(i); if (nv !== val[i]) { val[i] = nv; for (const r of netRd[i]) push(r); } } }
    E.base = base; E.baseHas = baseHas;
    let cur = null, curCi = -1;
    const g = pin => { const i = cur.pid[pin]; if (i === undefined) throw new Error(`${cur.c.ref}: pin ${pin} unconnected`);
      const x = val[i]; if (x === A || x === Z) { if (!miss[curCi]) { miss[curCi] = 1; missMsg[curCi] = `${cur.c.ref}.${pin}: net ${names[i]} undriven`; } return 0; } return x; };
    const gz = pin => { const i = cur.pid[pin]; if (i === undefined) return 'Z'; const x = val[i]; return x === A || x === Z ? 'Z' : x; };
    let so = null; const touched = [];
    const s = (pin, x, weak) => { const k = so[pin]; if (k === undefined) { if (cur.pid[pin] === undefined) return; throw new Error(`event settle: ${cur.c.ref} drives ${pin}, which isn't in its part's out list`); }
      if (x === 'Z') return; contrib[k] = weak ? 4 + x : x; };
    const old = [];
    const limit = 64 * E.nC + 1000; let evals = 0, giveUp = null;
    const run = () => { while (qh < queue.length) { const ci = queue[qh++]; queued[ci] = 0; if (++evals > limit) { giveUp = 'no settle'; for (let j = qh; j < queue.length; j++) queued[queue[j]] = 0; queue.length = 0; qh = 0; return; }
        cur = chips[ci]; curCi = ci; so = slotOf[ci]; miss[ci] = 0;
        const ks = slotList[ci]; for (let j = 0; j < ks.length; j++) { old[j] = contrib[ks[j]]; contrib[ks[j]] = 2; }
        P[cur.c.part].eval(cur.c, g, s, gz);
        for (let j = 0; j < ks.length; j++) if (contrib[ks[j]] !== old[j]) { const i = slotNet[ks[j]]; const nv = resolve(i); if (nv !== val[i]) { val[i] = nv; const rs = netRd[i]; for (let r = 0; r < rs.length; r++) push(rs[r]); } } }
      queue.length = 0; qh = 0; };
    const asyncChips = E.asyncCi.map(ci => chips[ci].c);
    const snap = asyncChips.map(c => [Array.isArray(c.q) ? c.q.slice() : c.q, c.a, c.b, 'q' in c, 'a' in c, 'b' in c]);
    const fallback = () => { asyncChips.forEach((c, j) => { const [q, a, b, hq, ha, hb] = snap[j]; if (hq) c.q = q; else delete c.q; if (ha) c.a = a; else delete c.a; if (hb) c.b = b; else delete c.b; });
      E.all = true; queued.fill(0); queue.length = 0; qh = 0; E.fallbacks = (E.fallbacks || 0) + 1; return this.settleFast(world); };
    try { run(); } catch (e) { return fallback(); }
    if (giveUp) return fallback();
    const anyMiss = () => { for (let ci = 0; ci < E.nC; ci++) if (miss[ci]) return true; return false; };
    if (anyMiss()) return fallback();
    for (let r = 0; r < 4; r++) { let chg = false;
      for (const ci of E.asyncCi) { const c = chips[ci].c; if (P[c.part].async(c, pin => { const i = id.get(c.pins[pin]); return i === undefined ? undefined : dec(val[i]); })) { chg = true; push(ci); } }
      if (!chg) break; try { run(); } catch (e) { return fallback(); } if (giveUp || anyMiss()) return fallback(); }
    // fights and contention are judged on the settled values: re-resolve every driven net once
    bad = 0; for (let i = 0; i < N; i++) if (netDrv[i].length) resolve(i);
    if (bad) return fallback();
    E.evals += evals; E.calls++;
    // live mode (jpusb/crosscheck.js): no result Map; read values with liveGet(net) until the next settle
    if (this.live) { this.v = null; return null; }
    const out = new Map(); for (let i = 0; i < N; i++) if (val[i] !== A) out.set(names[i], dec(val[i]));
    this.v = out; return out;
  }
  // SETTLE=check: the event settle and settleFast on every call, from the same chip state; throws on any difference
  settleCheckEvent(world) {
    const keyOf = c => [Array.isArray(c.q) ? JSON.stringify(c.q) : c.q, c.a, c.b, c.r];
    const snap = this.chips.map(keyOf), saved = this.chips.map(c => [Array.isArray(c.q) ? c.q.slice() : c.q, c.a, c.b, c.r, 'q' in c, 'a' in c, 'b' in c, 'r' in c]);
    let ee = null, re = null; try { re = this.settleEvent(world); } catch (e) { ee = e.message; }
    const afterE = JSON.stringify(this.chips.map(keyOf));
    this.chips.forEach((c, i) => { const [q, a, b, r, hq, ha, hb, hr] = saved[i]; if (hq) c.q = Array.isArray(q) ? q.slice() : q; else delete c.q; if (ha) c.a = a; else delete c.a; if (hb) c.b = b; else delete c.b; if (hr) c.r = r; else delete c.r; });
    let ef = null, rf = null; try { rf = this.settleFast(world); } catch (e) { ef = e.message; }
    const afterF = JSON.stringify(this.chips.map(keyOf));
    if (ee !== ef) throw new Error(`SETTLE=check: errors differ: event ${ee} / fast ${ef}`);
    if (afterE !== afterF) throw new Error('SETTLE=check: async state differs');
    if (rf) { if (re.size !== rf.size) throw new Error(`SETTLE=check: ${re.size} nets vs ${rf.size}`); for (const [k, x] of rf) if (re.get(k) !== x) throw new Error(`SETTLE=check: ${k} event ${re.get(k)} fast ${x}`); }
    this.settleChecks = (this.settleChecks || 0) + 1; void snap;
    if (ef) throw new Error(ef); return rf;
  }
  settleFast(world) {
    const F = this._fastIds();
    const { id, names, chips, nid } = F; const Z = 2, A = 3;
    for (const k of world.keys()) nid(k); if (this.defaults) for (const k of this.defaults.keys()) nid(k);
    const N = names.length, enc = x => x === 'Z' ? Z : x === undefined ? A : x;
    const base = new Int8Array(N).fill(A), baseHas = new Uint8Array(N);
    for (const [k, x] of world) { const i = id.get(k); base[i] = enc(x); baseHas[i] = 1; }
    base[id.get('GND')] = 0; base[id.get('VCC')] = 1; baseHas[id.get('GND')] = 1; baseHas[id.get('VCC')] = 1;
    if (this.defaults) for (const [k, x] of this.defaults) { const i = id.get(k); if (!baseHas[i]) { base[i] = enc(x); baseHas[i] = 1; } }
    let prev = base.slice(), v = new Int8Array(N), missing = null, fight = null;
    const drv = new Int32Array(N), weakRef = new Uint8Array(F.order.length), weakNet = new Uint8Array(N), clash = new Set();
    const dec = x => x === Z ? 'Z' : x === A ? undefined : x;
    let cur = null;   // the chip being evaluated
    const g = pin => { const i = cur.pid[pin]; if (i === undefined) throw new Error(`${cur.c.ref}: pin ${pin} unconnected`);
      let x = v[i]; if (x === A || x === Z || (weakNet[i] && prev[i] !== A && prev[i] !== Z)) { const p = prev[i]; if (p !== A) x = p; }
      if (x === A || x === Z) { if (!missing) missing = `${cur.c.ref}.${pin}: net ${names[i]} undriven`; return 0; } return x; };
    const gz = pin => { const i = cur.pid[pin]; if (i === undefined) return 'Z'; let x = v[i]; if (x === A || x === Z) x = prev[i]; return x === A || x === Z ? 'Z' : x; };
    const s = (pin, x, weak) => { const i = cur.pid[pin]; if (i === undefined) return; if (x === 'Z') return; const pd = drv[i] - 1;
      if (weak) { if (baseHas[i] && base[i] !== Z) return; if (pd >= 0) { if (weakRef[pd] && v[i] !== x) clash.add(i); return; } }
      else if (pd >= 0 && pd !== cur.ci && !weakRef[pd]) { if (!fight) fight = `bus fight on ${names[i]}: ${chips[pd].c.ref} and ${cur.c.ref}`; return; }
      drv[i] = cur.ci + 1; if (weak) { weakRef[cur.ci] = 1; weakNet[i] = 1; } else weakNet[i] = 0; v[i] = x; };
    const pass = () => { v.set(base); drv.fill(0); weakRef.fill(0); weakNet.fill(0); clash.clear(); missing = null; fight = null;
      for (const ch of chips) { cur = ch; P[ch.c.part].eval(ch.c, g, s, gz); }
      for (const i of clash) { const pd = drv[i] - 1; if (pd >= 0 && weakRef[pd] && !fight) fight = `weak contention on ${names[i]} (two resistors disagree)`; }
      let changed = false; for (let i = 0; i < N; i++) if (v[i] !== prev[i]) { changed = true; break; }
      const t = prev; prev = v; v = t; return changed; };
    const toMap = () => { const m = new Map(); for (let i = 0; i < N; i++) if (prev[i] !== A) m.set(names[i], dec(prev[i])); return m; };
    let k = 0; while (pass() || missing) { if (++k > 12) { this.v = toMap(); throw new Error(missing || 'netlist does not settle (a combinational loop?)'); } }
    if (!this.asyncChips) this.asyncChips = this.chips.filter(c => P[c.part].async);
    for (let r = 0; r < 4; r++) { let chg = false;
      for (const c of this.asyncChips) if (P[c.part].async(c, pin => { const i = id.get(c.pins[pin]); return i === undefined ? undefined : dec(prev[i]); })) chg = true;
      if (!chg) break; k = 0; while (pass() || missing) { if (++k > 12) { this.v = toMap(); throw new Error(missing || 'netlist does not settle'); } } }
    const out = toMap(); this.v = out; if (fight) throw new Error(fight); this.passes = Math.max(this.passes || 0, k + 1); return out;
  }
  settleSlow(world) {                           // world: Map of input net values (the original settle, 2026-11-18)
    // Passes repeat until a whole pass reproduces the previous one. Each pass rebuilds every driven net from scratch
    // (reading this pass's value when there is one, else the previous pass's), so a driver that turns off really
    // releases its net. Errors: two drivers on a net, a net still undriven when settled, or no settling (a loop).
    const base = new Map(world); base.set('GND', 0); base.set('VCC', 1);
    if (this.defaults) for (const [k, x] of this.defaults) if (!base.has(k)) base.set(k, x);   // e.g. LOAD = 0 at run time
    const order = this.order || (this.order = [...this.chips.filter(c => P[c.part].reg), ...this.chips.filter(c => P[c.part].weak), ...this.chips.filter(c => !P[c.part].reg && !P[c.part].weak)]);
    // Bus fights are judged on the settled pass only (2026-11-18, Memory card stage 2): during the early passes a gate
    // listed after an SRAM may not have updated that SRAM's /OE yet, which is an artefact of evaluation order, not a
    // fight. A real fight is still there when everything has settled, and that one throws.
    let prev = new Map(base), missing = null, fight = null;
    const pass = () => { const v = new Map(base), drv = new Map(), weakRef = new Set(), weakNet = new Set(), clash = new Set(); missing = null; fight = null;
      for (const c of order) {
        // a value a resistor wrote this pass doesn't hide last pass's value: a strong driver later in the order may still
        // drive it (2026-11-19: the I/O card's 'LV8154s on the answer bus; a reader saw the pull-ups' 1 every pass)
        const g = pin => { const n = c.pins[pin]; if (n === undefined) throw new Error(`${c.ref}: pin ${pin} unconnected`);
          let x = v.get(n); if (x === undefined || x === 'Z' || (weakNet.has(n) && prev.has(n) && prev.get(n) !== 'Z')) x = prev.get(n) ?? x;
          if (x === undefined || x === 'Z') { if (!missing) missing = `${c.ref}.${pin}: net ${n} undriven`; return 0; } return x; };
        // gz: read a net that may legitimately float (a resistor's far end); 'Z' instead of an undriven error
        const gz = pin => { const n = c.pins[pin]; let x = v.get(n); if (x === undefined || x === 'Z') x = prev.get(n); return x === undefined ? 'Z' : x; };
        const s = (pin, x, weak) => { const n = c.pins[pin]; if (!n) return; if (x === 'Z') return;
          const p = drv.get(n);
          if (weak) { if (base.has(n) && base.get(n) !== 'Z') return;                // a card input someone else drives
            if (p) { if (weakRef.has(p) && v.get(n) !== x) clash.add(n); return; } }
          else if (p && p !== c.ref && !weakRef.has(p)) { if (!fight) fight = `bus fight on ${n}: ${p} and ${c.ref}`; return; }
          drv.set(n, c.ref); if (weak) { weakRef.add(c.ref); weakNet.add(n); } else weakNet.delete(n); v.set(n, x); };
        P[c.part].eval(c, g, s, gz);
      }
      for (const n of clash) if (weakRef.has(drv.get(n)) && !fight) fight = `weak contention on ${n} (two resistors disagree)`;
      let changed = v.size !== prev.size; if (!changed) for (const [k, x] of v) if (prev.get(k) !== x) { changed = true; break; }
      prev = v; return changed; };
    let k = 0; while (pass() || missing) { if (++k > 12) { this.v = prev; throw new Error(missing || 'netlist does not settle (a combinational loop?)'); } }
    // asynchronous clears / loads ('16823 /CLR, '165 SH/LD) act on the settled values only, never on a pass in between
    if (!this.asyncChips) this.asyncChips = this.chips.filter(c => P[c.part].async);
    for (let r = 0; r < 4; r++) { let ch = false;
      for (const c of this.asyncChips) if (P[c.part].async(c, pin => prev.get(c.pins[pin]))) ch = true;
      if (!ch) break; k = 0; while (pass() || missing) { if (++k > 12) { this.v = prev; throw new Error(missing || 'netlist does not settle'); } } }
    this.v = prev; if (fight) throw new Error(fight); this.passes = Math.max(this.passes || 0, k + 1); return prev;
  }
  clock() { for (const c of this.chips) if (P[c.part].reg) { const g = pin => this.v.get(c.pins[pin]); P[c.part].clock(c, g); } }
  bom() { const m = {}; for (const c of this.chips) m[c.part] = (m[c.part] || 0) + 1; return m; }
}
// dual-rail helpers: trit -> [p, n]
const rails = t => [t === 1 ? 1 : 0, t === -1 ? 1 : 0];
const trit = (p, n) => p && !n ? 1 : n && !p ? -1 : 0;
module.exports = { Card, rails, trit };
