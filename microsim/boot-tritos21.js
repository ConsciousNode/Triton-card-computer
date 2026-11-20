// boot-tritos21.js: boot the original TritOS (Triton 2.1) on the microcoded card, in T2 mode, in lockstep with the
// emulator (triton3.html in T2 mode), comparing architected state after every instruction.
//   1. the scripted shell session from the Triton repo's own test (tests/t3-03-t2compat.js, part 2)
//   2. the self-hosting fixed point: TritOS assembles its own source from disk ('asm'), on the microcode
'use strict';
const path = require('path');
const { MicroMachine } = require('./microsim.js');
const tritonDir = process.argv[2] || require(__dirname+'/../triton-dir.js')+'';
const { loadHtmlModule } = require(path.join(tritonDir, 'tests/t3-common.js'));
const { T } = loadHtmlModule('triton3.html');
const built = T.assemble(T.TRITOS_SRC, { mode: 'T2' });
const W = (vm, r) => { const [a, b, c] = vm.getWord(r); return a + b * 19683 + c * 19683 * 19683; };

function session(name, script, maxSteps, withSource) {
  const em = new T.TritonJS({ archMode: 'T2' }), mm = process.env.ROMS ? require('./roms.js').romMachine(require('path').join(__dirname, '../roms'), em.ramSize) : new MicroMachine(em.ramSize);
  mm.sprWrite(0, 0); em.loadProgram(built.trytes, 0); built.trytes.forEach((v, i) => { mm.mem[i] = v; });
  mm.pc = em.pc; mm.sp = em.sp;
  if (withSource) for (let i = 0; i <= T.TRITOS_SRC.length; i++) {
    const ch = i < T.TRITOS_SRC.length ? T.balRem(T.TRITOS_SRC.charCodeAt(i), 19683, 9841) : 0; em.disk[500 + i] = ch; mm.io.disk[500 + i] = ch; }
  em.pushInputString(script); for (const c of script) mm.io.pushInputChar(c.charCodeAt(0));
  let steps = 0, uc = 0, bad = null; const t0 = Date.now();
  while (!em.halted && steps < maxSteps) {
    em.step(); uc += mm.step(); steps++;
    if (em.pc !== mm.pc || em.sp !== mm.sp || em.sf !== mm.sf || em.cf !== mm.cf || em.of !== mm.of || !!em.halted !== mm.halted) bad = 'pc/sp/flags';
    else for (let r = 0; r < 9; r++) if (W(em, r) !== mm.rf[r]) { bad = 'R' + r; break; }
    if (!bad && (steps & 1023) === 0 && em.consoleOut !== mm.io.consoleOut) bad = 'console';
    if (bad) { bad = `step ${steps}: ${bad} (pc ${em.pc} vs ${mm.pc})`; break; }
  }
  if (!bad && em.consoleOut !== mm.io.consoleOut) bad = 'console at end';
  for (let a = 0; a < 19683 && !bad; a++) if (em.mem[a] !== mm.mem[a]) bad = `memory at ${a}`;
  for (let a = 0; a < em.vram.length && !bad; a++) if (em.vram[a] !== mm.vram[a]) bad = `vram at ${a}`;
  for (let a = 0; a < em.disk.length && !bad; a++) if (em.disk[a] !== mm.io.disk[a]) bad = `disk at ${a}`;
  const secs = (Date.now() - t0) / 1000;
  console.log(`${name}: ${steps.toLocaleString()} instruction steps in lockstep, ${bad ? 'MISMATCH ' + bad : '0 mismatches'}; ` +
    `halted ${!!em.halted}; ${uc.toLocaleString()} µcycles = ${(uc / steps).toFixed(2)} per instruction = ${(uc / 1e7).toFixed(3)} s of card time at 10 MHz (${secs.toFixed(0)} s to simulate)`);
  return { em, mm, bad };
}

const s1 = session('TritOS 2.1 scripted shell session', 'list\nrun calc\n10T+11\nq\ndraw\ngame\nsave MYFILE BALANCED_TERNARY_OK\nreboot\nlist\ntype MYFILE\nquit\n', 500000, false);
console.log('--- console (card) ---\n' + s1.mm.io.consoleOut.slice(0, 1400) + (s1.mm.io.consoleOut.length > 1400 ? '\n[...]' : '') + '\n---');
const s2 = session('TritOS 2.1 self-hosting (asm of its own source)', 'asm\nquit\n', 6000000, true);
const n = s2.mm.mem[3198]; let same = n === built.length;
for (let i = 0; i < n && same; i++) if (s2.mm.mem[6000 + i] !== built.trytes[i]) same = false;
console.log(`fixed point on the card: OS assembled ${n} trytes; ${same ? 'byte-identical to the OS that was running' : 'DIFFERS from the running OS'}`);
process.exit(s1.bad || s2.bad || !same ? 1 : 0);
