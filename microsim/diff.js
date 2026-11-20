// diff.js: run the microcoded datapath and the Triton 3 emulator side by side, compare after every instruction.
// Usage: node diff.js [path/to/triton3.html] [programs]
// v5: faults and traps are compared too (no longer "accepted when both sides fault"): each program gets a vector
// table and two small handlers, may start in user mode with a protection window, and may raise every trap kind.
'use strict';
const path = require('path');
const { MicroMachine, word3, SLOT, OPC } = require('./microsim.js');
const tritonDir = path.resolve(process.argv[2] ? path.dirname(process.argv[2]) : require(__dirname+'/../triton-dir.js')+'');
const { loadHtmlModule } = require(path.join(tritonDir, 'tests/t3-common.js'));
const { T } = loadHtmlModule(path.basename(process.argv[2] || 'triton3.html'));
const NPROG = +(process.argv[3] || 2000);
const RAM = +(process.env.RAMSIZE || 0); // e.g. RAMSIZE=14348907 (3^15, the card's planned full RAM); default: the emulator's 3^14

let s = 0x7E57AB1E; const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 2 ** 32; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1)), pick = a => a[Math.floor(rnd() * a.length)];
const R = () => 'R' + ri(0, 6);               // R8 = data base pointer, R7 = handler scratch: never written by the body
const imm = () => pick([0, 1, -1, 9841, -9841, ri(-9841, 9841), ri(-50, 50)]);
const DATA = 5000;                             // R8 = 5000; data at 5000 +- 2000
const VBR = 9000;                              // vector table (12 words), outside the data window
const off = () => rnd() < 0.15 ? pick([997, 998, 999, 1000, -1001, -1002, -1000]) : ri(-2000, 2000); // edges of the 4000..6000 user window
const SAFE_MTSPR = [0, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 14, 15, 15, 16, -1]; // not 5 (VBR); 0 may switch to T2

// T2 bodies: Triton 2.1 instructions only, plus the odd T3-only op (must halt) and MTSPR #0 (may switch to T3)
function genT2() {
  const n = ri(10, 60), lines = [];
  for (let i = 0; i < n; i++) {
    const fwd = () => 2 * ri(i + 1, n), k = rnd();
    if (k < 0.04) lines.push(`${pick(['SHLI', 'SHRI'])} ${R()}, ${R()}, #${pick([1, 3, -1, 27, 28, ri(-30, 30)])}`);
    else if (k < 0.27) lines.push(`${pick(['ADD', 'ADC', 'SUB', 'SBC', 'TMIN', 'TMAX', 'TCON', 'TANY', 'TXOR', 'MUL', 'DIV', 'MOD'])} ${R()}, ${R()}, ${R()}`);
    else if (k < 0.37) lines.push(`${pick(['ADDI', 'SUBI', 'MULI', 'TUNARY'])} ${R()}, ${R()}, #${imm()}`);
    else if (k < 0.44) lines.push(`${pick(['LI', 'LUI'])} ${R()}, #${imm()}`);
    else if (k < 0.49) lines.push(`${pick(['MOV', 'NEG'])} ${R()}, ${R()}`);
    else if (k < 0.54) lines.push(rnd() < 0.5 ? `CMP ${R()}, ${R()}` : `CMPI ${R()}, #${imm()}`);
    else if (k < 0.70) lines.push(`${pick(['LT', 'ST', 'LW', 'SW'])} ${R()}, ${rnd() < 0.85 ? 'R8' : R()}, #${ri(-2000, 2000)}`); // wild bases wrap mod 3^9
    else if (k < 0.78) lines.push(rnd() < 0.5 ? `PUSH ${R()}` : `POP ${R()}`);
    else if (k < 0.87) lines.push(`${pick(['JMP', 'JN', 'JZ', 'JP', 'JNZ', 'JNP', 'JNN'])} #${fwd()}`);
    else if (k < 0.91) lines.push(`CALL #${2 * (i + 1)}`);
    else if (k < 0.93 && i + 3 < n) { const r = R(); lines.push(`LI ${r}, #${fwd()}`, `JR ${r}`); i++; }
    else if (k < 0.95 && i + 3 < n) { const r = R(); lines.push(`LI ${r}, #${fwd()}`, `PUSH ${r}`, 'RET'); i += 2; }
    else if (k < 0.955) lines.push(`MTSPR ${R()}, #${pick([0, 1, 3, 9, 15])}`); // 1: T2 can drop to user mode too
    else if (k < 0.97) lines.push(`${rnd() < 0.5 ? 'IN' : 'OUT'} ${R()}, #${pick([ri(0, 27), 2, 3, 4, 5, 7, 8])}`);
    else lines.push(pick(['BCOPY R0, R1, R2', 'MFSPR R0, #1', 'LMI R0, #5', 'SYSCALL #1', 'JALR R0, R8, #0'])); // not in T2: halts
  }
  lines.push('HALT');
  const H = 2 * lines.length; lines.push('MFSPR R7, #9', 'ADDI R7, R7, #2', 'MTSPR R7, #9', 'IRET', 'IRET');
  return { src: lines.join('\n'), H, n: lines.length };
}

