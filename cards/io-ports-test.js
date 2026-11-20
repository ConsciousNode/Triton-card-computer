// io-ports-test.js: the I/O card's port side (bare ports 40-47 + the port bridge) beside the microsim (Kehai Interim,
// 2026-11-19). MIT.
// The microsim runs the ternary drivers with its BareIO model (microsim/bareio.js), byte-level devices. The card
// netlist runs beside it, per microcycle 4 slots of SCLK, and talks to devices at the PINS:
//   - an SD card (a second SdCard instance, same image) behind a bit-level SPI slave: MISO is the byte the card will
//     answer (SdCard.peek(), which never depends on the byte being sent: Ncr >= 1), MOSI is sampled on rising SCK;
//   - two PS/2 devices that clock 11-bit frames (start, 8 data LSB first, odd parity, stop) into K_CLK/K_DATA and
//     M_CLK/M_DATA, and that see the card's clock-hold output (inhibit).
// Compared:
//   - every BUS = IO cycle after an IN to 40..47: the card drives exactly the microsim's value; never at other times;
//   - the SPI byte stream (MOSI byte, MISO byte, chip-select changes) on the card's SD equals the microsim's, checked
//     when READY returns after every OUT; the SPI clock speed (OUT 41 bit 1) equals the microsim's;
//   - PS/2: each frame the microsim takes is clocked in at the pins at that instruction boundary (declared: real
//     frames arrive asynchronously over ~1 ms; here a bit is 8 slots); the card must not be holding the clock then,
//     must hold it whenever the microsim's device is inhibited, and must raise exactly one IRQSET pulse per frame, at
//     the first CPU edge after it;
//   - at the end both SD cards hold identical bytes;
//   - the timer and RTC (ports 48..53, 2026-11-19): the model runs on this harness's slot clock (clk below), so every
//     IN 48 byte is compared like any other answer; the slots where the card's period counter fires (TC4 and TICK) must
//     equal the model's, and each firing must give exactly one IRQSET0 pulse, at the first CPU edge after it.
// Declared for the timer/RTC: the RTC's 32.768 kHz crystal is played as RTC_OSC toggling every slot (a fast test
// crystal: the CD4060 is the real divider), and the RTC chip's counter starts at RTC0 in both the card and the model
// (the coin cell kept it running before this power-up; the CD4060 starts at 0).
// Declared: the receive register starts at 0xFFFF like the model's; the CPU waits on IORDY as long as the card needs
// (the slow SPI clock makes init bytes ~256 microcycles), counted as "extra wait".
'use strict';
const fs = require('fs'), path = require('path');
const { build, cardWord, DERIVED } = require('./io-ports.js');
const { trit } = require('./netlist.js');
const { P } = require('./parts.js');
const { decodeWord } = require('../microsim/roms.js');
const { MicroMachine, WORD_BITS } = require('../microsim/microsim.js');
const { BareIO, SdCard, Ps2Port } = require('../microsim/bareio.js');
const { testProgram, ld, KCOUNT, KBUF, VBR } = require('../microsim/bare-drivers.js');
const { loadHtmlModule } = require(require(__dirname+'/../triton-dir.js')+'/tests/t3-common.js'); const { T: TJ } = loadHtmlModule('triton3.html');
const ROMS = path.join(__dirname, '../roms');
const chips = Array.from({ length: Math.ceil(WORD_BITS / 8) }, (_, k) => fs.readFileSync(path.join(ROMS, `cs${k}.bin`)));
const cs = Buffer.alloc(1 << 19);
for (let w = 0; w < 1024; w++) { let b = 0n; for (let k = 0; k < chips.length; k++) b |= BigInt(chips[k][w]) << BigInt(8 * k); let mu; try { mu = decodeWord(b); } catch { continue; } cs[w] = cardWord(mu); }
const MUT = process.env.IO_MUTANT || null;
const toT = (v, n) => { const t = []; let x = v; for (let i = 0; i < n; i++) { let r = ((x % 3) + 3) % 3; if (r === 2) r = -1; t.push(r); x = (x - r) / 3; } return t; };
const COV = {}; const cov = (k, d = 1) => { COV[k] = (COV[k] || 0) + d; };
// a mutant is killed by its first mismatch, so a mutant run stops there (and still writes its RESULTS line)
let bad = 0, first = null; const fail = msg => { bad++; if (!first) first = msg; if (process.env.IO_MUTANT && bad === 1 && typeof report === 'function') { report(); process.exit(0); } };

