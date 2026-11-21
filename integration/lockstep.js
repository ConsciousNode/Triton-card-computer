'use strict';
// lockstep.js: the integrated machine beside the microsim, compared every microcycle (Kehai Interim, 2026-11-20). MIT.
// The microsim only checks; nothing it computes is fed to the netlist. After RESET releases, at each CPU edge we
// compare the micro-address on the backplane (UA0..9) with the microsim's upc, and the dual-rail bus with the
// microsim's bus value (when the microsim says something drives it; undriven = the terminated 0).
// Usage: node lockstep.js [microcycles] [porCycles]
const path = require('path');
const { compose } = require('./integrate.js'); const { MachineSim } = require('./machine-sim.js');
const { MicroMachine } = require('../microsim/microsim.js'); const { trit } = require('../cards/netlist.js');
const N = +(process.argv[2] || 200), POR = +(process.argv[3] || 12);
const MUT = process.env.MACHINE_MUTANT ? Object.fromEntries([process.env.MACHINE_MUTANT.split(':')]) : {};   // e.g. Control:LATCH_NO_RESET
const m = compose({ mutants: MUT }), s = new MachineSim(m), mm = new MicroMachine(); mm.upc = mm.cs.addr.RESET; mm.rf[require('../microsim/microsim.js').SLOT.ULIMIT] = 0;   // power-on: the RESET routine first (2026-11-20)
const word = (v, pfx) => { let x = 0; for (let i = 9; i >= 0; i--) x = 2 * x + (v.get(`${pfx}${i}`) | 0); return x; };
const ua = v => word(v, 'UA'), upcOf = v => word(v, 'Control:UPC');
const bus = v => { let x = 0; for (let k = 26; k >= 0; k--) { const p = v.get(`D${k}+`), q = v.get(`D${k}-`); if (p && q) return NaN; x = 3 * x + trit(p, q); } return x; };
let k = 0, compared = 0, first = null; const t0 = Date.now(); const trace = [];
for (; k < POR; k++) s.microcycle(); s.set('POR', 0);
while (compared < N) { const v = s.microcycle(); k++; if (v.get('RESET') === 1) continue;
  // UPC (the µPC register) = the word executing this cycle = the microsim's upc; UA (backplane) = the next address
  const modeWant = { MODE: mm.mode, PRIV: mm.priv, IE: mm.ie, PROTEN: mm.protEn };
  const want = mm.upc, got = upcOf(v); mm.cycle(); const wantNext = mm.upc, gotNext = ua(v); const wb = mm.lastBus === undefined ? 0 : mm.lastBus, gb = bus(v);
  trace.push(`${compared}: UPC ${got} / upc ${want}  UA ${gotNext} / next ${wantNext}  bus ${gb} / ${mm.lastBus === undefined ? '(none)' : mm.lastBus}`);
  // the machine-mode lines on the backplane vs the microsim's state for this cycle (read before mm.cycle() changed it)
  const modeMis = Object.entries(modeWant).filter(([k, x]) => v.get(k) !== x).map(([k, x]) => `${k} ${v.get(k)} vs ${x}`);
  if (!first && (got !== want || gotNext !== wantNext || gb !== wb || modeMis.length)) first = { compared, got, want, gb, wb, gotNext, wantNext, modeMis };
  compared++; if (first && compared > first.compared + 3) break; }
console.log(trace.slice(Math.max(0, (first ? first.compared : compared) - 6)).slice(0, 12).join('\n'));
console.log(`lockstep: ${compared} microcycles compared after reset, ${(Date.now() - t0) / 1000 | 0} s; ${first ? `FIRST DIVERGENCE at microcycle ${first.compared}: UPC ${first.got} vs upc ${first.want}, UA ${first.gotNext} vs next ${first.wantNext}, bus ${first.gb} vs ${first.wb}${first.modeMis.length ? ', ' + first.modeMis.join(', ') : ''}` : 'no divergence'}`);
process.exitCode = first ? 1 : 0;
