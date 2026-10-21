const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
let child, token, temp;
const origin = 'http://127.0.0.1:18867';
const headers = () => ({ 'X-Studio-Token': token, 'Content-Type': 'application/json' });
before(async () => {
  temp = await fs.mkdtemp(path.join(__dirname, 'tmp-'));
  child = spawn(process.execPath, ['server.cjs'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: '18867' }, windowsHide: true });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(Error('Server exited ' + code))); });
  token = (await (await fetch(origin + '/api/session')).json()).token;
});
after(async () => {
  if (child) { const ended = new Promise(resolve => child.once('exit', resolve)); child.kill(); await ended; }
  const resolved = path.resolve(temp);
  if (!resolved.startsWith(path.resolve(__dirname) + path.sep)) throw Error('Unsafe test cleanup target');
  await fs.rm(resolved, { recursive: true, force: true });
});
test('workshop is local and file API requires its session token', async () => {
  assert.equal((await fetch(origin)).status, 200);
  assert.equal((await fetch(origin + '/api/watch')).status, 403);
  assert.equal((await fetch(origin + '/api/session', { headers: { Origin: 'https://unrelated.example' } })).status, 403);
});
test('file link follows stable saves and atomic file replacement, then disconnects', async () => {
  const source = path.join(temp, 'texture.png'); await fs.writeFile(source, 'first');
  const registered = await (await fetch(origin + '/api/watch', { method: 'POST', headers: headers(), body: JSON.stringify({ path: source }) })).json();
  assert.ok(registered.id);
  assert.equal(await (await fetch(origin + '/api/watch/' + registered.id + '/file', { headers: headers() })).text(), 'first');
  const replacement = path.join(temp, 'save-temp.png'); await fs.writeFile(replacement, 'second-save'); await fs.rename(replacement, source);
  await fetch(origin + '/api/watch', { headers: headers() });
  await new Promise(resolve => setTimeout(resolve, 720));
  const poll = await (await fetch(origin + '/api/watch', { headers: headers() })).json();
  assert.notEqual(poll.files[0].stamp, registered.stamp);
  assert.equal(await (await fetch(origin + '/api/watch/' + registered.id + '/file', { headers: headers() })).text(), 'second-save');
  assert.equal((await fetch(origin + '/api/watch/' + registered.id, { method: 'DELETE', headers: headers() })).status, 200);
  assert.equal((await fetch(origin + '/api/watch/' + registered.id + '/file', { headers: headers() })).status, 404);
});
test('unsupported file paths cannot become file links', async () => {
  assert.equal((await fetch(origin + '/api/watch', { method: 'POST', headers: headers(), body: JSON.stringify({ path: 'relative.png' }) })).status, 400);
  assert.equal((await fetch(origin + '/api/watch', { method: 'POST', headers: headers(), body: JSON.stringify({ path: path.join(temp, 'private.txt') }) })).status, 400);
});

test('repeated launch reuses Studio without opening a test browser', async () => {
 const result=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['server.cjs','--open','--no-open'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:'18867'},windowsHide:true});let output='';p.stdout.on('data',d=>output+=d);p.stderr.on('data',d=>output+=d);p.once('error',reject);p.once('exit',code=>resolve({code,output}));});
 assert.equal(result.code,0,result.output);assert.match(result.output,/already running/);
});

test('occupied foreign port is reported without terminating its server', async () => {
 const http=require('node:http');const foreign=http.createServer((req,res)=>res.end('another app'));await new Promise(r=>foreign.listen(0,'127.0.0.1',r));
 try {const port=foreign.address().port;const result=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['server.cjs','--open','--no-open'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port)},windowsHide:true});let output='';p.stderr.on('data',d=>output+=d);p.once('error',reject);p.once('exit',code=>resolve({code,output}));});assert.equal(result.code,1);assert.match(result.output,/occupied by another program/);assert.equal(await(await fetch('http://127.0.0.1:'+port)).text(),'another app');}
 finally{await new Promise(r=>foreign.close(r));}
});
