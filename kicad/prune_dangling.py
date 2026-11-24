# prune_dangling.py: delete unlocked track segments with an end that touches nothing of their net, repeatedly
# (Kehai Interim, 2026-11-24). MIT. usage: python3 kicad/prune_dangling.py <board.kicad_pcb>
# Router crumbs (GND/+3V3 fragments the planes make pointless) and stubs left when local_reroute.py reconnects a clipped
# net by a better path. Locked copper (the power fanout) is never touched. An end "touches" a same-net track end, a
# same-net via, or a same-net pad.
import sys, pcbnew
path = sys.argv[1]; b = pcbnew.LoadBoard(path)
pads = {}
for fp in b.GetFootprints():
    for pd in fp.Pads(): pads.setdefault(pd.GetNetname(), []).append(pd)
gone = 0
while True:
    ends, vias = {}, {}
    trs = [t for t in b.GetTracks()]
    for t in trs:
        if t.GetClass() == 'PCB_VIA': vias.setdefault(t.GetNetname(), []).append(t)
        else:
            for e in (t.GetStart(), t.GetEnd()): ends[(t.GetNetname(), e.x, e.y)] = ends.get((t.GetNetname(), e.x, e.y), 0) + 1
    segs = {}
    for t in trs:
        if t.GetClass() != 'PCB_VIA': segs.setdefault((t.GetNetname(), t.GetLayer()), []).append(t)
    def on_copper(t, e):
        # 2026-11-24: an end that lands ON another same-net track (nm-off joins, T-junctions) is connected; the first
        # version wanted the exact same endpoint and pruned 2 real connections on the Control card
        for o in segs.get((t.GetNetname(), t.GetLayer()), []):
            if o is t: continue
            a_, c_ = o.GetStart(), o.GetEnd(); vx, vy = c_.x - a_.x, c_.y - a_.y; L = vx * vx + vy * vy
            u = 0 if L == 0 else max(0, min(1, ((e.x - a_.x) * vx + (e.y - a_.y) * vy) / L))
            if ((e.x - a_.x - u * vx) ** 2 + (e.y - a_.y - u * vy) ** 2) ** 0.5 <= o.GetWidth() / 2: return True
        return False
    kill = []
    for t in trs:
        if t.GetClass() == 'PCB_VIA' or t.IsLocked(): continue
        n = t.GetNetname()
        for e in (t.GetStart(), t.GetEnd()):
            if ends[(n, e.x, e.y)] > 1 or on_copper(t, e): continue
            if any((v.GetPosition() - e).EuclideanNorm() <= v.GetWidth() / 2 for v in vias.get(n, [])): continue
            if any(pd.HitTest(e) for pd in pads.get(n, [])): continue
            kill.append(t); break
    if not kill: break
    for t in kill: b.Delete(t)
    gone += len(kill)
pcbnew.ZONE_FILLER(b).Fill(b.Zones()); b.Save(path)
print('pruned', gone, 'dangling segments')
