# microsim: the card computer's microcoded datapath, checked against the emulator

- `microsim.js`: a signal-level model of the datapath in `../CONTROL-SIGNALS.md`.
  - The ALU is 9 ripple-carry slices of 3-trit lookup tables.
  - The shifter is wiring.
  - It has a single-port register RAM, MAR/MDR, and IR.
  - Conditions read *latched* flags.
  - Every microinstruction is packed into its bit fields, so anything that doesn't fit throws.
- `diff.js`: random programs run on the microsim and on Triton 3's `TritonJS` side by side. PC, SP, R0–R8 and the
  flags are compared after **every instruction**, and RAM at the end.

## v0 result (2026-11-17), `RESULTS-v0.txt`

- 50 opcodes are microcoded: everything except MUL/MULI/DIV/MOD, shifts, TCON/TANY/TXOR/TUNARY, BFILL,
  IN/OUT, SYSCALL/IRET/MFSPR/MTSPR, faults and interrupts.
- 5,000 programs, **2,466,095 instruction steps compared, 0 mismatches**.
  - 277 programs ended in a fault on both sides (bad address or illegal opcode, after jumping into data).
  - 15 reached an opcode not microcoded yet.
- **Positive controls:** four planted microcode bugs are each caught.

  | `MICROSIM_MUTANT` | What it breaks |
  |---|---|
  | `ADC_NO_CARRY` | ADC ignores the carry |
  | `CMP_AS_ARITH` | CMP sets flags like ADD |
  | `BCOPY_WRITE_ORDER` | BCOPY writes rs2 before rs1 (visible only when registers alias) |
  | `LUI_SHIFT_8` | LUI shifts by 3 instead of 9 |

- **Microword: 63 bits** (8 flash chips). It grew from 61 because the IR needs 2 load bits and MAR needs +1.
- The sim found one bug in itself: the first shifter multiplied in floating point and lost a trit above 2^53.
  It's now wiring on trits, as the hardware is.

## Speed (µcycles per instruction, including the 3-cycle fetch)

| Instruction class | µcycles |
|---|---|
| LI, JMP, JR | 4 |
| ALU ops | 5–6 |
| Taken branches | ~5 |
| Tryte load/store | 8 |
| Word load/store, PUSH, CALL | 10 |
| **BCOPY: one tryte per step, as the emulator** | **18.9** |

Weighted by the TritOS mix (block moves 38.9%, loads/stores 20.4%, branches 19.5%, arithmetic 12.6%, mul/div
1.7% at an assumed ~60):
- **≈12.4 µcycles per step → ≈0.81M steps/s at 10 MHz**, about 4× TritOS's 200k/s pace.
- BCOPY is ~59% of all cycles. A tighter BCOPY loop (no refetch, no aliasing detour when registers are
  distinct) is the biggest lever. At ~8 µcycles per tryte it gives about 1.2M steps/s.

## v1 (2026-11-17 evening): fast BCOPY, `RESULTS-v1.txt`

- **The fast path loops inside the instruction** when the three registers are distinct.
  - Each pass retires one step: there's a new `RETIRE` bit, which also drives the step timer.
  - PC holds the instruction's own address between passes, as the emulator's re-execution leaves it.
  - With an IRQ pending, it goes back to fetch.
- **Aliased registers take the old path:** a new `ALIAS` condition compares the IR's register fields.
- **Self-modifying copy guard.** The differential caught it. A BCOPY whose destination range covered its *own* two
  trytes rewrote itself, and the emulator (refetching every tryte) executed the new code while the loop didn't.
  - Now a check runs once on entry: if [dst, dst+cnt−1] overlaps the instruction, it takes the refetching path.
  - Positive control `BCOPY_FAST_NO_SELFMOD_GUARD` is caught.
- **Microword: 64 bits**, still 8 chips. PC became an up/down counter (2 bits), RETIRE took 1, and LD_IR shrank to 1
  bit (the lane comes from MDR_LANE).
- **Results:**
  - same 5,000 programs: 2,466,095 steps, **0 mismatches**;
  - mutants `BCOPY_FAST_PC`, `BCOPY_FAST_NO_ALIAS_GUARD` and `BCOPY_FAST_NO_SELFMOD_GUARD` are all caught.
