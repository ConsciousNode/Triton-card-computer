'use strict';
// Stage 0 of the integration netlist (INTEGRATION-PLAN.md): does the backplane agree with itself?
// Builds each card's netlist (dummy table images: wiring doesn't depend on contents), takes the backplane signal list
// from backplane.js, and reports, for every backplane signal, which cards drive it (strong / tri-state / weak /
// open-drain) and which read it. Then: signals nobody drives, signals with two always-on drivers, backplane names a
// card doesn't use (spelt differently?), and per card the nets its harness supplies that aren't on the backplane
// (the things the integration must still find a real source for).
const path = require('path'), D = path.join(__dirname, '../cards/');
const { P } = require(D + 'parts.js'); const { SLOT } = require('../microsim/microsim.js');
const src = require('fs').readFileSync(path.join(__dirname, '../backplane.js'), 'utf8');
const sig = []; eval(src.slice(src.indexOf('const sig = [];'), src.indexOf('// ---- 2. connector')).replace('const sig = [];', ''));
const BP = new Set(sig.map(s => s[0]));
const B = () => Buffer.alloc(1 << 21), A = n => Array.from({ length: n }, B);
const cards = {
  ALU: require(D + 'alu-card.js').build(B(), A(4)), Control: require(D + 'clockgen.js').build(require(D + 'control-card.js').build(path.join(D, '../roms'), A(8))),   // + the clock/reset generator (stage 1)
  Registers: require(D + 'registers-card.js').build(B()), Memory: require(D + 'memory-card.js').build(A(4), 14348907, SLOT),
  Video: require(D + 'video-card.js').build(B()), IO: require(D + 'io-ports.js').build(B()) };
// Registers with an output-enable pin ('16823 x/OE, '574 /OE) are three-state too, as loadpath.js already treats them;
// one whose enable is tied to GND really is always on, so it stays 'strong'.
const oeOf = (ch, pin) => ch.part === 'ALVCH16823' ? ch.pins[`${pin[0]}/OE`] : ch.part === 'LVC574' ? ch.pins['/OE'] : undefined;
const kind = (ch, pin) => { const p = P[ch.part]; if (ch.part === 'LVC07') return 'od'; if (p.weak) return 'weak'; if (p.tri) return 'tri';
  const oe = oeOf(ch, pin); return oe !== undefined && oe !== 'GND' ? 'tri' : 'strong'; };
// signals driven by a part with no simulator model (declared here, not hidden)
const WORLD = { SCLK: 'the 40 MHz oscillator can on the Control card (world part)', LOAD: 'the copy engine (io-copy-engine.js; proven by load-sim, not yet in the I/O card netlist)' };
const use = {}; // signal -> card -> { drv: [kinds], rd }
const harnessIn = {};
for (const [name, c] of Object.entries(cards)) {
  const outs = new Map(), reads = new Set();
  for (const ch of c.chips) { const o = new Set(P[ch.part].out || []);
    for (const [pin, net] of Object.entries(ch.pins)) { if (net === 'VCC' || net === 'GND') continue;
      if (o.has(pin)) { if (!outs.has(net)) outs.set(net, []); outs.get(net).push(`${ch.ref}:${kind(ch, pin)}`); } else reads.add(net); } }
  const inputs = new Set(c.inputs || []);
  for (const net of new Set([...outs.keys(), ...reads, ...inputs])) if (BP.has(net)) { use[net] = use[net] || {}; use[net][name] = { drv: outs.get(net) || [], rd: reads.has(net) || inputs.has(net) }; }
  harnessIn[name] = [...inputs].filter(n => !BP.has(n) && !outs.has(n)); }
const out = [];
out.push(`# Backplane check (integration stage 0), generated ${new Date().toISOString()}`);
out.push(`Cards: ${Object.entries(cards).map(([k, c]) => `${k} ${c.chips.length}`).join(', ')}. Backplane signals: ${BP.size}.\n`);
out.push('| signal | ' + Object.keys(cards).join(' | ') + ' | note |'); out.push('| --- |' + ' --- |'.repeat(Object.keys(cards).length + 1));
const notes = { nodrv: [], multi: [], unused: [] };
for (const [s] of sig) { const u = use[s] || {}; const cells = Object.keys(cards).map(k => { const x = u[k]; if (!x) return '';
      const d = [...new Set(x.drv.map(v => v.split(':')[1]))]; return (d.length ? 'D:' + d.join('/') : '') + (x.rd ? (d.length ? ' ' : '') + 'r' : ''); });
  const strong = Object.entries(u).filter(([, x]) => x.drv.some(v => v.endsWith(':strong'))).map(([k]) => k);
  const anyDrv = Object.values(u).some(x => x.drv.length);
  let note = ''; if (!Object.keys(u).length) { note = 'no card uses it'; notes.unused.push(s); }
  else if (!anyDrv && WORLD[s]) { note = `driven by ${WORLD[s]}`; }
  else if (!anyDrv) { note = '**nobody drives it**'; notes.nodrv.push(s); }
  else if (strong.length > 1) { note = `**always-on drivers on ${strong.join(' + ')}**`; notes.multi.push(s); }
  out.push(`| ${s} | ${cells.join(' | ')} | ${note} |`); }
out.push('\n## Summary');
out.push(`- Nobody drives (${notes.nodrv.length}): ${notes.nodrv.join(', ') || 'none'}`);
out.push(`- Always-on drivers on two cards (${notes.multi.length}): ${notes.multi.join(', ') || 'none'}`);
out.push(`- No card uses (${notes.unused.length}): ${notes.unused.join(', ') || 'none'}`);
out.push('\n## Per card: inputs its harness supplies that aren\'t backplane signals');
for (const [k, v] of Object.entries(harnessIn)) out.push(`- **${k}** (${v.length}): ${v.join(', ') || 'none'}`);
require('fs').writeFileSync(path.join(__dirname, 'BACKPLANE-CHECK.md'), out.join('\n') + '\n');
console.log(out.slice(-12).join('\n'));
