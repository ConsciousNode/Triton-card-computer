// flag-tables.js: the flags block's two lookup tables, written from the microsim's flag rules (microsim.js, "flags").
// 1. TRYTE SIGN (one copy per tryte of the bus, 3 chips): address = 9 trits dual-rail (bit 2i = trit i +, 2i+1 = -),
//    data bits 0..1 = sign of the tryte (+, -).
// 2. FLAG TABLE: address = FOP(3) | oldSF(2)<<3 | oldOF(2)<<5 | tryte signs s0,s1,s2 (2 each)<<7 | cout(2)<<13 |
//    shOut(2)<<15, data = SF(2) | CF(2)<<2 | OF(2)<<4. FOP: 0 ARITH, 1 CMP, 2 LOGIC, 3 MULHI, 4 OFDIV0, 5 SHOUTL, 6 SHOUTR.
'use strict';
const enc = t => t === 1 ? 1 : t === -1 ? 2 : 0, dec = b => b === 1 ? 1 : b === 2 ? -1 : 0;
const FOPS = ['ARITH', 'CMP', 'LOGIC', 'MULHI', 'OFDIV0', 'SHOUTL', 'SHOUTR'];
function tryteSign() { const m = Buffer.alloc(1 << 19);
  for (let a = 0; a < (1 << 18); a++) { let s = 0, ok = true;
    for (let i = 8; i >= 0; i--) { const b = (a >> (2 * i)) & 3; if (b === 3) { ok = false; break; } if (!s) s = dec(b); }
    m[a] = ok ? enc(s) : 0; }
  return m; }
function flagTable() { const m = Buffer.alloc(1 << 19);
  for (let a = 0; a < (1 << 17); a++) {
    const op = a & 7, f = [(a >> 3) & 3, (a >> 5) & 3, (a >> 7) & 3, (a >> 9) & 3, (a >> 11) & 3, (a >> 13) & 3, (a >> 15) & 3];
    if (op > 6 || f.some(b => b === 3)) continue;
    const [sf0, of0, s0, s1, s2, cout, shOut] = f.map(dec);
    const sign = s2 || s1 || s0; let sf = sf0, cf = 0, of = of0;
    switch (FOPS[op]) {
      case 'ARITH': sf = sign; cf = of = cout; break;
      case 'CMP': sf = cout !== 0 ? cout : sign; cf = of = cout; break;
      case 'LOGIC': sf = sign; cf = of = 0; break;
      case 'MULHI': cf = of = sign; break;                        // SF unchanged
      case 'OFDIV0': cf = 0; of = sign || 1; break;               // SF unchanged
      case 'SHOUTL': sf = sign; cf = shOut; if (of0 === 0) of = shOut; break;
      case 'SHOUTR': sf = sign; cf = shOut; of = 0; break; }
    m[a] = enc(sf) | enc(cf) << 2 | enc(of) << 4; }
  return m; }
module.exports = { tryteSign, flagTable, FOPS };