- **Long copy: 9.00 µcycles per tryte** (2,000-tryte copy), down from 18.9.
- **On the TritOS mix:** ≈8.5 µcycles per step → **≈1.17M steps/s at 10 MHz** (was ≈0.81M), about 6× TritOS's pace.

## v2 (2026-11-17 night): multiply, divide, tritwise, `RESULTS-v2.txt`

- **New opcodes:** MUL, MULI, DIV, MOD, TCON, TANY, TXOR, TUNARY. That's 58 microcoded in total.
- **MUL** takes 27 passes, low multiplier trit first. P_hi += digit·X, then the 54-trit pair (T0:T1) shifts right one
  trit:
  - `R1C` keeps the adder's carry as the 28th trit;
  - `LINK` carries the trit falling out of P_hi into P_lo's top.
  
  Balanced ternary needs no sign fix-up.
- **MULI** takes 9 passes, since imm9 has only 9 trits. The 18 all-zero passes are replaced by wiring:
  low = (P_hi ≪ 9) + (P_lo ≫ 18), high = P_hi ≫ 18. That cuts it from 224 to 85 µcycles.
- **DIV / MOD** work on magnitudes:
  - the divisor is aligned left (`BTOPZ` = B's top trit is 0);
  - one quotient digit per position by subtracting 0–2 times, then Q = 3Q + digit;
  - the divisor shifts back right exactly;
  - signs are applied after: the quotient gets sa·sb, the remainder gets sa;
  - divide by zero takes the non-trapping path (SPR_TRAP_DIV0 = 0). The trapping path waits for traps.
- **TUNARY** uses `B_BCAST`, so every ALU slice sees B's low 3 trits (the truth table from imm9).
- **The builder now refuses any microinstruction that needs `CONST` for two jobs at once.** It caught three such
  clashes while writing this round. Hot temporaries T0/T1 got direct register selects so loops don't need CONST to
  address them.
- **Results:**
  - 3,000 programs, 1,546,359 steps, **0 mismatches**;
  - five new mutants caught: `MUL_NO_CARRY_TRIT`, `MUL_26_PASSES`, `MULI_TAIL_SHIFT_WRONG`, `DIV_ROUND_NOT_TRUNC`,
    `MOD_SIGN_OF_DIVISOR`, `TUNARY_NO_BCAST`.
- **µcycles:** MUL 201, MULI 85, DIV ~118, MOD ~126, and 6 for each tritwise op.
- **Microword: 71 bits, 9 flash chips** (was 64 / 8). The additions were:
  - QT latch load;
  - 3-way B negate (0 / 1 / by QT);
  - B broadcast;
  - 4-bit shifter field (R1C, R1L, L1L);
  - 3-bit flags (MULHI, OFDIV0);
  - 2-bit micro-loop counter.
- **Speed, weighted by the measured TritOS instruction mix** (`../tritos_instruction_mix.json`, BCOPY at its measured
  long-copy 9.0):
  - the microcoded ops cover 82.8% of TritOS's steps and average **9.40 µcycles → ≈1.06M steps/s at 10 MHz**;
  - this replaces the group-based ≈8.5 estimate;
  - still missing: BFILL (12.65% of steps, the biggest), SHLI/SHRI (2.8%), MTSPR/MFSPR, IN/OUT, SYSCALL/IRET,
    interrupts.

## v3 (2026-11-17 night): BFILL ("biffful", per Kham), `RESULTS-v3.txt`

- **Fast path (registers distinct, range not covering its own instruction): 4.01 µcycles per tryte** on a
  2,000-tryte fill. BCOPY is 9.0.
  - The fill value sits in MDR lane 0 for the whole fill.
  - The count is decremented *first*, so the continue/finish decision is latched one cycle before the write.
  - One cycle each: decrement, address, then write + `rd+1` + RETIRE.
  - The loop-back carries the next pass's count read, with its own JUMP, so it costs no extra cycle.
- **Slow path** follows the emulator order exactly, for aliased registers or a fill aimed at its own instruction.
  diff.js now generates both cases on purpose (8% of fills target their own instruction).
- **Results:**
  - 3,000 programs, 1,288,759 steps, **0 mismatches**;
  - mutants `BFILL_FAST_PC`, `BFILL_NO_ALIAS_GUARD` and `BFILL_NO_SELFMOD_GUARD` are all caught.
- **Microword unchanged:** 71 bits.
- **Speed, weighted by the TritOS mix** (long BCOPY 9.0, long BFILL 4.01):
  - microcoded ops now cover **95.5%** of TritOS's steps;
  - **8.65 µcycles per step → ≈1.16M steps/s at 10 MHz**.
  - Still missing: SHLI/SHRI (2.8%), MTSPR/MFSPR, IN/OUT, SYSCALL/IRET, and interrupts.

## v4 (2026-11-18, early morning): shifts (SHL, SHLI, SHR, SHRI), `RESULTS-v4.txt`

- **How:** one trit per pass through the shifter's *out wire*: two cycles per trit. Left uses `L1L` (top trit
  leaves); right uses a new `R1O` (bottom trit leaves, 0 fills the top). `R1L` was no good for this, since it feeds
  the old link trit back in at the top, and the mutant `SHR_FILLS_FROM_LINK` proves the differential notices.
