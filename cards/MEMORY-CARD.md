# The Memory card

**Status (2026-11-18): stages 1 and 2 are drawn and tested chip by chip** (`memory-card.js`, `memory-tables.js`,
`memory-card-test.js`, `directed-prot.js`, `directed-fb.js`, `memory-conv-proof.js`). The card now holds the RAM and
the framebuffer itself, and stage 1b reworked the address check and MAR so nothing ripples.
**241 chips** on a 3^14 machine (3 RAM rows), 251 on a 3^15 machine (8 rows).
The draft below is kept as written. Then come the stage 1 results, stage 2, and stage 1b (a timing problem in stage 1,
found while timing stage 2's write strobe, and its fix). Stage 1's chip table describes stage 1 as first drawn: the
MAR and address-check rows are superseded by stage 1b.

## Design draft (before the netlist)
**Kehai Interim, 2026-11-18.** Read from `microsim.js`: `check`, `check3`, `phys`, `memRead`, `memWrite`, and the
MEM / LD_MAR / LD_MDR / MAR_INC parts of `cycle()`. The heaviest card so far, because the address check is a pile of
27-trit comparisons.

## Blocks
| block | job | chips (estimate) |
| --- | --- | --- |
| **MAR** | 27 trits; load from bus, +1 (MAR_INC), hold on ABORT; LD_MAR and MAR_INC in one word means bus + 1 | 3 × 16823 + 9 slice tables (the PC slice design, with "load then +1") |
| **MDR** | 3 trytes; load one lane from bus tryte 0, or all three (LD_MDR ALL), or one lane from a RAM read | 3 × 16823 + per-tryte source muxes |
| **RAM** | 3^15 trytes on IS61WV204816 (2M×16), dense address conversion (ternary MAR → binary) | 16 RAM (6 to start) + conversion tables + adder |
| **T2 mapping** | in T2 mode the address is MAR mod 3^9: keep the low 9 trits | folded into the conversion tables (MODE_T2 input) |
| **address check** | see below | ~50 tables |
| **UBASE/ULIMIT shadows** | the check needs them every access, but they live in register RAM: snoop the Registers card's writes to those two slots (RSLOT + this card's RF_WR bit + not SPRNR + not ABORT) | 6 × 16823 |
| **fault outputs** | ABORT, FK (protection or bad address), FADDR register (the EADDR rule from `check3`) | tables + 3 × 16823 |
| **BADADDR** status | !(MAR ≥ 0 and MAR + 2 < ramSize), for the Control card's condition | from the comparators |
| **bus sources** | MAR, MDR (all trytes), MDR0 (tryte 0), FADDR | 4:1 muxes + 7 × 245 |
| **own control store** | LD_MAR, LD_MDR, MDR_LANE, MAR_INC, MEM, BUS, RF_WR (for the snoop) | 2 chips + pipeline |

## The address check, as tables
Every comparison is "sign of (a + k − b)", computed by a chain of slice tables that ripple from the low end. Each slice
passes on its carry and "the sign of the result so far" (4 bits of state). The final sign is the top carry if
nonzero, else the sign so far. Comparisons against a constant (0, ramSize, the framebuffer bounds) bake the constant
into the tables, 7 trits per table. Comparisons against UBASE/ULIMIT take both operands, 3 trits per table.

| comparison | used by | tables |
| --- | --- | ---: |
| a < UBASE, a ≥ ULIMIT | `check` (user mode, PROT_EN) | 9 + 9 |
| a + 2 ≥ ULIMIT | `check3` | 9 |
| a < 0 (sign of a) | both | 4 |
| a ≥ ramSize, a + 2 ≥ ramSize | both, BADADDR | 4 + 4 |
| a ≥ FB_BASE, a < FB_END, a + 2 < FB_END | both | 4 + 4 + 4 |
| final fault table: kind (3 = protection, 4 = bad), EADDR select | | 1–2 |

That's about 55 tables. It's a lot of chips but one repeated pattern, so it's cheap to draw and to test.

