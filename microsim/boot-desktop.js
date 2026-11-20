// boot-desktop.js: boot TritOS Desktop 1.1.2 (Triton 3.1.1 machine) on the microcoded card, in lockstep with the
// emulator inside tritos-desktop.html, comparing architected state + SPRs after every instruction, then RAM, the whole
// framebuffer, the disk and the device state at checkpoints. Input: the same pattern as the Triton repo's own
// determinism test (desktop-02): keys 'LS\nPS\nCAT HELLO\n' and random mouse moves/clicks, delivered between steps.
'use strict';
const path = require('path');
const { MicroMachine } = require('./microsim.js');
const tritonDir = process.argv[2] || require(__dirname+'/../triton-dir.js')+'';
const { loadHtmlModule, makeRng } = require(path.join(tritonDir, 'desktop/tests/t3-common.js'));
const { T } = loadHtmlModule('tritos-desktop.html');
const W = (vm, r) => { const [a, b, c] = vm.getWord(r); return a + b * 19683 + c * 19683 * 19683; };
const SPRS = [[1, 'priv'], [2, 'ie'], [3, 'imask'], [4, 'ipend'], [5, 'vbr'], [6, 'ubase'], [7, 'ulimit'], [8, 'protEn'], [9, 'epc'],
  [10, 'esp'], [11, 'esr'], [12, 'ecause'], [13, 'eaddr'], [14, 'ksp'], [15, 'trapDiv0']];

const em = new T.TritonJS({ archMode: 'T3' });
const built = T.bootTritOSDesktop(em, false);
const mm = new MicroMachine(em.ramSize);
for (let i = 0; i < built.trytes.length; i++) mm.io.disk[i] = built.trytes[i];   // the OS image on the disk
for (let i = 0; i < 32; i++) mm.mem[i] = built.trytes[i];                        // stage-0 loader in RAM, as the host does
mm.pc = em.pc; mm.sp = em.sp; mm.protEn = em.protEn; mm.rf[17] = em.ulimit; mm.io.nodeId = em.nodeId;

let steps = 0, uc = 0, bad = null, irq0 = 0; const t0 = Date.now(), log = [];
function check() {
  if (em.pc !== mm.pc || em.sp !== mm.sp || em.sf !== mm.sf || em.cf !== mm.cf || em.of !== mm.of || !!em.halted !== mm.halted) return `pc ${em.pc}/${mm.pc} sp ${em.sp}/${mm.sp}`;
  for (let r = 0; r < 9; r++) if (W(em, r) !== mm.rf[r]) return 'R' + r;
  for (const [i, n] of SPRS) if (em.getSPR(i) !== mm.sprRead(i)) return `${n} ${em.getSPR(i)}/${mm.sprRead(i)}`;
  if (em.timerCount !== mm.timerCount || em.timerPeriod !== mm.timerPeriod) return 'timer';
  return null;
}
function deep(label) {
  for (let a = 0; a < em.ramSize; a++) if (em.mem[a] !== mm.mem[a]) return `${label}: RAM at ${a}`;
  for (let a = 0; a < em.vram.length; a++) if (em.vram[a] !== mm.vram[a]) return `${label}: framebuffer at ${a}`;
  for (let a = 0; a < em.disk.length; a++) if (em.disk[a] !== mm.io.disk[a]) return `${label}: disk at ${a}`;
  if (em.consoleOut !== mm.io.consoleOut) return `${label}: console`;
  for (const f of ['displayX', 'displayY', 'diskAddr', 'diskStatus', 'diskErr', 'steps', 'kbdHead', 'mouseHead', 'netTxLen'])
    if (em[f] !== mm.io[f]) return `${label}: io.${f}`;
  return null;
}
function run(n) { for (let i = 0; i < n && !bad && !em.halted; i++) {
  em.step(); uc += mm.step(); steps++; if (mm.ecause >= 7) irq0++; bad = check(); if (bad) bad = `step ${steps}: ${bad}`; } }

run(300000); if (!bad) bad = deep('after boot (300k steps)'); log.push(`boot: ${steps} steps`);
const rng = makeRng(0x13572468), keys = 'LS\nPS\nCAT HELLO\n';
for (let i = 0; i < 2000 && !bad; i++) {
  if (i % 3 === 0) { const c = keys.charCodeAt(i % keys.length); em.pushKeyEvent(c, 0); mm.io.pushKeyEvent(c, 0); }
  else { const dx = rng.int(-3, 3), dy = rng.int(-3, 3), b = (i % 20 === 0) ? 1 : 0; em.pushMouseEvent(dx, dy, b); mm.io.pushMouseEvent(dx, dy, b); }
  if (i % 50 === 49) run(1500);
}
run(20000); if (!bad) bad = deep('after 2,000 input events');
const secs = (Date.now() - t0) / 1000;
console.log(`TritOS Desktop 1.1.2 on the microcoded card: ${steps.toLocaleString()} instruction steps in lockstep, ${bad ? 'MISMATCH ' + bad : '0 mismatches'}`);
console.log(`checked every step: PC, SP, flags, R0-R8, all 15 SPRs, the timer; at boot and at the end: all ${em.ramSize.toLocaleString()} trytes of RAM, the whole framebuffer, the whole disk, console and device state`);
console.log(`${uc.toLocaleString()} µcycles = ${(uc / steps).toFixed(2)} per instruction = ${(uc / 1e7).toFixed(3)} s of card time at 10 MHz (${secs.toFixed(0)} s to simulate)`);
module.exports = { em, mm };
if (require.main === module) {
  // the screen, as the card drew it
  try { const { PNG } = require('pngjs'); } catch (_) {}
  require('fs').writeFileSync('/tmp/desktop112-fb.json', JSON.stringify(Array.from(mm.vram)));
  process.exit(bad ? 1 : 0);
}
