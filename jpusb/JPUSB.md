# JPUSB: the Bare USB card in the card computer's library

*Kehai Interim, 2026-11-21. Step 1 of the JPUSB plan in `INTEGRATION-PLAN.md`.*

JPUSB ("Just Parts USB", named for Jeep) is Neon's Bare USB design: a USB 1.1 host made only of 74LVC logic,
10 ns SRAM tables, one parallel flash and an analog transceiver. Round 11 met its preregistered bar in Neon's own
simulator (`Bare-USB/AUDIT-11.md`). This folder brings the design into the card computer's part library and proves
the translation matches Neon's netlist, so the card can join the whole-machine simulation.

## Files
- `translate.js`: records Neon's `src/netlist.js` through a stub simulator (every `addChip` call, unchanged) and adds
  each chip to a card-computer `Card` with the library's part and pin names. Run it alone for the BOM and the static
  check. `BAREUSB_SRC` points at a Bare-USB delivery's `src` folder (default `../bare-usb/delivery-11/src`).
- `crosscheck.js`: Neon's simulator and the translation run side by side on Neon's own workloads, compared net by
  net before every 48 MHz edge. Usage: `node crosscheck.js [hid|msc] [min|typ|max] [keystrokes]`.

## The translation
257 chips: Neon's 260, minus three world parts. Those are the 48 MHz oscillator (CLK_48M is a world input), the
USB1T11A transceiver and the line resistors. The transceiver is analog, so the cut is at its digital pins: VP, VM and
RCV (DP_IN, DM_IN, RCV_IN) come in from the world; VPO, VMO, OE_N and SPEED go out to it.

