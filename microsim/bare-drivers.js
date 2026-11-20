// bare-drivers.js: TritOS-style drivers for the bare-ports card, in Triton 3 assembly (Kehai Interim, 2026-11-18). MIT.
// The ternary CPU does all of it: SD init over SPI, sector read/write (3 SD blocks per 729-tryte sector), and a PS/2
// keyboard interrupt handler that stores raw scancodes in a buffer. Constants above 9841 are loaded with LI/LMI/LHI.
'use strict';
const TM = 19683, TH = 9841;
const bal = x => { let r = ((x % TM) + TM) % TM; return r > TH ? r - TM : r; };
function ld(reg, v) { const t0 = bal(v), r1 = (v - t0) / TM, t1 = bal(r1), t2 = (r1 - t1) / TM;
  const out = [`LI ${reg}, #${t0}`]; if (t1 || t2) out.push(`LMI ${reg}, #${t1}`); if (t2) out.push(`LHI ${reg}, #${t2}`); return out.join('\n'); }

const KCOUNT = 23000, KBUF = 23003, VBR = 9000;
function drivers({ cmd0crc = 149, fast = true } = {}) { return `
SPI: OUT R1, #40
IN R1, #40
RET

; SD_CMD: R2 = command index, R3 = argument (0 .. 2^32-1). Returns R1 = R1 response (255 = no response).
SD_CMD: PUSH R4
PUSH R5
PUSH R6
PUSH R7
PUSH R8
LI R1, #255
CALLX SPI
ADDI R1, R2, #64
CALLX SPI
LI R5, #256
MOD R6, R3, R5
DIV R4, R3, R5
MOD R7, R4, R5
DIV R4, R4, R5
MOD R8, R4, R5
DIV R4, R4, R5
MOV R1, R4
CALLX SPI
MOV R1, R8
CALLX SPI
MOV R1, R7
CALLX SPI
MOV R1, R6
CALLX SPI
LI R1, #1
CMPI R2, #0
JNZX SC_C1
LI R1, #${cmd0crc}
SC_C1: CMPI R2, #8
JNZX SC_C2
LI R1, #135
SC_C2: CALLX SPI
LI R4, #10
SC_POLL: LI R1, #255
CALLX SPI
CMPI R1, #255
JNZX SC_GOT
SUBI R4, R4, #1
JNZX SC_POLL
SC_GOT: POP R8
POP R7
POP R6
POP R5
POP R4
RET

; SD_INIT: returns R1 = 0 on success, negative error code otherwise.
SD_INIT: PUSH R4
PUSH R6
LI R1, #0
OUT R1, #41
LI R4, #10
SI_DUMMY: LI R1, #255
CALLX SPI
SUBI R4, R4, #1
JNZX SI_DUMMY
LI R1, #1
OUT R1, #41
LI R2, #0
LI R3, #0
CALLX SD_CMD
CMPI R1, #1
JNZX SI_F1
LI R2, #8
LI R3, #426
CALLX SD_CMD
CMPI R1, #1
JNZX SI_F2
LI R1, #255
CALLX SPI
LI R1, #255
CALLX SPI
LI R1, #255
CALLX SPI
LI R1, #255
CALLX SPI
CMPI R1, #170
JNZX SI_F2
LI R6, #100
SI_ACMD: LI R2, #55
LI R3, #0
CALLX SD_CMD
LI R2, #41
${ld('R3', 0x40000000)}
CALLX SD_CMD
CMPI R1, #0
JZX SI_READY
SUBI R6, R6, #1
JNZX SI_ACMD
JMPX SI_F3
SI_READY: LI R2, #58
LI R3, #0
CALLX SD_CMD
CMPI R1, #0
JNZX SI_F4
LI R1, #255
CALLX SPI
LI R4, #64
DIV R1, R1, R4
LI R4, #2
MOD R1, R1, R4
MOV R4, R1
LI R1, #255
CALLX SPI
LI R1, #255
CALLX SPI
LI R1, #255
CALLX SPI
CMPI R4, #1
JNZX SI_F5
LI R1, #3
OUT R1, #41
LI R1, #0
JMPX SI_END
SI_F1: LI R1, #-1
JMPX SI_END
SI_F2: LI R1, #-2
JMPX SI_END
SI_F3: LI R1, #-3
JMPX SI_END
SI_F4: LI R1, #-4
JMPX SI_END
SI_F5: LI R1, #-5
SI_END: POP R6
POP R4
RET

; SD_RD: R2 = Triton sector, R3 = destination tryte address. Returns R1 = 0 or -1.
SD_RD: PUSH R4
PUSH R5
PUSH R6
PUSH R7
PUSH R8
MULI R4, R2, #3
MOV R7, R3
LI R8, #729
LI R6, #3
RD_BLK: LI R2, #17
MOV R3, R4
CALLX SD_CMD
CMPI R1, #0
JNZX RD_FAIL
LI R5, #1000
RD_TOK: LI R1, #255
CALLX SPI
CMPI R1, #254
JZX RD_DATA
SUBI R5, R5, #1
JNZX RD_TOK
JMPX RD_FAIL
RD_DATA: LI R5, #256
RD_PAIR: ${fast ? 'OUT R2, #47\nIN R2, #46' : 'LI R1, #255\nCALLX SPI\nMULI R2, R1, #256\nLI R1, #255\nCALLX SPI\nADD R2, R2, R1\nSUBI R2, R2, #9841'}
CMPI R8, #0
JZX RD_SKIP
ST R2, R7, #0
ADDI R7, R7, #1
SUBI R8, R8, #1
RD_SKIP: SUBI R5, R5, #1
JNZX RD_PAIR
LI R1, #255
CALLX SPI
LI R1, #255
CALLX SPI
ADDI R4, R4, #1
SUBI R6, R6, #1
JNZX RD_BLK
LI R1, #0
JMPX RD_END
RD_FAIL: LI R1, #-1
RD_END: POP R8
POP R7
POP R6
POP R5
POP R4
RET

; SD_WR: R2 = Triton sector, R3 = source tryte address. Returns R1 = 0 or -1.
SD_WR: PUSH R4
PUSH R5
PUSH R6
PUSH R7
PUSH R8
MULI R4, R2, #3
MOV R7, R3
LI R8, #729
LI R6, #3
WR_BLK: LI R2, #24
MOV R3, R4
CALLX SD_CMD
CMPI R1, #0
JNZX WR_FAIL
LI R1, #255
CALLX SPI
LI R1, #254
CALLX SPI
LI R5, #256
WR_PAIR: LI R2, #0
CMPI R8, #0
JZX WR_HAVE
LT R2, R7, #0
ADDI R7, R7, #1
SUBI R8, R8, #1
WR_HAVE: ${fast ? 'OUT R2, #46' : 'ADDI R2, R2, #9841\nLI R3, #256\nDIV R1, R2, R3\nCALLX SPI\nLI R3, #256\nMOD R1, R2, R3\nCALLX SPI'}
SUBI R5, R5, #1
JNZX WR_PAIR
LI R1, #255
CALLX SPI
LI R1, #255
CALLX SPI
LI R1, #255
CALLX SPI
LI R3, #32
MOD R1, R1, R3
CMPI R1, #5
JNZX WR_FAIL
LI R5, #10000
WR_BUSY: LI R1, #255
CALLX SPI
CMPI R1, #0
JNZX WR_NB
SUBI R5, R5, #1
JNZX WR_BUSY
JMPX WR_FAIL
WR_NB: ADDI R4, R4, #1
SUBI R6, R6, #1
JNZX WR_BLK
LI R1, #0
JMPX WR_END
WR_FAIL: LI R1, #-1
WR_END: POP R8
POP R7
POP R6
POP R5
POP R4
RET

; KBD_ISR: PS/2 keyboard, IRQ 1. Stores the raw scancode at KBUF + count (the CPU decodes scancodes, not the card).
KBD_ISR: PUSH R1
PUSH R2
PUSH R3
IN R1, #42
${ld('R2', KCOUNT)}
LW R3, R2, #0
ADD R2, R2, R3
ST R1, R2, #3
${ld('R2', KCOUNT)}
ADDI R3, R3, #1
SW R3, R2, #0
POP R3
POP R2
POP R1
IRET
`; }

