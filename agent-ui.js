import { download } from './image-io.js';
import { AgentConnection } from './agent-connection.js?v=0.5.3';
const $ = id => document.getElementById(id);
const roleNames = { reference: '综合参考', style: '风格参考', character: '主体 / 角色', background: '背景参考', decoration: '装饰 / 标记', material: '材质参考' };
const phases = { idle: '未提交任务', queued: '等待 Agent 读取', running: 'Agent 创作中', paused: '已暂停', completed: '本次创作完成', cancelled: '已取消' };

export class AgentWorkspace {
  constructor(adapter) {
    this.promptDrafts = { brief: [], feedback: [], layer: [] }; this.promptBusy = false;
    this.adapter = adapter; this.session = null; this.urls = new Map(); this.executing = false; this.polling = false; this.uploading = false; this.targetAsset = null; this.placement = null; this.lastContext = ''; this.eventsSignature = ''; this.assetsSignature = '';
    this.mount(); this.bind(); this.syncDistance(); this.poll().catch(adapter.fail); this.timer = setInterval(() => this.poll().catch(() => {}), 1000);
    this.connection = new AgentConnection(() => this.poll().catch(() => {})); this.connection.start();
    window.addEventListener('pagehide', () => this.connection.stop());
    window.addEventListener('pageshow', () => this.connection.start());
  }
  async api(suffix = '', method = 'GET', data) { return this.adapter.api('/api/agent' + suffix, { method, ...(data ? { body: JSON.stringify(data) } : {}) }); }
  mount() {
    const panel = document.createElement('section'); panel.id = 'agentPanel'; panel.className = 'agent-panel';
    panel.innerHTML = `<div class="agent-heading"><h2>创作流程</h2><span class="agent-status" id="agentStatus">未提交任务</span><button id="toggleAgent">收起</button></div>
    <div class="workflow-mipmap"><div class="workflow-mipmap-heading"><label><input id="agentDistanceLivery" type="checkbox"> Mipmap · 远近渐变皮肤 <small>可选</small></label><span id="agentMipSummary" aria-live="polite">普通皮肤</span></div>
<div id="agentMipTools" hidden><div class="agent-actions"><button id="agentMipNear">近景</button><button id="agentMipMid">中景</button><button id="agentMipFar">远景</button><details class="workflow-mip-options"><summary>渐变与预览设置</summary><div class="workflow-mip-grid"><label>中景层级<input id="agentMipMiddle" type="number" min="1" max="10"></label><label>远景层级<input id="agentMipDistant" type="number" min="2" max="14"></label><label><input id="agentMipSmooth" type="checkbox"> 平滑渐变</label><label>预览模式<select id="agentMipMode"><option value="manual">手动对比</option><option value="auto">自动随远近 / 角度</option></select></label></div><label class="slider">过渡层级<input id="agentMipLevel" type="range" min="0" max="14" step=".1"><output>0.0</output></label></details></div><p class="hint">Agent 按共用、近景、中景、远景分层创作；可在过程中切换预览。层级不是固定米数。</p></div></div>
<div id="agentBody"><nav class="workflow-steps" aria-label="创作步骤"><button data-flow="0"><span>1</span> 描述需求</button><i>→</i><button data-flow="1"><span>2</span> 添加素材</button><i>→</i><button data-flow="2"><span>3</span> 创作与调整</button></nav>
    <section id="agentStep0" class="workflow-page"><label for="agentBrief">想做一款什么样的皮肤？</label><textarea id="agentBrief" rows="2" placeholder="说说风格、配色、人设或文字，也可以只描述一个想法。"></textarea><div class="workflow-footer"><details class="workflow-settings"><summary>分段与更多设置</summary><div class="agent-options"><div><label for="agentStages">每行一个阶段</label><textarea id="agentStages" rows="3">风格\n材质\n图像或角色</textarea></div><div><label><input id="agentPauseStages" type="checkbox" checked> 每段完成后暂停</label><label><input id="agentResearch" type="checkbox" checked> 允许检索痛车实车与设计参考</label><label for="agentResearchFocus">参考检索重点</label><input id="agentResearchFocus" placeholder="例如 AMG 痛车侧面构图、人物倾斜方向、脸部避开接缝"></div></div></details><button id="agentNext" class="primary">下一步：添加素材 →</button></div></section>
    <section id="agentStep1" class="workflow-page" hidden><div class="workflow-assets-head"><p class="hint">添加自己的图片，并圈出大概位置；也可以跳过，让 Agent 自由发挥。</p><div class="agent-actions"><button id="agentAddReferences">＋ 添加图片</button><button id="agentMarkGlobal">在模型上圈位置</button></div></div><div class="agent-library"><span id="agentAssetCount">0 张</span><div id="agentReferences" class="agent-references"></div></div><div class="workflow-footer"><button id="agentBack">← 返回需求</button><button id="agentSubmit" class="primary">确认并开始 →</button></div></section>
    <section id="agentStep2" class="workflow-page" hidden><div id="agentStageList" class="agent-stages"></div><p id="agentLatest" class="workflow-latest" aria-live="polite">准备好后开始创作。</p><div id="agentHandoff" class="workflow-handoff" hidden><span>把任务发到当前对话，Agent 读取后开始。</span><button id="agentCopy" class="primary">复制任务到对话</button></div><div id="agentReviewStart"><button id="agentStartReview" class="primary">开始创作</button></div><div id="agentAdjust" hidden><div class="workflow-adjust"><textarea id="agentFeedback" rows="1" aria-label="修改要求" placeholder="想改哪里？例如：背景改冷色，主体保持不变。"></textarea><button id="agentRevise" class="primary">提交修改</button><button id="agentPause">暂停</button><button id="agentResume">继续</button></div></div><div class="workflow-footer"><button id="agentEditInputs">← 修改需求与素材</button><details class="workflow-log"><summary>详细记录与任务操作</summary><div id="agentActivity" class="agent-activity"></div><div class="agent-actions"><button id="agentExportTask">导出任务说明</button><button id="agentCancel">结束任务</button></div></details></div></section></div>`;
    document.querySelector('.workspace-top').after(panel);
    const bar = document.createElement('div'); bar.id = 'agentSticky'; bar.className = 'agent-sticky'; bar.innerHTML = '<span id="agentStickyStatus">Agent 工作台 · 当前对话协作</span><button id="agentQuickPause">暂停</button><button id="agentQuickEdit">修改提示词</button>'; panel.after(bar);
    const tools = document.createElement('div'); tools.id = 'agentLayerTools'; tools.className = 'agent-layer-tools'; tools.innerHTML = `<label class="label">Agent · 只修改选中图层</label><p class="hint" id="agentLayerDescription">背景、主体、装饰和文字独立修改。</p><label class="hint"><input id="agentLayerLock" type="checkbox"> 锁定图层，Agent 不可修改</label><textarea id="agentLayerPrompt" rows="2" placeholder="对这一个图层提出修改要求，例如姿势、画风、细节。"></textarea><button id="agentLayerRevise" class="wide">提交此图层的修改</button><div class="row"><select id="agentVersions" aria-label="图层历史版本"></select><button id="agentRestoreVersion">恢复</button></div>`;
    $('properties').append(tools);
    for (const [slot, id] of [['brief', 'agentBrief'], ['feedback', 'agentFeedback'], ['layer', 'agentLayerPrompt']]) {
      const panel = document.createElement('div'); panel.className = 'prompt-attachments'; panel.id = 'prompt-' + slot;
      const button = document.createElement('button'); button.type = 'button'; button.textContent = '＋ 图片'; button.onclick = () => panel.querySelector('input').click();
      const hint = document.createElement('span'); hint.textContent = '可多选、拖入或粘贴图片';
      const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.accept = 'image/png,image/jpeg,image/webp'; input.hidden = true;
      input.onchange = () => { this.addPromptFiles(slot, [...input.files]).catch(this.adapter.fail); input.value = ''; };
      const list = document.createElement('div'); list.className = 'prompt-attachment-list'; list.id = 'prompt-list-' + slot;
      panel.append(button, hint, input, list); $(id).after(panel);
      const attach = files => this.addPromptFiles(slot, files).catch(this.adapter.fail);
      const paste = e => { const files = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file' && i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean); if (files.length) { e.preventDefault(); attach(files); } };
      $(id).addEventListener('paste', paste); panel.addEventListener('paste', paste);
      for (const el of [$(id), panel]) {
        el.addEventListener('dragover', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); panel.classList.add('drag-over'); } });
        el.addEventListener('dragleave', () => panel.classList.remove('drag-over'));
        el.addEventListener('drop', e => { if (e.dataTransfer?.files.length) { e.preventDefault(); e.stopPropagation(); panel.classList.remove('drag-over'); attach([...e.dataTransfer.files]); } });
      }
    }

    const file = document.createElement('input'); file.type = 'file'; file.multiple = true; file.accept = 'image/png,image/jpeg,image/webp'; file.id = 'agentFileInput'; file.hidden = true; document.body.append(file);
    const overlay = document.createElement('div'); overlay.id = 'agentRegionOverlay'; overlay.hidden = true; overlay.innerHTML = '<div id="agentRegionBox"></div><span>拖出范围标记位置 · 松开确认 · Esc 取消</span>'; $('viewport').append(overlay);
  }
  syncDistance() {
    if (!$('mipEnabled')) return;
    const enabled = $('mipEnabled').checked;
    $('agentDistanceLivery').checked = enabled; $('agentMipTools').hidden = !enabled;
    $('agentMipSummary').textContent = enabled ? `已启用 · 近景 0 → 中景 ${$('mipMid').value} → 远景 ${$('mipFar').value} · 与侧栏同步` : '普通皮肤 · 默认关闭';
    for (const [top, side] of [['agentMipMiddle', 'mipMid'], ['agentMipDistant', 'mipFar'], ['agentMipMode', 'mipMode'], ['agentMipLevel', 'mipLevel']]) $(top).value = $(side).value;
    $('agentMipSmooth').checked = $('mipSmooth').checked;
    $('agentMipLevel').disabled = $('mipLevel').disabled; $('agentMipLevel').nextElementSibling.value = $('mipLevel').value;
  }
  bind() {
    document.addEventListener('studio:mipmap', () => this.syncDistance());
    for (const [top, side, event] of [['agentDistanceLivery', 'mipEnabled', 'change'], ['agentMipMiddle', 'mipMid', 'change'], ['agentMipDistant', 'mipFar', 'change'], ['agentMipSmooth', 'mipSmooth', 'change'], ['agentMipMode', 'mipMode', 'change'], ['agentMipLevel', 'mipLevel', 'input']]) {
      $(top).addEventListener(event, () => { if ($(top).type === 'checkbox') $(side).checked = $(top).checked; else $(side).value = $(top).value; $(side).dispatchEvent(new Event(event, { bubbles: true })); });
    }
    for (const [top, side] of [['agentMipNear', 'previewnear'], ['agentMipMid', 'previewmid'], ['agentMipFar', 'previewfar']]) $(top).onclick = () => $(side).click();

    for (const button of document.querySelectorAll('[data-flow]')) button.onclick = () => this.goStep(Number(button.dataset.flow));
    $('agentNext').onclick = () => { if (!$('agentBrief').value.trim() && !this.promptDrafts.brief.length) { $('agentBrief').focus(); this.adapter.toast('先写一句你想做的皮肤。'); return; } this.goStep(1); };
    $('agentBack').onclick = () => this.goStep(0); $('agentEditInputs').onclick = () => this.goStep(0);
    $('agentStartReview').onclick = () => this.submit().catch(this.adapter.fail);
    this.goStep(0);
    $('toggleAgent').onclick = () => { $('agentBody').hidden = !$('agentBody').hidden; $('toggleAgent').textContent = $('agentBody').hidden ? '展开' : '收起'; };
    $('agentAddReferences').onclick = () => $('agentFileInput').click(); $('agentFileInput').onchange = () => this.upload([...$('agentFileInput').files]);
    $('agentSubmit').onclick = () => this.submit().catch(this.adapter.fail);
    for (const [id, action] of [['agentPause', 'pause'], ['agentQuickPause', 'pause'], ['agentResume', 'resume'], ['agentCancel', 'cancel']]) $(id).onclick = () => this.control(action).catch(this.adapter.fail);
    $('agentRevise').onclick = () => this.submitFeedback().catch(this.adapter.fail);
    $('agentCopy').onclick = () => this.copyTask().catch(this.adapter.fail);
    $('agentExportTask').onclick = () => download(JSON.stringify({ instructions: this.instructions(), ...this.session }, null, 2), 'skin-agent-task.json', 'application/json');
    $('agentQuickEdit').onclick = () => { this.goStep(this.session?.job.id ? 2 : 0); (this.session?.job.id ? $('agentFeedback') : $('agentBrief')).focus(); $('agentPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
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
  goStep(index) {
    this.flowStep = index; $('agentBody').hidden = false; $('toggleAgent').textContent = '收起';
    for (let i = 0; i < 3; i++) { $('agentStep' + i).hidden = i !== index; const button = document.querySelector(`[data-flow="${i}"]`); button.classList.toggle('active', i === index); if (i === index) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current'); }
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
    if (bundle.job?.brief) { $('agentBrief').value = bundle.job.brief; $('agentStages').value = bundle.job.stages.map(s => s.title).join('\n'); $('agentPauseStages').checked = bundle.job.pauseAfterStage; $('agentResearch').checked = bundle.job.allowResearch; $('agentResearchFocus').value = bundle.job.researchFocus || ''; this.syncDistance(); }
    this.assetsSignature = ''; return ids;
  }
  async upload(files) {
    if (this.uploading) return; this.uploading = true;
    try { for (let i = 0; i < files.length; i++) { const f = files[i]; if (f.size > 32 * 1024 * 1024) { this.adapter.toast(f.name + ' 超过 32 MB，已跳过'); continue; } const dataUrl = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(f); }); await this.api('/assets', 'POST', { name: f.name, dataUrl, role: 'reference', source: 'upload' }); $('agentAssetCount').textContent = `上传 ${i + 1}/${files.length}`; } await this.poll(); } catch (e) { this.adapter.fail(e); } finally { this.uploading = false; $('agentFileInput').value = ''; }
  }
  async addPromptFiles(slot, files) {
    if (this.promptBusy) throw Error('正在提交图片，请稍后添加');
    const accepted = files.filter(f => ['image/png', 'image/jpeg', 'image/webp'].includes(f.type) && f.size <= 32 * 1024 * 1024);
    if (accepted.length !== files.length) this.adapter.toast('仅支持 PNG/JPG/WebP，单张不超过32MB');
    if (!accepted.length) return;
    if (this.session?.job.status === 'running') await this.control('pause');
    for (const file of accepted) this.promptDrafts[slot].push({ file, url: URL.createObjectURL(file), id: null });
    this.renderPromptFiles(slot);
  }
  renderPromptFiles(slot) {
    const list = $('prompt-list-' + slot); list.replaceChildren();
    for (const item of this.promptDrafts[slot]) {
      const card = document.createElement('div'); card.className = 'prompt-attachment';
      const image = document.createElement('img'); image.src = item.url; image.alt = item.file.name;
      const name = document.createElement('span'); name.textContent = item.file.name;
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.ariaLabel = '移除 ' + item.file.name; remove.disabled = this.promptBusy;
      remove.onclick = () => { if (this.promptBusy) return; this.promptDrafts[slot] = this.promptDrafts[slot].filter(n => n !== item); URL.revokeObjectURL(item.url); this.renderPromptFiles(slot); };
      card.append(image, name, remove); list.append(card);
    }
  }
  clearPromptFiles(slot) { for (const item of this.promptDrafts[slot]) URL.revokeObjectURL(item.url); this.promptDrafts[slot] = []; this.renderPromptFiles(slot); }
  setPromptBusy(value) {
    this.promptBusy = value;
    for (const id of ['agentBrief', 'agentFeedback', 'agentLayerPrompt', 'agentSubmit', 'agentStartReview', 'agentRevise', 'agentLayerRevise']) $(id).disabled = value;
    for (const slot of Object.keys(this.promptDrafts)) this.renderPromptFiles(slot);
  }
  async flushPromptFiles(slot) {
    if (!this.promptDrafts[slot].length) return [];
    const current = await this.api(); if (current.job.status === 'running') await this.control('pause');
    for (const item of this.promptDrafts[slot]) if (!item.id) {
      const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(item.file); });
      const asset = await this.api('/assets', 'POST', { name: item.file.name, role: 'reference', source: 'prompt', dataUrl }); item.id = asset.id;
    }
    return this.promptDrafts[slot].map(i => i.id);
  }
  async submit() {
    if (this.promptBusy) return;
    if (!$('agentBrief').value.trim() && !this.promptDrafts.brief.length) { this.goStep(0); $('agentBrief').focus(); throw Error('请写创作要求或添加图片'); }
    this.setPromptBusy(true);
    try {
      const attachments = await this.flushPromptFiles('brief');
      await this.syncContext(true); this.syncDistance();
      this.session = await this.api('/job', 'POST', { brief: $('agentBrief').value.trim() || '请参考附图自由设计皮肤。', attachments, stages: $('agentStages').value.split('\n').map(s => s.trim().replace(/^\d+[.、)）]\s*/, '')).filter(Boolean), pauseAfterStage: $('agentPauseStages').checked, allowResearch: $('agentResearch').checked, researchFocus: $('agentResearchFocus').value.trim(), distanceLivery: $('agentDistanceLivery').checked, references: this.session?.assets.filter(a => a.source === 'upload').map(a => a.id) || [], placement: this.placement });
      this.clearPromptFiles('brief'); this.render(); this.goStep(2); this.adapter.toast('图文任务已准备好，复制到当前对话即可开始。');
    } finally { this.setPromptBusy(false); }
  }
  async submitFeedback() {
    if (this.promptBusy) return;
    if (!$('agentFeedback').value.trim() && !this.promptDrafts.feedback.length) throw Error('请写修改要求或添加图片');
    this.setPromptBusy(true);
    try { const attachments = await this.flushPromptFiles('feedback'); await this.control('revise', { prompt: $('agentFeedback').value.trim() || '请参考本次附图调整设计。', attachments, target: null }); $('agentFeedback').value = ''; this.clearPromptFiles('feedback'); }
    finally { this.setPromptBusy(false); }
  }
  async control(action, extra = {}) { this.session = await this.api('/control', 'POST', { action, ...extra }); this.render(); if (['revise', 'resume'].includes(action)) this.goStep(2); }
  instructions() { return `请读取 ${this.session?.integration?.skillPath || 'skills/wt-skin-agent/SKILL.md'}，使用 node "${this.session?.integration?.cliPath || 'agent.cjs'}" status 读取 Skin Studio 当前任务。任务 ${this.session?.job.id || '尚未提交'}，revision ${this.session?.job.revision ?? 0}。按用户分段工作；每次生成与落图前重新检查暂停和修改状态。图片生成、背景、主体、装饰、文字必须分成可编辑图层。允许检索时先查痛车实车与设计参考、记录来源并优化构图；可变皮肤按距离组独立分层，检查近中远与过渡。不要启动或调用另一个 Codex。`; }
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
    this.syncDistance();
    if (!this.session) return; const { job, assets, events } = this.session;
    if (job.id && this.formJobId !== job.id) { this.formJobId = job.id; $('agentBrief').value = job.brief; $('agentStages').value = job.stages.map(s => s.title).join('\n'); $('agentPauseStages').checked = job.pauseAfterStage; $('agentResearch').checked = job.allowResearch; $('agentResearchFocus').value = job.researchFocus || ''; this.syncDistance(); if (job.status !== 'cancelled') this.goStep(2); }
    const hasJob = !!job.id; $('agentAdjust').hidden = !hasJob; $('agentReviewStart').hidden = hasJob; $('agentHandoff').hidden = job.status !== 'queued';
    $('agentSticky').hidden = !hasJob;
    $('agentLatest').textContent = events.at(-1)?.message || '准备好后开始创作。';
    $('agentPause').hidden = !['running', 'queued'].includes(job.status); $('agentResume').hidden = !['paused', 'completed'].includes(job.status);
    const label = phases[job.status] || job.status; $('agentStatus').textContent = label; $('agentStatus').dataset.phase = job.status;
    $('agentStickyStatus').textContent = `${label}${job.stage >= 0 ? ' · ' + (job.stages[job.stage]?.title || '') : ''}`;
    $('agentPause').disabled = !['running', 'queued'].includes(job.status); $('agentQuickPause').disabled = $('agentPause').disabled; $('agentResume').disabled = !['paused', 'completed'].includes(job.status);
    $('agentStageList').replaceChildren(...job.stages.map((stage, index) => { const button = document.createElement('button'); button.className = 'agent-stage ' + stage.status; button.textContent = `${index + 1}. ${stage.title} ${stage.status === 'completed' ? '✓' : stage.status === 'running' ? '…' : ''}`; button.onclick = () => { this.goStep(2); $('agentFeedback').value = `调整第 ${index + 1} 段「${stage.title}」：`; $('agentFeedback').focus(); }; return button; }));
    const signature = events.map(e => e.id).join(',');
    if (signature !== this.eventsSignature) { const activity = $('agentActivity'); const atBottom = activity.scrollHeight - activity.scrollTop - activity.clientHeight < 50; activity.replaceChildren(...events.slice(-150).map(e => { const row = document.createElement('div'); row.className = 'agent-event ' + e.kind; const time = document.createElement('time'); time.textContent = new Date(e.time).toLocaleTimeString('zh-CN', { hour12: false }); const content = document.createElement('span'); content.textContent = e.message + (e.attachments?.length ? ' · 附图：' + e.attachments.map(id => assets.find(a => a.id === id)?.name || id).join('、') : ''); row.append(time, content); for (const link of e.links || []) { const a = document.createElement('a'); a.href = link.url; a.textContent = link.title || link.url; a.target = '_blank'; a.rel = 'noreferrer'; row.append(a); } return row; })); if (atBottom) activity.scrollTop = activity.scrollHeight; this.eventsSignature = signature; }
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
    if (!cards.length) { const empty = document.createElement('p'); empty.className = 'workflow-empty'; empty.textContent = '还没有素材。添加你的图片，或直接开始。'; cards.push(empty); }
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
    if (this.promptBusy) return; this.setPromptBusy(true);
    try {
    const layer = this.adapter.selected(); if (!layer) throw Error('请先选择图层'); if (layer.agent?.locked) throw Error('此图层已锁定，请先取消锁定');
    const targetPart = this.adapter.context().selectedPart; const source = this.adapter.selectedSource(); let sourceAsset = layer.agent?.assetId;
    if (!sourceAsset && source) { const asset = await this.api('/assets', 'POST', { name: layer.name + ' · 修改源图', role: 'edit-target', source: 'editor', dataUrl: source }); sourceAsset = asset.id; }
    const attachments = await this.flushPromptFiles('layer'); await this.syncContext(true); await this.control('revise', { prompt: $('agentLayerPrompt').value.trim() || '仅参考本次附图调整此图层。', attachments, target: { layerId: layer.id, partId: targetPart, block: layer.agent?.block || layer.kind, assetId: sourceAsset, projectionId: layer.projectionId || null } }); $('agentLayerPrompt').value = ''; this.clearPromptFiles('layer'); this.adapter.toast('已提交仅修改此图层的要求。Agent 需读取最新任务后处理。');
    } finally { this.setPromptBusy(false); }
  }
  async restoreVersion() { const layer = this.adapter.selected(), assetId = $('agentVersions').value; if (!layer || !assetId) return; if (layer.agent?.locked) throw Error('请先取消图层锁定'); const result = await this.adapter.apply({ type: 'image', assetId, targetLayerId: layer.id, block: layer.agent.block, prompt: '恢复历史版本', name: layer.name }, async () => true, true); await this.syncContext(true); this.adapter.toast(result.message); }
}
