#!/bin/bash
# whole-machine regression on the event-driven settle + the halt latch (2026-11-21)
cd "$(dirname "$0")/.."   # needs TRITON_DIR, a ConsciousNode/Triton checkout (see triton-dir.js)
R() { echo "## $*"; "$@" 2>&1 | grep -v "^ *at \|^[0-9]*: UPC\|^bus drivers" | tail -n 30; }
R node integration/program-lockstep.js directed
R node integration/program-lockstep.js random 12
R node integration/program-lockstep.js traps
R node integration/program-lockstep.js trapsrandom 8
R node integration/program-lockstep.js timer
echo "## mutants (each must fail)"
for m in ALU:CARRY_SKIP ALU:RAILS_SWAPPED_R7 Registers:SLOT_BITS_SWAPPED Memory:CHUNK_OFF_BY_ONE Memory:MDR_LANE_RAILS Control:PC_CARRY_SKIP Control:COND_IGNORED Control:DISPATCH_BIT_SWAP Control:NO_RESET_VECTOR clockgen:HALT_IGNORED; do
  echo "### $m (directed)"; MACHINE_MUTANT=$m node integration/program-lockstep.js directed 2>&1 | tail -n 2; done
for m in Control:TRAP_BAD_WIRED_WRONG Control:PSW_ENTER_IGNORED Memory:WRITE_NOT_BLOCKED Memory:FK_INVERTED Memory:CHK3_USES_SINGLE Registers:ABORT_IGNORED ALU:ESRV_PRIV_IE_SWAPPED Memory:MAR_IGNORES_ABORT; do
  echo "### $m (traps)"; MACHINE_MUTANT=$m node integration/program-lockstep.js traps 2>&1 | tail -n 2; done
echo "### IO:CON_NO_STALL (poop)"; MACHINE_MUTANT=IO:CON_NO_STALL node integration/program-lockstep.js poop 2>&1 | tail -n 2
echo "### clockgen:HALT_IGNORED (console)"; MACHINE_MUTANT=clockgen:HALT_IGNORED node integration/program-lockstep.js console 2>&1 | tail -n 2

R node integration/program-lockstep.js poop
R node integration/program-lockstep.js console
echo DONE