// PRNUM: print R1 in decimal on the console, one character per OUT 0 (2026-11-19: the bare I/O card's console sends
// bytes; nothing on the card does radix conversion, so OUT 1's decimal print moved here). DIV truncates toward zero.
const PRNUM = `PRNUM: PUSH R1
PUSH R2
PUSH R4
PUSH R5
CMPI R1, #0
JNNX PN1
LI R2, #45
OUT R2, #0
LI R2, #0
SUB R1, R2, R1
PN1: LI R4, #0
LI R5, #10
PN2: MOD R2, R1, R5
DIV R1, R1, R5
ADDI R2, R2, #48
PUSH R2
ADDI R4, R4, #1
CMPI R1, #0
JNZX PN2
PN3: POP R2
OUT R2, #0
SUBI R4, R4, #1
CMPI R4, #0
JNZX PN3
POP R5
POP R4
POP R2
POP R1
RET`;
function testProgram(opts = {}) { const nKeys = opts.nKeys ?? 40; return `
MAIN: ${ld('R1', VBR)}
MTSPR R1, #5
LI R1, #2
MTSPR R1, #3
LI R1, #1
MTSPR R1, #2
CALLX SD_INIT
CALLX PRNUM
LI R2, #5
${ld('R3', 20000)}
CALLX SD_RD
CALLX PRNUM
LI R2, #7
${ld('R3', 21000)}
CALLX SD_WR
CALLX PRNUM
LI R2, #7
${ld('R3', 22000)}
CALLX SD_RD
CALLX PRNUM
WAITK: ${ld('R2', KCOUNT)}
LW R3, R2, #0
CMPI R3, #${nKeys}
JNX WAITK
HALT
${PRNUM}
${drivers(opts)}
VECS: .word #0
`; }
module.exports = { drivers, testProgram, ld, KCOUNT, KBUF, VBR, PRNUM };
