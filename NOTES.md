# Working notes (platform track), as logged 2026-11-17 onward
- `PCB-PRICING-RECON-testsuo.md`: pricing recon by Testsuo, 2026-11-17, as delivered. Kehai's check: area math
  (24.8 sq in per 100 × 160 mm board), OSH Park totals ($124 / $868 / $248) and the BOM column sums ($97 / $332) all
  recompute exactly; the US de minimis exemption did end for all countries on 2025-08-29 (China/HK on 2025-05-02).
  JLCPCB/PCBWay figures are Testsuo's own labelled estimates (±30%).
- **RAM measured (2026-11-17, `ramprobe.js`, run from Triton/desktop/tests):** TritOS Desktop 1.1.2 with all 8 task slots
  running, 8.85M instructions: highest RAM address in use 1,395,305 trytes, 253,372 non-zero. Memory-map ceiling
  (DESKTOP.md): 1,653,371 trytes = ~35% of T3's default 4,782,969. Plan: 4M trytes (8 × 1M×16 SRAM, e.g. AS6C1616,
  3.3 V) with dense address conversion (ROM partials + binary adders).
- **Speed target:** TritOS is paced at RATE = 200 instructions per virtual ms (200k instr/s = browser feel). Aim
  400k–1M instr/s: ALU tables shadowed from flash into 10–15 ns SRAM at power-up; 3–5 micro-steps per common instruction.
- **Instruction mix (2026-11-17, `tritos_instruction_mix.json`):** 3M instructions of TritOS Desktop 1.1.2, all 8 task
  slots open + typing. Block moves (BCOPY/BFILL, one tryte per step) 38.9%; loads/stores/stack 20.4%; compare & branch
  19.5%; add/sub/load-constant 12.6%; shifts 2.8%; call/return/trap 2.5%; mul/div 1.7%; I/O & SPR 1.5%; tritwise logic 0%.
  47 of 69 opcodes seen. Board implication: memory + address increment speed dominate; give block moves a 1–2 micro-step
  path; mul/div can be slow microcoded loops. Charted in the sketch doc.
- **Video draft (2026-11-17):** in the sketch doc. 729×486, 9 levels per colour. Discrete card: framebuffer in fast SRAM
  (12 dual-rail bits/pixel ≈ 4.25 Mbit), 800×600 VGA at 40 MHz with the picture centred 1:1, memory interleaved 2× pixel
  rate for CPU writes. Dual-rail resistor DAC: p wires and inverted n wires, weights 3:3:1:1 → exactly 9 even levels
  (checked); 1% resistors keep every step within ~4.5% of ideal. Option A (microcontroller draws the screen, packed 10
  bits/pixel ≈ 443 KB) as quick first light.
- **Video: option B chosen** (Kham, 2026-11-17); option A only as bring-up first light.
- **I/O + storage draft (2026-11-17):** in the sketch doc. Microcontroller bridge answers all 28 ports (console USB-serial,
  timer, PS/2 kbd/mouse, microSD disk images with DMA, StudioNet over Wi-Fi/Ethernet relay). Disk image = 2 bytes/tryte,
  same as emulator exportDiskImage; whole disk 3,188,646 bytes. Limits for "room to spare" are ISA/FS: one fixed disk
  (2,187 sectors; Desktop files from LBA 210 = 1,441,233 trytes) and a 44-entry flat directory. Proposed DISK_UNIT port
  (units: internal, microSD images, cartridge), emulator first. Timer question: step-timed TritOS would run 2–5× fast on
  hardware → real-time 200 kHz tick mode + exact-step conformance mode. Sound absent from the ISA.
- **Decided 2026-11-17:** it's **Triton 4** (units, TritFS v2, timer mode, RTC). See TRITON-4-STORAGE-TIME.md.
