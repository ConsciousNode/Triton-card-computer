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
