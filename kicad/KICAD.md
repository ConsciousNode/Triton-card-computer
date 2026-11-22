# KiCad: the cards as boards (first placement)
**Kehai Interim, 2026-11-22, early morning.** KiCad 7.0.11 (Ubuntu's package, with its official footprint libraries)
builds every card of the integrated netlist as a real `.kicad_pcb`.

## The pipeline
- `export-netlist.js <Card>`: one card from `integration/integrate.js compose()` as JSON (chips, pins, nets).
- `pinouts.py`: every part's KiCad footprint and package pin numbers, with the source of each.
- `build_card.py <json> <out> [height]`: the board.
  - A Eurocard outline (3U = 160 × 100 mm, 6U = 160 × 233.35 mm), 4 copper layers.
  - The **160-pin DIN 41612 connector** (z a b c d × 32), generated because KiCad's library has no 5-row part. Pins
    are named z1..d32 from `BACKPLANE-PINOUT.md`, and power and every backplane signal the card uses are connected.
  - Every chip on its footprint, with a 100 nF 0603 decoupling capacitor beside each IC.
  - Placement: same-sized parts together, shelf-packed, onto the back side when the front is full.
  - It writes the board, `-look.svg/.png` (pads, outlines, references and every unrouted connection; `LOOK_SIDE=B`
    draws the back) and `-stats.json`.
  - KiCad's own `kicad-cli pcb export svg` loads and plots the files.

## First results
| card | board | chips | nets | connections to route | front / back |
| --- | --- | ---: | ---: | ---: | --- |
| Registers | 3U | 20 | 141 | 198 | 20 / 0 |
| ALU | 6U | 97 | 470 | 1,227 | 97 / 0 |
| Control | 6U | 129 | 690 | 1,376 | 129 / 0 |
| Memory | 6U | 241 | 1,081 | 2,777 | 102 / 139 |
| Video | 6U | 103 | 636 | 1,082 | 103 / 0 |
| IO | 6U | 70 | 359 | 716 | 70 / 0 |

**The machine is 6U** (the 3U-vs-6U question in INTEGRATION-PLAN). Footprint area alone, before any routing room, as
a share of one side of a 3U board:
- Registers 19%, IO 52%, ALU 68%, Video 92%, Control 115%, Memory 208%.
- On 6U: Memory 89% of one side, so it is two-sided.
- Dense 4-layer logic usually wants about twice its footprint area, and the copy engine's load path isn't placed yet
  (up to 27 chips and 65 resistor networks more per card).
- So: Registers could stay 3U; everything else is 6U.

## Gates before anything is fabricated
1. **Pinouts, pin by pin against the vendor drawing.** Status in `pinouts.py`:
   - from the vendor pin tables, cross-read: ALVCH16823 (TI + Nexperia), IS61WV51216, IS61WV20488, CBTLV3253/3245/3257,
     LV8154;
   - derived from two ISSI excerpts: IS61WV5128;
   - JEDEC 74-series from memory: '04 '07 '08 '11 '32 '74 '86 '125 '138 '153 '157 '161 '164 '165 '244 '245 '574,
     CD4060, 1G07;
   - **PROVISIONAL, must be redone from the drawing: IS61WV204816 (48-pin TSOP-I, 3 chips on Memory).**
2. The **copy engine's load path** (loadpath.js: '125s, '138s, '164s, '16211s, RLINK8 networks) isn't in these
   boards yet: they are built from `compose()` without LOADPATH.
3. A real placement (by signal flow, not by size), then routing (Freerouting via Specctra DSN), then DRC.
4. The 160-pin connector footprint is generated: check it against a real part (e.g. a VME64x J1 style DIN 41612
   type C 160, male right-angle) before fab.
