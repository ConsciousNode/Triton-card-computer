# Triton card computer: critical-path timing budget (first pass)
**Kehai Interim, 2026-11-18.** Answers Vael's question 1 (The Office, `dev/2026-11-18_vael_to-kehai_card-computer-microcode-read.md`):
does the assumed 100 ns microcycle hold? **Not for the ALU's carry chain.** It does hold for everything else, and that
lets the card keep its speed.

## Part numbers used (worst case over −40…+85 °C at 3.3 V ± 0.3 V, from datasheets)

| Part | Role | Number used | Source |
| --- | --- | --- | --- |
| 74LVC245A bus transceiver | bus drivers, card-to-backplane buffers | **6.3 ns** max propagation | TI SN74LVC245A datasheet (3.3 V ± 0.3 V, −40…85 °C) |
| 74LVC574A D flip-flop | A/B/MAR/MDR/IR latches, microword pipeline register | **7.0 ns** max clock-to-Q; **2 ns** setup | Philips/Nexperia 74LVC574A; TI SN74LVC574A-Q1 |
| ISSI IS61WV1288EEBLL / IS61WV5128EDBLL | fast SRAM for shadowed tables (128K×8 / 512K×8) | **10 ns** access at 2.4–3.6 V (8 ns at 3.3 V ± 10%) | ISSI datasheets |
| ISSI IS61WV204816BLL | main RAM (2M×16) | **10 ns** access | ISSI / DigiKey listing |
| SST39LF010/020/040, SST39VF0x0 parallel flash | power-up image of all tables and microcode | **45–55 ns** (LF), **70 ns** (VF) access | Microchip/SST datasheets |
| 74LVC157A 2:1 multiplexer | B broadcast, shifter options, next-address select | **5.2 ns** max at 3.3 V (6 ns kept in the sums as margin) | TI SN74LVC157A datasheet |

Datasheet maximums are already worst case across the temperature range, so a design that fits them fits a hot board.
Wiring and backplane loading aren't included; they're covered below by a margin.

## Paths, one microcycle each

| Path | Sum | Total |
| --- | --- | --- |
| **ALU with carry** (ADD, INCA): A/B latch → 9 table slices in a ripple (each slice's carry is the next slice's address) → shifter mux → bus driver → destination setup | 7.0 + 9 × 10 + 6 + 6.3 + 2 | **111 ns** (≈122 ns with 10% wiring margin) |
| ALU without carry (MIN, MAX, tritwise, PASS): all 9 slices in parallel | 7.0 + 10 + 6 + 6.3 + 2 | 31 ns |
| Register RAM read → bus → latch | 7.0 (microword) + 6 (address mux) + 10 + 6.3 + 2 | 31 ns |
| Memory read (**as drawn, Memory card stage 2**): MAR → one level of conversion tables (no adder) → RAM on the same card → read mux → MDR | 7.0 + 10 + 10 + 5.2 + 6 + 2 | **≈41 ns** (the pre-drawing estimate was ≈67) |
| Address check → ABORT (**stage 1b**; stage 1 as first drawn rippled 9 slices: ≈107 ns, over budget) | 7.0 + 10 + 10 + 10 | **37 ns** |
| MAR + 1 (**stage 1b** lookahead; stage 1 as first drawn: ≈99 ns) | 7.0 + 6 + 6 + 10 + 10 + 2 | **41 ns** |
| Next microword from latched flags (control store shadowed in SRAM) | 7.0 + 6 + 6 + 10 + 2 | 31 ns |
| …same, control store left in 45 ns flash | 7.0 + 6 + 6 + 45 + 2 | 66 ns |
| **Dispatch** (FETCH's last cycle: the instruction arrives from memory, the dispatch table picks the routine, the control store fetches its first word) | 39 (memory to the backplane, as drawn) + 10 + 6 + 10 + 2 | **≈67 ns** with everything shadowed (was ≈95 with the estimated memory path); ≈102 ns with flash |
| ALU tables left in 70 ns flash | 9 × 70 + … | ≈650 ns: not an option |

## Findings

0. **(Added 2026-11-18, Memory card stages 2 and 1b.)** The address check and MAR were never in this table, and as first
   drawn they rippled 9 slices: ABORT at ≈107 ns and MAR + 1 at ≈99 ns. That's over budget, and ABORT came after the
   write strobe opens. Fixed with no-ripple comparisons and lookahead (ABORT 37 ns, MAR + 1 41 ns); see MEMORY-CARD.md.

1. **Shadow everything at power-up.** Copy the ALU tables, the dispatch table and the control store from one flash
   chip into 10 ns SRAM. The doc already suggested this for the ALU; the dispatch path needs it too.
2. **The 9-slice ripple carry is the one path that doesn't fit 100 ns** (≈111–122 ns). Everything else fits with room
   to spare; most paths take about a third of the cycle.
3. **Only 18% of microcycles use the carry chain** on a real workload (`timing-mix.js`: Desktop 1.1.2 boot + input,
   2,835,861 microcycles). The rest: 9.5% ALU without carry, 12.7% memory, 6.9% dispatch, 52.8% register/bus moves
   and branches.

## Options, measured on that workload (instructions/s)

| Clocking | Speed |
| --- | --- |
| uniform 100 ns (the original assumption, now known not to hold) | 1.34M |
| uniform 125 ns (8 MHz) | 1.07M |
| uniform 135 ns (7.4 MHz: ripple plus 20% margin) | 0.99M |
| **100 ns, carry cycles stretched to 200 ns** | **1.14M** |
| 70 ns, carry cycles stretched to 140 ns (needs every other path under 70 ns) | 1.62M |

**Recommendation for the first board: stretch only the carry cycles.**
- The clock generator gives a cycle a second period whenever the microword asks the ALU for ADD or INCA *and* uses
  the result. That's decode logic on fields the microword already has, so it needs **no new microword bit**.
- **Margins:** carry cycles get 200 ns for a ≈120 ns path, and everything else gets 100 ns for ≤95 ns. Generous for
  a first board, and it pairs naturally with the replica-path clock idea.
- **Speed:** ≈1.14M instructions/s, the same headline as before, now from measured path delays instead of an
  assumption. That's still about 5.7× TritOS's 200k/s pace.
- If dispatch turns out tight on the bench, stretch dispatch cycles too: about 1.07M/s.

## Later speed-ups (not needed for the first board)
- **Ternary carry-lookahead.** Each slice's carry-out, as a function of its carry-in, is a small "transfer function".
  Compose them in a tree of lookup tables (about 4 levels for 9 slices) instead of rippling. That's about 40–50 ns for
  the whole add. Then a 70 ns base clock with no stretching looks reachable, around 1.6–1.9M/s.
- **Carry-select:** each group of slices computes all three possible carry-ins in parallel. It costs more chips.

## Still open
- (Mux delay: looked up, 5.2 ns max; the sums keep 6 ns.) The dense-conversion adder is gone: the Memory card converts
  with one level of per-chunk tables and no carries (cards/MEMORY-CARD.md, stage 2). Still to confirm: the 74LVC11's
  datasheet maximum (counted as 6 ns).
- Then add backplane trace and loading figures once the layout exists. The bring-up ladder measures all of this for
  real.
