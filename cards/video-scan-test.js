// video-scan-test.js: the Video card's scan-out (stage 2), whole frames, slot by slot (Kehai Interim, 2026-11-18). MIT.
// The card runs alone on its 40 MHz slot clock with the CPU idle (or, in "fill", one OUT 5). J2 is played as the
// Memory card does it (VRAM-S in the declared layout, SO one slot after SA). Every slot's outputs are captured:
// HSYNC, VSYNC and the 12 DAC drive bits. The check is independent of the card's tables:
//   - VESA 800x600@60 timing from the card's own sync pulses: HSYNC every 1056 slots, 128 wide; VSYNC every 628
//     lines, 4 lines wide;
//   - every picture pixel, anchored on the VSYNC edge (row r, column c sits at VSYNC + (57 + r - 601) * 1056 + 35 + c),
//     against the emulator's renderDisplay rules: T3 PALETTE_729 (2 trits a channel, levels 0..8); T2 PALETTE_27
//     (one trit a channel at 28/132/242, the picture 3x wide and 2x tall, values outside -13..13 black), mapped to
//     the nearest of the DAC's 9 levels (the declared deviation, VIDEO-CARD.md);
//   - every slot outside the picture drives black (all 12 bits 0).
// Scenarios: t3, t2 (random pictures), desktop, tritos (the real framebuffer after a boot), starve (worst-case CPU
// writes from wr-density.js, 176 slots a line, front-loaded), overload (CPU writes in every strobe half: more than any
// program can make; the fetch must fall short, so this one is expected to FAIL: a positive control), fill (an OUT 5
// while the picture is being scanned).
'use strict';
const fs = require('fs'), path = require('path');
const { build, cardWord } = require('./video-card.js');
const V = require('./video-tables.js');
const { P } = require('./parts.js');
const { decodeWord } = require('../microsim/roms.js');
const { MicroMachine, WORD_BITS } = require('../microsim/microsim.js');
const ROMS = path.join(__dirname, '../roms');
const chips = Array.from({ length: Math.ceil(WORD_BITS / 8) }, (_, k) => fs.readFileSync(path.join(ROMS, `cs${k}.bin`)));
const cs = Buffer.alloc(1 << 19); let idleUA = -1, outUA = -1;
for (let w = 0; w < 1024; w++) { let b = 0n; for (let k = 0; k < chips.length; k++) b |= BigInt(chips[k][w]) << BigInt(8 * k); let mu; try { mu = decodeWord(b); } catch { continue; } cs[w] = cardWord(mu); if (idleUA < 0 && cs[w] === 7) idleUA = w; if (outUA < 0 && mu.IO === 'OUT') outUA = w; }
const which = process.argv[2] || 't3', MUT = process.env.VID_MUTANT;
const toT = (v, n) => { const t = []; let x = v; for (let i = 0; i < n; i++) { let r = ((x % 3) + 3) % 3; if (r === 2) r = -1; t.push(r); x = (x - r) / 3; } return t; };
const FB_SIZE = V.FB_SIZE; const sumT = (t, lo, hi) => { let r = 0; for (let i = hi - 1; i >= lo; i--) r = 3 * r + t[i]; return r; };
const fbLoc = p => { const t = toT(V.FB_BASE + p, 27); return (sumT(t, 10, 16) - 254) * 65536 + (sumT(t, 5, 10) + 128) * 256 + sumT(t, 0, 5) + 128; };
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
// --- the picture to show ---
let vram = new Int16Array(FB_SIZE), mode = 1;
if (which === 't2') { mode = 0; for (let p = 0; p < FB_SIZE; p++) vram[p] = p < 59049 ? Math.floor(rnd() * 27) - 13 : Math.floor(rnd() * 729) - 364; for (let k = 0; k < 500; k++) vram[Math.floor(rnd() * 59049)] = Math.floor(rnd() * 729) - 364; }
else if (which === 'desktop' || which === 'tritos') {
  const proto = MicroMachine.prototype, step = proto.step; let mm = null; proto.step = function () { mm = this; return step.call(this); };
  process.argv[2] = require(__dirname+'/../triton-dir.js')+''; process.argv.length = 3; const log = console.log; console.log = () => {};
  const ex = process.exit; process.exit = () => { throw { bootDone: 1 }; };   // the boot scripts exit when done
  try { require(which === 'desktop' ? '../microsim/boot-desktop.js' : '../microsim/boot-tritos21.js'); } catch (e) { if (!e.bootDone) throw e; }
  process.exit = ex; console.log = log; proto.step = step;
  vram = Int16Array.from(mm.vram); mode = mm.mode; console.log(`${which}: framebuffer from the boot, mode T${mode ? 3 : 2}, ${vram.filter(v => v).length} non-zero pixels`); }
