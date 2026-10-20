import {TGALoader} from './vendor/jsm/loaders/TGALoader.js';
export const canvas=(w,h)=>Object.assign(document.createElement('canvas'),{width:w,height:h});
export const imageFrom=src=>new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=()=>reject(new Error('图片读取失败'));im.src=src;});
export function copyCanvas(im){const c=canvas(im.width,im.height);c.getContext('2d').drawImage(im,0,0);return c;}
export async function readImage(bytes,name){
 const ext=name.split('.').pop().toLowerCase();
 if(ext==='dds')return decodeDDS(bytes);
 if(ext==='psd'){
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(bytes.length<26||v.getUint16(4)!==1||v.getUint16(22)!==8||v.getUint16(24)!==3)throw Error('PSD 请使用 RGB / 8 位格式，保存时开启最大兼容性。PSB、CMYK 和 16/32 位暂不支持。');
  const psd=globalThis.agPsd.readPsd(bytes,{skipLayerImageData:true,skipThumbnail:true,useImageData:true});
  if(!psd.imageData)throw Error('PSD 缺少合成图像，请在 Photoshop 中开启最大兼容性后重新保存。');
  const c=canvas(psd.width,psd.height);c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(psd.imageData.data),psd.width,psd.height),0,0);return c;
 }
 if(ext==='tga'){
  const t=new TGALoader().parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
  const c=canvas(t.width,t.height);c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(t.data),t.width,t.height),0,0);return c;
 }
 const url=URL.createObjectURL(new Blob([bytes]));try{return await imageFrom(url);}finally{URL.revokeObjectURL(url);}
}
export function download(data,name,type='application/octet-stream'){
 const url=URL.createObjectURL(data instanceof Blob?data:new Blob([data],{type}));
 const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
export function splitBase(im){
 const c=copyCanvas(im),g=c.getContext('2d'),d=g.getImageData(0,0,c.width,c.height),alpha=canvas(c.width,c.height),a=alpha.getContext('2d').createImageData(c.width,c.height);
 for(let i=0;i<d.data.length;i+=4){a.data[i]=a.data[i+1]=a.data[i+2]=d.data[i+3];a.data[i+3]=255;d.data[i+3]=255;}
 g.putImageData(d,0,0);alpha.getContext('2d').putImageData(a,0,0);if(im.sourceAlpha)alpha.getContext('2d').drawImage(im.sourceAlpha,0,0);
 return {base:c,alpha};
}
export function decodeDDS(bytes){
 const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 if(v.getUint32(0,true)!==0x20534444||v.getUint32(84,true)!==0||v.getUint32(88,true)!==32)throw Error('当前仅支持未压缩 32 位 DDS；请先将 DXT / BC 压缩 DDS 转为 PNG 或 TGA。');
 const w=v.getUint32(16,true),h=v.getUint32(12,true),pitch=v.getUint32(20,true)||w*4;
 if(!w||!h||w>16384||h>16384||bytes.length<128+pitch*h)throw Error('DDS 尺寸或数据长度无效');
 const masks=[92,96,100,104].map(n=>v.getUint32(n,true));
 const shift=m=>{let n=0;while(m&&!(m&1)){m>>>=1;n++;}return n;};const shifts=masks.map(shift);
 const data=new Uint8ClampedArray(w*h*4);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){const pixel=v.getUint32(128+y*pitch+x*4,true),i=(y*w+x)*4;for(let ch=0;ch<4;ch++)data[i+ch]=masks[ch]?Math.round(((pixel&masks[ch])>>>shifts[ch])*255/(masks[ch]>>>shifts[ch])):(ch===3?255:0);}
 const alpha=canvas(w,h),ad=alpha.getContext('2d').createImageData(w,h);for(let i=0;i<data.length;i+=4){ad.data[i]=ad.data[i+1]=ad.data[i+2]=data[i+3];ad.data[i+3]=255;data[i+3]=255;}alpha.getContext('2d').putImageData(ad,0,0);const c=canvas(w,h);c.getContext('2d').putImageData(new ImageData(data,w,h),0,0);c.sourceAlpha=alpha;return c;
}
export function toDDS(p){
 const w=p.canvas.width,h=p.canvas.height,g=p.canvas.getContext('2d'),data=g.getImageData(0,0,w,h).data;let alpha=null;if(p.alpha){const a=canvas(w,h);a.getContext('2d').drawImage(p.alpha,0,0,w,h);alpha=a.getContext('2d').getImageData(0,0,w,h).data;}
 const bytes=new Uint8Array(128+w*h*4),v=new DataView(bytes.buffer);const put=(o,n)=>v.setUint32(o,n,true);put(0,0x20534444);put(4,124);put(8,0x100f);put(12,h);put(16,w);put(20,w*4);put(76,32);put(80,0x41);put(88,32);put(92,0x00ff0000);put(96,0x0000ff00);put(100,0x000000ff);put(104,0xff000000);put(108,0x1000);
 for(let i=0;i<data.length;i+=4){bytes[128+i]=data[i+2];bytes[129+i]=data[i+1];bytes[130+i]=data[i];bytes[131+i]=alpha?alpha[i]:255;}return bytes;
}
