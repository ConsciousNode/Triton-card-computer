// translate.js: JPUSB, Neon's Bare USB netlist (Round 11) in the card computer's part library (Kehai Interim,
// 2026-11-21). MIT. Step 1 of the JPUSB plan (INTEGRATION-PLAN.md).
//
// Neon's src/netlist.js builds the design by calling sim.addChip(id, type, role, pins, image) on its own simulator.
// Here those calls are recorded through a stub, unchanged, and every chip is added to a card-computer Card with the
// card library's part name and pin names. Nothing is redesigned in this file: where Neon's design and the library
// disagree, the difference is listed below and checked by crosscheck.js.
//
// Part map (Neon type -> library part; pin renames):
//   74LVC04A/08A/32A/86A -> LVC04/08/32/86      same pins
//   74LVC157A           -> LVC157               G_N -> /E
//   74LVC161            -> LVC161               same pins
//   74LVC74A            -> LVC74                xCLR_N -> x/CLR, xPRE_N -> x/PRE, xQ_N -> x/Q
//   74LVC574A           -> LVC574               OE_N -> /OE, Dk -> D(k+1), Qk -> Q(k+1)   (the library numbers 1..8)
//   74LVC138A           -> LVC138               G2A_N -> /G2A, G2B_N -> /G2B, Yk_N -> /Yk
//   74LVC245A           -> LVC245               OE_N -> /OE
//   IS61WV5128EDBLL     -> IS61WV5128           CE_N/OE_N/WE_N -> /CE//OE//WE; Neon wires A0..A11, so A12..A18 -> GND
//      ...except the two packet-buffer chips that use Neon's separate D0..D7 write pins -> NEON_SRAM_SPLIT_IO
//      (parts.js: not a real part; JPUSB.md finding 1)
//   SST39SF040          -> SST39SF040           CE_N/OE_N/WE_N -> /CE//OE//WE; A12..A18 -> GND
// World, not chips (no simulator model in the library; their nets are inputs to this card):
//   ECS-3953M-480 (the 48 MHz oscillator: CLK_48M), USB1T11A (the analog transceiver: its VP, VM and RCV outputs are
//   inputs here, and VPO, VMO, OE_N, SPEED, SUSPND are the card's outputs to it), RES-NET-USB (the line resistors).
'use strict';
const path = require('path');
const { Card } = require('../cards/netlist.js'); const { P } = require('../cards/parts.js');
const BAREUSB = process.env.BAREUSB_SRC || path.join(__dirname, '../../bare-usb/delivery-11/src');