else for (let p = 0; p < FB_SIZE; p++) vram[p] = Math.floor(rnd() * 729) - 364;
// --- expected DAC levels per picture pixel [B, G, R], from the emulator's rules ---
const expLv = (r, c, vr) => { if (mode) { const t = toT(vr[r * 729 + c], 6); return [t[0] + 3 * t[1] + 4, t[2] + 3 * t[3] + 4, t[4] + 3 * t[5] + 4]; }
  const v = vr[(r >> 1) * 243 + Math.floor(c / 3)]; if (v < -13 || v > 13) return [0, 0, 0]; const t = toT(v, 3); return t.map(x => V.near9(V.LV3[x + 1])); };
const lvOf = (d, ch) => { const b = (d >> (4 * ch)) & 15; return 3 * ((b & 1) + ((b >> 1) & 1)) + ((b >> 2) & 1) + ((b >> 3) & 1); };
// --- the card and J2 ---
const card = build(cs, MUT).check(); const chip = r => card.chips.find(c => c.ref === r);
console.log(`Video card (stages 1+2): ${card.chips.length} chips${MUT ? ', MUTANT ' + MUT : ''}; scenario ${which}`);
const vramS = new Uint16Array(1 << 19); for (let p = 0; p < FB_SIZE; p++) if (vram[p]) vramS[fbLoc(p)] = V.encRails(vram[p], 8);
for (const c of card.chips) if (c.q) c.q = []; chip('U10').q = [0, 0, 0, 0, 1, 0, 0, 0, 0];
const w = new Map([['SCLK', 0], ['RESET', 0], ['MODE', mode], ['VBUSY', 0], ['/CEDGE', 1]]); for (let i = 0; i < 10; i++) w.set(`UA${i}`, (idleUA >> i) & 1); for (let i = 0; i < 6; i++) w.set(`PORT${i}`, 1);
for (let k = 0; k < 27; k++) { w.set(`D${k}+`, 0); w.set(`D${k}-`, 0); }
const setUA = ua => { for (let i = 0; i < 10; i++) w.set(`UA${i}`, (ua >> i) & 1); card.settle(w); P.ALVCH16823.clock(chip('U2'), p => card.v.get(chip('U2').pins[p])); };
setUA(idleUA);
let SO = 0, s = 0; const NS = +(process.env.NSLOTS || 640000) + (which === 'fill' ? 2 * 663168 : 0); const cap = new Uint16Array(NS); let writes = 0, fillOp = null;
const vbusyAt = s => { const q = s % 4; if (which === 'overload') return q >= 2 ? 1 : 0; if (which === 'starve') return q >= 2 && (s % 1056) < 352 ? 1 : 0; return 0; };
const t0 = Date.now(), LBUF = [chip('U106'), chip('U107')];
function slot() { w.set('/CEDGE', s % 4 === 3 ? 0 : 1); w.set('VBUSY', vbusyAt(s)); for (let i = 0; i < 12; i++) w.set(`SO${i}`, (SO >> i) & 1);
  const v = card.settle(w); let sa = 0; for (let i = 0; i < 19; i++) sa += v.get(`SA${i}`) * 2 ** i; const soNext = vramS[sa];
  if (v.get('/SWR') === 0) { let si = 0; for (let i = 0; i < 12; i++) si += v.get(`SI${i}`) * 2 ** i; vramS[sa] = si; writes++; }
  let d = 0; for (let i = 0; i < 12; i++) d |= v.get(`DAC${i}`) << i; cap[s] = d | v.get('HSYNC') << 12 | v.get('VSYNC') << 13;
  for (const c of LBUF) P[c.part].write(c, p => v.get(c.pins[p]));   // the line buffers write at the slot edge
  for (const c of card.chips) if (P[c.part].reg && c.ref !== 'U2') P[c.part].clock(c, p => v.get(c.pins[p]));
  SO = soNext; s++; return v; }
// fill: an OUT 5 at slot 100 000 (mid-picture), colour 200; the CPU then waits on READY
let fillStart = -1, fillEnd = -1; const FILLV = 200;
while (s < NS) {
  if (which === 'fill' && s === 100000) { fillStart = s; setUA(outUA); for (let i = 0; i < 6; i++) w.set(`PORT${i}`, (5 >> i) & 1); toT(FILLV, 27).forEach((x, k) => { w.set(`D${k}+`, x === 1 ? 1 : 0); w.set(`D${k}-`, x === -1 ? 1 : 0); });
    while (s % 4 !== 3) slot(); slot(); setUA(idleUA); for (let i = 0; i < 6; i++) w.set(`PORT${i}`, 1); }
  const v = slot(); if (fillStart >= 0 && fillEnd < 0 && s > fillStart + 8 && v.get('READY') === 1) fillEnd = s;
  if (s % 20000 === 0) process.stderr.write(`  slot ${s} (${((Date.now() - t0) / 1000).toFixed(0)} s)\n`); }
