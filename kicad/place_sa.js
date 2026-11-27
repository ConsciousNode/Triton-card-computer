// place_sa.js: a longer placement anneal for a placed card (Kehai Interim, 2026-11-27). MIT.
// usage: node kicad/place_sa.js <in.json from place_extract.py> <out.json> [iterations] [seed]
// Moves: swap two parts with the same footprint (on the same face, or across faces: a part that changes face is
// mirrored, x -> -x, as KiCad's flip does), and 180-degree turns. Cost: total half-perimeter wirelength (HPWL) of the
// signal nets, connector pins fixed. Power nets go to planes and aren't counted. build_card.py's own anneal is the same
// idea in Python at 60,000 steps on same-face swaps only; this one runs millions of steps and may cross faces.
'use strict';
const fs = require('fs');
const [inp, outp] = process.argv.slice(2); const ITERS = +(process.argv[4] || 3e6); let seed = +(process.argv[5] || 20261127) >>> 0;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const d = JSON.parse(fs.readFileSync(inp, 'utf8'));
const chips = d.chips.filter(c => c.ref !== 'J1');
// state per chip: slot position (x, y), face, turned (180), mirrored relative to its starting face
const N = chips.length, X = new Float64Array(N), Y = new Float64Array(N), FL = new Int8Array(N), TU = new Int8Array(N);
chips.forEach((c, k) => { X[k] = c.x; Y[k] = c.y; });
const netId = new Map(), netPins = [];   // net -> list of [chip, dx, dy] (chip -1 = fixed point)
const pinOf = (n) => { if (!netId.has(n)) { netId.set(n, netPins.length); netPins.push([]); } return netId.get(n); };
for (const [n, pts] of Object.entries(d.fixed)) { const i = pinOf(n); for (const [x, y] of pts) netPins[i].push([-1, x, y]); }
const netsOf = chips.map(() => new Set());
chips.forEach((c, k) => { for (const [dx, dy, n] of c.pads) { const i = pinOf(n); netPins[i].push([k, dx, dy]); netsOf[k].add(i); } });
const nets = netPins.map(p => p).filter(Boolean);
function hp(i) { let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const [k, dx, dy] of netPins[i]) { let x, y;
    if (k < 0) { x = dx; y = dy; } else { const sx = (FL[k] ? -1 : 1) * (TU[k] ? -1 : 1), sy = TU[k] ? -1 : 1; x = X[k] + sx * dx; y = Y[k] + sy * dy; }
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return netPins[i].length < 2 ? 0 : (x1 - x0) + (y1 - y0); }
const cost = Float64Array.from(netPins.map((_, i) => hp(i))); let total = cost.reduce((a, b) => a + b, 0); const start = total;
const groups = new Map(); chips.forEach((c, k) => { const g = c.fpid; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(k); });
const G = [...groups.values()].filter(g => g.length > 1); const all = chips.map((_, k) => k);
const face = chips.map(c => c.side === 'B' ? 1 : 0);   // current face; FL = mirrored relative to the start
// T0F: starting temperature factor (lower it to refine a placement that's already good)
let T = total / netPins.length * +(process.env.T0F || 0.3); const Tend = 0.01, alpha = Math.pow(Tend / T, 1 / ITERS);
let acc = 0;
const touched = new Set();
function tryMove(apply, undo, ks) {
  touched.clear(); for (const k of ks) for (const i of netsOf[k]) touched.add(i);
  const old = []; let dlt = 0; apply();
  for (const i of touched) { const v = hp(i); old.push([i, cost[i]]); dlt += v - cost[i]; cost[i] = v; }
  if (dlt <= 0 || rnd() < Math.exp(-dlt / T)) { total += dlt; acc++; return; }
  for (const [i, v] of old) cost[i] = v; undo();
}
for (let it = 0; it < ITERS; it++) {
  if (rnd() < 0.8) {
    const g = G[(rnd() * G.length) | 0], a = g[(rnd() * g.length) | 0], b = g[(rnd() * g.length) | 0];
    if (a === b) continue;
    if (face[a] !== face[b] && rnd() < 0.5) continue;                     // cross-face swaps at half the rate
    if (face[a] !== face[b] && (chips[a].tht || chips[b].tht)) continue;
    const sw = () => { let t = X[a]; X[a] = X[b]; X[b] = t; t = Y[a]; Y[a] = Y[b]; Y[b] = t;
      if (face[a] !== face[b]) { FL[a] ^= 1; FL[b] ^= 1; t = face[a]; face[a] = face[b]; face[b] = t; } };
    tryMove(sw, sw, [a, b]);
  } else {
    const a = all[(rnd() * all.length) | 0]; if (/^RN|^R_Array/.test(chips[a].fpid)) continue;
    const t = () => { TU[a] ^= 1; }; tryMove(t, t, [a]);
  }
  T *= alpha;
  if (it % 500000 === 0) console.log(`step ${it}: HPWL ${total.toFixed(0)} mm, T ${T.toFixed(3)}`);
}
// recompute from scratch (no drift)
let check = 0; for (let i = 0; i < netPins.length; i++) check += hp(i);
console.log(`HPWL ${start.toFixed(0)} -> ${check.toFixed(0)} mm (${(100 * (1 - check / start)).toFixed(1)}% shorter), ${acc} moves accepted`);
fs.writeFileSync(outp, JSON.stringify({ start, end: check, chips: chips.map((c, k) => ({ ref: c.ref, x: X[k], y: Y[k], flipped: !!FL[k], turned: !!TU[k], side: face[k] ? 'B' : 'F' })) }));
