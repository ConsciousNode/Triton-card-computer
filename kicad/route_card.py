# route_card.py: autoroute one card board with Freerouting (Kehai Interim, 2026-11-22). MIT.
# usage: python3 kicad/route_card.py <board.kicad_pcb> <freerouting.jar> [passes]
# 1. a 6-layer stackup (signal / GND / signal / signal / +3V3 / signal: four routing layers, two solid planes),
#    design rules for a cheap 4-layer fab: 0.15 mm tracks and clearance, 0.6/0.3 mm vias;
# 2. inner layers as planes: In1.Cu = GND, In2.Cu = +3V3 (power pins reach them through vias);
# 3. Specctra DSN out, Freerouting (headless) in between, SES back in; zones filled; saved as <board>-routed.kicad_pcb;
# 4. a copper plot (front + back + outline) and a count of what is still unrouted.
import sys, os, subprocess, time
import pcbnew
src, jar = sys.argv[1], sys.argv[2]; passes = sys.argv[3] if len(sys.argv) > 3 else '30'
mm = pcbnew.FromMM
b = pcbnew.LoadBoard(src)
ds = b.GetDesignSettings(); nc = ds.m_NetSettings.m_DefaultNetClass
nc.SetTrackWidth(mm(0.15)); nc.SetClearance(mm(0.15)); nc.SetViaDiameter(mm(0.6)); nc.SetViaDrill(mm(0.3))
ds.m_TrackMinWidth = mm(0.127); ds.m_ViasMinSize = mm(0.5); ds.m_MinThroughDrill = mm(0.25)
bb = b.GetBoardEdgesBoundingBox()
def plane(layer, netname):
    n = b.FindNet(netname)
    if n is None: return
    z = pcbnew.ZONE(b); z.SetLayer(layer); z.SetNet(n); z.SetIsRuleArea(False)
    ol = z.Outline(); ol.NewOutline()
    for (x, y) in [(bb.GetX(), bb.GetY()), (bb.GetRight(), bb.GetY()), (bb.GetRight(), bb.GetBottom()), (bb.GetX(), bb.GetBottom())]: ol.Append(x, y)
    z.SetMinThickness(mm(0.2)); z.SetLocalClearance(mm(0.2)); b.Add(z)
b.SetCopperLayerCount(6)   # 6 layers: F (signal) / In1 GND plane / In2, In3 (signal) / In4 +3V3 plane / B (signal)
plane(pcbnew.In1_Cu, 'GND'); plane(pcbnew.In4_Cu, '+3V3')
# the inner layers are POWER layers (2026-11-22: exported as signal layers, Freerouting ran signal wires through the
# planes); as power layers the DSN marks them as planes and the router only drops vias into them
b.SetLayerType(pcbnew.In1_Cu, pcbnew.LT_POWER); b.SetLayerType(pcbnew.In4_Cu, pcbnew.LT_POWER)
# POWER FANOUT (2026-11-22): every GND / +3V3 pad gets a short stub straight out of its footprint to its own via into the
# plane, done here, deterministically, so the autorouter only routes signals (left to Freerouting, hundreds of plane
# vias squeezed beside 0.65 mm-pitch pads made it fight itself: 55-161 connections left unrouted on the Registers card)
import math
# 2026-11-22: the first fanout never looked at its neighbours: a GND stub from an IC pin and the +3V3 via of the
# decoupling cap beside it landed 0-0.1 mm apart (179 clearance + 157 hole-clearance DRC errors, all inside the fixed
# fanout the router may not touch). Now every candidate via spot is checked against every other-net pad, via and stub
# already on the board, by the board's own rules; the first clean one wins, and a pad with none is left to the router.
CL, HOLE_CL, HH = mm(0.15), mm(0.25), mm(0.25)      # copper clearance; hole-to-copper; hole-to-hole (edge to edge)
VR, VH, SW = mm(0.25), mm(0.125), mm(0.25)          # fanout via copper radius, drill radius, stub width
def d_pt_rect(x, y, r):                              # point to axis-aligned rect (x0, y0, x1, y1); 0 inside
    ddx = max(r[0] - x, 0, x - r[2]); ddy = max(r[1] - y, 0, y - r[3]); return math.hypot(ddx, ddy)
def d_pt_seg(x, y, a, c):
    ax, ay = a; cx, cy = c; vx, vy = cx - ax, cy - ay; L = vx * vx + vy * vy
    t = 0 if L == 0 else max(0, min(1, ((x - ax) * vx + (y - ay) * vy) / L))
    return math.hypot(x - ax - t * vx, y - ay - t * vy)
obs_pads = []   # (rect, net, onF, onB, holeR)
for fp in b.GetFootprints():
    for pad in fp.Pads():
        bb_ = pad.GetBoundingBox()
        hr = pad.GetDrillSize().x / 2 if pad.GetDrillSize().x > 0 else 0
        obs_pads.append(((bb_.GetX(), bb_.GetY(), bb_.GetRight(), bb_.GetBottom()), pad.GetNetname(),
                         pad.IsOnLayer(pcbnew.F_Cu), pad.IsOnLayer(pcbnew.B_Cu), hr, (pad.GetPosition().x, pad.GetPosition().y)))
