# place_extract.py: a placed board as JSON for place_sa.js (Kehai Interim, 2026-11-27). MIT.
# usage: python3 kicad/place_extract.py <board.kicad_pcb> <out.json>
import sys, json, pcbnew
b = pcbnew.LoadBoard(sys.argv[1]); out = {'chips': [], 'fixed': {}, 'caps': {}}
POWER = {'GND', '+3V3', '+5V', ''}
fps = list(b.GetFootprints())
for fp in fps:
    r = fp.GetReference(); p = fp.GetPosition()
    if r == 'J1':
        for pd in fp.Pads():
            if pd.GetNetname() not in POWER: out['fixed'].setdefault(pd.GetNetname(), []).append([pd.GetPosition().x / 1e6, pd.GetPosition().y / 1e6])
        continue
    if r.startswith('C') and fp.GetValue() == '100n': continue
    bb = fp.GetBoundingBox(False, False)
    out['chips'].append({'ref': r, 'fpid': fp.GetFPIDAsString(), 'side': 'B' if fp.GetLayer() == pcbnew.B_Cu else 'F',
        'x': p.x / 1e6, 'y': p.y / 1e6, 'rot': fp.GetOrientationDegrees(), 'w': bb.GetWidth() / 1e6, 'h': bb.GetHeight() / 1e6,
        'tht': any(pd.GetDrillSize().x > 0 for pd in fp.Pads()),
        'pads': [[pd.GetPosition().x / 1e6 - p.x / 1e6, pd.GetPosition().y / 1e6 - p.y / 1e6, pd.GetNetname()] for pd in fp.Pads() if pd.GetNetname() not in POWER]})
json.dump(out, open(sys.argv[2], 'w'))
print(len(out['chips']), 'chips;', len(out['fixed']), 'connector nets')
