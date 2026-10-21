const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { AgentStore } = require('./agent-store.cjs');
const run = promisify(execFile);
const root = __dirname, port = Number(process.env.PORT || 8766);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('PORT must be an integer between 1 and 65535');
const reuseExisting = process.argv.includes('--open'), wantsBrowser = reuseExisting && !process.argv.includes('--no-open');
const token = crypto.randomBytes(32).toString('hex');
const agent = new AgentStore(root);
const watches = new Map();
const extensions = new Set(['.psd', '.png', '.jpg', '.jpeg', '.webp', '.tga', '.dds']);
const types = { '.zip': 'application/zip', '.webp': 'image/webp', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.obj': 'text/plain', '.mtl': 'text/plain', '.md': 'text/plain; charset=utf-8' };
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); }
function stamp(stat) { return stat.mtimeMs + ':' + stat.size; }
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 48 * 1024 * 1024) throw Error('Request too large'); chunks.push(chunk); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
function openBrowser() {
  const url = 'http://127.0.0.1:' + port;
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start', '', url], { windowsHide: true, stdio: 'ignore' });
  child.once('error', error => console.error('Browser could not open: ' + error.message + '. Open ' + url + ' manually.'));
  child.once('exit', code => { if (code) console.error('Open ' + url + ' manually in your browser.'); }); child.unref();
}
async function inspect(file) {
  const stat = await fsp.stat(file); if (!stat.isFile()) throw Error('请选择文件，不是文件夹。');
  if (stat.size > 512 * 1024 * 1024) throw Error('文件超过 512 MB，请导出精简 PSD 或 PNG。'); return stat;
}
async function handleAPI(req, res, url) {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!allowed.has(req.headers.host) || (req.headers.origin && !allowed.has(new URL(req.headers.origin).host))) return json(res, 403, { error: '仅允许本地 Skin Studio 页面调用。' });
  if (url.pathname === '/api/session' && req.method === 'GET') return json(res, 200, { token });
  if (req.headers['x-studio-token'] !== token) return json(res, 403, { error: '本地会话已失效，请刷新页面后重新连接。' });
  if (url.pathname.startsWith('/api/agent')) {
    await agent.ready;
    const suffix = url.pathname.slice('/api/agent'.length);
    if (!suffix && req.method === 'GET') return json(res, 200, agent.view());
    if (suffix === '/context' && req.method === 'POST') { const data = await body(req); return json(res, 200, await agent.updateContext(data.context, data.preview)); }
    if (suffix === '/job' && req.method === 'POST') return json(res, 200, await agent.start(await body(req)));
    if (suffix === '/claim' && req.method === 'POST') return json(res, 200, await agent.claim(await body(req)));
    if (suffix === '/control' && req.method === 'POST') { const data = await body(req); return json(res, 200, await agent.control(data.action, data)); }
    if (suffix === '/event' && req.method === 'POST') return json(res, 200, await agent.log(await body(req)));
    if (suffix === '/stage' && req.method === 'POST') return json(res, 200, await agent.stage(await body(req)));
    if (suffix === '/complete' && req.method === 'POST') return json(res, 200, await agent.complete(await body(req)));
    if (suffix === '/assets' && req.method === 'POST') return json(res, 200, await agent.addAsset(await body(req)));
    const assetMatch = suffix.match(/^\/assets\/([^/]+)(\/file)?$/);
    if (assetMatch) {
      if (req.method === 'PATCH') return json(res, 200, await agent.updateAsset(assetMatch[1], await body(req)));
      if (req.method === 'GET' && assetMatch[2]) { const file = await agent.assetFile(assetMatch[1]); res.writeHead(200, { 'Content-Type': file.path.endsWith('.jpg') ? 'image/jpeg' : file.path.endsWith('.webp') ? 'image/webp' : 'image/png', 'Cache-Control': 'no-store' }); return fs.createReadStream(file.path).pipe(res); }
    }
    if (suffix === '/commands' && req.method === 'GET') return json(res, 200, { commands: await agent.pollCommands(), job: agent.job });
    if (suffix === '/commands' && req.method === 'POST') return json(res, 200, await agent.enqueue(await body(req)));
    const ack = suffix.match(/^\/commands\/([^/]+)$/);
    if (ack && req.method === 'POST') return json(res, 200, await agent.acknowledge(ack[1], await body(req)));
    if (ack && req.method === 'GET') return json(res, 200, agent.commands.find(c => c.id === ack[1]) || { error: '操作不存在' });
    if (suffix === '/preview' && req.method === 'GET') { const bytes = await fsp.readFile(path.join(agent.root, 'preview.png')); res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); return res.end(bytes); }
    return json(res, 404, { error: '未知 Agent 操作' });
  }
  if (url.pathname === '/api/browse' && req.method === 'POST') {
    const script = `Add-Type -AssemblyName System.Windows.Forms; $dialog=New-Object System.Windows.Forms.OpenFileDialog; $dialog.Title='Skin Studio - Photoshop source'; $dialog.Filter='PSD and textures|*.psd;*.png;*.jpg;*.jpeg;*.webp;*.tga;*.dds'; if($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($dialog.FileName)))}`;
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 180000 });
    return json(res, 200, { path: stdout.trim() ? Buffer.from(stdout.trim(), 'base64').toString('utf8') : null });
  }
  if (url.pathname === '/api/watch' && req.method === 'POST') {
    const input = await body(req), file = input.path;
    if (typeof file !== 'string' || !path.isAbsolute(file)) return json(res, 400, { error: '请选择文件或输入完整的本地文件路径。' });
    if (!extensions.has(path.extname(file).toLowerCase())) return json(res, 400, { error: '支持 PSD、PNG、JPG、WebP、TGA 和 DDS。' });
    if (watches.size >= 24) return json(res, 400, { error: '最多连接 24 个文件，请先断开不用的联动。' });
    const resolved = path.resolve(file), stat = await inspect(resolved), id = crypto.randomUUID();
    watches.set(id, { path: resolved, observed: stamp(stat), stable: stamp(stat), since: Date.now() });
    return json(res, 200, { id, path: resolved, stamp: stamp(stat) });
  }
  if (url.pathname === '/api/watch' && req.method === 'GET') {
    const files = [];
    for (const [id, watch] of watches) {
      try {
        const stat = await inspect(watch.path), next = stamp(stat);
        if (next !== watch.observed) { watch.observed = next; watch.since = Date.now(); }
        if (Date.now() - watch.since >= 650) watch.stable = next;
        files.push({ id, stamp: watch.stable });
      } catch (error) { files.push({ id, error: error.code === 'ENOENT' ? '源文件暂时不存在，等待 PS 保存完成…' : error.message }); }
    }
    return json(res, 200, { files });
  }
  const match = url.pathname.match(/^\/api\/watch\/([^/]+)(\/file)?$/);
  if (match) {
    const watch = watches.get(match[1]); if (!watch) return json(res, 404, { error: '文件未连接，请重新选择。' });
    if (req.method === 'DELETE' && !match[2]) { watches.delete(match[1]); return json(res, 200, { ok: true }); }
    if (req.method === 'GET' && match[2]) {
      const before = await inspect(watch.path), bytes = await fsp.readFile(watch.path), after = await inspect(watch.path);
      if (stamp(before) !== stamp(after)) return json(res, 409, { error: '文件仍在保存，稍后自动重试。' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); return res.end(bytes);
    }
  }
  json(res, 404, { error: 'Unknown API' });
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1:' + port);
    if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('skin-studio-workshop-v2'); }
    if (url.pathname.startsWith('/api/')) return await handleAPI(req, res, url);
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
    let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    if (file === root) file = path.join(root, 'index.html');
    const stat = await fsp.stat(file); if (!stat.isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') return res.end(); fs.createReadStream(file).pipe(res);
  } catch (error) { if (!res.headersSent) json(res, error.code === 'ENOENT' ? 404 : 400, { error: error.code === 'ENOENT' ? '文件不存在，请检查路径。' : error.message }); else res.end(); }
});
server.on('error', async error => {
  if (error.code === 'EADDRINUSE' && reuseExisting) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(2500) });
      if (response.ok && (await response.text()) === 'skin-studio-workshop-v2') {
        console.log('Skin Studio is already running: http://127.0.0.1:' + port); if (wantsBrowser) openBrowser(); return;
      }
    } catch {}
  }
  console.error(error.code === 'EADDRINUSE' ? 'Port ' + port + ' is occupied by another program. Close that program or choose a different PORT.' : error.message); process.exitCode = 1;
});
agent.ready.then(() => server.listen(port, '127.0.0.1', () => { console.log('Skin Studio: http://127.0.0.1:' + port); if (wantsBrowser) openBrowser(); })).catch(error => { console.error('Cannot initialize Skin Studio workspace: ' + error.message); process.exitCode = 1; });
