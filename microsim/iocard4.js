// iocard4.js: the Triton 4 I/O card for the microsim (Kehai Interim, 2026-11-18). MIT.
//
// Triton 4 moves a lot onto the I/O card: 27 storage units (sparse, removable, write-protect, media-change IRQ on line 5),
// ports 28-32 (unit select/size/flags, timer mode, RTC), a real-time timer at 200 kHz and the RTC. The firmware's
// behaviour spec is the emulator's own device code, so this adapter runs that code directly: `fw` is a TritonJS instance
// from triton4.html used ONLY as the device model (its CPU is never stepped). Its memory, framebuffer, mode and IRQ lines
// are rewired to the microsim's, so DMA lands in the card's RAM and device IRQs reach the card's interrupt logic.
// The microsim checks the CPU side of the mailbox and the interrupt/timer plumbing; it does not re-derive the devices.
'use strict';
const TM = 19683;
const word3 = v => { const bal = (x, m, h) => { let r = ((x % m) + m) % m; return r > h ? r - m : r; };
  const t0 = bal(v, TM, 9841); const r = (v - t0) / TM; const t1 = bal(r, TM, 9841); return [t0, t1, (r - t1) / TM]; };

function attachIOCard4(m, fw) {
  // rewire the device model onto the card: RAM, framebuffer, mode latch, IRQ pending lines
  fw.mem = m.mem; fw.vram = m.vram; fw.ramSize = m.ramSize;
  Object.defineProperty(fw, 'ipend', { get: () => m.ipend, set: v => { m.ipend = v; }, configurable: true });
  Object.defineProperty(fw, 'archMode', { get: () => m.mode, set: () => {}, configurable: true });
  const io = {
    t4: true, fw,
    // instruction-boundary strobe: step counter, tick counter and the step timer (mode 0) live on the card
    tick() {
      fw.steps += 1;
      if (m.mode === 0) { fw.timerTicks = ((fw.timerTicks + 1 + 9841) % TM + TM) % TM - 9841; return; }
      if (fw.clockFn) fw._syncExternalClock();
      if (fw.timerMode === 0) {
        fw.timerTicks = ((fw.timerTicks + 1 + 9841) % TM + TM) % TM - 9841;
        if (fw.timerPeriod > 0 && ++fw.timerCount >= fw.timerPeriod) { fw.timerCount = 0; m.ipend |= 1; }
      } else fw.timerTicks = fw.realTimeTicks;
    },
    portIn(port) { fw.setWord(0, 0, 0, 0); fw.handlePortIn(0, port); const [a, b, c] = fw.getWord(0); return a + b * TM + c * TM * TM; },
    portOut(port, v) { const [a, b, c] = word3(v); fw.setWord(0, a, b, c); fw.handlePortOut(0, port); },
    pushKeyEvent: (c, u) => fw.pushKeyEvent(c, u), pushMouseEvent: (a, b, c) => fw.pushMouseEvent(a, b, c), pushInputChar: c => fw.pushInputChar(c),
    get consoleOut() { return fw.consoleOut; },
  };
  m.io = io; m.irqLines = 6; m.ownTimer = false;
  Object.defineProperty(m, 'timerPeriod', { get: () => fw.timerPeriod, set: v => { fw.timerPeriod = v; }, configurable: true });
  Object.defineProperty(m, 'timerCount', { get: () => fw.timerCount, set: v => { fw.timerCount = v; }, configurable: true });
  return io;
}
module.exports = { attachIOCard4 };