// ---------- the devices at the pins ----------
class SdPins {
  constructor(sd) { this.sd = sd; this.cs = 0; this.n = 0; this.inb = 0; this.r = 0xFF; this.log = []; }
  miso() { if (!this.cs) return 1; const r = this.n === 0 ? this.sd.peek() : this.r; return (r >> (7 - this.n)) & 1; }
  setCs(on) { if (on !== this.cs) { this.sd.setCs(on); this.cs = on; this.n = 0; this.log.push(`cs${on}`); } }
  rise(mosi) { if (this.n === 0) { this.sd.tickWrite(); this.r = this.cs ? this.sd.peek() : 0xFF; }
    this.inb = ((this.inb << 1) | mosi) & 255; if (++this.n < 8) return;
    const got = this.sd.xfer(this.inb); if (got !== this.r) fail(`SD pins: xfer answered ${got} where peek said ${this.r}`);
    this.log.push(`${this.inb}:${got}`); this.n = 0; }
}
const ps2Bits = (byte, parityOk) => { const d = [...Array(8).keys()].map(i => (byte >> i) & 1), ones = d.reduce((a, b) => a + b, 0);
  return [0, ...d, (ones % 2 === 0 ? 1 : 0) ^ (parityOk ? 0 : 1), 1]; };

// ---------- the card and its clocking ----------
let card = null, sdp = null, w = null, lastV = null, lastMachine = null, machines = 0, extra = 0, drove = 0, lastInPort = -1, n = 0;
let G = 0, edgeSlots = [], cardFires = [], pulses = [], mtimer = null;
// the world's serial terminal on CON_TX: a UART receiver at the true 115,200 baud (40e6 / 115200 = 347.22 slots per
// bit), sampling each bit at its middle from the start bit's falling edge; framing errors are recorded
const UB = 40e6 / 115200; let ux = { st: 'idle', t0: 0, k: 0, byte: 0, prev: 1, text: '', framing: 0 };
function uartSlot(tx) { if (ux.st === 'idle') { if (ux.prev === 1 && tx === 0) { ux.st = 'rx'; ux.t0 = G; ux.k = 0; ux.byte = 0; } }
  else { const due = ux.t0 + Math.round(UB * (ux.k + 0.5));
    if (G === due) { if (ux.k === 0) { if (tx !== 0) { ux.st = 'idle'; ux.framing++; } }
      else if (ux.k <= 8) ux.byte |= tx << (ux.k - 1);
      else { if (tx !== 1) { ux.framing++; fail(`console: framing error on byte ${ux.text.length}`); }
        const i = ux.text.length, want = mioRef && mioRef.consoleOut[i]; ux.text += String.fromCharCode(ux.byte); ux.st = 'idle'; cov('console byte');
        if (want === undefined || want.charCodeAt(0) !== ux.byte) fail(`console: byte ${i} on the wire is ${ux.byte}, the model printed ${want === undefined ? 'nothing' : want.charCodeAt(0)}`); }
      ux.k++; } }
  ux.prev = tx; } const R0 = 8, RTC0 = 0x1234FFFE;
const dev = { K: { clk: 1, data: 1 }, M: { clk: 1, data: 1 } };
let irqWant = { K: 0, M: 0 }, irqSeen = { K: 0, M: 0 }, framesIn = 0;
const chip = r => card.chips.find(c => c.ref === r);
const REGS = () => card._regs || (card._regs = card.chips.filter(c => P[c.part].reg));
function worldIn(w) {
  w.set('SD_MISO', sdp.miso()); w.set('SD_CD', 1); w.set('RTC_OSC', G & 1);
  for (const x of ['K', 'M']) { const held = lastV && lastV.get(`${x}_HOLD`) === 0; w.set(`${x}_CLK`, dev[x].clk && !held ? 1 : 0); w.set(`${x}_DATA`, dev[x].data); }
}
// parts clocked by derived nets (the 'LV8154s, the CD4060): fire edge() on each transition of an edge pin, with the
// values from before the edge, then settle again (ripples: the CD4060's Q14 clocks the RTC counter)
const EDGE = () => card._edge || (card._edge = card.chips.filter(c => P[c.part].edges));
function edges() { for (let r = 0; r < 6; r++) { const v = card.v; let any = false;
    for (const c of EDGE()) { c.last = c.last || {}; const hit = new Set();
      for (const [pin, kind] of Object.entries(P[c.part].edges)) { const x = v.get(c.pins[pin]), p = c.last[pin];
        if (p !== undefined && (kind === 'rise' ? p === 0 && x === 1 : p === 1 && x === 0)) hit.add(pin); c.last[pin] = x; }
      if (hit.size) { P[c.part].edge(c, pin => v.get(c.pins[pin]), hit); any = true; if (c.ref === 'U58' && hit.has('CLKA')) cov('RTC count'); } }
    if (!any) return card.v; card.settle(w); } throw new Error('derived clocks keep rippling'); }
