// directed-bcfault.js: a BCOPY and a BFILL running off the end of RAM, so a memory write faults in the same cycle
// as a register write (the count). The register write must not happen. Positive control for ABORT on the Registers card.
'use strict';
const { loadHtmlModule } = require(require(__dirname+'/../triton-dir.js')+'/tests/t3-common.js'); const { T } = loadHtmlModule('triton3.html');
const { MicroMachine } = require('../microsim/microsim.js');
const { ld } = require('../microsim/bare-drivers.js');
const mm = new MicroMachine(); const top = mm.ramSize;
const which = process.env.BCF || 'bfill';
const src = `${ld('R1', 9000)}\nMTSPR R1, #5\n` + (which === 'bcopy' ? `${ld('R4', 20000)}\n${ld('R5', top - 3)}\nLI R6, #8\nBCOPY R4, R5, R6\n` : '') + `${ld('R4', top - 2)}\nLI R5, #5\nLI R6, #9\nBFILL R4, R5, R6\nH: HALT\n`;
const asm = T.assemble(src, { mode: 'T3' }); asm.trytes.forEach((v, i) => { mm.mem[i] = v; }); mm.sp = 4000000;
mm.mem[9012] = asm.symbols.H; mm.mem[9013] = 0; mm.mem[9014] = 0;            // BAD_ADDR vector -> HALT
let st = 0; while (!mm.halted && st < 2000) { mm.step(); st++; }
console.log(`block-move fault probe: ${st} instructions, halted ${mm.halted}, R6 ${mm.rf[6]}`);
