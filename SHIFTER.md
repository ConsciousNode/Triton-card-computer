# The shifter: measured, then sized
**Kehai Interim, 2026-11-18.** Measured with `microsim/shift-mix.js` (results in `microsim/RESULTS-shift-mix.jsonl`).

## What real code uses
The control store has 535 words; 509 of them don't shift at all.

| option | control-store words | Desktop 1.1.2 boot (2.84M µcycles) | TritOS 2.1 self-host (13.9M µcycles) |
| --- | ---: | ---: | ---: |
| NONE | 509 | 95.58 % | 93.93 % |
| L1 | 5 | 0.10 % | 0.25 % |
| **L3** | **0** | 0 | 0 |
| L9 | 5 | 0.06 % | 0.15 % |
| R1 | 4 | 1.09 % | 1.77 % |
| **R3** | **0** | 0 | 0 |
| R9 | 4 | 0.24 % | 0.62 % |
| R1C | 4 | 1.05 % | 1.64 % |
| R1L | 2 | 1.05 % | 1.64 % |
| L1L | 1 | 0.42 % | 0 |
| R1O | 1 | 0.42 % | 0 |

## What that means for hardware
1. **L3 and R3 are dead.** No microcode word emits them. The hardware doesn't build them, and their enum codes become
   *reserved*. The ROM images are unchanged, so the verification stands as it is.
2. **Only three distances remain: 1, 9 and 0.** R1C, R1L, L1L and R1O are R1/L1 with a different trit fed in at the end.
   Only the one end trit needs a fill selector (a couple of 74LVC153s), not the whole word.
3. **So each of the 54 wires (27 trits, dual-rail) needs a 5-way choice:** none, L1, R1, L9, R9.

## Build: FET bus switches
**74CBTLV3253**, dual 1-of-4 FET mux at 3.3 V.
- Data path: **0.15 ns max** (NXP datasheet). It's a closed switch, not a gate, so the shifter all but drops out of the
  timing budget.
- The select-to-output enable time is ~5 ns, but the select comes straight from the microword pipeline register at the
  start of the cycle. It settles while the ALU tables are still looking up (10 ns+), so it's off the critical path.

| option | chips | speed cost |
| --- | --- | --- |
| **A. 4:1 {none, L1, R1, R9} in 3253s, L9 through 8-bit bus switches (74CBTLV3245-class) on the same output node** | 27 + 7 = **~34** + 2 fill | none |
| B. 4:1 only; L9 done by the microcode as nine L1s | 27 + 2 fill | +1.2 % µcycles on TritOS self-host (L9 0.154 % × 8 extra) |

**Recommendation: A.** Seven chips buy back the 1.2 %, and the microcode and ROMs stay exactly as verified. Either way,
the "dozens and dozens of mux chips" worry from PARTS.md shrinks to about 34 small, fast chips.

Still to check at schematic time: the load the switches put on the ALU output nets (each output feeds up to 5 switch
inputs), and the fan-in on the bus side.
