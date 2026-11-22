# Gate-level timing of the integrated card computer: first pass
**Kehai Interim, 2026-11-20.** Next step 2 of the integration plan. The paper budget (`TIMING-BUDGET.md`) added up
delays on paths I chose by hand. This pass reads the paths out of the composed netlist itself: 661 chips, six cards
and the backplane.

## Two instruments
1. **`sta.js`, static ("table mode").** It runs on every 25 ns slot of a real run. Every input a chip's model reads is
   an arc to the outputs it drives, as long as they're in the same section of the package. An SRAM address bit is an
   arc to every output bit that depends on it *anywhere* in the table. This is conservative: it keeps paths that the
   control values never let through. A "cycle mode" that only follows one-bit flips also exists, but it's too
   optimistic. It missed the carry ripple, because a carry-in change doesn't always change the carry out. So its
   numbers aren't used below.
2. **`timing-sim.js`, a worst-case timing simulation.**
   - Each slot is replayed with max delays, the way a gate-level simulator with timing data would do it. Registers
     change tco after their own clock net rises in the simulation. CLK is SCLK through the '08, so the 4.4 ns lag is
     *simulated*, not assumed.
   - It checks register setup at every edge, and **SRAM write windows**. A write window is /WE and /CE both low. Data
     must be still 5 ns before the window ends. The address must be still for the whole window, and 8 ns before it
     ends.
   - **Self-test:** after every slot, every net must hold the value machine-sim settled to. On every run below: 0 nets
     differ.
   - It is workload-based. A path the program never toggles isn't timed.
3. **Positive control.** The same run with every IS61WV5128 table 3× slower (30 ns): 55 CLK and 35 SCLK endpoints
   fail. The instrument does respond.

Delays are datasheet maximums at 3.3 V ± 0.3 V. The ones from `TIMING-BUDGET.md` cite their datasheets. **The rest
are my reading of TI, Nexperia and ISSI datasheets, not re-checked this session**, because there was no datasheet
access here. They're listed in `sta.js`: '16823 tco 4.6 / setup 2.1, '161 tco 7 / setup 5, '08/'32/'04 4.4, '153
6.5–7, CBT 0.25 data / 5–5.5 select, '245 enable 8.5, SRAM tDOE 5, write tDW 5 / tAW 8. Every marginal result below
depends on them. Check them before trusting a bench result.

Not covered: hold times (that needs min delays), wiring and backplane loading, and open-drain rise times.

## Update, 2026-11-20 late: Finding 1 fixed (Kham: yes), with the stretch
- **/WSTB**, the write strobe, sits on the backplane pin DIV0 used to have (no card used DIV0).
  - The clock generator makes it: U206 '74 + U207 '08 + a spare '04 gate. It's low for exactly one slot, the slot
    before the /CEDGE slot (slot 2, or slot 6 when stretched), and registered on SCLK.
  - Register RAM: /WE = /WRE | /WSTB (a spare gate in U3).
  - Main RAM: /RWE = (/WA | /WSTB) | FBSEL (a spare gate in U236).
  - The framebuffer path (/VWE, VBUSY) is unchanged for now. The Video card samples VBUSY a slot ahead, so its strobe
    timing needs its own design: still open.
- **STRETCH is driven:**
  - The ALU card's spare control-word bit 31 is now /STR. One '04 (U122; U120 until 2026-11-22, when the KiCad export found it shared that designator with an ESRV 3245) drives the backplane line.
  - A cycle is stretched when the word is an ADD or INCA whose result is used (BUS = ALU, or the flags). 75 of the 740
    directed microcycles were stretched.
- **Timing simulation after the fix** (directed program, 740 microcycles, 3,260 slots, self-test 0):
  - SRAM writes: 1,897 windows, **0 violations**, worst slack +34.4 ns. The register slot address settles at 25.5 ns;
    the window is 59.9–84.9 ns.
  - CPU-clock registers: 0 violations, worst +43.3 ns.
  - The three 25 ns paths are unchanged (Finding 3).
- **Both halves are needed, and each mutant proves it:**
  - `clockgen:WSTB_ALWAYS` (no strobe): 17 write violations, worst −491 ns. That's the old behavior.
  - `ALU:NO_STRETCH` (strobe, no stretch): the ADC's 7-slice ripple reaches the register RAM at 81.9 ns, needed by
    79.9 ns (−2.0 ns). A full 9-slice ripple would miss by about 20 ns.
- **Tests:**
  - Clock generator: the oracle now also requires /WSTB low exactly in the slot before /CEDGE. 22/22 cases, 8/8
    mutants.
  - Whole machine: directed matches, random matches.
  - Card tests (their harnesses hold /WSTB active, declared): Registers 300K microcycles, Memory 100K, ALU 100K, all
    0 mismatches.

## Results of the first pass (before the fix; directed program: 67 instructions, 794 microcycles, 3,176 slots)
Files: `RESULTS-timing-sim.txt`, `RESULTS-sta-table.txt`.

### Finding 1 (fixed, see the update above): no write strobes. The register RAM and main RAM wrote for as long as /WE was a decoded level.
- **What the netlist does:**
  - Registers card: /WE = /WRE = CW_/WR | SPRNR | ABORT.
  - Memory card: /RWE = CW_/MWR | ABORT | FBSEL.
  - Both are levels for the whole microcycle. Neither is gated by any clock or slot.