vias, stubs = [], []   # vias: (x, y, net); stubs: (a, c, net, layer)
def clear(pad, net, lay, a, vx, vy):
    for (r, n, onF, onB, hr, pc) in obs_pads:          # other-net pads: via copper on every layer, stub on its layer
        if n == net: continue
        if d_pt_rect(vx, vy, r) < VR + CL: return False
        if hr and math.hypot(vx - pc[0], vy - pc[1]) < VH + hr + HH: return False
        on = onF if lay == pcbnew.F_Cu else onB
        if on:
            for k in range(11):
                t = k / 10; sx, sy = a[0] + t * (vx - a[0]), a[1] + t * (vy - a[1])
                if d_pt_rect(sx, sy, r) < SW / 2 + CL: break
            else: continue
            # the stub's first stretch lies inside its own pad's footprint row only for same-net pads, so any hit counts
            return False
    for (x, y, n) in vias:
        dd = math.hypot(vx - x, vy - y)
        if dd < 2 * VH + HH: return False                  # hole to hole, any net
        if n != net and dd < 2 * VR + CL: return False
        if n != net and d_pt_seg(x, y, a, (vx, vy)) < VR + SW / 2 + CL: return False
    for (sa, sc, n, sl) in stubs:
        if n == net: continue
        if d_pt_seg(vx, vy, sa, sc) < VR + SW / 2 + CL: return False
        if sl == lay:
            for k in range(11):
                t = k / 10; sx, sy = a[0] + t * (vx - a[0]), a[1] + t * (vy - a[1])
                if d_pt_seg(sx, sy, sa, sc) < SW + CL: return False
    if not (bb.GetX() + mm(0.5) < vx < bb.GetRight() - mm(0.5) and bb.GetY() + mm(0.5) < vy < bb.GetBottom() - mm(0.5)): return False
    return True
fan = 0; left = []
for fp in b.GetFootprints():
    if fp.GetReference() == 'J1': continue                     # through-hole: reaches every layer already
    c = fp.GetPosition()
    for pad in fp.Pads():
        net = pad.GetNetname()
        if net not in ('GND', '+3V3'): continue
        p0 = pad.GetPosition(); dx, dy = p0.x - c.x, p0.y - c.y
        pb = pad.GetBoundingBox()                               # out of the package along the pad's own long axis
        if pb.GetWidth() >= pb.GetHeight(): ux, uy = (1 if dx >= 0 else -1), 0
        else: ux, uy = 0, (1 if dy >= 0 else -1)
        sz = pad.GetSize(); half = max(sz.x, sz.y) / 2
        lay = pcbnew.F_Cu if pad.IsOnLayer(pcbnew.F_Cu) else pcbnew.B_Cu
        a = (p0.x, p0.y); hit = None
        dirs = [(ux, uy), (ux - uy, uy + ux), (ux + uy, uy - ux), (-uy, ux), (uy, -ux)]   # out, the two diagonals, sideways
        for step in range(9):
            for (ex, ey) in dirs:
                L = math.hypot(ex, ey); d = half + mm(0.45) + step * mm(0.15)
                vx, vy = int(p0.x + ex / L * d), int(p0.y + ey / L * d)
                if clear(pad, net, lay, a, vx, vy): hit = (vx, vy); break
            if hit: break
        if not hit: left.append((pad, lay, a, net, fp.GetReference())); continue
        vp = pcbnew.VECTOR2I(*hit)
        tr = pcbnew.PCB_TRACK(b); tr.SetStart(p0); tr.SetEnd(vp); tr.SetWidth(SW); tr.SetLayer(lay); tr.SetNet(pad.GetNet()); tr.SetLocked(True); b.Add(tr)
        v = pcbnew.PCB_VIA(b); v.SetPosition(vp); v.SetWidth(2 * VR); v.SetDrill(2 * VH); v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu); v.SetNet(pad.GetNet()); v.SetLocked(True); b.Add(v)
        vias.append((hit[0], hit[1], net)); stubs.append((a, hit, net, lay)); fan += 1
# a pad with no clean spot of its own (2026-11-22: SRAM VDD/GND pins 11-12 with their decoupling cap right in front of
# them) is joined to the nearest same-net fanout via already in the plane (usually that cap's) by a straight stub,
# if the stub clears everything of another net
def stub_clear(lay, a, c, net, own):
    for (r, n, onF, onB, hr, pc) in obs_pads:
        if n == net or not (onF if lay == pcbnew.F_Cu else onB): continue
        for k in range(21):
            t = k / 20; sx, sy = a[0] + t * (c[0] - a[0]), a[1] + t * (c[1] - a[1])
            if d_pt_rect(sx, sy, r) < SW / 2 + CL: return False
    for (x, y, n) in vias:
        if n != net and d_pt_seg(x, y, a, c) < VR + SW / 2 + CL: return False
    for (sa, sc, n, sl) in stubs:
        if n == net or sl != lay: continue
        for k in range(21):
            t = k / 20; sx, sy = a[0] + t * (c[0] - a[0]), a[1] + t * (c[1] - a[1])
            if d_pt_seg(sx, sy, sa, sc) < SW + CL: return False
    return True
