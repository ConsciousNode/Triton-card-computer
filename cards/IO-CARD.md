# The I/O card: bare ports and the port bridge
**Kehai Interim, 2026-11-19.** The I/O card has three parts:

- the **copy engine**, which loads every table at power-up (COPY-ENGINE.md, `io-copy-engine.js`);
- the **bare ports 40–47** and the **port bridge**, drawn chip by chip here (`io-ports.js`, `io-ports-tables.js`,
  tested by `io-ports-test.js`);
- the **timer and RTC** (ports 48–53), drawn 2026-11-19 (section below);
- the **console** (OUT 0) and the open-drain **IORDY**, drawn 2026-11-19 (section below).

There's no microcontroller and no program on it. It's shift registers, counters, flip-flops and SRAM tables, and the
ternary CPU runs every driver itself (`microsim/bare-drivers.js`).

## What the machine asks of it (`microsim/bareio.js`)
| port | OUT | IN |
| --- | --- | --- |
| 40 | an 8-bit SPI exchange: the byte is the low tryte w0 mod 256 | the byte that came back (low byte of the receive register) |
| 41 | bit 0 chip select (1 = selected), bit 1 SPI clock (0 = 312.5 kHz, 1 = 10 MHz) | card detect |
| 42 / 44 | (nothing) | keyboard / mouse byte; clears ready and releases the PS/2 clock |
| 43 / 45 | (nothing) | keyboard / mouse status: bit 0 ready, bit 1 parity error, bit 2 framing error |
| 46 | a 16-bit exchange of w0 + 9841, high byte first | the 16 received bits − 9841 (11 trits) |
| 47 | a 16-bit exchange sending 0xFFFF (clock a word in) | 0 |

A keyboard frame raises IRQ 1 (IRQSET1), a mouse frame IRQ 2 (IRQSET2). While a byte waits to be read, the card holds
that port's PS/2 clock low (inhibit), so the device keeps its next byte.

## Decisions (and what changed in the model to match)
1. **THE PORT BRIDGE is two lookup tables and the only place trits become bits.**
   - **T→B** (2 × IS61WV20488): address = the low tryte as 18 rails plus PORT0..2; data = 16 bits.
     - Port 46: w0 + 9841.
     - Port 47: 0xFFFF.
     - Every other port: (w0 mod 256) << 8. The byte goes out of the high shift register first, and OUT 41 reads its
       two bits from the same word.
   - **B→T** (3 × IS61WV5128): address = the 16-bit answer bus plus PORT0..2; data = 11 trits (22 rails), because
     IN 46 ranges from −9841 to 55,694.
   - Each port's meaning lives in the tables: the byte, the status bits, the −9841 offset, the PS/2 data's inversion.
2. **One receive register for ports 40 and 46.** That's a '164 pair: an 8-bit exchange shifts the old low byte up.
   - `bareio.js` had two separate registers (`spiIn`, `spi16In`). It now models the one register, so IN 40 after an
     OUT 46 reads the low byte of that word.
   - The drivers never mix the two, so their results don't change.
3. **The SPI byte is w0 mod 256.** The hardware only sees trits 0..8. `bareio.js` took the whole 27-trit value mod 256,
   which differs once the upper trits are nonzero. It now takes w0. The drivers only ever send 0..255.
4. **The SD spec wants ≤ 400 kHz during card initialisation,** so the SPI clock has two speeds: SCLK/128 = 312.5 kHz
   and SCLK/4 = 10 MHz. That's OUT 41 bit 1.
   - The driver now writes 3 to port 41 once init succeeds.
   - Slow bytes take ~256 microcycles each. Init is ~60 bytes, so ≈ 1.5 ms of IORDY wait.
5. **A PS/2 frame is caught by an inverted shift register.** The register is cleared to 0 and stores !bit, so the start
   bit (0) arrives as a 1. When it reaches the far end, the frame is complete. No bit counter is needed.
   - A falling device clock, synchronised by two flip-flops, enables one shift per bit.
   - A state table per port does the rest:
     - captures the byte into a 3-state '574 (it clocks it on a rising CAP edge);
     - sets ready / parity error / framing error;
     - raises IRQSET for exactly one CPU edge;
     - clears the shift register;
     - holds the clock low until IN 42 / 44.
   - Parity and framing are computed by the table from the 11 stored bits. No XOR gates.
