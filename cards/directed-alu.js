// directed-alu.js: a workload of big-operand MUL/DIV/MOD/shifts/TUNARY on the microsim (no emulator needed: the
// microsim was proven against the emulator separately; here it is the reference for the ALU card).
'use strict';
const { loadHtmlModule } = require(require(__dirname+'/../triton-dir.js')+'/tests/t3-common.js'); const { T } = loadHtmlModule('triton3.html');
const { MicroMachine } = require('../microsim/microsim.js');
const { ld } = require('../microsim/bare-drivers.js');
let seed = 777; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const big = () => Math.floor((rnd() - 0.5) * 2 * 3812798742493 * (rnd() < 0.5 ? 1 : 1e-6));
const ops = ['MUL R3, R1, R2', 'DIV R3, R1, R2', 'MOD R3, R1, R2', 'SHL R3, R1, R4', 'SHR R3, R1, R4', 'TUNARY R3, R1, #' + 0, 'ADD R3, R1, R2', 'SUB R3, R1, R2', 'MULI R3, R1, #9841'];
let src = '';
for (let i = 0; i < 400; i++) { const op = ops[Math.floor(rnd() * ops.length)].replace('#0', '#' + (Math.floor(rnd() * 19683) - 9841));
  src += `${ld('R1', big())}\n${ld('R2', big() || 1)}\nLI R4, #${Math.floor(rnd() * 30) - 2}\n${op}\n`; }
src += 'HALT\n';
const code = T.assemble(src, { mode: 'T3' }).trytes;
const mm = new MicroMachine(); code.forEach((v, i) => { mm.mem[i] = v; }); mm.sp = 4000000;
let st = 0; while (!mm.halted && st < 1e6) { mm.step(); st++; }
console.log(`directed ALU workload: ${st} instructions, halted ${mm.halted}`);
