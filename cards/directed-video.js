// directed-video.js: ports 2-5 corners for the Video card (Kehai Interim, 2026-11-18). MIT.
// T3: X/Y wrap (negative, past 729/486, extremes), IN 2/3 after each; OUT 4 with values wider than 6 trits and IN 4 back;
// a CPU store into the framebuffer read back through IN 4 (the J2 read path); IN 5; a fill, then IN 4 here and there.
// T2: X/Y mod 243, 3-trit pixels from wider values, a T2 fill (59,049 pixels). Mode switch: X set in T3 (700), pixel
// written in T2 (index Y * 243 + 700).
'use strict';
const { loadHtmlModule } = require(require(__dirname+'/../triton-dir.js')+'/tests/t3-common.js'); const { T } = loadHtmlModule('triton3.html');
const { MicroMachine } = require('../microsim/microsim.js');
const { ld } = require('../microsim/bare-drivers.js');
let seed = 99; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const val = () => Math.floor(rnd() * 19683) - 9841;
function run(name, src, t2) { const asm = T.assemble(src + 'HALT\n', { mode: 'T3' }); const mm = new MicroMachine(); if (t2) mm.sprWrite(0, 0);
  asm.trytes.forEach((v, i) => { mm.mem[i] = v; }); mm.sp = 4000; let st = 0; while (!mm.halted && st < 100000) { mm.step(); st++; }
  console.log(`video probe "${name}": ${st} instructions, halted ${mm.halted}`); }
const xy = (x, y) => `${ld('R1', x)}\nOUT R1, #2\nIN R2, #2\n${ld('R1', y)}\nOUT R1, #3\nIN R3, #3\n`;
let s = '';
for (const [x, y] of [[0, 0], [728, 485], [729, 486], [-1, -1], [-730, -487], [9841, 9841], [-9841, -9841], [364, 243], [100, 200]])
  s += xy(x, y) + `${ld('R1', val())}\nOUT R1, #4\nIN R4, #4\n`;
for (let i = 0; i < 30; i++) { const x = Math.floor(rnd() * 729), y = Math.floor(rnd() * 486);
  s += xy(x, y) + `${ld('R5', 15000000 + y * 729 + x)}\n${ld('R6', val())}\nST R6, R5, #0\nIN R4, #4\n${ld('R1', val())}\nOUT R1, #4\nIN R4, #4\nLT R7, R5, #0\n`; }
s += `${ld('R1', -300)}\nOUT R1, #5\nIN R4, #5\n` + xy(5, 7) + 'IN R4, #4\n' + xy(728, 485) + 'IN R4, #4\n';
s += xy(700, 100) + `LI R1, #0\nMTSPR R1, #0\n${ld('R1', 9000)}\nOUT R1, #4\nIN R4, #4\nIN R2, #2\n`;
run('T3 ports, CPU stores, fill, mode switch', s);
let t = '';
for (const [x, y] of [[0, 0], [242, 242], [243, 243], [-1, -1], [9841, -9841], [121, 7]]) t += `LI R1, #${x}\nOUT R1, #2\nIN R2, #2\nLI R1, #${y}\nOUT R1, #3\nIN R3, #3\nLI R1, #${val()}\nOUT R1, #4\nIN R4, #4\n`;
t += `LI R1, #-5000\nOUT R1, #5\nIN R4, #5\nLI R1, #3\nOUT R1, #2\nIN R4, #4\n`;
run('T2 ports and fill', t, true);
