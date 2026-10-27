import numpy as np
from PIL import Image
W,H=1280,640
rng=np.random.default_rng(7)
db=rng.normal(0,1,(H,W))*0.07+0.18
# slow vertical texture
db+= (rng.normal(0,1,(1,W))*0.02)
def carrier(x0,width,amp,on=None):
    xs=np.arange(W)
    prof=amp*np.exp(-0.5*((xs-x0)/width)**2)
    m=np.ones(H) if on is None else on
    return m[:,None]*prof[None,:]
y=np.arange(H)
# FM-like constant signals
db+=carrier(130,10,0.55)+carrier(250,4,0.35)+carrier(1235,6,0.45)+carrier(560,3,0.3)+carrier(1120,4,0.38)
# wide data channel
xs0=np.arange(W); band=((xs0>1150)&(xs0<1215)).astype(float)*0.22
db+=((rng.random(H)>0.4).astype(float))[:,None]*band[None,:]
# beacon bursts on a fixed channel
bursts=((y//14)%5==0).astype(float)
db+=carrier(420,5,0.6,bursts)
# The satellite: Doppler S-curve, packet bursts (time runs down: newest at top)
xs=np.arange(W)
t=(y-330)/95.0
xc=960-130*np.tanh(t)   # frequency falls as the satellite passes
pk=(((y//9)%3)!=2).astype(float)*(np.abs(t)<2.6)
for i in range(H):
    db[i]+=0.95*pk[i]*np.exp(-0.5*((xs-xc[i])/7)**2)
    db[i]+=0.25*pk[i]*np.exp(-0.5*((xs-xc[i])/22)**2)
# second weaker pass
xc2=700-60*np.tanh((y-120)/60.0)
for i in range(0,H):
    if 0<i<260 and (i//6)%2==0:
        db[i]+=0.4*np.exp(-0.5*((xs-xc2[i])/5)**2)
v=np.clip(db,0,1)
# app colour map: navy -> blue -> cyan -> yellow -> red -> white
stops=[(0,(0.02,0.03,0.10)),(0.25,(0.05,0.15,0.55)),(0.45,(0.05,0.65,0.85)),(0.65,(0.95,0.90,0.20)),(0.85,(0.95,0.25,0.10)),(1,(1,1,1))]
sx=np.array([s[0] for s in stops]); sc=np.array([s[1] for s in stops])
rgb=np.stack([np.interp(v,sx,sc[:,k]) for k in range(3)],-1)
Image.fromarray((rgb*255).astype(np.uint8)).save('wf.png')
print('ok')
