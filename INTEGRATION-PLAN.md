# The integration netlist: plan (Kehai, 2026-11-20)
**Goal:** all six cards in one netlist on one simulated backplane. Only the world is driven from outside: the
oscillator, the reset button, SD, PS/2, the RTC crystal and the serial terminal. The microsim runs beside the netlist
**only to check**, never to drive.

Every card so far was tested alone, with its harness standing in for the other five, so a mistake *between* cards
could pass every card test. The Registers card's test catching a Control card fault was a taste of that.

## Stage 0: does the backplane agree with itself? (a static check, quick)
- A script lists every net each card treats as a backplane signal (from `BACKPLANE-PINOUT.md`) and who drives it.
- It flags names that differ for the same signal (the I/O card's `IORDY` vs the Video card's `READY`; `RESET` vs
  `/RESET`), signals with two strong drivers, and signals nobody drives.
- It checks the shared lines that should be open-drain (IORDY, /IRQ0..5) are open-drain on every card.

## Status, 2026-11-20
- **Stage 0 done.** Findings fixed: BTOP0 undriven (→ BTOPNZ, ALU + Control); the check's classifier called the
  '16823 bus registers "always on" (they're three-state via x/OE, as `loadpath.js` already treats them).
- **Stage 1, part 1 done: names and the clock/reset generator.**
  - Backplane renamed to the cards' tested spellings: IRQSET0..4 (one-clock active-high pulses, not /IRQ0..5 levels),
    MODE, PROTEN, RESET (active high). `/CEDGE` and `STRETCH` added to the backplane; it was missing `/CEDGE`, which the
    Video and I/O cards need. The connector is now exactly full: 112 signals, 0 spares.
  - `cards/clockgen.js` (on the Control card): '161 slot counter on SCLK, registered /CEDGE, glitch-free gated CLK
    (CEN captured on SCLK's falling edge), RESET asserted at once by POR (MAX812, the KERK panel's reset button on its
    MR input) or LOAD (the copy engine), released on the 2nd CPU edge. STRETCH (the carry-cycle stretch, ÷8) is built
    and tested but pulled low until the ALU card drives it. Pull-downs on IRQSET3/4 (no disk or network IRQ here).
  - `cards/clockgen-test.js`: half-slot stepping against an independent oracle, 22/22 cases, 7/7 mutants caught.
  - Backplane check: every signal now has a declared driver (SCLK and LOAD declared as world-driven).
  - Load-sim rerun after the renames: all five cards' tables load and verify.
- **Still to decide:** DIV0 and PROT are on the backplane but no card uses them (two pins that could be freed).
- **Bench items from stage 1:** CLK lags SCLK by one '08 delay, so feed the SCLK-side cards through a matched gate in
  the same package. A CEN flop clocked on the wrong edge would race the CLK gate; a functional simulator only catches
  that indirectly, through the reset-release timing.

