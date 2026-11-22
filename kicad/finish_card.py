# finish_card.py: a second Freerouting pass on an already-routed board (Kehai Interim, 2026-11-22). MIT.
# usage: python3 kicad/finish_card.py <board-routed.kicad_pcb> <freerouting.jar> [passes]
# The routed board goes out as DSN with its copper: the fanout (locked, exported as fixed) and the router's wires
# (unlocked, which Freerouting may keep or rip up). Freerouting finishes what is open; its session holds every unlocked
# wire and via, so the board's unlocked copper is replaced by the session's. First use: the ALU card, 1 connection open.
# Router-made GND/+3V3 fragments that end in nothing are dropped afterwards (the planes carry power).
import sys, os, re, subprocess, time, pcbnew
path, jar = sys.argv[1], sys.argv[2]; passes = sys.argv[3] if len(sys.argv) > 3 else '10'
mm = pcbnew.FromMM
b = pcbnew.LoadBoard(path)
base = os.path.splitext(path)[0]; dsn, ses = base + '-finish.dsn', base + '-finish.ses'
pcbnew.ExportSpecctraDSN(b, dsn) or sys.exit('DSN export failed')
if os.path.exists(ses): os.remove(ses)
t0 = time.time()
r = subprocess.run(['xvfb-run', '-a', 'java', '-jar', jar, '-de', dsn, '-do', ses, '-mp', passes], capture_output=True, text=True, timeout=40000)
print('freerouting exit', r.returncode, f'{time.time() - t0:.0f} s')
if not os.path.exists(ses): sys.exit('no SES produced')
for t in list(b.GetTracks()):
    if not t.IsLocked(): b.Delete(t)
# --- lifted from route_card.py (same day, same author): the SES reader (0.1 um units, Y flipped) ---
LAYER = {'F.Cu': pcbnew.F_Cu, 'B.Cu': pcbnew.B_Cu, 'In1.Cu': pcbnew.In1_Cu, 'In2.Cu': pcbnew.In2_Cu, 'In3.Cu': pcbnew.In3_Cu, 'In4.Cu': pcbnew.In4_Cu}
txt = open(ses).read(); body = txt[txt.index('(network_out'):]
toks = re.findall(r'\(|\)|"[^"]*"|[^\s()]+', body)
def P(x, y): return pcbnew.VECTOR2I(int(int(x) * 100), int(-int(y) * 100))
k = 0; cur = None; nw = nv = 0
while k < len(toks):
    t = toks[k]
    if t == '(':
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
print(f'session read: {nw} track segments, {nv} vias')
# dangling router power fragments: an unlocked GND/+3V3 track with an end touching no pad, via or other track of its net
def ends_ok(t):
    for e in (t.GetStart(), t.GetEnd()):
        hit = False
        for o in b.GetTracks():
            if o is t or o.GetNetname() != t.GetNetname(): continue
            if o.GetClass() == 'PCB_VIA':
                if (o.GetPosition() - e).EuclideanNorm() <= o.GetWidth() / 2: hit = True; break
            elif e in (o.GetStart(), o.GetEnd()): hit = True; break
        if not hit:
            for fp in b.GetFootprints():
                for pd in fp.Pads():
                    if pd.GetNetname() == t.GetNetname() and pd.HitTest(e): hit = True; break
                if hit: break
        if not hit: return False
    return True
dropped = 0
for t in list(b.GetTracks()):
    if t.GetClass() == 'PCB_TRACK' and not t.IsLocked() and t.GetNetname() in ('GND', '+3V3') and not ends_ok(t): b.Delete(t); dropped += 1
print('dangling router power fragments dropped:', dropped)
pcbnew.ZONE_FILLER(b).Fill(b.Zones()); b.Save(path)
b2 = pcbnew.LoadBoard(path); b2.BuildConnectivity()
print('unrouted connections:', b2.GetConnectivity().GetUnconnectedCount(True))
