// Directed: in T2 mode IN/OUT are NOT privileged (Triton 2.1 had no privilege), even after PRIV is set to user.
// A T2 program drops to user mode with MTSPR #1, then writes to the console and reads the step counter.
const { loadHtmlModule } = require(require(__dirname+'/../triton-dir.js')+'/tests/t3-common.js'); const { T } = loadHtmlModule('triton3.html');
const { MicroMachine } = require('./microsim.js');
const asm = T.assemble('LI R1, #1\nMTSPR R1, #1\nLI R2, #75\nOUT R2, #0\nIN R3, #6\nOUT R3, #1\nHALT', { mode: 'T3' }).trytes;
const em = new T.TritonJS({ archMode: 'T3' }), mm = new MicroMachine(em.ramSize);
em.setSPR(0, 0); mm.sprWrite(0, 0); em.sp = mm.sp = 3000; asm.forEach((v, i) => { em.mem[i] = v; mm.mem[i] = v; });
let st = 0, bad = null;
while (!em.halted && st < 50) { em.step(); mm.step(); st++;
  if (em.pc !== mm.pc || em.priv !== mm.priv || em.consoleOut !== mm.io.consoleOut) { bad = `step ${st}: pc ${em.pc}/${mm.pc} priv ${em.priv}/${mm.priv} console "${em.consoleOut}"/"${mm.io.consoleOut}"`; break; } }
console.log(`T2 user-mode I/O test: ${st} steps, priv ${em.priv}, console "${em.consoleOut}"; ${bad ? 'MISMATCH ' + bad : '0 mismatches'}`);
process.exit(bad ? 1 : 0);