- **The quirky flags fall out of the wire:**
  - two new flag modes, `SHOUTL` and `SHOUTR`;
  - both set SF from the shifted value and CF from the trit leaving this cycle, so CF ends as the *last* trit out;
  - `SHOUTL` sets OF only while OF is still 0, so it keeps the *first non-zero* trit out (= the sign of everything
    that fell off the top). `SHOUTR` holds OF at 0.
- **Counts:**
  - A negative count jumps to the other direction's entry, which negates B first.
  - The count is clamped to 28: from 28 on, everything has left, and the emulator's results stop changing. That also
    covers a register count with non-zero high trytes, which the emulator treats as 28·sign.
  - k = 0 writes rd with LOGIC flags, as the ISA says.
- **One datapath change:** the micro-loop counter now loads *from the bus* (`UCNT LOAD`), not from the CONST
  field. That's needed because the shift count arrives from a register. MUL and DIV were rewritten to load it via
  `BUS CONST` / `BUS ZERO`, and their mutants are still caught. The CONST builder check no longer counts UCNT.
- **Microword:** still 71 bits. `SHIFT` uses 11 of 16 codes; `FLAGS` uses 8 of 8 (full now).
- **Results:**
  - 3,000 programs, 1,368,472 steps, **0 mismatches**;
  - all five new mutants are caught: `SHL_OF_NOT_STICKY`, `SHR_FILLS_FROM_LINK`, `SHIFT_CLAMP_27`,
    `SHIFT_NEG_NO_SWAP`, `SHIFT_K0_KEEPS_FLAGS`;
  - re-checked after the counter change: `MUL_26_PASSES`, `DIV_ROUND_NOT_TRUNC`.
- **Cost:** 7 µcycles at k = 0, **14 at k = 1**, 12 + 2k in general, 68–69 at the clamp.
  - TritOS's shifts are all `SHLI`/`SHRI` (by 1 in 80 places, by 3 in 2).
  - `SHLI` falls straight into the shared body. `SHL` spends one extra cycle on a jump.
  - Worst case 69 µcycles, still under MUL's 201, so interrupt latency doesn't change.
- **Speed, weighted by the TritOS mix** (shifts at 14):
  - microcoded ops cover **98.3%** of TritOS's steps;
  - **8.80 µcycles per step → ≈1.14M steps/s at 10 MHz** (was 8.65 at 95.5%; shifts are slower than the average,
    so covering them nudges the mean up);
  - **63 of 69 opcodes**. Still missing: MTSPR/MFSPR, IN/OUT, SYSCALL/IRET, interrupts.
- **Optional later:**
  - a k = 1 fast path (14 → ~12, worth about 1% overall);
  - jumping 9 or 3 at a time while the trits leaving are all zero.

## v5 (2026-11-18, before dawn): privilege, protection, traps, SPRs, SYSCALL, IRET, `RESULTS-v5.txt`

**All 69 opcodes now dispatch.** IN and OUT do their privilege check for real and then stop as "not yet" in
supervisor mode, until the I/O card model exists. Unallocated opcodes trap to vector 1 instead of stopping the run.

**Faults are compared now, not shrugged at.** Until v4, a program that faulted on both sides was simply accepted.
From v5 on, every trap is checked field by field: EPC, ESP, ESR, ECAUSE, EADDR, the KSP switch, PRIV, IE, the vector
fetch, and the handler's IRET back.

