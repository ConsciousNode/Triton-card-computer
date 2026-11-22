# render_routed.py: a picture of a routed card, every signal layer in its own colour (Kehai Interim, 2026-11-22). MIT.
# usage: python3 kicad/render_routed.py <board-routed.kicad_pcb> <out.svg> [title]
import sys, pcbnew
b = pcbnew.LoadBoard(sys.argv[1]); out = sys.argv[2]; title = sys.argv[3] if len(sys.argv) > 3 else ''
bb = b.GetBoardEdgesBoundingBox(); W, H = pcbnew.ToMM(bb.GetWidth()), pcbnew.ToMM(bb.GetHeight()); S = 6.0
COL = {pcbnew.F_Cu: '#e0533c', pcbnew.In2_Cu: '#e8c547', pcbnew.In3_Cu: '#4fbf6f', pcbnew.B_Cu: '#4f8fe6'}
NAME = {pcbnew.F_Cu: 'top', pcbnew.In2_Cu: 'inner 2', pcbnew.In3_Cu: 'inner 3', pcbnew.B_Cu: 'bottom'}
X = lambda v: (pcbnew.ToMM(v) - pcbnew.ToMM(bb.GetX())) * S; Y = lambda v: (pcbnew.ToMM(v) - pcbnew.ToMM(bb.GetY())) * S
o = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -18 {W * S + 8} {H * S + 40}" width="{int(W * S + 8)}" height="{int(H * S + 40)}">',
     f'<rect x="-4" y="-18" width="{W * S + 8}" height="{H * S + 40}" fill="#0e1116"/>',
     f'<rect x="0" y="0" width="{W * S}" height="{H * S}" rx="6" fill="#123524" stroke="#c9b26b" stroke-width="2"/>',
     f'<text x="{W * S - 6}" y="-5" fill="#c9b26b" font-family="monospace" font-size="13" text-anchor="end">{title}</text>']
tracks = sorted([t for t in b.GetTracks() if t.Type() == pcbnew.PCB_TRACE_T], key=lambda t: {pcbnew.B_Cu: 0, pcbnew.In3_Cu: 1, pcbnew.In2_Cu: 2, pcbnew.F_Cu: 3}.get(t.GetLayer(), 0))
for fp in b.GetFootprints():
    f = fp.GetBoundingBox(False, False)
    if fp.GetReference() != 'J1' and fp.GetLayer() == pcbnew.F_Cu:
        o.append(f'<rect x="{X(f.GetX()):.1f}" y="{Y(f.GetY()):.1f}" width="{pcbnew.ToMM(f.GetWidth()) * S:.1f}" height="{pcbnew.ToMM(f.GetHeight()) * S:.1f}" fill="#1a1c20" stroke="#3a3f47" stroke-width="0.8"/>')
for t in tracks:
    o.append(f'<line x1="{X(t.GetStart().x):.1f}" y1="{Y(t.GetStart().y):.1f}" x2="{X(t.GetEnd().x):.1f}" y2="{Y(t.GetEnd().y):.1f}" stroke="{COL.get(t.GetLayer(), "#999")}" stroke-width="{max(0.9, pcbnew.ToMM(t.GetWidth()) * S):.2f}" stroke-linecap="round" opacity="0.92"/>')
for fp in b.GetFootprints():
    for pd in fp.Pads():
        px, py = X(pd.GetPosition().x), Y(pd.GetPosition().y); sz = pd.GetSize(); pw, ph = pcbnew.ToMM(sz.x) * S, pcbnew.ToMM(sz.y) * S
        if pd.GetOrientationDegrees() % 180 == 90: pw, ph = ph, pw
        if pd.GetShape() == pcbnew.PAD_SHAPE_CIRCLE: o.append(f'<circle cx="{px:.1f}" cy="{py:.1f}" r="{pw / 2:.1f}" fill="#d8b04a"/><circle cx="{px:.1f}" cy="{py:.1f}" r="{pw / 4:.1f}" fill="#0e1116"/>')
        elif fp.GetLayer() == pcbnew.F_Cu: o.append(f'<rect x="{px - pw / 2:.1f}" y="{py - ph / 2:.1f}" width="{pw:.1f}" height="{ph:.1f}" fill="#d8b04a"/>')
for v in b.GetTracks():
    if v.Type() == pcbnew.PCB_VIA_T:
        r = pcbnew.ToMM(v.GetWidth()) * S / 2; o.append(f'<circle cx="{X(v.GetPosition().x):.1f}" cy="{Y(v.GetPosition().y):.1f}" r="{r:.1f}" fill="#cfd6dd"/><circle cx="{X(v.GetPosition().x):.1f}" cy="{Y(v.GetPosition().y):.1f}" r="{r / 2:.1f}" fill="#0e1116"/>')
for fp in b.GetFootprints():
    if fp.GetReference() == 'J1' or fp.GetReference().startswith('C') or fp.GetLayer() != pcbnew.F_Cu: continue
    f = fp.GetBoundingBox(False, False); cx, cy = X(f.GetX() + f.GetWidth() // 2), Y(f.GetY() + f.GetHeight() // 2)
    o.append(f'<text x="{cx:.1f}" y="{cy:.1f}" fill="#ffffff" font-family="monospace" font-size="11" font-weight="bold" text-anchor="middle" stroke="#0e1116" stroke-width="2.5" paint-order="stroke">{fp.GetReference()}</text>')
n = sum(1 for t in tracks); nv = sum(1 for v in b.GetTracks() if v.Type() == pcbnew.PCB_VIA_T)
leg = '  '.join(f'<tspan fill="{c}">■ {NAME[l]}</tspan>' for l, c in COL.items())
o.append(f'<text x="6" y="{H * S + 16}" font-family="monospace" font-size="11" fill="#8fa1b3">{leg}  <tspan fill="#cfd6dd">● via</tspan>  · {n} track segments, {nv} vias · inside: GND plane (layer 2) and +3V3 plane (layer 5)</text>')
o.append('</svg>'); open(out, 'w').write('\n'.join(o))
