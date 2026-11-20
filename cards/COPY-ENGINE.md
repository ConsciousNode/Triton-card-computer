# The copy engine (I/O card), stage 0: what it has to load, and how
**Kehai Interim, 2026-11-18 late evening.** Option B is now drawn on all five cards and simulated: see §5. Tools: `table-inventory.js` (inventory and
flash size) and the coloring check written up below.

## 1. The inventory: 12 MB, not 1 MB
`table-inventory.js` builds every card and counts each SRAM whose /WE is tied high (a table). It takes the address range
actually wired and hashes the content. Identical images are counted once.

| card | table chips | distinct images | distinct MB | MB if every chip had its own |
| --- | --- | --- | --- | --- |
| ALU | 17 | 7 | 0.88 | 5.38 |
| Registers | 1 | 1 | 0.00 | 0.00 |
| Control | 42 | 31 | 2.49 | 4.99 |
| Memory (3^14) | 65 | 27 | 0.61 | 2.10 |
| Video | 27 | 27 | **8.08** | 8.08 |
| **all** | **152** | **93** | **12.06** | **20.55** |

- **Where it went wrong:** PARTS.md planned 2 × SST39SF040 = 1 MB. That figure dates from when the tables were the ALU
  table plus the control store (534 KB).
- **The big ones:** the Video card's three pixel-address tables, at 2 MB each (MODE | SCREEN | Y | X → address); the
  Control card's dispatch and flag tables; the ALU slices.
- **The flash fix is easy:** one **Infineon S29GL128S** (128 Mbit = 16 MB, 3.3 V, 90 ns, TSOP-56, about $3–5) holds all
  12 MB. Being 3.3 V, it also removes the 5 V → 3.3 V level shifting the SST parts needed.
  - The cost is the socket: TSOP-56 wants a ZIF socket or a small plug-in daughterboard to stay reprogrammable off the
    machine.
  - Section 3's option B needs a 64 MB **S29GL512S** instead: same family, about $8–10.

## 2. The real gap: no card has a load path
Every table's address and data pins are wired only to the run-time logic. Loading them at power-up means reaching those
pins from the copy engine. Measured from the netlists (audit script in this note's commit):

| card | distinct table address nets | table data nets | address nets driven by non-tristate parts |
| --- | --- | --- | --- |
| ALU | 216 | 116 | 57 ('157, '153) |
| Registers | 10 | 2 | 0 |
| Control | 298 | 269 | 1 |
| Memory | 427 | 285 | 15 ('157, '11) |
| Video | 145 | 164 | 31 ('157, '08) |
| **all** | **1,096** | **836** | **104** |

## 3. Options

### A. Conventional: a 2:1 mux on every table address net, a '245 on every data byte
- **Cost:** about 274 four-bit muxes plus 105 '245s, plus /WE decoding. **That's about 380 chips**, on a machine of
  roughly 600 so far.
- Proven and boring. The muxes also add 1–5 ns to timing paths that have already been budgeted.

### B. A resistor-coupled load bus (my proposal, not yet simulated)
- **Run-time drivers are three-stated during LOAD.** Almost every driver on a table net can already go off:
  - the '16823 and '574 registers, by /OE;
  - the SRAMs, by /OE;
  - the '245s, by /OE.

  The 104 that can't are swapped for same-pinout three-state parts: '157 → '257, '153 → '253, and the few gates get
  moved or buffered.
- **Each table net gets one resistor** (≈ 10 kΩ, in 8-way SIP networks) to one line of a per-card **load bus**. During
  LOAD the nets float, and the resistors pull each one to its load-bus line. At run time the real drivers overpower the
  resistors.
- **Which line each net gets is a graph colouring.** All the nets on one table chip (its address and data pins) must
  be on different lines, so the copy engine can present any address and data to that chip at once.
  - A DSATUR colouring of the real netlists needs **27 / 12 / 28 / 26 / 29 lines** for ALU / Registers / Control /
    Memory / Video. That is at or next to the lower bound (the widest table chip has 27 / 12 / 26 / 26 / 29 nets).
  - So **a 32-line load bus fits every card.**
- **The load bus rides the backplane D bus.** Its 54 wires are idle while the CPU is in reset. On each card a FET bus
  switch (2 × 74CBTLV16211) connects the card's load lines to D during LOAD and isolates them at run time.
- **The flash holds bus waveforms, not tables.** Each entry is one 32-bit load-bus word (address bits and data bits
  already routed to the right lines for that chip) plus the chip's /WE select.
  - The copy engine is then just counters, the flash, a latch, and a /WE decoder (/WE becomes a decoded per-chip line).
  - The rule holds: no program, no branching. It's a table played out by a counter, like the control store.
  - **Flash size:** about 4 bytes × the entries. 12M distinct entries is about 48 MB, so one 64 MB S29GL512S. Identical
    chips (the ALU slices, for example) can share writes if the colouring gives them identical lines; I haven't tried
    that constraint yet.
- **Rough cost:**
  - about 242 resistor networks (passives, cents each);
  - 104 same-pinout swaps (0 added chips);
  - about 10 bus switches;
  - about 20 /WE decoders;
  - the flash and counters.

  **So about 35 chips instead of about 380.**
- **The risks to check in simulation before trusting it:**
  - **settling time through 10 kΩ** into the pin capacitance (about 200 ns, so 12M entries take a few seconds of boot);
  - **static current at run time** (nets that disagree with their floating load line: tens of mA total; the line
    floats once the bus switch opens);
  - **coupling** through the shared floating line at run time (a few dozen nets on each line; expected to be small, but
    it needs a number);
  - every non-three-state driver found and swapped (the static check can enforce this).

### C. Fewer tables
Consolidate or shrink the biggest images (the Video PA tables, for example). That helps A and B both, but costs chips
or speed elsewhere. It's an optimisation, not a fix.

## 4. Proposed next steps (B)
1. Teach `netlist.js` a weak resistive driver (a net-to-line coupling with a strength order: strong driver > resistor >
   floating), and check it against a hand-worked case.
2. Generate the flash image: colouring, then per-chip bit routing, then entries.
3. **The real test:** simulate the whole power-up with every card on one load bus, starting from blank SRAMs. Afterwards
   every table chip's memory must equal its image, bit for bit. Mutants:
   - a wrong colour;
   - a driver left on;
   - a swapped /WE;
   - a stuck load line.
4. Then the I/O card proper (bare ports, port bridge), which also hosts the copy engine.

## 5. Option B, drawn and simulated
- **Files:**
  - `loadpath.js`: the transform that adds a card's load path (`LOADPATH=1` applies it inside every card's `build()`);
  - `load-sim.js`: power-up loading on the netlists;
  - `lp-check.js`: what each card gains;
  - new part models in `parts.js`: '257, '253, '125, '138, RLINK8, switched RPACK8S;
  - `netlist.js` now reports **weak contention** (two resistors pulling one net different ways) and supports
    `defaults` (LOAD = 0 at run time).
