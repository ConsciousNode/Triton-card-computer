// io-ports-tables.js: the I/O card's port-side lookup tables (bare ports 40-47 and the port bridge) (Kehai Interim,
// 2026-11-19). MIT. Spec: microsim/bareio.js. Design: IO-CARD.md. Every table is an SRAM image the copy engine loads.
'use strict';
const T = require('./control-tables.js');
const enc = t => t === 1 ? 1 : t === -1 ? 2 : 0, dec = b => b === 1 ? 1 : b === 2 ? -1 : 0;
const encRails = (v, n) => { let b = 0; T.toT(v, n).forEach((t, i) => { b += enc(t) * 2 ** (2 * i); }); return b; };
// rails -> value, or null if some trit has both rails high
const decRails = (bits, n) => { let x = 0; for (let i = n - 1; i >= 0; i--) { const r = Math.floor(bits / 2 ** (2 * i)) & 3; if (r === 3) return null; x = 3 * x + dec(r); } return x; };
const B19 = () => Buffer.alloc(1 << 19), B21 = () => Buffer.alloc(1 << 21);
const bit = (x, i) => (x >> i) & 1;

// ---- THE PORT BRIDGE ----
// T->B (2 x IS61WV20488). addr: the low tryte as 18 rails (D0+ D0- .. D8+ D8-) | PORT0 << 18 | PORT1 << 19 | PORT2 << 20.
// data (16 bits; chip 0 = bits 0..7, chip 1 = bits 8..15): port 46 -> w0 + 9841; port 47 -> 0xFFFF (clock 16 bits in);
// every other port -> (w0 mod 256) << 8: a byte goes out of the high '165 first, and OUT 41 reads bits 8 (chip select)
// and 9 (fast clock) of the same word.
function t2b(chip, mutant) { const m = B21();
  for (let a = 0; a < 1 << 21; a++) { const w = decRails(a & 0x3FFFF, 9); if (w === null) continue; const p = a >> 18;
    let u = p === 6 ? w + 9841 : p === 7 ? 0xFFFF : (((w % 256) + 256) % 256) << 8;
    if (mutant === 'BRIDGE_OFF_BY_ONE' && p === 6) u = (u + 1) & 0xFFFF;
    m[a] = (u >> (8 * chip)) & 255; }
  return m; }
// B->T (3 x IS61WV5128). addr: the answer bus ANS0..15 | PORT0..2 << 16. data: 11 trits as 22 rails (chip k = rails
// 8k..8k+7). What the answer bus carries depends on the port (the decode table turns one source on):
//   40: the receive register (IN 40 = its low byte)        46: the receive register (IN 46 = the 16 bits - 9841)
//   42, 44: a PS/2 data latch, which holds the bits inverted (the shift register stores !bit; see IO-CARD.md)
//   41, 43, 45: the status buffer: ANS0 card detect, ANS1..3 keyboard ready / parity error / framing error,
//               ANS4..6 the same for the mouse                47: nothing drives it (pull-ups); the answer is 0
const STATUS = { CD: 0, KRDY: 1, KPERR: 2, KFERR: 3, MRDY: 4, MPERR: 5, MFERR: 6 };
function b2tValue(ans, p, mutant) {
  switch (p) {
    case 0: return ans & 255;
    case 1: return bit(ans, STATUS.CD);
    case 2: case 4: return (~ans) & 255;
    case 3: return bit(ans, STATUS.KRDY) | bit(ans, STATUS.KPERR) << 1 | bit(ans, STATUS.KFERR) << 2;
    case 5: return bit(ans, STATUS.MRDY) | bit(ans, STATUS.MPERR) << 1 | bit(ans, STATUS.MFERR) << 2;
    case 6: return mutant === 'B2T_NO_OFFSET' ? ans : ans - 9841;
    default: return 0; } }
function b2t(chip, mutant) { const m = B19();
  for (let a = 0; a < 1 << 19; a++) m[a] = (encRails(b2tValue(a & 0xFFFF, a >> 16, mutant), 11) / 2 ** (8 * chip)) & 255;
  return m; }