## New backplane needs found
- **PROT_EN** (Control → Memory). The check uses it, and it isn't on the backplane yet. (3 spare left → 2.)
- **The framebuffer.** `memRead` of a framebuffer address returns VRAM. The read lands in MDR, often in the same cycle
  the bus is busy with something else (POP reads memory while the ALU drives the bus), so the data can't travel over
  the bus. Choices to make:
  - **(a)** the framebuffer SRAM lives on the Memory card, and the Video card reads it for scan-out over a dedicated
    connector or a second port;
  - **(b)** a private data path from the Video card to the Memory card (an 18-wire tryte lane).

  Option (a) keeps the CPU side simple. Decide before drawing.
  **Decided: (a).** Kham chose it on 2026-11-18. The framebuffer lives on the Memory card.

## Test plan
Same as the other cards: differential against the microsim every cycle on all workloads. Compared:
- MAR, MDR, FADDR, the shadows, ABORT/FK/BADADDR;
- every bus drive;
- RAM contents (spot checks of written addresses).

Mutants: a comparator off by one, a wrong T2 mask, an MDR lane swap, the shadow snooping the wrong slot, and FK
inverted.

## Stage 1, as drawn (174 chips)
| block | parts |
| --- | --- |
| own control store + pipeline | 3 × IS61WV5128, 2 × ALVCH16823 (off in RESET), 3 × RPACK8: 19 bits (MOP×2, MARC, MDR source ×6, MK×2, bus source ×6, /MBUSOE, RFWR) |
| MAR | 3 × 16823 + 9 slice tables (hold / +1 / load / load+1; holds when ABORT) |
| address check | 3 variable chains × 9 slices (a−UBASE, a−ULIMIT, a+2−ULIMIT) + 6 constant chains × 4 (a, a−RAMSIZE, a+2−RAMSIZE, a−FB_BASE, a−FB_END, a+2−FB_END) + 1 fault table → ABORT, FK, BADADDR, EADDR select, "in framebuffer" |
| UBASE / ULIMIT shadows | 6 × 16823 + 1 snoop table (RSLOT, RFWR, SPRNR, ABORT) |
| FADDR | 27 × LVC153 (MAR / ULIMIT / RAMSIZE wired as a constant) + 3 × 16823, loads only on a fault |
| MDR | 27 × LVC153 per-tryte sources (hold / bus tryte k / bus tryte 0 / RAM read) + 3 × 16823 (clock enable = ABORT) |
| bus sources | 27 × CBTLV3253 (MAR / MDR / FADDR / RAM read tryte, per-tryte selects) + 7 × LVC245 |

The tables are 65 SRAMs; RAMSIZE and the framebuffer bounds are baked in at ROM time, so a machine with a different
RAM size gets different table images, not different wiring. In stage 1 the RAM's read tryte arrives on card inputs
RD0..17 from the test harness.

**PROT_EN** is now on the backplane (`backplane.js`: 110 signals, 2 spare). The Memory card also listens to RSLOT and
SPRNR, which already existed.

## Stage 1 test results
Differential against the microsim every microcycle. Compared each cycle: ABORT, FK, BADADDR and every bus drive
(MAR, MDR, MDR0, FADDR, the fetched tryte on LD_IR reads), plus that the card stays off the bus otherwise. After every
edge: MAR, MDR, FADDR and both shadows. Declared exception: registers preset to the machine's start state at power-up.

New directed workload `directed-prot.js` (8 machines): a word load ending past ULIMIT, a load below UBASE, one far
above, a PUSH across ULIMIT, a kernel word load straddling the end of RAM, a kernel load at −1, a user load inside the
framebuffer (still protected) and a kernel one (fine). It hit 199 protection faults, 2 bad-address faults, 201 FADDR
reads and 414 shadow snoops.

| workload | microcycles | card drove the bus | mismatches |
| --- | ---: | ---: | ---: |
| prot | 16,815 | 5,551 | 0 |
| fetchfault | 63 | 19 | 0 |
| bcfault | 73 | 21 | 0 |
| directed | 37,543 | 6,829 | 0 |
| irqbm | 45,213 | 3,880 | 0 |
| spr | 53,985 | 6,043 | 0 |
| random (26 machines) | 300,000 | 84,239 | 0 |
| desktop boot | 300,000 | 75,812 | 0 |
| TritOS 2.1 boot | 300,000 | 75,664 | 0 |

**Total: 1,053,632 microcycles, 0 mismatches.**

