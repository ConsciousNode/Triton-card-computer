# local_reroute.py: rip up a small window of a routed board and reroute it with a grid maze router (Kehai Interim, 2026-11-22). MIT.
# usage: python3 kicad/local_reroute.py <board-routed.kicad_pcb> <x0> <y0> <x1> <y1> [margin_mm] [--save]
# Freerouting left one ALU connection open twice (R13+, U84 pin 5 to U83 pin 6: 6.4 mm straight down a TSSOP column, the
# strip beside it full of other nets). Its rip-up works on the whole board; this works on one window:
# 1. every unlocked track and via touching the RIP window (x0..x1, y0..y1 in mm) goes, except GND/+3V3 (planes);
# 2. per net, what is left is grouped (union-find over pads, vias, track ends: things that touch are one group);
#    groups with a member inside the routing window (RIP window + margin) are the terminals to join;
# 3. A* on a 0.05 mm grid over the four signal layers (F, In2, In3, B), 8 directions, vias where all four layers and
#    the drill clear; obstacles are other-net copper inflated by the board's own rules (0.15 mm clearance, 0.15 mm
#    tracks, 0.6/0.3 vias, 0.25 mm hole clearance); every routed net becomes an obstacle for the next;
# 4. net orders are tried until all connect (or it says which could not); with --save the board is written back and
#    nothing is forced: a net it cannot finish leaves the board untouched.
import sys, math, heapq, itertools, pcbnew
import numpy as np
mm = pcbnew.FromMM; TOMM = pcbnew.ToMM
path = sys.argv[1]; X0, Y0, X1, Y1 = map(float, sys.argv[2:6])
MARGIN = float(sys.argv[6]) if len(sys.argv) > 6 and not sys.argv[6].startswith('-') else 4.0
SAVE = '--save' in sys.argv
RIP_OUTER = '--rip-outer' in sys.argv
G = 0.05                                    # grid, mm
TW, CL, VD, VDR, HH = 0.15, 0.15, 0.6, 0.3, 0.25
LAYERS = [pcbnew.F_Cu, pcbnew.In2_Cu, pcbnew.In3_Cu, pcbnew.B_Cu]
PWR = ('GND', '+3V3')
b = pcbnew.LoadBoard(path)
def inside(p, x0, y0, x1, y1): return x0 <= TOMM(p.x) <= x1 and y0 <= TOMM(p.y) <= y1
def seg_hits_box(a, c, x0, y0, x1, y1):
    for k in range(41):
        t = k / 40; x = TOMM(a.x) + t * (TOMM(c.x) - TOMM(a.x)); y = TOMM(a.y) + t * (TOMM(c.y) - TOMM(a.y))
        if x0 <= x <= x1 and y0 <= y <= y1: return True
    return False
# ---- 1. rip ----
ripped, nets = [], set()
# --nets=A,B: route these nets too; --norip: rip nothing, only thread the named nets through free space (2026-11-22: Video's
# one open connection, FC0, a 30 mm gap; the routing window is the RIP box + margin as always)
NORIP = '--norip' in sys.argv
for a_ in sys.argv:
    if a_.startswith('--nets='): nets.update(a_[7:].split(','))
for t in ([] if NORIP else list(b.GetTracks())):
    if t.IsLocked() or t.GetNetname() in PWR or not t.GetNetname(): continue
    hit = inside(t.GetPosition(), X0, Y0, X1, Y1) if t.GetClass() == 'PCB_VIA' else seg_hits_box(t.GetStart(), t.GetEnd(), X0, Y0, X1, Y1)
    # --rip-outer: inner-layer tracks stay unless they end at a ripped via (2026-11-22: clipped In2 bus runs at minimum
    # pitch left ends the 0.05 mm grid could not leave without touching a neighbour's clearance)
    if hit and RIP_OUTER and t.GetClass() == 'PCB_TRACK' and t.GetLayer() not in (pcbnew.F_Cu, pcbnew.B_Cu): hit = False
    if hit: ripped.append(t); nets.add(t.GetNetname())
