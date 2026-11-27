# pin_swap.py: choose SRAM pin swaps on a placed card to shorten its unrouted connections (Kehai Interim, 2026-11-27). MIT.
# usage: python3 kicad/pin_swap.py <placed board.kicad_pcb> <card netlist.json from export-netlist.js> <out swaps.json>
#
# On an async SRAM, which address pin a signal reaches is a free choice, and so is which data pin. Nothing about the chip
# changes, as long as anything stored in it (a lookup table's image) is laid out to match. This script only CHOOSES the
# swaps from the placement; cards/netlist.js applies them (PINSWAP=<swaps.json>) to the netlist and remaps every
# SRAM's contents, so the simulator, the table images and the board all agree.
#
# Rules:
#   - address pins A0..An-1 permute freely among themselves (pins tied to GND included: an unused address input can
#     sit wherever it's cheapest, since it reaches the GND plane through its own fanout via);
#   - data pins IO0..IOm-1 permute freely among themselves. Every x16 part on these cards has /UB and /LB tied low (no
#     byte writes), so byte lanes don't constrain the swap;
#   - control pins (/CE /OE /WE /UB /LB), power and NC never move;
#   - only lookup tables are swapped (see below).
# Cost of putting net n on pad p: the distance from p to the nearest pad of n on ANOTHER part (0 for GND/VCC). Each
# group is solved exactly (Hungarian, scipy), sweeping all chips a few times so neighbours settle together.
# Reported: total airwire length (a minimum spanning tree per signal net, Manhattan, power nets excluded), before/after.
import sys, json, math
import pcbnew
from scipy.optimize import linear_sum_assignment
from scipy.sparse.csgraph import minimum_spanning_tree
import numpy as np
from pinouts import PARTS, RPACK_SMD
import os
if os.environ.get("RPACK_SMD"): PARTS = {**PARTS, **RPACK_SMD}   # as build_card.py: two-sided boards use SMD networks

src, netjs, outp = sys.argv[1], sys.argv[2], sys.argv[3]
SWEEPS = 4
POWER = {'GND', 'VCC', '+3V3'}
b = pcbnew.LoadBoard(src)
card = json.load(open(netjs))
chips = {c['ref']: c for c in card['chips']}

# pad positions (mm) by (ref, pad number), and each signal net's pads
pos = {}
for fp in b.GetFootprints():
    for pad in fp.Pads():
        p = pad.GetPosition(); pos[(fp.GetReference(), pad.GetNumber())] = (p.x / 1e6, p.y / 1e6)

def groups(part):
    pins = PARTS[part]['pins']
    a = sorted([k for k in pins if k[0] == 'A' and k[1:].isdigit()], key=lambda k: int(k[1:]))
    d = sorted([k for k in pins if k.startswith('IO') and k[2:].isdigit()], key=lambda k: int(k[2:]))
    return a, d

# only fixed tables (/WE tied high): their images are generated, so they can follow any swap. RAM and framebuffer chips
# keep their order, because the test harnesses read and load them by address (a swap there is free in hardware but
# would need every harness to translate addresses).
srams = [r for r, c in chips.items() if c['part'].startswith('IS61') and c['pins'].get('/WE') == 'VCC']
# current assignment: ref -> {pin name: net}
assign = {r: dict(chips[r]['pins']) for r in srams}
for r in srams:   # pins the netlist leaves unconnected count as their own "no net" entries (data pins on narrow tables)
    a, d = groups(chips[r]['part'])
    for k in a: assign[r].setdefault(k, 'GND')

def pad_of(r, pin): return str(PARTS[chips[r]['part']]['pins'][pin])

def net_pads():
    """signal net -> list of (ref, pad number), from the netlist with the current SRAM assignments"""
    m = {}
    for r, c in chips.items():
        pins = assign[r] if r in assign else c['pins']
        for pin, n in pins.items():
            if n in POWER or not n: continue
            pn = PARTS[c['part']]['pins'].get(pin) if c['part'] in PARTS else None
            if pn is None and c['part'] in RPACK_SMD: pn = RPACK_SMD[c['part']]['pins'].get(pin)
            if pn is None: continue
            m.setdefault(n, []).append((r, str(pn)))
    return m

def airwire_mm(m):
    tot = 0.0
    for n, pads in m.items():
        pts = [pos[p] for p in pads if p in pos]
        if len(pts) < 2: continue
        P = np.array(pts); D = np.abs(P[:, None, :] - P[None, :, :]).sum(-1)
        tot += minimum_spanning_tree(D + 1e-9).sum()
    return tot

before = airwire_mm(net_pads())
for sweep in range(SWEEPS):
    m = net_pads(); changed = 0
    for r in srams:
        part = chips[r]['part']
        for grp in groups(part):
            if not grp: continue
            nets = [assign[r].get(k) for k in grp]
            if all(n is None for n in nets): continue
            nets = [n if n is not None else '' for n in nets]   # '' = unconnected data pin
            cost = np.zeros((len(nets), len(grp)))
            for i, n in enumerate(nets):
                if n in POWER or n == '': continue
                others = [pos[p] for p in m.get(n, []) if p[0] != r and p in pos]
                if not others: continue
                for j, pin in enumerate(grp):
                    x, y = pos[(r, pad_of(r, pin))]
                    cost[i, j] = min(abs(x - ox) + abs(y - oy) for ox, oy in others)
            ri, ci = linear_sum_assignment(cost)
            new = {grp[j]: nets[i] for i, j in zip(ri, ci)}
            for k in grp:
                if new[k] != (assign[r].get(k) or ''):
                    changed += 1
                if new[k] == '': assign[r].pop(k, None)
                else: assign[r][k] = new[k]
    print(f'sweep {sweep + 1}: {changed} pins moved, airwire {airwire_mm(net_pads()):.0f} mm', flush=True)

after = airwire_mm(net_pads())
# the swaps as permutations: perm[k] = the ORIGINAL pin index whose net now sits on pin k (per group)
out = {'card': card['card'], 'board': src, 'airwire_mm_before': round(before, 1), 'airwire_mm_after': round(after, 1), 'chips': {}}
for r in srams:
    part = chips[r]['part']; e = {}
    for gname, grp in zip(('A', 'IO'), groups(part)):
        orig = [chips[r]['pins'].get(k, 'GND' if gname == 'A' else '') for k in grp]
        now = [assign[r].get(k, 'GND' if gname == 'A' else '') for k in grp]
        used = [False] * len(grp); perm = []
        for k, n in enumerate(now):           # match each new pin to an unused original pin carrying the same net
            j = next(j for j in range(len(grp)) if not used[j] and orig[j] == n); used[j] = True; perm.append(j)
        if perm != list(range(len(grp))): e[gname] = perm
    if e: out['chips'][r] = e
json.dump(out, open(outp, 'w'), indent=1)
print(f'{len(out["chips"])} of {len(srams)} SRAMs swapped; airwire {before:.0f} -> {after:.0f} mm ({100 * (1 - after / before):.1f}% shorter)')
