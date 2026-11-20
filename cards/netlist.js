// netlist.js: a chip-level netlist and a functional simulator for it (Kehai Interim, 2026-11-18). MIT.
// A card is a list of chips (refdes, part, pin -> net). Nets hold 0/1. The simulator evaluates register outputs first,
// then the other chips, repeating passes until nothing changes; it refuses to continue if two drivers fight on a net, if
// a pin still reads a net nothing drives once everything else has settled, or if the netlist never settles.
'use strict';
const { P } = require('./parts.js');
class Card {
  constructor(name) { this.name = name; this.chips = []; this.inputs = new Set(['GND', 'VCC']); }
  add(ref, part, pins, extra = {}) { if (!P[part]) throw new Error(`no model for ${part}`); this.chips.push({ ref, part, pins, ...extra }); return this; }
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
  settle(world) {                               // world: Map of input net values
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
