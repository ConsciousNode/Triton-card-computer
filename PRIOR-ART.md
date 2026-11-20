# Prior art and lineage: the Triton card computer

Kehai Interim with Kham, 2026-11-17. A first search, one evening's worth, not exhaustive. The point is to credit
whose shoulders we're on and to know who's working nearby, so we can say hello someday. If something here is
wrong or missing, fix it in a new commit.

## The roots

- **Thomas Fowler's calculating machine (~1840).** Built of wood, it worked in balanced ternary.
  <https://en.wikipedia.org/wiki/Ternary_computer>
- **Setun (1958–59) and Setun-70 (1967–70).** Moscow State University, led by Sergei Sobolev and Nikolay
  Brusentsov. The first modern balanced-ternary computer; about 50 were built. Setun-70 added a stack architecture
  and hardware support for structured programming.
  <https://en.wikipedia.org/wiki/Setun> · <https://en.wikipedia.org/wiki/Setun-70> ·
  <https://computer-museum.ru/english/setun.htm> · Brusentsov & Alvarez, "Ternary Computers: The Setun and the
  Setun 70" (SoRuCom 2006), <https://dl.ifip.org/IFIP-AICT-357/hal-01568401>
- **TERNAC (1973).** A ternary emulator running on a binary machine in the USA.
- **Douglas W. Jones, *The Ternary Manifesto* (U. Iowa, from 2012).** Kleene-logic gates (consensus,
  accept-anything, the 27 one-input functions), fast balanced-ternary addition and carry-lookahead, binary-coded
  ternary (BCT), and the Trillium architecture. Much of the vocabulary we reach for (TCON, TANY, TUNARY) lives
  here. <https://homepage.cs.uiowa.edu/~dwjones/ternary/>

## Closest neighbours (ternary carried on binary hardware)

- **5500FP: a 24-trit balanced-ternary RISC processor on an FPGA.** Claudio Lorenzo La Rosa, paper March 2026.
  Two binary bits per trit inside (the external bus is true −V/0/+V), open dev board, 120-instruction ISA.
  The ISA is co-designed by **Cesare Di Mauro** (© Di Mauro & La Rosa), and per the studio's 2026-11-13 notes
  it's proprietary: **no emulator or core from their ISA docs without written permission.** The nearest living
  relative: same encoding idea, different medium (FPGA, not discrete chips). Outreach is already on the Tuesday
  roster (item 15): `research/2026-11-13_ternary-hardware-contacts.md`.
  <https://zenodo.org/records/18881738> · <https://theregister.com/2026/03/18/ternary_cpu_on_fpga/> ·
  <https://www.ternary-computing.com/>
- **t729 (MrDyne, CircuitVerse).** A hobby 6/12-trit balanced-ternary CPU built in a logic simulator from ordinary
  binary gates, with binary-encoded trits. It credits Jones's pages.
  <https://circuitverse.org/users/6360/projects/t729-balanced-ternary-cpu>
- **Tiny Tapeout 03 #244, Steven Bos.** A 2-trit asynchronous balanced-ternary calculator on real silicon, using
  binary-encoded ternary. <https://tinytapeout.com/runs/tt03/244>
- **Tunguska.** A ternary emulator loosely modelled on the 6502, with 6-trit trytes, an assembler, a C compiler
  (3CC) and a small OS. The nearest software ancestor of the Triton + TritOS stack.
  <https://tunguska.sourceforge.net/>

## Ternary-native hardware (true three-level signals)

- **Thundersqueak's ternary computer** (Hackaday Prize, 2014): split-rail ternary gates.
  <https://hackaday.io/project/1043-base-3-ternary-computer-from-scratch>
- **TRIADOR**: a 3-trit computer built only from DG403-switch ternary multiplexers.
  <https://hackaday.io/project/28579-homebrew-ternary-computer>
- **3niti alpha and TERNARO (SHAOS)**: a ternary computer designed since 2004, with a simulator board, and an open
  ternary FPGA architecture. <https://hackaday.io/project/19989-3niti-alpha> ·
  <https://hackaday.io/project/159905-ternaro>
- **A balanced-ternary adder from relays** (2025–26): relays and diode matrices.
  <https://hackaday.io/project/205212-a-balanced-ternary-adder-built-from-relays>
- **Felicijan & Furber, "An asynchronous ternary logic signaling system"** (Manchester): three-level on-chip
  signalling compared against classic dual-rail. <https://apt.cs.manchester.ac.uk/publications/papers/TVLSI03_tomaz.php>

## Techniques we borrow

- **Dual-rail encoding.** A cornerstone of asynchronous ("clockless") logic design. Ours is the balanced-ternary
  flavour: a p wire and an n wire, so negation is a wire swap.
- **Microcoded CPUs from stock chips, with lookup-table ALUs in (E)EPROM.** A long homebrew tradition. Examples:
  - Warren Toomey's CSCvon8: 17 chips, an EPROM-table ALU, microcoded
    (<https://retrocomputingforum.com/t/cscvon8-a-homebrew-ttl-cpu/483>);
  - the DIP-8 TTL computer: EEPROM ALU and decode (<https://hackaday.io/project/186132-dip-8-ttl-computer>);
  - Bill Buzbee's Magic-1;
  - the Gigatron.
  
  Our LUT-slice ALU (3 trits per table chip, shadowed into fast SRAM) is this idea carried over to trits.

## What looks like ours (until a search shows otherwise)

None of the pieces are new. As far as tonight's search found, this *combination* is:

- **discrete stock chips** (not an FPGA, not three-level silicon) carrying balanced ternary on dual-rail wires;
- **a LUT-slice ALU** with free negation by rail swap and a pure-wiring trit shifter;
- **microcode proven at signal level** against our own emulator: every instruction step compared, with planted
  bugs as positive controls (`microsim/`);
- **a full software stack on top:**
  - the Triton 3/4 ISA;
  - TritOS Desktop with a crash-safe copy-on-write file system (TritFS v2);
  - StudioNet networking;
  - a resistor-DAC video card that reads trits straight to VGA;
- **all of it built in the open,** with a written record: specs, audits, errata.

Absence from a search isn't proof that no one else has done it. If someone has, they're a friend to find and
credit.

## People to say hello to someday (public project pages only)

- Claudio Lorenzo La Rosa and Cesare Di Mauro (5500FP). Already on the roster.
- Vladimir Vasiliev (Setun Telegram channel) and the MSU Laboratory of Ternary Informatics. See the 2026-11-13
  contacts note.
- Douglas W. Jones (Ternary Manifesto)
- SHAOS (3niti alpha, TERNARO)
- MrDyne (t729)
- Steven Bos (Tiny Tapeout ternary)
- the Tunguska author
