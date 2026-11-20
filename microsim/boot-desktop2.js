// boot-desktop2.js: boot TritOS Desktop 2.0 (Triton 4) on the microcoded card, in lockstep with the emulator in
// tritos-desktop-2.html (Argon delivery 3, accepted in AUDIT-2). The I/O card is iocard4.js: the emulator's own Triton 4
// device code (units, ports 28-32, real-time timer, RTC) rewired onto the card's RAM, framebuffer and IRQ lines.
// Both machines get the same host clock: 5 µs before every instruction (the page's own pacing rate, 200 steps/ms).
'use strict';
const path = require('path');
const { MicroMachine } = require('./microsim.js');
const { attachIOCard4 } = require('./iocard4.js');
const dir = process.argv[2] || '/tmp/d3/x/triton/desktop';
const { loadHtmlModule, makeRng } = require(path.join(dir, 'tests/t3-common.js'));
const { T } = loadHtmlModule('tritos-desktop-2.html');
const W = (vm, r) => { const [a, b, c] = vm.getWord(r); return a + b * 19683 + c * 19683 * 19683; };
const SPRS = [[0, 'mode'], [1, 'priv'], [2, 'ie'], [3, 'imask'], [4, 'ipend'], [5, 'vbr'], [6, 'ubase'], [7, 'ulimit'], [8, 'protEn'], [9, 'epc'],
  [10, 'esp'], [11, 'esr'], [12, 'ecause'], [13, 'eaddr'], [14, 'ksp'], [15, 'trapDiv0']];

const em = new T.TritonJS({ archMode: 'T3' }); T.bootTritOSDesktop(em, false);
const fw = new T.TritonJS({ archMode: 'T3' }); T.bootTritOSDesktop(fw, false);   // the I/O card's device state, booted the same way
const mm = new MicroMachine(em.ramSize);
for (let i = 0; i < 32; i++) mm.mem[i] = fw.mem[i];                              // stage-0 loader the host put in RAM
attachIOCard4(mm, fw);
mm.pc = em.pc; mm.sp = em.sp; mm.protEn = em.protEn; mm.rf[17] = em.ulimit;

let steps = 0, uc = 0, bad = null; const t0 = Date.now();
function check() {
  if (em.pc !== mm.pc || em.sp !== mm.sp || em.sf !== mm.sf || em.cf !== mm.cf || em.of !== mm.of || !!em.halted !== mm.halted) return `pc ${em.pc}/${mm.pc} sp ${em.sp}/${mm.sp}`;
  for (let r = 0; r < 9; r++) if (W(em, r) !== mm.rf[r]) return 'R' + r;
  for (const [i, n] of SPRS) if (em.getSPR(i) !== mm.sprRead(i)) return `${n} ${em.getSPR(i)}/${mm.sprRead(i)}`;
  for (const f of ['timerCount', 'timerPeriod', 'timerMode', 'timerTicks', 'realTimeTicks', 'steps', 'diskUnit', 'rtcOffset'])
    if (em[f] !== fw[f]) return `io.${f} ${em[f]}/${fw[f]}`;
  return null;
}
function units() { const out = [];
  for (let u = 0; u < 27; u++) { const a = em.units[u], b = fw.units[u];
    if (!!(a && a.present) !== !!(b && b.present)) return `unit ${u} presence`;
    if (a && a.present) { const ea = a.getNonZeroSectorEntries(), eb = b.getNonZeroSectorEntries();
      if (ea.length !== eb.length) return `unit ${u}: ${ea.length} vs ${eb.length} non-zero sectors`;
      for (let k = 0; k < ea.length; k++) { if (ea[k][0] !== eb[k][0]) return `unit ${u} sector list`;
        for (let j = 0; j < 729; j++) if (ea[k][1][j] !== eb[k][1][j]) return `unit ${u} sector ${ea[k][0]}`; }
      out.push(`${u}:${ea.length}`); } }
  unitSummary = out.join(' '); return null; }
let unitSummary = '';
function deep(label) {
  for (let a = 0; a < em.ramSize; a++) if (em.mem[a] !== mm.mem[a]) return `${label}: RAM at ${a}`;
  for (let a = 0; a < em.vram.length; a++) if (em.vram[a] !== mm.vram[a]) return `${label}: framebuffer at ${a}`;
  const u = units(); if (u) return `${label}: ${u}`;
  if (em.consoleOut !== fw.consoleOut) return `${label}: console`;
  return null;
}
function run(n) { for (let i = 0; i < n && !bad && !em.halted; i++) {
  em._advanceClockUsInternal(5); fw._advanceClockUsInternal(5);
  em.step(); uc += mm.step(); steps++; bad = check(); if (bad) bad = `step ${steps}: ${bad}`; } }

run(300000); if (!bad) bad = deep('after boot (300k steps)');
const bootSteps = steps, bootUc = uc;
const rng = makeRng(0x13572468), keys = 'LS\nPS\nCAT HELLO\n';
for (let i = 0; i < 2000 && !bad; i++) {
  if (i % 3 === 0) { const c = keys.charCodeAt(i % keys.length); em.pushKeyEvent(c, 0); fw.pushKeyEvent(c, 0); }
  else { const dx = rng.int(-3, 3), dy = rng.int(-3, 3), b = (i % 20 === 0) ? 1 : 0; em.pushMouseEvent(dx, dy, b); fw.pushMouseEvent(dx, dy, b); }
  if (i % 50 === 49) run(1500);
}
run(20000); if (!bad) bad = deep('after 2,000 input events');
const secs = (Date.now() - t0) / 1000;
console.log(`TritOS Desktop 2.0 (Triton 4) on the microcoded card: ${steps.toLocaleString()} instruction steps in lockstep, ${bad ? 'MISMATCH ' + bad : '0 mismatches'}`);
console.log(`checked every step: PC, SP, flags, R0-R8, all 16 SPRs, timer mode/period/count/ticks, real-time ticks, step counter, selected unit, RTC offset;`);
console.log(`at boot and at the end: all ${em.ramSize.toLocaleString()} trytes of RAM, the whole framebuffer, every storage unit sector by sector (non-zero sectors per unit: ${unitSummary}), console`);
console.log(`boot: ${bootSteps.toLocaleString()} steps = ${(bootUc / 1e7).toFixed(3)} s of card time at 10 MHz; overall ${(uc / steps).toFixed(2)} µcycles per instruction (${secs.toFixed(0)} s to simulate)`);
console.log(`timer mode at the end: ${fw.timerMode} (1 = real time); interrupts taken on the card: ${mm.irqTaken.toLocaleString()}; RTC reads ${fw.getRtcSeconds()} s since 2000-01-01`);
require('fs').writeFileSync('/tmp/desktop2-fb.json', JSON.stringify(Array.from(mm.vram)));
process.exit(bad ? 1 : 0);
