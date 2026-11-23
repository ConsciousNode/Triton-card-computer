# KiCad: the cards as boards
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

## Routing (2026-11-22, the day after)
- `route_card.py <board> <freerouting.jar> [passes]`:
  - **6 layers**: F (signal) / In1 GND plane / In2, In3 (signal) / In4 +3V3 plane / B (signal). The planes are POWER
    layers, so the router only drops vias into them. Rules: 0.15 mm tracks and clearance, 0.6/0.3 mm vias.
  - **Power fanout before routing.** Every GND/+3V3 pad gets a locked stub and a 0.5/0.25 mm via into its plane, so the
    router sees fixed copper and routes only signals. Each candidate via spot is checked against every other-net pad,
    via and stub by the board's rules. The search order is out along the pad's long axis, then the diagonals,
    sideways, and finally **inward under the package body** (the 0.5 mm-pitch TSSOP-56s need that); a pad with no
    clean spot is joined to the nearest same-net fanout via.
  - DSN, then **Freerouting 1.9.0** headless under `xvfb-run` (2.1.0 ignored every stop setting), then my own SES
    reader (KiCad 7's importer works only in the GUI), zone fill, `-routed.kicad_pcb`, and an unrouted count.
- `build_card.py` changes found by routing:
  - decoupling caps turn 90°/270° so each pad faces its own net's pin (the SRAMs had GND beside +3V3);
  - caps belong to the chip they were made for, not the nearest one;
  - `COL_FILL` caps how full a column gets (below).
- `render_routed.py`: the coloured-layer picture. `finish_card.py`: a second Freerouting pass on a routed board.
  `patch_power.py`, `local_reroute.py` (grid A*), `local_freeroute.py`: local repair tools. See the ALU entry for how
  far they got.

| card | layers | chips | routed | track segments | vias | copper | DRC (copper) |
| --- | --- | ---: | --- | ---: | ---: | ---: | --- |
| Registers | 6 | 20 | 0 open | 1,544 | 353 | 8.6 m | 0 errors |
| IO | 6 | 70 | 0 open | 7,454 | 1,380 | 29.0 m | 0 errors (2 hand touches, below) |
| ALU | 6 | 97 | 0 open (COL_FILL=0.85) | 14,537 | 2,167 | 51.0 m | 0 errors (2 hand touches, below) |
| Video | 6 | 103 | routing | | | | |

Remaining DRC findings are silkscreen-only (silk over copper, overlapping reference text), plus "footprint not in the
project library" notes from running headless.

**Found on the way:**
- **The ALU had two chips called U120**: an ESRV CBTLV3245 and the stretch '04. The simulator keeps chips in a list,
  so both were always simulated. KiCad's DSN export failed silently on the duplicate. The '04 is U122 now, and
  `netlist.add` refuses a duplicate designator; the whole machine composes under that rule (670 chips, 670 names).
  `alu-card-test` was rerun after the rename: TritOS Desktop lockstep, 2,835,861 microcycles, 0 mismatches.
- **I/O hand touches:**
  - a 0.5 mm stray GND stub left by the router was deleted;
  - one D5+ signal via between two tracks measured 0.1489 mm against the 0.15 rule (the session file's 0.1 µm
    rounding), so that one via is 0.59 mm instead of 0.60 (0.145 mm ring on the 0.3 mm drill).
- **ALU, one open connection** (R13+, U84 pin 5 to U83 pin 6). It survived:
  - the first 30-pass route;
  - a 10-pass second Freerouting pass (`finish_card.py`, 1 h 15 min plus 36 min optimising);
  - my grid router (`local_reroute.py`), with rip-up windows of 17, 23 and 8 nets: two nets always competed for one
    squeeze point, and clipped minimum-pitch bus ends were hard for a 0.05 mm grid to leave;
  - `local_freeroute.py`, which locks everything outside the window: Freerouting stalled after "normalization of net
    failed" warnings and was stopped.

  The cause was upstream. The placer filled each column to the board's full height at the 1 mm minimum gap, so the
  two chips sat 1.5 mm apart pad to pad. `COL_FILL=0.85` lets a column take only 85% of the height: the ALU gets 6
  columns, the tightest gap is 2.74 mm, and the straight-line wire total drops (45.3 m to 41.9 m). The default stays
  1.0, so the Registers and IO boards rebuild exactly as routed. **Rerouted with it: 0 open on the first try**
  (2 h 34 min routing plus optimising).
- **ALU hand touches:**
  - six dangling router fragments of GND/+3V3 (the planes carry power) were deleted;
  - one BS24+ via was 0.089 mm from a C8- track on In2 (a real shortfall, not rounding). It was moved 0.08 mm, with
    its two tracks, to the first spot that my own geometry check cleared; KiCad's DRC confirmed it.

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
3. ~~A real placement, then routing, then DRC~~: done for Registers and IO (above); ALU, Video, Control and Memory
   in progress. Placement is quadratic (by connectivity) + columns + annealing, no longer by size.
4. The 160-pin connector footprint is generated: check it against a real part (e.g. a VME64x J1 style DIN 41612
   type C 160, male right-angle) before fab.
