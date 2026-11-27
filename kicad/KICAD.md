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
| Video | 6 | 103 | 0 open | 12,369 | 2,561 | 44.4 m | 0 errors (FC0 by `local_reroute.py`, below) |
| Control | 6 | 129 (35 on the back) | 0 open (COL_FILL=0.85) | 25,241 | 3,097 | 68.7 m | 0 errors (IM2 by `local_reroute.py`, below) |
| Memory | 6 | 241 (108 on the back), SMD networks | **not routed yet** (placed, fanned out) | | | | |

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

- **Video** (built before COL_FILL; one-sided): Freerouting took 8 h 14 min plus optimising and left one connection
  open, FC0, a 30 mm gap from a stub at (31.8, 84.1) to U43 pin 5. `local_reroute.py --norip --nets=FC0` threaded it
  through free space without ripping anything: all on one layer, no vias, a 0.05 mm-grid staircase (266 small
  segments, legal but not pretty; worth a hand clean-up in the GUI some day). Three dangling GND/+3V3 router crumbs
  were deleted. KiCad DRC: 0 copper errors, 0 unconnected pads.

- **Control:** Freerouting took 12 h 47 min plus 2 h 41 min optimising and left 3 open. `local_reroute --norip` joined
  CW_PCC+ and UN4. **IM2 is still open**: U89 pin 13 sits on the back face, boxed in, 57 mm from the rest of its net.
  - The grid router finds a path only with rip-up, and then its join stubs at clipped minimum-pitch bus ends land inside
    a neighbour's clearance (8 errors). With exact join checks (`stub_clear`), every net order fails.
  - Two Freerouting finishing passes were killed by cloud-environment restarts (4.7 h in, then 45 min).
  - Also left: one 0.118 mm clearance (IR0_7+ via near CEN on In3) and dangling GND/+3V3 crumbs. Both are fixable the
    way the ALU's were.
- **Control, finished (2026-11-24):** a third Freerouting pass (`finish_card.py`, 7 h 28 min plus optimising, 9 h
  in all) still left IM2 open, so the pin really is boxed in. What closed it: `local_reroute.py` with
  `GRID_MM=0.025`, a wider rip-up (65..80 x 206..219 mm, 30 nets) and the exact join check. It went through net
  orders until one fit (TRAPDIV0_N, IP0, IM1_N, IM2_N, IM4_N, IM3 first): 0 unrouted, no new clearance errors.
  Then:
  - `prune_dangling.py` removed 14 dead stubs. A first version matched only exact endpoints and pruned 2 real
    connections (nm-off joins, T-junctions); it now counts an end on any same-net track's copper as connected.
  - The IR0_7+ via near CEN (0.118 mm against 0.15) is 0.5/0.25 mm, the fanout's via size, which gains 0.05 mm.
  - Eight GND/+3V3 router crumbs were deleted.

  KiCad DRC: 0 copper errors, 0 unconnected pads.
- A lesson about this workspace: background jobs live only while a reply is open, and the environment can restart
  between turns. Long runs need the turn kept open, with every result committed as it lands.
- **Memory:** placed two-sided with SMD resistor networks, 2,467 power pads fanned out. Freerouting was ~19 h into a
  30-pass run when the environment restarted, and a 10-pass rerun died in the next restart 45 minutes later. It needs
  one long uninterrupted run. A third attempt (10 passes, 2026-11-24) reached ~18.5 h of routing, still in its first
  stage, before another environment restart ended it. So even at 10 passes it needs more than a day here. Options:
  - run it where nothing restarts, e.g. Freerouting on a home machine with `out/Memory-6U.dsn`: open the DSN, route,
    save the .ses; then `REUSE_SES=1 route_card.py` imports it;
  - or a scripted bus router for its regular SRAM rows first, so Freerouting only finishes the rest.
