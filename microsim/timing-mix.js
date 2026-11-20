// timing-mix.js: classify every microcycle of a real workload by which datapath path it exercises, to size the
// timing budget (TIMING-BUDGET.md). Workload: TritOS Desktop 1.1.2 boot + the desktop-02 input pattern (boot-desktop.js).
'use strict';
const { MicroMachine } = require('./microsim.js');
const proto = MicroMachine.prototype, orig = proto.cycle;
const counts = { carry: 0, aluNoCarry: 0, mem: 0, dispatch: 0, other: 0, total: 0 };
proto.cycle = function () {
  const mu = this.cs.store[this.upc]; counts.total++;
  const aluUsed = mu.BUS === 'ALU' || mu.FLAGS === 'ARITH' || mu.FLAGS === 'CMP' || mu.FLAGS === 'SHOUTL' || mu.FLAGS === 'SHOUTR';
  const fn = mu.ALU_FN || 'ADD';
  if (mu.SEQ === 'DISPATCH') counts.dispatch++;
  else if (aluUsed && (fn === 'ADD' || fn === 'INCA')) counts.carry++;
  else if (aluUsed) counts.aluNoCarry++;
  else if (mu.MEM === 'RD' || mu.MEM === 'WR') counts.mem++;
  else counts.other++;
  return orig.call(this);
};
process.argv[2] = process.argv[2] || require(__dirname+'/../triton-dir.js')+'';
const { em, mm } = require('./boot-desktop.js');
const pct = k => (100 * counts[k] / counts.total).toFixed(1) + '%';
console.log(`microcycles classified: ${counts.total.toLocaleString()}`);
console.log(`carry-chain ALU (ADD/INCA, 9-slice ripple): ${pct('carry')}; ALU without carry: ${pct('aluNoCarry')}; memory: ${pct('mem')}; dispatch: ${pct('dispatch')}; other (RF/bus moves, branches): ${pct('other')}`);
const steps = em.steps, uc = counts.total;
for (const [label, tFast, tCarry] of [['uniform 100 ns (the assumption)', 100, 100], ['uniform 125 ns (8 MHz)', 125, 125],
  ['uniform 135 ns (7.4 MHz, ripple + 20% margin)', 135, 135], ['100 ns, carry cycles stretched to 2 (200 ns)', 100, 200],
  ['70 ns, carry cycles stretched to 2 (140 ns)', 70, 140]]) {
  const ns = (uc - counts.carry) * tFast + counts.carry * tCarry;
  console.log(`${label}: ${(steps / (ns * 1e-9) / 1e6).toFixed(2)}M instructions/s`);
}