function genProgram() {
  const n = ri(10, 60), lines = []; // each body line = one instruction (2 trytes) at address 2*i
  for (let i = 0; i < n; i++) {
    const fwd = () => 2 * ri(i + 1, n);   // absolute forward target (HALT sits at 2n)
    const k = rnd();
    const kk = () => pick([0, 1, -1, 2, 26, 27, 28, 29, -27, -28, 9841, -9841, ri(-30, 30), ri(-30, 30), ri(-9841, 9841)]);
    if (k < 0.05) { const op = pick(['SHL', 'SHR']), r = R();
      if (rnd() < 0.4) lines.push(`${op}I ${R()}, ${R()}, #${kk()}`);
      else if (rnd() < 0.7 && i + 3 < n) { lines.push(`LI ${r}, #${kk()}`, `${op} ${R()}, ${R()}, ${r}`); i++; }
      else lines.push(`${op} ${R()}, ${R()}, ${R()}`); }
    else if (k < 0.085) { // I/O: any port, or a whole disk DMA transfer set up through ports 17-20
      if (rnd() < 0.6 && i + 9 < n) { const r = R(), ok = rnd() < 0.75;   // mostly valid transfers, some each kind of error
        const lba = ok ? ri(0, 2184) : pick([2186, 2187, -1]), cnt = ok ? pick([1, 2, 3]) : pick([0, -1, 3]),
          dma = ok ? pick([DATA - 1500, DATA, DATA + 1000, 0, 2000]) : pick([4782000, -5, DATA]);
        lines.push(`LI ${r}, #${lba}`, `OUT ${r}, #17`, `LI ${r}, #${cnt}`, `OUT ${r}, #19`, `LI ${r}, #${dma - 19683 * Math.round(dma / 19683)}`, `LMI ${r}, #${Math.round(dma / 19683)}`,
          `OUT ${r}, #18`, `LI ${r}, #${ok ? pick([1, 1, 2]) : pick([0, 7, 1])}`, `OUT ${r}, #20`); i += 8; }
      else lines.push(`${rnd() < 0.5 ? 'IN' : 'OUT'} ${R()}, #${pick([ri(0, 27), ri(0, 27), ri(0, 27), -1, 40])}`); }
    else if (k < 0.10) { // trap-family instructions
      const t = rnd();
      if (t < 0.30) lines.push(`SYSCALL #${pick([0, 1, 6, -3, ri(-9841, 9841)])}`);
      else if (t < 0.60) lines.push(`MFSPR ${R()}, #${ri(-1, 16)}`);
      else if (t < 0.92) lines.push(`MTSPR ${R()}, #${pick(SAFE_MTSPR)}`);
      else lines.push('IRET'); }
    else if (k < 0.30) lines.push(`${pick(['ADD', 'ADC', 'SUB', 'SBC', 'TMIN', 'TMAX', 'TCON', 'TANY', 'TXOR', 'MUL', 'DIV', 'MOD', 'MUL', 'DIV', 'MOD'])} ${R()}, ${R()}, ${R()}`);
    else if (k < 0.41) lines.push(`${pick(['ADDI', 'SUBI', 'ADDM', 'ADDH', 'MULI', 'TUNARY'])} ${R()}, ${R()}, #${imm()}`);
    else if (k < 0.48) lines.push(`${pick(['LI', 'LUI', 'LMI', 'LHI'])} ${R()}, #${imm()}`);
    else if (k < 0.53) lines.push(`${pick(['MOV', 'NEG'])} ${R()}, ${R()}`);
    else if (k < 0.58) lines.push(rnd() < 0.5 ? `CMP ${R()}, ${R()}` : `CMPI ${R()}, #${imm()}`);
    else if (k < 0.71) { // loads/stores: mostly in the data window, sometimes through a wild register (faults)
      const base = rnd() < 0.85 ? 'R8' : R();
      lines.push(`${pick(['LT', 'ST', 'LW', 'SW', 'LDX', 'STX', 'LWX', 'SWX'])} ${R()}, ${base}, #${off()}`); }
    else if (k < 0.77) lines.push(rnd() < 0.5 ? `PUSH ${R()}` : `POP ${R()}`);
    else if (k < 0.85) { const t = fwd(); const op = pick(['JMP', 'JN', 'JZ', 'JP', 'JNZ', 'JNP', 'JNN']);
      lines.push(rnd() < 0.5 ? `${op} #${t}` : `${op}X #${t - 2 * (i + 1)}`); }
    else if (k < 0.88) lines.push(`CALL #${2 * (i + 1)}`);            // pushes a return address, continues
    else if (k < 0.90) lines.push(`CALLX #0`);
    else if (k < 0.92 && i + 3 < n) { const r = R(), t = fwd(); lines.push(`LI ${r}, #${t}`, `JR ${r}`); i++; }
    else if (k < 0.94 && i + 3 < n) { const r = R(), t = fwd(); lines.push(`LI ${r}, #${t}`, `PUSH ${r}`); lines.push('RET'); i += 2; }
    else if (k < 0.955) lines.push(`JALR ${R()}, R8, #${-DATA + fwd()}`);
    else if (i + 4 < n) { // BCOPY / BFILL with fresh pointers and a small count; registers may alias on purpose
      const d = R(), sr = rnd() < 0.2 ? d : R(), c = rnd() < 0.15 ? pick([d, sr]) : R();
      const wild = () => rnd() < 0.1 ? pick([-3, 4782960 + ri(0, 12), ri(-1e6, 1e7)]) : DATA + ri(-1900, 1900); // sometimes runs off RAM
      if (rnd() < 0.5) { lines.push(`LI ${sr}, #0`, `LI ${d}, #0`, `LI ${c}, #${ri(-2, 25)}`, `BCOPY ${d}, ${sr}, ${c}`); i += 3;
        lines._ptr = (lines._ptr || []).concat([[lines.length - 4, wild()], [lines.length - 3, wild()]]); }
      else { const dd = rnd() < 0.08 ? 2 * (i + 3) - ri(0, 3) : null;
        lines.push(`LI ${sr}, #${ri(-9841, 9841)}`, `LI ${d}, #${dd ?? 0}`, `LI ${c}, #${ri(-2, 25)}`, `BFILL ${d}, ${sr}, ${c}`); i += 3;
        if (dd === null) lines._ptr = (lines._ptr || []).concat([[lines.length - 3, wild()]]); } }
  }
  // wide pointers: LI can't hold them, so build with LI + LMI + LHI in place of the placeholder LI
  for (const [li, v] of (lines._ptr || []).reverse()) { const [w0, w1, w2] = word3(v); const r = lines[li].split(/[ ,]+/)[1];
    lines[li] = `LI ${r}, #${w0}`; lines.splice(li + 1, 0, `LMI ${r}, #${w1}`, `LHI ${r}, #${w2}`); }
  lines.push('HALT');
  const H = 2 * lines.length; // handlers right after HALT
  lines.push('MFSPR R7, #9', 'ADDI R7, R7, #2', 'MTSPR R7, #9', 'IRET'); // H: faults -> skip the faulting instruction
  lines.push('IRET');                                                    // H+8: SYSCALL -> back to the next instruction
  return { src: lines.join('\n'), H, n: lines.length };
}

