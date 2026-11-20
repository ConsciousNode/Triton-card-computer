# Triton card computer: datapath and control-signal list (draft 1, 2026-11-17)

Kehai Interim with Kham. Source of truth for the instruction set: `triton/ISA-3.md` (69 opcodes) plus
`TRITON-4-STORAGE-TIME.md`. **The emulator is the answer key.** Nothing here counts as working until
a microcode simulator runs TritOS step-identical to it (see "Next").

## Style: one bus, microcoded

Our speed target is 400k–1M instructions/s. The ALU settles in 7–15 ns, and the RAM and LUT SRAM are 10 ns parts.
- A **100 ns microcycle (10 MHz)** gives every step huge margin.
- An average of ~8–10 microcycles per instruction still lands at about 1M instructions/s. That's an
  estimate, to be measured by the microcode simulator.

So the design picks the simplest structure that works, not the fastest: **one internal bus, a
single-port register RAM, and a microcode ROM.**

All datapath words are 27 trits, dual-rail = 54 wires. Memory is one tryte (18 wires) per access.

```
            +---------+   +-----+
  bus  <--- | reg RAM | , | IR0 | IR1 (instruction trytes) --> field decode (rd, rs1, rs2, imm9, op)
   |        +---------+   +-----+
   +--> A latch --+
   +--> B latch --+-- (B_NEG: swap rails) --> LUT ALU (9 x 3-trit slices) --> shifter --> bus
   +--> MAR ------> address convert --> RAM / framebuffer / bad-address detect
   +--> MDR (3 tryte lanes) <--> RAM data
   +--> PC (with +1)
   +--> I/O mailbox (port, value; ready line)
```

**Register RAM slots (32):**
- R0–R8;
- SP;
- SPR 0–15 (VBR, UBASE, ULIMIT, KSP, EPC, ESP, ESR, ECAUSE, EADDR, IMASK, IPEND, …);
- temporaries T0–T5.

PC is a real register with its own +1, because it's used every instruction.

## The microword

| Field | Bits | Meaning |
|---|---|---|
| `SEQ` | 3 | next / jump / dispatch on opcode / branch if `COND` / branch if not `COND` / fetch (with interrupt check) / wait while `COND` |
| `COND` | 4 | SF=−1, SF=0, SF=+1, CF≠0, count=0, multiplier trit (−/0/+), I/O ready, IRQ pending and IE, user mode, T2 mode, divisor=0, bad address, outside UBASE/ULIMIT |
| `CONST` | 14 | next µ-address **or** a constant (register slot, vector number, small literal); shared because a microinstruction rarely needs both |
| `RF_SEL` | 3 | register slot from: rd, rs1, rs2, `CONST`, imm9 (for MFSPR/MTSPR), SP |
| `RF_RD`, `RF_WR` | 2 | read the register RAM onto the bus / write the bus into it |
| `BUS_SRC` | 4 | register RAM, ALU, MDR, PC, imm9 sign-extended, imm9 into the middle or high tryte (LUI, LMI, LHI), PC + rel9, `CONST`, I/O value, zero |
| `LD` | 7 | load A, B, MAR, MDR, PC (one bit each); IR lane 0/1 from memory (2 bits) |
| `MAR_INC` | 1 | MAR + 1 (multi-tryte words without an ALU trip) |
| `MDR_LANE` | 2 | which tryte of the 27-trit word the memory access fills or sends |
| `PC_INC` | 1 | PC + 1 |
| `ALU_FN` | 5 | add, pass A, pass B, MIN, MAX, consensus, any, XOR, unary (function from imm9), sign, … (32 slots, so 5 op-select address bits on each LUT chip) |
| `ALU_FN_SRC` | 1 | `ALU_FN` from the microword, or from imm9 (TUNARY) |
| `B_NEG` | 1 | swap B's rails: negate for free. SUB, SBC, CMP and NEG all reuse the adder |
| `CIN` | 2 | carry in: 0, CF, +1 |
| `SHIFT` | 3 | none, left 1/3/9, right 1/3/9 (plain rewiring, no logic; any count ≤ 26 is at most 6 steps) |
| `WIDTH9` | 1 | T2 mode: cut the carry chain after tryte 0 and sign-extend |
| `FLAGS` | 2 | keep, from ALU (sign, carry), compare, restore from ESR |
| `PSW` | 2 | keep, enter supervisor + IE off, restore from ESR |
| `MEM` | 2 | idle, read, write |
| `IO` | 2 | idle, IN, OUT |
| `IRQ_ACK` | 1 | clear the IPEND bit being serviced |
| **Total** | **63** | |