// one SCLK slot. cedge: /CEDGE low in this slot (the CPU edge is at its end). Returns the settled pre-edge values.
function slot(cedge, msgs) {
  w.set('/CEDGE', cedge ? 0 : 1); worldIn(w);
  card.settle(w); const v = edges(); lastV = v;
  if (v.get('TC4') === 1 && v.get('TICK') === 1) { cardFires.push(G); cov('timer fired'); }
  if (v.get('SNAPP') === 1) cov('snapshot held a slot (tick)');
  if (cedge) { edgeSlots.push(G); if (v.get('IRQSET0') === 1) { pulses.push(G); cov('IRQSET0 pulse'); } }
  if (cedge) for (const [x, irq] of [['K', 'IRQSET1'], ['M', 'IRQSET2']]) if (v.get(irq) === 1) { irqSeen[x]++;
    if (irqWant[x] <= 0) msgs.push(`${irq} pulse with no frame`); irqWant[x]--; cov(`${irq} pulse`); }
  for (const c of REGS()) if (!DERIVED[c.ref]) P[c.part].clock(c, p => v.get(c.pins[p]));
  const v2 = card.settle(w);
  for (const [ref, net] of Object.entries(DERIVED)) if (ref !== 'U2' && v.get(net) === 0 && v2.get(net) === 1) { const c = chip(ref); P[c.part].clock(c, p => v2.get(c.pins[p])); }
  if (v.get('SCK') === 0 && v2.get('SCK') === 1) sdp.rise(v2.get('SD_MOSI'));
  card.settle(w); const v3 = edges(); lastV = v3; sdp.setCs(v3.get('SD_/CS') === 0 ? 1 : 0);
  uartSlot(v3.get('CON_TX')); if (v3.get('CBUSY') === 1 && v3.get('IORDY') === 0) cov('IORDY held by the console');
  G++; return v;
}
function powerUp(m) {
  for (const c of card.chips) { if (c.q !== undefined) c.q = Array.isArray(c.q) ? [] : 0; }
  for (const c of card.chips) if (P[c.part].reg) c.q = c.part === 'ALVCH16823' || c.part === 'LVC74' ? [] : c.part === 'LVC574' ? [] : 0;
  G = 0; edgeSlots = []; cardFires = []; pulses = []; ux = { st: 'idle', t0: 0, k: 0, byte: 0, prev: 1, text: '', framing: 0 };
  for (const c of card.chips) if (P[c.part].edges) { c.last = {}; c.a = 0; c.b = 0; c.r = 0; c.q = 0; }
  const rtc = chip('U58'); rtc.a = RTC0 % 65536; rtc.b = Math.floor(RTC0 / 65536);   // declared: the coin cell kept it counting
  w = new Map([['RESET', 1], ['CLK', 0], ['MODE', 1]]); for (let i = 0; i < 10; i++) w.set(`UA${i}`, 0); for (let i = 0; i < 6; i++) w.set(`PORT${i}`, 0);
  for (let k = 0; k < 27; k++) { w.set(`D${k}+`, 0); w.set(`D${k}-`, 0); }
  dev.K = { clk: 1, data: 1 }; dev.M = { clk: 1, data: 1 }; lastV = null;
  const msgs = []; for (let s = 0; s < 8; s++) slot(s === 3, msgs);
  // the CPU clock runs during RESET, so the pipeline register (U2, outputs off in RESET) ends reset holding a real word
  // from the card's control store, not zeros (zeros would be every strobe active: an OUT to port 0, the console, at the
  // first edge; 2026-11-19, found when the console was drawn)
  { const v0 = card.settle(w); P.ALVCH16823.clock(chip('U2'), pin => v0.get(chip('U2').pins[pin])); }
  w.set('RESET', 0); for (let s = 0; s < 4; s++) slot(s === 3, msgs);
  chip('U21').q = 0xFF; chip('U22').q = 0xFF;                          // declared preset: the receive register = 0xFFFF
  if (msgs.length) fail('power-up: ' + msgs.join('; '));
  const r = card.settle((worldIn(w), w)); if (r.get('IORDY') !== 1) fail('power-up: IORDY not 1 after reset');
}
// a PS/2 frame at the pins, at an instruction boundary (frozen CPU)
function frame(x, byte, parityOk, msgs) {
  if (lastV.get(`${x}_HOLD`) === 0) msgs.push(`${x}: the microsim took a frame while the card holds the clock low`);
  for (const b of ps2Bits(byte, parityOk)) { dev[x].data = b; dev[x].clk = 1; for (let s = 0; s < 4; s++) slot(false, msgs); dev[x].clk = 0; for (let s = 0; s < 4; s++) slot(false, msgs); }
  dev[x].clk = 1; dev[x].data = 1; for (let s = 0; s < 6; s++) slot(false, msgs);
  if (lastV.get(`${x}RDY`) !== 1) msgs.push(`${x}: frame ${byte} not captured`);
  irqWant[x]++; framesIn++; cov(`${x} frame${parityOk ? '' : ' (bad parity)'}`);
}