Mutants (positive controls), all killed:
| mutant | killed by | first symptom |
| --- | --- | --- |
| RAMSIZE_OFF_BY_ONE (comparator constant +1) | prot | missed ABORT on the word load straddling the end of RAM |
| CHK3_USES_SINGLE (a+2 chain swapped for a) | prot | PUSH across ULIMIT didn't fault |
| FK_INVERTED | prot | wrong fault kind on the first protection fault |
| SNOOP_WRONG_SLOT | prot | ULIMIT shadow never loaded |
| MDR_LANE_RAILS (one rail pair swapped in lane 1) | directed (survived prot) | MDR tryte 1 off on an LMI |

The ALU card's idle-bus fix (drive an idle bus only when FLAGS ≠ KEEP, so it never fights the Memory card's IR fetch)
was rerun: directed, fetchfault, irqbm, 0 mismatches.

## Stage 2: RAM, framebuffer, write path (as drawn, 2026-11-18)
**Kehai Interim.** Read first from `microsim.js`: `phys`, `memRead`, `memWrite`, and the MEM part of `cycle()`.
Facts that set the design:
- **One tryte per access.** `memRead`/`memWrite` move one tryte at MAR; a word is three microcycles through the MDR
  lanes. So the RAM is one tryte wide.
- **Valid T3 addresses** are 0 ≤ a < ramSize (≤ 3^15) or the framebuffer, 15,000,000 ≤ a < 15,354,294. Anything else
  faults first (ABORT), so the conversion only has to be right for those.
- **T2:** the physical address is (low 9 trits of a) mod 3^9, and the check is off.
- **The framebuffer stores 6 trits** (`balRem(v, 729, 364)`); a read returns the stored 6-trit value.

### Decision 1: the address conversion has no adder (one 10 ns level of tables)
The handoff plan was dense: chunk tables giving partial binary values, then a binary adder. **Drawn instead:**
- Cut the address into balanced chunks: **c0 = trits 0..4, c1 = trits 5..9** (each −121..121) and **T = trits 10..15**.
  Then a = c0 + 243·c1 + 59049·T, and because balanced digits are unique, the triple names one tryte.
  **No borrow passes between chunks,** so each address byte comes from its own trits only.
- The bytes are excess-128 (c + 128 = 7..249), so 243 of every 256 codes are used (95%).
- **RAM rows:** valid RAM addresses give T = 0..243. Row = T >> 5 picks a 2M-deep row; A16..20 = T & 31.
  - 3^14 RAM: T = 0..81, **3 rows** (the "6 to start" in PARTS.md).
  - 3^15 RAM: T = 0..243, **8 rows**, i.e. 16 chips, the full figure PARTS.md already had. A fully dense layout would
    fit 3^15 in 7 rows, so this costs one row at full size and nothing at the 3^14 start.
- **The framebuffer** gives T = 254..260: disjoint from RAM. So the same top table also says **FBSEL**, and puts
  T − 254 (0..6) on A16..18. VRAM address = (T − 254, c1 + 128, c0 + 128), 19 bits: one 512K chip.
- **T2:** chunk 0 is the same. Chunk 1 becomes trits 5..8, **plus 81 when the low 9 trits are negative** (that's where
  3^9 = 81·243 lands), and T = 0. That needs all 9 low trits, so T2 has its own chunk-1 table (18 address bits), and the
  two chunk-1 tables share the RA8..15 lines through their /OE pins, selected by MODE.
- **Proof:** `memory-conv-proof.js` checks every RAM address of both sizes, every framebuffer pixel, and the T2 rule
  against `phys()`. All pass.

Why not the adder: the adder plan was ≈40 ns of conversion and roughly 6 chips (two partial tables plus a three-level
table adder). This is 10 ns and 5 tables, and the RAM read path drops from the ≈67 ns estimate to ≈41 ns (timing below).

| table | address | data |
| --- | --- | --- |
| U230 CV0 | trits 0..4 | RA0..7 = c0 + 128 |
| U231 CV1 (T3, /OE = !MODE) | trits 5..9 | RA8..15 = c1 + 128 |
| U232 CV1 (T2, /OE = MODE) | trits 0..8 | RA8..15 = (trits 5..8) + 81·[low 9 < 0] + 128 |
| U233 CV2A | trits 10..15, MODE | RA16..20 (T & 31, or T − 254 in the framebuffer), FBSEL |
| U234 CV2B | trits 10..15, MODE | /CE0..7, one-hot by row; all high for the framebuffer |