- **The address unit** sits in front of memory and checks MAR before every access, fetch included:
  - user-mode protection against `[UBASE, ULIMIT)`;
  - then RAM / framebuffer bounds.
  - A failed check *aborts the cycle*, so nothing in it takes effect. The sequencer is forced to `TRAP_PROT` or
    `TRAP_BAD`, and the address goes into a FADDR latch.
  - The framebuffer (15,000,000 + 354,294 trytes) is modelled, and writes keep 6 trits, as the emulator.
- **Word writes never half-happen.** A new memory op, `CHK3`, checks all three trytes in the cycle that loads MDR.
  EADDR is the first tryte outside the allowed range, matching the emulator's whole-word pre-check. PUSH, CALL and
  CALLX were reordered so SP is written only after the check passes. None of this changed their cycle counts.
- **BFILL's fast loop was reordered** so the count is committed in the write cycle: a faulting write leaves rs2 exactly
  as the emulator does. The written-back destination comes from MAR (`MAR_INC`, new bus source `MAR`). Still
  **4.006 µcycles per tryte**; BCOPY is still 9.005.
- **Flags at instruction start.** A shadow latch takes SF/CF/OF at fetch and at every RETIRE. ESR packs those, plus
  PRIV and IE. That packing is pure wiring, because the five values are already trits. `PSW ENTER` puts the shadow
  flags back. So anything a faulting instruction did to the flags before its fault is undone, which is what the
  emulator shows (it never commits flags before a fault). BCOPY and BFILL needed this, because they test the count's
  sign before their first access.
- **FPC:** fetch writes the instruction's own address into a register slot in the same cycle it loads MAR. Faults
  save it as EPC; SYSCALL saves the next PC instead.
- **Trap entry:**
  - ~5 µcycles for the per-kind entry (ECAUSE, EADDR, B = 3·vector, A = saved PC);
  - then a shared `TRAP_COMMON`: EPC, ESP, ESR, and SP = KSP when coming from user mode with KSP ≠ 0;
  - then `TRAP_VEC`: ENTER, the vector address, and a halt if the vector lies outside RAM (as the emulator), else
    the 3-tryte vector read.
  - About 20 µcycles in all (SYSCALL measures 20.1, including fetch).
- **The SPR port:** `RF_SEL SPR` addresses the SPR named by imm9. That's a register-RAM slot (10 + index) for the
  word SPRs, or a latch for MODE / PRIV / IE / IMASK / IPEND / PROT_EN / TRAP_DIV0. IMASK and IPEND keep 5 bits, as the
  emulator's `val & 31`. Writing 0 to SPR 0 (switch to T2 mode) stops the run as "not yet".
- **IRET:** PC = EPC, SP = ESP, then flags, PRIV and IE are unpacked from ESR (`PSW RESTORE`, wiring again).
  8.1 µcycles.
- **MFSPR / MTSPR:** 6.1 µcycles.
- **Microword: 72 bits**, exactly 9 flash chips. `RF_SEL` grew to 4 bits (SPR, FPC). `COND`, `MEM` and `FLAGS` are
  now completely full; `BUS` has 2 codes spare.
- **Harness changes (diff.js):**
  - Every program gets a vector table at 9000 and two handlers after its HALT: faults skip the faulting instruction
    via EPC + 2; SYSCALL just IRETs.
  - 35% of programs start in user mode, with a protection window chosen from a few shapes. Some have a kernel stack;
    some trap on divide-by-zero.
  - Bodies include SYSCALL, MFSPR, MTSPR (a safe set of SPRs), IRET, loads/stores at the window's edges, wild
    BCOPY/BFILL pointers, and 30% of programs get one unallocated opcode.
  - Every SPR is compared after every step.
  - A per-step limit of 10,000 µcycles turns a microcode livelock into an error. One mutant livelocked silently
    before this guard existed.
- **Results:** 2,000 programs (726 starting in user mode), **4,016,438 steps, 0 mismatches**, with **281,524 traps
  compared**: protection 215,318, bad address 29,355, illegal opcode 15,141, syscall 12,820, privilege 5,678, divide
  by zero 3,212. 8 programs stopped at IN/OUT in supervisor mode.
  - New mutants, all caught: `TRAP_NO_KSP_SWITCH`, `TRAP_NO_ENTER` (livelock), `TRAP_ENTER_TOO_EARLY`,
    `PUSH_SP_BEFORE_CHECK`, `SW_NO_WORD_CHECK`, `SYSCALL_EPC_IS_FETCH_PC`, `MTSPR_NO_PRIV_CHECK`,
    `IRET_NO_SP_RESTORE`, `BFILL_COUNT_BEFORE_WRITE`.
  - Old mutants re-checked against v5 microcode: all BFILL and BCOPY guards, `ADC_NO_CARRY`, `DIV_ROUND_NOT_TRUNC`,
    `SHL_OF_NOT_STICKY`.
  - `SW_NO_WORD_CHECK` is the rare one: it needs a user window edge, a store at that edge and a word straddling it
    (caught at program 1,535 of 3,000).