- **What each card gains** (`lp-check.js`):

  | card | '125 | '32 | '138 | swapped in place ('157 → '257, '153 → '253) | RLINK8 networks | pull networks |
  | --- | --- | --- | --- | --- | --- | --- |
  | ALU | 11 | 2 | 5 | 15 | 39 | 8 |
  | Registers | 0 | 1 | 3 | 0 | 2 | 1 |
  | Control | 1 | 1 | 8 | 1 | 62 | 3 |
  | Memory | 4 | 3 | 12 | 2 | 75 | 7 |
  | Video | 6 | 2 | 6 | 8 | 38 | 8 |
  | **all** | **22** | **9** | **34** | **26** | **216** | **27** |

  - **65 active chips added across the five cards,** plus 243 resistor networks (passives). Option A would have been
    about 380.
  - The I/O card's copy engine itself (flash, counters, latches, a bus switch pair per card) comes on top.
- **Loading, all five cards** (`load-sim.js`, FULL = 4096, SAMPLE = 600):
  - **all 152 tables:** the routing proof passes. For each chip, a walking one and a walking zero over its lines; every
    pin follows its own line and nothing else.
  - **145,431 writes, each with a full settle of the card,** in 151,259 settles. At every write exactly one /WE is low
    (the right one), and every pin reads what the copy engine meant.
  - Tables up to 4,096 entries are loaded completely; larger ones get 600 random entries plus the first and last.
  - **Readback:** every written entry matches its image bit for bit, on all five cards.

  | card | tables | writes | settles |
  | --- | --- | --- | --- |
  | ALU | 17 | 11,922 | 12,718 |
  | Registers | 1 | 1,024 | 1,048 |
  | Control | 42 | 40,182 | 41,942 |
  | Memory (3^14) | 65 | 42,009 | 44,311 |
  | Video | 27 | 50,294 | 51,320 |

