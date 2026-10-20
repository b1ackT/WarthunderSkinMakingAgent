#!/usr/bin/env node
// Local agent adapter. It does not launch Codex, call a model or require an API key.
const fs = require('node:fs/promises');
const path = require('node:path');
const args = process.argv.slice(2), command = args.shift() || 'status';
function option(name, fallback) { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : fallback; }
const origin = option('url', 'http://127.0.0.1:8766');
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) throw Error('Only a local Skin Studio URL is supported');
async function main() {
  const session = await (await fetch(origin + '/api/session')).json();
  const request = async (suffix = '', method = 'GET', data) => {
    const response = await fetch(origin + '/api/agent' + suffix, { method, headers: { 'X-Studio-Token': session.token, ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
    const result = await response.json(); if (!response.ok) throw Error(result.error || 'Request failed'); return result;
  };
  const input = async () => { const file = option('file'); if (!file) throw Error('Use --file <JSON file>'); return JSON.parse(await fs.readFile(file, 'utf8')); };
  let result;
  if (command === 'status') result = await request();
  else if (command === 'claim') result = await request('/claim', 'POST', { worker: option('worker', '当前对话中的 Agent') });
  else if (command === 'asset') {
    const file = option('path'); if (!file) throw Error('Use --path <local image>'); const bytes = await fs.readFile(file), ext = path.extname(file).toLowerCase(), mime = ext === '.jpg' || ext === '.jpeg' ? 'jpeg' : ext === '.webp' ? 'webp' : 'png';
    result = await request('/assets', 'POST', { name: option('name', path.basename(file)), role: option('role', 'generated'), source: 'agent', prompt: option('prompt', ''), dataUrl: `data:image/${mime};base64,${bytes.toString('base64')}` });
  } else if (['apply', 'event', 'stage', 'complete', 'control', 'start'].includes(command)) {
    result = await request(({ apply: '/commands', event: '/event', stage: '/stage', complete: '/complete', control: '/control', start: '/job' })[command], 'POST', await input());
    if (command === 'apply' && args.includes('--wait')) {
      const id = result.id, deadline = Date.now() + Number(option('timeout', 60000));
      while (Date.now() < deadline) { const current = await request('/commands/' + id); if (['applied', 'failed', 'cancelled'].includes(current.status)) { result = current; break; } await new Promise(r => setTimeout(r, 350)); }
      if (result.status === 'queued') throw Error('编辑器未确认应用。操作已排队，请检查网页或运行 status。');
      if (result.status !== 'applied') throw Error(result.error || result.result?.message || result.status);
    }
  } else if (command === 'preview') {
    const response = await fetch(origin + '/api/agent/preview', { headers: { 'X-Studio-Token': session.token } }); if (!response.ok) throw Error('编辑器尚未提供预览');
    const output = path.resolve(option('out', path.join(__dirname, '.studio-agent', 'preview-copy.png'))); await fs.writeFile(output, Buffer.from(await response.arrayBuffer())); result = { path: output };
  } else throw Error('Commands: status, claim, asset, apply, event, stage, complete, control, start, preview');
  if (option('out') && command !== 'preview') await fs.writeFile(option('out'), JSON.stringify(result, null, 2));
  else process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
main().catch(error => { console.error(error.message === 'fetch failed' ? 'Skin Studio 未启动。请先运行 server.cjs 并打开编辑器。' : error.message); process.exitCode = 1; });
