// crosscheck.js: JPUSB step 1's proof. Neon's own simulator and the translation (translate.js) run side by side, and
// every net they share is compared before every 48 MHz edge (Kehai Interim, 2026-11-21). MIT.
//
// Neon's side runs unchanged: its GateSimulator, its netlist, its line model, device, pin harness and driver, on one of
// its own workloads. Watchers on Neon's simulator record every change on the card's inputs, in time order:
//   the CPU's port bus (RST_N, IO_CS_N, IO_RD_N, IO_WR_N, PORT_A0..2, PORT_D0..15 while the CPU drives it) and the
//   transceiver's outputs to the card (VP, VM, RCV: DP_IN, DM_IN, RCV_IN). The 48 MHz clock is the last input.
// Our side gets the same changes in the same order, and the card computer's physical rule: after each change, settle;
// a flip-flop or counter is clocked only when its own clock net rises, with the values from just before; derived
// clocks ripple; an SRAM writes while /CE and /WE are low (write-through).
// Compared, at every CLK_48M rising edge, just before it: every net both simulators have (Neon's netValues against our
// settled value). Neon's simulator is timed, so a net can still be moving shortly after an input changed: an edge
// within SKIP_NS of a change on an asynchronous input (the port bus or the transceiver) is not compared.
// Recorded, not failed: nets that float in our model at a compare (Neon's outputs never release a net; a bus with
// nothing driving keeps its last value there), and every clocked read of a floating net (a register capturing it).
// Usage: node crosscheck.js [hid|msc] [corner] [keystrokes]
'use strict';
const path = require('path');
const { build, BAREUSB } = require('./translate.js'); const { P } = require('../cards/parts.js');
const N = f => require(path.join(BAREUSB, f));
const { GateSimulator } = N('src/simulator'); const { buildSieNetlist } = N('src/netlist'); const { ClosedBoxPinHarness } = N('src/pin-harness');
const { UsbLineModel } = N('src/line-model'); const { LowSpeedHidKeyboardDevice, FullSpeedMassStorageDevice, generateScriptedKeystrokes } = N('src/devices');
const { UsbHostDriver } = N('src/driver');
const WHICH = process.argv[2] || 'hid', CORNER = process.argv[3] || 'min', NKEYS = +(process.argv[4] || 2), SKIP_NS = +(process.env.SKIP_NS || 40);
const MAXBAD = 20;

