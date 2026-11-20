// bare-io-test.js: the bare-ports I/O card, end to end (Kehai Interim, 2026-11-18).
//  1. host-side unit test of the SD card model with a separately written JS driver;
//  2. the ternary drivers (bare-drivers.js) run in lockstep on the microsim and on the Triton 3.1.1 emulator, each with
//     its own BareIO + SD card + keyboard instance (the emulator's IN/OUT are routed to its instance for ports >= 40):
//     SD init, read sector 5, write sector 7, read it back, and 40 PS/2 scancodes taken by interrupt, some arriving
//     while interrupts are still off (PS/2 inhibit) and many during SD transfers;
//  3. negative control: a driver with a wrong CMD0 CRC must fail init.
'use strict';
const { loadHtmlModule } = require(require(__dirname+'/../triton-dir.js')+'/tests/t3-common.js'); const { T } = loadHtmlModule('triton3.html');
const { MicroMachine } = require('./microsim.js');
const { BareIO, SdCard } = require('./bareio.js');
const { testProgram, KCOUNT, KBUF, VBR } = require('./bare-drivers.js');
let fails = 0; const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails++; };

// deterministic PRNG
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const encodeSector = (sd, sector, trytes) => { const bytes = new Uint8Array(1536); trytes.forEach((t, i) => { const u = t + 9841; bytes[2 * i] = u >> 8; bytes[2 * i + 1] = u & 255; }); sd.data.set(bytes, sector * 1536); };
const decodeSector = (sd, sector) => { const out = []; for (let i = 0; i < 729; i++) { const o = sector * 1536 + 2 * i; out.push(((sd.data[o] << 8) | sd.data[o + 1]) - 9841); } return out; };
const sector5 = Array.from({ length: 729 }, () => Math.floor(rnd() * 19683) - 9841);
const pattern = Array.from({ length: 729 }, (_, i) => ((i * 37) % 19683) - 9841 + (i % 3));

// ---- 1. host-side SD model test (independent JS driver) ----
{ const sd = new SdCard(32), x = b => sd.xfer(b);
  const cmd = (n, arg, crc) => { x(0xFF); [0x40 | n, arg >>> 24, (arg >> 16) & 255, (arg >> 8) & 255, arg & 255, crc].forEach(x); for (let i = 0; i < 10; i++) { const r = x(0xFF); if (r !== 0xFF) return r; } return -1; };
  sd.setCs(1);
  check(cmd(0, 0, 0x01) === 0x09, 'SD model: CMD0 with a bad CRC answers CRC error (0x09)');
  check(cmd(0, 0, 0x95) === 0x01, 'SD model: CMD0 answers idle');
  check(cmd(17, 0, 1) === 0x05, 'SD model: CMD17 before init is rejected (illegal command)');
  check(cmd(8, 0x1AA, 0x87) === 0x01 && [x(255), x(255), x(255), x(255)][3] === 0xAA, 'SD model: CMD8 echoes 0xAA');
  let r, n = 0; do { cmd(55, 0, 1); r = cmd(41, 0x40000000, 1); n++; } while (r !== 0 && n < 10);
  check(r === 0 && n === 3, `SD model: ACMD41 leaves idle after ${n} tries`);
  const blk = Array.from({ length: 512 }, (_, i) => (i * 7) & 255);
  check(cmd(24, 3, 1) === 0, 'SD model: CMD24 accepted'); x(0xFF); x(0xFE); blk.forEach(x); x(0); x(0);
  check((x(0xFF) & 0x1F) === 5, 'SD model: write data response 0x05');
  let busy = 0; while (x(0xFF) === 0) busy++; check(busy > 0, `SD model: busy for ${busy} bytes after write`);
  check(cmd(17, 3, 1) === 0, 'SD model: CMD17 accepted'); while (x(0xFF) !== 0xFE);
  const back = Array.from({ length: 512 }, () => x(0xFF)); check(back.every((v, i) => v === blk[i]), 'SD model: block reads back');
}