// ---------- hooks into the microsim ----------
let pendingFrames = [], mioRef = null, msLog = [], msCs = 0;
const ptick = Ps2Port.prototype.tick;
Ps2Port.prototype.tick = function (step, m) {
  const x = this.irqBit === 2 ? 'K' : 'M', due = this.queue.length && this.queue[0].at <= step, f = due ? this.queue[0] : null, was = this.ready;
  ptick.call(this, step, m);
  if (!was && this.ready) pendingFrames.push([x, f.byte, f.parityOk]);
  else if (due && this.ready && card && lastV) { if (lastV.get(`${x}_HOLD`) !== 0) fail(`${x}: device inhibited in the microsim but the card is not holding the clock`); else cov(`${x} inhibit held`); }
};
const btick = BareIO.prototype.tick;
BareIO.prototype.tick = function () { btick.call(this); if (sdp && this === mioRef) sdp.sd.tickWrite(); };
function wrapSd(sd) { const x = sd.xfer.bind(sd), sc = sd.setCs.bind(sd);
  sd.xfer = b => { const r = x(b); msLog.push(`${b & 255}:${r}`); return r; };
  sd.setCs = on => { const v = on ? 1 : 0; if (v !== msCs) { msCs = v; msLog.push(`cs${v}`); } sc(on); }; }

const proto = MicroMachine.prototype, orig = proto.cycle;
const decR = (v, k0, k1) => { let x = 0; for (let k = k1 - 1; k >= k0; k--) x = 3 * x + trit(v.get(`D${k}+`), v.get(`D${k}-`)); return x; };
let checkedLog = 0;
proto.cycle = function () {
  if (this !== lastMachine) { lastMachine = this; machines++; lastInPort = -1; if (!card) { card = build(cs, MUT).check(); console.log('I/O ports BOM:', JSON.stringify(card.bom()), `= ${card.chips.length} chips`); if (MUT) console.log('MUTANT', MUT); }
    powerUp(this); }
  const msgs = [];
  try { while (pendingFrames.length) { const [x, b, ok] = pendingFrames.shift(); frame(x, b, ok, msgs); } } catch (e) { msgs.push('netlist stopped in a frame: ' + e.message); }
  const mu = this.cs.store[this.upc], d = this.decode(), upc = this.upc;
  const exIn = mu.IO === 'IN' ? d.imm : null, exOut = mu.IO === 'OUT' ? d.imm : null;
  const res = orig.call(this);
  const port = d.imm >= 0 && d.imm <= 62 ? d.imm : 63;
  const cardDrives = mu.BUS === 'IO' && lastInPort >= 40 && lastInPort <= 48;
  w.set('RESET', 0); for (let i = 0; i < 10; i++) w.set(`UA${i}`, (upc >> i) & 1); for (let i = 0; i < 6; i++) w.set(`PORT${i}`, (port >> i) & 1);
  const bus = toT(this.lastBus === undefined ? 0 : this.lastBus, 27);
  for (let k = 0; k < 27; k++) { if (cardDrives) { w.delete(`D${k}+`); w.delete(`D${k}-`); } else { w.set(`D${k}+`, bus[k] === 1 ? 1 : 0); w.set(`D${k}-`, bus[k] === -1 ? 1 : 0); } }
  try {
    { w.set('/CEDGE', 1); worldIn(w); const pw = new Map(w); if (cardDrives) for (let k = 0; k < 27; k++) { pw.set(`D${k}+`, 0); pw.set(`D${k}-`, 0); }
      card.settle(pw); P.ALVCH16823.clock(chip('U2'), p => card.v.get(chip('U2').pins[p])); }
    if (exIn !== null) lastInPort = exIn;
    for (let s = 0; s < 4; s++) { const v = slot(s === 3, msgs);
      if (s === 0 && cardDrives) { drove++; cov(`IN ${lastInPort}`); const x = decR(v, 0, 27); if (x !== this.lastBus) msgs.push(`BUS=IO after IN ${lastInPort}: ${x} vs ${this.lastBus}`); }
      if (s === 0 && !cardDrives) for (let k = 0; k < 27; k++) if (v.get(`D${k}+`) !== w.get(`D${k}+`) || v.get(`D${k}-`) !== w.get(`D${k}-`)) { msgs.push('card drove the bus when it should not'); break; } }
    if (mu.SEQ === 'WAIT' && this.upc !== upc) { let k = 0;
      while (lastV.get('IORDY') !== 1) { for (let s = 0; s < 4; s++) slot(s === 3, msgs); k++; if (k > 100000) { msgs.push('READY never returned'); break; } }
      extra += k; if (k) cov('extra wait microcycles', k);
      if (sdp.log.length !== msLog.length || sdp.log.some((e, i) => i >= checkedLog && e !== msLog[i])) { const i = sdp.log.findIndex((e, j) => e !== msLog[j]);
        msgs.push(`SPI stream differs at entry ${i}: card ${sdp.log.slice(i, i + 3)} vs microsim ${msLog.slice(i, i + 3)} (lengths ${sdp.log.length}/${msLog.length})`); }
      checkedLog = msLog.length;
      if (lastV.get('FAST') !== this.io.spiFast) msgs.push(`SPI clock speed ${lastV.get('FAST')} vs ${this.io.spiFast}`); else cov(lastV.get('FAST') ? 'SPI fast' : 'SPI slow'); }
    if (exOut !== null && exOut >= 40 && exOut <= 55) cov(`OUT ${exOut}`);
    if (mtimer && mtimer.fires.length > cardFires.length + 1) msgs.push(`timer: the model fired at slot ${mtimer.fires[cardFires.length]}, the card didn't`);
  } catch (e) { msgs.push('netlist stopped: ' + e.message); }
  if (msgs.length) { fail(`cycle ${n} upc ${upc} (${mu._r || ''}): ${msgs.join('; ')}`); if (bad > 20) { report(); process.exit(1); } }
  n++; return res;
};