// ---- Neon's side, exactly as run-tests.js builds it
const sim = new GateSimulator({ delayCorner: CORNER }); buildSieNetlist(sim, {});
// ---- our side
const { card, xin } = build(); card.live = true;
const PORTD = [...Array(16).keys()].map(i => `PORT_D${i}`);
const ASYNC = ['RST_N', 'IO_CS_N', 'IO_RD_N', 'IO_WR_N', 'PORT_A0', 'PORT_A1', 'PORT_A2', ...PORTD, ...xin];
const nv = () => sim.netValues, nid = n => sim.netNameToId.get(n);
const w = new Map(); for (const n of [...ASYNC, 'CLK_48M']) w.set(n, nv()[nid(n)] | 0);
// PORT_D is the world's only while the CPU drives it (IO_RD_N high); during a read the card's '245s drive it
const portD = () => { const reading = w.get('IO_RD_N') === 0 && w.get('IO_CS_N') === 0; for (const n of PORTD) { if (reading) w.delete(n); else w.set(n, cpuD.get(n)); } };
const cpuD = new Map(PORTD.map(n => [n, w.get(n)]));
// clock pins per part, as integration/machine-sim.js has them
const CK = { LVC74: ['1CLK', '2CLK'], LVC161: ['CP'], LVC161_SYNC_MR: ['CP'], LVC574: ['CLK'] };
const regs = card.chips.filter(c => P[c.part].reg).map(c => ({ c, halves: CK[c.part].filter(k => c.pins[k] && c.pins[k] !== 'GND' && c.pins[k] !== 'VCC') }));
const srams = card.chips.filter(c => P[c.part].write && c.pins['/WE'] !== 'VCC');
for (const c of card.chips) { if (c.part === 'LVC74') c.q = [0, 0, 0]; else if (P[c.part].reg) c.q = c.part === 'LVC161' ? 0 : []; }
// declared: a bus-hold cell powers up holding some level; here, the level Neon's simulator starts that net at
for (const c of card.chips) if (c.part === 'LVCH245') { c.hold = {}; for (const [pin, n] of Object.entries(c.pins)) if (/^[AB]\d$/.test(pin) && nid(n) !== undefined) c.hold[pin] = nv()[nid(n)]; }
const floatRead = new Map(); const fr = k => floatRead.set(k, (floatRead.get(k) || 0) + 1);
const clockNets = [...new Set(regs.flatMap(r => r.halves.map(k => r.c.pins[k])))];
let settles = 0;
function settle() { card.settle(w); settles++; }
function snapClocks() { const m = new Map(); for (const n of clockNets) m.set(n, card.liveGet(n)); return m; }
// one input change on our side
// same: the input nets that changed at the same instant as the clock edge applied here. Neon's pin harness changes the
// port bus exactly at 48 MHz rising edges; in its simulator an input net is updated at once and every gate output a
// delay later, so at that edge a flip-flop reading the input net directly sees the new value and one reading it through
// any gate sees the old one. The first clocking pass here reads exactly that way (declared; JPUSB.md).
function apply(same = null) {
  portD(); let before = snapClocks(); settle();
  for (let r = 0; r < 8; r++) { let any = false; const cur = snapClocks();
    for (const { c, halves } of regs) for (const k of halves) { const n = c.pins[k]; if (!(before.get(n) === 0 && cur.get(n) === 1)) continue; any = true;
      // pre-edge values: the settled state before this change (pre) -- reread lazily from a snapshot taken before settle
      const g0 = pin => { const n0 = c.pins[pin]; const x = r === 0 && same && same.has(n0) ? w.get(n0) : preVal(n0); if (x !== 0 && x !== 1) { fr(`${c.ref}.${pin} (${c.pins[pin]})`); return 0; } return x; };
      if (halves.length === 1) { P[c.part].clock(c, g0); continue; }
      const o = k[0] === '1' ? '2' : '1', proxy = Object.create(c); proxy.pins = { ...c.pins, [`${o}CLK`]: 'GND' }; P[c.part].clock(proxy, g0); }
    if (!any) break; savePre(); before = cur; settle(); if (r === 7) throw new Error('derived clocks keep rippling'); }
  let wrote = false;
  for (const c of srams) { const g = pin => { const x = card.liveGet(c.pins[pin]); if (x !== 0 && x !== 1) { if (pin === '/CE' || pin === '/WE') return 1; fr(`${c.ref}.${pin} write (${c.pins[pin]})`); return 0; } return x; };
    if (P[c.part].write(c, g) >= 0) wrote = true; }
  if (wrote) settle();
  savePre();
}
// the pre-edge values a clocked chip reads: every net as it was settled before the change that clocked it
let PRE = null; function savePre() { const E = card._ev; PRE = E.val.slice(); }
function preVal(n) { const i = card.liveId(n); if (i === undefined) return undefined; const x = PRE[i]; return x === 2 ? 'Z' : x === 3 ? undefined : x; }
settle(); savePre(); apply();

// ---- the shared nets, as id pairs (ours, Neon's)
const ours = card._ev.F.names; const pairs = [];
// (CLK_48M is left out: it is sampled just before the edge is applied, by construction)
for (let i = 0; i < ours.length; i++) { const j = nid(ours[i]); if (j !== undefined && !['GND', 'VCC', 'CLK_48M'].includes(ours[i])) pairs.push([i, j, ours[i]]); }
// BD's combinational cone: every net reachable from BD0..15 through logic only (stopping at any register or memory)
const BDNET = new Set([...Array(16).keys()].map(i => `BD${i}`)); let bdSkips = 0, txCaptures = 0, fpOverlaps = 0;
{ const comb = card.chips.filter(c => !P[c.part].reg && !P[c.part].write && !P[c.part].edges && c.part !== 'SST39SF040');
  let grew = true; while (grew) { grew = false; for (const c of comb) { const outs = new Set(P[c.part].out.map(o => c.pins[o]).filter(Boolean));
    if (!Object.entries(c.pins).some(([pin, n]) => !P[c.part].out.includes(pin) && BDNET.has(n))) continue;
    for (const n of outs) if (!BDNET.has(n) && n !== 'GND' && n !== 'VCC') { BDNET.add(n); grew = true; } } } }