// ---- 2. ternary drivers, lockstep microsim vs emulator ----
function run(opts = {}) {
  const src = testProgram(opts), asm = T.assemble(src, { mode: 'T3' }), code = asm.trytes, sym = asm.symbols;
  const em = new T.TritonJS({ archMode: 'T3' }), mm = new MicroMachine(em.ramSize);
  const mk = () => { const sd = new SdCard(64); encodeSector(sd, 5, sector5); return sd; };
  const mio = new BareIO(mm, mk()); mm.io = mio;
  const eio = new BareIO(em, mk());                                     // the emulator's own instance, same model code
  const origIn = em.handlePortIn.bind(em), origOut = em.handlePortOut.bind(em);
  em.handlePortIn = function (rd, port) { if (port < 40) return origIn(rd, port); const v = eio.portIn(port);
    this.setWord(rd, v, 0, 0); this.sf = v > 0 ? 1 : v < 0 ? -1 : 0; this.cf = 0; this.of = 0; };
  em.handlePortOut = function (rd, port) { if (port < 40) return origOut(rd, port); const [w0] = this.getWord(rd); eio.portOut(port, w0); };
  for (const m of [em, mm]) { code.forEach((v, i) => { m.mem[i] = v; }); pattern.forEach((v, i) => { m.mem[21000 + i] = v; });
    const isr = sym.KBD_ISR; m.mem[VBR + 24] = isr; m.mem[VBR + 25] = 0; m.mem[VBR + 26] = 0; m.sp = 60000; }
  // keyboard script: 2 frames before interrupts are on (the 2nd must wait: inhibit), then ~1 ms apart (1100 steps)
  const keys = []; for (let i = 0; i < (opts.nKeys ?? 40); i++) keys.push(1 + Math.floor(rnd() * 254));
  keys.forEach((k, i) => { const at = i < 2 ? 2 + i : 400 + i * (900 + Math.floor(rnd() * 600)); mio.kbd.send(k, at); eio.kbd.send(k, at); });
  let st = 0, bad = null; const marks = []; let clen = 0;
  while (!em.halted && st < 3e6) {
    eio.tick();                                                         // the microsim ticks its own card inside step()
    em.step(); mm.step(); st++;
    if (mm.io.consoleOut.length !== clen) { clen = mm.io.consoleOut.length; marks.push([st, mm.ucycles]); }
    if (em.pc !== mm.pc || em.sp !== mm.sp || em.ipend !== mm.ipend || em.consoleOut !== mm.io.consoleOut) { bad = `step ${st}: pc ${em.pc}/${mm.pc} sp ${em.sp}/${mm.sp} ipend ${em.ipend}/${mm.ipend} console "${em.consoleOut}"/"${mm.io.consoleOut}"`; break; }
  }
  return { em, mm, mio, eio, st, bad, keys, uc: mm.ucycles, marks };
}

const slow = run({ fast: false });
const r = run();
check(!r.bad, `lockstep: ${r.st.toLocaleString()} instruction steps, microsim vs emulator ${r.bad ? 'MISMATCH ' + r.bad : '0 mismatches'}`);
check(r.mm.io.consoleOut === '0000', `driver results printed by the CPU: "${r.mm.io.consoleOut}" (init, read, write, read-back all 0)`);
const memOf = (m, a, n) => Array.from({ length: n }, (_, i) => m.mem[a + i]);
check(memOf(r.mm, 20000, 729).every((v, i) => v === sector5[i]), 'sector 5 read by the ternary driver matches the SD image');
check(decodeSector(r.mio.sd, 7).every((v, i) => v === pattern[i]), 'sector 7 written by the ternary driver decodes correctly on the SD card');
check(memOf(r.mm, 22000, 729).every((v, i) => v === pattern[i]), 'sector 7 read back matches what was written');
check(r.mio.sd.data.every((v, i) => v === r.eio.sd.data[i]), 'both SD cards (microsim side, emulator side) hold identical bytes');
const kc = r.mm.mem[KCOUNT], kbuf = memOf(r.mm, KBUF, r.keys.length);
check(kc === r.keys.length && kbuf.every((v, i) => v === r.keys[i]), `keyboard: ${kc} scancodes taken by interrupt, in order, none lost`);
check(r.mio.kbd.inhibitedSteps > 0, `keyboard inhibit exercised (device held off for ${r.mio.kbd.inhibitedSteps} steps while the latch was full)`);
for (const m of [r.mm, r.em]) for (let a = 20000; a < 23100; a++) if (r.mm.mem[a] !== r.em.mem[a]) { check(false, `RAM differs at ${a}`); break; }
const neg = run({ cmd0crc: 1, nKeys: 2 });
check(neg.mm.io.consoleOut.startsWith('-1'), `negative control: wrong CMD0 CRC makes init fail ("${neg.mm.io.consoleOut}")`);

// speed: SPI traffic and time for the sector transfers at the measured µcycles/instruction
const us = r.uc / 10;                                                     // 10 MHz µcycle clock
const [m0, m1, m2, m3] = r.marks, ms = (a, b) => ((b[1] - a[1]) / 10 / 1000).toFixed(2);
console.log(`\nSD init ${(m0[1] / 10000).toFixed(2)} ms; read one 729-tryte sector ${m1[0] - m0[0]} instructions = ${ms(m0, m1)} ms; write one sector ${m2[0] - m1[0]} instructions = ${ms(m1, m2)} ms (at 10 MHz, keyboard interrupts included)`);
{ const [s0, s1, s2] = slow.marks, sms = (a, b) => ((b[1] - a[1]) / 10 / 1000).toFixed(2);
  check(!slow.bad && slow.mm.io.consoleOut === '0000', `byte-at-a-time drivers (CPU splits trytes with DIV/MOD) also pass: read ${sms(s0, s1)} ms, write ${sms(s1, s2)} ms per sector`); }
console.log(`read rate ≈ ${(729 / (+ms(m0, m1) / 1000) / 1000).toFixed(1)}K trytes/s`);
console.log(`whole run: ${r.st.toLocaleString()} instructions, ${r.uc.toLocaleString()} µcycles = ${(us / 1000).toFixed(1)} ms at 10 MHz; SPI bytes ${r.mio.spiBytes}`);
require('fs').appendFileSync(__dirname + '/RESULTS-bare-io.jsonl', JSON.stringify({ date: new Date().toISOString(), steps: r.st, ucycles: r.uc, spiBytes: r.mio.spiBytes, fails }) + '\n');
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
