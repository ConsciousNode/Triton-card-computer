'use strict';
// sta.js: gate-level timing for the composed card computer, on the exercised paths (Kehai Interim, 2026-11-20). MIT.
//
// What this is, and what it isn't:
//   - It runs on the settled values of a real microcycle (from machine-sim.js, during program-lockstep.js). For each
//     chip it takes the pins its model actually reads with those values, and draws an arc from each read pin to each
//     output the chip drives (not 'Z'). So a mux contributes its select and the input it selected, a '245 with /OE high
//     contributes nothing, a gate contributes all its inputs, an SRAM that is enabled contributes every address pin,
//     /CE and /OE (its contents don't matter: every address bit is an arc, whatever the table holds).
//   - Arrival times start at every register's clock-to-Q after its own clock edge, and run to every pin that
//     register's clock() reads (D, /CLKEN, /LD...), which must arrive a setup time before the next edge.
//   - It runs once per 25 ns slot, on that slot's settled values (machine-sim.js half-slots), with absolute times
//     from the CPU edge: a CLK register launches at 0 + tco; an SCLK register launches at its own edge (25 j) + tco.
//     An SCLK register captures at the end of slot j (25 (j + 1) - setup); a CLK register only at the end of the
//     microcycle's last slot (the /CEDGE slot). So a signal the Video card samples at 25 ns is judged with the
//     control values of slot 0, not those of the write-strobe half.
//   - Two modes. 'table' (conservative): every read pin of a gate is an arc, and an SRAM address bit is an arc to each
//     output bit that depends on it anywhere in the table. 'cycle' (sensitized): an input is an arc to an output only
//     if flipping that input alone, with this slot's other values, changes the output (or its three-state).
//     'table' keeps paths that the current control values block (e.g. the bus into the SPR latch tables in a word that
//     doesn't write an SPR); 'cycle' drops them, and also drops data-dependent paths the workload's values never
//     sensitized. Both are reported.
//   - It is "exercised-path" timing: the control values (which mux input, which driver is on) come from the cycles the
//     workload actually ran. A path the workload never selects is not timed. Data values never matter: a gate or table
//     input is an arc whether or not its value changed.
//   - Not covered here: SRAM write timing (address and data setup to the /WE strobe inside the cycle), clock skew (CLK
//     is SCLK through one '08: a bench item already), wiring and backplane loading, open-drain rise times (LVC07 nets
//     are listed separately: their rise is set by a pull-up, not the gate).
// Delays: datasheet maximums at 3.3 V +- 0.3 V, -40..85 C. The ones marked [budget] are from TIMING-BUDGET.md, which
// cites the datasheets; the rest are Kehai's reading of the TI / Nexperia / ISSI datasheets, NOT re-verified in this
// session (no web access to datasheets here): check every one before a bench result is trusted.
const path = require('path'); const { P } = require(path.join(__dirname, '../cards/parts.js'));

// part -> { d: data in -> out, en: enable pin -> out, sel: select/direction pin -> out, tco, su, notes }
const T = {
  IS61WV5128: { d: 10, en: 10, oe: 5 }, IS61WV20488: { d: 10, en: 10, oe: 5 },          // tAA [budget], tACE, tDOE
  IS61WV204816: { d: 10, en: 10, oe: 5 }, IS61WV51216: { d: 10, en: 10, oe: 5 },
  ALVCH16823: { tco: 4.6, su: 2.1, suEn: 2.5, oe: 5.0 },
  LVC574: { tco: 7.0, su: 2.0, oe: 7.5 },                                                // tco, su [budget]
  LVC74: { tco: 5.5, su: 3.0 }, LVC161: { tco: 7.0, su: 5.0 }, LVC164: { tco: 8.0, su: 4.0 }, LV164: { tco: 14.0, su: 6.0 }, LVC165: { tco: 8.0, su: 4.0 },
  LVC157: { d: 6.0, sel: 6.5, en: 6.0 },                                                 // d [budget, with margin]
  LVC153: { d: 6.5, sel: 7.0, en: 6.5 }, LVC257: { d: 6.0, sel: 6.5, en: 7.0 }, LVC253: { d: 6.5, sel: 7.0, en: 7.0 },
  CBTLV3253: { d: 0.25, sel: 5.5, en: 5.0 }, CBTLV3257: { d: 0.25, sel: 5.0, en: 5.0 }, CBTLV3245: { d: 0.25, en: 5.0 }, CBTLV16211: { d: 0.25, en: 5.0 },
  LVC245: { d: 6.3, en: 8.5, sel: 8.5 },                                                 // d [budget]
  LVC244: { d: 5.9, en: 7.3 }, LVC125: { d: 4.8, en: 5.8 }, LVC07: { d: 4.0 },
  LVC04: { d: 4.4 }, LVC08: { d: 4.4 }, LVC32: { d: 4.4 }, LVC11: { d: 5.0 }, LVC138: { d: 7.5, en: 7.5 },
  S70GL02GS: { d: 110, en: 110, oe: 25 }, LV8154: { d: 12 }, CD4060: { d: 100 },
};
const ENABLE = /^(\d?\/(OE|E|CE|G)|\/CE|\/OE|\/E\d?|\d\/OE|G\d?|\/G)$/, SELECT = /^(S\d?|DIR|[AB]$|\/?SEL)$/;
const CK = { LVC74: ['1CLK', '2CLK'], ALVCH16823: ['1CLK', '2CLK'], LVC161: ['CP', 'CLK'], LVC574: ['CLK'], LVC164: ['CLK'], LV164: ['CLK'], LVC165: ['CLK'] };
const PERIOD = { CLK: 100, SCLK: 25 };   // nominal; captures are timed per slot below