console.log(`  BD's combinational cone: ${BDNET.size} nets (${[...BDNET].filter(n => !/^BD\d/.test(n)).slice(0, 10).join(' ')}${BDNET.size > 26 ? ' ...' : ''})`);
let edges = 0, compared = 0, skipped = 0, bad = 0, lastAsync = -1e9; const floatAt = new Map(), firstBad = [];
function compare(t) {
  if (t - lastAsync < SKIP_NS) { skipped++; return; } compared++;
  const val = card._ev.val, n = nv();
  // declared (finding 1's fix, translate.js): in a buffer write window (BUF_OE_N high) the fixed design drives BD with
  // the write data where Neon's model leaves it holding its last value; BD and its combinational cone aren't compared
  // there. Anything stored from them in that window would still show, in the register it went to.
  const writing = process.env.WRITEPATH !== 'neon' && card.liveGet('BUF_OE_N') === 1; if (writing) bdSkips++;
  // Round 12 audit (2026-11-22): the strong form of Neon's false-path invariants, on our side: the TX byte latch never
  // captures (TX_LAT_EN = 1) while the buffer is being written (the '257s enabled, an RX write window or pulse, a CPU
  // write window). Neon checks only S_TX_DATA for two of its three declarations.
  if (card.liveId('TX_LAT_EN') !== undefined && card.liveGet('TX_LAT_EN') === 1) { txCaptures++;
    if (card.liveGet('BUF_DRV_OE_N') === 0 || card.liveGet('RX_WE_WIN') === 1 || card.liveGet('RX_WE_PULSE') === 1 || card.liveGet('CPU_WR_WIN') === 1) fpOverlaps++; }
  for (const [i, j, name] of pairs) { if (writing && BDNET.has(name)) continue; const x = val[i]; if (x === 2 || x === 3) { floatAt.set(name, (floatAt.get(name) || 0) + 1); continue; }
    if (x !== n[j]) { bad++; if (firstBad.length < MAXBAD) firstBad.push(`t=${t.toFixed(2)} ns edge ${edges}: ${name} ours ${x} Neon ${n[j]}`); } }
}
// ---- watchers on Neon's simulator: queue our side's changes in time order; act on every clock change
const pending = [];
for (const n of ASYNC) sim.watchNet(n, (t, v) => pending.push([t, n, v]));
let stopped = null;
sim.watchNet('CLK_48M', (t, v) => { if (stopped) return;
  try {
    const DBG = +(process.env.DEBUG_EDGE || -1); if (DBG >= 0 && edges >= DBG - 3 && edges <= DBG) for (const [t2, n, x] of pending) console.log(`  [debug] edge ${edges} t=${t2.toFixed(2)} ${n}=${x}`);
    const now = pending.filter(e => e[0] < t), sameEv = pending.filter(e => e[0] >= t); pending.length = 0;
    if (sameEv.length) lastAsync = t;   // Neon is mid-transition at this edge: not compared (the skip window)
    for (const [t2, n, x] of now) { if (PORTD.includes(n)) cpuD.set(n, x); w.set(n, x); lastAsync = t2; apply(); }
    if (DBG >= 0 && edges >= DBG - 3 && edges <= DBG) { const ns = (process.env.DEBUG_NETS || 'BA0,BA1,BA2,BA3,FSM_A6_REG,START_OR_SOF,SEL_DAT_N,SEL_DAT_DLY,BUF_LOAD_N,BUF_ADDR_RST_N,SOF_1MS_TICK').split(',');
      console.log(`  [debug] t=${t.toFixed(2)} CLK->${v} (edge ${edges}) ours/Neon: ${ns.map(n => `${n} ${card.liveGet(n)}/${nv()[nid(n)]}`).join(' ')}`); }
    if (v === 1) { edges++; compare(t); if (bad > MAXBAD) { stopped = 'too many mismatches'; } }
    const same = new Set(); for (const [t2, n, x] of sameEv) { if (PORTD.includes(n)) cpuD.set(n, x); w.set(n, x); same.add(n); lastAsync = t2; }
    w.set('CLK_48M', v); apply(v === 1 && same.size ? same : null);
  } catch (e) { stopped = `our side stopped at t=${t.toFixed(2)} ns (edge ${edges}): ${e.message}`; } });