// ---------- workloads ----------
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
function machine(src, sd, setup) {
  const asm = TJ.assemble(src, { mode: 'T3' }); const mm = new MicroMachine(4782969); mm.io = new BareIO(mm, sd); mioRef = mm.io;
  // the model's time = this harness's slots: an OUT/IN happens at the coming cycle's edge slot, a boundary is the last
  // edge run; the crystal falls on even slots (RTC_OSC = G & 1)
  mm.io.clk = { r0: R0, now: () => G + 3, boundary: () => G - 1, oscFalls: s2 => Math.floor(s2 / 2) }; mm.io.timer.rtc0 = RTC0; mtimer = mm.io.timer;
  asm.trytes.forEach((v, i) => { mm.mem[i] = v; }); mm.sp = 60000; setup(mm, asm.symbols);
  wrapSd(mm.io.sd); msLog = []; msCs = 0; checkedLog = 0;
  const sd2 = new SdCard(sd.blocks); sd2.data.set(sd.data); sdp = new SdPins(sd2); irqWant = { K: 0, M: 0 }; irqSeen = { K: 0, M: 0 }; pendingFrames = [];
  return mm; }
function runTo(mm, maxSteps) { let st = 0; while (!mm.halted && st < maxSteps) { mm.step(); st++; } return st; }