- **Memory on a home machine (2026-11-24, from 21:38 ET):** Freerouting **2.5.0** (Windows installer, Java bundled)
  on Kham's laptop: 4 cores and ~900 MB for Java. It opened `out/Memory-6U.dsn` and started routing.
  - 2.5.0 runs a fanout stage first. Of 7,274 SMD pins, 6,224 needed one; ~20 pins a minute in pass 1.
  - It reported **970 "unfixable" clearance violations**, all GND via against GND via. The cause: the power fanout
    lets same-net vias sit at the hole-to-hole limit (2 x 0.125 + 0.25 = 0.5 mm centre to centre). With 0.5 mm vias,
    that's copper touching copper. The DSN has 81 such pairs; Freerouting counts each pair on every layer, in both
    directions (81 x 6 x 2 = 972). Same net, so it's electrically harmless, and KiCad passes it (the other five
    boards have the same rule). Freerouting just routes around them.
  - Left as is: `REUSE_SES` re-runs the fanout and must rebuild exactly the vias the session was routed against.
    For the next board: give same-net vias 2 x VR + CL as well, or reuse a same-net via within ~0.6 mm.

- **Memory: SRAM pin swaps (2026-11-27).** On an async SRAM, which address pin a signal reaches is free, and so is which
  data pin, as long as anything stored in the chip is laid out to match. The builder wired every SRAM in index order, so
  signals cross over each other to reach "their" pin.
  - `pin_swap.py` chooses a swap for each of the card's 65 **lookup tables** (SRAMs with /WE tied high) from the placed
    board: each pin group (address, data) is an exact assignment problem (Hungarian), cost = Manhattan distance from the
    pad to the nearest pad of that net on another part, 4 sweeps. Pins tied to GND move too. Control pins, power and NC
    stay put. RAM and framebuffer chips are left alone: swaps there are free in hardware, but the harnesses load and
    audit them by address.
  - `cards/netlist.js` applies a swap file (`PINSWAP=kicad/pinswap-Memory.json`) when a card is built: pins move and the
    table's image is laid out to match (new address bit k = old bit perm[k], same for data), sized to the highest
    address pin that carries a signal. `PINSWAP_NOREMAP=1` moves the pins and leaves the image: the positive control.
  - `apply_pin_swap.py` re-nets the placed board from the swapped netlist (`PINSWAP=... export-netlist.js Memory`, the
    same netlist the tests ran) and checks every pad of every chip against it: 1,192 SRAM pads re-netted, 0 pads
    disagree. Placement is unchanged. `route_card.py` with `DSN_ONLY=1` then writes `out/Memory-6U-pinswap.dsn` (same
    power fanout: 2,467 pads to plane vias) for routing elsewhere.
  - **What it buys (measured on the placement):** airwire length (MST per signal net, Manhattan) 120,553 -> 117,269 mm
    (2.7% shorter); airwire crossings 98,477 -> 94,195 (4.3% fewer). Modest: most of the length is long bus nets
    between far-apart chips, which no pin order can shorten. Whether Freerouting finishes faster is untested; that
    needs a run on the home machine.
  - **Tests with the swap** (`RESULTS-memory-card.jsonl` lines with a `pinswap` field): all seven directed workloads
    (directed, fetchfault, irqbm, spr, bcfault, prot, fb) and random 100,000 microcycles: 0 mismatches, with the same
    bus-drive counts as without it. NOREMAP control: 24 mismatches in the first 20 microcycles. Mutants
    SNOOP_WRONG_SLOT and CHK3_USES_SINGLE are still caught by `prot` at the same cycles as before. Whole machine,
    `program-lockstep.js` directed: 57 instructions, 740 microcycles, match.
  - **Not adopted as the default yet.** Without `PINSWAP` everything builds as before. Adopting it (if the swapped
    board routes better) means: make the swap file the default in `netlist.js`, regenerate the table ROM manifest
    (`integration/roms-cards.js export`), and rerun the card and machine suites.

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
