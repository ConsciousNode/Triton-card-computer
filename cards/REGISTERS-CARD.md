# The Registers card (a checked netlist)
**Kehai Interim, 2026-11-18.** `registers-card.js`, tested by `registers-card-test.js` (differential, every cycle).

## What's on it (20 parts)
| part | qty | job |
| --- | ---: | --- |
| IS61WV5128 (10 ns) | 7 + 1 | register RAM: 32 slots × 54 wires (R0–R8, SP, the register-RAM SPRs, temporaries); 1 control-store chip |
| 74LVC245 | 7 | bidirectional: RAM → bus on reads, bus → RAM on writes |
| 74LVC574 | 1 | pipeline for this card's 2 control bits (/RD, /WR), off in RESET |
| 74LVC32, 74LVC08, 74LVC04 | 3 | read = RF_RD and not SPRNR; write = RF_WR and not SPRNR and not ABORT; transceiver enable and direction |
| 4.7k resistor pack | 1 | "neither read nor write" during RESET |

- **Inputs from the backplane:** RSLOT0..4 (Control), SPRNR (Control), ABORT (Memory), the micro-address, the bus.
- **Write strobe (drawn 2026-11-20):** /WE = /WRE OR /WSTB (U3's spare gate). /WSTB is the backplane write strobe,
  low for the slot before the CPU edge's slot, so the slot address and data are settled when it opens and still when
  it closes, 25 ns before the edge. The first plan (/WE = /WRE OR CLK) no longer worked once CLK became a short pulse
  from the clock generator; the integration timing simulation showed writes spanning into the next word
  (integration/TIMING-GATE-LEVEL.md). The card test holds /WSTB active and writes at the edge, as before.

## A real bug this card caught in the Control card
SPR 8 (PROT_EN) is a latch, but my Control card's SPR tables treated every SPR in 5..14 as a register-RAM slot. So
SPRNR stayed low for SPR 8, and the Registers card would also have written register slot 18.
- **The Control card's own test** had the same wrong rule in its harness, so it passed.
- **The Registers card's test** compares against the microsim's register file, and it caught the bug on the first SPR
  probe.

Fixed in `control-tables.js` and in both harnesses; the Control card was fully rerun.
**Lesson:** a harness that computes the expected value with the same assumption as the design can't catch that
assumption. Testing cards against each other, and eventually the whole machine as one netlist, is worth doing.

## Results (`RESULTS-registers-card.jsonl`)
| workload | microcycles | Registers drove the bus | mismatches |
| --- | ---: | ---: | ---: |
| 100 random programs | 300,000 | 44,093 | **0** |
| Desktop 1.1.2 boot | 400,000 | 72,285 | **0** |
| TritOS 2.1 | 400,000 | 59,108 | **0** |
| directed arithmetic | 37,543 | 8,908 | **0** |
| fetch fault / interrupts on block moves / SPR probe | 63 / 45,213 / 53,985 | | **0** |
| block-move fault probe (BFILL off the end of RAM) | 73 | 14 | **0** |

All 32 slots are compared after every edge.

**Mutants: 3 of 3 caught:**
- SPRNR ignored;
- two slot-address bits swapped;
- ABORT ignored.

The last needs the new block-move fault probe. Most register writes that share a cycle with a memory access are
pre-checked by CHK3, so they never abort. The BFILL body writes the count in the same cycle as the memory write, so
there the gate matters.

## Also today: the ALU card drives BUS = ZERO
Fourteen microcode words put 0 on the bus, and no card had been assigned to drive it. The ALU card now does it from its
all-zero table page; none of those words uses the ALU. Reruns: random and directed, 0 mismatches.
