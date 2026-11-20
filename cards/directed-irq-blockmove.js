// directed-irq-blockmove.js: timer interrupts landing on block-move step boundaries (the RETIRE redirect).
// A BCOPY of 3000 trytes and a BFILL of 3000, with the step timer firing every 37 steps; the handler just IRETs.
'use strict';
const { loadHtmlModule } = require(require(__dirname+'/../triton-dir.js')+'/tests/t3-common.js'); const { T } = loadHtmlModule('triton3.html');
const { MicroMachine } = require('../microsim/microsim.js');
const { ld } = require('../microsim/bare-drivers.js');
const src = `${ld('R1', 9000)}\nMTSPR R1, #5\nLI R1, #1\nMTSPR R1, #3\nLI R1, #37\nOUT R1, #9\nLI R1, #1\nMTSPR R1, #2
${ld('R4', 20000)}\n${ld('R5', 30000)}\n${ld('R6', 3000)}\nBCOPY R4, R5, R6\n${ld('R4', 40000)}\nLI R5, #-77\n${ld('R6', 3000)}\nBFILL R4, R5, R6\nLI R1, #0\nMTSPR R1, #2\nHALT
ISR: IRET\n`;
const asm = T.assemble(src, { mode: 'T3' });
const mm = new MicroMachine(); asm.trytes.forEach((v, i) => { mm.mem[i] = v; }); mm.sp = 4000000;
mm.mem[9021] = asm.symbols.ISR; mm.mem[9022] = 0; mm.mem[9023] = 0;           // vector 7 (timer) -> ISR
let st = 0; while (!mm.halted && st < 200000) { mm.step(); st++; }
console.log(`IRQ/block-move probe: ${st} instructions, halted ${mm.halted}, interrupts taken ${mm.irqTaken}`);