- **Emulator finding (for the Triton repo, not a card issue):** TritonJS forms effective addresses as unbounded JS
  numbers. A base near ±(3^27−1)/2 plus an offset gives an EADDR (or a JALR target PC) outside the 27-trit range,
  which no 27-trit register can hold. Both sides fault identically; only that value differs, by exactly 3^27. diff.js
  counts these instead of failing on them: 3,023 comparisons in the v5 run. The ISA says EADDR is "the full 27-trit
  address", so the emulator should probably wrap. That's a call for us, and for whichever Triton version is next.
- **Known gap:** if a fetch faults on its *second* tryte *and* the vector then lies outside RAM (so the machine
  halts), PC is left one higher than the emulator's. The diff never puts vectors outside RAM; the gap is noted here.
- **Speed, TritOS mix:** SPR moves, IRET and SYSCALL are now covered (99.8% of steps): **8.78 µcycles per step,
  ≈1.14M steps/s at 10 MHz**. Only IN/OUT (0.25%) remain.

## v6 (2026-11-18, morning): interrupts, `RESULTS-v6.txt`

- **Taken at FETCH:** the first fetch cycle branches on `IRQ` (IE set and an enabled line pending), so checking costs
  no extra cycle.
- **Entry sequence (`IRQ_ENTRY`):**
  - a priority encoder puts 7 + the lowest pending enabled line on the bus (`IRQV`, new bus source);
  - ECAUSE = that vector, and B = 3·vector, because the shifter's L1 *is* ×3;
  - `IRQ_ACK` clears that pending bit;
  - EADDR = 0, and the saved PC is the instruction about to run.
- **Shared tail with traps:** `trapTail()` lays the common tail out twice. Traps end the step. Interrupts jump to
  `FETCH2` instead (a fetch without the IRQ check), so the handler's first instruction runs in the same step, exactly
  as the emulator does it.
- **The step timer** ticks at every instruction boundary and raises line 0 when it reaches its period. It's the
  emulator's mode-0 timer, which lives on the I/O card in hardware.
- **Block moves stop for interrupts:** a boundary inside BCOPY/BFILL's own loop (after RETIRE) is a real
  instruction boundary. With an interrupt pending, the sequencer goes back to FETCH there. PC already holds the block
  move's own address, so after IRET the move resumes with the exact remaining count.
  - Directed test (`irq-blockmove-test.js`): 400-tryte BFILL and BCOPY with a timer interrupt every 7 steps, giving
    80 interrupts mid-move each and 0 mismatches.
- **Interrupt cost:** 21 µcycles from detection to the handler's first fetch (1 + 5 + 8 + 7). Worst-case latency
  is an interrupt arriving just after a MUL starts: 201 + 21 = **222 µcycles ≈ 22.2 µs at 10 MHz**, measured from the
  microcode (the earlier estimate was ≈21.5).
- **Harness changes:**
  - random timer periods, IMASK and IE;
  - device lines (keyboard/mouse/disk/net) raised at random steps on both sides;
  - MTSPR may now write IE and IPEND;
  - interrupt vectors point at an IRET handler;
  - the timer count is compared every step.
- **Results:**
  - 2,000 programs, 3,877,147 steps, **0 mismatches**;
  - **30,099 interrupts taken**, alongside 261,449 traps;
  - new mutants all caught: `IRQ_NO_ACK`, `IRQ_ENDS_STEP`, `IRQ_VECTOR_NOT_TIMES_3`, `IRQ_NOT_AT_FETCH`;
  - re-checked: `TRAP_NO_KSP_SWITCH`, `BFILL_COUNT_BEFORE_WRITE`, `BCOPY_FAST_PC`.
- **Microword:** still 72 bits. `IRQ_ACK` was already in the field list from the start.
- **Left:**
  - IN/OUT with the I/O card model (the only opcodes still "not yet");
  - T2 mode (the first bring-up rung);
  - the RAM-size hardware profile;
  - booting TritOS.

