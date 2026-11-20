// Directed T2 test: code runs straight across the 9-trit PC wrap (+9841 -> -9841, physically contiguous at 9,842),
// with a CALL/RET pair and loads through a negative address. Emulator vs microsim, every step.
const { loadHtmlModule } = require(require(__dirname+'/../triton-dir.js')+'/tests/t3-common.js'); const { T } = loadHtmlModule('triton3.html');
const { MicroMachine } = require('./microsim.js');
const body = ['LI R0, #5', 'LI R1, #-7', 'ADD R2, R0, R1', 'PUSH R2', 'PUSH R0', 'POP R3', 'MUL R4, R2, R3', 'ST R4, R1, #-9000',
  'LT R5, R1, #-9000', 'CALL #-9833', 'SHLI R6, R5, #3', 'SW R6, R0, #-500', 'LW R7, R0, #-500', 'HALT', 'NEG R6, R6', 'RET'];
const asm = T.assemble(body.join('\n'), { mode: 'T3' }).trytes, base = 9822; // 16 instructions: 9822..9853 phys
const em = new T.TritonJS({ archMode: 'T3' }), mm = new MicroMachine(em.ramSize);
em.setSPR(0, 0); mm.sprWrite(0, 0); em.pc = mm.pc = base; em.sp = mm.sp = 3000; // (SP wrapping is left to diff.js: here it would land on the code)
asm.forEach((v, i) => { em.mem[base + i] = v; mm.mem[base + i] = v; });
const w = (vm, r) => { const [a, b, c] = vm.getWord(r); return a + b * 19683 + c * 19683 * 19683; };
let st = 0, bad = null, pcs = [];
while (!em.halted && st < 100) { em.step(); mm.step(); st++; pcs.push(em.pc);
  const d = []; if (em.pc !== mm.pc) d.push(`pc ${em.pc}/${mm.pc}`); if (em.sp !== mm.sp) d.push(`sp ${em.sp}/${mm.sp}`);
  for (let r = 0; r < 8; r++) if (w(em, r) !== mm.rf[r]) d.push(`R${r}`); if (d.length) { bad = `step ${st}: ${d.join(' ')}`; break; } }
for (let a = 0; a < 19683 && !bad; a++) if (em.mem[a] !== mm.mem[a]) bad = `mem ${a}`;
if (process.env.TRACE) console.log(pcs.join(" "));
console.log(`T2 wrap test: ${st} steps, PC went ${Math.max(...pcs)} -> ${Math.min(...pcs)}, final SP ${em.sp}, R7 ${w(em, 7)}; ${bad ? 'MISMATCH ' + bad : '0 mismatches'}; halted ${!!em.halted}/${mm.halted}`);
