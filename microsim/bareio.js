// bareio.js: the "bare ports" I/O card (Kehai Interim, 2026-11-18). MIT.
//
// Kham's rule for the card computer: no bits faked by software on a chip. So this I/O card has no microcontroller.
// It is shift registers, latches and counters, and the ternary CPU runs every driver itself:
//   ports 40-41  SPI to an SD card: OUT 40 starts an 8-bit exchange ('165 out, '164 in, clocked by a counter), IN 40
//                reads the byte that came back; OUT 41 bit 0 drives chip select (1 = selected), bit 1 the SPI clock
//                (0 = 312.5 kHz for card init, as the SD spec asks; 1 = 10 MHz); IN 41 = card present.
//                The byte is the low tryte w0 mod 256 (the card's T->B table sees trits 0..8 only).
//                One 16-bit receive register is shared by ports 40 and 46: an 8-bit exchange shifts the old low byte
//                up (IN 40 = the low byte, IN 46 = all 16 bits). [2026-11-19, to match the I/O card netlist]
//   ports 42-43  PS/2 keyboard: an 11-bit shift register clocked by the keyboard; on a complete frame the data byte is
//                latched, IRQ 1 is raised, and the keyboard clock is held low (PS/2 inhibit) until the CPU reads port 42.
//                IN 43 = status: bit 0 ready, bit 1 parity error ('280 parity checker), bit 2 framing error.
//   ports 44-45  a second PS/2 port (mouse), IRQ 2, same hardware.
//   ports 46-47  16-bit SPI through the PORT BRIDGE: OUT 46 = a tryte t goes through the ternary->binary table to the
//                16-bit value t + 9841, shifted out high byte first; OUT 47 = clock in 16 bits while sending 0xFFFF;
//                IN 46 = the 16 bits received, through the binary->ternary table (value - 9841).
//
// THE PORT BRIDGE (made explicit 2026-11-18): the backplane's I/O bus carries trits (dual-rail). Every binary device
// is reached through two lookup tables in SRAM, loaded at power-up by the copy engine like every other table:
//   T->B: address = the 9-trit tryte as 18 dual-rail wires (256K entries, 19,683 used), data = 16 bits;
//   B->T: address = 16 bits (64K entries), data = 11 trits (22 dual-rail wires; 3 x 64Kx8 SRAM).
// The 8-bit ports (40, 42-45) use the same tables: a byte is the value 0..255 in trits. Tables, not software: the same
// binary *material* as the ALU slices and the RAM address conversion.
// Ports kept from the old card because they were discrete hardware anyway: 0-1 console (a serial shifter), 2-5 video
// card registers, 6 and 9 the step timer counters. Removed: the DMA disk (7-8, 17-21), the keyboard/mouse mailboxes
// (10-16) and the network (22-27); reading one returns 0, writing one does nothing (no card answers).
//
// The SD card model follows the SD Physical Layer Simplified Spec, SPI mode: CMD0 (CRC checked), CMD8 (CRC checked),
// CMD55/ACMD41, CMD58, CMD17, CMD24, block addressing (SDHC). Its inside is a binary controller, like any SD card: it is
// an off-card peripheral that stores bytes. A Triton sector (729 trytes) is stored as 3 blocks: each tryte t as the
// 16-bit big-endian value t + 9841, 1458 bytes, the rest of the 1536 bytes padding.
'use strict';
const { IOCard } = require('./iocard.js');
const low9 = v => { const x = Number(v); let r = ((x % 19683) + 19683) % 19683; return r > 9841 ? r - 19683 : r; };   // trits 0..8

