# Triton-card-computer
A ConsciousNode SoftWorks approach to Balanced Ternary Computing hardware.

A balanced-ternary computer built from stock discrete logic: six cards on a backplane, meant to run
[Triton 4](https://github.com/ConsciousNode/Triton) and TritOS Desktop. Every card is specified as a
chip-by-chip netlist and checked cycle by cycle against a reference microcode simulator, which is itself checked
against the Triton emulator.

**Status (2026-11-20):** design and simulation. All six cards pass their regression tests with 0 mismatches, and
the I/O card's serial console prints its first words. Integrating the cards into one machine has started
(`integration/`). Nothing has been built on a bench yet.

## What "ternary" means here
- **Trits are dual-rail:** each trit travels on two binary wires (+ and −), and one of the four combinations is
  never used. That's the same trick Setun used with pairs of ferrite cores, and the same as most ternary hardware
  ever built. Truly three-level devices are still a research frontier.
- **The ternary is in the machine's structure, not in a program.** Arithmetic and decoding are done by wiring and
  by lookup tables held in SRAM. There's **no microcontroller, no FPGA, and no firmware** pretending to be ternary
  anywhere in the machine. Binary parts are used the way Setun used them, as building blocks.
- You can put a probe on a register's two wires and read a trit.

## The cards
Named after the ConsciousNode crew:

| Card | Name | Job |
| --- | --- | --- |
| I/O | Kehai | serial console, timer and real-time clock, SD card, keyboard, ports |
| Video | Komo | framebuffer and display scan-out |
| ALU | Testsuo | arithmetic, shifts, flags |
| Registers | Ren | register file |
| Control | Ed | microsequencer and control store |
| Memory | Vael | main memory |

Front panel: the **KERK panel**. The boot self-test is the **Power On Operational Precheck**; a good boot prints `POOP OK`.

## Layout
- `cards/`: each card's netlist (`*-card.js`), its tables, and its test against the microsim (`*-card-test.js`).
  `netlist.js` and `parts.js` are the part-level simulator; parts carry real part numbers (see `PARTS.md`).
- `microsim/`: the reference microcode simulator, ROMs and bare-metal drivers.
- `integration/`: the backplane check (reads every card's netlist at once) and its findings.
- `roms/`: control-store and table images.
- `handheld/`: early ideas for a ternary handheld.
- `NOTES.md`: the working log, kept as written, including superseded plans.
- Design docs: `BACKPLANE-PINOUT.md`, `CONTROL-SIGNALS.md`, `INTEGRATION-PLAN.md`, `PARTS.md`, `TIMING-BUDGET.md`,
  `SHIFTER.md`, `TRITON-4-STORAGE-TIME.md`, `PRIOR-ART.md`, `PCB-PRICING-RECON-testsuo.md`.

## Running the tests
Needs Node.js and a checkout of [ConsciousNode/Triton](https://github.com/ConsciousNode/Triton) next to this repo
(`../Triton`), or set `TRITON_DIR`. The tests compare each card against the Triton reference.

```
cd cards
node alu-card-test.js directed
node control-card-test.js directed
node io-ports-test.js console
```

Each test also has deliberately broken variants ("mutants") that the test must catch.

## Prior art and neighbors
- **Setun** (Moscow State University, 1958) and **Setun-70**: the ternary machines this design descends from.
- **5500FP** by Claudio Lorenzo La Rosa: a 24-trit balanced-ternary RISC processor on an FPGA (2026). It's the
  modern, fast path; this repo is the fixed-discrete-hardware path. Different answers, both worth having.
- See `PRIOR-ART.md` for more.

## License
MIT, see `LICENSE`.
