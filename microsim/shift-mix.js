// shift-mix.js: which of the 11 SHIFT options does real code use, and how often? Sizes the shifter (PARTS.md open item 1).
// Usage: node shift-mix.js desktop|tritos21 [tritonDir]
'use strict';
const { MicroMachine, buildStore } = require('./microsim.js');
const proto = MicroMachine.prototype, orig = proto.cycle;
const dyn = {}, dynUsed = {}; let total = 0, aluTotal = 0;
proto.cycle = function () {
  const mu = this.cs.store[this.upc]; total++;
  const sh = mu.SHIFT || 'NONE'; dyn[sh] = (dyn[sh] || 0) + 1;
  if (mu.BUS === 'ALU' || mu.FLAGS) { aluTotal++; dynUsed[sh] = (dynUsed[sh] || 0) + 1; }
  return orig.call(this);
};
const which = process.argv[2] || 'desktop'; process.argv.splice(2, 1);
const t0 = Date.now();
const realExit = process.exit; process.exit = () => { report(); realExit(0); };
if (which === 'desktop') require('./boot-desktop.js'); else require('./boot-tritos21.js');
function report() {
// static: count control-store words per option (from a fresh store)
const st = {}; const store = buildStore().store || buildStore();
for (const w of (Array.isArray(store) ? store : Object.values(store))) { if (!w) continue; const s = w.SHIFT || 'NONE'; st[s] = (st[s] || 0) + 1; }
const opts = ['NONE', 'L1', 'L3', 'L9', 'R1', 'R3', 'R9', 'R1C', 'R1L', 'L1L', 'R1O'];
console.log(`\n== shift mix: ${which} (${total.toLocaleString()} microcycles, ${((Date.now() - t0) / 1000).toFixed(0)} s) ==`);
console.log('option  static-words  dynamic-cycles  %-of-all-cycles');
for (const o of opts) console.log(`${o.padEnd(6)}  ${String(st[o] || 0).padStart(12)}  ${String(dyn[o] || 0).padStart(14)}  ${(100 * (dyn[o] || 0) / total).toFixed(3).padStart(8)}%`);
require('fs').appendFileSync(__dirname + '/RESULTS-shift-mix.jsonl', JSON.stringify({ which, total, dyn, st, date: new Date().toISOString() }) + '\n');
}
report();