6. **The answer bus is 16 bits wide, and the decode table turns on one source for an IN.** The sources are:
   - the receive register through two '244s;
   - a PS/2 data latch;
   - a status '244: card detect, plus ready, parity and framing for both ports.
   Port 47 has no source, so the pull-ups answer and the table returns 0.
   The B→T result goes into a 27-trit answer register (3 × '16823). That register drives D on BUS = IO, if the last IN
   was to a port on this card.

## As drawn (46 chips)
| block | parts |
| --- | --- |
| own control store + pipeline | IS61WV5128 (IN, OUT, BUS = IO), '16823 (off in RESET, clocked by the CPU clock), RPACK8 |
| port decode at the CPU edge | 2 × IS61WV5128: start / OUT 41 / load answer / reads / source enables; '74: "the last IN was mine" |
| T→B bridge + TX latch | 2 × IS61WV20488, '16823 (loaded when an exchange starts) |
| SPI | '157 + '74 (chip select, clock speed); sequencer IS61WV5128 + '574; 4 × '161 (phase and prescaler); 2 × SN74LVC165A out; 2 × 74LV164 in; 2 × '244 onto the answer bus |
| PS/2 × 2 | 3 × '74 synchronisers; per port: '16823 shift register (11 bits), state table IS61WV5128, '574 state, '574 data latch (3-state); '125 clock holds |
| answer side | status '244, 2 × RPACK8 pull-ups, B→T 3 × IS61WV5128, answer register 3 × '16823 |
| glue | '04, '32 |

BOM: IS61WV5128 ×9, ALVCH16823 ×7, LVC574 ×5, LVC74 ×5, LVC161 ×4, LVC244 ×3, RPACK8 ×3, IS61WV20488 ×2, LVC165 ×2,
LV164 ×2, LVC157, LVC125, LVC04, LVC32.

**Part notes.**
- There is no 74LVC164. The receive registers (and the copy engine's select registers) are **74LV164 / SN74LV164A**,
  2–5.5 V.
- The 74LVC165A is a current TI part (SN74LVC165A, 2024 datasheet).
- **PS/2 is 5 V open-collector.** The clock and data lines need level shifting (BSS138-style) and the hold outputs drive
  them through it.
- The SD card is 3.3 V native. `SD_/CS` is its active-low chip select.

**Integration notes.**
- IORDY now has two sources, this card's READY and the Video card's, so it wants an open-drain AND on the backplane
  (or a wired AND through '07-class buffers).
- The tables count toward the copy engine's load: nine 512K chips and two 2M chips.
- The card is a sixth `table-inventory.js` entry once the console/timer half is drawn.

## Results (`io-ports-test.js`, beside the microsim)
**How the test plays the devices.** They're played at the pins:
- **SD card:** a second SdCard instance behind a bit-level SPI slave. MISO is `SdCard.peek()`, which never depends on
  the byte being sent (Ncr ≥ 1). MOSI is sampled on rising SCK.
- **PS/2 devices:** two of them clock real 11-bit frames, bit by bit, and see the card's clock hold.
- **Declared simplifications:**
  - a frame is clocked in at the instruction boundary where the microsim takes it, with 8 slots per bit (a real
    frame takes ~1 ms, asynchronously);
  - the receive register starts at 0xFFFF like the model's;
  - the CPU waits on IORDY as long as the card needs.

| workload | microcycles | extra wait (IORDY) | BUS = IO answered | mismatches | what it reached |
| --- | --- | --- | --- | --- | --- |
| `ports` (every port 40–47, odd values, both PS/2 ports polled, bad parity, inhibit) | 10,384 | 2,004 | 101 | **0** | 12 frames (3 bad parity), 12 IRQ pulses, inhibit held 145 times |
| `drivers` (SD init, read sector 5, write sector 7, read back, 40 keys by interrupt) | 388,237 | 38,178 | 1,813 | **0** | console "0000" (init, read, write, read-back all OK); 4,846 SPI log entries identical; both SD images identical; 40 keys, 40 IRQ pulses, inhibit held 195 times |

**Mutants (positive controls):** all 6 killed on `ports`.

| mutant | caught as |
| --- | --- |
| BRIDGE_OFF_BY_ONE | SPI stream differs (227 vs 226) |
| B2T_NO_OFFSET | IN 46 answers 65535 vs 55694 |
| IN42_NO_CLEAR | the card holds the clock while the microsim takes a frame |
| SPI_SHORT | SPI stream short by a byte |
| K_NO_IRQ | 0 keyboard IRQ pulses for 6 frames |
| NO_INHIBIT | the device is inhibited in the microsim and the card isn't holding |

**Simulator change found here.** Two parts act asynchronously: the '16823 x/CLR and the '165 SH/LD. Modelling that
inside `eval` was wrong, because an early settle pass reads a net before its driver has run and saw a false 0, which
cleared the shift register. `netlist.settle()` now applies async parts' `async()` hook to the *settled* values only,
then settles again. Every other card ties x/CLR high, so nothing else changes. Regression after the change, all 0 mismatches:
- Control card, random: 300,000 microcycles.
- Registers card, random: 300,000 microcycles.
- Video card, directed: 6,946 microcycles + 199,383 of wait, both fills.
`microsim/bare-io-test.js` is ALL PASS with the model changes.

# The timer and the RTC (ports 48–53), 2026-11-19
**Why new ports, not 6 / 9 / 31 / 32.** The handoff's "console and timer ports (0, 1, 6, 9)" came from the Triton 3 port
list the bare-I/O model started from. TritOS Desktop 2 never touches 0 or 1, and it does use 6, 9, **31** (timer mode,
200 kHz real time) and **32** (the RTC). Those ports each answer a full 27-trit number in one IN, and the port bridge can
only make 11 trits from 16 bits. So, like the SD card replacing the DMA disk, the timer and RTC get bare ports that
hand over bytes, and the CPU's driver assembles the values. TritOS's five `drv_timer_*` routines get swapped on bare
hardware, the same way every other driver does. There's **no step-counting mode**: it would need an end-of-step wire
from the Control card, and TritOS switches to real time at boot anyway. Ports 6 and 9 are now unanswered, like 7–27.

| port | OUT | IN |
| --- | --- | --- |
| 48 | (nothing) | the selected stored byte |
| 49 | arm: the period counter loads the latch now | (nothing) |
| 50 / 51 | period latch, low / high byte (L) | (nothing) |
| 52 | snapshot: both counters into their registers | (nothing) |
| 53 | bits 0–2 = which byte IN 48 reads (0–3 tick count, 4–7 RTC), bit 3 = timer enable | (nothing) |

- **Tick:** an 8-bit prescaler ('161 × 2) counts 56..255 and reloads, giving one TICK slot in every 200 SCLK slots
  (200 kHz, 5 µs, the Triton 4 real-time rate). It's held at 56 during RESET.
- **Tick count:** one **SN74LV8154** as a 32-bit counter (CLKA = CLKB = TICKQ, RCOA → CLKBEN), cleared by RESET. It
  wraps every ~6 h, and the driver extends it in software (the timer interrupt runs far more often than that).
- **Period timer:** 16 bits of '161, counting TICKs while enabled. At all ones it reloads the latch on the next TICK and
  **fires**, so the period is 65536 − L ticks (1 tick to 0.33 s). A firing sets a flip-flop that becomes **IRQSET0**,
  which stays up until one CPU edge has seen it: one pulse into IPEND per firing. Firings that come faster than the
  CPU takes them collapse into one pending IRQ, as IPEND is one bit.
- **RTC (option A, on the coin cell):** a **CD4060** divides the 32.768 kHz crystal to 2 Hz (Q14), and a second
  'LV8154 counts half-seconds: 32 bits, 68 years. It's **never cleared or set**. The OS keeps the offset to real time
  on the home disk, exactly like the emulator's `rtcOffset`.
- **Reading:** OUT 52 snapshots both 'LV8154s at once (their RCLK). OUT 53 picks a byte, and a '138 on the select
  latch, enabled by IN 48's decode, puts that chip's byte on the answer bus (B→T byte mode).
- **Snapshot timing.** The 'LV8154 has no clock-enable pin: every rising edge on CLKA counts, every rising edge on
  RCLK stores. So both clocks come from flip-flops (TICKQ, RCLKQ), and **a snapshot asked for in a TICK slot is held one
  slot** (SNAPP), so RCLK and the tick counter's CLKA never rise at the same edge. The tick count read is always "TICKs
  in slots up to the OUT 52 edge". **The RTC can still race:** its clock comes from the crystal, not SCLK, so a snapshot
  can land while the RTC chip is counting. The RTC driver snapshots twice and accepts a value when two agree.
- **New glue:** one more decode/glue table (U56: the write strobes, IN 48's enable, the period counter's load, the IRQ
  flag's next state, the snapshot hold), two '74s, the select/enable latch and the period latch ('16823 × 2).
  U5's decode now also answers IN 48 (it loads the answer register and claims BUS = IO).

**Chips: +15, 61 on the card.** 'LV8154 ×2, CD4060, LVC161 ×6, LVC74 ×2, ALVCH16823 ×2, LVC138, IS61WV5128 (U56). Plus
passives for the RTC: the 32.768 kHz crystal and its two caps and resistors, a CR2032 holder, and a diode-OR so the
RTC side runs from 3V3 when the machine is on and from the cell when it's off.

**Power domain (bench items, not simulated).** The CD4060, the RTC 'LV8154 and the crystal sit on VBAT. The 'LV8154
has Ioff (partial power-down), so its inputs from the 3V3 side (RCLK, the byte gates) don't back-power it when the
machine is off. The byte gates need pull-ups to VBAT so its outputs stay off while the 3V3 side is unpowered.
Measure the coin cell current (the CD4060 oscillator is most of it).

**Models added:** `parts.js` gets `LV8154` (from TI's SCLS589B pin functions) and `CD4060`. Both are clocked by
derived nets, so they have an `edges` table, and the harness fires `edge()` on each transition.

## Simulator fix found here (netlist.settle)
A reader evaluated before a strong driver in the same pass saw the pull-ups' weak 1 on that pass, and every pass did
the same, so the netlist "settled" on a wrong value. The new 'LV8154s on the answer bus come after the B→T tables in
the chip order, and IN 48 answered 255. Fix: a value a resistor wrote this pass no longer hides last pass's value. Every
card's regression was rerun after the fix (HANDOFF addendum 8).

# The console (OUT 0) and IORDY as a wired-AND, 2026-11-19
**What it is:** OUT 0 sends one byte out the **CON_TX** pin as standard serial: 115,200 baud, 8 data bits, no parity, 1
stop bit, LSB first. Any 3.3 V USB-serial cable on a PC can read it. **The first thing it says on a good boot is
`POOP OK`** (the Power On Operational Precheck, Kham's).

- **The byte** is the bridge's byte mode (w0 mod 256, TB8–15), latched at the OUT 0 edge in U63.
- **Baud:** a 12-bit '161 counter (U59–U61) loads 3749 and gives one tick at 4095, so one slot in 347. 40 MHz / 347
  = 115,274 baud, +0.064 % (a UART tolerates a few percent). OUT 0 reloads it, so the start bit gets a whole bit time.
- **The bit sequencer** is a '161 (U62) loaded with 1 by OUT 0 and counting baud ticks while busy:
  - 1 = start bit (0);
  - 2–9 = data bits 0–7;
  - 10 = stop bit (1);
  - 0 and 11+ = idle (1).
- **The pin:** a table (U64: byte × bit index → TXD, BUSY, the baud reload) picks each bit. A flip-flop (U65)
  registers it onto CON_TX, so the pin never glitches. U65 is preset by RESET, so the line idles high.
- **Flow control is the same as the SD port's:** the card holds **IORDY** low while a byte shifts. A character costs
  the CPU about 87 µs (868 microcycles), and interrupts wait that long too. That's fine for a debug console. If it
  ever matters, a one-byte holding register lets the CPU go on with its next instruction.
- **Gone:** IN 0 / IN 1 (console input; the keyboard is PS/2) and OUT 1's decimal print. Turning a 27-trit number into
  digits is radix conversion, which no counter does, so the CPU does it in software: `PRNUM` in
  `microsim/bare-drivers.js`, which handles the sign too and uses DIV, which truncates toward zero.
- **Decode:** U6 gains `/CSTART` (OUT 0 at the CPU edge). Port 0 shares the bridge's PORT0..2 mode with port 40 (byte
  mode), which is what we want.

**IORDY is now an open-drain wired-AND** (from the handoff's list). The SPI sequencer's READY (U14, now `SREADY`) and
the console's `/CBUSY` each drive IORDY through a **74LVC07** (U66), against one pull-up (RN4). Anything else that
might ever stall gets its own '07 gate. Four are spare. The Video card's READY joins this line on the backplane in the
integration netlist.

**Found while drawing it (harness, not board):** the test harness started each machine with the card's pipeline
register (U2) at zeros. On this card zeros mean every strobe is active, so with PORT = 0 the first CPU edge looked like
OUT 0, and the console sent a byte. On a real board the CPU clock runs during RESET, so U2 leaves reset holding a
real control word, and the harness now does the same. **Bench note:** the CPU clock must run while RESET is held.

**Chips: +8, 70 on the card** ('161 ×4, '16823, IS61WV5128 (U64), '74, '07, and a resistor pack).

**Test:** the harness plays the world's terminal: a UART receiver on CON_TX at the true 115,200 baud, sampling each bit
at its middle. Every received byte must equal the model's next printed byte, with no framing errors. The `console`
workload is `POOP OK\r\n`, then numbers printed by PRNUM (0, 7, −1, 42, ±9841, 1234567, −987654321), then the bytes
00 01 55 AA 7F 80 FF and a negative value. Mutants: bits MSB-first, a stop bit of 0, twice the baud, and the console
not holding IORDY.