# the open connection(s) named by the caller's window also count: nets with a pad in the RIP window and an open ratsnest
b.BuildConnectivity(); conn = b.GetConnectivity()
for fp in b.GetFootprints():
    for pd in fp.Pads():
        if pd.GetNetname() and pd.GetNetname() not in PWR and inside(pd.GetPosition(), X0 - 1, Y0 - 1, X1 + 1, Y1 + 1):
            if conn.GetUnconnectedCount(True) and any(True for _ in [0]): pass
print('ripping', len(ripped), 'items of', len(nets), 'nets:', ' '.join(sorted(nets)))
# a track crossing the RIP window is clipped, not deleted (2026-11-22: 18 mm data-bus runs on In2 were deleted whole, their
# far ends outside the routing window: the router never saw them, 17 connections open); the parts outside stay, their
# new ends on the window's edge are terminals like any other
def clip(a, c):
    # Liang-Barsky: the parameter interval [t0, t1] of segment a->c inside the RIP box (mm)
    ax, ay, cx, cy = TOMM(a.x), TOMM(a.y), TOMM(c.x), TOMM(c.y); dx, dy = cx - ax, cy - ay; t0, t1 = 0.0, 1.0
    for p_, q_ in ((-dx, ax - X0), (dx, X1 - ax), (-dy, ay - Y0), (dy, Y1 - ay)):
        if p_ == 0:
            if q_ < 0: return None
        else:
            r = q_ / p_
            if p_ < 0: t0 = max(t0, r)
            else: t1 = min(t1, r)
    return (t0, t1) if t0 <= t1 else None
kept = 0
for t in ripped:
    if t.GetClass() == 'PCB_TRACK':
        a, c = t.GetStart(), t.GetEnd(); iv = clip(a, c)
        if iv:
            for (u0, u1) in ((0.0, iv[0]), (iv[1], 1.0)):
                if u1 - u0 > 1e-6 and (u1 - u0) * t.GetLength() > mm(0.05):
                    n = pcbnew.PCB_TRACK(b); n.SetLayer(t.GetLayer()); n.SetWidth(t.GetWidth()); n.SetNet(t.GetNet())
                    n.SetStart(pcbnew.VECTOR2I(int(a.x + u0 * (c.x - a.x)), int(a.y + u0 * (c.y - a.y))))
                    n.SetEnd(pcbnew.VECTOR2I(int(a.x + u1 * (c.x - a.x)), int(a.y + u1 * (c.y - a.y)))); b.Add(n); kept += 1
    b.Delete(t)
print('clipped tracks: kept', kept, 'outside pieces')
# ---- 2. groups per net ----
WX0, WY0, WX1, WY1 = X0 - MARGIN, Y0 - MARGIN, X1 + MARGIN, Y1 + MARGIN
# --win=x0,y0,x1,y1: a routing window of its own, bigger than the RIP box (2026-11-23: Control's IM2, a back-side pin boxed
# in by its neighbours and 57 mm from the rest of its net); and the window never leaves the board (1 mm in from the edge)
for a_ in sys.argv:
    if a_.startswith('--win='): WX0, WY0, WX1, WY1 = map(float, a_[6:].split(','))
_eb = b.GetBoardEdgesBoundingBox()
WX0, WY0 = max(WX0, TOMM(_eb.GetX()) + 1.0), max(WY0, TOMM(_eb.GetY()) + 1.0)
WX1, WY1 = min(WX1, TOMM(_eb.GetRight()) - 1.0), min(WY1, TOMM(_eb.GetBottom()) - 1.0)
def items_of(net):
    its = []   # (kind, obj, layers, points)
    for fp in b.GetFootprints():
        for pd in fp.Pads():
            if pd.GetNetname() == net:
                lays = [L for L in LAYERS if pd.IsOnLayer(L)]
                its.append(('pad', pd, lays, [(pd.GetPosition().x, pd.GetPosition().y)]))
    for t in b.GetTracks():
        if t.GetNetname() != net: continue
        if t.GetClass() == 'PCB_VIA': its.append(('via', t, LAYERS, [(t.GetPosition().x, t.GetPosition().y)]))
        else: its.append(('trk', t, [t.GetLayer()], [(t.GetStart().x, t.GetStart().y), (t.GetEnd().x, t.GetEnd().y)]))
    return its
