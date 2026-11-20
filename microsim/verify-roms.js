// verify-roms.js: prove the exported ROM images are complete. Builds a machine from the image bytes alone (roms.js
// romMachine: control store, dispatch and ALU decoded from ../roms/*.bin) and checks it three ways:
//   1. the ALU slice table, exhaustively against the arithmetic definition (every valid slice input, every function)
//   2. the random-program differential against the emulator (diff.js with ROMS=1)
//   3. TritOS 2.1 booting and self-hosting (boot-tritos21.js with ROMS=1)
'use strict';
const path = require('path'), fs = require('fs'), { execFileSync } = require('child_process');
const dir = path.join(__dirname, '../roms');
const alu = fs.readFileSync(path.join(dir, 'alu.bin'));
const { ALU_FNS } = require('./microsim.js');
const bal = (x, m, h) => { let r = ((x % m) + m) % m; return r > h ? r - m : r; };
const tr = v => [0, 1, 2].map(i => { const d = bal(Math.floor((v + 13) / 3 ** i) % 3 - 1 + 0, 3, 1); return d; });
const toT = (v, n) => { const t = []; for (let i = 0; i < n; i++) { const d = bal(v, 3, 1); t.push(d); v = (v - d) / 3; } return t; };
const e1 = t => t === 1 ? 1 : t === -1 ? 2 : 0, d1 = b => b === 1 ? 1 : b === 2 ? -1 : 0;
const enc = t => t.reduce((a, d, i) => a | e1(d) << 2 * i, 0), dec = (x, n) => Array.from({ length: n }, (_, i) => d1((x >> 2 * i) & 3));
// independent definitions (not the LUT): per-trit functions and the slice adder
const f = { MIN: (x, y) => Math.min(x, y), MAX: (x, y) => Math.max(x, y), CON: (x, y) => x === y ? x : 0, ANY: (x, y) => Math.sign(x + y), XOR: (x, y) => bal(x + y, 3, 1) };
let checked = 0, bad = 0;
for (let fi = 0; fi < ALU_FNS.length; fi++) for (let neg = 0; neg < 2; neg++) for (let a = -13; a <= 13; a++) for (let b = -13; b <= 13; b++) for (let c = -1; c <= 1; c++) {
  const fn = ALU_FNS[fi], B = neg ? -b : b, ta = toT(a, 3), tb = toT(B, 3); let r, co = 0;
  if (fn === 'ADD') { const s = a + B + c; r = bal(s, 27, 13); co = (s - r) / 27; }
  else if (fn === 'INCA') { const s = a + c; r = bal(s, 27, 13); co = (s - r) / 27; }
  else if (fn === 'PASSA') r = a; else if (fn === 'PASSB') r = B; else if (fn === 'NEGA') r = -a;
  else if (fn === 'UNARY') r = ta.reduce((acc, x, i) => acc + tb[x + 1] * 3 ** i, 0);
  else r = ta.reduce((acc, x, i) => acc + f[fn](x, tb[i]) * 3 ** i, 0);
  const d = alu[enc(toT(a, 3)) | enc(toT(b, 3)) << 6 | e1(c) << 12 | fi << 14 | neg << 18];
  const rr = dec(d & 63, 3).reduce((acc, x, i) => acc + x * 3 ** i, 0), cc = d1(d >> 6);
  checked++; if (rr !== r || cc !== co) bad++; }
console.log(`1. ALU slice table: ${checked.toLocaleString()} slice inputs x functions checked against the arithmetic definitions, ${bad} wrong`);
const run = (script, args) => execFileSync('node', [path.join(__dirname, script), ...args], { env: { ...process.env, ROMS: '1' }, encoding: 'utf8', maxBuffer: 1e8 });
const d = run('diff.js', ['', process.argv[2] || '300']).split('\n').filter(l => /^programs|^MISMATCH|^I\/O|^T2/.test(l));
console.log('2. differential, machine built from the ROM images:\n   ' + d.join('\n   '));
const b = run('boot-tritos21.js', []).split('\n').filter(l => /^TritOS|^fixed/.test(l));
console.log('3. TritOS 2.1 from the ROM images:\n   ' + b.join('\n   '));
process.exit(bad ? 1 : 0);
