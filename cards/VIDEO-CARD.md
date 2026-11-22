# The Video card
**Kehai Interim, 2026-11-18.** Stage 1 (the CPU side: ports 2–5, pixel writes and reads over J2, the fill engine) is
drawn and tested chip by chip: `video-card.js`, `video-tables.js`, `video-card-test.js`, `directed-video.js`.
**60 chips.** Stage 2 (scan-out: VGA timing, line buffers, palette, the ternary DAC) is designed below and not yet drawn.

## What the machine asks of it
From `iocard.js` (ports kept by `bareio.js` as "video card registers") and the emulator's `renderDisplay`:

| port | OUT | IN |
| --- | --- | --- |
| 2 | X = w0 mod 729 (T3) or mod 243 (T2) | X |
| 3 | Y = w0 mod 486 (T3) or mod 243 (T2) | Y |
| 4 | pixel at (X, Y): index Y·729 + X (T3) or Y·243 + X (T2), value truncated to 6 trits (T3) or 3 (T2) | that pixel |
| 5 | fill the framebuffer (all 354,294 pixels in T3, the first 59,049 in T2) with the truncated value, and remember it | the remembered value |

- **The picture:** T3 is 729×486 with 6-trit pixels: R = trits 4–5, G = trits 2–3, B = trits 0–1. Each 2-trit "diad"
  is one of 9 even levels.
- **T2** is 243×243 with 3-trit pixels (one trit per channel, levels 28/132/242 of 255), shown 3× wide and 2× tall in
  the same 729×486 area.