def touches(a, c):
    (ka, oa, la, pa), (kc, oc, lc, pc) = a, c
    if not set(la) & set(lc): return False
    for p in pa:
        v = pcbnew.VECTOR2I(int(p[0]), int(p[1]))
        if kc == 'pad' and oc.HitTest(v): return True
        if kc == 'via' and (oc.GetPosition() - v).EuclideanNorm() <= oc.GetWidth() / 2: return True
        if kc == 'trk' and (p == pc[0] or p == pc[1]): return True
    for p in pc:
        v = pcbnew.VECTOR2I(int(p[0]), int(p[1]))
        if ka == 'pad' and oa.HitTest(v): return True
        if ka == 'via' and (oa.GetPosition() - v).EuclideanNorm() <= oa.GetWidth() / 2: return True
    return False
def groups(net):
    its = items_of(net); par = list(range(len(its)))
    def f(i):
        while par[i] != i: par[i] = par[par[i]]; i = par[i]
        return i
    for i, j in itertools.combinations(range(len(its)), 2):
        if f(i) != f(j) and touches(its[i], its[j]): par[f(i)] = f(j)
    gs = {}
    for i, it in enumerate(its): gs.setdefault(f(i), []).append(it)
    return list(gs.values())
# ---- 3. grid ----
NX, NY = int((WX1 - WX0) / G) + 1, int((WY1 - WY0) / G) + 1
xs = WX0 + np.arange(NX) * G; ys = WY0 + np.arange(NY) * G
GX, GY = np.meshgrid(xs, ys, indexing='ij')
def cell(xm, ym): return int(round((xm - WX0) / G)), int(round((ym - WY0) / G))
def mark_seg(mask, ax, ay, cx, cy, r):
    x0, x1 = min(ax, cx) - r, max(ax, cx) + r; y0, y1 = min(ay, cy) - r, max(ay, cy) + r
    i0, i1 = max(0, int((x0 - WX0) / G)), min(NX, int((x1 - WX0) / G) + 2); j0, j1 = max(0, int((y0 - WY0) / G)), min(NY, int((y1 - WY0) / G) + 2)
    if i0 >= i1 or j0 >= j1: return
    px, py = GX[i0:i1, j0:j1], GY[i0:i1, j0:j1]; vx, vy = cx - ax, cy - ay; L = vx * vx + vy * vy
    t = np.zeros_like(px) if L == 0 else np.clip(((px - ax) * vx + (py - ay) * vy) / L, 0, 1)
    d = np.hypot(px - ax - t * vx, py - ay - t * vy); mask[i0:i1, j0:j1] |= d < r
def mark_rect(mask, r, infl):
    x0, y0, x1, y1 = r
    i0, i1 = max(0, int((x0 - infl - WX0) / G)), min(NX, int((x1 + infl - WX0) / G) + 2); j0, j1 = max(0, int((y0 - infl - WY0) / G)), min(NY, int((y1 + infl - WY0) / G) + 2)
    if i0 >= i1 or j0 >= j1: return
    px, py = GX[i0:i1, j0:j1], GY[i0:i1, j0:j1]
    d = np.hypot(np.maximum(np.maximum(x0 - px, 0), px - x1), np.maximum(np.maximum(y0 - py, 0), py - y1)); mask[i0:i1, j0:j1] |= d < infl