## v7 (2026-11-18, morning): T2 mode (Triton 2.1), `RESULTS-v7.txt`

The first rung of the bring-up ladder runs Triton 2.1 software, so the card has to speak it.

- **Mode latch:** SPR 0, now a real latch; MTSPR #0 switches in either direction. It's one more address bit of the
  dispatch ROM, so T2 has its own dispatch table.
- **What T2 can run:** 47 of its opcodes reuse the T3 microcode unchanged.
  - That includes loads and stores: `(rs1 + imm)` and `(low tryte of rs1 + imm)` are the same address mod 3^9, so no
    separate routine is needed.
  - Anything T2 doesn't have halts, as the emulator's T2 default does. That covers the T3-only ops, MFSPR, SYSCALL,
    BCOPY, the X-forms and so on.
- **Addresses:** in T2 the address unit maps MAR mod 3^9 onto 0..19,682. That's the 5+4-trit conversion ROMs from the
  sketch, which give exactly a 32K chip. There's no protection, no bad-address check, no faults, no interrupts, and
  the timer doesn't count.
- **PC:** the counter's carry stops at 9 trits, so PC wraps +9,841 → −9,841. Physically that's contiguous, at 9,842.
- **SP:** a new microword field, `WIDTH9` (already in the draft field list), confines an ALU result to 9 trits, which
  makes SP wrap. PUSH and POP are T3's routines with WIDTH9 on the SP word.
- **New T2-only routines:**
  - CALL and RET move a single tryte, with SP ∓ 1;
  - HALT without the privilege check;
  - IN and OUT without the privilege check (still "not yet").
- **Mode bugfix:** the DIV0 trap condition is now gated on T3 mode, because the emulator never traps a divide in T2.
  diff.js would have caught this as soon as T2 programs ran with TRAP_DIV0 set.
- **Harness changes:**
  - 30% of programs now start in T2, with Triton 2.1 bodies, the odd T3-only op (which must halt) and MTSPR #0;
  - T3 programs can switch down to T2 mid-run;
  - the mode is compared every step.
- **Directed test (`t2-wrap-test.js`):** code runs straight across the PC wrap, including a CALL/RET pair and a load
  through a negative address. 0 mismatches.
- **Results:**
  - 2,000 programs, 2,969,136 steps, **137,269 of them in T2 mode, 0 mismatches**;
  - new mutants all caught: `T2_PUSH_NO_WRAP`, `T2_CALL_PUSHES_WORD`, `T2_RET_SP_PLUS_3`, `T2_MFSPR_ALLOWED`;
  - re-checked: `IRQ_NO_ACK`, `SW_NO_WORD_CHECK`.
- **Microword:** still 72 bits.
- **Left:**
  - IN/OUT with the I/O card model;
  - the RAM-size hardware profile;
  - booting TritOS. T2 also lets us try booting the original Triton 2.1 TritOS, a much smaller first target.

## v8 (2026-11-18, morning): IN/OUT and the I/O card, `RESULTS-v8.txt`

**Every opcode now runs in both modes. Nothing is "not yet" any more.**

- **The mailbox:**
  - `IO IN` / `IO OUT` hand the card the port (imm9) and, for OUT, the value on the bus.
  - The sequencer then sits in `WAIT` until the card raises IORDY.
  - IN takes the answer from the bus (`BUS IO`) with LOGIC flags.
  - Privileged in T3 (vector 2, EADDR = port). *Not* privileged in T2, because Triton 2.1 had no privilege. That's
    true even after T2 code sets PRIV.
