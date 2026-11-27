# apply_pin_swap.py: put a card's SRAM pin swaps onto its placed board (Kehai Interim, 2026-11-27). MIT.
# usage: python3 kicad/apply_pin_swap.py <placed board.kicad_pcb> <swapped card netlist.json> <out.kicad_pcb>
# The swapped netlist comes from PINSWAP=<swaps.json> node kicad/export-netlist.js <Card>: the same file the
# simulator ran against. Every SRAM pad's net is set from it, then EVERY pad on the board is checked against that
# netlist, so the board and the tested netlist can't drift apart. Placement is untouched.
import sys, json
import pcbnew
from pinouts import PARTS, RPACK_SMD
import os
if os.environ.get("RPACK_SMD"): PARTS = {**PARTS, **RPACK_SMD}   # as build_card.py: two-sided boards use SMD networks
src, netjs, out = sys.argv[1:4]
PWR = {'VCC': '+3V3', 'GND': 'GND'}
b = pcbnew.LoadBoard(src); card = json.load(open(netjs)); chips = {c['ref']: c for c in card['chips']}
nets = {}
def net(name):
    name = PWR.get(name, name)
    n = b.FindNet(name)
    if n is None: n = pcbnew.NETINFO_ITEM(b, name); b.Add(n)
    return n
changed = 0
for fp in b.GetFootprints():
    r = fp.GetReference(); c = chips.get(r)
    if not c or not c['part'].startswith('IS61'): continue
    tab = PARTS[c['part']]['pins']; bypad = {str(v): k for k, v in tab.items()}
    for pad in fp.Pads():
        pin = bypad.get(pad.GetNumber())
        if pin is None or not (pin[0] == 'A' and pin[1:].isdigit() or pin.startswith('IO')): continue
        want = c['pins'].get(pin)
        if want is None:                       # unconnected data pin
            if pad.GetNetname() != '': pad.SetNetCode(0); changed += 1
        elif pad.GetNetname() != PWR.get(want, want): pad.SetNet(net(want)); changed += 1
# check every pad of every netlisted chip
bad = 0
for fp in b.GetFootprints():
    r = fp.GetReference(); c = chips.get(r)
    if not c: continue
    tab = (PARTS.get(c['part']) or RPACK_SMD.get(c['part']))['pins']
    for pin, n in c['pins'].items():
        if pin not in tab: continue
        pad = fp.FindPadByNumber(str(tab[pin]))
        if pad is None or pad.GetNetname() != PWR.get(n, n):
            bad += 1
            if bad <= 5: print('MISMATCH', r, pin, n, pad.GetNetname() if pad else None)
print(f'{changed} SRAM pads re-netted; {bad} pads disagree with the netlist')
if bad: sys.exit(1)
pcbnew.SaveBoard(out, b)
