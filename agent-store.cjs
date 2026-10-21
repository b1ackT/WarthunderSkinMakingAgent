const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

class AgentStore {
  constructor(root) {
    this.projectRoot = root;
    this.root = path.join(root, '.studio-agent'); this.assetsDir = path.join(this.root, 'assets');
    this.context = null; this.lastCanvas = 0; this.commands = []; this.events = []; this.assets = [];
    this.job = { id: null, status: 'idle', revision: 0, brief: '', stages: [], references: [], stage: -1, pauseAfterStage: true, allowResearch: true, researchFocus: '', distanceLivery: false, feedback: [], worker: null };
    this.sequence = 0; this.queue = Promise.resolve(); this.ready = this.load();
  }
  async load() {
    await fs.mkdir(this.assetsDir, { recursive: true });
    try {
      const saved = JSON.parse(await fs.readFile(path.join(this.root, 'session.json'), 'utf8'));
      this.assets = saved.assets || []; this.job = { ...this.job, ...saved.job }; this.events = saved.events || []; this.commands = saved.commands || []; this.sequence = saved.sequence || 0;
      for (const c of this.commands) if (['queued', 'applying'].includes(c.status)) c.status = 'cancelled';
      if (['running', 'queued'].includes(this.job.status)) { this.job.status = 'paused'; this.job.revision++; }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  view() {
    return { job: this.job, assets: this.assets, events: this.events, commands: this.commands.map(({ result, ...c }) => ({ ...c, result: result ? { ...result, preview: undefined } : null })), context: this.context, canvasOnline: Date.now() - this.lastCanvas < 15000,
      integration: { projectRoot: this.projectRoot, cliPath: path.join(this.projectRoot, 'agent.cjs'), skillPath: path.join(this.projectRoot, 'skills', 'wt-skin-agent', 'SKILL.md'), previewPath: path.join(this.root, 'preview.png'), contextPath: path.join(this.root, 'context.json'), assetsPath: this.assetsDir } };
  }
  async persist() {
    const data = JSON.stringify({ job: this.job, assets: this.assets, events: this.events, commands: this.commands, sequence: this.sequence }, null, 2);
    this.queue = this.queue.catch(() => {}).then(async () => { const temp = path.join(this.root, 'session.next.json'); await fs.writeFile(temp, data); await fs.rename(temp, path.join(this.root, 'session.json')); });
    await this.queue;
  }
  event(kind, message, extra = {}) {
    const e = { id: ++this.sequence, kind, message: String(message).slice(0, 16000), time: new Date().toISOString(), ...extra };
    this.events.push(e); if (this.events.length > 800) this.events.shift(); return e;
  }
  cancelPending(reason) { for (const c of this.commands) if (['queued', 'applying'].includes(c.status)) { c.status = 'cancelled'; c.error = reason; } }
  async updateContext(context, preview) {
    const changed = this.context && this.context.editorRevision !== context.editorRevision;
    const distanceChanged = !!this.job.id && typeof context.mipmap?.enabled === 'boolean' && this.job.distanceLivery !== context.mipmap.enabled;
    if (distanceChanged) this.job.distanceLivery = context.mipmap.enabled;
    this.context = context; this.lastCanvas = Date.now();
    if (preview) await fs.writeFile(path.join(this.root, 'preview.png'), decodeImage(preview).bytes);
    await fs.writeFile(path.join(this.root, 'context.json'), JSON.stringify(context, null, 2));
    if (changed && this.job.status === 'running') {
      this.job.revision++; this.job.status = 'paused'; this.cancelPending('用户已修改画布'); this.event('pause', '检测到用户编辑画布，已暂停后续落图。请以最新位置继续。'); await this.persist();
    } else if (distanceChanged) await this.persist();
    return { revision: this.job.revision, status: this.job.status };
  }
  async addAsset(data) {
    const { bytes, ext } = decodeImage(data.dataUrl);
    const id = crypto.randomUUID(), filename = id + ext;
    await fs.writeFile(path.join(this.assetsDir, filename), bytes);
    const asset = { id, filename, name: String(data.name || 'image').slice(0, 200), role: data.role || 'reference', prompt: String(data.prompt || '').slice(0, 24000), placement: data.placement || null, notes: String(data.notes || '').slice(0, 4000), createdAt: new Date().toISOString(), source: data.source || 'upload' };
    this.assets.push(asset);
    if (asset.source === 'upload' && this.job.id && !['completed', 'cancelled'].includes(this.job.status)) { this.job.references.push(id); if (this.job.status === 'running') { this.job.status = 'paused'; this.job.revision++; this.cancelPending('用户加入新参考图'); this.event('pause', '用户加入了新参考图，已暂停等待重新读取。'); } }
    this.event('asset', '素材已入库：' + asset.name, { assetId: id }); await this.persist(); return asset;
  }
  async updateAsset(id, patch) {
    const asset = this.assets.find(a => a.id === id); if (!asset) throw Error('素材不存在');
    for (const key of ['role', 'notes', 'placement', 'name']) if (key in patch) asset[key] = patch[key];
    if (this.job.status === 'running') { this.job.status = 'paused'; this.job.revision++; this.cancelPending('用户修改素材要求'); this.event('pause', '素材位置或说明已修改，后续落图已暂停。'); }
    await this.persist(); return asset;
  }
  async start(data) {
    if (!this.context) throw Error('请先打开模型工作台');
    if (!String(data.brief || '').trim()) throw Error('请填写创作要求');
    this.cancelPending('新任务');
    this.job = { id: crypto.randomUUID(), status: 'queued', revision: this.job.revision + 1, brief: String(data.brief).slice(0, 40000), stages: (data.stages?.length ? data.stages : ['风格', '材质', '图像或角色']).map(title => ({ title: String(title).slice(0, 180), status: 'pending', message: '' })), references: [...new Set(data.references || this.assets.filter(a => a.source === 'upload').map(a => a.id))], pauseAfterStage: data.pauseAfterStage !== false, allowResearch: data.allowResearch !== false, researchFocus: String(data.researchFocus || '').slice(0, 4000), distanceLivery: data.distanceLivery === true, stage: -1, feedback: [], worker: null, placement: data.placement || null, createdAt: new Date().toISOString() };
    this.event('queued', '任务已提交，等待当前对话中的 Agent 读取。'); await this.persist(); return this.view();
  }
  async control(action, data = {}) {
    if (!this.job.id) throw Error('请先提交创作任务');
    if (action === 'pause') { this.job.status = 'paused'; this.job.revision++; this.cancelPending('用户暂停'); this.event('pause', '用户已暂停；旧任务的迟到结果不会自动覆盖画布。'); }
    else if (action === 'resume') { this.job.status = 'queued'; this.job.revision++; this.job.worker = null; this.event('queued', '已继续，等待 Agent 读取最新要求。'); }
    else if (action === 'revise') {
      if (!String(data.prompt || '').trim()) throw Error('请填写修改要求');
      this.job.status = 'queued'; this.job.revision++; this.cancelPending('用户修改要求'); this.job.worker = null;
      const feedback = { id: crypto.randomUUID(), prompt: String(data.prompt).slice(0, 20000), target: data.target || null, stage: data.stage ?? this.job.stage, time: new Date().toISOString() };
      this.job.feedback.push(feedback); this.event('feedback', feedback.prompt, { target: feedback.target });
    } else if (action === 'cancel') { this.job.status = 'cancelled'; this.job.revision++; this.cancelPending('用户取消'); this.event('cancelled', '创作任务已取消，现有图层保留。'); }
    else throw Error('不支持的任务操作');
    await this.persist(); return this.view();
  }
  checkRevision(revision, allowPaused = false) {
    if (Number(revision) !== this.job.revision) throw Error('任务已修改。请重新读取 status，使用最新 revision。');
    if (!allowPaused && this.job.status !== 'running') throw Error('当前任务未运行。暂停时不能继续落图；等待用户继续后重新 claim。');
  }
  async claim(data = {}) {
    if (!['queued', 'running'].includes(this.job.status)) throw Error('任务未提交或已暂停');
    if (data.jobId && data.jobId !== this.job.id) throw Error('任务已更换');
    this.job.status = 'running'; this.job.worker = String(data.worker || '当前对话中的 Agent').slice(0, 160); this.event('running', this.job.worker + ' 已读取任务。'); await this.persist(); return this.view();
  }
  async log(data) { this.checkRevision(data.revision); this.event(data.kind || 'progress', data.message || '', { links: Array.isArray(data.links) ? data.links.filter(l => /^https?:\/\//.test(l.url)).slice(0, 20) : undefined }); await this.persist(); return this.view(); }
  async stage(data) {
    this.checkRevision(data.revision); const index = Number(data.index), stage = this.job.stages[index]; if (!stage) throw Error('阶段不存在');
    if (!['running', 'completed', 'pending'].includes(data.status)) throw Error('阶段状态无效');
    stage.status = data.status; stage.message = String(data.message || ''); this.job.stage = index; this.event('stage', stage.title + ' · ' + (data.status === 'completed' ? '已完成' : '进行中'), { stage: index });
    if (data.status === 'completed' && this.job.pauseAfterStage) { this.job.status = 'paused'; this.job.revision++; this.cancelPending('阶段结束'); this.event('pause', '本段已完成，等待用户调整或继续。'); }
    await this.persist(); return this.view();
  }
  async enqueue(data) {
    this.checkRevision(data.revision); if (Date.now() - this.lastCanvas > 15000) throw Error('编辑器未在线。请打开 Skin Studio 网页后再提交画布操作。');
    if (!['image', 'fill', 'text', 'update', 'preview'].includes(data.operation?.type)) throw Error('未知画布操作');
    if (data.operation.assetId && !this.assets.some(a => a.id === data.operation.assetId)) throw Error('素材 ID 不存在，请先 asset 入库');
    const command = { id: crypto.randomUUID(), jobId: this.job.id, revision: this.job.revision, status: 'queued', operation: data.operation, createdAt: new Date().toISOString() };
    this.commands.push(command); this.event('canvas', data.operation.name || '画布操作：' + data.operation.type, { commandId: command.id }); await this.persist(); return command;
  }
  async pollCommands() { this.lastCanvas = Date.now(); return this.commands.filter(c => c.status === 'queued' && c.jobId === this.job.id && c.revision === this.job.revision && this.job.status === 'running'); }
  async acknowledge(id, data) {
    const command = this.commands.find(c => c.id === id); if (!command) throw Error('操作不存在');
    this.checkRevision(command.revision); if (command.status === 'cancelled') throw Error('操作已取消');
    command.status = data.success ? 'applied' : 'failed'; command.result = { ...data, preview: undefined }; command.completedAt = new Date().toISOString();
    if (data.preview) { const decoded = decodeImage(data.preview); await fs.writeFile(path.join(this.root, 'preview.png'), decoded.bytes); }
    if (data.context) { if (typeof data.context.mipmap?.enabled === 'boolean') this.job.distanceLivery = data.context.mipmap.enabled; this.context = data.context; await fs.writeFile(path.join(this.root, 'context.json'), JSON.stringify(this.context, null, 2)); }
    this.event(data.success ? 'applied' : 'error', data.message || (data.success ? '已同步到画布' : '画布操作失败'), { commandId: id }); await this.persist(); return command;
  }
  async complete(data) { this.checkRevision(data.revision); if (this.commands.some(c => c.status === 'queued')) throw Error('仍有未应用的画布操作'); this.job.status = 'completed'; this.event('completed', data.message || '本次创作完成，可继续逐层修改。'); await this.persist(); return this.view(); }
  async assetFile(id) {
    const asset = this.assets.find(a => a.id === id); if (!asset) throw Error('素材不存在');
    return { asset, path: path.join(this.assetsDir, asset.filename) };
  }
}
function decodeImage(dataUrl) {
  const match = /^data:image\/(png|jpeg|webp);base64,([a-zA-Z0-9+/=\r\n]+)$/.exec(String(dataUrl)); if (!match) throw Error('需要 PNG、JPG 或 WebP 图片数据');
  const bytes = Buffer.from(match[2], 'base64'); if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw Error('每张图片须小于 32 MB；素材数量不限');
  const valid = match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : match[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) throw Error('图片格式与内容不符'); return { bytes, ext: match[1] === 'jpeg' ? '.jpg' : '.' + match[1] };
}
module.exports = { AgentStore, decodeImage };
