// Isolated Chromium smoke checks; never connects to the user's Chrome profile.
const {spawn}=require('node:child_process');const fs=require('node:fs'),path=require('node:path');
const url=process.argv[2]||'http://127.0.0.1:8766/tests/mipmap.html';
const child=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--use-angle=swiftshader','--enable-unsafe-swiftshader','--user-data-dir='+path.resolve('output/mip-cdp-profile'),'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let ws,next=0;const pending=new Map(),errors=[];
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
(async()=>{
 try{
 const browserURL=await new Promise((resolve,reject)=>{let log='';child.stderr.on('data',b=>{log+=b;const m=log.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m)resolve(m[1]);});setTimeout(()=>reject(Error('Chrome startup timed out')),15000).unref();child.once('error',reject);});
 const port=new URL(browserURL).port;const target=await (await fetch(`http://127.0.0.1:${port}/json/new?`+encodeURIComponent(url),{method:'PUT'})).json();
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(m.error)p.reject(Error(m.error.message));else p.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text+' '+(m.params.exceptionDetails.exception?.description||''));};
 await call('Runtime.enable');
 const result=await call('Runtime.evaluate',{expression:`new Promise(resolve=>{const end=Date.now()+55000;const timer=setInterval(()=>{const text=document.getElementById('result')?.textContent||'';if(text.includes('ALL CHECKS PASSED')||text.includes('FAIL')||Date.now()>end){clearInterval(timer);resolve({text,frameStatus:document.querySelector('iframe')?.contentDocument?.getElementById('status')?.textContent});}},200);})`,awaitPromise:true,returnByValue:true});
 const value=result.result.value;console.log(JSON.stringify({url,...value,errors},null,2));fs.writeFileSync('output/browser-check-result.json',JSON.stringify({url,...value,errors},null,2));if(!value?.text?.includes('ALL CHECKS PASSED')||errors.length)process.exitCode=1;
 await call('Emulation.setDeviceMetricsOverride',{width:1500,height:1100,deviceScaleFactor:1,mobile:false});
 await call('Runtime.evaluate',{expression:`document.getElementById('result').hidden=true;const f=document.querySelector('iframe');if(f){f.style.width='100%';f.style.height='1060px';f.contentDocument.getElementById('distancePanel').open=true;}`});
 await call('Page.captureScreenshot',{format:'png'}).then(r=>fs.writeFileSync('output/distance-ui-check.png',Buffer.from(r.data,'base64')));
 await call('Browser.close');
 }catch(e){console.error(e);process.exitCode=1;child.kill();}finally{ws?.close();}
})();
