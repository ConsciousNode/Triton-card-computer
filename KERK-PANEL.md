# The KERK front panel
**Kehai Interim, 2026-11-22.** Controls chosen by Kham (2026-11-22): the classic set. Step size: either, by switch.
The old HALTED pin becomes RESET (Kham: "it's free real estate").

## What's on it
| control | kind | does |
| --- | --- | --- |
| **RESET** | push button | restarts the machine (the RESET routine, then POOP OK). Clears HALT and a pending step. |
| **RUN / STOP** | toggle | RUN: the machine runs. STOP: it freezes where it is, with nothing lost. |
| **STEP** | push button | while stopped, one press = one step forward, then it freezes again |
| **STEP-MODE** | toggle | **instruction**: a step is one whole instruction (e.g. `ADD R1, R2`); **microcycle**: a step is one tick of the CPU's own clock (an instruction is about 4–10 of them) |
| power | LED | the 3.3 V rail is up |

No HALT lamp (Kham, 2026-11-21).

**How it behaves:**
- In **instruction mode** a stopped machine always rests on an instruction boundary, the FETCH word, exactly where
  HALT parks. So:
  - STOP lets the current instruction finish first.
  - Switching back to instruction mode while stopped mid-instruction (after some microcycle steps) finishes that
    instruction by itself.
- In **microcycle mode** STOP freezes at the next CPU edge, and each STEP lets exactly one edge through.
- The slot-clock side keeps going while stopped: the screen keeps showing, and the UART, the timer and the scan-out
  carry on. A stopped machine is a frozen CPU, not a dead machine.
- Powered up with RUN off, the machine still comes out of reset, then parks before its first instruction (or at its
  first edge, in microcycle mode). POOP OK waits for you.

## The four backplane pins
`FP_RUN`, `FP_STEP`, `FP_STEPMODE`, `FP_RESET` (BACKPLANE-PINOUT.md; the pin budget stays exactly full).
- All are active low on the panel: switch closed to GND. High = run, released, instruction mode.
- Unplugged, the panel reads as "run, released, instruction mode", so the machine just runs.

## On the panel board
- **MAX6817** (dual switch debouncer, SOT-23-6): RUN/STOP and STEP. **MAX6816** (single, SOT-143): STEP-MODE.
  - They need no external parts (internal pull-ups, ±15 kV ESD protection), and the debounce period is about 40 ms.
  - STEP must be debounced, or one press could become several steps.
- **RESET** goes straight to the Control card's **MAX812** manual-reset input. That input is debounced, has an
  internal 20 kΩ pull-up, and can be shorted to ground with a switch. Reset is held for the supervisor's timeout
  after release.
- Power LED plus resistor.

## On the Control card (in `cards/clockgen.js`; 5 new chips, no new backplane signals)
- **U209** 74LVC574 on SCLK: synchronizes the three panel lines (two flops each), plus one more stage on STEP.
- **STEPP** = STEP3 & /STEP2: one slot per press.
- **PEND** (U213 half 1): set by a press, kept until spent, cleared by RESET.
- **ALLOW** = RUN | PEND | (instruction mode & not FETCH) | RESET.
  - "Not FETCH" is **/ATF**, a spare bit in the Control card's own control-store slice (52 → 53 bits, still 7 chips),
    low only in the FETCH word. That costs no gates.
  - RESET is in ALLOW because the reset synchronizer needs CPU edges to release.
- **One decision per cycle:**
  - The write strobe is gated by ALLOW: WSTB_NEXT & ALLOW.
  - The edge is gated by that same decision one slot later: GOQ, U213 half 2. CEN_D = CEDGE & /HALTQ & GOQ.
  - So an edge always has its write strobe, and a stopped cycle writes nothing.
  - A press landing between the two decisions waits for the next cycle. (Caught in review before the first run: with
    ALLOW read twice, a press in slot 2 would have made an edge without its write.)
- **SPENT** = CEN & (microcycle mode | FETCH): the edge that uses a step up.
- Chips: U209 '574, U210 '04, U211 '08, U212 '32, U213 '74, plus U207's two spare ANDs. The Control card grows by 5.

## Tests
- **`cards/clockgen-test.js`:** 24/24 cases, 12/12 mutants. The new case is judged by behaviour against a played
  microcode of known instruction lengths:
  - after STOP, it parks on FETCH;
  - an instruction STEP runs exactly one instruction;
  - a microcycle STEP makes exactly one edge;
  - instruction mode mid-instruction finishes the instruction;
  - RUN resumes;
  - every edge has exactly one write strobe;
  - powered up stopped in microcycle mode, it still leaves reset.
  - Mutants PANEL_IGNORED, STEP_NEVER_SPENT and MODE_IGNORED are all caught.
- **Whole machine, `integration/program-lockstep.js panel`:** the directed program, with the panel driven like a
  person would. Run; STOP at instruction 25 (parked on FETCH after 26); 3 instruction STEPs (8, 10 and 8
  microcycles: one instruction each); microcycle mode, 3 STEPs (one microcycle each); back to instruction mode
  (finished the instruction it was in); 1 STEP; RUN to HALT.
  - 409 stopped cycles, each checked: micro-address and PC held, no main or register RAM write.
  - Every executed cycle stays in lockstep with the microsim.
  - The three mutants (as `clockgen:` mutants) are caught on the whole machine too.
- **Regression after the change:** control-card-test directed (0 mismatches); whole machine directed, POOP OK,
  traps, timer and console all match.

## Open
- The panel's physical layout (switch types, where it mounts on the rack) comes with the case/KiCad work.
- A RESET-button run on the whole machine isn't simulated separately: the MAX812 is a world part, so a press there is
  exactly the power-on reset every run already starts with.
