// clockgen.js: the machine's clock and reset generator (Kehai Interim, 2026-11-20). MIT.
// Lives on the Control card (BACKPLANE-PINOUT: CLK, SCLK, RESET come from Control). Stage 1 of the integration plan.
//
// World parts (no simulator model; their outputs are this section's inputs):
//   - the 40 MHz 3.3 V oscillator can  -> SCLK (the slot clock; also the Video card's pixel clock)
//   - MAX812 supervisor (active-high RESET, push-pull, 140 ms min after power-up; its MR input is the KERK panel's
//     reset button) -> POR
//   - LOAD, from the copy engine: the CPU is held in reset while tables load (COPY-ENGINE.md)
//   - STRETCH, the carry-cycle stretch (TIMING-BUDGET.md): driven by the ALU card from its control word (2026-11-20)
//
// What it makes:
//   - /CEDGE: low for exactly one SCLK slot per CPU cycle, the last one (slot 3, or slot 7 when the cycle is stretched).
//     Registered, so it never glitches inside a slot.
//   - CLK: the CPU clock = SCLK AND CEN. CEN is captured on SCLK's falling edge from CEDGE, so it only changes while
//     SCLK is low and the AND gate cannot glitch. CLK's rising edge is SCLK's rising edge at the end of the /CEDGE slot,
//     the same instant the SCLK-side cards sample /CEDGE (one gate delay later: a bench item, see below).
//   - /WSTB (2026-11-20, from the first gate-level timing pass): the write strobe. Low for exactly one slot, the one
//     before the /CEDGE slot: slot 2, or slot 6 when stretched. Registered on SCLK, so it never glitches. Register RAM
//     and main RAM gate their /WE with it: they write from about 55 ns (address, data and ABORT settled) until 75 ns,
//     25 ns before the CPU edge changes anything (no hold race). WSTB_NEXT = Q0 & /Q1 & (Q2 | /STRETCH): slot 1 when
//     not stretched, slot 5.
//   - RESET (active high, the backplane signal every card already reads): asserted at once by POR or LOAD through the
//     flops' async presets; released through two flops on CLK, so every card leaves reset on the same CPU edge.
//
//   - THE HALT LATCH (2026-11-21, integration finding 5: HALT didn't halt). The next-address table (Control U29) has
//     always made HALTED during a HALT word, but nothing read it, so on the whole machine HALT went on to FETCH and ran
//     the next instruction (the console workload printed "32P" from the PRNUM after its HALT). Now U206's spare half
//     captures HALTED | HALTQ on CLK, so it stays set; its /Q gates CEN's D input (U207's spare AND), so after the
//     edge that ends the HALT word CLK never rises again: the CPU stops at FETCH, as the microsim's HALT leaves it.
//     RESET clears the latch at once (/CLR from U201's spare inverter), so the KERK panel's reset button restarts the
//     machine. Interrupts don't wake it (HALT as the emulator has it). Only spare gates: no new chips.
//     Mutant HALT_IGNORED: the wiring before (CEN's D straight from CEDGE).
//
//   - THE KERK PANEL (2026-11-22): RUN/STOP, STEP and STEP-MODE come in on the backplane (FP_RUN, FP_STEP,
//     FP_STEPMODE), already debounced on the panel (MAX6817 + MAX6816), high = released/run/instruction-mode. The
//     panel's RESET button is the old HALTED pin, now FP_RESET, wired to the MAX812's manual-reset input (debounced,
//     internal 20k pull-up), a world part like POR itself.
//     - U209 ('574 on SCLK) synchronizes them: RUN1->RUN2, STEP1->STEP2->STEP3, MODE1->MODE2.
//     - STEPP = STEP3 & /STEP2: one slot per press (released -> pressed).
//     - PEND (U213 half 1, on SCLK, cleared by RESET): set by STEPP, kept until spent.
//     - ALLOW = RUN2 | PEND | (MODE2 & /ATF) | RESET: the CPU edge may happen (RESET: the reset synchronizer needs
//       CPU edges to release, so a machine powered up stopped in microcycle mode still comes out of reset). /ATF comes from the Control card's own
//       control-store slice (a spare bit, low only in the FETCH word), so in instruction mode a stopped machine runs on
//       to the next FETCH and parks there, exactly where HALT parks; in microcycle mode it stops at the next edge.
//     - The decision is made ONCE per cycle, with the write strobe: WSTB_NEXT = (slot 1 or 5) & ALLOW, and GOQ (U213
//       half 2) is WSTB one slot later, i.e. in the /CEDGE slot. CEN_D = CEDGE & /HALTQ & GOQ. So an edge always has
//       its write strobe and a withheld edge has none: a machine stopped mid-instruction never repeats a register or
//       RAM write, and a press landing between the two (slot 2) waits for the next cycle instead of tearing this one.
//     - SPENT = CEN & !(MODE2 & /ATF): the edge that uses a step up (any edge in microcycle mode, the FETCH edge in
//       instruction mode), sampled at the same SCLK rise as the CPU edge. PEND_D = STEPP | (PEND & !SPENT).
//     Mutants: PANEL_IGNORED (ALLOW tied high), STEP_NEVER_SPENT (PEND never clears), MODE_IGNORED (always
//     instruction mode).
//
// Slot counter: a '161 on SCLK, loaded with 0 at the edge that ends the /CEDGE slot. CEDGE_NEXT, the value /CEDGE takes
// for the next slot, is decoded from the count: slot 2 and not stretched, or slot 6.
//   CEDGE_NEXT = Q1 & /Q0 & (Q2 | /STRETCH)
//
// Bench items (outside a functional simulator): CLK lags SCLK by one '08 delay (1.0-4.1 ns), so an SCLK-launched
// signal captured on CLK at the same edge needs clk->Q min (1.5 ns) > that skew + hold; route SCLK to the SCLK-side
// cards through a second gate of the same '08 package so both clocks see matched delay.
'use strict';
function build(c, { mutant = null } = {}) {
  c.input('SCLK', 'POR', 'LOAD', 'STRETCH', 'FP_RUN', 'FP_STEP', 'FP_STEPMODE');
  const halt = mutant !== 'HALT_IGNORED';
  // U200: '161 slot counter. Loads 0 when /CEDGE is low (at the edge ending the /CEDGE slot); counts otherwise.
  c.add('U200', 'LVC161', { MR_N: 'VCC', CP: 'SCLK', PE_N: mutant === 'NO_RELOAD' ? 'VCC' : '/CEDGE', CEP: 'VCC', CET: 'VCC',
    D0: 'GND', D1: 'GND', D2: 'GND', D3: 'GND', Q0: 'SQ0', Q1: 'SQ1', Q2: 'SQ2', Q3: 'SQ3', TC: 'STC' });
  // U201: '04: /Q0, /STRETCH, /SCLK (for the falling-edge CEN flop), /POR-or-LOAD, spare
  c.add('U201', 'LVC04', { '1A': 'SQ0', '1Y': 'SQ0N', '2A': 'STRETCH', '2Y': 'STRN', '3A': 'SCLK', '3Y': '/SCLK',
    '4A': 'RSTREQ', '4Y': '/RSTREQ', '5A': 'SQ1', '5Y': 'SQ1N', ...(halt ? { '6A': 'RESET', '6Y': '/RESETC' } : { '6A': 'GND' }) });
  // U202: '08: Q1&/Q0, (..)&(Q2|/STRETCH), CLK = SCLK & CEN, spare
  c.add('U202', 'LVC08', { '1A': 'SQ1', '1B': mutant === 'DECODE_SLOT3' ? 'SQ0' : 'SQ0N', '1Y': 'SL2',
    '2A': 'SL2', '2B': 'LONGOK', '2Y': 'CEDGE_NEXT',
    '3A': 'SCLK', '3B': mutant === 'CLK_UNGATED' ? 'VCC' : 'CEN', '3Y': 'CLK', '4A': 'SQ0', '4B': 'SQ1N', '4Y': 'SL1' });
  // U203: '32: Q2 | /STRETCH, POR | LOAD
  c.add('U203', 'LVC32', { '1A': 'SQ2', '1B': mutant === 'STRETCH_IGNORED' ? 'VCC' : 'STRN', '1Y': 'LONGOK',
    '2A': 'POR', '2B': mutant === 'LOAD_IGNORED' ? 'GND' : 'LOAD', '2Y': 'RSTREQ',
    ...(halt ? { '3A': 'HALTED', '3B': 'HALTQ', '3Y': 'HALT_D' } : { '3A': 'GND', '3B': 'GND' }), '4A': 'GND', '4B': 'GND' });
  // U204: '74. Half 1 registers /CEDGE on SCLK. Half 2 captures CEN on SCLK's falling edge (clock = /SCLK).
  c.add('U204', 'LVC74', { '1D': 'CEDGE_NEXT', '1CLK': 'SCLK', '1/CLR': 'VCC', '1/PRE': 'VCC', '1Q': 'CEDGE', '1/Q': '/CEDGE',
    '2D': halt ? 'CEN_D' : 'CEDGE', '2CLK': mutant === 'CEN_ON_RISING' ? 'SCLK' : '/SCLK', '2/CLR': 'VCC', '2/PRE': 'VCC', '2Q': 'CEN' });
  // U205: '74, reset synchronizer on CLK: presets assert RESET at once; two CPU edges of 0 release it
  c.add('U205', 'LVC74', { '1D': 'GND', '1CLK': 'CLK', '1/CLR': 'VCC', '1/PRE': '/RSTREQ', '1Q': 'RST1',
    '2D': mutant === 'ONE_FLOP_RELEASE' ? 'GND' : 'RST1', '2CLK': 'CLK', '2/CLR': 'VCC', '2/PRE': '/RSTREQ', '2Q': 'RESET' });
  // U207: '08: WSTB_NEXT = SL1 & (Q2 | /STRETCH). U206: '74 half 1 registers it on SCLK (/Q is the backplane /WSTB);
  // half 2 spare. Mutant WSTB_ALWAYS: no strobe (/WSTB tied low), the wiring before 2026-11-20.
  const pnl = mutant !== 'PANEL_IGNORED';
  c.add('U207', 'LVC08', { '1A': 'SL1', '1B': 'LONGOK', '1Y': 'WSTB_PRE', ...(halt ? { '2A': 'CEDGE', '2B': '/HALTQ', '2Y': 'CEN_D0' } : { '2A': 'CEDGE', '2B': 'VCC', '2Y': 'CEN_D0' }),
    '3A': 'CEN_D0', '3B': pnl ? 'GOQ' : 'VCC', '3Y': 'CEN_D', '4A': 'WSTB_PRE', '4B': pnl ? 'ALLOW' : 'VCC', '4Y': 'WSTB_NEXT' });
  // ---- the KERK panel (2026-11-22): see the header ----
  c.add('U209', 'LVC574', { CLK: 'SCLK', '/OE': 'GND', D1: 'FP_RUN', Q1: 'RUN1', D2: 'RUN1', Q2: 'RUN2', D3: 'FP_STEP', Q3: 'STEP1', D4: 'STEP1', Q4: 'STEP2',
    D5: 'STEP2', Q5: 'STEP3', D6: mutant === 'MODE_IGNORED' ? 'VCC' : 'FP_STEPMODE', Q6: 'MODE1', D7: 'MODE1', Q7: 'MODE2', D8: 'GND' });
  c.add('U210', 'LVC04', { '1A': 'STEP2', '1Y': '/STEP2', '2A': 'IDLEOK', '2Y': 'SPSEL', '3A': 'SPENT', '3Y': '/SPENT', '4A': 'GND', '5A': 'GND', '6A': 'GND' });
  c.add('U211', 'LVC08', { '1A': 'STEP3', '1B': '/STEP2', '1Y': 'STEPP', '2A': 'MODE2', '2B': 'CW_/ATF', '2Y': 'IDLEOK',
    '3A': 'CEN', '3B': 'SPSEL', '3Y': 'SPENT', '4A': 'PEND', '4B': mutant === 'STEP_NEVER_SPENT' ? 'VCC' : '/SPENT', '4Y': 'PKEEP' });
  c.add('U212', 'LVC32', { '1A': 'RUN2', '1B': 'PEND', '1Y': 'RUNPEND', '2A': 'RUNPEND', '2B': 'IDLEOK', '2Y': 'ALLOW0', '3A': 'STEPP', '3B': 'PKEEP', '3Y': 'PEND_D', '4A': 'ALLOW0', '4B': 'RESET', '4Y': 'ALLOW' });
  c.add('U213', 'LVC74', { '1D': 'PEND_D', '1CLK': 'SCLK', '1/CLR': halt ? '/RESETC' : 'VCC', '1/PRE': 'VCC', '1Q': 'PEND', '2D': 'WSTB', '2CLK': 'SCLK', '2/CLR': 'VCC', '2/PRE': 'VCC', '2Q': 'GOQ' });
  c.add('U206', 'LVC74', { '1D': 'WSTB_NEXT', '1CLK': 'SCLK', '1/CLR': 'VCC', '1/PRE': 'VCC', '1Q': 'WSTB', '1/Q': mutant === 'WSTB_ALWAYS' ? 'WSTB_UNUSED' : '/WSTB',
    ...(halt ? { '2D': 'HALT_D', '2CLK': 'CLK', '2/CLR': '/RESETC', '2/PRE': 'VCC', '2Q': 'HALTQ', '2/Q': '/HALTQ' } : { '2D': 'GND', '2CLK': 'GND', '2/CLR': 'VCC', '2/PRE': 'VCC' }) });
  if (mutant === 'WSTB_ALWAYS') c.add('U208', 'LVC04', { '1A': 'VCC', '1Y': '/WSTB', '2A': 'GND', '3A': 'GND', '4A': 'GND', '5A': 'GND', '6A': 'GND' });
  // RN200: pull-downs so these lines can never float: IRQSET3/IRQSET4. (STRETCH had one until 2026-11-20; the ALU card
  // now drives it from an inverter that is always on, and its pipeline's pull-ups make it 0 in RESET.) (Triton 4's disk and network interrupts have no source on this bare-ports machine).
  c.add('RN200', 'RPACK8G', { P2: 'IRQSET3', P3: 'IRQSET4' });
  return c;
}
module.exports = { build, MUTANTS: ['NO_RELOAD', 'DECODE_SLOT3', 'CLK_UNGATED', 'STRETCH_IGNORED', 'LOAD_IGNORED', 'CEN_ON_RISING', 'ONE_FLOP_RELEASE', 'WSTB_ALWAYS', 'HALT_IGNORED', 'PANEL_IGNORED', 'STEP_NEVER_SPENT', 'MODE_IGNORED'] };