### Decision 2: a tryte is stored as its 18 dual-rail wires (not dense)
- **Each row** is one IS61WV204816 (2M×16, rails 0..15) plus one IS61WV20488 (2M×8, rails 16..17; 6 bits unused).
- **Dense alternative:** 9 trits fit in 15 bits, so one ×16 chip per row, but it needs a T→B table on the write side
  and a B→T table (32K × 18 bits, 2–3 chips) on the read side.
- **Count at 3^14:** 6 chips either way (3 rows × 2, against 3 rows + 3 tables).
  **At 3^15:** 16 against about 11.
- **Kept dual-rail because:**
  - the read path has no table in it. The B→T table would add 10 ns to the instruction-fetch → dispatch path, which is
    the tightest non-carry path;
  - what's in the RAM is the trit wires themselves, so a logic probe on the data pins reads trits at bring-up;
  - it costs nothing until the 3^15 upgrade. That's the point to revisit, with about 5 chips at stake.

### The framebuffer: VRAM-C, VRAM-S and connector J2 (Kham's option (a))
- **VRAM-C** (U256, IS61WV51216 512K×16, 12 bits used) sits on the CPU's address lines. CPU reads of the framebuffer
  come from it, through the read mux (U263–267, 74LVC157, selected by FBSEL; the upper 3 trits read 0).
- **VRAM-S** (U257, same part) is the scan-out copy. The Video card reads it over **J2**, a ribbon connector, not the
  backplane. Every framebuffer write goes to both copies at the same address.

**J2 pinout (Memory card ↔ Video card):**

