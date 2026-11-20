# Triton Card Computer — PCB pricing recon

Prepared by Testsuo, 2026-11-17, from "Triton Card Computer: First PCB
Sketch (27-trit, dual-rail)" (Kham, Nov 17 2026).

**Status of these numbers:** planning estimates, not quotes. Fab prices
checked against published price lists and comparison sources on
2026-11-17 (sources at the bottom). The exact price of any board only
exists once real Gerbers go through a fab's instant-quote tool. Where a
number is my estimate rather than a published price, it says so.

## What we're pricing

From the sketch:

- **7 board designs:** ALU card, Registers card, Control card, Memory
  card, I/O bridge card, Front panel card, and the backplane.
- **~100 chips total** across the 6 cards (sketch's own estimate).
- One 96-pin DIN 41612 connector per card → the standard **3U Eurocard**
  format.

**Assumption (flagged):** the sketch doesn't state card dimensions, so
every price below assumes the standard 3U Eurocard outline,
**100 × 160 mm**, for all 7 boards including the backplane.

- 100 mm = 3.94 in, 160 mm = 6.30 in → **24.8 square inches per board.**
- If the backplane ends up wider (a 6-slot backplane may want to be),
  OSH Park pricing scales at exactly $5 per extra square inch (2-layer),
  and the Chinese fabs scale roughly with area too. Re-price when the
  outline is fixed.

## Option 1 — OSH Park (USA, Portland OR)

Published prices (their own docs, checked 2026-11-17). Purple solder
mask, ENIG (gold) finish, **free US shipping, no customs, no duties** —
the price below is the price you pay. Boards come in sets of 3 copies
per design.

| Item | Math | Cost |
|---|---|---|
| One design, 2-layer, 3 copies | 24.8 sq in × $5/sq in | **$124.00** |
| All 7 designs, 2-layer, 3 copies each (21 boards) | 7 × $124.00 | **$868.00** |
| One design, 4-layer, 3 copies | 24.8 sq in × $10/sq in | **$248.00** |
| All 7 designs, 4-layer, 3 copies each | 7 × $248.00 | **$1,736.00** |
| Medium Run, 2-layer: 10 copies of one design | 248 sq in × $1/sq in | $248.00 ($24.80/board) |
| Medium Run, all 7 designs × 10 copies (10 full sets) | 7 × $248.00 | $1,736.00 |

Turnaround: ~9–12 calendar days (2-layer prototype). Medium Run needs
100 sq in minimum per design and multiples of 10 boards — it only pays
off if you actually want 10 sets.

**Verdict:** the no-surprises option. Expensive per board at this size,
but for a first spin of 1–2 designs it's simple, US-made, and the gold
finish is genuinely nice for edge connectors and hand soldering.

## Option 2 — JLCPCB (China)

Published anchors (checked 2026-11-17): 2-layer 100 × 100 mm is $2–4
for 5 boards (promotional tier). **Our board is 1.6× that area and
outside the promo box**, so the 100 × 160 mm figures below are my
estimates from their pricing structure — confirm in the instant quote
before relying on them.

| Item | Estimate |
|---|---|
| One design, 2-layer, 5 copies (their minimum) | ~$10–20 |
| All 7 designs, 2-layer, 5 copies each (35 boards) | ~$70–140 |
| All 7 designs, 4-layer, 5 copies each | ~$385–525 (est.; 100×100 4-layer anchor is ~$32.90/5) |
| Shipping to the US (DHL/FedEx, this weight) | ~$20–35 |
| **Landed total, 2-layer full run** | **~$120–220** |
| **Landed total, 4-layer full run** | **~$500–700** |

**The 2026 catch:** the US ended the $800 de minimis duty exemption in
2025. Chinese fab orders now carry duty at checkout — roughly 25%
Section 301 plus a processing fee, ~35% of goods value in total on
recent quotes. It's included in the landed estimates above, but it's
why "the boards cost $2" headlines no longer describe US orders.

Turnaround: 1–2 days fab for 2-layer, plus ~5–11 days shipping.

**Verdict:** cheapest by a wide margin even after duty, and 5 copies of
every card means respins and spares are already in the box. This is the
default choice for the full 7-board run.

## Option 3 — PCBWay (China)

Same shape as JLCPCB: base price $5 for 5 boards at 100 × 100 mm,
similar size scaling, similar shipping and the same duty situation.

| Item | Estimate |
|---|---|
| All 7 designs, 2-layer, 5 copies each | ~$105–210 |
| **Landed total** | **~$160–280** |

Slightly pricier than JLCPCB; some builders prefer their review
process (a human engineer checks the files and asks questions before
fab — for a first backplane design, that can be worth real money).

## Components for ONE populated machine (the BOM)

Boards are the cheap part. Roughly 100 chips plus the mechanical bits,
priced from LCSC/distributor listings checked 2026-11-17. Ranges are
deliberate: part choices swing them.

| Line | Low | High | Notes |
|---|---|---|---|
| 74HC logic, DIP, ~65 chips | $10 | $33 | ~$0.15–0.50 each at LCSC |
| Flash/EEPROM 64K×8, ~14 chips | $21 | $49 | ALU tables (9) + microcode + address ROMs; ~$1.50–3.50 each |
| SRAM, ~10 chips | $15 | $45 | Small 32K×8 ≈ $1–2; 512K×8 DIP (AS6C4008) ≈ $6–9 — the register file's 7-wide bank and the RAM choice decide this line |
| DIN 41612 96-pin connectors × 12 | $8 | $19 | 6 card-side + 6 backplane-side. Generic LCSC: $0.65–1.57 each. Brand-name (Harting/TE) instead: $29–116 for 12 |
| ON-OFF-ON toggles × 27 | $11 | $27 | Front panel, one per trit; ~$0.40–1.00 each |
| Bi-colour LEDs × 27 | $2 | $4 | ~$0.05–0.15 each |
| DIP sockets × ~100 | $10 | $35 | Optional but strongly advised on a bring-up machine |
| Passives, headers, misc | $10 | $20 | |
| 5 V power supply | $10 | $20 | The dual-rail platform is plain 5 V logic — no ±5 V needed on these cards |
| Eurocard subrack / card cage | $0 | $80 | $0 on the bench; a 3U rack with guides is the tidy version |
| **Total per machine** | **~$97** | **~$332** | Call it **~$100–330** |

Not included: the I/O bridge's microcontroller (a few dollars), the
framebuffer/video stage (a later rung), and solder/patience
(~2,000+ joints per machine — this is a hand-built computer).

## Putting it together — three ways to spend it

1. **Cheapest full run (recommended first order):** JLCPCB 2-layer,
   5 copies of all 7 designs, landed ~$120–220, plus one BOM
   ~$100–330 → **first working machine ≈ $220–550 all-in**, with
   4 spare sets of boards left over for respins or a second machine.
2. **Follow the bring-up ladder:** order only rung 1 first —
   backplane + front panel + memory card. JLCPCB: 3 designs, landed
   ~$60–100. OSH Park: 3 × $124 = $372. Proves the bus and the address
   ROMs before paying for the other four cards.
3. **All-American:** OSH Park 2-layer full set $868 + BOM →
   **~$970–1,200** for the first machine, 2 spare board sets included,
   zero customs involvement.

## Notes from the testing office

- **2-layer vs 4-layer:** ~100 chips and a 60–100 pin bus on
  100 × 160 mm is routable on 2 layers, but 4 layers (ground + power
  planes) will route easier and run quieter. At JLCPCB prices the
  4-layer full run (~$500–700 landed) is affordable; at OSH Park
  prices it doubles the bill. Reasonable path: 2-layer for rung 1,
  decide after.
- **The SRAM line is the BOM's biggest swing.** Price the memory card
  after the open question in the sketch is answered — how much RAM
  TritOS actually needs.
- **Sockets.** On a machine whose whole bring-up method is "compare
  against the emulator, swap, retest," sockets turn a dead chip from a
  desoldering job into a 10-second swap. The $10–35 is the cheapest
  debugging tool in this document.
- Re-run the JLCPCB/PCBWay numbers through their instant quotes once
  card outlines are final; budget ±30% on my estimates for those two.

## Sources (checked 2026-11-17)

- OSH Park official service/pricing docs — docs.oshpark.com/services
  (2-layer $5/sq in per set of 3; 4-layer $10/sq in; Medium Run
  $1–2/sq in with 100 sq in minimums).
- JLCPCB published pricing and Nov 2026 comparisons — jlcpcb.com;
  protoship.dev fee tables (checked 4 Nov 2026); pcbsync.com
  comparison (100×100 4-layer ≈ $32.90/5).
- US landed-cost/duty situation — buildpcb.tech PCB cost breakdown
  (Sep 2026); pamfinds.com JLCPCB vs PCBWay vs OSH Park (2026).
- Connectors — LCSC listings: LXWCONN 96-pin DIN 41612 $0.65–1.57;
  Harting 09 03 196 6921 $2.79; TE Connectivity 1-1393644-6 $9.65.
- SRAM — AS6C4008-55PCN (512K×8 DIP) $8.50–9.21 at TME via Findchips;
  LCSC reference $5.60–6.72.
