# local_freeroute.py: rip up one window of a routed board and let Freerouting redo only that (Kehai Interim, 2026-11-22). MIT.
# usage: python3 kicad/local_freeroute.py <board-routed.kicad_pcb> <freerouting.jar> <x0> <y0> <x1> <y1> [passes] [--save]
# Every wire and via outside the window is locked first, so the DSN carries it as fixed and Freerouting cannot move it;
# inside the window every unlocked signal track is clipped at the window's edge and every signal via goes. Freerouting
# then routes only what is open, with its own exact geometry (my grid router, local_reroute.py, kept tripping on
# minimum-pitch bus ends). Its session holds exactly the unlocked wires, i.e. the new ones; they are added, and the
# router's own wires are unlocked again afterwards (power fanout stays locked as it was).
# First use: the ALU card's last open connection, R13+ from U84 pin 5 to U83 pin 6.
import sys, os, re, subprocess, time, pcbnew
mm = pcbnew.FromMM; TOMM = pcbnew.ToMM
path, jar = sys.argv[1], sys.argv[2]; X0, Y0, X1, Y1 = map(float, sys.argv[3:7])
passes = sys.argv[7] if len(sys.argv) > 7 and not sys.argv[7].startswith('-') else '20'
SAVE = '--save' in sys.argv; PWR = ('GND', '+3V3')
b = pcbnew.LoadBoard(path)
was_locked = set()
for t in b.GetTracks():
    if t.IsLocked(): was_locked.add((t.GetClass(), t.GetNetname(), t.GetStart().x, t.GetStart().y, t.GetEnd().x, t.GetEnd().y))
def clip(a, c):
    ax, ay, cx, cy = TOMM(a.x), TOMM(a.y), TOMM(c.x), TOMM(c.y); dx, dy = cx - ax, cy - ay; t0, t1 = 0.0, 1.0
    for p_, q_ in ((-dx, ax - X0), (dx, X1 - ax), (-dy, ay - Y0), (dy, Y1 - ay)):
        if p_ == 0:
            if q_ < 0: return None
        else:
            r = q_ / p_
            if p_ < 0: t0 = max(t0, r)
            else: t1 = min(t1, r)
    return (t0, t1) if t0 <= t1 else None
ripped = set(); n_rip = 0
for t in list(b.GetTracks()):
    if t.IsLocked() or t.GetNetname() in PWR or not t.GetNetname(): continue
    if t.GetClass() == 'PCB_VIA':
        p = t.GetPosition()
        if X0 <= TOMM(p.x) <= X1 and Y0 <= TOMM(p.y) <= Y1: ripped.add(t.GetNetname()); b.Delete(t); n_rip += 1
        continue
    a, c = t.GetStart(), t.GetEnd(); iv = clip(a, c)
    if not iv: continue
    ripped.add(t.GetNetname()); n_rip += 1
    for (u0, u1) in ((0.0, iv[0]), (iv[1], 1.0)):
        if (u1 - u0) * t.GetLength() > mm(0.05):
            n = pcbnew.PCB_TRACK(b); n.SetLayer(t.GetLayer()); n.SetWidth(t.GetWidth()); n.SetNet(t.GetNet())
            n.SetStart(pcbnew.VECTOR2I(int(a.x + u0 * (c.x - a.x)), int(a.y + u0 * (c.y - a.y))))
            n.SetEnd(pcbnew.VECTOR2I(int(a.x + u1 * (c.x - a.x)), int(a.y + u1 * (c.y - a.y)))); b.Add(n)
    b.Delete(t)
print(f'ripped {n_rip} items of {len(ripped)} nets:', ' '.join(sorted(ripped)))
for t in b.GetTracks(): t.SetLocked(True)
base = '/tmp/' + os.path.basename(os.path.splitext(path)[0]) + '-local'; dsn, ses = base + '.dsn', base + '.ses'
pcbnew.ExportSpecctraDSN(b, dsn) or sys.exit('DSN export failed')
if os.path.exists(ses): os.remove(ses)
t0 = time.time()
r = subprocess.run(['xvfb-run', '-a', 'java', '-jar', jar, '-de', dsn, '-do', ses, '-mp', passes], capture_output=True, text=True, timeout=40000)
print('freerouting exit', r.returncode, f'{time.time() - t0:.0f} s')
if not os.path.exists(ses): sys.exit('no SES produced')
# --- lifted from route_card.py (same day, same author): the SES reader (0.1 um units, Y flipped) ---
LAYER = {'F.Cu': pcbnew.F_Cu, 'B.Cu': pcbnew.B_Cu, 'In1.Cu': pcbnew.In1_Cu, 'In2.Cu': pcbnew.In2_Cu, 'In3.Cu': pcbnew.In3_Cu, 'In4.Cu': pcbnew.In4_Cu}
txt = open(ses).read(); body = txt[txt.index('(network_out'):]
toks = re.findall(r'\(|\)|"[^"]*"|[^\s()]+', body)
def P(x, y): return pcbnew.VECTOR2I(int(int(x) * 100), int(-int(y) * 100))
k = 0; cur = None; nw = nv = 0
while k < len(toks):
    if toks[k] == '(':
        head = toks[k + 1]
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
# --- end of lift ---
print(f'new copper from the session: {nw} track segments, {nv} vias')
for t in b.GetTracks():
    key = (t.GetClass(), t.GetNetname(), t.GetStart().x, t.GetStart().y, t.GetEnd().x, t.GetEnd().y)
    t.SetLocked(key in was_locked)
pcbnew.ZONE_FILLER(b).Fill(b.Zones())
outp = path if SAVE else '/tmp/local_freeroute_out.kicad_pcb'; b.Save(outp)
b2 = pcbnew.LoadBoard(outp); b2.BuildConnectivity(); print('saved', outp, '; unrouted connections:', b2.GetConnectivity().GetUnconnectedCount(True))