## Decisions
1. **The framebuffer is on the Memory card** (Kham's option (a)). This card reaches it over the **J2** ribbon:
   - SA0..18 (VRAM address, in the Memory card's layout);
   - SI0..11 + /SWR (writes);
   - SO0..11 (reads);
   - VBUSY (a CPU write owns VRAM-S this cycle);
   - SCLK (the slot clock, forwarded).
2. **One clock: 40 MHz.** The CPU's 10 MHz (100 ns) clock is that divided by 4. So the Video card works in **25 ns
   slots, 4 per microcycle, phase-locked to the CPU**, and a CPU framebuffer write takes VRAM-S only for its
   write-strobe half: 2 of the 4 slots (4 of 8 in a stretched cycle).
   - The oscillator belongs with the clock generator on the Control card, so SCLK takes one of the backplane's 2
     spare pins.
3. **J2 is pipelined, so it fits a 25 ns slot.** As first drawn, a read went Video SA register → cable → Memory card
   '157 mux → SRAM → '245 → cable → latch ≈ 34 ns. Revised on the Memory card (stage 2 rerun on fb, plus the scan
   mutant):
   - the VRAM-S address mux is now **74CBTLV3257** FET switches (≈0.25 ns);
   - **SO is latched on the Memory card** by SCLK (2 × 74LVC574).
   - So a read is SA in slot t, SO valid in slot t + 1: stage A ≈ 7 + 2 + 0.25 + 10 + 2 = 21 ns, stage B ≈ 7 + 2 + 2
     = 11 ns.
   - A write is SA, SI and /SWR registered together, written during the next slot.
4. **Coordinates are binary, so the address is one table.** The X and Y registers hold the mode's coordinate as a
   binary number.
   - A **pixel address table** (3 × 2M×8, address MODE | Y | X) turns it straight into the Memory card's VRAM address.
   - The **fill counters** walk (X, Y) through the same table.
   - The ternary values the CPU sees go through two small tables at the edges: **coordinate in** (the tryte →
     X mod w) and **coordinate out** (X → the tryte for IN).
5. **Everything waits on IORDY.**
   - A pixel write or read takes 2–3 slots.
   - A fill takes one slot per pixel: 354,294 slots ≈ 8.9 ms with no scan-out. With scan-out taking priority it's
     ≈ 29 ms (327 free slots per line, below).
   - The microsim's stand-in latency is 10 microcycles. This is a real-time difference, like the I/O card's.
   - The harness lets the CPU wait as long as the card needs, and counts the extra cycles.

## Stage 1 as drawn (60 chips)
| block | parts |
| --- | --- |
| own control store + pipeline | IS61WV5128 (IN, OUT, BUS = IO), 16823 (off in RESET), RPACK8 (idle) |
| port decode at the CPU edge | 2 tables: loads for X, Y, pixel, fill colour; start pixel write / fill / pixel read; the answer source; the BUS = IO select latch |
| sequencer | 1 table + 74LVC574 (pixel write pending, read pending, filling, read pipeline R1/R2, /SWR): one J2 operation per free slot |
| coordinates | coordinate-in table (2 × 2M×8), X and Y registers (16823 ×2, the second also holds the BUS = IO select bit), coordinate-out table (3 chips) |
| pixel value / fill colour | 16823 ×2; trits 3–5 gated by MODE (T2 pixels are 3 trits; 2 × 74LVC08) |
| fill counters | 16823 ×2 + 4 next-count tables (wrap at 729/243, 486/243; "last pixel" flag) |
| J2 address and data | 5 × '157 (drawing position or fill counters) → pixel address table (3 × 2M×8) → SA register (16823 ×2); 3 × '157 (pixel or fill colour) → SI register |
| the answer to IN | 9 × '153 (coordinate / fill colour / pixel from SO) → 16823; 7 × '245 onto the bus while BUS = IO and this card was the one asked |
| glue | '04, '32, '08 ×2 |

- **Reset:** /SWR is ORed with RESET, because the tables are garbage while the copy engine loads them.

## Stage 1 test
`video-card-test.js` runs the card beside the microsim, 4 slots per microcycle (the last one is the CPU edge). J2 is
played by the harness the way the Memory card does it: VRAM-S in the declared layout, preset from the machine's
framebuffer, SO one slot after SA, writes at the slot edge, and the CPU's own framebuffer writes landing too, with
VBUSY in their second half.

**Compared:**
- after an IN to ports 2–5, the card drives exactly the microsim's ioData in the BUS = IO cycle, and never otherwise;
- every J2 write:
  - an OUT 4 makes exactly one, at the right pixel with the right value;
  - an OUT 5 makes one per pixel (354,294 or 59,049) and leaves VRAM-S equal to the microsim's framebuffer;
  - nothing at any other time;
- when READY returns, the answer is already in the register and the writes are done;
- a full VRAM-S audit at the end.

**Declared:** registers start at the machine's X, Y and fill colour; the CPU waits on READY as long as the card needs.

`directed-video.js`:
- **T3:**
  - X/Y wrap: 0, 728/485, 729/486, −1, −730/−487, ±9841;
  - OUT 4 with values wider than 6 trits, and IN 4 back;
  - 30 CPU stores into the framebuffer read back through IN 4 (the J2 read path);
  - a fill, then IN 4 / IN 5;
  - a mode switch: X = 700 set in T3, a pixel written in T2.
- **T2:** wraps mod 243, 3-trit pixels, a T2 fill.

| workload | microcycles | extra wait (CPU on IORDY) | card answered BUS = IO | mismatches | what it reached |
| --- | ---: | ---: | ---: | ---: | --- |
| **directed** (2 machines, new) | 6,946 | 103,315 | 178 | 0 | 49 IN 2, 48 IN 3, 79 IN 4, 46 pixel writes, a T3 and a T2 fill, 30 CPU framebuffer writes read back over J2 |
| desktop boot | 300,000 | 88,563 | 0 | 0 | a T3 fill, 5,983 CPU framebuffer writes (VBUSY) |
| TritOS 2.1 boot | 300,000 | 0 | 0 | 0 | 32 T2 pixel writes |
| random (26 machines) | 300,000 | 0 | 0 | 0 | stays off the bus and J2 through everything else |
| fb (Memory card's workload, 7 machines) | 18,875 | 88,563 | 40 | 0 | |
| prot (14 machines) | 32,972 | 0 | 0 | 0 | |
| spr | 53,985 | 0 | 0 | 0 | |

**Total: 1,012,778 microcycles plus 280,441 microcycles of IORDY wait, 0 mismatches.** Both fills, 4 slots per
microcycle: 1,121,764 slot-level settles in the waits alone.

- **The same harness trap the Memory card hit:** desktop first showed 1 "mismatch", in the end-of-run audit, because
  the boot keeps drawing after the 300,000 tracked cycles. The audit now runs where tracking stops; desktop was
  rerun clean.

### Mutants
6 of 6 killed, plus one equivalent mutant kept as a record:

| mutant | what it breaks | killed by | first symptom |
| --- | --- | --- | --- |
| FILL_ONE_PIXEL | the fill stops after the first pixel | directed | fill: 1 J2 write vs 354,294 |
| IN4_NEVER_LOADS | the J2 read never reaches the answer register | directed | IN 4: answer 0 vs 43 when READY returned |
| PA_STRIDE_T2 | pixel address table uses stride 729 in T2 | directed | T2 OUT 4 wrote the wrong VRAM address |
| T2_COORD_729 | T2's X wraps mod 729, not 243 | directed | IN 2 answered 243 vs 0 |
| T2_PIXEL_NOT_MASKED | one rail of trit 5 not cleared in T2 | directed | T2 pixel stored −240 vs 3 |
| READY_IGNORES_FILL | READY returns while the fill is still running | directed | READY back after 43 of 354,294 writes |
| READY_EARLY (equivalent) | READY one slot early on a pixel read | survives, as predicted | BUS = IO comes a whole microcycle (4 slots) later, so it changes nothing, here or on hardware |

## Stage 2: scan-out (drawn and tested, 42 more chips: 102 in all; was estimated 85–90 for the whole card)
The card now paints the screen. Everything below is in `video-card.js` (U70–U119) and `video-tables.js`.

**Blocks as drawn:**
- **Timing (U80–U88):** HC (11 bits, U80) and VC (10 bits, U85) are '16823 registers loading every slot from their
  own next-count tables (U81–U84, U86–U88). The same table words carry HSYNC, VSYNC, the picture flags, the picture
  column XD = HC − 35, the fetch window FWIN (HC < 1053), the fetch row PY = VC − 56 and the two bank bits.
- **Fetch engine (U89–U95, U70–U74):** FXC (the next column to fetch, U89) with its "more to fetch" flag FACT,
  stepped by the U90/U91 tables. FACTV = FACT & FLINE & FWIN; **FNOW = FACTV & FREE** (U92).
  - **Priority:** the SEQ table (U9) now sees FREEOP = FREE & !FACTV, so ports and fill only get the slots the fetch
    doesn't want.
  - In a fetch slot the CO2 mux (U70–U74) feeds (FXC, PY) to the PA tables with **SCREEN = FNOW** as address bit 20.
    T2's 3×2 scaling lives in the table, as planned.
  - F1/F2 (U94/U95) carry (column, bank, valid) down the pipeline, so the pixel is written one slot after SA, when SO
    carries it. The fetch stops at HC 1053 so its tail never spills into the next line.
- **Line buffers (U100–U113):** 2 × IS61WV51216, ping-pong. The bank on display reads at AX; the other is written at
  F2X from SO through '245s (U109–U112). The address muxes and the read mux are switched by the registered display
  bank ADB.
- **Output pipeline (U98, U116–U119):** stage A registers (column, bank, picture, syncs); stage B registers the pixel;
  the palette table (U117/U118) turns the 12 rails + MODE + picture into the 12 DAC drive bits; stage C (U119)
  drives the resistors and the two syncs. **Syncs go through the same 3 stages as the pixels,** so they stay aligned.
- **Not in the netlist:** the 12 DAC resistors and 2 sync resistors (passives, values in the notes below).
- The estimate was 25–30 chips. It came out at 42: the line-buffer muxes and '245s, and the registers that keep every
  output glitch-free, cost more than I guessed.

## Stage 2 test (`video-scan-test.js`)
- **The method:** the whole card runs slot by slot at 40 MHz, J2 played as the Memory card does it (SO one slot after
  SA). All 640,000+ slots are captured: HSYNC, VSYNC and the 12 DAC bits.
- **What the check compares against:** the emulator's `renderDisplay` rules, written independently of the card's
  tables.
  - **Timing:** HSYNC every 1056 slots, 128 wide; VSYNC 4 lines wide.
  - **Picture:** every picture pixel, anchored on the VSYNC edge, against PALETTE_729 (T3) or PALETTE_27 (T2: 3× wide,
    2× tall, values outside −13..13 black) at the nearest of the DAC's 9 levels.
  - **Border:** every slot outside the picture must be black.

**Results:**

| scenario | what | result |
| --- | --- | --- |
| t3 | random T3 picture | 0 mismatches (354,294 pixels + every border slot) |
| t2 | random T2 picture, incl. 500 out-of-range values | 0 mismatches |
| starve | worst-case CPU writes from wr-density.js (176 slots a line, front-loaded) | 0 mismatches |
| fill | an OUT 5 issued mid-picture | 354,294 writes, 0 pixels wrong after, frames before/after correct; **20.2 ms** |
| overload (positive control) | CPU strobes in every half-microcycle, more than any program can make | **fails, as it must:** the first wrong pixel is column 527, exactly where 528 free slots run out |
| desktop | the real framebuffer after the desktop boot (T3, all 354,294 pixels non-zero) | 0 mismatches |
| tritos | the framebuffer after the TritOS 2.1 boot (T2) | 0 mismatches, but a weak test: that boot leaves 1 non-zero pixel |
| t3 rerun | after removing a pointless double inverter (104 → 102 chips) | 0 mismatches |

- **The fill takes 20.2 ms in T3,** inside the 29 ms estimated (the fetch only runs on 486 of the 628 lines).
- The stage-1 directed harness reran with stage 2 inside: 6,946 microcycles + 199,383 wait microcycles, 0
  mismatches. So the fetch taking slots never breaks a port operation.

### Mutants (stage 2)
All 6 killed:

| mutant | what it breaks | killed by |
| --- | --- | --- |
| HSYNC_SHORT | HSYNC one slot short | sync check: width 127 |
| FETCH_ROW_OFF | fetches the row for the current line, not the next | 353,753 pixels wrong |
| BANK_FLIP | writes into the bank on display | 353,909 pixels wrong |
| T2_SCALE_OFF | T2 scaled 2× wide instead of 3× | 339,932 pixels wrong |
| PALETTE_RB_SWAP | red and blue swapped in the palette | 314,570 pixels wrong |
| FETCH_LOSES_PRIORITY | the SEQ table sees FREE instead of FREEOP, so a fill fights the fetch for the address | fill leaves 75,761 pixels wrong |

### Stage 2 design notes (as planned before drawing)
**Timing:** VESA 800×600 at 60 Hz.
- Pixel clock 40.000 MHz: the slot clock itself.
- H: 800 + 40 + 128 + 88 = 1056; V: 600 + 1 + 4 + 23 = 628; both syncs positive.
- Frame rate 60.3 Hz.
- The 729×486 picture is centred 1:1: H 35..763, V 57..542. The border is black.

**Can the fetch keep up? Proven from the microcode,** not estimated (`microsim/wr-density.js`):
- **Method:** the control-store graph is walked with every branch free to go either way, so it's an upper bound over
  all programs. Carry cycles are stretched to 200 ns.
- **Result:** CPU write strobes can take **at most 176 of a line's 1,056 slots** (plus up to 4 if the line starts in
  the middle of one).
- At least **876 free slots for the 729-pixel fetch**, a margin of 147.
- In 100 ns microcycles: at most 81 writes per 264-microcycle line, so 0.31 of cycles at most. BFILL writes once
  every 4 microcycles; a word store writes 3 in a row.
- **Fill rate:** with scan-out first, a fill gets 1056 − 729 = 327 slots per line: about 29 ms for T3, 4.8 ms for T2.

**Blocks:**
- **Timing counters:** H (11 bits) and V (10 bits) as registers with next-count tables. The same tables also put out,
  registered and so glitch-free: HSYNC, VSYNC, blanking, "picture column" (X′ = H − 35) and "picture line", and the
  fetch window. 4–5 table chips + 2 registers.
- **Fetch engine:** during screen line y it fetches line y + 1, 729 screen pixels, into the idle bank of a
  **ping-pong line buffer** (2 × IS61WV51216: one bank written, one read, never both).
  - **Priority** per free slot: fetch first, then the port/fill operation.
  - **The pixel address table gains its 21st address bit, "screen coordinates":** T2 maps (X′, Y′) to
    (X′ / 3, Y′ / 2), so T2's 3×2 scaling costs no extra chips.
  - The coordinate mux becomes 3:1 ('153s): drawing position, fill counters, fetch counters.
- **Palette table:** address = the 12 pixel rails, MODE and BLANK.
  - Out comes the **DAC drive**: per channel p_hi, !n_hi, p_lo, !n_lo (the inversion is in the table).
  - T3 is the identity.
  - T2 maps its 3 levels to the nearest of the 9: 28 → 32, 132 → 128, 242 → 255. That's ≤ 13/255 off the emulator's
    colours. **A declared deviation;** an exact match would need a binary DAC instead of the ternary one.
- **The ternary DAC:** 2 × 74LVC574 (registered drive) and 4 resistors per channel (weights 3 : 3 : 1 : 1 on p_hi,
  !n_hi, p_lo, !n_lo), into the monitor's 75 Ω.
  - Each 2-trit diad v = 3·th + tl gives the drive sum (th + 1)·3 + (tl + 1) = v + 4: exactly 9 even levels.
  - **Values (computed):** 732 Ω and 2.21 kΩ (E96, 1%). Full scale 0.69–0.70 V. Worst step error 0.6% / 2.6% / 4.6%
    for a driver output resistance of 10 / 20 / 30 Ω (it's in series with the weight-3 legs, hence 732 rather than
    743).
  - The source impedance is ≈ 285 Ω, not a back-terminated 75 Ω. That's fine for a short VGA cable at 40 MHz. A video
    buffer can come later if the bench shows ringing.
- **Sync:** HSYNC and VSYNC from the registered table outputs through 33 Ω. 3.3 V clears VGA's TTL threshold.
- **Estimate:** about 25–30 more chips, so the whole card is ≈ 85–90.

**Stage 2 test plan:**
- Differential at the slot level against a reference renderer built from the emulator's `renderDisplay` rules (the
  palettes, T2 scaling): render whole frames from the netlist (≈ 663k slots per frame) at points in the desktop and
  TritOS boots, and compare every pixel's 4 DAC drive bits per channel.
- Plus the fetch-starvation corner: the worst-case write pattern from `wr-density.js` replayed as VBUSY during a frame.
- Plus mutants: sync off by one line, a T2 scale off, palette diad swap, fetch losing priority to a fill, a line-buffer
  bank flip.

## Found at integration (2026-11-21/22, whole machine, `integration/program-lockstep.js video` / `videoscan`)
1. **READY was never on IORDY.** The card-level harnesses let the CPU wait on READY directly, so nothing in the drawing
   ever stalled the real CPU: a fill (20 ms) would have been run over by the next instruction. **Fix:** U120, a
   74LVC1G07 (one open-drain buffer, SOT-23-5), READY → the backplane's wired-AND IORDY, beside the I/O card's two
   sources and its pull-up (RN4). 103 chips. Mutant VID_NO_STALL.
2. **The pipeline register U2 was drawn on SCLK, not the CPU clock.** The `reg18` helper put every register on SCLK,
   U2 included. On SCLK, U2 takes the *next* microword one slot after the backplane's UA changes, so the card strobed
   X, Y, pixel and colour at the edge of the cycle *before* the OUT, while the bus was empty: every port register
   loaded 0. The card harnesses clocked U2 by hand at the CPU edge (and skipped it on SCLK), so they tested the
   intended design, not the drawing. **Fix:** U2 on CLK, as on the I/O card. Mutant PIPE_ON_SCLK.

## Open
- **SCLK** on the backplane (spare 2 → 1); the clock generator on the Control card has to be 40 MHz ÷ 4 with the
  carry-cycle stretch.
- **74CBTLV3257 and 74LVC11:** datasheet maximums to confirm.
- **Fill time vs the microsim's 10-microcycle stand-in:** the same real-time question as the I/O card's timer.