// A: the drivers from bare-drivers.js (SD init, read sector 5, write sector 7, read back; 40 keys by interrupt)
const which = process.argv[2] || 'all', results = {};
if (which === 'all' || which === 'drivers') {
  const sd = new SdCard(64); const sector5 = Array.from({ length: 729 }, () => Math.floor(rnd() * 19683) - 9841);
  const bytes = new Uint8Array(1536); sector5.forEach((t, i) => { const u = t + 9841; bytes[2 * i] = u >> 8; bytes[2 * i + 1] = u & 255; }); sd.data.set(bytes, 5 * 1536);
  const pattern = Array.from({ length: 729 }, (_, i) => ((i * 37) % 19683) - 9841 + (i % 3));
  const nKeys = +(process.env.NKEYS || 40);
  const mm = machine(testProgram({ nKeys }), sd, (m, sym) => { pattern.forEach((v, i) => { m.mem[21000 + i] = v; }); m.mem[VBR + 24] = sym.KBD_ISR; m.mem[VBR + 25] = 0; m.mem[VBR + 26] = 0;
    for (let i = 0; i < nKeys; i++) { const k = 1 + Math.floor(rnd() * 254); m.io.kbd.send(k, i < 2 ? 2 + i : 400 + i * (900 + Math.floor(rnd() * 600))); } });
  const st = runTo(mm, 3e6);
  const memOf = (a, k) => Array.from({ length: k }, (_, i) => mm.mem[a + i]);
  const ok = mm.io.consoleOut === '0000' && memOf(20000, 729).every((v, i) => v === sector5[i]) && memOf(22000, 729).every((v, i) => v === pattern[i]) && mm.mem[KCOUNT] === nKeys;
  if (!ok) fail(`drivers workload did not complete: console "${mm.io.consoleOut}", keys ${mm.mem[KCOUNT]}`);
  if (!sdp.sd.data.every((v, i) => v === mm.io.sd.data[i])) fail('drivers: the card-side SD image differs from the microsim\'s');
  if (irqSeen.K !== framesIn || irqWant.K !== 0) fail(`drivers: ${irqSeen.K} keyboard IRQ pulses for ${framesIn} frames`);
  results.drivers = { steps: st, ucycles: mm.ucycles, console: mm.io.consoleOut, keys: mm.mem[KCOUNT], spiEntries: msLog.length, timer: timerCheck('drivers'), terminal: consoleCheck('drivers', mm) };
  console.log(`drivers: ${st.toLocaleString()} instructions, ${mm.ucycles.toLocaleString()} µcycles, console "${mm.io.consoleOut}", ${mm.mem[KCOUNT]} keys, ${msLog.length} SPI log entries`);
}
// B: every port 40-47 directly, odd values, both PS/2 ports polled with interrupts off, bad-parity frames, inhibit
if (which === 'all' || which === 'ports') {
  framesIn = 0; const N = 12;
  const src = `
MAIN: IN R1, #41
IN R1, #43
IN R1, #45
IN R1, #47
IN R1, #40
IN R1, #46
LI R1, #5
OUT R1, #42
OUT R1, #43
OUT R1, #44
OUT R1, #45
OUT R1, #47
IN R1, #47
IN R1, #40
LI R1, #-300
OUT R1, #40
IN R2, #40
IN R2, #46
${ld('R1', 1000000)}
OUT R1, #40
IN R2, #40
IN R2, #46
LI R1, #9841
OUT R1, #46
IN R2, #46
IN R2, #40
LI R1, #-9841
OUT R1, #46
IN R2, #46
LI R1, #3
OUT R1, #41
${[64, 0, 0, 0, 0, 149, 255, 255, 255].map(b => `LI R1, #${b}\nOUT R1, #40\nIN R2, #40\nIN R2, #46`).join('\n')}
LI R1, #1234
OUT R1, #46
IN R2, #46
LI R1, #1
OUT R1, #41
LI R1, #0
OUT R1, #41
LI R6, #0
LI R7, #2
POLL: IN R1, #45
MOD R3, R1, R7
CMPI R3, #0
JZX PK
IN R2, #44
IN R1, #45
ADDI R6, R6, #1
PK: IN R1, #43
MOD R3, R1, R7
CMPI R3, #0
JZX PN
IN R2, #42
IN R1, #43
ADDI R6, R6, #1
PN: CMPI R6, #${N}
JNZX POLL
IN R1, #41
HALT
`;
  const mm = machine(src, new SdCard(16), m => {
    [[30, 0x5A, true], [31, 0x00, true], [33, 0xFF, false], [170, 0x81, true], [171, 0x7E, false], [260, 0x33, true]].forEach(([at, b, ok]) => m.io.mouse.send(b, at, ok));
    [[32, 0x1C, true], [34, 0x01, false], [175, 0xF0, true], [176, 0xAA, true], [300, 0x12, true], [301, 0xE0, true]].forEach(([at, b, ok]) => m.io.kbd.send(b, at, ok)); });
  const st = runTo(mm, 2e5);
  if (!mm.halted) fail(`ports workload did not halt (${st} steps)`);
  if (irqSeen.K + irqSeen.M !== framesIn || irqWant.K || irqWant.M) fail(`ports: IRQ pulses K ${irqSeen.K} M ${irqSeen.M} for ${framesIn} frames`);
  results.ports = { steps: st, ucycles: mm.ucycles, frames: framesIn, timer: timerCheck('ports'), terminal: consoleCheck('ports', mm) };
  console.log(`ports: ${st.toLocaleString()} instructions, ${mm.ucycles.toLocaleString()} µcycles, ${framesIn} PS/2 frames`);
}
// the timer's firings, and one IRQSET0 pulse per firing at the first CPU edge after it
// D: the console (OUT 0): the boot greeting, numbers printed by the CPU's own PRNUM (signs, every digit, the widest
// values), the byte patterns 0x00 0x01 0x55 0xAA 0x7F 0x80 0xFF, and back-to-back OUTs (each one waits on IORDY for the
// last). The terminal must receive exactly what the model printed.
if (which === 'all' || which === 'console') {
  const { PRNUM } = require('../microsim/bare-drivers.js');
  const say = t => [...t].map(ch => `LI R1, #${ch.charCodeAt(0)}\nOUT R1, #0`).join('\n');
  const nums = [0, 7, -1, 42, -9841, 9841, 1234567, -987654321];
  const src = `
MAIN: ${say('POOP OK\r\n')}
${nums.map(v => `${ld('R1', v)}\nCALLX PRNUM\nLI R1, #32\nOUT R1, #0`).join('\n')}
${[0, 1, 85, 170, 127, 128, 255].map(b => `LI R1, #${b}\nOUT R1, #0`).join('\n')}
LI R1, #-200
OUT R1, #0
HALT
${PRNUM}
`;
  const mm = machine(src, new SdCard(4), () => {});
  const st = runTo(mm, 2e5);
  if (!mm.halted) fail(`console workload did not halt (${st} steps)`);
  const want = 'POOP OK\r\n' + nums.map(v => `${v} `).join('') + String.fromCharCode(0, 1, 85, 170, 127, 128, 255, 56);
  if (mm.io.consoleOut !== want) fail(`console: the model printed ${JSON.stringify(mm.io.consoleOut)}, expected ${JSON.stringify(want)}`);
  results.console = { steps: st, ucycles: mm.ucycles, ...consoleCheck('console', mm) };
  console.log(`console: ${st.toLocaleString()} instructions, ${mm.ucycles.toLocaleString()} µcycles; the terminal received ${JSON.stringify(ux.text.slice(0, 24))}... (${ux.text.length} bytes, ${ux.framing} framing errors)`);
}
// C: the timer and the RTC (ports 48..53): a driver-style snapshot reader (all 8 stored bytes, assembled into two
// 32-bit values by the CPU), interrupts at two periods (23 ticks, 5), then a period of 1 tick with interrupts off (it
// fires every tick; the firings collapse into one pending IRQ, taken once IE is back on; with IE on, a 1-tick period is
// an interrupt storm the ISR can't keep up with, a real one), the timer switched off and on, a tight snapshot loop whose phase walks across the 200-slot tick grid (so some
// snapshots land on a TICK slot and have to be held a slot), and the ports around 48..53 that nothing answers.
if (which === 'all' || which === 'timer') {
  const TCOUNT = 24000, RING = 24010;
  const src = `
MAIN: ${ld('R1', VBR)}
MTSPR R1, #5
LI R1, #1
MTSPR R1, #3
LI R1, #1
MTSPR R1, #2
LI R6, #0
LI R7, #0
CALLX SNAPREAD
LI R1, #233
OUT R1, #50
LI R1, #255
OUT R1, #51
OUT R1, #49
LI R7, #8
OUT R7, #53
L1: CALLX SNAPREAD
${ld('R2', TCOUNT)}
LW R3, R2, #0
CMPI R3, #6
JNX L1
LI R7, #0
OUT R7, #53
LI R5, #6
L2: CALLX SNAPREAD
SUBI R5, R5, #1
CMPI R5, #0
JNZX L2
LI R1, #251
OUT R1, #50
OUT R1, #49
LI R7, #8
OUT R7, #53
L3: CALLX SNAPREAD
${ld('R2', TCOUNT)}
LW R3, R2, #0
CMPI R3, #20
JNX L3
LI R1, #0
MTSPR R1, #2
LI R1, #255
OUT R1, #50
OUT R1, #49
CALLX SNAPREAD
CALLX SNAPREAD
LI R7, #0
OUT R7, #53
LI R1, #1
MTSPR R1, #2
L4: ${ld('R2', TCOUNT)}
LW R3, R2, #0
CMPI R3, #21
JNX L4
LI R7, #0
OUT R7, #53
LI R5, #61
L5: OUT R7, #52
IN R2, #48
SUBI R5, R5, #1
CMPI R5, #0
JNZX L5
IN R1, #49
IN R1, #50
IN R1, #53
IN R1, #55
LI R1, #77
OUT R1, #48
OUT R1, #54
OUT R1, #55
LI R5, #3
L6: CALLX SNAPREAD
SUBI R5, R5, #1
CMPI R5, #0
JNZX L6
HALT
; SNAPREAD: snapshot, read the 8 stored bytes (select | enable in R7), assemble two 32-bit values, keep the last 4 pairs
SNAPREAD: PUSH R1
PUSH R2
PUSH R3
PUSH R4
OUT R7, #52
LI R4, #0
LI R3, #3
SR1: ADD R1, R3, R7
OUT R1, #53
IN R2, #48
MULI R4, R4, #256
ADD R4, R4, R2
SUBI R3, R3, #1
CMPI R3, #0
JNNX SR1
${ld('R2', RING)}
ADD R2, R2, R6
SW R4, R2, #0
LI R4, #0
LI R3, #7
SR2: ADD R1, R3, R7
OUT R1, #53
IN R2, #48
MULI R4, R4, #256
ADD R4, R4, R2
SUBI R3, R3, #1
CMPI R3, #3
JNZX SR2
${ld('R2', RING)}
ADD R2, R2, R6
SW R4, R2, #3
ADDI R6, R6, #6
CMPI R6, #24
JNX SRX
LI R6, #0
SRX: OUT R7, #53
POP R4
POP R3
POP R2
POP R1
RET
TISR: PUSH R2
PUSH R3
${ld('R2', TCOUNT)}
LW R3, R2, #0
ADDI R3, R3, #1
SW R3, R2, #0
POP R3
POP R2
IRET
`;
  const mm = machine(src, new SdCard(4), (m, sym) => { m.mem[VBR + 21] = sym.TISR; m.mem[VBR + 22] = 0; m.mem[VBR + 23] = 0; });
  const st = runTo(mm, 4e5);
  if (!mm.halted) fail(`timer workload did not halt (${st} steps)`);
  // the CPU's own assembly of the stored bytes must equal the model's snapshot values (the driver path, end to end)
  const tm = mm.io.timer; let found = false; const word = a => mm.mem[a] + 19683 * mm.mem[a + 1] + 19683 * 19683 * mm.mem[a + 2];   // trytes, low first
  for (let i = 0; i < 24; i += 6) if (word(RING + i) === tm.snapT && word(RING + i + 3) === tm.snapR) found = true;
  if (!found) fail(`timer: the CPU's assembled values don't include the last snapshot (${tm.snapT}, ${tm.snapR})`); else cov('CPU assembled the last snapshot');
  consoleCheck('timer', mm);
  results.timer = { steps: st, ucycles: mm.ucycles, tcount: mm.mem[TCOUNT], snapT: tm.snapT, snapR: tm.snapR, rtcCounted: tm.snapR - RTC0, ...timerCheck('timer') };
  console.log(`timer: ${st.toLocaleString()} instructions, ${mm.ucycles.toLocaleString()} µcycles, ${mm.mem[TCOUNT]} timer interrupts taken, ${cardFires.length} firings, last snapshot ticks ${tm.snapT} RTC ${tm.snapR.toString(16)}`);
}
// what the terminal received must be exactly what the model printed, with no framing errors
function consoleCheck(name, mm) { if (ux.text !== mm.io.consoleOut) fail(`${name}: the terminal got ${JSON.stringify(ux.text)}, the model printed ${JSON.stringify(mm.io.consoleOut)}`);
  if (ux.framing) fail(`${name}: ${ux.framing} framing errors on CON_TX`); return { text: ux.text, framing: ux.framing }; }
function timerCheck(name) { const mf = mtimer.fires;
  if (mf.length !== cardFires.length || mf.some((t, i) => t !== cardFires[i])) { const i = mf.findIndex((t, j) => t !== cardFires[j]);
    fail(`${name}: timer firings differ at #${i}: model ${mf.slice(i, i + 3)} vs card ${cardFires.slice(i, i + 3)} (${mf.length}/${cardFires.length})`); }
  let k = 0; const want = [];
  for (const t of cardFires) { while (k < edgeSlots.length && edgeSlots[k] < t + 1) k++; if (k < edgeSlots.length && (!want.length || want[want.length - 1] !== edgeSlots[k])) want.push(edgeSlots[k]); }
  if (want.length !== pulses.length || want.some((p, i) => p !== pulses[i])) { const i = want.findIndex((p, j) => p !== pulses[j]);
    fail(`${name}: IRQSET0 pulses differ at #${i}: expected edge ${want.slice(i, i + 3)} vs card ${pulses.slice(i, i + 3)} (${want.length}/${pulses.length})`); }
  return { fires: cardFires.length, pulses: pulses.length, delivered: mtimer.delivered }; }
function report() {
  const line = `I/O ports card vs microsim (${which}): ${n.toLocaleString()} microcycles (+${extra.toLocaleString()} extra wait), drove BUS=IO ${drove} times, ${machines} machine power-up(s), ${bad} mismatches${first ? '; first: ' + first : ''}`;
  console.log(line); console.log('coverage:', JSON.stringify(COV));
  fs.appendFileSync(path.join(__dirname, 'RESULTS-io-ports.jsonl'), JSON.stringify({ date: new Date().toISOString(), which, mutant: MUT, cycles: n, extra, drove, bad, first, results, cov: COV }) + '\n'); }
report(); process.exit(bad ? 1 : 0);
