# Triton card computer: parts selection, first pass
**Kehai Interim, 2026-11-18.** It follows from TIMING-BUDGET.md and the RAM decision (3^15 trytes). Prices are
distributor listings checked 2026-11-18 at quantity 1–10. They are planning numbers, not quotes. Everything runs at
**3.3 V**.

## Decisions

1. **Logic family: 74LVC.** 3.3 V, 5 V-tolerant inputs, and worst-case delays already used in the timing budget:
   - 74LVC245A transceiver: 6.3 ns max;
   - 74LVC574A flip-flop: 7.0 ns clock-to-Q, 2 ns setup;
   - **74LVC157A 2:1 mux: 5.2 ns max at 3.3 V** (TI). The budget had estimated 6 ns, so it improves slightly.
2. **The rule (Kham, 2026-11-18): no bits faked by software on a chip.** Binary *parts* are fine; Setun used them too
   (two magnetic cores per trit). What's not allowed is a programmed processor on the card standing in for any part of
   the machine. So **no microcontroller anywhere on the card computer.** (An earlier draft of this file had an RP2350B
   doing the loading and the I/O; that's dropped.)
   - Things that stay binary *material*, and are named as such: dual-rail trit wires; truth tables in SRAM (ALU, dispatch);
     the binary-addressed microsequencer; the dense address conversion at the RAM's doorstep.
   - Peripherals with their own controllers inside (an SD card, a PS/2 keyboard) are off-card devices, like Setun's
     teletype. They store and send bytes; they don't compute for the CPU.
3. **Power-up loader: a copy engine, no program.** (Revised 2026-11-19; full design in `cards/COPY-ENGINE.md`.)
   - The real tables are about 12 MB, not the ~534 KB first planned, so the flash is two **Infineon S70GL02GS**
     (2 Gbit, ×16, 3.3 V parallel NOR). About 21.5M load entries, ~344 MB of images; entry bit 24 picks the chip.
   - The engine is about 25 chips on the I/O card: 8× 74LVC161 counter (low 4 bits = phase), 7× 74LVC16823 latches
     (six words drive 96 engine lines, one word holds flags WE/SHIFT/SDATA/END), a '138 phase decode, registered strobes.
   - Delivery is a **resistor-coupled load bus**: in LOAD every table-net driver lets go; nets that are already
     backplane lines (the 96 "engine lines": D wires, UA, PORT, RSLOT, status…) are driven directly, the rest get a
     10k resistor to an on-card LDB line through a CBTLV16211 switch that's open at run time.
   - Chip select is serial: 16 bits into 2× 74LV164 per card (TI SN74LV164A; there is no LVC164) (LOAD_SEL0 data, LOAD_SEL1 clock; bits 0–6 chip,
     7–9 card), a '138 tree, then the LOAD_WE strobe. LOAD_SEL2 is spare.
   - Boot is ~43 s at 8 MHz ECLK. The CPU is held in reset until END. New microcode means reflashing off-machine.
   - The SST39SF040 plan below (§ sourcing notes) is superseded; kept for the record.
4. **Every lookup table lives in 10 ns SRAM,** loaded at power-up.

## Major parts by card (counts are first estimates)

| Card | Part | Qty | Unit price | Notes |
| --- | --- | --- | --- | --- |
| ALU | ISSI IS61WV5128EDBLL-10TLI (512K×8, 10 ns) | 9 | ~$3–6 | one per 3-trit slice; image `alu.bin`, negation folded in |
| ALU | 74LVC574A | ~14 | <$1 | A and B latches, 54 bits each |
| ALU | 74CBTLV3253 + 74CBTLV3245-class FET bus switches, 74LVC153 fill | ~36 | <$1 | SHIFTER.md: measured option mix; L3/R3 dropped |
| Control | IS61WV5128EDBLL or smaller 10 ns SRAM | 9 | ~$3–6 | control store: 9 × 1K used of each chip (microword = 72 bits) |
| Control | 10 ns SRAM | 2 | ~$3 | dispatch table (`dispatch.bin`) |
| Control | 74LVC574A | ~12 | <$1 | microword pipeline register (72 bits), IR, flags |
| Control | 74LVC157A / '161 | ~10 | <$1 | next-address select, micro-loop counter, condition select |
| Registers | 10 ns SRAM (e.g. IS61WV1288EEBLL 128K×8) | 7 | ~$3 | register RAM, 54 bits wide (R0–R8, SP, 16 SPRs, temporaries) |
| Memory | ISSI IS61WV204816BLL-10TLI (2M×16, 10 ns) + IS61WV20488FBLL-10 (2M×8, 10 ns) per row | 3 rows = 6 (3^14), 8 rows = 16 (3^15) | ~$21–26 (×16); ×8 price to check | one tryte = 18 dual-rail bits per row (cards/MEMORY-CARD.md, stage 2) |
| Memory | ISSI IS61WV51216EDBLL-10 (512K×16, 10 ns) | 2 | price to check | framebuffer: VRAM-C (CPU) and VRAM-S (scan-out copy, J2 to the Video card) |
| Memory | 10 ns SRAM (IS61WV5128) | 5 | | address conversion: one level of per-chunk tables, no adder |
| Memory | the rest of the card | | | 241 parts in all at 3^14 (cards/memory-card.js `bom()`): 65 table SRAMs, 21 × 16823, 63 × '153, 27 × CBTLV3253, 20 × '245, 17 × '157, 9 × LVC11, glue and resistor networks |
| I/O | bare ports: 74LVC595/165 shift registers, latches, step-timer counters, SD socket, PS/2 jack | ~10–15 | <$1 each | **the CPU runs its own drivers** (SD over SPI, bit by bit; PS/2 shifts in on the keyboard clock and raises an IRQ). No DMA; needs a "bare ports" device model in microsim + emulator |
| I/O | port bridge: IS61WV25616-class 256K×16 (T→B) + 64K×24 of SRAM (B→T), 10 ns | 2–4 | ~$3–6 | the one place trits become bits for binary devices; tables loaded by the copy engine |
| Video | 2 × fast SRAM, timing counters, resistor DAC | ~20–30 | | option B from the doc; unchanged |
| Front panel | ON-OFF-ON toggles, bi-colour LEDs, step button | | | unchanged |
| Backplane | **DIN 41612 160-pin (5-row)**, 3U Eurocard; ~105 signals + 32 GND + 16 power (BACKPLANE-PINOUT.md) | 1 per card | ~$4.33 (LCSC, TE 384299-E) | 96 pins couldn't fit the 54-wire bus plus control; the microword is distributed (only the 10-bit micro-address crosses) |
| Control store | 1K-entry-or-larger 10 ns SRAM, **15 chips spread over the cards** (was 9 on one card) | 15 | ~$1–3 | each card holds its own fields; see BACKPLANE-PINOUT.md |

**Rough memory and table cost:**
- 9 + 9 + 2 + 7 ≈ **27 fast SRAMs for tables and registers**, about $100–150;
- the main RAM: about $130–160 staged, or $340–420 full;
- logic chips: tens of dollars.

That's before PCBs, which Testsuo's recon covers.

## Open design items (they decide chip counts, not feasibility)

1. **The shifter: measured and sized** (`SHIFTER.md`).
   - L3/R3 are never used, so they're dropped (codes reserved, ROMs unchanged).
   - The remaining distances are 0, 1 and 9, plus a fill selector on the end trit.
   - Build: 74CBTLV3253 FET bus switches (0.15 ns data path) plus 8-bit switches for L9: **~36 chips, no speed cost.**
2. **Dense address conversion.** Three 5-trit groups → binary partials → a 3-input 24-bit binary adder. The timing
   budget assumed 25 ns. Pick the adder: lookup tables in 10 ns SRAM (carry-save), or a fast adder family.
3. **Register RAM width and ports.** One port, 54 bits. Check that every register access the microcode makes fits a
   single port per microcycle. The microsim already enforces this (one `RF_SEL` per word), so it should hold.
4. **The carry-stretch decode** (TIMING-BUDGET.md): a few gates on ALU_FN and BUS/FLAGS feeding the clock generator.
5. **Copy-engine timing and verification:** a readback-compare pass after loading (counters again, plus a comparator)
   would catch a bad flash before the CPU starts.
6. **Bare-ports I/O model:** new device mode for the microsim and a matching spec for the Triton emulator, so the
   differential tests keep working; TritOS gets SD and PS/2 drivers written in ternary code.

## Sources
- TI SN74LVC245A, SN74LVC574A-Q1, SN74LVC157A datasheets; Philips/Nexperia 74LVC574A
- ISSI IS61WV5128EDBLL, IS61WV1288EEBLL, IS61WV204816BLL (DigiKey listings, 2026-11-18)
- Microchip SST39LF040/VF040 status (DigiKey: "Obsolete and no longer manufactured" for SST39LF040-45; Arrow lists
  SST39VF040-70-4I-WHE as obsolete)
- Microchip SST39SF040 (Arrow: SST39SF040-70-4C-NHE-T active; Microchip Direct lists PLCC -55 variant active)
