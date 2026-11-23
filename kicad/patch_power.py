# patch_power.py: after routing, reach every power pin that the fanout could not with its own via (Kehai Interim, 2026-11-22). MIT.
# usage: python3 kicad/patch_power.py <board-routed.kicad_pcb>
# The planes carry GND and +3V3, so a power pin needs only a via. route_card.py's fanout leaves a pin to the router when no
# spot beside it is clear; Freerouting then half-finishes some (I/O card: 7 unconnected). Here, on the routed board:
# 1. the router's own power copper (unlocked GND/+3V3 tracks and vias) goes;
# 2. each power pad with no locked stub gets a stub + via at the first spot that clears every other-net pad, track and
#    via on the board (outward, diagonals, sideways, and inward under its own package body, further out step by step);
# 3. zones refilled, saved in place; a pin with no clear spot is reported, never forced.
import sys, math, pcbnew
mm = pcbnew.FromMM
path = sys.argv[1]; b = pcbnew.LoadBoard(path)
CL, HH = mm(0.15), mm(0.25); VR, VH, SW = mm(0.25), mm(0.125), mm(0.25)
PWR = ('GND', '+3V3')
gone = 0
for t in list(b.GetTracks()):
    if t.GetNetname() in PWR and not t.IsLocked(): b.Delete(t); gone += 1
locked_ends = set()
for t in b.GetTracks():
    if t.IsLocked() and t.GetClass() == 'PCB_TRACK': locked_ends.add((t.GetStart().x, t.GetStart().y))
def d_pt_rect(x, y, r):
    return math.hypot(max(r[0] - x, 0, x - r[2]), max(r[1] - y, 0, y - r[3]))
def d_pt_seg(x, y, a, c):
    vx, vy = c[0] - a[0], c[1] - a[1]; L = vx * vx + vy * vy
    t = 0 if L == 0 else max(0, min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / L))
    return math.hypot(x - a[0] - t * vx, y - a[1] - t * vy)
def d_seg_seg(a, c, p, q):
    return min(d_pt_seg(a[0], a[1], p, q), d_pt_seg(c[0], c[1], p, q), d_pt_seg(p[0], p[1], a, c), d_pt_seg(q[0], q[1], a, c),
               0 if _cross(a, c, p, q) else 1e18)
def _cross(a, c, p, q):
    def o(u, v, w): return (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0])
    return o(a, c, p) * o(a, c, q) < 0 and o(p, q, a) * o(p, q, c) < 0
pads = []
for fp in b.GetFootprints():
    for pd in fp.Pads():
        r = pd.GetBoundingBox(); hr = pd.GetDrillSize().x / 2
        pads.append(((r.GetX(), r.GetY(), r.GetRight(), r.GetBottom()), pd.GetNetname(), pd.IsOnLayer(pcbnew.F_Cu), pd.IsOnLayer(pcbnew.B_Cu), hr, (pd.GetPosition().x, pd.GetPosition().y)))
segs, vias = [], []
for t in b.GetTracks():
    if t.GetClass() == 'PCB_VIA': vias.append((t.GetPosition().x, t.GetPosition().y, t.GetNetname(), t.GetWidth() / 2, t.GetDrillValue() / 2))
    else: segs.append(((t.GetStart().x, t.GetStart().y), (t.GetEnd().x, t.GetEnd().y), t.GetNetname(), t.GetLayer(), t.GetWidth() / 2))
bb = b.GetBoardEdgesBoundingBox()
def ok(net, lay, a, v):
    vx, vy = v
    if not (bb.GetX() + (mm(0.5) + VR + mm(0.05)) < vx < bb.GetRight() - (mm(0.5) + VR + mm(0.05)) and bb.GetY() + (mm(0.5) + VR + mm(0.05)) < vy < bb.GetBottom() - (mm(0.5) + VR + mm(0.05))): return False   # 2026-11-22: copper edge, not centre (Memory: 8 edge-clearance errors)
    for (r, n, onF, onB, hr, pc) in pads:
        if n == net: continue
        if d_pt_rect(vx, vy, r) < VR + CL: return False
        if hr and math.hypot(vx - pc[0], vy - pc[1]) < VH + hr + HH: return False
        if (onF if lay == pcbnew.F_Cu else onB):
            for k in range(21):
                t = k / 20
                if d_pt_rect(a[0] + t * (vx - a[0]), a[1] + t * (vy - a[1]), r) < SW / 2 + CL: return False
    for (x, y, n, rr, hr) in vias:
        dd = math.hypot(vx - x, vy - y)
        if dd < VH + hr + HH: return False
        if n != net and (dd < VR + rr + CL or d_pt_seg(x, y, a, v) < rr + SW / 2 + CL): return False
    for (p, q, n, l, hw) in segs:
        if n == net: continue
        if d_pt_seg(vx, vy, p, q) < VR + hw + CL: return False                     # the via touches every layer
        if l == lay and d_seg_seg(a, v, p, q) < SW / 2 + hw + CL: return False
    return True
fixed, stuck = 0, []
for fp in b.GetFootprints():
    if fp.GetReference() == 'J1': continue
    c = fp.GetPosition()
    for pd in fp.Pads():
        net = pd.GetNetname()
        if net not in PWR or (pd.GetPosition().x, pd.GetPosition().y) in locked_ends: continue
        p0 = pd.GetPosition(); a = (p0.x, p0.y); dx, dy = p0.x - c.x, p0.y - c.y
        r = pd.GetBoundingBox()
        if r.GetWidth() >= r.GetHeight(): ux, uy = (1 if dx >= 0 else -1), 0
        else: ux, uy = 0, (1 if dy >= 0 else -1)
        lay = pcbnew.F_Cu if pd.IsOnLayer(pcbnew.F_Cu) else pcbnew.B_Cu
        half = max(pd.GetSize().x, pd.GetSize().y) / 2
        dirs = [(ux, uy), (ux - uy, uy + ux), (ux + uy, uy - ux), (-uy, ux), (uy, -ux), (-ux, -uy), (-ux - uy, -uy + ux), (-ux + uy, -uy - ux)]
        hit = None
        for step in range(20):
            for (ex, ey) in dirs:
                L = math.hypot(ex, ey); d = half + mm(0.45) + step * mm(0.15)
                v = (int(p0.x + ex / L * d), int(p0.y + ey / L * d))
                if ok(net, lay, a, v): hit = v; break
            if hit: break
        if not hit: stuck.append(f'{fp.GetReference()}.{pd.GetNumber()}'); continue
        tr = pcbnew.PCB_TRACK(b); tr.SetStart(p0); tr.SetEnd(pcbnew.VECTOR2I(*hit)); tr.SetWidth(SW); tr.SetLayer(lay); tr.SetNet(pd.GetNet()); tr.SetLocked(True); b.Add(tr)
        vv = pcbnew.PCB_VIA(b); vv.SetPosition(pcbnew.VECTOR2I(*hit)); vv.SetWidth(2 * VR); vv.SetDrill(2 * VH); vv.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu); vv.SetNet(pd.GetNet()); vv.SetLocked(True); b.Add(vv)
        segs.append((a, hit, net, lay, SW / 2)); vias.append((hit[0], hit[1], net, VR, VH)); fixed += 1
pcbnew.ZONE_FILLER(b).Fill(b.Zones()); b.Save(path)
print(f'patch_power: removed {gone} router power items; {fixed} power pins given their own via' + (f'; NO CLEAR SPOT: {" ".join(stuck)}' if stuck else ''))
