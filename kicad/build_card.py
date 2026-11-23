# build_card.py: one card of the Triton card computer as a KiCad 7 board (Kehai Interim, 2026-11-22). MIT.
# usage: python3 kicad/build_card.py <card.json from export-netlist.js> <out dir>
# Builds a 3U Eurocard (160 x 100 mm, 4 copper layers), the 160-pin DIN 41612 backplane connector (rows z a b c d x 32,
# generated: KiCad's library has no 5-row part), every chip with its library footprint and package pin numbers
# (pinouts.py), a 100 nF 0603 decoupling capacitor beside each IC, nets from the integrated netlist, a first placement
# (shelf packing in netlist order: chips that the drawing groups stay together), and writes:
#   <card>.kicad_pcb, <card>-look.svg (pads, outlines, references and every airwire: the unrouted connections), stats.
# Placement is a first look, not a layout. Routing is a later step (Freerouting), and so is the pinout gate (KICAD.md).
import math, sys, os, json, re
import pcbnew
from pinouts import PARTS, RPACK_SMD
if os.environ.get('RPACK_SMD'): PARTS = {**PARTS, **RPACK_SMD}   # two-sided boards: SMD resistor networks (pinouts.py)

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
    COL_FILL = float(os.environ.get('COL_FILL', '1.0'))
    missing, placed, caps = set(), [], 0; items = []
    owner = {}   # cap -> the chip it was made for (2026-11-22: chosen by nearness, C93 followed U120 onto C75 on the ALU)
    for i, c in enumerate(d['chips']):
        spec = PARTS.get(c['part'])
        if not spec: missing.add(c['part']); continue
        fp = load_fp(spec['fp']); fp.SetReference(c['ref']); fp.SetValue(c['part']); fp.SetPosition(mm(0, 0))
        bb = fp.GetBoundingBox(False, False); items.append((-pcbnew.ToMM(bb.GetHeight()), spec['fp'], i, c, spec, fp, bb))
    # ---- signal-flow placement (2026-11-22): quadratic placement (every chip pulled towards what it is wired to, net
    # cliques weighted 1/(k-1), the connector's pads fixed), then legalised into columns: chips in order of their solved
    # x, each column stacked by solved y; when the front is full, the back. PLACE=shelf: the old size-grouped shelves.
    import numpy as np
    n = len(items); ref_i = {}
    for k, it in enumerate(items): ref_i[it[3]['ref']] = k
    jpos = {}
    for pd in J.Pads():
        if pd.GetNetname(): jpos.setdefault(pd.GetNetname(), []).append((pcbnew.ToMM(pd.GetPosition().x), pcbnew.ToMM(pd.GetPosition().y)))
    members = {}
    for k, it in enumerate(items):
        for pin, nn in it[3]['pins'].items():
            nn = PWR.get(nn, nn)
            if nn in ('GND', '+3V3', '+5V', 'VCC'): continue
            members.setdefault(nn, set()).add(k)
    L = np.zeros((n, n)); bx = np.zeros(n); by = np.zeros(n)
    for nn, ks in members.items():
        fx = jpos.get(nn, []); m = len(ks) + len(fx)
        if m < 2: continue
        w = 1.0 / (m - 1); ks = list(ks)
        for i in ks:
            for j in ks:
                if i != j: L[i, i] += w; L[i, j] -= w
            for (x, y) in fx: L[i, i] += w; bx[i] += w * x; by[i] += w * y
    L += np.eye(n) * 1e-3; bx += 1e-3 * (W / 2); by += 1e-3 * (H / 2)
    sx, sy = np.linalg.solve(L, bx), np.linalg.solve(L, by)
    order = sorted(range(n), key=lambda k: (sx[k], sy[k])) if os.environ.get('PLACE', 'qp') == 'qp' else sorted(range(n), key=lambda k: (items[k][0], items[k][1], items[k][2]))
    # legalise: columns
    cols = []; cur = []; cur_h = 0.0
    for k in order:
        h = pcbnew.ToMM(items[k][6].GetHeight())
        # COL_FILL (2026-11-22): a column may fill only this share of the board's height, so the chips in it keep a
        # routing channel between them (the ALU's left column was packed at the 1 mm minimum: U84 and U83 sat 1.5 mm
        # apart and one connection between them could not be routed, by Freerouting or by local rip-up)
        if cur and cur_h + h + gap > (H - 3) * COL_FILL: cols.append(cur); cur, cur_h = [], 0.0
        cur.append(k); cur_h += h + gap
    if cur: cols.append(cur)
    slots = {}; side, x = 'F', x0
    cw_of = lambda col: max(pcbnew.ToMM(items[k][6].GetWidth()) + (0 if items[k][3]['part'].startswith('RPACK') else 2.0) for k in col)
    # routing room: spread the columns over the board's width (and the chips over each column's height), up to 12 mm
    # between columns and 6 mm between chips; a two-sided card spreads each side over the width separately
    sides = [[]]; acc = x0
    for col in cols:
        if acc + cw_of(col) > W - 1.5: sides.append([]); acc = x0
        sides[-1].append(col); acc += cw_of(col) + gap
    if len(sides) > 2: fits = False
    for si, scol in enumerate(sides[:2]):
        side = 'F' if si == 0 else 'B'; spare = W - 1.5 - x0 - sum(cw_of(c) for c in scol)
        cg = min(12.0, max(gap, spare / max(1, len(scol)))); x = x0 + max(0.0, (spare - cg * (len(scol) - 1)) / 2) if len(scol) > 1 else x0
        for col in scol:
            col.sort(key=lambda k: sy[k]); cwid = cw_of(col)
            hs = sum(pcbnew.ToMM(items[k][6].GetHeight()) for k in col); vg = min(6.0, max(gap, (H - 4 - hs) / max(1, len(col))))
            y = max(2.0, (H - hs - vg * (len(col) - 1)) / 2)
            for k in col:
                slots[k] = (side, x, y, cwid); y += pcbnew.ToMM(items[k][6].GetHeight()) + vg
            x += cwid + cg
    fits = fits if 'fits' in dir() else True
    for k, (_, _, _, c, spec, fp, bb) in enumerate(items):
        side, x, y, cwid = slots[k]
        cw = 0 if c['part'].startswith('RPACK') else 2.0
        w, h = pcbnew.ToMM(bb.GetWidth()) + cw, pcbnew.ToMM(bb.GetHeight())
        cx = x + cw + (w - cw) / 2 - pcbnew.ToMM(bb.GetX() + bb.GetWidth() // 2); cy = y + h / 2 - pcbnew.ToMM(bb.GetY() + bb.GetHeight() // 2)
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
            C.SetOrientationDegrees(90); C.SetPosition(mm(x + 0.9, y + h / 2)); board.Add(C); owner[C.GetReference()] = fp.GetReference()
            if side == 'B': C.Flip(C.GetPosition(), False)
            for pad in C.Pads(): pad.SetNet(net('VCC' if pad.GetNumber() == '1' else 'GND'))

    back = sum(1 for p in placed if p[2] == 'B')
    # ---- placement improvement (2026-11-22): simulated annealing over swaps of same-footprint chips (same side) and
    # 180-degree turns, minimising the total half-perimeter wirelength of the signal nets (power goes to the planes).
    # The connector's pads are fixed. Decoupling caps follow their chip. SA_ITERS=0 turns it off.
    import random
    iters = int(os.environ.get('SA_ITERS', '60000'))
    if iters and len(placed) > 1:
        rnd = random.Random(20261122)
        chips = [fp for (_, fp, _) in placed]
        capof = {}
        for C in board.GetFootprints():
            if C.GetReference().startswith('C') and C.GetValue() == '100n':
                cp = C.GetPosition(); best = next(f for f in chips if f.GetReference() == owner[C.GetReference()]); capof.setdefault(best.GetReference(), []).append((C, cp.x - best.GetPosition().x, cp.y - best.GetPosition().y))
        idx = {fp.GetReference(): k for k, fp in enumerate(chips)}
        pos = [[fp.GetPosition().x, fp.GetPosition().y] for fp in chips]; rot = [0] * len(chips)
        off = [[(pd.GetPosition().x - fp.GetPosition().x, pd.GetPosition().y - fp.GetPosition().y, pd.GetNetname()) for pd in fp.Pads()] for fp in chips]
        nets_of = {}
        fixed = {}
        for pd in J.Pads():
            if pd.GetNetname(): fixed.setdefault(pd.GetNetname(), []).append((pd.GetPosition().x, pd.GetPosition().y))
        for k, o in enumerate(off):
            for (_, _, n) in o:
                if n and n not in ('GND', '+3V3', '+5V'): nets_of.setdefault(n, set()).add(k)
        def hpwl(n):
            xs, ys = [], []
            for (x, y) in fixed.get(n, []): xs.append(x); ys.append(y)
            for k in nets_of[n]:
                sgn = -1 if rot[k] else 1
                for (dx, dy, nn) in off[k]:
                    if nn == n: xs.append(pos[k][0] + sgn * dx); ys.append(pos[k][1] + sgn * dy)
            return (max(xs) - min(xs)) + (max(ys) - min(ys)) if xs else 0
        cost = {n: hpwl(n) for n in nets_of}; total = sum(cost.values()); start = total
        group = {}
        for k, (c, fp, sd) in enumerate(placed): group.setdefault((fp.GetFPIDAsString(), sd), []).append(k)
        groups = [g for g in group.values()]
        T = total / max(1, len(nets_of)) * 0.5
        for it in range(iters):
            g = rnd.choice(groups); a = rnd.choice(g)
            if len(g) > 1 and rnd.random() < 0.7:
                b2 = rnd.choice(g)
                if b2 == a: continue
                pos[a], pos[b2] = pos[b2], pos[a]; touched = set()
                for (_, _, n) in off[a] + off[b2]:
                    if n in cost: touched.add(n)
                undo = lambda: pos.__setitem__(a, pos[b2]) or None
                new = {n: hpwl(n) for n in touched}; d = sum(new[n] - cost[n] for n in touched)
                if d < 0 or rnd.random() < math.exp(-d / max(T, 1)): cost.update(new); total += d
                else: pos[a], pos[b2] = pos[b2], pos[a]
            else:
                if chips[a].GetValue().startswith('RPACK'): continue   # origin at pin 1, not the centre: a turn would move its body
                rot[a] ^= 1; touched = {n for (_, _, n) in off[a] if n in cost}
                new = {n: hpwl(n) for n in touched}; d = sum(new[n] - cost[n] for n in touched)
                if d < 0 or rnd.random() < math.exp(-d / max(T, 1)): cost.update(new); total += d
                else: rot[a] ^= 1
            T *= 0.99985
        for k, fp in enumerate(chips):
            fp.SetPosition(pcbnew.VECTOR2I(int(pos[k][0]), int(pos[k][1])))
            if rot[k]: fp.SetOrientationDegrees((fp.GetOrientationDegrees() + 180) % 360)
            for (C, dx, dy) in capof.get(fp.GetReference(), []):
                sgn = -1 if rot[k] else 1; C.SetPosition(pcbnew.VECTOR2I(int(pos[k][0] + sgn * dx), int(pos[k][1] + sgn * dy)))
        print(f'placement: signal wirelength (HPWL) {start / 1e6:.0f} mm -> {total / 1e6:.0f} mm ({100 * (start - total) / start:.0f}% shorter)')
    if missing: print('NO PINOUT for', sorted(missing)); sys.exit(2)
    # ---- through-hole parts own both faces (2026-11-22): the resistor packs (SIP9) are through-hole, so their pins come
    # out on both sides; on two-sided boards back-side chips were placed under them (Control: RN2 over U10, RN7 over
    # U209) and the overlap check, which compared footprints face by face, never saw it. Each through-hole part that
    # touches anything on either face moves to the nearest spot clear on both faces (1 mm grid, 0.5 mm margin).
    def bbox_mm(f):
        bb = f.GetBoundingBox(False, False); return (pcbnew.ToMM(bb.GetX()), pcbnew.ToMM(bb.GetY()), pcbnew.ToMM(bb.GetRight()), pcbnew.ToMM(bb.GetBottom()))
    def is_tht(f): return f.GetReference() != 'J1' and any(pd.GetDrillSize().x > 0 for pd in f.Pads())
    def hit(r, q, m=0.5): return r[0] - m < q[2] and q[0] - m < r[2] and r[1] - m < q[3] and q[1] - m < r[3]
    moved_tht = 0; two_sided = any(g.GetLayer() == pcbnew.B_Cu for g in board.GetFootprints())
    for f in [f for f in board.GetFootprints() if is_tht(f)]:
        others = [bbox_mm(g) for g in board.GetFootprints() if g is not f]
        r = bbox_mm(f)
        # only on two-sided boards (one-sided boards keep their placement exactly: same-face spacing is the overlap
        # check's job); there, any through-hole part touching anything moves, which frees room for the others
        if not two_sided or not any(hit(r, q) for q in others): continue
        w, h = r[2] - r[0], r[3] - r[1]; px, py = pcbnew.ToMM(f.GetPosition().x), pcbnew.ToMM(f.GetPosition().y)
        best = None
        for yy in range(2, int(H - h - 1)):
            for xx in range(int(x0), int(W - w - 1)):
                q = (xx, yy, xx + w, yy + h)
                if any(hit(q, o) for o in others): continue
                d = math.hypot(xx - r[0], yy - r[1])
                if best is None or d < best[0]: best = (d, xx - r[0], yy - r[1])
        if best is None: print('NO ROOM for through-hole', f.GetReference()); continue
        f.SetPosition(pcbnew.VECTOR2I(int(f.GetPosition().x + best[1] * 1e6), int(f.GetPosition().y + best[2] * 1e6))); moved_tht += 1
    if moved_tht: print('through-hole parts moved clear of both faces:', moved_tht)
    # ---- decoupling caps face their pins (2026-11-22): every cap stood at 90 degrees whatever its chip's power pins
    # were doing, so on the SRAMs the cap's GND pad sat beside the +3V3 pin and the reverse, and neither pin could reach
    # the plane (4 connections the router could not make). Each cap now takes 90 or 270, whichever puts each pad
    # nearer its own net's pin on the nearest chip; same footprint box, so the placement and overlap check are unchanged.
    turned = 0
    chips_all = [fp for (_, fp, _) in placed]
    for C in board.GetFootprints():
        if not (C.GetReference().startswith('C') and C.GetValue() == '100n'): continue
        cp = C.GetPosition()
        ch = next(f for f in chips_all if f.GetReference() == owner[C.GetReference()])
        pins = [(pd.GetPosition(), pd.GetNetname()) for pd in ch.Pads() if pd.GetNetname() in ('GND', '+3V3')]
        def score():
            t = 0
            for pd in C.Pads():
                same = [q for (q, n) in pins if n == pd.GetNetname()]
                if same: t += min(math.hypot(q.x - pd.GetPosition().x, q.y - pd.GetPosition().y) for q in same)
            return t
        o0 = C.GetOrientationDegrees(); s0 = score()
        C.SetOrientationDegrees((o0 + 180) % 360)
        if score() < s0: turned += 1
        else: C.SetOrientationDegrees(o0)
    print('decoupling caps turned to face their power pins:', turned)
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
    boxes = []
    for f in board.GetFootprints():
        if f.GetReference() == 'J1': continue
        bb = f.GetBoundingBox(False, False)
        for lay in ((pcbnew.F_Cu, pcbnew.B_Cu) if is_tht(f) else (f.GetLayer(),)):       # through-hole: both faces
            boxes.append((lay, bb.GetX(), bb.GetY(), bb.GetRight(), bb.GetBottom(), f.GetReference()))
    overlaps = [(a[5], c[5]) for i, a in enumerate(boxes) for c in boxes[i + 1:] if a[0] == c[0] and a[1] < c[3] and c[1] < a[3] and a[2] < c[4] and c[2] < a[4]]
    if overlaps: print('OVERLAPS:', overlaps[:10])
    st = dict(card=card, overlaps=len(overlaps), height=H, chips=len(placed), caps=caps, nets=len(nets), connector_pins_used=jn, airwires=wires, airwire_m=round(wl / 1000, 2), fits=fits, back_side_chips=back)
    json.dump(st, open(os.path.join(out, f'{card}{tag}-stats.json'), 'w')); print(json.dumps(st))

if __name__ == '__main__': main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