function record(options = {}) {
  const { buildSieNetlist, SIE_PINS } = require(path.join(BAREUSB, 'src/netlist.js'));
  const chips = [], init = []; const stub = { addChip(id, type, role, pins, image) { chips.push({ id, type, role, pins: { ...pins }, image: image || null }); },
    getOrCreateNet() { return 0; }, getNet() { return 0; }, watchNet() {}, scheduleNet() {}, stepUntil() {},
    setNetImmediate(n, v) { init.push([n, v]); } };
  buildSieNetlist(stub, options); return { chips, init, SIE_PINS };
}
const SAME = p => p;
const MAP = {
  '74LVC04A': ['LVC04', SAME], '74LVC08A': ['LVC08', SAME], '74LVC32A': ['LVC32', SAME], '74LVC86A': ['LVC86', SAME],
  '74LVC157A': ['LVC157', p => p === 'G_N' ? '/E' : p],
  '74LVC161': ['LVC161', SAME],
  '74LVC74A': ['LVC74', p => p.replace(/^(\d)CLR_N$/, '$1/CLR').replace(/^(\d)PRE_N$/, '$1/PRE').replace(/^(\d)Q_N$/, '$1/Q')],
  '74LVC574A': ['LVC574', p => p === 'OE_N' ? '/OE' : /^[DQ]\d$/.test(p) ? p[0] + (+p[1] + 1) : p],
  '74LVC138A': ['LVC138', p => p === 'G2A_N' ? '/G2A' : p === 'G2B_N' ? '/G2B' : /^Y\d_N$/.test(p) ? `/Y${p[1]}` : p],
  '74LVC245A': ['LVC245', p => p === 'OE_N' ? '/OE' : p],
  // Round 12 (2026-11-22): Neon's netlist now names these parts itself (the write-path and bus-hold fix, as drawn by Neon)
  '74LVCH245A': ['LVCH245', p => p === 'OE_N' ? '/OE' : p],
  '74LVC257A': ['LVC257', p => p === 'OE_N' ? '/OE' : p],
  IS61WV5128EDBLL: ['IS61WV5128', p => ({ CE_N: '/CE', OE_N: '/OE', WE_N: '/WE' })[p] || p],
  SST39SF040: ['SST39SF040', p => ({ CE_N: '/CE', OE_N: '/OE', WE_N: '/WE' })[p] || p],
};
// JPUSB finding 3 (2026-11-21): two buses float while gates read them (Neon's simulator holds every net's last value,
// so it never showed). BUS_D0..15, behind the backplane '245s, is read all the time by the hold muxes and gates but
// driven only during a port access; BD0..15, the packet buffer's data bus, is read by the TX payload muxes while the
// SRAMs' outputs are off. The fix used here: the '245s on those buses (U46/U47 on BUS_D, the readback buffers U67/U68
// on BD) are SN74LVCH245A, bus-hold on the data pins, which is what Neon's model silently assumed. BUSHOLD=0 builds
// the design as Neon drew it.
const BUSHOLD = process.env.BUSHOLD === '0' ? new Set() : new Set(['U46_BUS_XCVR_LO', 'U47_BUS_XCVR_HI', 'U67_RD_DAT_LO', 'U68_RD_DAT_HI']);
// JPUSB finding 1 (2026-11-21), the fix: the packet buffer's write path. Neon's U41/U42 write through model-only D pins
// (BUF_DIN_*, from the '157s U106..U109); the real IS61WV5128 has common I/O. Here U106..U109 are 74LVC257A (3-state)
// driving the SRAMs' I/O bus BD directly, enabled while BUF_OE_N is high (CPU_WR_DAT | RX_WE_PULSE: exactly the buffer
// write windows, when the SRAMs' outputs are already off) through U152's spare inverter 1 (BUF_DIN_OE_N); U41/U42 are
// plain IS61WV5128s. No new chips. Its timing (SRAM /OE to high-Z, the '257's enable and disable, data setup and hold
// around /WE) is for Neon's timed simulator (Round 12). WRITEPATH=neon builds Neon's drawing (NEON_SRAM_SPLIT_IO).
const WRITEPATH_FIX = process.env.WRITEPATH !== 'neon';
const DIN_MUX = new Set(['U106_BUF_DIN_LO0', 'U107_BUF_DIN_LO1', 'U108_BUF_DIN_HI0', 'U109_BUF_DIN_HI1']);
const dinToBd = n => { const m = /^BUF_DIN_(LO|HI)(\d)$/.exec(n); return m ? `BD${(m[1] === 'HI' ? 8 : 0) + +m[2]}` : n; };
const WORLD_TYPES = new Set(['ECS-3953M-480', 'USB1T11A', 'RES-NET-USB']);
// gate parts whose eval reads every section: an input Neon left out is tied to GND here (listed in the report)
const ALL_SECTIONS = { LVC08: [1, 2, 3, 4], LVC32: [1, 2, 3, 4], LVC86: [1, 2, 3, 4] };