def obstacles(net, extra):
    """per layer: cells where a 0.15 mm track centre may not go; and cells where a via centre may not go"""
    trk = np.zeros((4, NX, NY), bool); via = np.zeros((NX, NY), bool)
    for fp in b.GetFootprints():
        for pd in fp.Pads():
            if pd.GetNetname() == net: continue
            bb = pd.GetBoundingBox(); r = (TOMM(bb.GetX()), TOMM(bb.GetY()), TOMM(bb.GetRight()), TOMM(bb.GetBottom()))
            if r[2] < WX0 - 2 or r[0] > WX1 + 2 or r[3] < WY0 - 2 or r[1] > WY1 + 2: continue
            for li, L in enumerate(LAYERS):
                if pd.IsOnLayer(L): mark_rect(trk[li], r, TW / 2 + CL)
            if any(pd.IsOnLayer(L) for L in LAYERS): mark_rect(via, r, VD / 2 + CL)
            if pd.GetDrillSize().x > 0:
                c = pd.GetPosition(); mark_seg(via, TOMM(c.x), TOMM(c.y), TOMM(c.x), TOMM(c.y), VDR / 2 + TOMM(pd.GetDrillSize().x) / 2 + HH)
    allt = [(t.GetNetname(), t.GetClass(), t) for t in b.GetTracks()] + extra
    for (n, cls, t) in allt:
        if cls == 'PCB_VIA':
            p = t.GetPosition() if hasattr(t, 'GetPosition') else t['p']; x, y = TOMM(p.x), TOMM(p.y); w = TOMM(t.GetWidth()) if hasattr(t, 'GetWidth') else VD
            dr = TOMM(t.GetDrillValue()) if hasattr(t, 'GetDrillValue') else VDR
            if not (WX0 - 2 < x < WX1 + 2 and WY0 - 2 < y < WY1 + 2): continue
            mark_seg(via, x, y, x, y, VDR / 2 + dr / 2 + HH)                       # hole to hole: any net
            if n == net: continue
            for li in range(4): mark_seg(trk[li], x, y, x, y, w / 2 + TW / 2 + CL)
            mark_seg(via, x, y, x, y, w / 2 + VD / 2 + CL)
        else:
            if n == net: continue
            if hasattr(t, 'GetStart'): a, c, L, w = t.GetStart(), t.GetEnd(), t.GetLayer(), TOMM(t.GetWidth()); ax, ay, cx, cy = TOMM(a.x), TOMM(a.y), TOMM(c.x), TOMM(c.y)
            else: ax, ay, cx, cy, L, w = t['a'][0], t['a'][1], t['c'][0], t['c'][1], t['L'], TW
            if max(ax, cx) < WX0 - 2 or min(ax, cx) > WX1 + 2 or max(ay, cy) < WY0 - 2 or min(ay, cy) > WY1 + 2: continue
            if L in LAYERS: mark_seg(trk[LAYERS.index(L)], ax, ay, cx, cy, w / 2 + TW / 2 + CL)
            mark_seg(via, ax, ay, cx, cy, w / 2 + VD / 2 + CL)
    # edge of the window: stay inside it
    trk[:, :2, :] = trk[:, -2:, :] = trk[:, :, :2] = trk[:, :, -2:] = True
    return trk, via
