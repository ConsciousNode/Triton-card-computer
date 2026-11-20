// directed-fb.js: stage 2 of the Memory card, the RAM and framebuffer corners (Kehai Interim, 2026-11-18). MIT.
// Machines, one per case:
//   1. framebuffer, T3 kernel: tryte stores of values wider than 6 trits (stored truncated) and read back, word
//      stores/loads at both ends of the framebuffer, a scatter over all 7 VRAM pages, and the port-2/3/4 pixel path
//      (the Video card's J2 write) with IN 4 reading it back;
//   2. RAM rows (3^14 machine): stores and loads on both sides of every row boundary and at the last tryte;
//   3. RAM rows on a 3^15 machine (8 rows), the same, plus the last tryte of RAM;
//   4. T2: stores and loads through negative addresses (the mod 3^9 wrap), and high trits that must be ignored;
//   5. a user-mode store to a real but protected address: the write is aborted and must not reach RAM;
//   6. a port-5 fill followed by CPU reads of the filled framebuffer.
'use strict';
const { loadHtmlModule } = require(require(__dirname+'/../triton-dir.js')+'/tests/t3-common.js'); const { T } = loadHtmlModule('triton3.html');
const { MicroMachine } = require('../microsim/microsim.js');
const { ld } = require('../microsim/bare-drivers.js');
const FB = 15000000, FBN = 354294;
let seed = 4242; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const val = () => Math.floor(rnd() * 19683) - 9841;
const vec = 'H: HALT\n';
function run(name, src, { ramSize, t2 = false, sp = 4000, setup } = {}) {
  const asm = T.assemble(src + vec, { mode: 'T3' }); const mm = new MicroMachine(ramSize);
  if (t2) mm.sprWrite(0, 0);
  asm.trytes.forEach((v, i) => { mm.mem[i] = v; }); mm.sp = sp;
  for (let v = 0; v < 6; v++) { mm.mem[9000 + 3 * v] = asm.symbols.H; mm.mem[9001 + 3 * v] = 0; mm.mem[9002 + 3 * v] = 0; }
  if (setup) setup(mm);
  let st = 0; while (!mm.halted && st < 200000) { mm.step(); st++; }
  console.log(`fb probe "${name}": ${st} instructions, halted ${mm.halted}`);
}
const VBR = `${ld('R1', 9000)}\nMTSPR R1, #5\n`;
// 1. framebuffer
{ let s = VBR + `${ld('R2', FB)}\n`;
  for (const v of [9000, -9841, 365, -365, 364, 1, -1, 4000]) s += `${ld('R3', v)}\nST R3, R2, #0\nLT R4, R2, #0\nST R4, R2, #1\nLT R5, R2, #1\nADDI R2, R2, #2\n`;
  s += `${ld('R3', 123456789)}\n${ld('R2', FB + 100)}\nSW R3, R2, #0\nLW R4, R2, #0\n${ld('R2', FB + FBN - 3)}\nSW R3, R2, #0\nLW R4, R2, #0\nLT R5, R2, #2\n`;
  for (let i = 0; i < 300; i++) { const p = Math.floor(rnd() * FBN); s += `${ld('R2', FB + p)}\n${ld('R3', val())}\nST R3, R2, #0\nLT R4, R2, #0\n`; }
  for (let i = 0; i < 40; i++) s += `${ld('R1', Math.floor(rnd() * 729))}\nOUT R1, #2\n${ld('R1', Math.floor(rnd() * 486))}\nOUT R1, #3\n${ld('R1', val())}\nOUT R1, #4\nIN R6, #4\n`;
  run('framebuffer', s); }
// 2./3. RAM rows: both sides of every row boundary (T = 32k means a = (32k - 0.5) * 59049 +- ...)
for (const ramSize of [4782969, 14348907]) { let s = VBR; const top = ramSize - 1; const pts = [0, 1, 2, top, top - 1];
  for (let k = 1; k * 32 * 59049 < ramSize + 59049 * 32; k++) { const edge = Math.floor((32 * k - 0.5) * 59049); for (const d of [-1, 0, 1, 2, 30000]) pts.push(edge + d); }
  for (let k = 0; k < 60; k++) pts.push(Math.floor(rnd() * ramSize));
  for (const a of pts) if (a >= 0 && a < ramSize) s += `${ld('R2', a)}\n${ld('R3', val())}\nST R3, R2, #0\nLT R4, R2, #0\n`;
  run(`RAM rows, ramSize ${ramSize}`, s, { ramSize, sp: 9000 }); }
// 4. T2: addresses through the wrap, with junk in the high trits of the base register
{ let s = ''; for (const a of [-1, -2, -9841, -5000, -243, -244, -81, -82, -6561, 9841, 9840, 243, 244, 1, -3]) s += `LI R2, #${a}\nLI R3, #${val()}\nST R3, R2, #0\nLT R4, R2, #0\nSW R3, R2, #-10\nLW R5, R2, #-10\n`;
  run('T2 wrap', s, { t2: true, sp: 3000, setup: mm => { mm.pc = 0; } }); }
// a base register with high trits set (built in T3), then MODE -> T2: only the low 9 trits may count
{ const s = `${ld('R2', 19683 * 77 - 1)}\nLI R1, #0\nMTSPR R1, #0\nLI R3, #4321\nST R3, R2, #0\nLT R4, R2, #0\nLI R3, #-1234\nST R3, R2, #-5\nLT R5, R2, #-5\nH: HALT\n`;
  const asm = T.assemble(s, { mode: 'T3' }); const mm = new MicroMachine(); asm.trytes.forEach((v, i) => { mm.mem[i] = v; }); mm.sp = 3000;
  let st = 0; while (!mm.halted && st < 1000) { mm.step(); st++; } console.log(`fb probe "T2 high trits ignored": ${st} instructions, mem[19682] ${mm.mem[19682]}, mem[19677] ${mm.mem[19677]}`); }
// 5. a protected store to real RAM (user window [0, 5000), store at 6000): aborted, RAM untouched
run('protected store', `LI R1, #0\nMTSPR R1, #6\n${ld('R1', 5000)}\nMTSPR R1, #7\nLI R1, #1\nMTSPR R1, #8\n${VBR}${ld('R2', 6000)}\nLI R3, #777\nLI R1, #1\nMTSPR R1, #1\nST R3, R2, #0\n`, { sp: 4000 });
// 6. a port-5 fill, then CPU reads of filled pixels and one CPU store
{ let s = VBR + `${ld('R1', -200)}\nOUT R1, #5\n`; for (const p of [0, 1, 728, 729, FBN - 1, 177147]) s += `${ld('R2', FB + p)}\nLT R4, R2, #0\n`;
  s += `${ld('R2', FB + 5)}\nLI R3, #99\nST R3, R2, #0\nLT R4, R2, #0\n`; run('fill', s); }
