import { download } from './image-io.js';
const $ = id => document.getElementById(id);
const roleNames = { reference: '综合参考', style: '风格参考', character: '主体 / 角色', background: '背景参考', decoration: '装饰 / 标记', material: '材质参考' };
const phases = { idle: '未提交任务', queued: '等待 Agent 读取', running: 'Agent 创作中', paused: '已暂停', completed: '本次创作完成', cancelled: '已取消' };

export class AgentWorkspace {
  constructor(adapter) {
    this.adapter = adapter; this.session = null; this.urls = new Map(); this.executing = false; this.polling = false; this.uploading = false; this.targetAsset = null; this.placement = null; this.lastContext = ''; this.eventsSignature = ''; this.assetsSignature = '';
    this.mount(); this.bind(); this.poll().catch(adapter.fail); this.timer = setInterval(() => this.poll().catch(() => {}), 1000);
  }
  async api(suffix = '', method = 'GET', data) { return this.adapter.api('/api/agent' + suffix, { method, ...(data ? { body: JSON.stringify(data) } : {}) }); }
  mount() {
    const panel = document.createElement('section'); panel.id = 'agentPanel'; panel.className = 'agent-panel';
    panel.innerHTML = `<div class="agent-heading"><div><span class="eyebrow">HUMAN × AGENT</span><h2>皮肤创作工作台</h2></div><span class="agent-status" id="agentStatus">未提交任务</span><button id="toggleAgent">收起</button></div>
    <div id="agentBody" class="agent-body"><div class="agent-brief"><label for="agentBrief">这次想做什么？</label><textarea id="agentBrief" rows="3" placeholder="描述人设、风格、配色、文字和大概位置；也可以只给图片，让 Agent 自由发挥。"></textarea><div class="agent-options"><div><label for="agentStages">分段 · 每行一个，可自由增加</label><textarea id="agentStages" rows="3">风格\n材质\n图像或角色</textarea></div><div><label><input id="agentPauseStages" type="checkbox" checked> 每段完成后暂停</label><label><input id="agentResearch" type="checkbox" checked> 可上网查找设定与参考</label><button id="agentAddReferences">＋ 添加参考图片（可多选）</button><button id="agentMarkGlobal">在模型上圈出大概位置</button></div></div><div class="agent-actions"><button id="agentSubmit" class="primary">提交创作任务</button><button id="agentCopy">复制给当前对话</button><button id="agentExportTask">导出任务说明</button></div><p class="hint">当前对话协作模式：任务由 Agent 读取后执行；此网页不自动调用模型或启动 Codex。</p></div>
    <div class="agent-monitor"><div id="agentStageList" class="agent-stages"></div><div id="agentActivity" class="agent-activity" aria-live="polite"><p class="hint">真实的阶段、生成与落图记录会出现在这里。</p></div><label for="agentFeedback">中途修改 / 风格调整</label><textarea id="agentFeedback" rows="2" placeholder="例如：保留背景，只把当前主体改成侧身姿势；或把整体风格改为冷色。"></textarea><div class="agent-actions"><button id="agentPause">暂停</button><button id="agentResume">继续</button><button id="agentRevise" class="primary">提交修改</button><button id="agentCancel">结束任务</button></div></div></div>
    <details class="agent-library" open><summary>参考素材与生成资产 <span id="agentAssetCount">0</span></summary><div id="agentReferences" class="agent-references"></div></details>`;
    document.querySelector('.workspace-top').after(panel);
    const bar = document.createElement('div'); bar.id = 'agentSticky'; bar.className = 'agent-sticky'; bar.innerHTML = '<span id="agentStickyStatus">Agent 工作台 · 当前对话协作</span><button id="agentQuickPause">暂停</button><button id="agentQuickEdit">修改提示词</button>'; panel.after(bar);
    const tools = document.createElement('div'); tools.id = 'agentLayerTools'; tools.className = 'agent-layer-tools'; tools.innerHTML = `<label class="label">Agent · 只修改选中图层</label><p class="hint" id="agentLayerDescription">背景、主体、装饰和文字独立修改。</p><label class="hint"><input id="agentLayerLock" type="checkbox"> 锁定图层，Agent 不可修改</label><textarea id="agentLayerPrompt" rows="2" placeholder="对这一个图层提出修改要求，例如姿势、画风、细节。"></textarea><button id="agentLayerRevise" class="wide">提交此图层的修改</button><div class="row"><select id="agentVersions" aria-label="图层历史版本"></select><button id="agentRestoreVersion">恢复</button></div>`;
    $('properties').append(tools);
    const file = document.createElement('input'); file.type = 'file'; file.multiple = true; file.accept = 'image/png,image/jpeg,image/webp'; file.id = 'agentFileInput'; file.hidden = true; document.body.append(file);
    const overlay = document.createElement('div'); overlay.id = 'agentRegionOverlay'; overlay.hidden = true; overlay.innerHTML = '<div id="agentRegionBox"></div><span>拖出范围标记位置 · 松开确认 · Esc 取消</span>'; $('viewport').append(overlay);
  }
  bind() {
    $('toggleAgent').onclick = () => { $('agentBody').hidden = !$('agentBody').hidden; $('toggleAgent').textContent = $('agentBody').hidden ? '展开' : '收起'; };
    $('agentAddReferences').onclick = () => $('agentFileInput').click(); $('agentFileInput').onchange = () => this.upload([...$('agentFileInput').files]);
    $('agentSubmit').onclick = () => this.submit().catch(this.adapter.fail);
    for (const [id, action] of [['agentPause', 'pause'], ['agentQuickPause', 'pause'], ['agentResume', 'resume'], ['agentCancel', 'cancel']]) $(id).onclick = () => this.control(action).catch(this.adapter.fail);
    $('agentRevise').onclick = () => this.control('revise', { prompt: $('agentFeedback').value, target: null }).then(() => $('agentFeedback').value = '').catch(this.adapter.fail);
    $('agentCopy').onclick = () => this.copyTask().catch(this.adapter.fail);
    $('agentExportTask').onclick = () => download(JSON.stringify({ instructions: this.instructions(), ...this.session }, null, 2), 'skin-agent-task.json', 'application/json');
    $('agentQuickEdit').onclick = () => { $('agentBody').hidden = false; $('toggleAgent').textContent = '收起'; $('agentFeedback').focus(); $('agentPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    $('agentMarkGlobal').onclick = () => this.mark(null).catch(this.adapter.fail);
    $('agentLayerRevise').onclick = () => this.reviseLayer().catch(this.adapter.fail);
    $('agentLayerLock').onchange = () => this.adapter.lockLayer($('agentLayerLock').checked);
    $('agentRestoreVersion').onclick = () => this.restoreVersion().catch(this.adapter.fail);
    const overlay = $('agentRegionOverlay'); let selection;
    overlay.onpointerdown = e => { const r = overlay.getBoundingClientRect(); selection = { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height }; overlay.setPointerCapture(e.pointerId); this.drawRegion(selection.x, selection.y, 0, 0); };
    overlay.onpointermove = e => { if (!selection) return; const r = overlay.getBoundingClientRect(); this.drawRegion(Math.min(selection.x, e.clientX - r.left), Math.min(selection.y, e.clientY - r.top), Math.abs(e.clientX - r.left - selection.x), Math.abs(e.clientY - r.top - selection.y)); };
    overlay.onpointerup = async e => {
      if (!selection) return; const r = overlay.getBoundingClientRect(), x2 = e.clientX - r.left, y2 = e.clientY - r.top;
      const w = Math.max(.03, Math.abs(x2 - selection.x) / r.width), h = Math.max(.03, Math.abs(y2 - selection.y) / r.height);
      const placement = { mode: 'projection', camera: this.adapter.context().camera, viewport: { width: r.width, height: r.height }, rect: { cx: (x2 + selection.x) / (2 * r.width), cy: (y2 + selection.y) / (2 * r.height), w, h, angle: 0 }, targets: this.adapter.context().parts.map(p => p.id) };
      selection = null; overlay.hidden = true; this.adapter.endRegion();
      try { if (this.targetAsset) await this.api('/assets/' + this.targetAsset, 'PATCH', { placement }); else { this.placement = placement; if (this.session?.job.id) await this.control('revise', { prompt: '请使用刚重新圈选的大概位置，并检查模型上的实际效果。', target: { placement } }); } this.adapter.toast('已记录大概位置，Agent 会结合模型预览二次调整。'); await this.poll(); } catch (e) { this.adapter.fail(e); }
    };
    addEventListener('keydown', e => { if (e.key === 'Escape' && !overlay.hidden) { overlay.hidden = true; selection = null; this.adapter.endRegion(); } });
  }
  drawRegion(x, y, w, h) { Object.assign($('agentRegionBox').style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' }); }
  async mark(assetId) { if (this.session?.job.status === 'running') await this.control('pause'); if (this.executing) throw Error('正在完成当前画布操作，请稍后圈选。'); if (!this.adapter.beginRegion()) return; this.targetAsset = assetId; $('agentRegionOverlay').hidden = false; $('agentRegionBox').style.width = '0'; $('viewport').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  async assetURL(asset) {
    if (this.urls.has(asset.id)) return this.urls.get(asset.id);
    const response = await this.adapter.fetchAsset(asset.id); const url = URL.createObjectURL(await response.blob()); this.urls.set(asset.id, url); return url;
  }
  async exportBundle() {
    const session = await this.api(), assets = [];
    for (const asset of session.assets) {
      const blob = await (await this.adapter.fetchAsset(asset.id)).blob();
      const dataUrl = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(blob); });
      assets.push({ ...asset, dataUrl });
    }
    return { job: session.job, assets };
  }
  async importBundle(bundle) {
    const ids = new Map(); if (!bundle) return ids;
    for (const asset of bundle.assets || []) { const imported = await this.api('/assets', 'POST', { ...asset, source: 'project' }); ids.set(asset.id, imported.id); }
    if (bundle.job?.brief) { $('agentBrief').value = bundle.job.brief; $('agentStages').value = bundle.job.stages.map(s => s.title).join('\n'); $('agentPauseStages').checked = bundle.job.pauseAfterStage; $('agentResearch').checked = bundle.job.allowResearch; }
    this.assetsSignature = ''; return ids;
  }
  async upload(files) {
    if (this.uploading) return; this.uploading = true;
    try { for (let i = 0; i < files.length; i++) { const f = files[i]; if (f.size > 32 * 1024 * 1024) { this.adapter.toast(f.name + ' 超过 32 MB，已跳过'); continue; } const dataUrl = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(f); }); await this.api('/assets', 'POST', { name: f.name, dataUrl, role: 'reference', source: 'upload' }); $('agentAssetCount').textContent = `上传 ${i + 1}/${files.length}`; } await this.poll(); } catch (e) { this.adapter.fail(e); } finally { this.uploading = false; $('agentFileInput').value = ''; }
  }
  async submit() {
    await this.syncContext(true);
    this.session = await this.api('/job', 'POST', { brief: $('agentBrief').value, stages: $('agentStages').value.split('\n').map(s => s.trim().replace(/^\d+[.、)）]\s*/, '')).filter(Boolean), pauseAfterStage: $('agentPauseStages').checked, allowResearch: $('agentResearch').checked, references: this.session?.assets.filter(a => a.source === 'upload').map(a => a.id) || [], placement: this.placement });
    this.render(); this.adapter.toast('任务已提交。点击“复制给当前对话”，让当前 Agent 读取后开始创作。');
  }
  async control(action, extra = {}) { this.session = await this.api('/control', 'POST', { action, ...extra }); this.render(); }
  instructions() { return `请读取 ${this.session?.integration?.skillPath || 'skills/wt-skin-agent/SKILL.md'}，使用 node "${this.session?.integration?.cliPath || 'agent.cjs'}" status 读取 Skin Studio 当前任务。任务 ${this.session?.job.id || '尚未提交'}，revision ${this.session?.job.revision ?? 0}。按用户分段工作；每次生成与落图前重新检查暂停和修改状态。图片生成、背景、主体、装饰、文字必须分成可编辑图层。不要启动或调用另一个 Codex。`; }
  async copyTask() { const text = this.instructions(); try { await navigator.clipboard.writeText(text); this.adapter.toast('已复制。粘贴到当前对话，Agent 即可读取任务。'); } catch { $('agentFeedback').value = text; this.adapter.toast('请复制修改框中的任务说明到当前对话。'); } }
  async syncContext(force = false) {
    const context = this.adapter.context(), key = JSON.stringify(context); if (!force && key === this.lastContext) return;
    await this.api('/context', 'POST', { context, preview: this.adapter.preview() }); this.lastContext = key;
  }
  async poll() {
    if (this.polling || this.adapter.busy() || !$('agentRegionOverlay').hidden) return; this.polling = true;
    try {
      await this.syncContext(); this.session = await this.api(); this.render();
      const info = await this.api('/commands'); this.session.job = info.job;
      if (!this.executing && info.commands.length) { this.executing = true; try { for (const c of info.commands) await this.execute(c); } finally { this.executing = false; } }
    } finally { this.polling = false; }
  }
  async execute(command) {
    try {
      const current = await this.api(); if (current.job.status !== 'running' || current.job.revision !== command.revision) return;
      const result = await this.adapter.apply(command.operation, async () => { const latest = await this.api(); return latest.job.status === 'running' && latest.job.revision === command.revision; });
      await this.api('/commands/' + command.id, 'POST', { success: true, ...result, context: this.adapter.context(), preview: this.adapter.preview() }); this.lastContext = JSON.stringify(this.adapter.context());
    } catch (error) { try { await this.api('/commands/' + command.id, 'POST', { success: false, message: error.message }); } catch {} this.adapter.fail(error); }
  }
  render() {
    if (!this.session) return; const { job, assets, events } = this.session;
    if (job.id && this.formJobId !== job.id) { this.formJobId = job.id; $('agentBrief').value = job.brief; $('agentStages').value = job.stages.map(s => s.title).join('\n'); $('agentPauseStages').checked = job.pauseAfterStage; $('agentResearch').checked = job.allowResearch; }
    const label = phases[job.status] || job.status; $('agentStatus').textContent = label; $('agentStatus').dataset.phase = job.status;
    $('agentStickyStatus').textContent = `${label}${job.stage >= 0 ? ' · ' + (job.stages[job.stage]?.title || '') : ''}${job.worker ? ' · ' + job.worker : ''}`;
    $('agentPause').disabled = !['running', 'queued'].includes(job.status); $('agentQuickPause').disabled = $('agentPause').disabled; $('agentResume').disabled = !['paused', 'completed'].includes(job.status);
    $('agentStageList').replaceChildren(...job.stages.map((stage, index) => { const button = document.createElement('button'); button.className = 'agent-stage ' + stage.status; button.textContent = `${index + 1}. ${stage.title} ${stage.status === 'completed' ? '✓' : stage.status === 'running' ? '…' : ''}`; button.onclick = () => { $('agentFeedback').value = `调整第 ${index + 1} 段「${stage.title}」：`; $('agentFeedback').focus(); }; return button; }));
    const signature = events.map(e => e.id).join(',');
    if (signature !== this.eventsSignature) { const activity = $('agentActivity'); const atBottom = activity.scrollHeight - activity.scrollTop - activity.clientHeight < 50; activity.replaceChildren(...events.slice(-150).map(e => { const row = document.createElement('div'); row.className = 'agent-event ' + e.kind; const time = document.createElement('time'); time.textContent = new Date(e.time).toLocaleTimeString('zh-CN', { hour12: false }); const content = document.createElement('span'); content.textContent = e.message; row.append(time, content); for (const link of e.links || []) { const a = document.createElement('a'); a.href = link.url; a.textContent = link.title || link.url; a.target = '_blank'; a.rel = 'noreferrer'; row.append(a); } return row; })); if (atBottom) activity.scrollTop = activity.scrollHeight; this.eventsSignature = signature; }
    const aSignature = JSON.stringify(assets); if (aSignature !== this.assetsSignature && !this.uploading && !document.activeElement?.closest('#agentReferences')) { this.assetsSignature = aSignature; this.renderAssets(assets).catch(this.adapter.fail); }
    $('agentAssetCount').textContent = assets.length + ' 张';
    this.layerSelected(this.adapter.selected());
  }
  async renderAssets(assets) {
    const cards = [];
    for (const asset of assets) {
      const card = document.createElement('article'); card.className = 'agent-asset'; const image = document.createElement('img'); image.src = await this.assetURL(asset); image.alt = asset.name;
      const title = document.createElement('b'); title.textContent = asset.name;
      const select = document.createElement('select'); select.ariaLabel = asset.name + ' 用途'; for (const [value, name] of Object.entries(roleNames)) select.add(new Option(name, value)); if (!roleNames[asset.role]) select.add(new Option(asset.role === 'generated' ? 'Agent 生成' : asset.role, asset.role)); select.value = asset.role;
      select.onchange = () => this.api('/assets/' + asset.id, 'PATCH', { role: select.value }).then(() => this.poll()).catch(this.adapter.fail);
      const notes = document.createElement('input'); notes.placeholder = '这张图的要求 / 大概位置'; notes.value = asset.notes || ''; notes.ariaLabel = asset.name + ' 说明'; notes.onchange = () => this.api('/assets/' + asset.id, 'PATCH', { notes: notes.value }).then(() => this.poll()).catch(this.adapter.fail);
      const mark = document.createElement('button'); mark.textContent = asset.placement ? '重新标位置 ✓' : '在模型上标位置'; mark.onclick = () => this.mark(asset.id).catch(this.adapter.fail);
      card.append(image, title, select, notes, mark); cards.push(card);
    }
    if (document.activeElement?.closest('#agentReferences')) { this.assetsSignature = ''; return; }
    $('agentReferences').replaceChildren(...cards);
  }
  layerSelected(layer) {
    const tools = $('agentLayerTools'); if (!tools) return; tools.hidden = !layer;
    if (!layer) return; const metadata = layer.agent || {};
    $('agentLayerDescription').textContent = metadata.block ? `独立分块：${metadata.block} · ${metadata.prompt || '尚无提示词'}` : '此图层可单独交给 Agent 修改；其他图层保持独立。';
    $('agentLayerLock').checked = !!metadata.locked;
    const key = layer.id + ':' + (metadata.versions?.length || 0); if ($('agentVersions').dataset.key !== key) { $('agentVersions').dataset.key = key; $('agentVersions').replaceChildren(...(metadata.versions || []).map((v, i) => new Option(`版本 ${i + 1} · ${(v.prompt || '原图').slice(0, 25)}`, v.assetId))); }
  }
  async reviseLayer() {
    const layer = this.adapter.selected(); if (!layer) throw Error('请先选择图层'); if (layer.agent?.locked) throw Error('此图层已锁定，请先取消锁定');
    const source = this.adapter.selectedSource(); let sourceAsset = layer.agent?.assetId;
    if (!sourceAsset && source) { const asset = await this.api('/assets', 'POST', { name: layer.name + ' · 修改源图', role: 'edit-target', source: 'editor', dataUrl: source }); sourceAsset = asset.id; }
    await this.syncContext(true); await this.control('revise', { prompt: $('agentLayerPrompt').value, target: { layerId: layer.id, partId: this.adapter.context().selectedPart, block: layer.agent?.block || layer.kind, assetId: sourceAsset, projectionId: layer.projectionId || null } }); $('agentLayerPrompt').value = ''; this.adapter.toast('已提交仅修改此图层的要求。Agent 需读取最新任务后处理。');
  }
  async restoreVersion() { const layer = this.adapter.selected(), assetId = $('agentVersions').value; if (!layer || !assetId) return; if (layer.agent?.locked) throw Error('请先取消图层锁定'); const result = await this.adapter.apply({ type: 'image', assetId, targetLayerId: layer.id, block: layer.agent.block, prompt: '恢复历史版本', name: layer.name }, async () => true, true); await this.syncContext(true); this.adapter.toast(result.message); }
}