- **`iocard.js`: the firmware spec.** A reference model of the card's microcontroller, as seen from the bus. All 28
  ports are ported line for line from TritonJS's `handlePortIn` / `handlePortOut`, with the same event-queue caps.
  - Console, display cursor and pixel/fill (it writes the video card's memory).
  - Step and tick counters, the timer period.
  - The disk stream (ports 7–8) and the disk DMA (ports 17–21).
  - Keyboard and mouse queues, StudioNet.
  - Provenance and changes are listed in its header. The real firmware has to meet this file.
  - **Its job in the sim:** the microsim checks the *CPU side* of the mailbox. It doesn't try to re-derive the devices.
- **Disk DMA and framebuffer fills** run as bus master while the CPU is held in WAIT, so they've finished when the
  instruction retires. That's the same point in the step where the emulator does them, and the disk IRQ is raised
  then too.
- **I/O response time:** assumed to be 10 µcycles (~1 µs). It's a parameter, so a real measurement can replace it.
  - Supervisor IN/OUT cost about 17 µcycles.
  - With IN/OUT covered, the TritOS mix is 100% microcoded: **≈8.80 µcycles per step, ≈1.14M steps/s at 10 MHz.**
- **Harness changes:**
  - IN/OUT to any port (including invalid ones), from T3, T2 and user mode;
  - whole disk-DMA transfers set up through ports 17–20, mostly valid, some with each kind of error;
  - random disk content on both sides;
  - typed characters, key events and mouse events pushed through the card's queues;
  - device state, console text, the timer period and counters compared after every step;
  - the **whole VRAM and the whole 3^13-tryte disk** compared at the end of every program.
- **Results:**
  - 2,000 programs, 2,781,273 steps, **0 mismatches**;
  - 28,437 IN/OUT steps and 4,519 completed disk DMA transfers, plus 184,962 traps and 29,754 interrupts;
  - mutants `IN_NO_FLAGS`, `OUT_SENDS_RS1` and `IN_NO_PRIV_CHECK` are caught by the random programs;
  - **`T2_OUT_PRIV_CHECKED` was NOT caught by 3,000 random programs.** T2 plus user mode plus I/O almost never happens
    in the generator. A directed test, `t2-user-io-test.js`, catches it at step 4, and it now ships in the folder.
    Lesson filed: rare *combinations* need directed tests, not just more random runs.
- **Microword:** still 72 bits. `IO` and `WAIT` were in the field list from the first draft.
- **Left:**
  - the RAM-size hardware profile;
  - booting TritOS on the microcode (Triton 2.1's in T2 first, then the desktop);
  - the written critical-path timing budget (Vael's question).

## Hardware profile: RAM = 3^15 = 14,348,907 trytes (decided 2026-11-18, Kham: "as big as is reasonable")

- **Why 3^15:** it's the ISA's own maximum ("configurable up to 3^15"), and TritonJS already supports it
  (`new TritonJS({ ramSize: 14348907 })`). So the card and its answer key match exactly, with no emulator change and no
  odd 2^22 size.
  - It also clears delivery 3's §2.1: fsck of a 3^13-sector unit needs RAM up to 3^14, which now fits with 3× headroom.
- **Parts:** 16 × ISSI IS61WV204816BLL-10TLI (2M × 16, 10 ns, 3.3 V; about $21–26 each at quantity 1–10, distributor
  listings 2026-11-18). Arranged 2 wide (32 bits, 18 used per tryte) × 8 deep = 16M trytes. The dense address
  conversion maps 0..14,348,906 onto them.
  - **Staged option:** wire all 8 rows and populate 3 to start (6,291,456 trytes, already above everything TritOS
    uses, with `ramSize` set to match). Fill the rest later.
  - The 10 ns parts also help the timing budget and the video interleave.
- **Checked:** `RAMSIZE=14348907 node diff.js triton3.html 400` gives 0 mismatches (`RESULTS-v8-ram3p15.txt`). diff.js
  takes `RAMSIZE` for any profile.

## Booting real software on the microcode (2026-11-18)

Each run is in lockstep with the emulator. Every instruction compares PC, SP, flags, R0–R8 and all SPRs; at checkpoints
the run also compares all RAM, the whole framebuffer, the disks and the device state.

| Run | Machine (answer key) | Steps | Result | Card time at 10 MHz |
| --- | --- | --- | --- | --- |
| `boot-tritos21.js`: TritOS 2.1 scripted shell session (the Triton repo's own test script) | triton3.html, T2 mode | 7,213 | 0 mismatches | 0.007 s |
| `boot-tritos21.js`: **TritOS 2.1 assembles its own source** (`asm`) | triton3.html, T2 mode | 1,788,709 | 0 mismatches; output **byte-identical** to the running OS (3,057 trytes) | 1.385 s |
| `boot-desktop.js`: **TritOS Desktop 1.1.2**, boot, then the 2,000-event input pattern from `desktop-02` | tritos-desktop.html (Triton 3.1.1) | 380,000 | 0 mismatches | 0.284 s |
| `boot-desktop2.js`: **TritOS Desktop 2.0 on Triton 4** (Argon delivery 3), same input | tritos-desktop-2.html (Triton 4) | 380,000 | 0 mismatches, real-time timer mode, every storage unit compared sector by sector | 0.219 s to boot |

- **Screenshots** of the card's own framebuffer: `desktop112-on-microcode.png`, `desktop2-triton4-on-microcode.png`.
- **Speed on real desktop workloads:** 7.46 µcycles per instruction, better than the 8.80 mix estimate.
- **The Triton 4 I/O card (`iocard4.js`):** it runs the emulator's own Triton 4 device code. That covers the 27
  units, ports 28–32, the real-time timer and the RTC. The code is rewired onto the card's RAM, framebuffer, mode latch
  and IRQ lines, so DMA lands in the card's memory and device interrupts go through the card's priority encoder (6 lines
  on Triton 4: IMASK/IPEND keep 6 bits).
  - That device code is the firmware's spec. The microsim proves the CPU side and the interrupt and timer plumbing.
  - Both machines get the same host clock: 5 µs before every instruction, the page's own pacing.
- **Caveat:** the desktops were driven with the determinism test's input pattern; they weren't used interactively.
  The Desktop 2.0 boot leaves the RTC at the boot default the page sets (820,454,400 s, 1996-01-01). That's AUDIT-2's
  wall-clock note, unchanged.

## ROM images (2026-11-18): `../roms/`, exported by `roms.js`, verified by `verify-roms.js`

- **What's exported:**
  - the **control store**: 9 byte-wide chips × 1,024 words, 535 used, 72-bit microword;
  - the **dispatch table**: T2/T3 × 243 opcodes → microaddress;
  - **one ALU slice table**: 512K × 8, the same image in all 9 slice chips. B negation is folded into the table
    address, so no rail-swap mux sits in the ripple path (TIMING-BUDGET.md).
  - Layouts are documented in roms.js, and the sha256 of every image is in `../roms/MANIFEST.md`.
- **Verification:** `romMachine()` builds a card from the image *bytes alone*. It decodes the microwords from the
  chips, dispatch from its table, and the ALU from the slice table rippling 9 times; it never looks at MICRO, the labels
  or the LUT. Then:
  1. The ALU table is checked exhaustively against independent arithmetic definitions: 48,114 slice-input ×
     function cases, 0 wrong.
  2. diff.js with `ROMS=1`: 300 programs, 396,517 steps, 0 mismatches.
  3. boot-tritos21.js with `ROMS=1`: TritOS 2.1's session and self-hosting fixed point, 0 mismatches, byte-identical.
  
  So these images are a complete description of the card's control and ALU. Burning them is what card #1's flash
  needs, plus the power-up copy into SRAM.
- **Fixed addresses:** the sequencer, fault and interrupt hardware jump to a few fixed microaddresses: FETCH,
  FETCH2, TRAP_PROT, TRAP_BAD, TRAP_ILL, T2_HALT and IRQ_ENTRY. They're wired constants, like a reset vector, and
  they're listed in roms.js.

## Bare-ports I/O card (2026-11-18)
Kham's rule: no bits faked by software on a chip, so the I/O card has no microcontroller (`bareio.js`). SPI to an SD
card (ports 40-41) and two PS/2 ports (42-45) are shift registers and latches; the ternary CPU runs every driver
(`bare-drivers.js`, Triton 3 assembly). `bare-io-test.js`: SD model unit tests with a separate JS driver, then the
ternary drivers in lockstep on the microsim and the Triton 3.1.1 emulator (separate device instances): SD init, read
sector, write sector, read back, 40 scancodes by interrupt (inhibit exercised), negative control (bad CMD0 CRC).
Result: **ALL PASS, 0 mismatches.**

**Port bridge made explicit:** the I/O bus carries trits; binary devices sit behind two SRAM lookup tables (T→B 256K×16,
B→T 64K×22 bits), loaded by the copy engine. With 16-bit SPI ports (46-47) the CPU moves a whole tryte per OUT/IN:
read **6.3 ms** per 729-tryte sector (~115K trytes/s), write **5.5 ms**. The byte-at-a-time drivers (CPU does DIV/MOD)
still pass too: 20 ms read, 49 ms write. Assumes SPI at 25 MHz (16 bits ≈ 0.64 µs, inside the 1 µs I/O wait). See
RESULTS-bare-io.txt.
