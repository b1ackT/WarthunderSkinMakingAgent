const {test}=require('node:test');const assert=require('node:assert/strict');
test('distance anchors and intermediate weights stay normalized',async()=>{
 const {mipWeights}=await import('../mipmap.js');const c={enabled:true,midLevel:3,farLevel:6};
 assert.deepEqual(mipWeights(0,c),{near:1,mid:0,far:0});assert.deepEqual(mipWeights(3,c),{near:0,mid:1,far:0});assert.deepEqual(mipWeights(6,c),{near:0,mid:0,far:1});
 assert.deepEqual(mipWeights(1.5,c),{near:.5,mid:.5,far:0});for(let i=0;i<150;i++){const w=Object.values(mipWeights(i/10,c));assert.ok(w.every(x=>x>=0&&x<=1));assert.ok(Math.abs(w.reduce((a,b)=>a+b,0)-1)<1e-12);}
 assert.deepEqual(mipWeights(12,{enabled:false}),{near:1,mid:0,far:0});
});
test('rectangular mip chains reach one texel and settings reject bad anchors',async()=>{
 const {mipDimensions,validateMipmap,normalizeMipmap,layerInBand}=await import('../mipmap.js');const a=mipDimensions(2048,1024);assert.equal(a.length,12);assert.deepEqual(a.at(-2),{width:2,height:1});assert.deepEqual(a.at(-1),{width:1,height:1});assert.throws(()=>validateMipmap({midLevel:6,farLevel:3}));assert.throws(()=>validateMipmap({enabled:'true'}));assert.throws(()=>validateMipmap({farLevel:NaN}));assert.equal(normalizeMipmap().enabled,false);assert.ok(layerInBand({},'near'));assert.ok(!layerInBand({distanceBand:'far'},'near'));
});
function solid(w,h,r,g,b){return{width:w,height:h,getContext:()=>({getImageData:()=>({data:Uint8ClampedArray.from(Array.from({length:w*h},()=>[r,g,b,255]).flat())})})};}
test('DDS contains distinct mip pixels, correct flags, offsets and alpha policy',async()=>{
 const {toDDS}=await import('../image-io.js');const m=[solid(4,2,255,0,0),solid(2,1,0,255,0),solid(1,1,0,0,255)],dds=toDDS({canvas:m[0]},{mipmaps:m,alphaOverride:0}),v=new DataView(dds.buffer);
 assert.equal(v.getUint32(28,true),3);assert.ok(v.getUint32(8,true)&0x20000);assert.equal(v.getUint32(108,true)&0x400008,0x400008);assert.equal(dds.length,128+44);
 assert.deepEqual([...dds.slice(128,132)],[0,0,255,0]);assert.deepEqual([...dds.slice(160,164)],[0,255,0,0]);assert.deepEqual([...dds.slice(168,172)],[255,0,0,0]);
 assert.throws(()=>toDDS({canvas:m[0]},{mipmaps:[m[0],m[2]]}),/尺寸/);assert.throws(()=>toDDS({canvas:m[0]},{mipmaps:m.slice(0,2)}),/完整/);
});