- **What the timing simulation shows:**
  - The write window runs from one microword into the next. Register RAM's /WE stays low until about 20 ns after
    the next CPU edge.
  - RSLOT (the address) changes at 16 ns. That's inside the window (slack −296 ns: the address isn't still for the
    window at all). On a board, the next word's slot gets the data too.
  - Main RAM: the address moves during the window (−201 ns), and data changes 4.7 ns too late (−4.7 ns).
- **Why nothing caught it before:**
  - The functional simulation writes with settled values.
  - REGISTERS-CARD.md already said the strobe ("/WE = /WRE OR CLK") would be drawn "at schematic time".
  - With the clock generator as built, CLK is a 12.5 ns pulse, not half the cycle, so that sentence no longer
    describes a working strobe.
- **Proposed fix (not made: it touches three cards and a backplane pin, so it's your call):**
  - A write strobe on the backplane, /WSTB, low for the last two slots of the microcycle (50 ns through the CPU edge).
    That's 4 of 8 slots when stretched.
  - Make it on the Control card from the slot counter (SQ1 & /SQ0-style decode, registered on SCLK so it's
    glitch-free).
  - Gate each /WE as /WE = /WRE | /WSTB.
  - The backplane is full, but DIV0 and PROT are unused. One of them becomes /WSTB.
  - VRAM-C and VRAM-S writes and the VBUSY timing the Video card expects ("VBUSY in the second half") would come from
    the same strobe. The Video card test assumed that half; the Memory card as drawn doesn't produce it.
- **Knock-on effect:** with a strobe ending at the CPU edge, the long carry ripple has to finish before the strobe
  closes. That's exactly what the carry stretch is for, and STRETCH is still pulled low (nothing drives it). The ADC
  in the directed program ripples 7 slices inside its own cycle (C6 at 76 ns here). A full 9-slice ripple into the
  register RAM would miss a 100 ns strobe. So the strobe and the STRETCH driver need to go in together.

### Finding 2: registered endpoints in the CPU clock domain meet 100 ns on this workload
- **Result:** worst slack +33 ns, 410 endpoints changed. The latest is the flag register: B_NEG → slice tables → bus
  → flag tables, at 69 ns.
- **Why the ripple doesn't show here:** the ALU computes as soon as its operands latch (ALU_FN defaults to ADD), so
  in most words the ripple has settled before the word that consumes it. The ripple that does land in its own cycle
  (ADC, CIN = CF) feeds the register RAM, so Finding 1 is where it bites.
- **Static view (table mode):** the worst structural chain is 207 ns. It runs carry ripple → bus → the SPR-latch
  tables → IRQ lookahead (U100) → next address → every card's control store. The control values block it, though:
  the latch tables only pass the bus when CW_SPRWR is set.
  - Worth a design note: the IRQ redirect decision (IRQN) is computed from the latches' *next* values. So in a word
    that writes IMASK/IPEND/IE from the bus, the next-address path really does start at the bus. If such a word ever
    takes its bus value from a rippling ADD, the cycle would need the stretch.
  - Today the SPR writes take their value through PASSA with no carry, so that case doesn't happen.

### Finding 3: three SCLK-domain (25 ns) paths are marginal, all depending on unverified numbers
| Path | Slack |
| --- | --- |
| I/O card timer prescaler: '161 TC → '161 CET → TICK → 2 gates → '161 /PE | −2.8 ns |
| Video vertical counter: HC → line-end table → vertical-next table → '16823 (two tables in one slot) | −1.7 ns |
| I/O card counters' /PE from RESET (CLK → U205 → RESET → table) | +0.1 ns |

With 8 ns SRAMs (ISSI's figure at 3.3 V ± 10%) the video path has 2.3 ns of slack. The '161 numbers are the softest in
the table. These need real datasheet values. If they're still short, the fix is one pipeline register each.

### Finding 4 (static only): the Video card's control word, and its fill engine's enable, are sampled every slot
- **The microword register:** Video.U2 is a '16823 on SCLK with /CLKEN tied low. It loads the Video card's control
  word at every 25 ns edge, but UA (hence CSD) only settles at about 42–52 ns. So in slots 0–1 the Video card's
  control word is the old one, or whatever is mid-change.
- **The fill-engine enable:** U17/U18's /CLKEN comes from ABORT → /VWE → VBUSY → FREE, which settles at about 75 ns.
- **Coverage gap:** the directed program does no I/O, so these weren't toggled in the timing simulation. Stage 3's
  I/O programs will time them.
- **Fix if they fail:** register the Video card's control word on CLK like every other card, or enable U2 only on the
  CPU-edge slot. Then derive FREE from a strobe-qualified VBUSY (Finding 1).

### Also seen
- **The clock lag is real and measured:** CLK rises 4.4 ns after SCLK. Every CLK-domain endpoint was judged against
  that lag.
- **A structural loop through two Video tables** (U9 CNTRST ↔ U22 FDONE, via U20 WRAPX). By the tables' contents
  neither output depends on the other, so it can't latch. Async SRAM outputs may still glitch on any address change,
  though. Breaking it (FDONE and WRAPX don't need CNTRST as an address) would make it clean by construction.

## What's next for timing
1. Done: /WSTB and STRETCH (above). Still open: the framebuffer path's strobe and the Video card's VBUSY timing.
2. Get real datasheet numbers for the soft entries. Add min delays and a hold check.
3. Run the timing simulation over the I/O programs (stage 3) to cover Finding 4.
