// directed-prot.js: the address check's corners, one fault per machine. User window [0, 5000) with PROT_EN on:
// a word load past the top (EADDR = ULIMIT, the max() rule), a load below the base, a load far above, a PUSH that
// crosses ULIMIT, and in kernel mode a word load straddling the end of RAM (EADDR = RAMSIZE) and one at -1.
'use strict';
const { loadHtmlModule } = require(require(__dirname+'/../triton-dir.js')+'/tests/t3-common.js'); const { T } = loadHtmlModule('triton3.html');
const { MicroMachine } = require('../microsim/microsim.js');
const { ld } = require('../microsim/bare-drivers.js');
const setup = `LI R1, #0\nMTSPR R1, #6\n${ld('R1', 5000)}\nMTSPR R1, #7\nLI R1, #1\nMTSPR R1, #8\n${ld('R1', 9000)}\nMTSPR R1, #5\n`;
const user = `LI R1, #1\nMTSPR R1, #1\n`;
const top = new MicroMachine().ramSize;
const cases = [
  ['word load ending past ULIMIT', `${setup}${ld('R2', 4999)}\n${user}LW R3, R2, #0\n`],
  ['load below UBASE', `${setup}LI R2, #-5\n${user}LT R3, R2, #0\n`],
  ['load far above', `${setup}${ld('R2', 600000)}\n${user}LT R3, R2, #0\n`],
  ['push across ULIMIT', `${setup}${ld('R2', 5001)}\n${user}PUSH R2\n`, 5001],
  ['kernel word load straddling end of RAM', `${setup}${ld('R2', top - 1)}\nLW R3, R2, #0\n`],
  ['kernel load at -1', `${setup}LI R2, #-1\nLT R3, R2, #0\n`],
  ['user load inside framebuffer is still protected', `${setup}${ld('R2', 15000010)}\n${user}LT R3, R2, #0\n`],
  ['kernel load inside framebuffer is fine', `${setup}${ld('R2', 15000010)}\nLT R3, R2, #0\n`],
  // stage 1b: ULIMIT values whose "minus 2" borrows through several slices (UL2 shadow lookahead), word stores at the edge
  ...[6926, 265721, 7174454].flatMap(ul => [-3, -2].map(d => [`word store at ULIMIT${d}, ULIMIT ${ul}`,
    `${setup.replace(`${ld('R1', 5000)}`, ld('R1', ul))}${ld('R2', ul + d)}\nLI R3, #7\n${user}SW R3, R2, #0\n`])),
];
for (const [name, body, sp] of cases) {
  const asm = T.assemble(body + 'H: HALT\n', { mode: 'T3' }); const mm = new MicroMachine();
  asm.trytes.forEach((v, i) => { mm.mem[i] = v; }); mm.sp = sp || 4000; for (const v of [12, 15]) { mm.mem[9000 + v] = asm.symbols.H; mm.mem[9001 + v] = 0; mm.mem[9002 + v] = 0; }
  let st = 0; while (!mm.halted && st < 500) { mm.step(); st++; }
  console.log(`prot probe "${name}": ${st} instructions, ECAUSE ${mm.sprRead(12)}, EADDR ${mm.faultAddr}`);
}
