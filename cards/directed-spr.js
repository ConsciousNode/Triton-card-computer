// directed-spr.js: MTSPR/MFSPR on every latch SPR (and a register one) with awkward values: 0, ±1, values that need
// mod 32 (negative, big), and nonzero tests across all three trytes. Interrupts stay masked; PRIV is written last.
'use strict';
const { loadHtmlModule } = require(require(__dirname+'/../triton-dir.js')+'/tests/t3-common.js'); const { T } = loadHtmlModule('triton3.html');
const { MicroMachine } = require('../microsim/microsim.js');
const { ld } = require('../microsim/bare-drivers.js');
const vals = [0, 1, -1, 37, -40, 31, 32, -33, 19683 * 5 + 7, -(19683 * 19683) * 2 + 3, 1000000007, -999999999];
let src = '';
for (const i of [3, 4, 8, 15, 2, 0, 9]) for (const v of vals) { if (i === 0 && v === 0) continue; if (i === 2 && v !== 0) continue;
  src += `${ld('R1', v)}\nMTSPR R1, #${i}\nMFSPR R2, #${i}\nOUT R2, #1\nMFSPR R3, #3\nMFSPR R4, #4\n`; }
src += `${ld('R1', 5)}\nMTSPR R1, #1\nHALT\n`;          // PRIV = 1 last: the HALT then traps as privileged; fine, the run stops at the step limit
const asm = T.assemble(src, { mode: 'T3' });
const mm = new MicroMachine(); asm.trytes.forEach((v, i) => { mm.mem[i] = v; }); mm.sp = 4000000;
let st = 0; while (!mm.halted && st < 3000) { mm.step(); st++; }
console.log(`SPR probe: ${st} instructions, console ${mm.io.consoleOut.slice(0, 60)}…`);