if (process.env.DEBUG) { const la = chip('U106').state?.mem || chip('U106').mem, lb = chip('U107').state?.mem || chip('U107').mem;
  console.log('U106 keys', Object.keys(chip('U106')), 'nonzero A', la && la.filter(x => x).length, 'B', lb && lb.filter(x => x).length, 'writes', writes);
  const enc = c => V.encRails(vram[c], 8) ; console.log('rows 0,1,2 expect', [0,1,2,3].map(enc), [729,730,731,732].map(enc), [1458,1459,1460,1461].map(enc), 'LA', la && Array.from(la.slice(0, 4)), 'LB', lb && Array.from(lb.slice(0,4)));
  const L = 57 * 1056; let nz = []; for (let i = L; i < L + 1056; i++) if (cap[i] & 4095) nz.push(i - L); for (let k = 0; k < 4; k++) { const d = cap[L + 35 + k + 3] & 4095; process.stdout.write(`cap@${35 + k + 3}: ${[0,1,2].map(ch => lvOf(d, ch))} exp ${expLv(0, k, vram)}  `); }
  console.log('nonblack slots on line 57:', nz.length, nz.slice(0, 5), nz.slice(-3)); }
// --- checks ---
const msgs = []; const rises = bit => { const r = []; for (let i = 1; i < NS; i++) if ((cap[i] >> bit & 1) && !(cap[i - 1] >> bit & 1)) r.push(i); return r; };
const hs = rises(12), vs = rises(13);
for (let i = 1; i < hs.length; i++) if (hs[i] - hs[i - 1] !== 1056) { msgs.push(`HSYNC period ${hs[i] - hs[i - 1]} at ${hs[i]}`); break; }
for (const h of hs.slice(0, 50)) { let wdt = 0; while (cap[h + wdt] >> 12 & 1) wdt++; if (wdt !== 128) { msgs.push(`HSYNC width ${wdt}`); break; } }
for (let i = 1; i < vs.length; i++) if (vs[i] - vs[i - 1] !== 628 * 1056) msgs.push(`VSYNC period ${(vs[i] - vs[i - 1]) / 1056} lines`);
if (vs.length) { let wdt = 0; while (cap[vs[0] + wdt] >> 13 & 1) wdt++; if (wdt !== 4 * 1056) msgs.push(`VSYNC width ${wdt / 1056} lines`); } else msgs.push('no VSYNC');
const checkFrame = (v0, vr, label, either) => { let bad = 0, first = null; const pic = new Uint8Array(628 * 1056); const base = v0 - 601 * 1056;
  for (let r = 0; r < 486; r++) for (let c = 0; c < 729; c++) { const at = v0 + (57 + r - 601) * 1056 + 35 + c; pic[at - base] = 1; const d = cap[at] & 4095;
    const got = [0, 1, 2].map(ch => lvOf(d, ch)), e = expLv(r, c, vr); let ok = got.join() === e.join(); if (!ok && either) ok = got.join() === expLv(r, c, either).join();
    if (!ok) { bad++; if (!first) first = `${label} pixel (${r}, ${c}): levels ${got} vs ${e}`; } }
  let blankBad = 0; for (let i = 0; i < 628 * 1056; i++) if (!pic[i] && base + i < NS && base + i >= 0 && (cap[base + i] & 4095)) { blankBad++; if (!first) first = `${label}: non-black outside the picture at slot ${base + i}`; }
  return { bad, blankBad, first }; };
const frames = [];
if (vs.length) { const f1 = checkFrame(vs[0], vram, 'frame 1'); frames.push(f1); }
let fillReport = '';
if (which === 'fill') { const filled = new Int16Array(FB_SIZE).fill(FILLV);
  let wrong = 0; for (let p = 0; p < FB_SIZE; p++) if (vramS[fbLoc(p)] !== V.encRails(FILLV, 8)) wrong++;
  fillReport = `fill: ${writes} J2 writes, ${wrong} pixels wrong after; took ${fillEnd - fillStart} slots (${((fillEnd - fillStart) / 40e3).toFixed(1)} ms); `;
  if (wrong) msgs.push(`fill left ${wrong} pixels wrong`); if (writes !== FB_SIZE) msgs.push(`fill made ${writes} writes`);
  // frame 1 shows old pixels, new pixels, or (rows scanned while the fill ran) either; the last frame must be all new
  frames.length = 0; frames.push(checkFrame(vs[0], vram, 'frame 1 (during the fill)', filled)); if (vs.length >= 3) frames.push(checkFrame(vs[vs.length - 1], filled, 'last frame (after the fill)'));
}
for (const f of frames) { if (f.bad) msgs.push(`${f.bad} picture pixels wrong (first: ${f.first})`); if (f.blankBad) msgs.push(`${f.blankBad} slots not black outside the picture`); }
const line = `Video scan-out (${which}${MUT ? ', ' + MUT : ''}): ${s.toLocaleString()} slots in ${((Date.now() - t0) / 1000).toFixed(0)} s, ${hs.length} HSYNC / ${vs.length} VSYNC, ${frames.length} frame(s) checked; ${fillReport}${msgs.length ? 'FAIL: ' + msgs.join('; ') : '0 mismatches'}`;
console.log(line); fs.appendFileSync(path.join(__dirname, 'RESULTS-video-card.jsonl'), JSON.stringify({ date: new Date().toISOString(), stage: 2, which, mutant: MUT || null, slots: s, hsync: hs.length, vsync: vs.length, fill: fillReport || null, ok: !msgs.length, msgs }) + '\n');
