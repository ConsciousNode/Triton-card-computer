# compare_look.py: two placed boards side by side, every unrouted connection drawn (Kehai Interim, 2026-11-27). MIT.
# usage: python3 kicad/compare_look.py <a.kicad_pcb> <title a> <b.kicad_pcb> <title b> <out.png>
import sys, json, numpy as np, pcbnew, matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
from scipy.sparse.csgraph import minimum_spanning_tree
fig, axs = plt.subplots(1, 2, figsize=(12, 9), facecolor='#0e1116')
for ax, (path, title) in zip(axs, [(sys.argv[1], sys.argv[2]), (sys.argv[3], sys.argv[4])]):
    b = pcbnew.LoadBoard(path); nets = {}
    for fp in b.GetFootprints():
        bb = fp.GetBoundingBox(False, False)
        if fp.GetReference() != 'J1' and not fp.GetReference().startswith('C'):
            back = fp.GetLayer() == pcbnew.B_Cu
            ax.add_patch(plt.Rectangle((bb.GetX()/1e6, bb.GetY()/1e6), bb.GetWidth()/1e6, bb.GetHeight()/1e6, fill=False, ec='#6b5a8a' if back else '#c9b26b', lw=0.5, ls='--' if back else '-'))
        for pd in fp.Pads():
            n = pd.GetNetname()
            if n and n not in ('GND', '+3V3', '+5V'): nets.setdefault(n, []).append((pd.GetPosition().x/1e6, pd.GetPosition().y/1e6))
    tot = 0
    for pts in nets.values():
        if len(pts) < 2: continue
        P = np.array(pts); T = minimum_spanning_tree(np.abs(P[:, None]-P[None]).sum(-1)+1e-9).tocoo()
        for i, j in zip(T.row, T.col):
            ax.plot([P[i,0], P[j,0]], [P[i,1], P[j,1]], color='#58c4dc', lw=0.25, alpha=0.5); tot += abs(P[i]-P[j]).sum()
    ax.set_xlim(0, 160); ax.set_ylim(233.35, 0); ax.set_aspect('equal'); ax.axis('off')
    ax.set_title(f'{title}\nunrouted length {tot/1000:.1f} m', color='#e8e2d0', fontsize=12)
fig.suptitle('Memory card (6U): every unrouted connection, front + back (back-side parts dashed)', color='#f0b44c', y=0.995)
plt.tight_layout(rect=(0, 0, 1, 0.96)); plt.savefig(sys.argv[5], dpi=110, facecolor='#0e1116')
