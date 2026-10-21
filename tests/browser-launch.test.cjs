const {test}=require('node:test'),assert=require('node:assert/strict');const {openStudioBrowser}=require('../browser-launch.cjs');
test('default browser launch waits until ShellExecute command completes',async()=>{
 let resolve,done=false;const result=openStudioBrowser('http://127.0.0.1:8766',{run:async(file,args,opts)=>{assert.match(file,/powershell.exe$/);assert.ok(args.at(-1).includes("Start-Process -FilePath 'http://127.0.0.1:8766'"));assert.equal(opts.windowsHide,true);await new Promise(r=>resolve=r);},exists:()=>false}).then(v=>{done=true;return v});
 await new Promise(r=>setImmediate(r));assert.equal(done,false);resolve();assert.equal(await result,'default');
});
test('failed default browser falls back to installed Chrome with visible new-window request',async()=>{
 const calls=[];const value=await openStudioBrowser('http://127.0.0.1:8766',{env:{SystemRoot:'C:/Windows',ProgramFiles:'C:/Program Files'},exists:p=>p.endsWith('chrome.exe'),run:async(file,args)=>{calls.push({file,args});if(calls.length===1)throw Error('association failed');}});
 assert.match(value,/chrome.exe/);assert.match(calls[1].file,/powershell.exe$/);assert.ok(calls[1].args.at(-1).includes('chrome.exe'));assert.ok(calls[1].args.at(-1).includes("@('--new-window','http://127.0.0.1:8766')"));
});
test('browser errors keep the usable local URL and reject arbitrary shell text',async()=>{
 await assert.rejects(openStudioBrowser('http://127.0.0.1:8766',{run:async()=>{throw Error('failed')},exists:()=>false}),/Open http:\/\/127.0.0.1:8766 manually/);
 await assert.rejects(openStudioBrowser("http://127.0.0.1:8766';evil"),/Unexpected/);
});