function wordOf(vm, r) { const [a, b, c] = vm.getWord(r); return a + b * 19683 + c * 19683 * 19683; }
const OPN = Object.fromEntries(Object.entries(OPC).map(([n, o]) => [o, n]));
const SPRS = [[1, 'priv'], [2, 'ie'], [3, 'imask'], [4, 'ipend'], [5, 'vbr'], [6, 'ubase'], [7, 'ulimit'], [8, 'protEn'], [9, 'epc'],
  [10, 'esp'], [11, 'esr'], [12, 'ecause'], [13, 'eaddr'], [14, 'ksp'], [15, 'trapDiv0']];
// Known emulator quirk (reported, not hidden): TritonJS forms effective addresses as unbounded JS numbers, so a base
// near +-(3^27-1)/2 plus an offset gives an EADDR (or PC) outside the 27-trit range that no register can hold. The card
// keeps 27 trits. Both sides fault the same way; only that value differs, by exactly 3^27. Counted, not failed.
const H27 = (3 ** 27 - 1) / 2, wrap27 = x => { let r = x % 3 ** 27; if (r > H27) r -= 3 ** 27; if (r < -H27) r += 3 ** 27; return r; };
const errs = {}; let ioOps = 0, dmaOk = 0, dmaTried = 0, unwrapped = 0, irqRaised = 0, irqTaken = 0, t2Progs = 0, t2Steps = 0; const same = (e, m) => e === m || (Math.abs(e) > H27 && wrap27(e) === m && ++unwrapped);
const stats = new Map(), causes = new Map(); let steps = 0, progs = 0, mism = 0, notYet = 0, halted = 0, userProgs = 0;
for (let p = 0; p < NPROG && mism < (process.env.MICROSIM_MUTANT ? 1 : 3); p++) {
  const t2 = rnd() < 0.3; if (t2) t2Progs++;
  const { src, H, n } = t2 ? genT2() : genProgram(); let asm;
  try { asm = T.assemble(src, { mode: 'T3' }).trytes; } catch (e) { throw new Error('assemble failed: ' + e.message + '\n' + src); }
  // sometimes replace one body instruction with an unallocated opcode (vector 1)
  if (rnd() < 0.3) { const at = 2 * ri(0, n - 7), op = pick([56, 57, 80, 121, -14, -50, -121]); asm[at] = op * 81 + ri(-4, 4) * 9 + ri(-4, 4); }
  const em = new T.TritonJS({ archMode: 'T3', ...(RAM ? { ramSize: RAM } : {}) }), mm = process.env.ROMS ? require('./roms.js').romMachine(require('path').join(__dirname, '../roms'), em.ramSize) : new MicroMachine(em.ramSize);
  em.pc = 0; em.sp = 50000; em.priv = 0; em.ie = 0; em.timerPeriod = 0; em.halted = 0;
  mm.pc = 0; mm.sp = 50000;
  for (let i = 0; i < asm.length; i++) { em.setMem(i, asm[i]); mm.mem[i] = asm[i]; }
  for (let a = DATA - 2100; a < DATA + 2100; a++) { const v = ri(-9841, 9841); em.setMem(a, v); mm.mem[a] = v; }
  for (let v = 0; v < 12; v++) { const w = word3(v >= 6 ? H + 8 : H); /* faults skip; SYSCALL and IRQs just IRET */ for (let j = 0; j < 3; j++) { em.setMem(VBR + 3 * v + j, w[j]); mm.mem[VBR + 3 * v + j] = w[j]; } }
  for (let r = 0; r < 9; r++) {
    const v = r === 8 ? DATA : (r < 3 ? DATA + ri(-1500, 1500) : (r < 5 ? ri(-3, 20) : pick([ri(-9841, 9841), ri(-3e12, 3e12), 0])));
    const w = word3(v); em.setWord(r, w[0], w[1], w[2]); mm.rf[r] = v;
  }
  // SPR start state: vector table, maybe user mode with a protection window, maybe a kernel stack, maybe DIV0 traps
  const user = !t2 && rnd() < 0.35; if (user) userProgs++;
  const init = { 5: VBR, 1: user ? 1 : 0, 14: pick([0, 0, 60000]), 15: pick([0, 1]),
    6: user ? pick([0, 0, 0, 1000, 4000]) : 0, 7: user ? pick([em.ramSize, 60000, 6000, 6000, 50001]) : em.ramSize };
  for (const [i, v] of Object.entries(init)) { em.setSPR(+i, v); mm.sprWrite(+i, v); }
  // interrupts: a step timer, a mask, maybe enabled from the start; devices raise lines at random steps below
  const tp = pick([0, 0, 7, 23, 60, 200]); em.timerPeriod = tp; mm.timerPeriod = tp; em.timerCount = 0;
  for (const [i, v] of [[3, pick([0, 1, 31, ri(0, 31)])], [2, pick([0, 0, 1])]]) { em.setSPR(i, v); mm.sprWrite(i, v); }
  if (t2) { em.setSPR(0, 0); mm.sprWrite(0, 0); const sp0 = pick([-1, 9000, -3000, 19000]); em.sp = sp0; mm.sp = sp0; }
  for (let k = 0; k < 6; k++) { const sec = pick([0, 1, 5, 100, 2186, ri(0, 2186)]); // some disk content on both sides
    for (let j = 0; j < 729; j++) { const v = ri(-9841, 9841); em.disk[sec * 729 + j] = v; mm.io.disk[sec * 729 + j] = v; } }
  progs++;
  for (let st = 0; st < 3000 && !em.halted && !mm.halted; st++) {
    const op = mm.decode.call({ IR: [em.getMem(em.pc) || 0, 0] }).op; // for stats only
    const ev = rnd();   // devices: typed characters, key events and mouse events through the card's queues; raw disk/net lines
    if (ev < 0.006) { const c = ri(32, 126); em.pushInputChar(c); mm.io.pushInputChar(c); irqRaised++; }
    else if (ev < 0.009) { const c = ri(-200, 200), u = ri(0, 1); em.pushKeyEvent(c, u); mm.io.pushKeyEvent(c, u); irqRaised++; }
    else if (ev < 0.012) { const a = ri(-30, 30), b = ri(-30, 30), c = ri(0, 9); em.pushMouseEvent(a, b, c); mm.io.pushMouseEvent(a, b, c); irqRaised++; }
    else if (ev < 0.015) { const b = pick([8, 16]); em.ipend |= b; mm.ipend |= b; irqRaised++; }
    if (em.archMode === 0) t2Steps++;
    const ds0 = em.diskStatus, dl0 = em.diskLba, dc0 = em.diskCount;
    em.step(); const uc = mm.step(); steps++;
    if (mm.unimpl !== null) { notYet++; break; }  // IN/OUT in supervisor mode, or a switch to T2 mode
    const sk = OPN[op] ? op : 'illegal'; const e = stats.get(sk) || [0, 0]; e[0]++; e[1] += uc; stats.set(sk, e);
    if (em.faulted) { const c = op === 52 ? 'sys' : em.ecause; causes.set(c, (causes.get(c) || 0) + 1); }
    if (process.env.TRACE == p) console.log(st, OPN[op] || op, 'pc', em.pc, mm.pc, 'uc', uc, 'priv', em.priv, mm.priv);
    const bad = [];
    if (!same(em.pc, mm.pc)) bad.push(`pc ${em.pc} vs ${mm.pc}`);
    if (em.sp !== mm.sp) bad.push(`sp ${em.sp} vs ${mm.sp}`);
    for (const f of ['sf', 'cf', 'of']) if (em[f] !== mm[f]) bad.push(`${f} ${em[f]} vs ${mm[f]}`);
    for (let r = 0; r < 9; r++) if (wordOf(em, r) !== mm.rf[r]) bad.push(`R${r} ${wordOf(em, r)} vs ${mm.rf[r]}`);
    for (const [i, name] of SPRS) if (!same(em.getSPR(i), mm.sprRead(i))) bad.push(`${name} ${em.getSPR(i)} vs ${mm.sprRead(i)}`);
    const io = mm.io;
    for (const f of ['displayX', 'displayY', 'displayCmd', 'diskAddr', 'diskLba', 'diskDmaAddr', 'diskCount', 'diskStatus', 'diskErr', 'steps',
      'timerTicks', 'inputHead', 'kbdHead', 'mouseHead', 'netTxLen', 'lastKbdCode', 'lastKbdType', 'lastMouseDy', 'lastMouseBtn'])
      if (em[f] !== io[f]) bad.push(`io.${f} ${em[f]} vs ${io[f]}`);
    if (em.timerPeriod !== mm.timerPeriod) bad.push(`timerPeriod ${em.timerPeriod} vs ${mm.timerPeriod}`);
    if (em.consoleOut !== io.consoleOut) bad.push(`console "${em.consoleOut.slice(-20)}" vs "${io.consoleOut.slice(-20)}"`);
    if (op === 31 || op === 32) ioOps++;
    if (op === 32 && em.ioTrace.length && em.ioTrace[em.ioTrace.length - 1][2] === 20) { dmaTried++; if (em.diskStatus === 1) dmaOk++; errs[em.diskErr] = (errs[em.diskErr] || 0) + 1; }
    if (em.archMode !== mm.mode) bad.push(`mode ${em.archMode} vs ${mm.mode}`);
    if (em.timerCount !== mm.timerCount) bad.push(`timerCount ${em.timerCount} vs ${mm.timerCount}`);
    if (!!em.halted !== mm.halted) bad.push('halt');
    if (bad.length) { mism++; console.log(`MISMATCH prog ${p} step ${st} op ${OPN[op] ?? op}: ${bad.join('; ')}\n${src}`); break; }
  }
  if (em.halted) halted++; irqTaken += mm.irqTaken;
  for (let a = 0; a < em.vram.length && mism === 0; a++) if (em.vram[a] !== mm.vram[a]) { mism++; console.log(`VRAM mismatch prog ${p} at ${a}`); }
  for (let a = 0; a < em.disk.length && mism === 0; a++) if (em.disk[a] !== mm.io.disk[a]) { mism++; console.log(`DISK mismatch prog ${p} at ${a}`); }
  if (mm.unimpl === null) for (let a = 0; a < 62000 && mism === 0; a++) if (em.getMem(a) !== mm.mem[a]) { mism++; console.log(`MEM mismatch prog ${p} at ${a}`); }
}
const CN = { 1: 'illegal op', 2: 'privilege', 3: 'protection', 4: 'bad address', 5: 'div by 0' };
console.log(`RAM ${RAM || 'emulator default (3^14)'} trytes`);
console.log(`programs ${progs} (${userProgs} starting in user mode), instruction steps compared ${steps}, MISMATCHES ${mism}, ` +
  `stopped at a not-yet-microcoded case ${notYet}, halted ${halted}`);
