'use strict';
// machine-sim.js: steps the composed machine (integrate.js) in half-slots of SCLK (Kehai Interim, 2026-11-20). MIT.
// The physical rule, the same for every chip on every card:
//   - a flip-flop or counter is clocked only when its own clock net rises (per half, for '74 and '16823), with the
//     values settled just before that edge; derived clocks (a flop's output used as another chip's clock) are followed
//     by settling again and repeating, up to 6 ripples;
//   - edge-triggered parts with `edges` ('LV8154, CD4060) get their listed edges the same way;
//   - an async SRAM writes whenever its /WE and /CE are both low, with the settled values (write-through, as the part
//     does); tables with /WE tied to VCC never write.
// The microsim is not used here: this file only runs the netlist. Comparisons live in the run scripts.
const path = require('path'); const { P } = require(path.join(__dirname, '../cards/parts.js'));
const CK = { LVC74: ['1CLK', '2CLK'], ALVCH16823: ['1CLK', '2CLK'], LVC161: ['CP', 'CLK'], LVC574: ['CLK'], LVC164: ['CLK'], LV164: ['CLK'], LVC165: ['CLK'] };
class MachineSim {
  constructor(m, world = {}) {
    this.m = m; this.w = new Map([['SCLK', 0], ['POR', 1], ['LOAD', 0], ['SD_MISO', 1], ['SD_CD', 1], ['K_CLK', 1], ['K_DATA', 1], ['M_CLK', 1], ['M_DATA', 1], ['RTC_OSC', 0], ...Object.entries(world)]);
    this.regs = m.chips.filter(c => P[c.part].reg).map(c => ({ c, halves: CK[c.part].filter(k => c.pins[k] !== undefined && c.pins[k] !== 'GND') }));
    this.edgy = m.chips.filter(c => P[c.part].edges);
    this.srams = m.chips.filter(c => P[c.part].write && c.pins['/WE'] !== 'VCC');
    for (const c of m.chips) if (c.part === 'LVC74' && !c.q) c.q = [0, 0, 0];
    this.v = m.settle(this.w); this.halfSteps = 0; this.writes = [];
    for (const c of this.edgy) { c.last = {}; for (const pin of Object.keys(P[c.part].edges)) c.last[pin] = this.v.get(c.pins[pin]); }
  }
  set(net, x) { this.w.set(net, x); }
  half(sclk) {
    let before = this.v; this.w.set('SCLK', sclk); let cur = this.m.settle(this.w);
    for (let r = 0; r < 6; r++) { let any = false; const g0 = c => pin => before.get(c.pins[pin]);
      for (const { c, halves } of this.regs) for (const k of halves) { const n = c.pins[k]; if (!(before.get(n) === 0 && cur.get(n) === 1)) continue; any = true;
        if (halves.length === 1 || c.part === 'LVC161') { P[c.part].clock(c, g0(c)); continue; }
        // one half of a '74 or '16823: hide the other half's clock (or clock enable) from this call
        const h = k[0], o = h === '1' ? '2' : '1', proxy = Object.create(c);
        proxy.pins = c.part === 'LVC74' ? { ...c.pins, [`${o}CLK`]: 'GND' } : { ...c.pins, [`${o}/CLKEN`]: 'VCC' };
        if (c.part === 'ALVCH16823') { c.q = c.q || []; } P[c.part].clock(proxy, g0(c)); if (proxy.hasOwnProperty('q') && proxy.q !== c.q) c.q = proxy.q; }
      for (const c of this.edgy) { const hit = new Set();
        for (const [pin, kind] of Object.entries(P[c.part].edges)) { const x = cur.get(c.pins[pin]), p = c.last[pin];
          if (p !== undefined && (kind === 'rise' ? p === 0 && x === 1 : p === 1 && x === 0)) hit.add(pin); c.last[pin] = x; }
        if (hit.size) { P[c.part].edge(c, g0(c), hit); any = true; } }
      if (!any) break; before = cur; cur = this.m.settle(this.w);
      if (r === 5) throw new Error('derived clocks keep rippling');
    }
    for (const c of this.srams) { const a = P[c.part].write(c, pin => cur.get(c.pins[pin])); if (a >= 0) this.writes.push([c.ref, a]); }
    this.v = cur; this.halfSteps++; return cur;
  }
  slot() { const hi = this.half(1); const lo = this.half(0); return { hi, lo }; }
  // run slots until the end of the next /CEDGE slot (the CPU edge); returns the values settled just before that edge
  // (the edge itself happens at the start of the next slot; the returned values are the ones every flop will sample)
  microcycle(maxSlots = 16) { for (let s = 0; s < maxSlots; s++) { const { hi, lo } = this.slot(); if (hi.get('/CEDGE') === 0) return lo; }
    throw new Error(`no CPU edge in ${maxSlots} slots`); }
}
module.exports = { MachineSim };