// ---- port decode at the CPU edge ----
// addr: PORT0..5 | CW_/IN << 6 | CW_/OUT << 7 | /CEDGE << 8 | ISEL << 9   (ISEL: the last IN was to a port on this card)
// DT1 data: /START << 0 (OUT 40, 46, 47: start an exchange) | WR41 << 1 | /LDANS << 2 (IN 40..47: load the answer)
//           | ISELD << 3 | RDK << 4 (IN 42) | RDM << 5 (IN 44) | /OE_RX << 6 (IN 40, 46) | /OE_KD << 7 (IN 42)
// DT2 data: /OE_MD << 0 (IN 44) | /OE_ST << 1 (IN 41, 43, 45)
// The answer-bus sources are only turned on in the edge slot, so the bus is quiet the rest of the time.
function decode(x) { const port = x & 63, inn = !bit(x, 6), out = !bit(x, 7), edge = !bit(x, 8), isel = bit(x, 9);
  // IN 48 (the timer/RTC read port, 2026-11-19) is answered by this card too: it loads the answer register like 40..47
  const mine = port >= 40 && port <= 47, mineIn = mine || port === 48, p = port - 40, i = edge && inn && mine, o = edge && out && mine;
  return { start: o && (p === 0 || p === 6 || p === 7), wr41: o && p === 1, ldans: edge && inn && mineIn, iseld: edge && inn ? (mineIn ? 1 : 0) : isel,
    rdk: i && p === 2, rdm: i && p === 4, oeRx: i && (p === 0 || p === 6), oeKd: i && p === 2, oeMd: i && p === 4, oeSt: i && (p === 1 || p === 3 || p === 5) }; }
function dt1(mutant) { const m = B19(); for (let x = 0; x < 1 << 10; x++) { const d = decode(x);
    if (mutant === 'IN42_NO_CLEAR') d.rdk = false;
    m[x] = (d.start ? 0 : 1) | (d.wr41 ? 1 : 0) << 1 | (d.ldans ? 0 : 1) << 2 | d.iseld << 3 | (d.rdk ? 1 : 0) << 4 | (d.rdm ? 1 : 0) << 5
      | (d.oeRx ? 0 : 1) << 6 | (d.oeKd ? 0 : 1) << 7; } return m; }
// dt2 bit 2 (2026-11-19): /CSTART, the console's start strobe: OUT 0 at the CPU edge
function dt2() { const m = B19(); for (let x = 0; x < 1 << 10; x++) { const d = decode(x), cstart = (x & 63) === 0 && !bit(x, 7) && !bit(x, 8);
    m[x] = (d.oeMd ? 0 : 1) | (d.oeSt ? 0 : 1) << 1 | (cstart ? 0 : 1) << 2; } return m; }
// ---- the console (OUT 0, 2026-11-19): 115,200 baud 8N1 out of the CON_TX pin ----
// A 12-bit baud counter ('161 x 3) loads 3749 and gives BTC at 4095: one slot in 347 (40 MHz / 347 = 115,274 baud,
// +0.064 %). OUT 0 latches the byte (TB8..15) and loads the bit counter with 1 and the baud counter (so the start bit
// gets a full bit time). Bit counter: 1 = start (0), 2..9 = data bits 0..7 (LSB first), 10 = stop (1), 0 and 11.. =
// idle (1). BUSY = 1..10; the card holds IORDY low while busy, so OUT 0 waits for the whole byte.
// CON addr: CS0..7 | CB0..3 << 8 | BTC << 12 | /CSTART << 13. data: TXD_D | /CBUSY << 1 | /BLD << 2 | CBUSY << 3
function conTable(mutant) { const m = B19();
  for (let x = 0; x < 1 << 14; x++) { const byte = x & 255, cb = (x >> 8) & 15, btc = bit(x, 12), cstart = !bit(x, 13);
    const busy = cb >= 1 && cb <= 10;
    let txd = 1; if (cb === 1) txd = 0; else if (cb >= 2 && cb <= 9) txd = (byte >> (mutant === 'CON_MSB_FIRST' ? 9 - cb : cb - 2)) & 1;
    if (mutant === 'CON_NO_STOP' && cb === 10) txd = 0;
    const bld = btc || cstart;
    m[x] = txd | (busy ? 0 : 1) << 1 | (bld ? 0 : 1) << 2 | (busy ? 1 : 0) << 3; }
  return m; }