// JPUSB_MUTANT (positive controls for crosscheck.js; our side only, Neon's simulator keeps the real design):
//   neon:NAME  Neon's own netlist mutant NAME;   old161  the '161 model without its asynchronous MR (before 2026-11-21);
//   swap574    the first '574's D1 and D2 swapped.
P.LVC161_SYNC_MR = { ...P.LVC161, async: undefined };
function build({ options = {}, report = null } = {}) {
  const MUTANT = process.env.JPUSB_MUTANT || '';
  if (MUTANT.startsWith('neon:')) options = { ...options, mutant: MUTANT.slice(5), fsmMutantAddr: process.env.JPUSB_FSM_ADDR !== undefined ? +process.env.JPUSB_FSM_ADDR : 0x082 };
  const rec = record(options); const card = new Card('JPUSB'); const notes = { tied: [], split: [], world: [] };
  let xcvr = null;
  for (const ch of rec.chips) {
    if (WORLD_TYPES.has(ch.type)) { notes.world.push(`${ch.id} (${ch.type})`); if (ch.type === 'USB1T11A') xcvr = ch; continue; }
    const m = MAP[ch.type]; if (!m) throw new Error(`no library part for ${ch.id}: ${ch.type}`);
    let [part, ren] = m; const pins = {};
    for (const [p, n] of Object.entries(ch.pins)) if (n) pins[ren(p)] = n;
    if (WRITEPATH_FIX && DIN_MUX.has(ch.id)) { part = 'LVC257'; delete pins['/E']; pins['/OE'] = 'BUF_DIN_OE_N'; for (const k of Object.keys(pins)) if (/^\dY$/.test(k)) pins[k] = dinToBd(pins[k]); notes.writePath = (notes.writePath || []).concat(ch.id); }
    if (WRITEPATH_FIX && ch.id === 'U152_SE0_PREV_INV') { pins['1A'] = 'BUF_OE_N'; pins['1Y'] = 'BUF_DIN_OE_N'; }
    if (WRITEPATH_FIX && (ch.id === 'U41_BUF_SRAM_LO' || ch.id === 'U42_BUF_SRAM_HI')) for (let i = 0; i < 8; i++) delete pins[`D${i}`];
    if (BUSHOLD.has(ch.id)) { part = 'LVCH245'; notes.bushold = (notes.bushold || []).concat(ch.id); }
    if (part === 'IS61WV5128' && [...Array(8).keys()].some(i => pins[`D${i}`])) { part = 'NEON_SRAM_SPLIT_IO'; notes.split.push(ch.id); }
    if (part === 'IS61WV5128' || part === 'NEON_SRAM_SPLIT_IO' || part === 'SST39SF040') for (let i = 12; i < 19; i++) if (!pins[`A${i}`]) pins[`A${i}`] = 'GND';
    if (ALL_SECTIONS[part]) for (const k of ALL_SECTIONS[part]) for (const x of ['A', 'B']) if (!pins[`${k}${x}`]) { pins[`${k}${x}`] = 'GND'; notes.tied.push(`${ch.id}.${k}${x}`); }
    const extra = {};
    if (P[part].write || part === 'SST39SF040') { extra.mem = new Uint8Array(1 << 19); if (ch.image) extra.mem.set(ch.image); }
    if (MUTANT === 'old161' && part === 'LVC161') part = 'LVC161_SYNC_MR';
    if (MUTANT === 'swap574' && part === 'LVC574' && !notes.swapped && pins.D1 !== pins.D2) { [pins.D1, pins.D2] = [pins.D2, pins.D1]; notes.swapped = ch.id; }
    card.add(ch.id, part, pins, extra);
  }
  // the world's side: inputs from the oscillator, the transceiver and the CPU's port bus
  const xin = ['VP', 'VM', 'RCV'].map(p => xcvr.pins[p]).filter(Boolean);
  card.input('CLK_48M', 'RST_N', 'IO_CS_N', 'IO_RD_N', 'IO_WR_N', 'PORT_A0', 'PORT_A1', 'PORT_A2', ...[...Array(16).keys()].map(i => `PORT_D${i}`), ...xin);
  const xout = Object.fromEntries(['VPO', 'VMO', 'OE_N', 'SPEED', 'SUSPND'].map(p => [p, xcvr.pins[p]]).filter(([, n]) => n));
  if (report) report({ notes, xin, xout, nChips: card.chips.length, recorded: rec.chips.length });
  return { card, rec, xin, xout, notes };
}
module.exports = { build, record, BAREUSB };
if (require.main === module) { const { card, notes, xin, xout } = build();
  const bom = card.bom(); console.log(`JPUSB: ${card.chips.length} chips in the library (${Object.entries(bom).map(([k, v]) => `${v} ${k}`).join(', ')})`);
  console.log('world parts:', notes.world.join(', ')); console.log('transceiver -> card:', xin.join(' '), '| card -> transceiver:', JSON.stringify(xout));
  console.log('split-I/O SRAMs (not buildable as drawn):', notes.split.join(' ') || 'none', '| write path (finding 1 fix):', (notes.writePath || []).join(' ') || "Neon's drawing", '| bus-hold (finding 3):', (notes.bushold || []).join(' ')); console.log('unlisted gate inputs tied to GND:', notes.tied.length, notes.tied.slice(0, 12).join(' '));
  // the integration's precise static check (a '245 with DIR tied drives one side only; '574s with /OE are 3-state)
  const { staticCheck } = require('../integration/integrate.js'); const probs = staticCheck(card);
  if (probs.length) { console.log(`static check: ${probs.length} problems`); probs.slice(0, 20).forEach(x => console.log('  ' + x)); process.exitCode = 1; }
  else console.log('static check: every read net has a driver or is a world input; no always-on driver shares a net'); }
