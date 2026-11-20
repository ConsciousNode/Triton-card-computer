# The ALU card, schematic draft 1 (a checked netlist)
**Kehai Interim, 2026-11-18.** `alu-card.js` places every chip and names every pin-to-net connection. `parts.js` holds
functional models of the real parts, and `netlist.js` simulates them. `alu-card-test.js` is **differential twin #3**:
the card runs chip by chip beside the microsim on real workloads, microcycle by microcycle.

## Non-emulation check (Kham's rule)
There is no processor, no programmable logic and no firmware. The card is:
- latches;
- lookup tables in SRAM (the ALU slices and the card's own control store);
- 2:1 and 4:1 multiplexers;
- FET bus switches;
- bus transceivers;
- resistor packs.

The tables come from `roms/` and are loaded at power-up by the copy engine.

## What's on it (96 parts, flags block included)
| part | qty | job |
| --- | ---: | --- |
| IS61WV5128 (512K×8, 10 ns) | 9 + 4 + 3 + 1 | 9 slice tables (`alu.bin`), 4 control-store chips (this card's fields only), 3 tryte-sign tables + 1 flag table (`flag-tables.js`) |
| 74ALVCH16823 (18-bit FF, clock enable) | 3 + 3 + 2 + 1 + 1 | A latch, B latch (54 wires each), control-word pipeline register, link + QT, flags + their fetch-time shadow |
| 74LVC32 (quad OR) | 1 | A/B/flag load enables ORed with ABORT |
| 74LVC157 (quad 2:1) | 12 + 1 + 1 | B broadcast for slices 1–8; WIDTH9 function select; QT load |
| 74LVC153 (dual 4:1) | 4 + 3 | carry-in select (0, CF, +1, link), negate select (0, 1, QT), top-trit fill (0, carry, link), link source; flag select (table / shadow / bus for IRET) |
| 74CBTLV3253 (dual 1-of-4 FET) | 27 | shifter: none / L1 / R1 / R9, one chip per trit (both rails) |
| 74CBTLV3245 (octal FET) | 7 + 2 | shifter: L9; ESRV (shadow flags, PRIV, IE onto trits 0–4) |
| 74LVC245 | 7 | bus drivers onto the backplane |
| 4.7k ×8 resistor pack | 4 | hold every control line high during RESET |

## Design decisions found while drawing it
1. **No decode logic.** The card's control store holds this card's control lines already decoded (switch selects,
   enables, fill and link sources), packed from the shared ROM images at ROM-generation time.
2. **WIDTH9 costs one chip.** It only ever appears with ADD and no shift (checked against the microcode). In WIDTH9 the
   upper six slices are pointed at function 11: an unused table page whose bytes are all zero, which in dual-rail means
   "result 0, carry 0". No ROM change.
3. **Power-up safety.** A pipeline register full of random bits could turn on two shifter switch banks at once and short
   two SRAM outputs together. The simulator caught it as a bus fight. Fix: during RESET the pipeline outputs are off,
   and resistor packs pull every control line to "disabled".
4. **QT loads from the A latch's output** (the old A). The microcode never loads A and QT in the same cycle (checked).
5. **A new backplane line, ABORT.** When the Memory card's address check faults a cycle, the microsim abandons the cycle
   before anything loads. The first chip-level run on random programs caught the card loading anyway. So the Memory
   card now drives ABORT and every card's clock enables respect it; on this card that's one OR chip, plus moving link/QT
   into a register with a clock enable. `backplane.js` has the pin.
6. **ALU_FN_SRC is a dead microword field.** No microcode word sets it, so its bit can be reclaimed.

## The flags block (added the same day)
- **Sign detector:** three tryte-sign tables read the bus and feed a flag table, which computes the eight FLAGS rules.
  Whenever the bus is otherwise idle the ALU card drives it, so the detector always sees the ALU result: 8 microcode
  words set ARITH flags with BUS = NONE.
- **Final select:** a 4:1 select takes the table, the shadow (PSW ENTER) or the bus's low trits (IRET RESTORE).
- **Registers:** one 18-bit register holds SF CF OF and the shadow copy taken on the FETCH/FETCH2 words. The shadow's
  load is decided at ROM time from the word's address.
- **ESRV:** the exception status value goes onto the bus through two switch chips. PRIV and IE come from the Control
  card, so the backplane gets an IE line next to PRIV.
- The test no longer feeds CF in. It compares SF, CF, OF and the shadow every cycle.

## Results (`RESULTS-alu-card.jsonl`)
| workload | microcycles | card drove the bus | mismatches |
| --- | ---: | ---: | ---: |
| 120 random programs (all opcodes, traps, interrupts; 29 machine power-ups) | 400,000 | 62,679 | **0** |
| Desktop 1.1.2 boot | 600,000 | 143,959 | **0** |
| TritOS 2.1 session + self-host start | 600,000 | 80,022 | **0** |
| directed big-operand MUL/DIV/MOD/shift/TUNARY | 37,543 | 9,307 | **0** |
| directed fetch-fault probe (flags change right before a faulting fetch) | 63 | 8 | **0** |

Every shift option the card builds, every function, broadcast, negate-by-QT, WIDTH9 and ABORT were all exercised.

All rows above were rerun with the flags block in place; flags and shadow were compared every cycle.

**Positive controls: 10 of 10 caught.**
- **Datapath:** carry skipping a slice; one trit's rails swapped; link used where carry belongs; broadcast taken from
  slice 1; L9 wired as L8; QT taken from the wrong trit.
- **Flags:** tryte signs swapped into the flag table; PRIV and IE swapped in ESRV; IRET restore reading the wrong trits;
  the shadow loading every cycle.

FILL_LINK_FOR_CARRY is caught only by the directed big-operand workload. A first flags mutant, "shadow gated by ABORT",
turned out to be *equivalent*: the shadow only loads on FETCH/FETCH2, which never touch memory, so they never abort. It
was replaced, and the note in the netlist was corrected.

See `RESULTS-alu-card.jsonl`. Positive controls are deliberate wiring mistakes:
- the carry chain skipping a slice;
- one trit's rails swapped into the shifter;
- link used where carry belongs;
- broadcast taken from slice 1;
- L9 wired as L8;
- QT taken from the wrong trit.

Each one must make the test fail.