console.log(`I/O: ${ioOps} IN/OUT steps compared, ${dmaOk} completed disk DMA transfers of ${dmaTried} commands ${JSON.stringify(errs)} (device state, console, VRAM and the whole disk checked too)`);
console.log(`T2 mode: ${t2Progs} programs started in T2; ${t2Steps} steps compared in T2 mode (incl. switches from T3)`);
console.log(`emulator values outside 27 trits (EADDR/PC = card value + 3^27, the known TritonJS quirk): ${unwrapped} comparisons`);
console.log('traps taken (compared): ' + [...causes].filter(([c]) => CN[c]).sort((a, b) => a[0] - b[0]).map(([c, k]) => `${CN[c]} ${k}`).join(', ') +
  `, syscalls ${causes.get('sys') || 0}; interrupts taken ${irqTaken} (device lines raised ${irqRaised}, plus the step timer)`);
console.log('µcycles per instruction (incl. 3-cycle fetch; a trap\'s cycles count against the instruction that raised it):');
console.log([...stats].sort((a, b) => (a[0] === 'illegal') - (b[0] === 'illegal') || a[0] - b[0]).map(([o, [k, c]]) => `${OPN[o] ?? o}:${(c / k).toFixed(1)}`).join('  '));
process.exit(mism ? 1 : 0);
