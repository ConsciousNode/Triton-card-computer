# build_card.py: one card of the Triton card computer as a KiCad 7 board (Kehai Interim, 2026-11-22). MIT.
# usage: python3 kicad/build_card.py <card.json from export-netlist.js> <out dir>
# Builds a 3U Eurocard (160 x 100 mm, 4 copper layers), the 160-pin DIN 41612 backplane connector (rows z a b c d x 32,
# generated: KiCad's library has no 5-row part), every chip with its library footprint and package pin numbers
# (pinouts.py), a 100 nF 0603 decoupling capacitor beside each IC, nets from the integrated netlist, a first placement
# (shelf packing in netlist order: chips that the drawing groups stay together), and writes:
#   <card>.kicad_pcb, <card>-look.svg (pads, outlines, references and every airwire: the unrouted connections), stats.
# Placement is a first look, not a layout. Routing is a later step (Freerouting), and so is the pinout gate (KICAD.md).
import sys, os, json, math, re
import pcbnew
from pinouts import PARTS

FPLIB = '/usr/share/kicad/footprints'
W, H = 160.0, 100.0                      # 3U Eurocard: 160 mm deep, 100 mm high (6U: 233.35 high, argv[3])
mm = pcbnew.VECTOR2I_MM
PWR = {'VCC': '+3V3', 'GND': 'GND'}

def load_fp(spec):
    lib, name = spec.split(':'); return pcbnew.FootprintLoad(os.path.join(FPLIB, lib + '.pretty'), name)

def pinout_table(path):   # BACKPLANE-PINOUT.md rows "| n | z | a | b | c | d |"
    pins = {}
    for line in open(path):
        m = re.match(r'^\|\s*(\d+)\s*\|(.*)\|\s*$', line)
        if not m: continue
        cells = [c.strip() for c in m.group(2).split('|')]
        if len(cells) != 5: continue
        for row, sig in zip('zabcd', cells): pins[f'{row}{m.group(1)}'] = sig
    return pins