// multi-section packages: an input only reaches the outputs of its own section (gate 2's inputs never reach gate 3)
function section(part, pin) {
  if (part === 'LVC245' || part === 'CBTLV3245') { const m = /^[AB](\d+)$/.exec(pin); return m ? m[1] : null; }
  if (part === 'LVC244' || part === 'CBTLV16211') { let m = /^(\d)[AYB](\d+)$/.exec(pin); if (m) return `${m[1]}.${m[2]}`; m = /^(\d)\//.exec(pin); return m ? m[1] : null; }
  if (P[part].write || P[part].edges || part === 'LVC138' || part === 'S70GL02GS') return null;
  const m = /^(\d+)/.exec(pin); return m ? m[1] : null;
}
const reaches = (part, i, o) => { const si = section(part, i), so = section(part, o); return !si || !so || so === si || so.startsWith(si + '.'); };
function delay(part, pin) {
  const t = T[part]; if (!t) throw new Error(`no timing for ${part}`);
  if (P[part].write || part === 'S70GL02GS') return /^\/OE$/.test(pin) ? t.oe : /^\/CE/.test(pin) ? t.en : t.d;
  if (ENABLE.test(pin) && t.en !== undefined) return t.en;
  if (SELECT.test(pin) && t.sel !== undefined) return t.sel;
  return t.d;
}

class Timing {
  constructor(m, { scale = {}, mode = 'table' } = {}) {
    this.m = m; this.scale = scale; this.mode = mode;   // scale: { part: factor } (the positive controls slow a part down)
    this.regs = m.chips.filter(c => P[c.part].reg);
    this.comb = m.chips.filter(c => !P[c.part].reg && !P[c.part].weak);
    this.dom = new Map(); for (const c of this.regs) { const k = CK[c.part].find(k => c.pins[k] && c.pins[k] !== 'GND'); this.dom.set(c, c.pins[k]); }
    this.worst = new Map();       // endpoint "ref.pin" -> { slack, arr, req, launch, capture, path, upc }
    this.cycles = 0;
  }
  d(part, pin) { return delay(part, pin) * (this.scale[part] || 1); }
  // one settled microcycle: v = net values just before the CPU edge; upc = the microword it was (for the report)
  // slot: j = slot index since the CPU edge, last = this is the /CEDGE slot (the CPU edge follows it)
  analyze(v, upc, { j = 3, last = true } = {}) {
    this.cycles += last ? 1 : 0; this.slots = (this.slots || 0) + 1; const SL = 25;
    const arr = new Map();                         // net -> { t, dom, from: [ref, pin, prevNet] }
    const put = (n, t, dom, from) => { const a = arr.get(n); if (!a || t > a.t) { arr.set(n, { t, dom, from }); return true; } return false; };
    for (const c of this.regs) { const dom = this.dom.get(c), t = T[c.part];
      const outs = []; P[c.part].eval(c, pin => v.get(c.pins[pin]) ?? 0, (pin, x) => { if (x !== 'Z') outs.push(pin); }, pin => v.get(c.pins[pin]) ?? 'Z');
      const t0 = dom === 'SCLK' ? SL * j : 0; if (dom !== 'CLK' && dom !== 'SCLK') continue;
      for (const o of outs) { const n = c.pins[o]; if (n) put(n, t0 + t.tco * (this.scale[c.part] || 1), dom, [c.ref, 'CLK', null]); } }
    // the arcs this cycle: pins each combinational chip reads -> outputs it drives
    const arcs = [];
    for (const c of [...this.comb, ...this.regs.filter(r => P[r.part].tri)]) { const reads = new Set(), outs = [], isReg = !!P[c.part].reg;
      P[c.part].eval(c, pin => { reads.add(pin); return v.get(c.pins[pin]) ?? 0; }, (pin, x) => { if (x !== 'Z' && c.pins[pin]) outs.push(pin); },
        pin => { reads.add(pin); return v.get(c.pins[pin]) ?? 'Z'; });
      if (!outs.length) continue;
      // a three-state register: only its output enable is an arc (/OE -> Q); its data comes from the clock edge
      const ins = [...reads].filter(p => { const n = c.pins[p]; return n && n !== 'GND' && n !== 'VCC' && (!isReg || ENABLE.test(p)); });
      let sens = null;
      if (this.mode === 'cycle') { const base = this.outVals(c, v, null); sens = p => { const f = this.outVals(c, v, p); return outs.filter(o => f[o] !== base[o]); }; }
      const dm = this.mode === 'table' && P[c.part].write && c.pins['/WE'] === 'VCC' ? this.depMask(c) : null;
      arcs.push({ c, ins: ins.map(p => [p, c.pins[p], isReg ? T[c.part].oe * (this.scale[c.part] || 1) : this.d(c.part, p),
        (sens ? sens(p) : dm && /^A\d+$/.test(p) ? outs.filter(o => (dm[+p.slice(1)] >> +o.slice(2)) & 1) : outs.filter(o => reaches(c.part, p, o))).map(o => c.pins[o])]) }); }
    for (let pass = 0; ; pass++) { let ch = false;
      for (const { c, ins } of arcs) for (const [p, n, dl, outs] of ins) { const a = arr.get(n); if (!a) continue;
        for (const o of outs) if (o !== n && put(o, a.t + dl, a.dom, [c.ref, p, n])) ch = true; }
      if (!ch) break;
      if (pass > 200) { const loop = []; let n = arcs.length && [...arr.entries()].sort((a, b) => b[1].t - a[1].t)[0][0]; const seen = new Set();
        while (n && !seen.has(n)) { seen.add(n); const a = arr.get(n); loop.push(`${n}<${a.from[0]}.${a.from[1]}`); n = a.from[2]; }
        throw new Error('timing does not converge: a combinational loop on the active arcs: ' + loop.slice(0, 20).join(' ')); } }
    // endpoints: what each register's clock() reads
    for (const c of this.regs) { const cap = this.dom.get(c); if (cap !== 'SCLK' && !(cap === 'CLK' && last)) continue; const t = T[c.part];
      const reads = new Set(); const q0 = c.q; const probe = Object.create(c); probe.q = Array.isArray(c.q) ? c.q.slice() : c.q;
      try { P[c.part].clock(probe, pin => { reads.add(pin); return v.get(c.pins[pin]) ?? 0; }); } catch (e) { }
      for (const pin of reads) { const n = c.pins[pin]; const a = arr.get(n); if (!a || !PERIOD[a.dom]) continue;
        if (CK[c.part].includes(pin) || /CLR|PRE|MR/.test(pin)) continue;     // clocks, async clears
        const su = /CLKEN|\/LD|EN[PT]/.test(pin) && t.suEn ? t.suEn : t.su;
        const req = SL * (j + 1) - su, slack = req - a.t, key = `${c.ref}.${pin}`, w = this.worst.get(key);
        if (!w || slack < w.slack) this.worst.set(key, { slack, arr: a.t, req, launch: a.dom, capture: cap, net: n, upc, slot: j, path: this.trace(arr, n) }); }
      void q0; }
  }
  // the chip's outputs with this slot's values, one read pin flipped ('Z' counts as a value)
  outVals(c, v, flip) { const o = {}; const get = pin => { let x = v.get(c.pins[pin]); if (x === undefined || x === 'Z') x = 0; return pin === flip ? 1 - x : x; };
    P[c.part].eval(c, get, (pin, x) => { o[pin] = x; }, pin => { const x = v.get(c.pins[pin]); return pin === flip ? (x === 1 ? 0 : 1) : x ?? 'Z'; }); return o; }
  // a fixed table (an SRAM with /WE tied high): which output bits can change when one address bit changes, over the
  // whole table. An address bit no output depends on is not a timing arc (its table never lets it through). It can
  // still make the SRAM's outputs glitch for tAA, which matters only in a loop; loops are reported, not hidden.
  depMask(c) { if (c._dep) return c._dep; const mem = c.mem, na = Math.round(Math.log2(mem.length)), dep = [];
    const full = P[c.part].out.length >= 16 ? 0xFFFF : 0xFF;
    for (let a = 0; a < na; a++) { const bit = 1 << a; let acc = 0;
      for (let x = 0; x < mem.length && acc !== full; x++) if (!(x & bit)) acc |= mem[x] ^ mem[x | bit];
      dep[a] = acc; }
    return (c._dep = dep); }
  trace(arr, n) { const out = []; let k = 0; while (n && k++ < 60) { const a = arr.get(n); if (!a) break; out.push(`${n}@${a.t.toFixed(1)}${a.from ? ` <${a.from[0]}.${a.from[1]}` : ''}`); n = a.from && a.from[2]; } return out.reverse(); }
  report(limit = 15) {
    const all = [...this.worst.entries()].map(([k, w]) => ({ k, ...w })).sort((a, b) => a.slack - b.slack);
    const groups = {}; for (const w of all) { const g = `${w.launch}->${w.capture}`; (groups[g] = groups[g] || []).push(w); }
    return { all, groups, limit };
  }
}
module.exports = { Timing, T, delay };
