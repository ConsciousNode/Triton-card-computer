// directed-fetchfault.js: flags change on the instruction right before a fetch that faults (JALR to an unmapped
// address). The shadow must still be taken on that faulting fetch. Positive control for SHADOW_GATED_BY_ABORT.
'use strict';
const { loadHtmlModule } = require(require(__dirname+'/../triton-dir.js')+'/tests/t3-common.js'); const { T } = loadHtmlModule('triton3.html');
const { MicroMachine } = require('../microsim/microsim.js');
const { ld } = require('../microsim/bare-drivers.js');
const src = `${ld('R1', 9000)}\nMTSPR R1, #5\nLI R1, #-5\nCMPI R1, #0\n${ld('R2', 20000000)}\nJALR R3, R2, #0\nH: HALT\n`;
const asm = T.assemble(src, { mode: 'T3' });
const mm = new MicroMachine(); asm.trytes.forEach((v, i) => { mm.mem[i] = v; }); mm.sp = 4000000;
mm.mem[9012] = asm.symbols.H; mm.mem[9013] = 0; mm.mem[9014] = 0;           // BAD_ADDR vector -> HALT
let st = 0; while (!mm.halted && st < 1000) { mm.step(); st++; }
console.log(`fetch-fault probe: ${st} instructions, halted ${mm.halted}, ECAUSE ${mm.sprRead(12)}`);