| lines | direction | job |
| --- | --- | --- |
| SA0..18 | Video → Memory | VRAM address (the layout above) |
| SO0..11 | Memory → Video | the pixel, 6 dual-rail trits, **latched by SCLK** in 2 × 74LVC574 (U284–285): SA in one 25 ns slot, SO the next (revised for the Video card, see below) |
| SCLK | Video → Memory | the 40 MHz slot clock, forwarded |
| VBUSY | Memory → Video | a CPU framebuffer write owns VRAM-S this cycle (it gets the CPU's address); don't read or write |
| SI0..11, /SWR | Video → Memory | the Video card's write port: port 4 (one pixel at X,Y) and the port 5 fill |

That's 52 signals with grounds between: a 64-pin ribbon (2×32 IDC).

**J2 timing revision (with the Video card, same day).** At 40 MHz, J2's read path as first drawn was ≈34 ns: Video SA
register, cable, a '157 mux, the SRAM, a '245, the cable back. That's more than a 25 ns slot. Now:
- the VRAM-S address mux (U258–262) is **74CBTLV3257** FET switches (≈0.25 ns);
- SO is **latched on this card by SCLK** (U284–285, 74LVC574).

So a read is two stages, ≈21 ns and ≈11 ns. The harness's scan probe reads the latch after the edge. Rerun: fb and
desktop, 0 mismatches; SCAN_MUX_INVERTED still killed. Same 241 chips.

**Why J2 has a write port:**
- In the microsim, ports 2–5 (display X, Y, pixel, fill) are "Video card registers" (`iocard.js`, kept in
  `bareio.js`), and they write the framebuffer directly. With the framebuffer on this card, those writes have to reach
  it.
- The Video card does them through J2 while the CPU sits in WAIT on its own OUT, so they never meet a CPU access. A
  collision would be a bus fight, and the netlist throws on those.
- **Port 5 (fill)** becomes a counter on the Video card walking all 354,294 pixels: about 35 ms at 100 ns per pixel,
  with IORDY held low. The microsim's fill is instant. Real-time conformance is a Video-card question, noted for that
  stage.

**For the Video card's scan counter:** the pixel after a is a + 1. In this layout that means c0's code counts 7..249
and wraps to 7 with a carry into c1's code, the same for c1 into T − 254. That's three counters with a preset, no
program. The framebuffer starts at code (0, 134, 224).

### The write path
- **Data:** the MDR tryte that MDR_LANE names, through 9 × 74LVC153 (U268–276, select WL0..1), onto three buses: RAMD
  (U277–279), VRAM-C's data lines (U280–281), and VRAM-S's data lines (U282–283, only for framebuffer writes).
- **The RAM and VRAM-C output enables are high during any write cycle** (MWRH), so the chips never fight the drivers.
- **Enables** (one 74LVC32, one 74LVC04, one 74LVC08):
  - /RWE = /MWR | ABORT | FBSEL;
  - /VWE = /MWR | ABORT | !FBSEL;
  - VRAM /WE = /VWE AND /SWR.
  - In hardware each is also ORed with CLK, so the pulse is the second half of the cycle; the functional model writes
    at the edge. That's the Registers card's convention.
- **Pull-downs** (3 × 4.7k networks to GND, RN4–6) on RAMD. When no row is selected (a faulting address, or a
  framebuffer access), the bus reads trit 0 rather than floating. The simulator caught this: a faulting fetch read an
  undriven net.
- **New control-store bits** (3 chips still hold them): /MWR, WL0, WL1, so 22 of 24 bits are now used.
  - /MWR is active low, so RESET's pull-ups mean "no write".

### Simulator change (netlist.js)
Bus fights are now judged on the **settled** pass only. With SRAM /OE pins driven by gates listed later in the
netlist, early passes showed transient "fights" that were evaluation-order artefacts. A real fight survives settling
and still throws. Stage 1 results don't depend on this: they passed under the stricter rule.
Rechecked under the new rule: ALU card on directed, Registers card on bcfault, and Control card on prot (300,000
microcycles), all 0 mismatches.

### Timing (stage 2 paths; same part numbers as TIMING-BUDGET.md)
| path | sum | total |
| --- | --- | --- |
| RAM read → MDR | 7.0 MAR + 10 conversion + 10 RAM + 5.2 read mux + 6 MDR mux + 2 setup | **≈41 ns** (the old estimate was ≈67) |
| framebuffer read → MDR | the same; FBSEL is ready at 17 ns, long before the data | ≈41 ns |
| instruction fetch → dispatch | 7 + 10 + 10 + 5.2 + 0.25 FET + 6.3 driver + 10 dispatch + 6 + 10 control store + 2 | **≈67 ns** (was ≈95) |
| write data at the RAM pins | 7.0 MDR + 6 lane mux + 6.3 driver | 19 ns; address at 17 ns |

### The workload and the harness
`memory-card-test.js` is now the stage 1+2 harness:
- **RAM inputs are gone.** Reads come from the card's own chips.
- **At power-up** the RAM rows and both VRAM copies are preset from the machine's memory. That's declared, like the
  register preset.
- **Every chip write is accounted for, in both directions.** Each microsim write must land in exactly the right chips
  (both chips of the right row, or both VRAM copies) at the right address with the right value. Any other chip write
  is a mismatch, which is how an un-gated aborted write is caught.
- **J2:** VBUSY is checked each cycle. When VRAM-S is free, a scan-out probe reads a pixel (half the time the last one
  written) through SA → SO.
- **Port 4** pixel writes go through J2 in the netlist.
- **Off-card writers not drawn yet** (the port-5 fill engine, and the legacy I/O model's disk DMA in the boot
  workloads) are found on I/O cycles by diffing a shadow, then copied into the card's chips. They're counted under
  "sync" in the coverage (declared).
- **After each machine,** a full audit compares the RAM rows and both VRAM copies against the microsim, both ways.

New directed workload `directed-fb.js`, 7 machines:
- framebuffer stores wider than 6 trits, read back; word access at both ends of the framebuffer; 300 scattered pixels
  over all 7 VRAM pages; 40 port-4 pixels with IN 4;
- every RAM row boundary, on a 3^14 machine and a 3^15 machine (all 8 rows);
- T2 through negative addresses, and a T2 base register with junk in its high trits;
- a protected user-mode store to real RAM (aborted);
- a port-5 fill followed by CPU reads.

## Stage 1b: no ripple in the address check or MAR (2026-11-18)
**The problem.** Timing stage 2's write strobe meant asking when ABORT is valid, and stage 1 had never been timed:
- **ABORT:** the address check's variable chains (a − UBASE, a − ULIMIT, a + 2 − ULIMIT) were 9 slices rippling, so
  7 + 9 × 10 + 10 (fault table) ≈ **107 ns**. That's past the 100 ns cycle before ABORT even leaves the card, and every
  card's clock enables need it.
- **The write strobe** opens at mid-cycle (/WE = enable OR CLK), so ABORT has to be valid by 50 ns, or an aborted
  write lands. A faulting store could corrupt RAM: a real bug on real hardware, invisible to a functional simulation.
- **MAR +1** rippled through 9 slices too: 7 + 90 + 2 ≈ **99 ns**, and MAR_INC is about 16% of all microcycles.
  Load+1 from a late bus was worse.

**The fix: nothing ripples.**

- **Comparisons are lexicographic.** For balanced numbers, the sign of a − b is the sign of (a_k − b_k) at the most
  significant trit where they differ: the trits below are worth at most 3^k − 1, less than one unit of 3^k. So no
  carry is needed, just "first difference from the top".
  - **Variable compares** (MAR against UBASE, ULIMIT, UL2): 7 slice tables of 4 trits each (a(4) | b(4), 16 address
    bits → <, =, >), all in parallel. Then one combine table takes the first non-equal slice from the top. That's 8
    tables per compare, 24 in all.
  - **Constant compares** (0, RAMSIZE, RAMSIZE − 2, FB_BASE, FB_END, FB_END − 2): 7-trit chunk tables with the
    constants baked in, 4 constants per table, so 8 tables. Then 3 combine tables (2 constants each).
  - **The "+2" folds into the other side:** a + 2 < X ⟺ a < X − 2. For the constants it's free.
  - **For ULIMIT it's a third shadow, UL2 = ULIMIT − 2,** loaded on the same edge as the ULIMIT shadow from the bus
    through a lookahead "minus 2":
    - borrow into slice k = (slice 0 ≤ −12) AND slices 1..k−1 all −13;
    - the "all −13" flags are 3-input ANDs on the − rails (3 × 74LVC11);
    - then 1 lookahead table, 9 slice tables, 3 × 16823;
    - an underflow flag (UL − 2 below the 27-trit range) makes "a + 2 < ULIMIT" false for every a, as the microsim's
      exact arithmetic says.
  - **The fault table is unchanged:** n1..n9 mean exactly what they meant.
- **MAR uses lookahead.** A +1 carries out of a 3-trit slice only when the slice is +13 (all trits +1).
  - "Slice is +13" flags come from the MAR and from the bus: 16 AND3 gates on the + rails (6 × 74LVC11). Two 74LVC157
    pick one set by MOP1 (load or not).
  - One lookahead table gives the carry into each slice (MARC AND the flags below).
  - The 9 slice tables take their carry from it, not from each other.
  - **ABORT moved from the slice tables' address to the MAR registers' clock enable** (/CLKEN = ABORT), like MDR and
    FADDR, so it only needs setup time.

| path | stage 1 | stage 1b |
| --- | --- | --- |
| ABORT valid | 7 + 90 + 10 ≈ 107 ns | 7 + 10 (slices) + 10 (combine) + 10 (fault table) = **37 ns** |
| MAR + 1 | 7 + 90 + 2 ≈ 99 ns | 7 + 6 (AND3) + 6 (mux) + 10 (lookahead) + 10 (slice) + 2 = **41 ns** |
| MAR load + 1 | bus + 92 ns | **bus + 34 ns** |
| UL2 shadow load | — | bus + 6 + 10 + 10 + 2 = **bus + 28 ns** |
| write strobe opens | 50 ns, before ABORT (bug) | 50 ns, 13 ns after ABORT |

(Gates and muxes are counted at 6 ns, the margin TIMING-BUDGET.md keeps for 5.2 ns parts. **The 74LVC11's datasheet
maximum still needs confirming.**)

- **Cost:** +10 chips net. The check went from 51 ripple tables to 24 + 11 tables; UL2 and the MAR lookahead add 26
  parts.
- **Table images, for the copy engine** (I/O card stage): the card's 65 tables use **642 KB of distinct images**,
  2.2 MB counting duplicates loaded in parallel.
  - My first cut, with 9-trit chunks, was 2.3 MB distinct, more than the planned 2 × 512 KB of flash on its own. The
    7-trit chunks cost 3 chips and saved 1.7 MB.
  - **The copy engine's flash has to be sized against every card's images; this card alone is 0.64 MB.**

**Mutants for 1b:**
- MAR_IGNORES_ABORT (MAR's clock enable tied on);
- MAR_SHORT_CARRY (lookahead only reaches slice 1);
- UL2_SHORT_BORROW (the minus-2 borrow stops after slice 1).

The prot workload got 6 new machines with ULIMIT values whose "minus 2" borrows through 2, 4 and 5 slices (6,926,
265,721 and 7,174,454), each with a word store at ULIMIT − 3 (allowed) and ULIMIT − 2 (protection fault, EADDR =
ULIMIT).

### Stage 2 results
Stages 1 + 1b + 2 together (the card as it stands, 241 parts at 3^14), differential every microcycle:

| workload | microcycles | card drove the bus | mismatches | what it reached |
| --- | ---: | ---: | ---: | --- |
| prot (14 machines) | 32,972 | 11,058 | 0 | 303 protection faults, 765 shadow snoops, the 3 UL2 borrow cases |
| fetchfault | 63 | 19 | 0 | a fetch from a missing row (the pull-downs) |
| bcfault | 73 | 21 | 0 | |
| directed | 37,543 | 6,829 | 0 | MAR carries across 2+ slices |
| irqbm | 45,213 | 3,880 | 0 | |
| spr | 53,985 | 6,043 | 0 | |
| **fb** (7 machines, new) | 18,875 | 6,742 | 0 | all 8 rows, 323 FB writes, 330 FB reads, 39 J2 pixel writes, 45 T2 wrapped reads, an aborted write |
| random (26 machines) | 300,000 | 84,239 | 0 | 251 aborted writes, 1,496 T2 wrapped reads |
| desktop boot | 300,000 | 75,812 | 0 | 5,983 CPU framebuffer writes, a port-5 fill, 35,094 DMA trytes synced |
| TritOS 2.1 boot | 300,000 | 75,664 | 0 | all T2, 3,695 wrapped reads, 30 J2 pixel writes |

**Total: 1,088,724 microcycles, 0 mismatches.** Scan-out probes ran in every cycle where VRAM-S was free:
1,082,348 probes, all correct.

- **One harness bug was found and fixed on the way.** The end-of-run audit ran after the boot workloads had carried on
  past the 300,000 tracked cycles, so it compared the card with memory the machine had written since tracking stopped:
  3 "mismatches" each on desktop and TritOS, with every per-cycle check clean.
  - The audit now runs at the moment tracking stops, and both boots were rerun.
  - The earlier lines stay in `RESULTS-memory-card.jsonl`, as recorded.

### Stage 2 mutants (positive controls)
All 15 killed (5 from stage 1 rerun against the new card, 3 for stage 1b, 7 for stage 2):

| mutant | what it breaks | killed by | first symptom |
| --- | --- | --- | --- |
| RAMSIZE_OFF_BY_ONE | constant RAMSIZE + 1 | prot | missed ABORT on the word load straddling the end of RAM |
| CHK3_USES_SINGLE | "a + 2 < ULIMIT" wired from "a < ULIMIT" | prot | PUSH across ULIMIT didn't fault |
| FK_INVERTED | fault kind inverted | prot | wrong FK on the first protection fault |
| SNOOP_WRONG_SLOT | shadows snoop UBASE's slot for ULIMIT | prot | ULIMIT (and UL2) shadow never loaded |
| MDR_LANE_RAILS | one rail pair swapped in lane 1 | directed | MDR tryte 1 off on an LMI |
| MAR_IGNORES_ABORT | MAR clock enable tied on | prot | MAR 5001 vs 5000 after a faulting word load |
| MAR_SHORT_CARRY | lookahead reaches slice 1 only | directed (survives prot: its code never crosses 364) | MAR −364 vs 365 |
| UL2_SHORT_BORROW | minus-2 borrow stops after slice 1 | prot | UL2 shadow 7653 vs 6924 (ULIMIT 6926) |
| T2_NO_WRAP | T2 chunk-1 table without the +81 | fb | T2 store at −1 missed RAM 19682 |
| CHUNK_OFF_BY_ONE | T3 chunk-1 table reads trits 4..8 | fb | first framebuffer store went elsewhere |
| VRAM_NOT_TRUNCATED | VRAM keeps 7 trits | fb | pixel stored −1093 vs −364 |
| WRITE_NOT_BLOCKED | /RWE ignores ABORT | fb (and random's 251 aborted writes) | unexpected RAM write in an aborted cycle |
| FB_STEER_INVERTED | read mux select inverted | fb | the very first fetch read 0 |
| SCAN_MUX_INVERTED | VRAM-S takes the CPU address at the wrong time | fb | VRAM-S not written at the CPU's address |
| J2_WRITE_ONE_COPY | J2 writes skip VRAM-C | fb | VRAM-C missing a port-4 pixel |