// ---- Neon's workload
const t0 = Date.now(); const line = new UsbLineModel();
const dev = WHICH === 'hid' ? new LowSpeedHidKeyboardDevice({ seed: 42 }) : new FullSpeedMassStorageDevice({ seed: 20261118 });
line.attachDevice(dev); const harness = new ClosedBoxPinHarness(sim, line, { hostClockSkewPct: 0 }); harness.reset();
const driver = new UsbHostDriver(harness); let result;
try { const en = driver.enumerateDevice(1); result = { enumerated: en.ok, stage: en.stage, reason: en.reason };
  if (en.ok && WHICH === 'hid') { const k = driver.readHidKeystrokes(1, NKEYS); const exp = generateScriptedKeystrokes(NKEYS, 42);
    result.keys = k.ok ? k.reports.filter((r, i) => Buffer.from(r).equals(Buffer.from(exp[i]))).length : 0; }
  // Neon's Test 3 workload (run-tests.js runClosedBoxWorkload, fileSectorsToRead = 1): one SCSI read at LBA 32
  if (en.ok && WHICH === 'msc') { const r = driver.scsiReadSectors(1, 32, 1, { outToggle: 0, inToggle: 0 });
    const want = dev.image.fileBytes.slice(0, 512); result.sector = !!(r.ok && Buffer.from(r.data).equals(Buffer.from(want))); }
} catch (e) { result = { error: e.message }; }
const ms = (Date.now() - t0) / 1000;
console.log(`JPUSB cross-check (${WHICH}, ${CORNER} corner): Neon's workload ${JSON.stringify(result)}; ${(sim.nowNs / 1e6).toFixed(3)} ms simulated in ${ms.toFixed(0)} s`);
console.log(`  ${edges.toLocaleString()} edges, ${compared.toLocaleString()} compared x ${pairs.length} shared nets, ${skipped.toLocaleString()} skipped (within ${SKIP_NS} ns of an async change); ${settles.toLocaleString()} settles on our side`);
console.log(`  TX latch captures: ${txCaptures.toLocaleString()}; during a buffer write (strong false-path invariant): ${fpOverlaps}`);
console.log(`  BD not compared at ${bdSkips.toLocaleString()} edges in buffer write windows (finding 1's fix; WRITEPATH=neon for Neon's drawing)`);
console.log(`  mismatches: ${bad}${stopped ? `; STOPPED: ${stopped}` : ''}`); firstBad.forEach(x => console.log('    ' + x));
console.log(`  floating in our model at a compare (Neon holds the last value): ${floatAt.size} nets`, [...floatAt].slice(0, 12).map(([k, v]) => `${k} x${v}`).join(', '));
console.log(`  clocked reads of a floating net: ${floatRead.size}`, [...floatRead].slice(0, 12).map(([k, v]) => `${k} x${v}`).join(', '));
// the FSM address Neon's Test 6 would plant fsm_bad_next_state at, by its own rule (run-tests.js line 837)
const used = [...sim.fsmAccessedAddresses]; const pick = used.find(a => (a & 0x0F) === 2 && ((a >> 6) & 1) === 0 && ((a >> 7) & 1) === 1);
console.log(`  FSM addresses visited (Neon's side): ${used.length}; Test 6's pick: ${pick === undefined ? 'none (Neon falls back to 0x082)' : '0x' + pick.toString(16)}`);
process.exitCode = bad || stopped ? 1 : 0;
