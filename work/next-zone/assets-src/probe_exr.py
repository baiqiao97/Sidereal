import OpenEXR, numpy as np, time
t=time.time()
with OpenEXR.File('assets-src/starmap_2020_16k_gal.exr') as f:
    ch=f.channels(); print('channels', list(ch.keys()))
    k=list(ch.keys())[0]; px=ch[k].pixels; print(k, px.shape, px.dtype, 'load', round(time.time()-t,1),'s')
H,W=px.shape[:2]
L=(0.2126*px[...,0].astype(np.float32)+0.7152*px[...,1]+0.0722*px[...,2])[::4,::4]
b=np.linspace(90,-90,L.shape[0])[:,None]
for name,m in (('band |b|<5',np.abs(b)<5),('|b| 5-20',(np.abs(b)>=5)&(np.abs(b)<20)),('|b|>30',np.abs(b)>30)):
    v=L[np.broadcast_to(m,L.shape)]; print(name, 'p50 %.4g p90 %.4g p99 %.4g p99.9 %.4g max %.4g'%tuple(np.percentile(v,[50,90,99,99.9]).tolist()+[v.max()]))
np.save('assets-src/_lum_q4.npy', L.astype(np.float32))