- **Stage 1, part 2 done: the composed machine** (`integration/integrate.js`, `machine-sim.js`, `lockstep.js`).
  - 657 chips in one netlist: the six cards from the same ROM images their own tests use, the clock/reset generator on
    Control, and backplane termination. Card-local nets are prefixed ("IO:BUSY"); backplane and J2 nets are shared;
    J2's one name mismatch (Memory VWEH = Video VBUSY) is joined explicitly. Every input any card's harness used to
    supply is now driven inside the machine or is a declared world input.
  - A precise static check (a '245 with DIR tied drives one side; registers with /OE are three-state): every read net
    driven, no always-on driver sharing a net.
  - `machine-sim.js`: one physical rule for every chip: clocked only when its own clock net rises, with pre-edge values;
    derived clocks followed; async SRAMs write whenever /WE and /CE are low.
  - **Three integration findings, all fixed:**
    1. **The backplane floated.** On cycles where no card drives the bus, the ALU's tables read an undriven D0+. Every
       card harness had quietly supplied 0. Fix: backplane termination, 65 three-state lines pulled down (9 resistor
       packs on the backplane): idle bus = trit 0 on both rails, idle controls inactive.
    2. **The machine came up in the wrong mode.** Control's status latch had no reset (every card test preset it from
       outside, a declared exception). Fix: both halves clear on RESET; MODE and PROTEN are stored inverted (U104,
       one '04), giving ISA-4's reset state: MODE 1, PROTEN 1, the rest 0. Mutant LATCH_NO_RESET (caught by lockstep).
    3. **Every taken branch ran one extra microword.** UA was the µPC register's output, so µPC -> control store ->
       pipeline was a three-stage loop with one clock edge: a delay slot the microsim doesn't have. The card tests hid
       it (clocking pipelines mid-cycle, or comparing "one cycle behind"). Fix: the backplane UA is now the *next*
       address (NA, through two '244 buffers that let go in LOAD); every card's pipeline latches the word the µPC is
       moving to on the same edge. The µPC keeps the executing address (UPC) for the incrementer. Path: pipeline ->
       next-address table -> muxes -> '244 -> each card's control store -> pipeline setup, about 45-60 ns of the 100 ns
       cycle (conditions come from registers). Mutant UA_IS_UPC (caught by the Control test and lockstep).
  - The Control card test now clocks every register on one edge (it used to run a cycle behind): directed, irqbm, spr
    and fetchfault all 0 mismatches. Load-sim: Control's 42 tables still load and verify (UA releases in LOAD).
  - **Lockstep:** after reset, the whole machine runs beside the microsim, comparing every microcycle: the executing
    micro-address (UPC), the next address (UA), the bus, and MODE/PRIV/IE/PROTEN. Empty RAM (NOPs): 300 microcycles,
    no divergence.
- **Next: stage 2 proper.** Load a real program into the machine's RAM (and the microsim's), compare registers and
  memory at instruction boundaries, then the directed programs, then the POOP OK boot.

## Stage 1: compose the cards
- `integrate.js` builds each card's netlist and merges them into one. Local nets get the card's prefix (`IO:BUSY`); the
  backplane nets are shared.
- Backplane nets that are buses (D0..D26 dual-rail) go through each card's '245s, exactly as drawn.
- The clock and reset come from where the pinout says they do (Control → all; SCLK via the Video card to Memory over
  J2). Whatever isn't drawn yet gets drawn here, not faked in the harness.

## Stage 2: the first instruction
- Tables are loaded at the start: **declared** (the copy engine's power-up load is proven separately by `load-sim` and
  `powerup-sim`; running all 811K load clocks every time would cost an hour).
- A tiny program in RAM. At every instruction boundary we check PC, the registers, PSW, IPEND and every memory write
  against the microsim.

## Stage 3: the directed programs, on the whole machine
- These reuse what each card's test already proved, now with nobody standing in: the ALU directed set, IRQ +
  block-move, the protection faults, a video fill, the SD driver, the timer, and the console.
- **The milestone: the integrated machine boots a small program that prints `POOP OK` on CON_TX**, received by the
  world's terminal.

## Stage 4: the speed of the simulator
- Each card alone runs about 4–7 ms per microcycle; six together will be slower. If Stage 3 is too slow, the settle
  loop goes event-driven: re-evaluate only chips whose inputs changed. Results must stay bit-identical; the card
  tests rerun to prove it.

## What it will probably find
- Naming and polarity mismatches between cards; two cards both thinking they drive something at a boundary cycle.
- Timing order assumptions: each harness chose an order (e.g. IRQSET at the edge, `/CEDGE` slot 3) that the real
  cards must agree on.
- Whatever is missing: the clock and reset generator, the KERK panel's inputs, the Video card's READY into IORDY.

## Then
The KERK front panel (it hangs on the Control card's 4 panel pins), the ROM repack, and KiCad schematics, from a
netlist that has run as one machine.