def terminal_cells(group):
    """cells (layer, i, j) that touch this group, and the exact point each joins at"""
    out = {}
    for (k, o, lays, pts) in group:
        for L in lays:
            li = LAYERS.index(L)
            if k == 'pad':
                bb = o.GetBoundingBox(); x0, y0, x1, y1 = TOMM(bb.GetX()), TOMM(bb.GetY()), TOMM(bb.GetRight()), TOMM(bb.GetBottom())
                for i in range(max(0, int((x0 - WX0) / G)), min(NX, int((x1 - WX0) / G) + 2)):
                    for j in range(max(0, int((y0 - WY0) / G)), min(NY, int((y1 - WY0) / G) + 2)):
                        if o.HitTest(pcbnew.VECTOR2I(mm(float(xs[i])), mm(float(ys[j])))): out[(li, i, j)] = None
            else:
                for p in pts:
                    xm, ym = TOMM(p[0]), TOMM(p[1])
                    if WX0 < xm < WX1 and WY0 < ym < WY1:
                        if k == 'via':
                            i, j = cell(xm, ym)
                            for l2 in range(4): out[(l2, i, j)] = (xm, ym)
                        else:
                            # 2026-11-23: a track end joins the grid by a short stub; on minimum-pitch buses the nearest
                            # cell put that stub inside a neighbour's clearance (Control IM2: 8 errors). Every cell
                            # within 0.15 mm whose stub clears all other-net copper exactly is a terminal; the nearest
                            # cell only if none does.
                            ok = [(i, j) for (i, j) in near_cells(xm, ym, 0.15) if stub_clear(o.GetNetname(), L, xm, ym, WX0 + i * G, WY0 + j * G)]
                            for (i, j) in (ok or [cell(xm, ym)]): out[(li, i, j)] = (xm, ym)
    return out
def near_cells(xm, ym, r):
    i0, j0 = cell(xm, ym); n = int(r / G) + 1
    return [(i, j) for i in range(i0 - n, i0 + n + 1) for j in range(j0 - n, j0 + n + 1)
            if 0 <= i < NX and 0 <= j < NY and math.hypot(WX0 + i * G - xm, WY0 + j * G - ym) <= r]
def _dps(px, py, ax, ay, cx, cy):
    vx, vy = cx - ax, cy - ay; L = vx * vx + vy * vy
    t = 0 if L == 0 else max(0, min(1, ((px - ax) * vx + (py - ay) * vy) / L)); return math.hypot(px - ax - t * vx, py - ay - t * vy)
def _dss(a, c, p, q):
    return min(_dps(a[0], a[1], p[0], p[1], q[0], q[1]), _dps(c[0], c[1], p[0], p[1], q[0], q[1]),
               _dps(p[0], p[1], a[0], a[1], c[0], c[1]), _dps(q[0], q[1], a[0], a[1], c[0], c[1]))
_COPPER = None
def _copper():
    """other-net copper near the window, exact (mm): ('seg', layer, a, c, halfwidth) | ('via', x, y, r) | ('pad', layers, rect)"""
    global _COPPER
    if _COPPER is None:
        _COPPER = []
        for t in b.GetTracks():
            if t.GetClass() == 'PCB_VIA':
                x, y = TOMM(t.GetPosition().x), TOMM(t.GetPosition().y)
                if WX0 - 2 < x < WX1 + 2 and WY0 - 2 < y < WY1 + 2: _COPPER.append((t.GetNetname(), 'via', x, y, TOMM(t.GetWidth()) / 2))
            else:
                a, c = (TOMM(t.GetStart().x), TOMM(t.GetStart().y)), (TOMM(t.GetEnd().x), TOMM(t.GetEnd().y))
                if max(a[0], c[0]) < WX0 - 2 or min(a[0], c[0]) > WX1 + 2 or max(a[1], c[1]) < WY0 - 2 or min(a[1], c[1]) > WY1 + 2: continue
                _COPPER.append((t.GetNetname(), 'seg', t.GetLayer(), a, c, TOMM(t.GetWidth()) / 2))
        for fp in b.GetFootprints():
            for pd in fp.Pads():
                bb = pd.GetBoundingBox(); r = (TOMM(bb.GetX()), TOMM(bb.GetY()), TOMM(bb.GetRight()), TOMM(bb.GetBottom()))
                if r[2] < WX0 - 2 or r[0] > WX1 + 2 or r[3] < WY0 - 2 or r[1] > WY1 + 2: continue
                _COPPER.append((pd.GetNetname(), 'pad', [L for L in LAYERS if pd.IsOnLayer(L)], r))
    return _COPPER
