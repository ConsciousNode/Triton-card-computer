const path=require(__dirname+'/../triton-dir.js')+''; const { loadHtmlModule } = require(path+'/tests/t3-common.js'); const { T } = loadHtmlModule('triton3.html');
const { MicroMachine, word3 } = require('./microsim.js');
for (const op of ['BFILL', 'BCOPY']) {
  const src = `LI R0, #6000\nLI R1, #5\nLI R2, #400\nLI R3, #3000\n${op} R0, ${op==='BFILL'?'R1':'R3'}, R2\nHALT\nADDI R7, R7, #1\nIRET`;
  const asm = T.assemble(src, { mode: 'T3' }).trytes;
  const em = new T.TritonJS({ archMode: 'T3' }), mm = new MicroMachine(em.ramSize);
  em.sp = 50000; mm.sp = 50000; asm.forEach((v, i) => { em.setMem(i, v); mm.mem[i] = v; });
  for (let v = 0; v < 12; v++) { const w = word3(12); for (let j = 0; j < 3; j++) { em.setMem(9000 + 3*v + j, w[j]); mm.mem[9000 + 3*v + j] = w[j]; } }
  for (const [i, v] of [[5, 9000], [3, 1], [2, 1]]) { em.setSPR(i, v); mm.sprWrite(i, v); }
  em.timerPeriod = 7; mm.timerPeriod = 7; let bad = 0, st = 0, uc = 0;
  while (!em.halted && st < 5000) { em.step(); uc += mm.step(); st++; const r = [0,1,2,7].map(k => { const [a,b,c] = em.getWord(k); return a + b*19683 + c*19683*19683 - mm.rf[k]; });
    if (em.pc !== mm.pc || r.some(x => x) || em.sp !== mm.sp || em.ipend !== mm.ipend) { bad++; console.log('diverge at', st); break; } }
  const [r7] = em.getWord(7);
  console.log(op, '400 trytes with a timer IRQ every 7 steps:', st, 'steps,', mm.irqTaken, 'interrupts taken mid-copy (handler count R7 =', r7 + '),', bad ? 'MISMATCH' : '0 mismatches', ', µcycles', uc);
}