def main(js, out, height=None):
    global H
    if height: H = float(height)
    tag = '' if H == 100.0 else '-6U'
    d = json.load(open(js)); card = d['card']; os.makedirs(out, exist_ok=True)
    here = os.path.dirname(os.path.abspath(__file__)); bp = pinout_table(os.path.join(here, '..', 'BACKPLANE-PINOUT.md'))
    board = pcbnew.BOARD(); board.SetCopperLayerCount(4)
    nets = {}
    def net(name):
        name = PWR.get(name, name)
        if name not in nets: ni = pcbnew.NETINFO_ITEM(board, name); board.Add(ni); nets[name] = ni
        return nets[name]
    # outline
    for (x0, y0, x1, y1) in [(0, 0, W, 0), (W, 0, W, H), (W, H, 0, H), (0, H, 0, 0)]:
        s = pcbnew.PCB_SHAPE(board); s.SetShape(pcbnew.SHAPE_T_SEGMENT); s.SetStart(mm(x0, y0)); s.SetEnd(mm(x1, y1))
        s.SetLayer(pcbnew.Edge_Cuts); s.SetWidth(pcbnew.FromMM(0.1)); board.Add(s)
    used = set()                                   # backplane nets this card touches
    for c in d['chips']:
        for n in c['pins'].values(): used.add(n)
    # the backplane connector: 5 x 32, 2.54 mm, along the rear (left) edge; row z nearest the edge
    x0c, y0c = 4.0, (H - 31 * 2.54) / 2; jn = 0
    J = pcbnew.FOOTPRINT(board); J.SetReference('J1'); J.SetValue('DIN41612 160 (z a b c d)'); J.SetPosition(mm(x0c, y0c)); board.Add(J)
    for ri, row in enumerate('zabcd'):
        for n in range(1, 33):
            p = pcbnew.PAD(J); p.SetNumber(f'{row}{n}'); p.SetShape(pcbnew.PAD_SHAPE_CIRCLE); p.SetAttribute(pcbnew.PAD_ATTRIB_PTH)
            p.SetSize(mm(1.6, 1.6)); p.SetDrillSize(mm(1.0, 1.0)); p.SetLayerSet(p.PTHMask())
            p.SetPos0(mm(ri * 2.54, (n - 1) * 2.54)); p.SetPosition(mm(x0c + ri * 2.54, y0c + (n - 1) * 2.54)); J.Add(p)   # Pos0: what the file stores
            sig = bp.get(f'{row}{n}', '')
            if sig in ('GND', '+3V3', '+5V') or sig in used:
                p.SetNet(net(sig)); jn += 1
    # chips: same-sized parts together (sorted by footprint, then netlist order), shelf-packed with the decoupling
    # capacitor beside each IC; when the front is full, the back (footprints flipped to B.Cu)
    gap, x0 = 1.0, 18.5
    missing, placed, caps = set(), [], 0; items = []
    for i, c in enumerate(d['chips']):
        spec = PARTS.get(c['part'])
        if not spec: missing.add(c['part']); continue
        fp = load_fp(spec['fp']); fp.SetReference(c['ref']); fp.SetValue(c['part']); fp.SetPosition(mm(0, 0))
        bb = fp.GetBoundingBox(False, False); items.append((-pcbnew.ToMM(bb.GetHeight()), spec['fp'], i, c, spec, fp, bb))
    items.sort(key=lambda t: (t[0], t[1], t[2]))
    side, x, y, shelf_h, fits = 'F', x0, 2.0, 0.0, True
    for _, _, _, c, spec, fp, bb in items:
        cw = 0 if c['part'].startswith('RPACK') else 2.0          # room for the 0603 beside the chip
        w, h = pcbnew.ToMM(bb.GetWidth()) + cw, pcbnew.ToMM(bb.GetHeight())
        if x + w > W - 1.5: x, y, shelf_h = x0, y + shelf_h + gap, 0.0
        if y + h > H - 2:
            if side == 'F': side, x, y, shelf_h = 'B', x0, 2.0, 0.0
            else: fits = False
        cx = x + cw + w / 2 - cw / 2 - pcbnew.ToMM(bb.GetX() + bb.GetWidth() // 2); cy = y + h / 2 - pcbnew.ToMM(bb.GetY() + bb.GetHeight() // 2)
        fp.SetPosition(mm(cx, cy)); board.Add(fp)
        if side == 'B': fp.Flip(fp.GetPosition(), False)
        placed.append((c, fp, side))
        bynum = {}
        for pin, n in c['pins'].items():
            if pin in spec['pins']: bynum[str(spec['pins'][pin])] = n
        for pn, lst in spec['power'].items():
            for k in lst: bynum[str(k)] = pn
        for pad in fp.Pads():
            n = bynum.get(pad.GetNumber())
            if n is not None: pad.SetNet(net(n))
        if cw:
            C = load_fp('Capacitor_SMD:C_0603_1608Metric'); caps += 1; C.SetReference(f'C{caps}'); C.SetValue('100n')
            C.SetOrientationDegrees(90); C.SetPosition(mm(x + 0.9, y + h / 2)); board.Add(C)
            if side == 'B': C.Flip(C.GetPosition(), False)
            for pad in C.Pads(): pad.SetNet(net('VCC' if pad.GetNumber() == '1' else 'GND'))
        x += w + gap; shelf_h = max(shelf_h, h)
    back = sum(1 for p in placed if p[2] == 'B')
    if missing: print('NO PINOUT for', sorted(missing)); sys.exit(2)
    path = os.path.join(out, f'{card}{tag}.kicad_pcb'); board.Save(path)
    # ---- the look: my own SVG of pads, footprint outlines, references and airwires (KiCad's plots have no ratsnest)
    S = 6.0; svg = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -16 {W * S + 8} {H * S + 36}" width="{int(W * S + 8)}" height="{int(H * S + 36)}">',
                    f'<rect x="-4" y="-16" width="{W * S + 8}" height="{H * S + 36}" fill="#0e1116"/>',
                    f'<rect x="0" y="0" width="{W * S}" height="{H * S}" rx="6" fill="#1f5135" stroke="#c9b26b" stroke-width="2"/>',
                    f'<text x="{W * S - 8}" y="-3" fill="#c9b26b" font-family="monospace" font-size="13" text-anchor="end">Triton card computer · {card} card · {'3U' if H == 100.0 else '6U'} Eurocard 160 x {H:g} mm · first placement, unrouted{" · BACK SIDE (seen through the board)" if os.environ.get("LOOK_SIDE") == "B" else ""}</text>']
    pads_by_net = {}
    view = os.environ.get('LOOK_SIDE', 'F')        # F: the front (and the airwires); B: the back, seen from the front
    for fp in board.GetFootprints():
        on_back = fp.GetLayer() == pcbnew.B_Cu
        if fp.GetReference() != 'J1' and on_back != (view == 'B'): continue
        bb = fp.GetBoundingBox(False, False)
        if fp.GetReference() != 'J1':
            svg.append(f'<rect x="{pcbnew.ToMM(bb.GetX()) * S:.1f}" y="{pcbnew.ToMM(bb.GetY()) * S:.1f}" width="{pcbnew.ToMM(bb.GetWidth()) * S:.1f}" height="{pcbnew.ToMM(bb.GetHeight()) * S:.1f}" fill="#16181c" stroke="#3a3f47" stroke-width="1"/>')
        for pad in fp.Pads():
            px, py = pcbnew.ToMM(pad.GetPosition().x), pcbnew.ToMM(pad.GetPosition().y); sz = pad.GetSize()
            pw, ph = pcbnew.ToMM(sz.x), pcbnew.ToMM(sz.y)
            if pad.GetOrientationDegrees() % 180 == 90: pw, ph = ph, pw
            col = '#e0b84f' if pad.GetNetname() else '#7a6a3a'
            if pad.GetShape() == pcbnew.PAD_SHAPE_CIRCLE: svg.append(f'<circle cx="{px * S:.1f}" cy="{py * S:.1f}" r="{pw * S / 2:.1f}" fill="{col}"/>')
            else: svg.append(f'<rect x="{(px - pw / 2) * S:.1f}" y="{(py - ph / 2) * S:.1f}" width="{pw * S:.1f}" height="{ph * S:.1f}" fill="{col}"/>')
            nn = pad.GetNetname()
            if nn and nn not in ('GND', '+3V3', '+5V'): pads_by_net.setdefault(nn, []).append((px, py))
        if fp.GetReference() == 'J1' or fp.GetReference().startswith('C'): continue
        cx, cy = pcbnew.ToMM(bb.GetX() + bb.GetWidth() // 2), pcbnew.ToMM(bb.GetY() + bb.GetHeight() // 2)
        svg.append(f'<text x="{cx * S:.1f}" y="{cy * S:.1f}" fill="#e8e8e8" font-family="monospace" font-size="11" text-anchor="middle">{fp.GetReference()}</text>')
        svg.append(f'<text x="{cx * S:.1f}" y="{cy * S + 12:.1f}" fill="#8fa1b3" font-family="monospace" font-size="8" text-anchor="middle">{fp.GetValue()}</text>')
    wires = 0; wl = 0.0
    for nn, pts in (pads_by_net.items() if view == 'F' else []):   # minimum spanning tree per net (Prim): the airwires
        if len(pts) < 2: continue
        inT = [False] * len(pts); dist = [1e18] * len(pts); par = [-1] * len(pts); dist[0] = 0
        for _ in range(len(pts)):
            i = min((k for k in range(len(pts)) if not inT[k]), key=lambda k: dist[k]); inT[i] = True
            if par[i] >= 0:
                (ax, ay), (bx, by) = pts[i], pts[par[i]]; wires += 1; wl += math.hypot(ax - bx, ay - by)
                svg.append(f'<line x1="{ax * S:.1f}" y1="{ay * S:.1f}" x2="{bx * S:.1f}" y2="{by * S:.1f}" stroke="#58c4dc" stroke-opacity="0.45" stroke-width="0.8"/>')
            for k in range(len(pts)):
                if not inT[k]:
                    dd = math.hypot(pts[k][0] - pts[i][0], pts[k][1] - pts[i][1])
                    if dd < dist[k]: dist[k] = dd; par[k] = i
    svg.append(f'<text x="8" y="{H * S + 15}" fill="#8fa1b3" font-family="monospace" font-size="10">J1: DIN 41612, 160 pins (z a b c d), {jn} used · {len(placed)} chips + {caps} decoupling caps · {len(nets)} nets · {wires} airwires, {wl / 1000:.2f} m if routed straight · {len(placed) - back} chips front, {back} back · placement {"fits" if fits else "DOES NOT FIT"}</text>')
    svg.append('</svg>'); open(os.path.join(out, f'{card}{tag}-look{"-back" if view == "B" else ""}.svg'), 'w').write('\n'.join(svg))
    st = dict(card=card, height=H, chips=len(placed), caps=caps, nets=len(nets), connector_pins_used=jn, airwires=wires, airwire_m=round(wl / 1000, 2), fits=fits, back_side_chips=back)
    json.dump(st, open(os.path.join(out, f'{card}{tag}-stats.json'), 'w')); print(json.dumps(st))

if __name__ == '__main__': main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