def stub_clear(net, L, ax, ay, cx, cy):
    need = TW / 2 + CL + 0.002
    for it in _copper():
        if it[0] == net: continue
        if it[1] == 'via':
            if _dps(it[2], it[3], ax, ay, cx, cy) < it[4] + need: return False
        elif it[1] == 'seg':
            if it[2] == L and _dss((ax, ay), (cx, cy), it[3], it[4]) < it[5] + need: return False
        else:
            if L in it[2]:
                r = it[3]
                for k in range(11):
                    x, y = ax + k / 10 * (cx - ax), ay + k / 10 * (cy - ay)
                    if math.hypot(max(r[0] - x, 0, x - r[2]), max(r[1] - y, 0, y - r[3])) < need: return False
    return True
DIRS = [(1, 0, 1.0), (-1, 0, 1.0), (0, 1, 1.0), (0, -1, 1.0), (1, 1, 1.4142), (1, -1, 1.4142), (-1, 1, 1.4142), (-1, -1, 1.4142)]
VIA_COST = 30.0
def astar(src, dst, trk, via):
    tgt = set(dst); tl = np.array([[k[1], k[2]] for k in dst])
    def h(i, j): return float(np.min(np.abs(tl[:, 0] - i) + np.abs(tl[:, 1] - j))) * 0.7
    pq, came, gsc = [], {}, {}
    for s in src:
        gsc[s] = 0.0; heapq.heappush(pq, (h(s[1], s[2]), 0.0, s))
    while pq:
        f, gc, cur = heapq.heappop(pq)
        if cur in tgt:
            pathc = [cur]
            while pathc[-1] in came: pathc.append(came[pathc[-1]])
            return pathc[::-1]
        if gc > gsc.get(cur, 1e18): continue
        li, i, j = cur
        nbrs = []
        for (di, dj, c) in DIRS:
            ni, nj = i + di, j + dj
            if 0 <= ni < NX and 0 <= nj < NY and not trk[li, ni, nj]:
                if di and dj and (trk[li, i + di, j] or trk[li, i, j + dj]): continue
                nbrs.append(((li, ni, nj), c))
        if not via[i, j] and not any(trk[l2, i, j] for l2 in range(4)):
            for l2 in range(4):
                if l2 != li: nbrs.append(((l2, i, j), VIA_COST))
        for (nx_, c) in nbrs:
            ng = gc + c
            if ng < gsc.get(nx_, 1e18):
                gsc[nx_] = ng; came[nx_] = cur; heapq.heappush(pq, (ng + h(nx_[1], nx_[2]), ng, nx_))
    return None
def route_net(net, extra):
    gs = [g for g in groups(net) if terminal_cells(g)]
    if len(gs) < 2: return []
    trk, via = obstacles(net, extra)
    # a terminal's own cells are always enterable (they are this net's copper)
    tcs = [terminal_cells(g) for g in gs]
    for tc in tcs:
        for (li, i, j) in tc: trk[li, i, j] = False
    joined = [0]; pieces = []
    while len(joined) < len(gs):
        src = [k for gi in joined for k in tcs[gi]]
        rest = [gi for gi in range(len(gs)) if gi not in joined]
        dst = {k: gi for gi in rest for k in tcs[gi]}
        p = astar(src, list(dst), trk, via)
        if p is None: return None
        gi = dst[p[-1]]; joined.append(gi)
        pieces.append((p, tcs[[g for g in joined[:-1] if p[0] in tcs[g]][0]][p[0]], tcs[gi][p[-1]]))
        for (li, i, j) in p: tcs[0][(li, i, j)] = None   # the new path is now part of the joined copper
    return pieces