// ---- the SPI sequencer ----
// addr: PRE0..5 | PH0..5 << 6 | BUSY << 12 | N16 << 13 | FAST << 14 | /START << 15 | PORT1 << 16 | RESET << 17
// data (into a '574 every slot): BUSY' | N16' << 1 | SHLD' << 2 (0 = the '165s load) | PHCE << 3 | /PHLD << 4
//      | /PRELD << 5 | PRECE << 6 | READY' << 7
// One SCK half-period is a "tick": every 2 slots fast (10 MHz SCK), every 64 slow (312.5 kHz). SCK = PH0. The '165s
// load while PH = 0, the receiver samples MISO on each rising SCK edge, the '165s shift on each falling one; after
// 2N ticks (N = 8 or 16 bits) the exchange is done.
const SLOW = 63, FASTLIM = 1;
function spiNext(x, mutant) { const pre = x & 63, ph = (x >> 6) & 63, busy = bit(x, 12), n16 = bit(x, 13), fast = bit(x, 14), start = !bit(x, 15), p1 = bit(x, 16), rst = bit(x, 17);
  const o = { busy: 0, n16, shld: 1, phce: 0, phld: 1, preld: 1, prece: 0 };
  if (rst) Object.assign(o, { busy: 0, n16: 0, phld: 0, preld: 0 });
  else if (start) Object.assign(o, { busy: 1, n16: p1, shld: 0, phld: 0, preld: 0 });
  else if (busy) { const N = (n16 ? 32 : 16) - (mutant === 'SPI_SHORT' && n16 ? 2 : 0), lim = fast ? FASTLIM : SLOW, tick = pre >= lim;
    if (ph >= N) o.busy = 0;
    else Object.assign(o, { busy: 1, phce: tick ? 1 : 0, preld: tick ? 0 : 1, prece: tick ? 0 : 1, shld: ph === 0 && !tick ? 0 : 1 }); }
  return o; }
function spiTable(mutant) { const m = B19(); for (let x = 0; x < 1 << 18; x++) { const o = spiNext(x, mutant);
    m[x] = o.busy | o.n16 << 1 | o.shld << 2 | o.phce << 3 | o.phld << 4 | o.preld << 5 | o.prece << 6 | (o.busy ? 0 : 1) << 7; } return m; }

// ---- a PS/2 receiver's state table (one per port) ----
// addr: S0..S10 (the inverted shift register: S10 = !start bit, S9..S2 = !d0..!d7, S1 = !parity, S0 = !stop)
//       | RDY << 11 | IRQ << 12 | CAPQ << 13 | RD << 14 | RESET << 15 | /CEDGE << 16 | PERR << 17 | FERR << 18
// data (into a '574 every slot): RDY' | IRQ' << 1 | CAP' << 2 | /CLR' << 3 | PERR' << 4 | FERR' << 5 | /RDY' << 6
// A frame is complete when S10 = 1 (the start bit, stored as 1, has reached the end; the register is cleared to 0s).
// Capture: RDY and IRQ set, CAP rises (it clocks the data latch), the next slot clears the shift register. IRQ stays
// up until a CPU edge has seen it (one pulse into IPEND). While RDY the card holds the PS/2 clock low (inhibit), and
// IN 42 / 44 (RD) clears RDY.
function ps2Next(x, mutant) { const s = x & 2047, rdy = bit(x, 11), irq = bit(x, 12), capq = bit(x, 13), rd = bit(x, 14), rst = bit(x, 15), edge = !bit(x, 16), perr = bit(x, 17), ferr = bit(x, 18);
  const o = { rdy, irq: irq && !edge ? 1 : 0, cap: 0, clr: 1, perr, ferr };
  if (rst) return { rdy: 0, irq: 0, cap: 0, clr: 0, perr: 0, ferr: 0 };
  if (bit(s, 10) && !rdy && !capq) {   // capture (wins over a read in the same slot)
    let ones = 0; for (let i = 2; i <= 9; i++) ones += 1 - bit(s, i); ones += 1 - bit(s, 1);
    Object.assign(o, { rdy: 1, irq: mutant === 'NO_IRQ' ? 0 : 1, cap: 1, perr: ones % 2 === 1 ? 0 : 1, ferr: bit(s, 0) }); }
  else { if (capq) o.clr = 0; if (rd) o.rdy = 0; }
  return o; }
