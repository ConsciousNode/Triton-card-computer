# place_apply.py: write place_sa.js's result onto the board (Kehai Interim, 2026-11-27). MIT.
# usage: python3 kicad/place_apply.py <board.kicad_pcb> <extract.json> <sa result.json> <out.kicad_pcb>
# Decoupling caps stay where they are: they belong to the slot (swaps only trade same-footprint parts between slots,
# and each slot's cap is already on its face). Each part goes to its new slot; a part that changed face is flipped (left-right, as place_sa.js models it); a turned
# part is rotated 180 degrees. Every signal pad's position is then checked against the model's prediction, and parts are
# checked for overlaps face by face (through-hole parts on both).
import sys, json, math, pcbnew
src, exj, saj, out = sys.argv[1:5]
b = pcbnew.LoadBoard(src); ex = {c['ref']: c for c in json.load(open(exj))['chips']}; res = json.load(open(saj))
V = lambda x, y: pcbnew.VECTOR2I(int(round(x * 1e6)), int(round(y * 1e6)))
fp_by = {f.GetReference(): f for f in b.GetFootprints()}
# decoupling caps: each belongs to the nearest chip (as build_card placed them beside their owner)
chips = [f for f in b.GetFootprints() if f.GetReference() in ex]
caps = {}
for C in b.GetFootprints():
    if not (C.GetReference().startswith('C') and C.GetValue() == '100n'): continue
    cp = C.GetPosition()
    own = min(chips, key=lambda f: math.hypot(f.GetPosition().x - cp.x, f.GetPosition().y - cp.y))
    caps.setdefault(own.GetReference(), []).append(C)
bad = 0
for r in res['chips']:
    f = fp_by[r['ref']]; old = f.GetPosition(); mates = caps.get(r['ref'], [])
    rel = [(C, C.GetPosition().x - old.x, C.GetPosition().y - old.y) for C in mates]
    new = V(r['x'], r['y'])
    if r['flipped']:
        f.Flip(old, True)
    if r['turned']:
        f.SetOrientationDegrees((f.GetOrientationDegrees() + 180) % 360)
    f.SetPosition(new)
    sx = (-1 if r['flipped'] else 1) * (-1 if r['turned'] else 1); sy = -1 if r['turned'] else 1
    # check every signal pad against the model
    e = ex[r['ref']]
    got = sorted((round(p.GetPosition().x / 1e6, 3), round(p.GetPosition().y / 1e6, 3), p.GetNetname()) for p in f.Pads() if p.GetNetname() not in ('GND', '+3V3', '+5V', ''))
    want = sorted((round(r['x'] + sx * dx, 3), round(r['y'] + sy * dy, 3), n) for (dx, dy, n) in e['pads'])
    if any(abs(g[0] - w[0]) > 0.002 or abs(g[1] - w[1]) > 0.002 or g[2] != w[2] for g, w in zip(got, want)) or len(got) != len(want):
        bad += 1
        if bad < 4: print('PAD MISMATCH', r['ref'], got[:2], want[:2])
boxes = []
for f in b.GetFootprints():
    if f.GetReference() == 'J1': continue
    bb = f.GetBoundingBox(False, False); tht = any(pd.GetDrillSize().x > 0 for pd in f.Pads())
    for lay in ((pcbnew.F_Cu, pcbnew.B_Cu) if tht else (f.GetLayer(),)):
        boxes.append((lay, bb.GetX(), bb.GetY(), bb.GetRight(), bb.GetBottom(), f.GetReference()))
ov = [(a[5], c[5]) for i, a in enumerate(boxes) for c in boxes[i + 1:] if a[0] == c[0] and a[1] < c[3] and c[1] < a[3] and a[2] < c[4] and c[2] < a[4]]
ebb = b.GetBoardEdgesBoundingBox(); outside = [f.GetReference() for f in b.GetFootprints() if not ebb.Contains(f.GetBoundingBox(False, False))]
print(f'{bad} parts with pad mismatches; {len(ov)} overlaps {ov[:6]}; {len(outside)} outside the board {outside[:5]}')
if bad or ov or outside: sys.exit(1)
pcbnew.SaveBoard(out, b)
