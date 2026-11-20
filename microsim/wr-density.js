// worst case: most MEM=WR microcycles any control-store path can fit in a window of L microcycles (conditions ignored,
// so every branch is free to go either way: an upper bound over all programs)
const { MicroMachine } = require('./microsim.js'); const mm = new MicroMachine(); const { store, addr, dispatch, dispatchT2 } = mm.cs;
const N = store.length, succ = store.map((mu, u) => { const s = new Set(), seq = mu.SEQ || 'NEXT';
  if (seq === 'NEXT') s.add(u + 1); else if (seq === 'JUMP') s.add(mu.CONST); else if (seq === 'BR' || seq === 'BRN') { s.add(u + 1); s.add(mu.CONST); }
  else if (seq === 'FETCH' || seq === 'HALT') s.add(addr.FETCH); else if (seq === 'WAIT') { s.add(u); s.add(u + 1); }
  else if (seq === 'DISPATCH') { for (const v of dispatch.values()) s.add(v); for (const v of dispatchT2.values()) s.add(v); s.add(addr.TRAP_ILL); s.add(addr.T2_HALT); }
  if (mu.RETIRE) s.add(addr.FETCH); if (mu.MEM) { s.add(addr.TRAP_PROT); s.add(addr.TRAP_BAD); }
  return [...s].filter(v => v >= 0 && v < N); });
const w = store.map(mu => mu.MEM === 'WR' ? 1 : 0);
for (const L of [4, 8, 16, 264, 2640]) { let best = new Int32Array(N); for (let u = 0; u < N; u++) best[u] = w[u];
  for (let k = 1; k < L; k++) { const nb = new Int32Array(N); for (let u = 0; u < N; u++) { let m = 0; for (const v of succ[u]) if (best[v] > m) m = best[v]; nb[u] = w[u] + m; } best = nb; }
  let m = 0; for (let u = 0; u < N; u++) m = Math.max(m, best[u]); console.log(`window ${L} µcycles: at most ${m} writes (${(m / L).toFixed(3)})`); }
// in time, with carry cycles stretched to 200 ns (TIMING-BUDGET.md's rule: the ALU's ADD/INCA result is used): the most
// VRAM-S slots (25 ns) that CPU write strobes (the second half of a write cycle) can take out of one 1,056-slot line
const len = store.map(mu => { const alu = mu.BUS === 'ALU' || ['ARITH', 'CMP', 'SHOUTL', 'SHOUTR'].includes(mu.FLAGS); return alu && ['ADD', 'INCA'].includes(mu.ALU_FN || 'ADD') ? 8 : 4; });
const LINE = 1056; let best = Array.from({ length: LINE + 1 }, () => new Int32Array(N).fill(-1));   // best[t][u]: max blocked in t slots starting at u
for (let t = 0; t <= LINE; t++) for (let u = 0; u < N; u++) { const l = len[u], b = w[u] ? l / 2 : 0;
  if (l > t) { best[t][u] = w[u] ? Math.max(0, t - l / 2) : 0; continue; }       // the window ends inside this cycle
  let m = 0; for (const v of succ[u]) if (best[t - l][v] > m) m = best[t - l][v]; best[t][u] = b + m; }
let mx = 0; for (let u = 0; u < N; u++) mx = Math.max(mx, best[LINE][u]);
console.log(`one 800x600 line (1,056 slots), stretched carry cycles: CPU write strobes take at most ${mx} slots; free >= ${LINE - mx} for the 729-pixel fetch`);