Four parts were added to `cards/parts.js`: the 74LVC86 (XOR), the SST39SF040 flash (read only; a write cycle
throws), the 74LVC257A and the SN74LVCH245A (both below). Pin renames are listed at the top of `translate.js`. Neon's SRAMs wire
A0..A11, so A12..A18 go to GND. The static check (the integration's precise one) is clean.

## How the cross-check works
- Neon's side runs unchanged: its GateSimulator (a timed event simulator), its netlist, line model, device, pin
  harness and driver.
- Watchers on Neon's simulator record every change on the card's inputs, in time order: the port bus (RST_N, IO_CS_N,
  IO_RD_N, IO_WR_N, PORT_A0..2, and PORT_D0..15 while the CPU drives it), the transceiver's outputs and the clock.
- Our side gets the same changes in the same order, under the card computer's physical rule. After each change it
  settles. A flip-flop or counter is clocked only when its own clock net rises, with the values from just before.
  Derived clocks ripple. An SRAM writes while /CE and /WE are low.
- **Compared:** every net both simulators have (1,125), at every CLK_48M rising edge, just before it.
- **Not compared:** an edge within 40 ns of a change on an asynchronous input, because Neon's timed nets are still
  moving there.
- **Declared (Neon's pin harness):** Neon's harness changes the port bus at exactly the instant of a 48 MHz rising
  edge, so every port access is a zero-setup event, legal because the bus is declared asynchronous and synchronized.
  In Neon's simulator an input net updates at once and every gate output a delay later. So at that edge a flop
  reading the input net directly sees the new value, and one reading it through any gate sees the old one. The first
  clocking pass at such an edge reads exactly that way.
- **Declared (bus-hold power-up):** a bus-hold cell powers up holding the level Neon's simulator starts that net at.

## Results (2026-11-21, min corner; Neon's drawing with the bus-hold parts, `WRITEPATH=neon`)
| Workload | Neon's result | Edges | Compared × nets | Mismatches |
| --- | --- | ---: | ---: | ---: |
| Low-speed HID keyboard: enumerate, 1 keystroke | enumerated, key exact | 134,348 | 129,382 × 1,125 | **0** |
| Full-speed mass storage: enumerate, SCSI read LBA 32 | enumerated, sector byte-exact | 215,506 | 205,065 × 1,125 | **0** |

**Positive controls** (`WRITEPATH=neon`; our side only; Neon's simulator keeps the real design), keyboard workload unless noted:
- **Caught (13):**
  - two of mine: `old161` (the library's '161 before today's fix), caught at edge 4,848; `swap574` (one register's
    D1/D2 swapped);
  - eleven of Neon's own netlist mutants: `auto_ack_late`, `bit_stuff_off_by_one`, `crc16_tap_moved`,
    `dpll_resync_disabled`, `false_path_violated`, `mcp_endpoint_captures_off_enable`,
    `mcp_source_changes_off_enable`, `nrzi_rx_inverted`, `reg_dec_swapped`, `sof_missing`, `turnaround_short`.
- **Caught at the first settle:** `undriven_net_mutant` (U150.2B reads SE0_PREV_N, which nothing drives).
- **Not seen by the keyboard workload, as expected, so rerun on mass storage:**
  - `buf_addr_carry_broken`: 8-byte packets never carry the buffer address past 15. Caught on mass storage at edge
    35,783.
  - `fsm_bad_next_state`: needs a planted address. Caught on mass storage at 0x82, the address Neon's Test 6 picks by
    its own rule.
- **`enable_spacing_too_short`** is timing in intent but has a functional effect at full speed: caught on mass storage
  at edge 977.

**17 of 17 controls caught.**

## Findings
**1. The packet buffer can't be built as drawn.** Neon's simulator gives its IS61WV5128EDBLL model separate write-data
pins D0..D7 beside IO0..IO7. The real chip has one set of common I/O pins. U41/U42 write through D (BUF_DIN_*, from
the '157 muxes U106..U109) and read on IO (BD*). It is translated with a declared model-only part,
`NEON_SRAM_SPLIT_IO`, so the cross-check can prove equality with Neon's design.
- **The fix, now the translation's default (`WRITEPATH=neon` builds Neon's drawing):** U106..U109 become 74LVC257A
  (the same mux with 3-state outputs) driving BD directly. Their /OE is BUF_OE_N through U152's spare inverter 1;
  BUF_OE_N = CPU_WR_DAT | RX_WE_PULSE, high exactly in the write windows, when the SRAMs' /OE is already high. U41/U42
  are plain IS61WV5128s. No new chip positions.
- **Checked for function:**
  - keyboard: 134,348 edges, 0 mismatches; mass storage: 215,506 edges, 0 mismatches, sector byte-exact;
  - declared: in a buffer write window the fix drives BD with the write data, where Neon's model holds the old value.
    So BD and its combinational cone (32 nets, through the TX payload muxes) aren't compared there: at 83 and 595
    edges. Every register and every other net still is.
- **Still to check: timing.** SRAM /OE to high-Z, the '257's enable and disable, data setup and hold around /WE. Kham
  chose (2026-11-21) to go with the recommendation: the fix here, and timing as Neon's Round 12
  (`Bare-USB/ROUND12-MESSAGE.md`, bar in `PREREG-v6-addendum.md`).

**2. Neon's simulator never lets a net float.** A disabled '574, '245 or SRAM output just stops updating, so every
bus behaves as if it had a keeper. Our library treats a read of a floating net as an error, which is how findings 3
and 4 surfaced.

**3. Two buses floated while gates read them.**
- **BUS_D0..15**, behind the backplane '245s, is read all the time by the hold muxes and gates but driven only during
  a port access.
- **BD0..15**, the buffer's data bus, is read by the TX payload muxes while the SRAMs' outputs are off.
- **Fix, used in the translation:** the '245s on those buses (U46/U47 on BUS_D, U67/U68 on BD) become SN74LVCH245A,
  the same chip with bus-hold on its data pins. That is exactly what Neon's model assumed without saying so, so
  the parts change but nothing else does. `BUSHOLD=0` builds Neon's drawing as it is.

**4. FL_D0..7 (the boot flash's data pins) float outside reset.** Nothing reads them then, so this is fine.

**5. A bug in our own library, found by this cross-check.** The 74LVC161's MR and the 74LVC74's /CLR and /PRE are
asynchronous. Our models only overrode the outputs while those pins were low, and the old state came back when they
released. Inside the card computer it never showed, because the clocks keep running through every reset. In JPUSB a
buffer-address reset with no clock edge inside it brought the old address back. Fixed in `cards/parts.js` (an async
hook on both). The `old161` control above is the old model, and it is caught.

## Next (the rest of the JPUSB plan)
1. Round 12 (timing of the write path and the bus-hold parts, in Neon's timed simulator), then this cross-check
   against delivery 12.
2. The 48 MHz domain against SCLK (40 MHz): the card's port interface already treats the bus as asynchronous with
   2-flop synchronizers. Joining it to the I/O card's port bridge needs the trit-to-binary port interface and
   IRQSET3.
3. The TritOS driver.
4. The whole-machine test with a simulated USB keyboard.
