// memory-conv-proof.js: exhaustive check of the Memory card's stage 2 address conversion (Kehai Interim, 2026-11-18). MIT.
// Claims checked: (1) every RAM address 0 <= a < ramSize (3^14 and 3^15) gets a distinct (T, c1 + 128, c0 + 128) and
// T fits the row count; (2) every framebuffer address gets a distinct 19-bit VRAM address with T = 254..260; (3) the
// T2 rule (chunk 1 = trits 5..8, + 81 when the low 9 trits are negative; T = 0) puts a T2 access exactly where T3 puts
// phys(a) = a mod 3^9, for every low-9-trit value and assorted junk in the high trits. Run: node memory-conv-proof.js
// proof of the per-chunk (no-carry) address conversion
const toT=(v,n)=>{const t=[];let x=v;for(let i=0;i<n;i++){let r=((x%3)+3)%3;if(r===2)r=-1;t.push(r);x=(x-r)/3;}return t;};
const val=(t,lo,hi)=>{let x=0;for(let i=hi-1;i>=lo;i--)x=3*x+t[i];return x;};
const conv3=a=>{const t=toT(a,27);return [val(t,0,5)+128,val(t,5,10)+128,val(t,10,16)];};
const FB_BASE=15000000,FB_END=15354294;
for (const ramSize of [3**14, 3**15]) { const seen=new Uint8Array(1<<24); let Tmax=-1,Tmin=1e9, lo0=999,hi0=-1;
  for(let a=0;a<ramSize;a++){const [b0,b1,T]=conv3(a); if(T<0||T>255) throw 'T '+a; const k=(T<<16)|(b1<<8)|b0; if(seen[k]) throw 'dup '+a; seen[k]=1; Tmax=Math.max(Tmax,T);Tmin=Math.min(Tmin,T); lo0=Math.min(lo0,b0);hi0=Math.max(hi0,b0);}
  console.log('ramSize',ramSize,'T',Tmin,Tmax,'rows',(Tmax>>5)+1,'byte range',lo0,hi0); }
{ let Tmin=1e9,Tmax=-1; const seen=new Uint8Array(1<<19);
  for(let a=FB_BASE;a<FB_END;a++){const [b0,b1,T]=conv3(a); Tmin=Math.min(Tmin,T);Tmax=Math.max(Tmax,T); const k=((T-254)<<16)|(b1<<8)|b0; if(k>=(1<<19)||k<0||seen[k]) throw 'fb '+a; seen[k]=1;}
  console.log('FB T',Tmin,Tmax); }
// T2: microsim phys = a mod 19683; card rule: b0 from trits0..4, b1 from trits0..8 (sign rule), T=0
const phys=a=>{const r=a%19683;return r<0?r+19683:r;};
const conv2=a=>{const t=toT(a,27);const L=val(t,0,9);const c1=val(t,5,9)+(L<0?81:0);return [val(t,0,5)+128,c1+128,0];};
let n=0; for(let L=-9841;L<=9841;L++) for(const hi of [0,1,-1,5,-777,123456,-(3**17)]) { const a=L+19683*hi; if(Math.abs(a)>(3**27-1)/2) continue;
  const x=conv2(a), y=conv3(phys(a)); if(x.join()!==y.join()) throw 'T2 '+a+' '+x+' '+y; n++; }
console.log('T2 ok over',n,'addresses');