function crc16(buf) { let c = 0; for (const b of buf) { c ^= b << 8; for (let i = 0; i < 8; i++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF; } return c; }

class SdCard {
  constructor(blocks = 64) { this.data = new Uint8Array(blocks * 512); this.blocks = blocks; this.cs = 0; this.idle = true;
    this.inited = false; this.acmd = false; this.acmd41Count = 0; this.cmd = []; this.out = []; this.wstate = null; this.log = []; }
  setCs(on) { if (!on) { this.cmd = []; this.out = []; if (this.wstate && this.wstate.phase !== 'busy') this.wstate = null; } this.cs = on ? 1 : 0; }
  xfer(b) {
    b &= 0xFF; if (!this.cs) return 0xFF; this.tickWrite();
    if (this.wstate) return this.writeByte(b);
    if (this.out.length) return this.out.shift();
    if (this.cmd.length === 0 && (b & 0xC0) !== 0x40) return 0xFF;      // waiting for a start bit pattern 01xxxxxx
    this.cmd.push(b); if (this.cmd.length < 6) return 0xFF;
    const [c0, a3, a2, a1, a0, crc] = this.cmd; this.cmd = []; this.command(c0 & 0x3F, ((a3 << 24) >>> 0) + (a2 << 16) + (a1 << 8) + a0, crc);
    return 0xFF;
  }
  // what the next xfer() will return, whatever byte is sent: an SD card answers a byte only in later bytes (Ncr >= 1),
  // so the pin-level harness can put this on MISO while the byte is still being clocked in
  peek() { if (!this.cs) return 0xFF; this.tickWrite(); const w = this.wstate;
    if (w) return w.phase === 'busy' ? (!w.sentResp ? 0x05 : w.busy > 0 ? 0x00 : 0xFF) : 0xFF;
    return this.out.length ? this.out[0] : 0xFF; }
  r1(v) { this.out.push(0xFF, v); }                                      // Ncr = 1 byte, then the response
  command(n, arg, crc) {
    this.log.push(n); const idle = this.idle ? 1 : 0, acmd = this.acmd; this.acmd = false;
    if (n === 0) { if (crc !== 0x95) return this.r1(0x08 | idle); this.idle = true; this.inited = false; return this.r1(0x01); }
    if (n === 8) { if (crc !== 0x87) return this.r1(0x08 | idle); return this.out.push(0xFF, idle, 0, 0, (arg >> 8) & 0xF, arg & 0xFF); }
    if (n === 55) { this.acmd = true; return this.r1(idle); }
    if (n === 41 && acmd) { if (++this.acmd41Count >= 3) { this.idle = false; this.inited = true; } return this.r1(this.idle ? 1 : 0); }
    if (n === 58) return this.out.push(0xFF, idle, this.inited ? 0xC0 : 0x40, 0xFF, 0x80, 0x00);
    if (n === 16) return this.r1(idle);
    if (!this.inited) return this.r1(0x04 | idle);                       // illegal command before init
    if (n === 17) { if (arg >= this.blocks) return this.r1(0x40); const blk = this.data.subarray(arg * 512, arg * 512 + 512), c = crc16(blk);
      return this.out.push(0xFF, 0x00, 0xFF, 0xFF, 0xFE, ...blk, c >> 8, c & 0xFF); }
    if (n === 24) { if (arg >= this.blocks) return this.r1(0x40); this.r1(0x00); this.pendingWrite = arg; return; }
    return this.r1(0x04 | idle);
  }
  writeByte(b) {
    const w = this.wstate;
    if (w.phase === 'token') { if (b === 0xFE) w.phase = 'data'; return 0xFF; }
    if (w.phase === 'data') { w.buf.push(b); if (w.buf.length === 514) {             // 512 data + 2 CRC bytes (not checked: CRC is off in SPI mode)
        this.data.set(w.buf.slice(0, 512), w.blk * 512); w.phase = 'busy'; w.busy = 3; return 0xFF; } return 0xFF; }
    if (w.phase === 'busy') { if (!w.sentResp) { w.sentResp = true; return 0x05; } if (w.busy-- > 0) return 0x00; this.wstate = null; return 0xFF; }
    return 0xFF;
  }
  // the R1 for CMD24 has been queued; once it has been clocked out the card waits for the data token
  tickWrite() { if (this.pendingWrite !== undefined && this.out.length === 0) { this.wstate = { phase: 'token', blk: this.pendingWrite, buf: [] }; this.pendingWrite = undefined; } }
}
// CRC on writes: SPI mode has CRC off by default (CMD59), so the card accepts the 2 CRC bytes without checking them.

class Ps2Port {
  constructor(irqBit) { this.irqBit = irqBit; this.queue = []; this.latch = 0; this.ready = 0; this.parityErr = 0; this.inhibitedSteps = 0; }
  // a frame from the device: data byte, finishing at instruction step `at` (if the line isn't held low by us)
  send(byte, at, parityOk = true) { this.queue.push({ byte: byte & 0xFF, at, parityOk }); }
  tick(step, m) {
    if (this.queue.length && this.queue[0].at <= step) {
      if (this.ready) { this.inhibitedSteps++; return; }                 // clock held low: the device keeps the byte
      const f = this.queue.shift(); this.latch = f.byte; this.parityErr = f.parityOk ? 0 : 1; this.ready = 1; m.ipend |= this.irqBit;
    }
  }
  read() { const v = this.latch; this.ready = 0; return v; }
  status() { return this.ready | (this.parityErr << 1); }
}

// THE TIMER AND THE RTC (ports 48..53, 2026-11-19, to match the I/O card netlist; IO-CARD.md). Plain binary counters
// read a byte at a time; the ternary CPU's driver assembles values and does every conversion. Time is counted in
// SCLK slots (40 MHz; a microcycle is 4 slots, the CPU edge at the end of the 4th), from `clk`, which a harness can
// replace with the real slot count (the card can stretch a cycle with IORDY wait; the microsim can't see that).
//   200 kHz TICK: one slot in every 200, the first 199 slots after RESET ends (slot r0).
//   OUT 50 / 51: period latch low / high byte (L). OUT 49: arm (the period counter loads L now).
//   The period counter counts TICKs while enabled; on a TICK at 0xFFFF it reloads L and fires: the period is 65536 - L.
//   A firing raises IRQ 0 at the first CPU edge after its slot.
//   OUT 52: snapshot: the tick count (TICKs in slots <= this edge's slot, 32 bits, cleared at RESET) and the RTC
//   (half-seconds: rtc0 + the CD4060's Q14 rises so far, 32 bits; if this edge's slot is a TICK slot the snapshot
//   happens one slot later, which can only matter to the RTC).
//   OUT 53: bits 0..2 select the stored byte IN 48 reads (0..3 tick count, 4..7 RTC), bit 3 enables the timer.
//   IN 48: that stored byte. Ports 6 and 9 (the old step timer) are gone: no card answers them, and nothing counts steps.
// THE CONSOLE (2026-11-19): OUT 0 sends one byte (w0 mod 256, the bridge's byte mode) out a serial pin, 115,200 8N1;
// the card holds IORDY low while it shifts, so the CPU waits about 87 us per character (the microsim doesn't model
// that wait, the netlist harness does). IN 0, IN 1 and OUT 1 are gone: no console input, and decimal printing is the
// CPU's job now (bare-drivers.js PRNUM).
const REMOVED = new Set([0, 1, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27]);
class BareTimer {
  constructor(io) { this.io = io; this.pl = 0; this.ph = 0; this.cnt = 0; this.ten = 0; this.sel = 0; this.snapT = 0; this.snapR = 0;
    this.done = -1; this.fires = []; this.delivered = 0; this.rtc0 = 0; }
  get clk() { return this.io.clk; }
  isTick(s) { const r0 = this.clk.r0; return s >= r0 + 199 && (s - r0 - 199) % 200 === 0; }
  ticksUpTo(s) { const r0 = this.clk.r0; return s >= r0 + 199 ? Math.floor((s - r0 - 199) / 200) + 1 : 0; }
  // process every TICK slot up to and including slot s, with the latches as they were before s's edge
  advance(s) { const r0 = this.clk.r0; let k = this.ticksUpTo(this.done);
    for (let t = r0 + 199 + 200 * k; t <= s; t += 200) { if (this.ten) { if (this.cnt === 0xFFFF) { this.fires.push(t); this.cnt = this.ph * 256 + this.pl; } else this.cnt++; } }
    if (s > this.done) this.done = s; }
  rtcAt(s) { const k = this.clk.oscFalls(s); return (this.rtc0 + Math.floor((k + 8192) / 16384)) % 4294967296; }
  out(port, b) { const e = this.clk.now(); this.advance(e);
    if (port === 50) this.pl = b; else if (port === 51) this.ph = b; else if (port === 49) this.cnt = this.ph * 256 + this.pl;
    else if (port === 52) { this.snapT = this.ticksUpTo(e) % 4294967296; this.snapR = this.rtcAt(this.isTick(e) ? e + 1 : e); }
    else if (port === 53) { this.sel = b & 7; this.ten = (b >> 3) & 1; } }
  in48() { const v = this.sel < 4 ? this.snapT : this.snapR; return Math.floor(v / 2 ** (8 * (this.sel & 3))) & 255; }
  // at an instruction boundary: firings whose slot is before the boundary's edge slot are pending now
  boundary(m) { const B = this.clk.boundary(); this.advance(B); let n = 0;
    while (this.delivered < this.fires.length && this.fires[this.delivered] <= B - 1) { this.delivered++; n++; }
    if (n) m.ipend |= 1; return n; }
}
class BareIO extends IOCard {
  constructor(m, sd) { super(m, 1); this.sd = sd || new SdCard(); this.kbd = new Ps2Port(2); this.mouse = new Ps2Port(4); this.rx16 = 0xFFFF; this.spiBytes = 0; this.spiFast = 0;
    m.ownTimer = false; m.timerPeriod = 0;
    // default clock: no IORDY stretch, so slots = 4 per microcycle (ucycles already counts the cycle running now); the RTC crystal is modelled as falling every 2 slots
    // (a test crystal, far faster than 32.768 kHz); harnesses replace this with their own slot counts
    this.clk = { r0: 0, now: () => 4 * m.ucycles - 1, boundary: () => 4 * m.ucycles - 1, oscFalls: s => Math.floor(s / 2) };
    this.timer = new BareTimer(this); }
  tick() { super.tick(); this.kbd.tick(this.steps, this.m); this.mouse.tick(this.steps, this.m); this.sd.tickWrite(); this.timer.boundary(this.m); }
  portIn(port) {
    if (port === 48) return this.timer.in48();
    if (port === 40) return this.rx16 & 255;
    if (port === 41) return 1;
    if (port === 42) return this.kbd.read();
    if (port === 43) return this.kbd.status();
    if (port === 44) return this.mouse.read();
    if (port === 45) return this.mouse.status();
    if (port === 46) return this.rx16 - 9841;
    if (REMOVED.has(port) || port > 27) return 0;
    return super.portIn(port);
  }
  portOut(port, v) {
    const w0 = low9(v), b = ((w0 % 256) + 256) % 256;                                      // T->B table, byte mode
    if (port === 40) { this.sd.tickWrite(); this.rx16 = ((this.rx16 << 8) | this.sd.xfer(b)) & 0xFFFF; this.spiBytes++; return; }
    if (port === 41) { this.sd.setCs(b & 1); this.spiFast = (b >> 1) & 1; return; }
    if (port === 46 || port === 47) { const u = port === 46 ? w0 + 9841 : 0xFFFF;          // T->B table, word / ones mode
      const hi = this.sd.xfer((u >> 8) & 255), lo = this.sd.xfer(u & 255); this.rx16 = (hi << 8) | lo; this.spiBytes += 2; return; }
    if (port >= 42 && port <= 45) return;
    if (port === 0) { this.consoleOut += String.fromCharCode(b); return; }
    if (port >= 49 && port <= 53) return this.timer.out(port, b);
    if (REMOVED.has(port) || port > 27) return;
    return super.portOut(port, v);
  }
}
module.exports = { BareIO, BareTimer, SdCard, Ps2Port, crc16 };
