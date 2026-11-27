# airwire_crossings.py: airwire length and crossings of a placed board (MST per signal net, Manhattan) (Kehai Interim, 2026-11-27). MIT.
# usage: python3 kicad/airwire_crossings.py <board.kicad_pcb> <card netlist.json> [swaps.json]
import sys, json, numpy as np, pcbnew
from scipy.sparse.csgraph import minimum_spanning_tree
from pinouts import PARTS, RPACK_SMD
PARTS={**PARTS,**RPACK_SMD}
b=pcbnew.LoadBoard(sys.argv[1]); card=json.load(open(sys.argv[2])); sw=json.load(open(sys.argv[3]))['chips'] if len(sys.argv)>3 else {}
pos={(fp.GetReference(),pad.GetNumber()):(pad.GetPosition().x/1e6,pad.GetPosition().y/1e6,fp.IsFlipped()) for fp in b.GetFootprints() for pad in fp.Pads()}
def grp(part,g):
    ks=[k for k in PARTS[part]['pins'] if (k[0]=='A' and k[1:].isdigit()) if g=='A'] if g=='A' else [k for k in PARTS[part]['pins'] if k.startswith('IO') and k[2:].isdigit()]
    return sorted(ks,key=lambda k:int(k.lstrip('AIO')))
segs=[]; nets={}
for c in card['chips']:
    pins=dict(c['pins']); r=c['ref']
    if r in sw:
        for g,perm in sw[r].items():
            ks=grp(c['part'],g); old=[pins.get(k,'GND' if g=='A' else '') for k in ks]
            for k,j in zip(ks,perm):
                if old[j]: pins[k]=old[j]
                else: pins.pop(k,None)
    tab=PARTS.get(c['part']) or RPACK_SMD.get(c['part'])
    for pin,n in pins.items():
        if n in ('GND','VCC','+3V3') or not tab or pin not in tab['pins']: continue
        p=(r,str(tab['pins'][pin]))
        if p in pos: nets.setdefault(n,[]).append(pos[p])
for n,pts in nets.items():
    if len(pts)<2: continue
    P=np.array([p[:2] for p in pts]); D=np.abs(P[:,None]-P[None]).sum(-1)+1e-9
    T=minimum_spanning_tree(D).tocoo()
    for i,j in zip(T.row,T.col): segs.append((P[i],P[j],n))
A=np.array([s[0] for s in segs]); B=np.array([s[1] for s in segs])
def ccw(a,b,c): return (c[...,1]-a[...,1])*(b[...,0]-a[...,0])-(b[...,1]-a[...,1])*(c[...,0]-a[...,0])
cross=0; L=len(segs)
for i in range(L):
    a,b=A[i],B[i]; c,d=A[i+1:],B[i+1:]
    s1=ccw(a,b,c)*ccw(a,b,d); s2=ccw(c,d,a[None])*ccw(c,d,b[None])
    cross+=int(((s1<0)&(s2<0)).sum())
lens=np.abs(A-B).sum(1)
print(f'segments {L}  crossings {cross}  total {lens.sum():.0f} mm  short(<5mm) {int((lens<5).sum())}')