- **Width:** 63 bits = **8 flash chips** (61 in draft 1; the microsim added the IR and MAR_INC bits) (8 bits wide, 16K microwords, 14 address bits).
- **This corrects the earlier estimate** of 40–48 lines and 6 chips. Sharing next-address with the constant
  field is what keeps it to 8 instead of 10.
- **Dispatch ROM:** opcode (5 trits) + T2 mode + user mode → starting µ-address.
- The microcode and ALU tables live in binary flash, holding ternary tables. This is the same arrangement
  as the LUT ALU.

## Walking a few instructions through it (checks the field set)

- **Fetch:**
  1. `PC→MAR`; mem read lane 0 → IR0; PC+1.
  2. The same into IR1.
  3. dispatch.
  
  (3 µcycles; an interrupt check rides on `SEQ=fetch`.)
- **ADD rd, rs1, rs2:** `rs1→A`; `rs2→B`; `ALU add → rd`, flags. (3 µcycles + fetch = 6)
- **SUB:** the same with `B_NEG`. **CMP:** the same, writing flags only.
- **LW rd, rs1, imm9:**
  1. `rs1→A`; `imm9→B`; `ALU add → MAR`.
  2. Bad-address and user-range checks (`COND`).
  3. Three reads into MDR lanes 0–2; `MDR→rd`, flags.
  
  (~7 + fetch)
- **MUL:** 27 steps, one per trit of the multiplier.
  - Each step: test the multiplier's low trit (`COND`), then add +A, add −A (`B_NEG`), or skip.
  - Then shift. Balanced ternary needs no sign correction.
  - About 60 µcycles. MUL is ~1.7% of the TritOS mix with DIV/MOD.
- **BCOPY dst, src, count:** a loop per tryte:
  - read src → MDR, write MDR → dst;
  - then the three register updates through the ALU;
  - check `count=0` and pending IRQs every pass (the instruction is interruptible by spec).
  
  About 7 µcycles per tryte.
- **Trap or interrupt entry:**
  - save PC→EPC and SP→ESP;
  - build ESR from flags/PRIV/IE through the ALU;
  - load ECAUSE/EADDR;
  - swap to KSP if coming from user mode;
  - `PSW` enter supervisor;
  - read the 3-tryte vector at VBR + 3·vec into PC.
  
  About 15 µcycles.

## Decisions this draft leaves open

1. **Block moves are 39% of the instructions TritOS executes** (mostly window redraws).
   - At ~7 µcycles per tryte, a full-screen copy (354,294 trytes) takes ~0.25 s.
   - The microcode version works. The upgrade is dedicated address and count counters, so each tryte costs
     ~2 µcycles. The microcode simulator should measure how much it matters before we add chips.
2. **The user-range (UBASE/ULIMIT) check:**
   - in microcode it costs ~2 µcycles per user memory access;
   - a hardware comparator costs ~18 LUT-style chips;
   - start in microcode and decide by measurement.
3. **DIV/MOD:** an iterative balanced-ternary division loop, about 27 × 4 µcycles. It must match the
   emulator's rounding exactly, so the simulator's differential test is the judge.

## Update: the microsim exists (`microsim/`)

Draft 1 is now running as `microsim/`: 50 opcodes, 2.47M instruction steps against the emulator with 0 mismatches, and four planted bugs caught. See `microsim/README.md`.

## Next (original plan)

A **microcode assembler + simulator in JS**. It would:
- run this exact datapath, signal by signal, with the microcode written as source;
- execute TritOS images;
- compare architected state against `triton4.html` after every instruction;
- count µcycles per instruction.

That proves the signal list is complete and gives the real speed before a single board is drawn.
