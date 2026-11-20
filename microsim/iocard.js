// iocard.js: reference model of the I/O card's microcontroller firmware, as seen from the bus (Kehai Interim, 2026-11-18). MIT.
//
// The I/O card is the one binary card on purpose (keyboards, SD cards and networks are binary worlds). The CPU talks to it
// through a mailbox: IN/OUT put a port number (and for OUT a value) on the card, then the sequencer WAITs until the card
// raises IORDY. Disk DMA and framebuffer fills are done by the card as bus master while the CPU is held in WAIT, so they
// have finished when the instruction retires (the same point in the step at which the emulator does them).
//
// Provenance: port semantics ported from triton3.html (Triton 3.1.1), TritonJS.handlePortIn / handlePortOut, and the
// event queues from pushInputChar / pushKeyEvent / pushMouseEvent (same caps and recycling rules). This file is the spec
// the real firmware has to meet; the microsim's job is the CPU side of the mailbox, not to re-derive the devices.
// Changes from the source: state lives here instead of on the VM; RAM/VRAM/IRQ/timer are reached through the machine `m`;
// network transmit hooks are not modelled (the frame is dropped, as with no hooks attached).
'use strict';
const TM = 19683, TH = 9841, SECTOR = 729, FB_W = 729, FB_H = 486, INPUT_QUEUE_CAP = 4096 + 65536, EVENT_RING_SLOTS = 2048;
const balRem = (x, m, h) => { let r = ((x % m) + m) % m; return r > h ? r - m : r; };
const word3 = v => { const t0 = balRem(v, TM, TH); const r = (v - t0) / TM; const t1 = balRem(r, TM, TH); return [t0, t1, (r - t1) / TM]; };
const physAddr = a => { const r = a % TM; return r < 0 ? r + TM : r; };