still = []
for (pad, lay, a, net, ref) in left:
    near = sorted((math.hypot(x - a[0], y - a[1]), (x, y)) for (x, y, n) in vias if n == net)
    for (dd, c) in [q for q in near if q[0] <= mm(3)]:
        if stub_clear(lay, a, c, net, pad):
            tr = pcbnew.PCB_TRACK(b); tr.SetStart(pcbnew.VECTOR2I(*a)); tr.SetEnd(pcbnew.VECTOR2I(*c)); tr.SetWidth(SW); tr.SetLayer(lay)
            tr.SetNet(pad.GetNet()); tr.SetLocked(True); b.Add(tr); stubs.append((a, c, net, lay)); fan += 1; break
    else: still.append(ref + '.' + pad.GetNumber())
if still: print('power pads left to the router:', len(still), ' '.join(still))
print('power fanout:', fan, 'pads to plane vias')
base = os.path.splitext(src)[0]; dsn, ses = base + '.dsn', base + '.ses'
pcbnew.ExportSpecctraDSN(b, dsn)
t0 = time.time()
# Freerouting 1.9.0 (2026-11-22: 2.1.0 ignored every stop setting and never wrote its session); it opens a window even in
# CLI mode, so it runs under a virtual display (xvfb-run)
if os.environ.get('REUSE_SES') and os.path.exists(ses): r = subprocess.CompletedProcess([], 0, 'reused the existing session', '')
else:
  if os.path.exists(ses): os.remove(ses)
  r = subprocess.run(['xvfb-run', '-a', 'java', '-jar', jar, '-de', dsn, '-do', ses, '-mp', passes],
                   capture_output=True, text=True, timeout=7000)
print('freerouting exit', r.returncode, f'{time.time() - t0:.0f} s'); print('\n'.join((r.stdout + r.stderr).strip().splitlines()[-6:]))
if not os.path.exists(ses): sys.exit('no SES produced')
# KiCad 7's ImportSpecctraSES works only inside the GUI (it acts on the "current" board), so the session is read here:
# (resolution um 10): coordinates in 0.1 um, Y up; wires as (path <layer> <width> x y x y ...), vias as (via "<padstack>" x y)
import re
LAYER = {'F.Cu': pcbnew.F_Cu, 'B.Cu': pcbnew.B_Cu, 'In1.Cu': pcbnew.In1_Cu, 'In2.Cu': pcbnew.In2_Cu, 'In3.Cu': pcbnew.In3_Cu, 'In4.Cu': pcbnew.In4_Cu}
txt = open(ses).read(); body = txt[txt.index('(network_out'):]
toks = re.findall(r'\(|\)|"[^"]*"|[^\s()]+', body)
def P(x, y): return pcbnew.VECTOR2I(int(int(x) * 100), int(-int(y) * 100))   # 0.1 um -> nm, Y flipped
k = 0; cur = None; nw = nv = 0; stack = []
while k < len(toks):
    t = toks[k]
    if t == '(':
        head = toks[k + 1]; stack.append(head)
        if head == 'net': cur = b.FindNet(toks[k + 2].strip('"'))
        elif head == 'path':
            layer, width = toks[k + 2], int(toks[k + 3]); j = k + 4; pts = []
            while toks[j] != ')': pts.append((toks[j], toks[j + 1])); j += 2
            for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
                tr = pcbnew.PCB_TRACK(b); tr.SetStart(P(x1, y1)); tr.SetEnd(P(x2, y2)); tr.SetWidth(width * 100); tr.SetLayer(LAYER[layer])
                if cur: tr.SetNet(cur)
                b.Add(tr); nw += 1
        elif head == 'via':
            v = pcbnew.PCB_VIA(b); v.SetPosition(P(toks[k + 3], toks[k + 4])); v.SetWidth(mm(0.6)); v.SetDrill(mm(0.3))
            v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
            if cur: v.SetNet(cur)
            b.Add(v); nv += 1
        k += 1
    elif t == ')':
        if stack: stack.pop()   # the session's own closing brackets come after network_out
        k += 1
    else: k += 1
print(f'session read: {nw} track segments, {nv} vias')
filler = pcbnew.ZONE_FILLER(b); filler.Fill(b.Zones())
out = base + '-routed.kicad_pcb'; b.Save(out)
tracks = [t for t in b.GetTracks()]; vias = sum(1 for t in tracks if t.Type() == pcbnew.PCB_VIA_T)
length = sum(pcbnew.ToMM(t.GetLength()) for t in tracks if t.Type() == pcbnew.PCB_TRACE_T)
b2 = pcbnew.LoadBoard(out); b2.BuildConnectivity(); unrouted = b2.GetConnectivity().GetUnconnectedCount(True)
print(f'routed board {out}: {len(tracks) - vias} track segments, {vias} vias, {length / 1000:.2f} m of copper; unrouted connections: {unrouted}')