function ps2Table(mutant) { const m = B19(); for (let x = 0; x < 1 << 19; x++) { const o = ps2Next(x, mutant);
    m[x] = o.rdy | o.irq << 1 | o.cap << 2 | o.clr << 3 | o.perr << 4 | o.ferr << 5 | (o.rdy ? 0 : 1) << 6; } return m; }

// ---- the timer and RTC (ports 48..53, 2026-11-19) ----
// The bare timer/RTC ports (the CPU's driver does all the arithmetic; see IO-CARD.md):
//   OUT 50 / 51: period latch, low / high byte (L = the counter's reload value; the period is 65536 - L ticks)
//   OUT 49: arm: load the period counter from the latch now
//   OUT 52: snapshot: both 'LV8154s store their counters (the 200 kHz tick count and the RTC's half-seconds)
//   OUT 53: bits 0..2 = which stored byte IN 48 reads (0..3 tick count, 4..7 RTC), bit 3 = timer enable
//   IN 48: the selected stored byte (B->T byte mode: PORT0..2 = 0)
// DT3 addr: PORT0..5 | CW_/IN << 6 | CW_/OUT << 7 | /CEDGE << 8 | TC4 << 9 | TICK << 10 | IRQ0 << 11 | SNAPP << 12
//           | RESET << 13
// DT3 data: /WRPL | /WRPH << 1 | /WRSEL << 2 | /OE_T << 3 | /PE_PER << 4 | IRQ0D << 5 | SNAPPD << 6 | RCLKD << 7
// TC4 = the period counter at all ones with the timer enabled; it fires on a TICK slot: the counter reloads and the
// IRQ flag sets. The flag stays up until a CPU edge has seen it (one pulse into IPEND per firing).
// A snapshot never clocks RCLK in the same slot as a tick (the tick counter's CLKA rises at the end of a TICK slot): a
// request in a TICK slot is held for one slot (SNAPP), so the two clocks never rise together.
function dt3(mutant) { const m = B19();
  for (let x = 0; x < 1 << 14; x++) { const port = x & 63, inn = !bit(x, 6), out = !bit(x, 7), edge = !bit(x, 8), tc4 = bit(x, 9), tick = bit(x, 10),
      irq = bit(x, 11), snapp = bit(x, 12), rst = bit(x, 13);
    const o = edge && out, wrpl = o && port === 50, wrph = o && port === 51, wrsel = o && port === 53, arm = o && port === 49, snapReq = o && port === 52;
    const oeT = edge && inn && port === 48, fire = tc4 && tick;
    const pe = (mutant === 'TMR_NO_RELOAD' ? false : fire) || arm;
    const irq0d = rst ? 0 : (fire || (irq && (mutant === 'IRQ_NO_CLEAR' || !edge))) ? 1 : 0;
    const want = snapReq || snapp, defer = mutant === 'SNAP_NO_DEFER' ? false : tick;
    const rclkd = rst ? 0 : (want && !defer) ? 1 : 0, snappd = rst ? 0 : (want && defer) ? 1 : 0;
    m[x] = (wrpl ? 0 : 1) | (wrph ? 0 : 1) << 1 | (wrsel ? 0 : 1) << 2 | (oeT ? 0 : 1) << 3 | (pe ? 0 : 1) << 4 | irq0d << 5 | snappd << 6 | rclkd << 7; }
  return m; }

module.exports = { t2b, b2t, b2tValue, dt1, dt2, dt3, conTable, spiTable, ps2Table, encRails, decRails, STATUS, decode };
