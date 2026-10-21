const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const fs=require('node:fs');
const path=require('node:path');
// Await ShellExecute before a reused-server launcher exits; do not unref the opener.
async function openStudioBrowser(url,{run=promisify(execFile),env=process.env,exists=fs.existsSync}={}){
 if(!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(url))throw Error('Unexpected Studio browser URL');
 const options={windowsHide:true,timeout:12000,maxBuffer:65536};const failures=[];
 const powershell=path.join(env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 try{await run(powershell,['-NoProfile','-NonInteractive','-Command',`Start-Process -FilePath '${url}' -ErrorAction Stop`],options);return 'default';}catch(e){failures.push(e.message);}
 const candidates=[
  [env.ProgramFiles,'Google','Chrome','Application','chrome.exe'],
  [env.LOCALAPPDATA,'Google','Chrome','Application','chrome.exe'],
  [env['ProgramFiles(x86)'],'Microsoft','Edge','Application','msedge.exe'],
  [env.ProgramFiles,'Microsoft','Edge','Application','msedge.exe']
 ].filter(p=>p[0]).map(p=>path.join(...p));
 for(const executable of candidates)if(exists(executable)){
  try{await run(powershell,['-NoProfile','-NonInteractive','-Command',`Start-Process -FilePath '${executable.replaceAll("'", "''")}' -ArgumentList @('--new-window','${url}') -ErrorAction Stop`],options);return path.basename(executable);}catch(e){failures.push(e.message);}
 }
 throw Error('Browser could not open. Open '+url+' manually. '+failures.join(' | '));
}
module.exports={openStudioBrowser};