def to_items(net, pieces):
    """grid paths -> track segments (collinear runs merged) and vias; ends joined to the exact terminal points"""
    items = []
    for (p, ja, jb) in pieces:
        pts = [(LAYERS[li], WX0 + i * G, WY0 + j * G) for (li, i, j) in p]
        run = [pts[0]]
        def flush(r):
            if len(r) < 2: return
            # merge collinear
            keep = [r[0]]
            for k in range(1, len(r) - 1):
                a, c, d = keep[-1], r[k], r[k + 1]
                if (c[1] - a[1]) * (d[2] - c[2]) - (c[2] - a[2]) * (d[1] - c[1]) != 0: keep.append(c)
            keep.append(r[-1])
            for a, c in zip(keep, keep[1:]): items.append(('trk', a[0], (a[1], a[2]), (c[1], c[2])))
        for q in pts[1:]:
            if q[0] != run[-1][0]: flush(run); items.append(('via', None, (q[1], q[2]), None)); run = [q]
            else: run.append(q)
        flush(run)
        if ja: items.append(('trk', pts[0][0], ja, (pts[0][1], pts[0][2])))
        if jb: items.append(('trk', pts[-1][0], (pts[-1][1], pts[-1][2]), jb))
    return items
order0 = sorted(nets)
best = None
# net order: a net that fails moves to the front and the rest keep their order (2026-11-22: lexicographic permutations
# of 17 nets only ever shuffled the tail; S13+ failed in all 60)
tried = set(); perm = tuple(order0); orders = []
for _ in range(40):
    if perm in tried: break
    tried.add(perm); orders.append(perm)
    perm = None
    break
def next_orders():
    p = tuple(order0); seen = set()
    while p not in seen and len(seen) < 40:
        seen.add(p); fail = yield p
        if fail is None: return
        p = (fail,) + tuple(n for n in p if n != fail)
gen = next_orders(); perm = next(gen); fail = 'start'
while True:
    extra, done, fail = [], {}, None
    for net in perm:
        pc = route_net(net, extra)
        if pc is None: fail = net; break
        its = to_items(net, pc); done[net] = its
        for it in its:
            if it[0] == 'trk': extra.append((net, 'PCB_TRACK', {'a': it[2], 'c': it[3], 'L': it[1]}))
            else:
                class V: pass
                v = V(); v.p = pcbnew.VECTOR2I(mm(it[2][0]), mm(it[2][1]))
                extra.append((net, 'PCB_VIA', type('X', (), {'GetPosition': lambda s, p=v.p: p, 'GetWidth': lambda s: mm(VD), 'GetDrillValue': lambda s: mm(VDR)})()))
    if fail is None: best = (perm, done); break
    print('order', ' '.join(perm), '-> could not finish', fail)
    try: perm = gen.send(fail)
    except StopIteration: break
if not best: print('NO ORDER WORKED; board left untouched'); sys.exit(1)
perm, done = best
print('routed in order:', ' '.join(perm))
nt = nv = 0
for net, its in done.items():
    n = b.FindNet(net)
    for it in its:
        if it[0] == 'trk':
            if abs(it[2][0] - it[3][0]) < 1e-9 and abs(it[2][1] - it[3][1]) < 1e-9: continue
            t = pcbnew.PCB_TRACK(b); t.SetStart(pcbnew.VECTOR2I(mm(it[2][0]), mm(it[2][1]))); t.SetEnd(pcbnew.VECTOR2I(mm(it[3][0]), mm(it[3][1])))
            t.SetWidth(mm(TW)); t.SetLayer(it[1]); t.SetNet(n); b.Add(t); nt += 1
        else:
            v = pcbnew.PCB_VIA(b); v.SetPosition(pcbnew.VECTOR2I(mm(it[2][0]), mm(it[2][1]))); v.SetWidth(mm(VD)); v.SetDrill(mm(VDR))
            v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu); v.SetNet(n); b.Add(v); nv += 1
print(f'added {nt} track segments, {nv} vias')
pcbnew.ZONE_FILLER(b).Fill(b.Zones())
outp = path if SAVE else '/tmp/local_reroute_out.kicad_pcb'; b.Save(outp)
b2 = pcbnew.LoadBoard(outp); b2.BuildConnectivity(); print('saved', outp, '; unrouted connections:', b2.GetConnectivity().GetUnconnectedCount(True))