- **Mutants:**

  | mutant | ALU | Registers | Control | Memory | Video |
  | --- | --- | --- | --- | --- | --- |
  | WRONG_COLOUR (two nets of one chip on one line) | killed | killed | killed | killed | killed |
  | DRIVER_LEFT_ON (one on-card driver not let go) | killed | n/a (no on-card drivers) | killed | killed | killed |
  | WE_SWAP (two chips' /WE swapped) | killed | n/a (one table) | killed | killed | killed |
  | STUCK_LINE (one load line stuck at 0) | killed | killed | killed | killed | killed |

  - **Not caught by the first version of the driver mutant:** it chose a pipeline register. That register's /OE is
    RESET, and the CPU is held in reset during LOAD, so the mutant was equivalent. The final version leaves a whole
    always-enabled chip on.
  - **What that says about cost:** for registers already off in RESET, the LOAD OR gate is redundant. A small saving
    for the real layout.
- **Run time, with the load path in place (LOADPATH=1):**

  | card | workload | microcycles | mismatches |
  | --- | --- | --- | --- |
  | Registers | directed | 37,543 | 0 |
  | ALU | directed | 37,543 | 0 |
  | Control | directed | 37,543 | 0 |
  | Memory | fb | 18,875 | 0 |
  | Video | directed | 6,946 + 199,383 of wait | 0 |
  | Video | scan-out, t3 (a whole frame) | 640,000 slots | 0 |
- **Bugs found on the way, all in my own code:**
  1. **A net-name collision:** the Video card already has LB0..11, its line buffer B. The load lines are now LDB*, and
     the transform refuses to run if a name collides.
  2. **Tables share output buses by /OE,** so a table's /OE must be ORed with LOAD, not replaced by it.
  3. **The test used a data pin's list position instead of its IO number,** so it was wrong on chips with gaps in
     their wiring (U100 uses IO6 only).
  4. **The Control harness found pipeline chips by the literal net name RESET.** It now accepts RESET|LOAD.

## 6. Numbers that need the bench (estimates, not simulated)
The simulator is logic-level, with no RC.
- **Flash:**
  - 21,546,048 entries. Each is 39 load lines plus the card select, 3 × 16 bits, so **123 MB**: one **S29GL01GS**
    (1 Gbit, 128 MB).
  - Unreachable entries (aliased pins) can be dropped. If the colouring is constrained so identical chips get identical
    lines, shared images (the ALU slices, for example) could load together and cut this a lot.
- **Resistor value: a trade-off.** Per net, about 30 pF (pins plus trace):

  | R | settle (≈ 3RC) | boot (21.5M entries) | run-time current (≈ 1,932 nets × 1.65 V / R) |
  | --- | --- | --- | --- |
  | 4.7 kΩ | ≈ 0.4 µs | ≈ 15 s | ≈ 0.7 A (2.2 W) |
  | 10 kΩ | ≈ 0.9 µs | ≈ 25 s | ≈ 0.3 A (1 W) |
  | 22 kΩ | ≈ 2 µs | ≈ 50 s | ≈ 0.15 A (0.5 W) |

  - The run-time current comes from the floating load lines. Each line joins about 20–40 nets on its card through
    their resistors, so nets that disagree push current through each other.
  - **One fix:** park the load lines at run time. Drive every line to the value most of its nets usually hold. That's
    only a partial fix.
  - **Another:** accept a slow boot with 47 kΩ.
  - Needs a bench measurement either way.
- **Cards combined:** a table net that is a card input (UA, MODE, …) must be let go by the card that drives it. The
  integration netlist has to check that across the backplane.

## 7. The copy engine itself, and the revised load bus (2026-11-19)
**Why the bus changed.** Drawing the engine showed that every one of the 54 D-bus wires is itself a table input on the
ALU, Control and Memory cards. While loading, the engine drives those wires directly, so a table pin wired to D5+
sees exactly what the engine puts on D5+. Two fixes, both now in `loadpath.js`:
- **The load bus is the backplane itself: 96 engine lines.** That's the 54 D wires plus every control or status line
  that feeds a table somewhere: UA0..9, PORT0..5, RSLOT0..4, RESET, /CEDGE, MODE, PRIV, PROTEN, IE, SPRNR, ABORT, FK,
  the flags, IORDY and IRQSET0..4.
  - Their on-card drivers all let go during LOAD. A new transform rule: every on-card driver of a backplane net is
    gated by LOAD.
  - A table net that *is* an engine line needs no resistor; its colour is its own line index.
  - Every other table net is coloured with any of the 96 line indices and gets its resistor to that line, through the
    card's bus switch. That's 1–2 '16211s per card, switching only the lines that card's resistors use.
- **The chip select left the D bus.** It's 16 bits shifted MSB first into a '164 pair on every card: LOAD_SEL0 is
  data, LOAD_SEL1 is clock. Bits 0..6 are the chip, 7..9 the card. LOAD_WE strobes the chosen chip's /WE.
  - It costs 16 shift entries per table (2,432 in all), not per write.
  - No new backplane pins: LOAD_SEL2 is now spare.
  - Colouring with the fixed lines: every card fits in the 96 lines.

**The engine** (`io-copy-engine.js`, I/O card, about 25 chips, no program):
- **Counting:** a 32-bit counter (8 × '161); its low 4 bits are the phase.
- **Flash:** two S70GL02GS (2 Gbit each, x16). Word address = entry × 8 + (phase & 7); entry bit 24 picks the chip.
- **Latching:** seven '16823s catch words 0..6 at the end of phases 0..6 (a '138 decodes the latch enables).
  - Words 0..5 drive the 96 lines.
  - Word 6 holds the flags: WE, SHIFT, SDATA, END.
- **Strobes:** phases 7..13 let the lines settle. In phase 14, LOAD_WE (or LOAD_SEL1) goes high from a registered
  '74; it drops in phase 15.
- **Ending:** an END entry sets DONE. The counter stops, the line latches let go of the backplane, and LOAD drops, so
  the CPU leaves reset.

**Production numbers:**
- **Flash:** about 21.5M write entries + 2,433, at 8 words each = **about 344 MB on two 256 MB S70GL02GS chips**.
- **Time:** at ECLK = 8 MHz an entry takes 16 × 125 ns = 2 µs, so **about 43 s to load everything.**
  - Halving the settle phases (lower R) or reading the flash in page mode would cut that.
  - Sharing images between identical chips would cut the entries.

**Chips added, all cards** (`lp-check.js`):

| card | '125 | '32 | '138 | '164 | '04 | '16211 | total | resistor networks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ALU | 11 | 2 | 5 | 2 | 1 | 2 | 23 | 31 |
| Registers | 0 | 1 | 3 | 2 | 1 | 1 | 8 | 1 |
| Control | 1 | 1 | 8 | 2 | 1 | 2 | 15 | 51 |
| Memory | 4 | 3 | 12 | 2 | 1 | 2 | 24 | 65 |
| Video | 6 | 2 | 6 | 2 | 1 | 2 | 19 | 34 |

- **89 active chips on the cards, plus about 25 for the engine: about 114 in all.**
- Plus 26 same-pinout swaps, 182 resistor networks and 23 pull networks.
- Option A's muxes alone were about 380.

**The test** (`powerup-sim.js`): build all five cards with their load paths, fill every table with garbage, generate the
flash stream, run the engine's netlist clock by clock from /POR, and let the backplane it drives load the cards.
- On every LOAD_SEL1 edge, all five cards settle and their shift registers clock.
- On every write, exactly one table on the whole backplane may have /WE low. The first write after each select settles
  all five cards to check that.
- **At DONE:** LOAD must be low, and every written entry must match its image.

**Results (final scheme):**
- **Power-up, flash to tables** (`powerup-sim.js`, FULL = 1024, SAMPLE = 200):
  - 50,709 entries, 811,347 engine clocks (101 ms of machine time at 8 MHz);
  - 2,432 select shifts and **48,276 writes**;
  - DONE rose, LOAD dropped, the engine let go of the backplane, and **every written entry matches its image** on all
    152 tables.
- **Engine mutants:**

  | mutant | what it breaks | result |
  | --- | --- | --- |
  | WORD_SWAP | latch enables crossed | **killed**: 694 entries wrong |
  | STROBE_EARLY | the write strobe in phase 4, before the lines are all latched | **killed**: 178 wrong |
  | END_IGNORED | DONE never sets | **killed**: the engine runs on into erased flash, and its all-ones flags write garbage and break the one-/WE rule |

- **Per-card loading** (`load-sim.js`, FULL = 4096, SAMPLE = 600, engine lines): routing proved on all 152 tables;
  145,431 writes, every one matching.
- **Load-path mutants:** WRONG_COLOUR, DRIVER_LEFT_ON, WE_SWAP and STUCK_LINE are killed on every card where they
  apply. On the Registers card, two can't happen: it has no on-card drivers of table nets, and only one table.
  - DRIVER_LEFT_ON had to be fixed. The new backplane rule silently re-gated the very driver the mutant skipped.
- **Run time with the load path** (LOADPATH=1):

  | card | workload | result |
  | --- | --- | --- |
  | Registers | directed (37,543 microcycles) | 0 mismatches |
  | ALU | directed (37,543 microcycles) | 0 mismatches |
  | Control | directed (37,543 microcycles) | 0 mismatches |
  | Memory | fb (18,875 microcycles) | 0 mismatches |
  | Video | directed (6,946 + 199,383 of wait) | 0 mismatches |
  | Video | a whole scan-out frame (640,000 slots) | 0 mismatches |

**Open:**
- **Backplane names:** the cards spell some signals differently from `backplane.js` (IRQSET0..4 vs /IRQ0..5,
  MODE vs MODE_T2, PROTEN vs PROT_EN). The integration netlist must reconcile them.
- **LOAD_SEL2** is now spare.
- **The resistor value and the settle phases** need the bench (§6).
- **Image sharing** to shrink the flash.

**Part-name correction (2026-11-19):** there is no 74LVC164. The select shift registers are **74LV164** (Nexperia) / **SN74LV164A** (TI), 2–5.5 V, same function and pinout; `parts.js` keeps the old key as an alias. Found while drawing the I/O card ports (IO-CARD.md).