class IOCard {
  constructor(m, diskSectors = 2187) {
    this.m = m; this.diskSectors = diskSectors; this.diskSize = diskSectors * SECTOR; this.disk = new Int16Array(this.diskSize);
    this.inputQueue = []; this.inputHead = 0; this.kbdQueue = []; this.kbdHead = 0; this.mouseQueue = []; this.mouseHead = 0;
    this.lastKbdCode = 0; this.lastKbdType = 0; this.lastMouseDx = 0; this.lastMouseDy = 0; this.lastMouseBtn = 0;
    this.displayX = 0; this.displayY = 0; this.displayCmd = 0; this.consoleOut = '';
    this.steps = 0; this.timerTicks = 0; this.diskAddr = 0;
    this.diskLba = 0; this.diskDmaAddr = 0; this.diskCount = 0; this.diskStatus = 0; this.diskErr = 0;
    this.nodeId = 3; this.netTxBuf = new Uint8Array(512); this.netTxLen = 0; this.netRxFrame = null; this.netRxPos = 0; this.netRxQueue = [];
  }
  // instruction boundary strobe from the CPU card (the step counter and the 9-trit tick counter live here)
  tick() { this.steps++; this.timerTicks = balRem(this.timerTicks + 1, TM, TH); }
  // host side: devices
  pushInputChar(code) { const c = balRem(code, TM, TH);
    if (this.inputHead >= this.inputQueue.length) { this.inputQueue = []; this.inputHead = 0; }
    if (this.inputQueue.length < INPUT_QUEUE_CAP) this.inputQueue.push(c);
    this.pushKeyEvent(c, 0); }
  pushKeyEvent(code, isUp = 0) { const c = balRem(code, TM, TH);
    if (this.kbdHead >= this.kbdQueue.length) { this.kbdQueue = []; this.kbdHead = 0; }
    else if (this.kbdHead >= 4096) { this.kbdQueue = this.kbdQueue.slice(this.kbdHead); this.kbdHead = 0; }
    if (this.kbdQueue.length - this.kbdHead < EVENT_RING_SLOTS) { this.kbdQueue.push([c, isUp ? 1 : 0]); this.m.ipend |= 2; } }
  pushMouseEvent(dx, dy, buttons = 0) {
    if (this.mouseHead >= this.mouseQueue.length) { this.mouseQueue = []; this.mouseHead = 0; }
    else if (this.mouseHead >= 4096) { this.mouseQueue = this.mouseQueue.slice(this.mouseHead); this.mouseHead = 0; }
    if (this.mouseQueue.length - this.mouseHead < EVENT_RING_SLOTS) {
      this.mouseQueue.push([balRem(dx, TM, TH), balRem(dy, TM, TH), buttons & 7]); this.m.ipend |= 4; } }
  // CPU side: IN returns a 27-trit value
  portIn(port) {
    const m = this.m, t2 = m.mode === 0; let w0 = 0, w1 = 0, w2 = 0;
    if (port === 0) { if (this.inputHead < this.inputQueue.length) w0 = this.inputQueue[this.inputHead++]; }
    else if (port === 1) w0 = balRem(this.inputQueue.length - this.inputHead, TM, TH);
    else if (port === 2) w0 = this.displayX;
    else if (port === 3) w0 = this.displayY;
    else if (port === 4) w0 = m.vram[this.displayY * (t2 ? 243 : FB_W) + this.displayX];
    else if (port === 5) w0 = this.displayCmd;
    else if (port === 6) { if (t2) w0 = this.timerTicks; else [w0, w1, w2] = word3(this.steps); }
    else if (port === 7) { if (t2) w0 = this.diskAddr; else [w0, w1, w2] = word3(this.diskAddr); }
    else if (port === 8) {
      if (t2) { w0 = this.disk[this.diskAddr]; this.diskAddr = (this.diskAddr + 1) % TM; }
      else { w0 = (this.diskAddr >= 0 && this.diskAddr < this.diskSize) ? this.disk[this.diskAddr] : 0; this.diskAddr = (this.diskAddr + 1) % this.diskSize; } }
    else if (port === 9) [w0, w1, w2] = word3(m.timerPeriod);
    else if (port === 10) w0 = balRem(this.kbdQueue.length - this.kbdHead, TM, TH);
    else if (port === 11) { if (this.kbdHead < this.kbdQueue.length) { const [kc, ku] = this.kbdQueue[this.kbdHead++]; this.lastKbdCode = kc; this.lastKbdType = ku; w0 = kc; } }
    else if (port === 12) w0 = this.lastKbdType;
    else if (port === 13) w0 = balRem(this.mouseQueue.length - this.mouseHead, TM, TH);
    else if (port === 14) { if (this.mouseHead < this.mouseQueue.length) { const [dx, dy, b] = this.mouseQueue[this.mouseHead++]; this.lastMouseDx = dx; this.lastMouseDy = dy; this.lastMouseBtn = b; w0 = dx; } }
    else if (port === 15) w0 = this.lastMouseDy;
    else if (port === 16) w0 = this.lastMouseBtn;
    else if (port === 17) [w0, w1, w2] = word3(this.diskLba);
    else if (port === 18) [w0, w1, w2] = word3(this.diskDmaAddr);
    else if (port === 19) [w0, w1, w2] = word3(this.diskCount);
    else if (port === 20) w0 = this.diskStatus;
    else if (port === 21) w0 = this.diskErr;
    else if (port === 22) w0 = 0xA4 | (this.netRxFrame ? 1 : 0);
    else if (port === 23) w0 = this.nodeId;
    else if (port === 24) w0 = this.netTxLen;
    else if (port === 25) w0 = this.netRxFrame ? this.netRxFrame.length : 0;
    else if (port === 27) { if (this.netRxFrame && this.netRxPos < this.netRxFrame.length) w0 = this.netRxFrame[this.netRxPos++]; }
    return w0 + w1 * TM + w2 * TM * TM;
  }
  // CPU side: OUT delivers a 27-trit value
  portOut(port, v) {
    const m = this.m, t2 = m.mode === 0, [w0] = word3(v);
    if (port === 0) this.consoleOut += String.fromCharCode((((w0 % TM) + TM) % TM) & 0xFFFF);
    else if (port === 1) this.consoleOut += BigInt(v).toString();
    else if (port === 2) { const w = t2 ? 243 : FB_W; this.displayX = ((w0 % w) + w) % w; }
    else if (port === 3) { const h = t2 ? 243 : FB_H; this.displayY = ((w0 % h) + h) % h; }
    else if (port === 4) { if (t2) m.vram[this.displayY * 243 + this.displayX] = balRem(w0, 27, 13); else m.vram[this.displayY * FB_W + this.displayX] = balRem(w0, 729, 364); }
    else if (port === 5) { const c = t2 ? balRem(w0, 27, 13) : balRem(w0, 729, 364); this.displayCmd = c; if (t2) m.vram.fill(c, 0, 59049); else m.vram.fill(c); }
    else if (port === 6) this.timerTicks = w0;
    else if (port === 7) { if (t2) this.diskAddr = physAddr(w0); else { let r = v % this.diskSize; if (r < 0) r += this.diskSize; this.diskAddr = r; } }
    else if (port === 8) {
      if (t2) { this.disk[this.diskAddr] = w0; this.diskAddr = (this.diskAddr + 1) % TM; }
      else { if (this.diskAddr >= 0 && this.diskAddr < this.diskSize) this.disk[this.diskAddr] = w0; this.diskAddr = (this.diskAddr + 1) % this.diskSize; } }
    else if (port === 9) { m.timerPeriod = v > 0 ? v : 0; m.timerCount = 0; }
    else if (port === 17) this.diskLba = v;
    else if (port === 18) this.diskDmaAddr = v;
    else if (port === 19) this.diskCount = v;
    else if (port === 20) {
      const cmd = w0;
      if (cmd === 0) { this.diskStatus = 0; this.diskErr = 0; }
      else if (cmd === 1 || cmd === 2) {
        if (this.diskCount <= 0 || this.diskLba < 0 || this.diskLba + this.diskCount > this.diskSectors) { this.diskStatus = -1; this.diskErr = 1; }
        else { const n = this.diskCount * SECTOR;
          if (this.diskDmaAddr < 0 || this.diskDmaAddr + n > m.ramSize) { this.diskStatus = -1; this.diskErr = 2; }
          else { const d0 = this.diskLba * SECTOR;             // bus-master DMA, CPU held in WAIT meanwhile
            if (cmd === 1) for (let i = 0; i < n; i++) m.mem[this.diskDmaAddr + i] = this.disk[d0 + i];
            else for (let i = 0; i < n; i++) this.disk[d0 + i] = m.mem[this.diskDmaAddr + i];
            this.diskStatus = 1; this.diskErr = 0; m.ipend |= 8; } } }
      else { this.diskStatus = -1; this.diskErr = 3; } }
    else if (port === 24) this.netTxLen = 0;                    // (transmit hooks not modelled)
    else if (port === 25) { if (w0 === 1) { this.netRxFrame = this.netRxQueue.length ? this.netRxQueue.shift() : null; this.netRxPos = 0; } }
    else if (port === 26) { if (this.netTxLen < 512) this.netTxBuf[this.netTxLen++] = ((w0 % 256) + 256) % 256; }
  }
}
module.exports = { IOCard };
