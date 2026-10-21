import * as THREE from 'three';
import { OrbitControls } from './vendor/jsm/controls/OrbitControls.js';
import { OBJLoader } from './vendor/jsm/loaders/OBJLoader.js';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { canvas, copyCanvas, imageFrom, readImage, download, splitBase, toDDS } from './image-io.js?v=0.5.0';
import { buildUVGeometry, bakeProjection, captureCamera, restoreCamera, reframeRectangle } from './projection.js';
import { AgentWorkspace } from './agent-ui.js?v=0.5.1';
import { exportPolicy, skinConfig } from './skin-export.js';
import { DISTANCE_BANDS, DEFAULT_MIPMAP, normalizeMipmap, validateMipmap, mipWeights, mipDimensions, layerInBand } from './mipmap.js';

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const state = {
  parts: [], part: 0, selected: null, tool: 'move', vehicle: 'HSTV-L', builtin: true,
  modelSource: null, modelFiles: null, projections: [], history: [], redo: [],
  mipmap: { ...DEFAULT_MIPMAP }, mipPreview: 'manual', mipLevel: 0, creationDistance: 'all',
  zoom: 1, panX: 0, panY: 0, space: false, brush: 24, busy: false, links: [],
};
let renderer, scene, camera, controls, model, geometries, textureTransform, drag, uvCache;
let draft = null, draftTimer, draftRunning = false, draftRevision = 0, toastTimer, apiToken;
let agentWorkspace, agentApplying = false, editorRevision = 0;
const part = () => state.parts[state.part];
const selected = () => part()?.layers.find(l => l.id === state.selected);
const say = text => $('status').textContent = text;
function toast(text) { say(text); $('toast').textContent = text; $('toast').style.display = 'block'; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').style.display = 'none', 4500); }
function fail(error) { console.error(error); toast(error.message || String(error)); }
async function task(text, fn) {
  if (state.busy) return;
  state.busy = true; $('busyText').textContent = text; $('busy').hidden = false; say(text);
  await new Promise(r => setTimeout(r, 40));
  try { return await fn(); } catch (error) { fail(error); } finally { state.busy = false; $('busy').hidden = true; }
}
function pick(accept, callback) {
  const input = $('file'); input.value = ''; input.accept = accept;
  input.onchange = () => { if (input.files[0]) task('读取文件…', () => callback(input.files[0])); }; input.click();
}
async function fileImage(file) { return readImage(new Uint8Array(await file.arrayBuffer()), file.name); }
function getImageSrc(im) { return im.src?.startsWith('data:') ? im.src : copyCanvas(im).toDataURL(); }

// Layer images are immutable except paint layers; masks are editable raster data.
function cloneLayers(layers) { return layers.map(l => ({ ...l, agent: l.agent ? structuredClone(l.agent) : undefined, mask: copyCanvas(l.mask), image: l.kind === 'paint' && l.image ? copyCanvas(l.image) : l.image })); }
function snapshot(baseIds = []) {
  return { mipmap: { ...state.mipmap }, part: state.part, selected: state.selected, layers: state.parts.map(p => cloneLayers(p.layers)),
    bases: Object.fromEntries(state.parts.filter(p => baseIds.includes(p.id)).map(p => [p.id, { base: copyCanvas(p.base), alpha: p.alpha }])),
    projections: state.projections.map(d => ({ ...d, rect: { ...d.rect }, targets: [...d.targets], camera: structuredClone(d.camera) })) };
}
function checkpoint(baseIds = []) {
  if (!agentApplying) editorRevision++;
  state.history.push(snapshot(baseIds)); if (state.history.length > 10) state.history.shift(); state.redo = []; historyButtons();
}
function historyButtons() { $('undo').disabled = !state.history.length; $('redo').disabled = !state.redo.length; }
async function travel(from, to) {
  if (!from.length || draft) return;
  editorRevision++; const entry = from.pop(); to.push(snapshot(Object.keys(entry.bases)));
  state.parts.forEach((p, i) => { p.layers = cloneLayers(entry.layers[i]); if (entry.bases[p.id]) { p.base = copyCanvas(entry.bases[p.id].base); p.alpha = entry.bases[p.id].alpha; p.original.image = p.base; p.original.needsUpdate = true; } });
  state.mipmap = normalizeMipmap(entry.mipmap); syncMipmapUI(); state.projections = entry.projections; state.part = entry.part; state.selected = entry.selected;
  composeAll(); refresh(); historyButtons();
}
function clearHistory() { editorRevision++; state.history = []; state.redo = []; historyButtons(); }
function makePart(name, image, from, output, key = null, alpha = null, id = crypto.randomUUID()) {
  const split = splitBase(image), base = split.base, p = { id, name, key, from, output, rule: 'set_tex', param: true, base, alpha: alpha || split.alpha, layers: [], canvas: canvas(base.width, base.height) };
  for (const [name, source] of [['texture', p.canvas], ['original', p.base]]) {
    p[name] = new THREE.CanvasTexture(source); p[name].colorSpace = THREE.SRGBColorSpace;
    p[name].wrapS = p[name].wrapT = THREE.RepeatWrapping; p[name].anisotropy = 8;
  }
  return p;
}
function newLayer(name, kind = 'image', rect = { x: .25, y: .25, w: .5, h: .5 }) {
  const mask = canvas(512, 512); mask.getContext('2d').fillStyle = '#fff'; mask.getContext('2d').fillRect(0, 0, 512, 512);
  return { id: crypto.randomUUID(), name, kind, distanceBand: state.mipmap.enabled ? state.creationDistance : 'all', ...rect, image: null, mask, opacity: 1, blend: 'source-over', scale: 1, dx: 0, dy: 0, angle: 0, flip: false, visible: true, fill: false, color: '#e6edf2' };
}
function layerCanvas(p, l) {
  const w = Math.max(1, Math.round(l.w * p.canvas.width)), h = Math.max(1, Math.round(l.h * p.canvas.height));
  const patch = canvas(w, h), g = patch.getContext('2d');
  if (l.fill) { g.fillStyle = l.color; g.fillRect(0, 0, w, h); }
  if (l.image) {
    if (['projection', 'paint', 'external'].includes(l.kind)) g.drawImage(l.image, 0, 0, w, h);
    else {
      const a = l.angle * Math.PI / 180, iw = l.image.width, ih = l.image.height;
      const rw = Math.abs(iw * Math.cos(a)) + Math.abs(ih * Math.sin(a)), rh = Math.abs(iw * Math.sin(a)) + Math.abs(ih * Math.cos(a));
      const s = Math.min(w / rw, h / rh) * l.scale;
      g.translate(w / 2 + l.dx * w, h / 2 + l.dy * h); g.rotate(a); g.scale(s * (l.flip ? -1 : 1), s); g.drawImage(l.image, -iw / 2, -ih / 2); g.setTransform(1, 0, 0, 1, 0, 0);
    }
  }
  g.globalCompositeOperation = 'destination-in'; g.drawImage(l.mask, 0, 0, w, h);
  return patch;
}
function distanceSources(p, layers = p.layers) {
  // Render each layer patch once, then compose complete variants before crossfading.
  const patches = layers.filter(l => l.visible).map(l => [l, layerCanvas(p, l)]);
  return Object.fromEntries(['near', 'mid', 'far'].map(band => {
    const c = canvas(p.canvas.width, p.canvas.height), g = c.getContext('2d'); g.drawImage(p.base, 0, 0);
    for (const [l, patch] of patches) if (layerInBand(l, band)) { g.globalAlpha = l.opacity; g.globalCompositeOperation = l.blend; g.drawImage(patch, l.x * c.width, l.y * c.height); }
    return [band, c];
  }));
}
function blendDistance(sources, level, width, height) {
  const c = canvas(width, height), g = c.getContext('2d'); g.globalCompositeOperation = 'lighter';
  for (const [band, weight] of Object.entries(mipWeights(level, state.mipmap))) if (weight > 0) { g.globalAlpha = weight; g.drawImage(sources[band], 0, 0, width, height); }
  return c;
}
function distanceMipmaps(p, sources = distanceSources(p)) { return mipDimensions(p.canvas.width, p.canvas.height).map((size, level) => blendDistance(sources, level, size.width, size.height)); }
function compose(p = part(), previewLayers = null) {
  if (!p) return;
  const g = p.canvas.getContext('2d'); g.clearRect(0, 0, p.canvas.width, p.canvas.height);
  if (state.mipmap.enabled) {
    const sources = distanceSources(p, previewLayers || p.layers);
    g.drawImage(blendDistance(sources, state.mipLevel, p.canvas.width, p.canvas.height), 0, 0);
    p.texture.mipmaps = state.mipPreview === 'auto' ? distanceMipmaps(p, sources) : [];
    p.texture.generateMipmaps = state.mipPreview !== 'auto';
  } else {
    g.drawImage(p.base, 0, 0);
    for (const l of previewLayers || p.layers) if (l.visible && layerInBand(l, 'near')) { g.globalAlpha = l.opacity; g.globalCompositeOperation = l.blend; g.drawImage(layerCanvas(p, l), l.x * p.canvas.width, l.y * p.canvas.height); }
    p.texture.mipmaps = []; p.texture.generateMipmaps = true;
  }
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; p.texture.needsUpdate = true;
  if (p === part()) drawEditor();
}
function syncMipmapUI() {
  $('mipEnabled').checked = state.mipmap.enabled; $('mipMid').value = state.mipmap.midLevel; $('mipFar').value = state.mipmap.farLevel; $('mipSmooth').checked = state.mipmap.smooth;
  $('mipMode').value = state.mipPreview; $('mipLevel').value = state.mipLevel; $('mipLevel').disabled = !state.mipmap.enabled || state.mipPreview === 'auto';
  $('mipLevel').nextElementSibling.value = Number(state.mipLevel).toFixed(1); $('mipSettings').hidden = !state.mipmap.enabled;
  $('mipSummary').textContent = state.mipmap.enabled ? `近景 0 → 中景 ${state.mipmap.midLevel} → 远景 ${state.mipmap.farLevel} · ${state.mipPreview === 'auto' ? '自动采样' : '手动对比'}` : '当前使用普通皮肤导出';
  document.dispatchEvent(new Event('studio:mipmap'));
}
function setLayerDistance(l, band) {
  if (!DISTANCE_BANDS.includes(band)) throw Error('距离分组无效');
  const layers = l.projectionId ? state.parts.flatMap(p => p.layers).filter(n => n.projectionId === l.projectionId) : [l];
  layers.forEach(n => n.distanceBand = band);
  const record = state.projections.find(p => p.id === l.projectionId); if (record) record.distanceBand = band;
}
function composeAll() { state.parts.forEach(p => compose(p)); }
function addImage(image, name) {
  checkpoint(); const p = part(), width = .4, height = Math.min(.75, width * p.canvas.width / p.canvas.height * image.height / image.width);
  const l = newLayer(name, 'image', { x: .3, y: (1 - height) / 2, w: width, h: height }); l.image = image; p.layers.push(l); state.selected = l.id; setTool('move'); compose(); refreshLayers();
}
function textImage(l) {
  const c = canvas(1400, 400), g = c.getContext('2d'); g.fillStyle = l.textColor || '#e6edf2'; g.font = `bold 180px "${l.font || 'Arial'}"`; g.textBaseline = 'middle'; g.textAlign = 'center';
  g.fillText(l.text || 'SKIN STUDIO', 700, 200, 1350); return c;
}
function refresh() {
  $('part').replaceChildren(...state.parts.map((p, i) => new Option(p.name, i))); $('part').value = state.part;
  $('vehicle').textContent = state.vehicle; $('projectTitle').textContent = `${state.vehicle} / Skin Studio`;
  if (part()) { $('dimensions').textContent = `${part().canvas.width} × ${part().canvas.height}`; $('textureName').textContent = part().output; $('fromName').value = part().from; $('outputName').value = part().output; $('rule').value = part().rule; $('camoParam').checked = part().param; }
  uvCache = null; refreshLayers(); drawEditor();
}
function refreshLayers() {
  const list = $('layers'); list.replaceChildren();
  if (!part()?.layers.length) { const d = document.createElement('div'); d.className = 'empty'; d.textContent = '添加图片、文字或色块，也可以直接贴到模型上。'; list.append(d); }
  for (const l of [...(part()?.layers || [])].reverse()) {
    const row = document.createElement('div'); row.className = 'layer' + (l.id === state.selected ? ' selected' : '');
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = l.visible; check.ariaLabel = '显示 ' + l.name;
    check.onclick = e => { e.stopPropagation(); checkpoint(); l.visible = check.checked; compose(); };
    const thumb = document.createElement('img'); thumb.className = 'thumb'; if (l.image) thumb.src = thumbnail(l.image); else thumb.style.background = l.color;
    const name = document.createElement('span'); name.textContent = l.name;
    const type = document.createElement('small'); type.textContent = ({ projection: '投射', paint: '绘画', external: 'PS', text: '文字', fill: '色块', image: '图片' })[l.kind] + ' · ' + ({ all: '共用', near: '近', mid: '中', far: '远' })[l.distanceBand || 'all'];
    row.append(check, thumb, name, type); row.onclick = () => { state.selected = l.id; refreshLayers(); drawEditor(); }; list.append(row);
  }
  $('properties').hidden = !selected(); syncProperties(); agentWorkspace?.layerSelected(selected());
}
function thumbnail(im) { const c = canvas(48, 48); c.getContext('2d').drawImage(im, 0, 0, 48, 48); return c.toDataURL(); }
function syncProperties() {
  const l = selected(); if (!l) return;
  $('layerDistance').value = l.distanceBand || 'all'; $('layerName').value = l.name; $('opacity').value = l.opacity; $('opacity').nextElementSibling.value = Math.round(l.opacity * 100) + '%'; $('blend').value = l.blend;
  $('fillEnabled').checked = l.fill; $('fillColor').value = l.color; $('flip').checked = l.flip;
  $('transformProps').hidden = ['projection', 'paint', 'external'].includes(l.kind); $('textProps').hidden = l.kind !== 'text';
  $('editProjection').hidden = l.kind !== 'projection'; $('deleteProjection').hidden = l.kind !== 'projection'; $('sourceImage').hidden = l.kind === 'paint' || l.kind === 'fill';
  if (l.kind === 'text') { $('textValue').value = l.text; $('font').value = l.font; $('textColor').value = l.textColor; }
  for (const k of ['x', 'y', 'w', 'h', 'scale', 'dx', 'dy', 'angle']) { $(k).value = l[k]; $(k).nextElementSibling.value = k === 'angle' ? l[k] + '°' : Number(l[k]).toFixed(2); }
}
function setTool(tool) { state.tool = tool; for (const id of ['move', 'draw', 'paint', 'erasePaint', 'eraseMask', 'paintMask']) $(id).classList.toggle('active', tool === id); $('editor').style.cursor = tool === 'move' ? 'grab' : 'crosshair'; }
function fit() { state.zoom = 1; state.panX = state.panY = 0; drawEditor(); }
function makeUV(p, full = false) {
  const w = full ? p.canvas.width : Math.min(2048, p.canvas.width), h = full ? p.canvas.height : Math.min(2048, p.canvas.height), c = canvas(w, h), g = c.getContext('2d');
  const geom = geometries?.get(p.id); if (!geom) return c; const uv = geom.attributes.atlas;
  g.strokeStyle = full ? '#4c9df0' : '#ed75bd'; g.lineWidth = full ? .9 : .6; g.beginPath();
  for (let i = 0; i < uv.count; i += 3) { for (let j = 0; j < 3; j++) { const x = uv.getX(i + j) * w, y = (1 - uv.getY(i + j)) * h; j ? g.lineTo(x, y) : g.moveTo(x, y); } g.closePath(); }
  g.stroke(); return c;
}
function drawEditor() {
  if (!part()) return;
  const el = $('editor'), host = $('editorWrap'), dpr = devicePixelRatio || 1, w = host.clientWidth, h = host.clientHeight;
  if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) { el.width = Math.round(w * dpr); el.height = Math.round(h * dpr); }
  const g = el.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const p = part(), s = Math.min((w - 36) / p.canvas.width, (h - 36) / p.canvas.height) * state.zoom;
  const ox = (w - p.canvas.width * s) / 2 + state.panX, oy = (h - p.canvas.height * s) / 2 + state.panY; textureTransform = { s, ox, oy };
  g.drawImage($('compare').checked ? p.base : p.canvas, ox, oy, p.canvas.width * s, p.canvas.height * s);
  if ($('uv').checked) { if (!uvCache) uvCache = makeUV(p); g.globalAlpha = .6; g.drawImage(uvCache, ox, oy, p.canvas.width * s, p.canvas.height * s); g.globalAlpha = 1; }
  const l = selected(); if (l && !['projection', 'paint', 'external'].includes(l.kind)) { g.strokeStyle = '#91cbff'; g.lineWidth = 1.5; g.setLineDash([5, 4]); g.strokeRect(ox + l.x * p.canvas.width * s, oy + l.y * p.canvas.height * s, l.w * p.canvas.width * s, l.h * p.canvas.height * s); g.setLineDash([]); }
  if (drag?.type === 'draw') { g.strokeStyle = '#91cbff'; g.strokeRect(ox + drag.start.x * p.canvas.width * s, oy + drag.start.y * p.canvas.height * s, (drag.last.x - drag.start.x) * p.canvas.width * s, (drag.last.y - drag.start.y) * p.canvas.height * s); }
}
function point(e) { const r = $('editor').getBoundingClientRect(), t = textureTransform, p = part(); return { x: (e.clientX - r.left - t.ox) / (t.s * p.canvas.width), y: (e.clientY - r.top - t.oy) / (t.s * p.canvas.height) }; }
function stroke(a, b) {
  const l = selected(); if (!l) return; const isMask = state.tool.endsWith('Mask'), source = isMask ? l.mask : l.image;
  if (!source || (!isMask && l.kind !== 'paint')) return;
  const g = source.getContext('2d'), sx = source.width / (l.w * part().canvas.width * textureTransform.s), sy = source.height / (l.h * part().canvas.height * textureTransform.s);
  const cv = q => ({ x: (q.x - l.x) / l.w * source.width, y: (q.y - l.y) / l.h * source.height }); a = cv(a); b = cv(b);
  g.save(); g.scale(sx, sy); g.globalCompositeOperation = ['eraseMask', 'erasePaint'].includes(state.tool) ? 'destination-out' : 'source-over'; g.strokeStyle = isMask ? '#fff' : $('paintColor').value; g.fillStyle = g.strokeStyle; g.lineWidth = state.brush; g.lineCap = 'round';
  g.beginPath(); g.moveTo(a.x / sx, a.y / sy); g.lineTo(b.x / sx, b.y / sy); g.stroke(); g.beginPath(); g.arc(b.x / sx, b.y / sy, state.brush / 2, 0, Math.PI * 2); g.fill(); g.restore(); compose();
}
$('editor').onpointerdown = e => {
  if (!part() || draft || e.button === 2) return; $('editor').setPointerCapture(e.pointerId); const pt = point(e);
  if (state.space || e.button === 1) { drag = { type: 'pan', x: state.panX, y: state.panY, sx: e.clientX, sy: e.clientY }; return; }
  if (state.tool === 'draw') { drag = { type: 'draw', start: pt, last: pt }; return; }
  if (['paint', 'erasePaint', 'eraseMask', 'paintMask'].includes(state.tool)) { if (!selected()) return; if (['paint', 'erasePaint'].includes(state.tool) && selected().kind !== 'paint') { toast('请选择绘画图层，或点击“绘画”新建一层。'); return; } checkpoint(); drag = { type: 'stroke', last: pt }; stroke(pt, pt); return; }
  const l = [...part().layers].reverse().find(l => l.visible && l.kind !== 'projection' && pt.x >= l.x && pt.x <= l.x + l.w && pt.y >= l.y && pt.y <= l.y + l.h);
  state.selected = l?.id || null; if (l && l.kind !== 'paint') { checkpoint(); drag = { type: 'move', x: l.x, y: l.y, start: pt }; } refreshLayers(); drawEditor();
};
$('editor').onpointermove = e => {
  if (!drag) return; if (drag.type === 'pan') { state.panX = drag.x + e.clientX - drag.sx; state.panY = drag.y + e.clientY - drag.sy; drawEditor(); return; }
  const pt = point(e); if (drag.type === 'draw') { drag.last = pt; drawEditor(); } else if (drag.type === 'move') { selected().x = drag.x + pt.x - drag.start.x; selected().y = drag.y + pt.y - drag.start.y; compose(); syncProperties(); } else if (drag.type === 'stroke') { stroke(drag.last, pt); drag.last = pt; }
};
$('editor').onpointerup = () => {
  if (drag?.type === 'draw') { const a = drag.start, b = drag.last, x = clamp(Math.min(a.x, b.x), 0, 1), y = clamp(Math.min(a.y, b.y), 0, 1), w = Math.min(Math.abs(a.x - b.x), 1 - x), h = Math.min(Math.abs(a.y - b.y), 1 - y); if (w > .003 && h > .003) { checkpoint(); const l = newLayer('色块', 'fill', { x, y, w, h }); l.fill = true; l.color = $('paintColor').value; part().layers.push(l); state.selected = l.id; refreshLayers(); } }
  drag = null; compose();
};
$('editor').onpointercancel = () => { drag = null; drawEditor(); };
$('editor').onwheel = e => { e.preventDefault(); state.zoom = clamp(state.zoom * Math.exp(-e.deltaY * .001), .4, 16); drawEditor(); };
$('editorWrap').ondragover = e => e.preventDefault(); $('editorWrap').ondrop = e => { e.preventDefault(); if (e.dataTransfer.files[0]) task('导入图片…', async () => addImage(await fileImage(e.dataTransfer.files[0]), e.dataTransfer.files[0].name)); };
$('viewport').ondragover = e => e.preventDefault();
$('viewport').ondrop = e => {
  e.preventDefault(); const file = e.dataTransfer.files[0]; if (!file) return;
  const bounds = $('viewport').getBoundingClientRect(), cx = (e.clientX - bounds.left) / bounds.width, cy = (e.clientY - bounds.top) / bounds.height;
  task('将图片放到模型表面…', async () => { const image = await fileImage(file); if (!draft) beginProjection(); draft.rect.cx = cx; draft.rect.cy = cy; setDraftImage(image, file.name); });
};
addEventListener('keydown', e => { if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return; if (e.code === 'Space') { state.space = true; e.preventDefault(); } if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); travel(e.shiftKey ? state.redo : state.history, e.shiftKey ? state.history : state.redo); } });
addEventListener('keyup', e => { if (e.code === 'Space') state.space = false; });
addEventListener('blur', () => state.space = false);

function init3D() {
  const host = $('viewport'); scene = new THREE.Scene(); renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.3;
  host.prepend(renderer.domElement); camera = new THREE.PerspectiveCamera(38, 1, .05, 100); controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x62707a, 1.8)); for (const [position, intensity] of [[[4, 7, 3], 1.6], [[-5, 2, -4], .8]]) { const light = new THREE.DirectionalLight(0xffffff, intensity); light.position.set(...position); scene.add(light); }
  const grid = new THREE.GridHelper(16, 32, 0x68788a, 0x3c4c5e); grid.material.transparent = true; grid.material.opacity = .23; scene.add(grid);
  new ResizeObserver(() => { const previousAspect = camera.aspect; renderer.setSize(host.clientWidth, host.clientHeight); camera.aspect = host.clientWidth / host.clientHeight; camera.updateProjectionMatrix(); if (draft) { draft.rect = reframeRectangle(draft.rect, previousAspect, camera.aspect); draft.camera = captureCamera(camera, controls.target); draft.viewport = { width: host.clientWidth, height: host.clientHeight }; updateSticker(); scheduleDraft(); } drawEditor(); }).observe(host);
  renderer.setAnimationLoop(() => { if (!draft) controls.update(); renderer.render(scene, camera); });
  renderer.domElement.ondblclick = e => {
    if (draft) return; const r = renderer.domElement.getBoundingClientRect(), ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), camera);
    const hits = ray.intersectObject(model, true); const hit = hits.find(h => { const mats = Array.isArray(h.object.material) ? h.object.material : [h.object.material]; return mats[h.face.materialIndex || 0]?.userData.part; });
    if (hit) { const mats = Array.isArray(hit.object.material) ? hit.object.material : [hit.object.material], p = mats[hit.face.materialIndex || 0].userData.part; state.part = state.parts.indexOf(p); state.selected = null; refresh(); fit(); toast('已选择模型材质：' + p.name); }
  };
}
function resetCamera(side = null) { if (draft) return; camera.position.set(...(side === 'left' ? [8.8, 1.7, 0] : side === 'right' ? [-8.8, 1.7, 0] : [7, 4.3, 7])); controls.target.set(0, 1.05, 0); controls.update(); }
function parseMTL(text) { const defs = {}; let def; for (const line of text.split(/\r?\n/)) { const [cmd, ...args] = line.trim().split(/\s+/); if (cmd === 'newmtl') { def = { name: args.join(' ') }; defs[def.name] = def; } else if (def && cmd === 'map_Kd') def.texture = args.join(' '); else if (def && cmd === 'd') def.opacity = Number(args[0]); } return defs; }
function disposeModel() {
  if (geometries) for (const g of geometries.values()) g.dispose();
  if (model) { scene.remove(model); const mats = new Set(); model.traverse(o => { if (o.isMesh) { o.geometry.dispose(); for (const m of Array.isArray(o.material) ? o.material : [o.material]) mats.add(m); } }); mats.forEach(m => m.dispose()); }
}
async function loadModel(objText, mtlText, resolve) {
  const materials = {};
  for (const d of Object.values(parseMTL(mtlText))) {
    const result = d.texture ? await resolve(d.texture) : null, m = new THREE.MeshStandardMaterial({ color: result ? 0xffffff : 0x606e76, side: THREE.DoubleSide, metalness: .12, roughness: .8 });
    if (result?.part) { m.map = result.part.texture; m.userData.part = result.part; }
    else if (result?.image) { m.map = new THREE.CanvasTexture(result.image); m.map.colorSpace = THREE.SRGBColorSpace; m.map.wrapS = m.map.wrapT = THREE.RepeatWrapping; }
    if (d.opacity !== undefined && d.opacity < 1) { m.transparent = true; m.opacity = d.opacity; m.depthWrite = false; } materials[d.name] = m;
  }
  const next = new OBJLoader().parse(objText); next.traverse(o => { if (o.isMesh) { const assign = m => materials[m.name] || new THREE.MeshStandardMaterial({ color: 0x61717c, side: THREE.DoubleSide }); o.material = Array.isArray(o.material) ? o.material.map(assign) : assign(o.material); } });
  const box = new THREE.Box3().setFromObject(next), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3()), scale = 6 / Math.max(size.x, size.y, size.z);
  next.scale.setScalar(scale); next.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
  disposeModel(); model = next; scene.add(model); state.modelSource = { objText, mtlText }; geometries = buildUVGeometry(model, state.parts); resetCamera(); uvCache = null;
}
async function loadBuiltin() {
  const parts = [];
  for (const [key, name] of [['body', '车体'], ['turret', '炮塔'], ['gun', '主炮'], ['mg', '机枪']]) {
    const stem = `hstv_l_${key}_c`, image = await imageFrom(`assets/model/textures/${stem}_us_camo_modern_green.jpg`);
    const p = makePart(name, image, stem, stem, key); p.materialPath = `${stem}_us_camo_modern_green.jpg`; parts.push(p);
  }
  state.parts = parts; state.part = 0; state.selected = null; state.builtin = true; state.vehicle = 'HSTV-L'; state.modelFiles = null; state.projections = [];
  const [obj, mtl] = await Promise.all(['HSTV-L.obj', 'HSTV-L.mtl'].map(f => fetch('assets/model/' + f).then(r => r.text())));
  await loadModel(obj, mtl, async name => { const p = parts.find(p => name.endsWith(p.materialPath)); return p ? { part: p } : { image: await imageFrom('assets/model/' + name) }; }); composeAll(); refresh(); fit(); clearHistory(); say('已就绪 · 4 张颜色贴图 · 原车底图');
}
async function importModel(file) {
  cancelProjection(); await disconnectAll();
  const files = unzipSync(new Uint8Array(await file.arrayBuffer())), keys = Object.keys(files), objs = keys.filter(k => /\.obj$/i.test(k)), mtls = keys.filter(k => /\.mtl$/i.test(k));
  if (objs.length !== 1 || !mtls.length) throw Error('ZIP 需要包含一个 OBJ、配套 MTL 和颜色贴图。');
  const objText = strFromU8(files[objs[0]]), mtlText = strFromU8(files[mtls[0]]), parts = [], lookup = {};
  for (const d of Object.values(parseMTL(mtlText))) if (d.texture && !lookup[d.texture]) {
    const basename = d.texture.replaceAll('\\', '/').split('/').pop(), key = keys.find(k => k.toLowerCase().endsWith('/' + basename.toLowerCase()) || k.toLowerCase() === basename.toLowerCase());
    if (!key) throw Error('模型包缺少贴图：' + d.texture);
    const image = await readImage(files[key], key), stem = basename.replace(/\.[^.]+$/, '').replace(/_us_camo.*$/, '');
    const p = makePart(stem, image, stem, stem); p.materialPath = d.texture; parts.push(p); lookup[d.texture] = { part: p };
  }
  if (!parts.length) throw Error('MTL 没有 map_Kd 颜色贴图。');
  state.parts = parts; state.part = 0; state.selected = null; state.vehicle = file.name.replace(/\.zip$/i, ''); state.builtin = false; state.modelFiles = files; state.projections = [];
  await loadModel(objText, mtlText, name => lookup[name]); composeAll(); clearHistory(); refresh(); fit(); toast('模型已导入。游戏导出前请核对各材质的 from 名称。');
}

// A projection is one source and one projector, with rasterized layers in each UV map.
function beginProjection(record = null) {
  if (!model || draft) return; controls.update();
  const host = $('viewport');
  if (record) { const saved = restoreCamera(record.camera); camera.copy(saved); camera.aspect = host.clientWidth / host.clientHeight; camera.updateProjectionMatrix(); controls.target.fromArray(record.camera.target); }
  draft = record ? { ...record, rect: { ...record.rect }, targets: [...record.targets], image: record.image, existing: true } : { id: crypto.randomUUID(), name: '模型投射', image: null, rect: { cx: .5, cy: .5, w: .45, h: .45, angle: 0 }, targets: state.parts.map(p => p.id), occlusion: true, mirror: false, distanceBand: state.mipmap.enabled ? state.creationDistance : 'all', existing: false };
  if (record) draft.rect = reframeRectangle(record.rect, record.camera.aspect, camera.aspect);
  draft.camera = captureCamera(camera, controls.target); draft.viewport = { width: host.clientWidth, height: host.clientHeight }; draft.result = null;
  controls.enabled = false; $('projectionOverlay').hidden = false; $('projectionPanel').hidden = false; $('projectionOcclusion').checked = draft.occlusion; $('projectionMirror').checked = draft.mirror; $('projectionAngle').value = draft.rect.angle; $('projectionSize').value = draft.rect.w;
  $('projectionTargets').replaceChildren(...state.parts.map(p => { const label = document.createElement('label'), check = document.createElement('input'); check.type = 'checkbox'; check.checked = draft.targets.includes(p.id); check.onchange = () => { draft.targets = [...$('projectionTargets').querySelectorAll('input:checked')].map(el => el.value); scheduleDraft(); }; check.value = p.id; label.append(check, p.name); return label; }));
  $('viewHint').textContent = '投射视角已锁定 · 拖动图片定位 · 确认后可继续旋转模型'; updateSticker(); if (draft.image) scheduleDraft();
}
function updateSticker() {
  if (!draft) return; const r = draft.rect, box = $('sticker'); box.style.left = (r.cx - r.w / 2) * 100 + '%'; box.style.top = (r.cy - r.h / 2) * 100 + '%'; box.style.width = r.w * 100 + '%'; box.style.height = r.h * 100 + '%'; box.style.transform = `rotate(${r.angle}deg)`;
  if (!draft.cachedSrc && draft.image) draft.cachedSrc = getImageSrc(draft.image); $('stickerImage').src = draft.cachedSrc || ''; $('stickerImage').style.transform = draft.mirror ? 'scaleX(-1)' : ''; $('stickerImage').style.opacity = $('projectionReference').checked ? '.75' : '0'; $('sticker').style.visibility = draft.image ? 'visible' : 'hidden';
  $('projectionSize').nextElementSibling.value = Math.round(r.w * 100) + '%'; $('projectionAngle').nextElementSibling.value = r.angle + '°';
}
function setDraftImage(image, name = '模型投射') {
  if (!draft) beginProjection(); draft.image = image; draft.cachedSrc = getImageSrc(image); draft.name = name; draft.rect.h = draft.rect.w * draft.viewport.width / draft.viewport.height * image.height / image.width; updateSticker(); scheduleDraft();
}
function scheduleDraft() { if (!draft) return; draft.result = null; draftRevision++; clearTimeout(draftTimer); if ($('projectionLive').checked && draft.image) draftTimer = setTimeout(() => previewDraft().catch(fail), 220); }
async function calculateDraft() {
  if (!draft?.image) throw Error('请先选择投射图片。');
  return bakeProjection({ renderer, model, geometries, parts: state.parts.filter(p => draft.targets.includes(p.id)), camera: restoreCamera(draft.camera), image: draft.image, rect: draft.rect, viewport: draft.viewport, occlusion: draft.occlusion, mirror: draft.mirror });
}
function projectionLayer(d, p, image) { const l = newLayer(d.name, 'projection', { x: 0, y: 0, w: 1, h: 1 }); l.image = image; l.projectionId = d.id; return l; }
function showDraftResult(result) {
  if (!draft) return;
  for (const p of state.parts) { const layers = p.layers.filter(l => l.projectionId !== draft.id); if (result.has(p.id)) { const old = p.layers.find(l => l.projectionId === draft.id); layers.push(old ? { ...old, image: result.get(p.id).canvas } : projectionLayer(draft, p, result.get(p.id).canvas)); } compose(p, layers); }
  const names = state.parts.filter(p => result.has(p.id)).map(p => p.name); $('projectionInfo').textContent = names.length ? '覆盖材质：' + names.join(' / ') + '。确认后将保留为关联图层。' : '当前范围没有覆盖所选表面。请移动图片，或取消后调整视角。';
}
async function previewDraft() {
  if (!draft?.image || draftRunning) return; draftRunning = true; const revision = draftRevision;
  try { const result = await calculateDraft(); if (draft && revision === draftRevision) { draft.result = result; showDraftResult(result); } } finally { draftRunning = false; }
}
function commitResult(record, result) {
  for (const p of state.parts) {
    const old = p.layers.find(l => l.projectionId === record.id), data = result.get(p.id);
    if (data) { if (old) old.image = data.canvas; else { const layer = projectionLayer(record, p, data.canvas); layer.distanceBand = record.distanceBand || 'all'; p.layers.push(layer); } }
    else p.layers = p.layers.filter(l => l.projectionId !== record.id);
  }
}
async function applyProjection() {
  if (!draft?.image) throw Error('请先选择自己的图片。'); clearTimeout(draftTimer);
  const result = draft.result || await calculateDraft(); if (!result.size) throw Error('投射没有覆盖任何选中材质，请调整图片位置与视角。');
  checkpoint(); const record = { id: draft.id, name: draft.name, image: draft.image, camera: draft.camera, rect: { ...draft.rect }, viewport: { ...draft.viewport }, targets: [...draft.targets], occlusion: draft.occlusion, mirror: draft.mirror, distanceBand: draft.distanceBand || 'all' };
  state.projections = state.projections.filter(d => d.id !== record.id); state.projections.push(record); commitResult(record, result);
  const target = state.parts.find(p => result.has(p.id)); state.part = state.parts.indexOf(target); state.selected = target.layers.find(l => l.projectionId === record.id).id;
  const names = state.parts.filter(p => result.has(p.id)).map(p => p.name); endProjection(); refresh(); fit(); toast('已投射到 ' + names.join(' / ') + '，可继续编辑图层或整组投射。');
}
function endProjection() { clearTimeout(draftTimer); draftRevision++; draft = null; controls.enabled = true; $('projectionOverlay').hidden = true; $('projectionPanel').hidden = true; $('viewHint').textContent = '拖动旋转 · 滚轮缩放 · 右键平移 · 双击选择材质'; composeAll(); }
function cancelProjection() { if (draft) endProjection(); }
let stickerDrag;
$('projectionOverlay').onpointerdown = e => {
  if (!draft?.image || e.button !== 0) return; e.preventDefault(); $('projectionOverlay').setPointerCapture(e.pointerId);
  stickerDrag = { x: e.clientX, y: e.clientY, rect: { ...draft.rect }, resize: e.target === $('stickerHandle') };
};
$('projectionOverlay').onpointermove = e => {
  if (!stickerDrag || !draft) return; const r = stickerDrag.rect, w = $('viewport').clientWidth, h = $('viewport').clientHeight, dx = (e.clientX - stickerDrag.x) / w, dy = (e.clientY - stickerDrag.y) / h;
  if (stickerDrag.resize) { const factor = Math.max(.1, 1 + (dx + dy) / Math.max(.02, r.w + r.h) * 2); draft.rect.w = r.w * factor; draft.rect.h = r.h * factor; } else { draft.rect.cx = r.cx + dx; draft.rect.cy = r.cy + dy; }
  $('projectionSize').value = draft.rect.w; updateSticker(); scheduleDraft();
};
$('projectionOverlay').onpointerup = () => { stickerDrag = null; scheduleDraft(); };
$('projectionOverlay').onpointercancel = () => stickerDrag = null;

// Project files include editable layers and the source projector, not only a flatten.
function serializeLayer(l) { return { ...l, image: undefined, mask: undefined, imageSrc: l.image ? getImageSrc(l.image) : null, maskSrc: l.mask.toDataURL() }; }
async function hydrateLayer(data) { const l = { ...data }; l.image = data.imageSrc ? await imageFrom(data.imageSrc) : null; if (l.kind === 'paint' && l.image) l.image = copyCanvas(l.image); l.mask = copyCanvas(await imageFrom(data.maskSrc)); delete l.imageSrc; delete l.maskSrc; return l; }
async function saveProject() {
  if (draft) throw Error('请先确认或取消当前投射，再保存工程。');
  const data = { version: 2, mipmap: state.mipmap, vehicle: state.vehicle, builtin: state.builtin, part: state.part, selected: state.selected, view: captureCamera(camera, controls.target), model: state.modelSource,
    parts: state.parts.map(p => ({ id: p.id, key: p.key, name: p.name, from: p.from, output: p.output, rule: p.rule, param: p.param, materialPath: p.materialPath, base: p.base.toDataURL(), alpha: p.alpha ? copyCanvas(p.alpha).toDataURL() : null, layers: p.layers.map(serializeLayer) })),
    projections: state.projections.map(d => ({ ...d, image: undefined, imageSrc: getImageSrc(d.image) })) };
  if (agentWorkspace) data.agent = await agentWorkspace.exportBundle();
  const files = { 'studio.json': strToU8(JSON.stringify(data)) }; if (state.modelFiles) for (const [name, bytes] of Object.entries(state.modelFiles)) files['model/' + name] = bytes;
  download(zipSync(files, { level: 1 }), state.vehicle + '.studio.zip', 'application/zip'); toast('工程已保存，包含图层、蒙版和可重新投射的源图片。');
}
async function openProject(file) {
  const files = unzipSync(new Uint8Array(await file.arrayBuffer())); if (!files['studio.json']) throw Error('请选择新版 .studio.zip 工程；旧编辑器的工程请在旧版本打开。');
  return restoreProject(JSON.parse(strFromU8(files['studio.json'])), files);
}
async function restoreProject(data, files = {}) {
  if (data.version !== 2 || !data.parts?.length) throw Error('工程格式无效。');
  const assetIds = await agentWorkspace?.importBundle(data.agent);
  if (assetIds?.size) for (const p of data.parts) for (const l of p.layers) if (l.agent) { l.agent.assetId = assetIds.get(l.agent.assetId) || l.agent.assetId; for (const v of l.agent.versions || []) v.assetId = assetIds.get(v.assetId) || v.assetId; }
  const parts = []; for (const info of data.parts) { const p = makePart(info.name, await imageFrom(info.base), info.from, info.output, info.key, info.alpha ? await imageFrom(info.alpha) : null, info.id); p.rule = info.rule; p.param = info.param; p.materialPath = info.materialPath; p.layers = await Promise.all(info.layers.map(hydrateLayer)); parts.push(p); }
  const oldParts = state.parts, reuseModel = data.builtin && state.builtin && data.model.objText === state.modelSource.objText;
  cancelProjection(); await disconnectAll(); state.mipmap = normalizeMipmap(data.mipmap); state.mipLevel = 0; state.mipPreview = 'manual'; syncMipmapUI(); state.parts = parts; state.part = clamp(data.part || 0, 0, parts.length - 1); state.selected = data.selected; state.vehicle = data.vehicle; state.builtin = data.builtin;
  state.projections = await Promise.all((data.projections || []).map(async d => ({ ...d, image: await imageFrom(d.imageSrc) })));
  state.modelFiles = data.builtin ? null : Object.fromEntries(Object.entries(files).filter(([k]) => k.startsWith('model/')).map(([k, v]) => [k.slice(6), v]));
  if (reuseModel) {
    model.traverse(o => { if (!o.isMesh) return; for (const m of Array.isArray(o.material) ? o.material : [o.material]) { const old = m.userData.part; if (!old) continue; const next = parts.find(p => p.key === old.key); if (next) { m.userData.part = next; m.map = next.texture; m.needsUpdate = true; } } });
    geometries = new Map(parts.map(p => [p.id, geometries.get(oldParts.find(old => old.key === p.key)?.id)]));
    for (const p of oldParts) { p.texture.dispose(); p.original.dispose(); } uvCache = null;
  } else await loadModel(data.model.objText, data.model.mtlText, async name => { const p = parts.find(p => p.materialPath === name || name.endsWith(p.materialPath)); return p ? { part: p } : data.builtin ? { image: await imageFrom('assets/model/' + name) } : null; });
  if (data.view) { camera.copy(restoreCamera(data.view)); camera.aspect = $('viewport').clientWidth / $('viewport').clientHeight; camera.updateProjectionMatrix(); controls.target.fromArray(data.view.target); controls.update(); } composeAll(); refresh(); fit(); clearHistory(); toast('工程已恢复。PS 文件联动需重新连接，未自动读取外部文件。');
}
function validateConfig() { const names = new Set(); for (const p of state.parts) { if (!/^[a-zA-Z0-9_.-]+$/.test(p.output) || !p.from || /["\r\n*]/.test(p.from)) throw Error('请检查导出规则：输出名使用字母、数字、_、-；from 不含引号、换行和 *。'); if (names.has(p.output.toLowerCase())) throw Error('不同材质的输出名称不能相同。'); names.add(p.output.toLowerCase()); } }
async function exportSkin() {
  if (draft) throw Error('请先确认或取消当前投射。'); validateConfig(); const files = {}, options = { builtin: state.builtin }, blk = skinConfig(state.parts, options);
  for (const p of state.parts) { compose(p); files[p.output + '.dds'] = state.mipmap.enabled ? toDDS(p, { ...exportPolicy(p, options), mipmaps: distanceMipmaps(p) }) : toDDS(p, exportPolicy(p, options)); }
  if (state.mipmap.enabled) files['distance-layers.json'] = strToU8(JSON.stringify({ mipmap: state.mipmap, parts: state.parts.map(p => ({ name: p.output, levels: mipDimensions(p.canvas.width, p.canvas.height) })), note: 'Mip levels are not fixed metre distances. Validate custom mip retention in game.' }, null, 2));
  files[state.builtin ? 'us_hstv_l.blk' : 'skin.blk'] = strToU8(blk);
  files['安装说明.txt'] = strToU8('将 DDS 与 BLK 放在 War Thunder/UserSkins/自定义目录。其他载具需沿用游戏模板的 BLK 文件名并核对 from。\n本工程仅导出颜色贴图，不覆盖游戏法线和材质贴图。源 JPEG 不包含原始 DDS Alpha；导入 DDS 可保留其 Alpha。\n可变皮肤启用时 DDS 包含完整自定义 mip 链；远近和斜视角、分辨率、画质会改变切换，不能指定固定米数。请在游戏内验证是否保留自定义 mip。\n请在游戏内检查材质、接缝与方向。\n');
  download(zipSync(files, { level: 1 }), state.vehicle + '-studio-skin.zip', 'application/zip'); toast('已导出 DDS + BLK，颜色贴图保持当前工程分辨率。');
}
async function exportPSD() {
  if (draft) throw Error('请先结束当前投射。'); const p = part(), children = [{ name: 'Base texture', canvas: p.base }];
  for (const l of p.layers) children.push({ name: '[' + (l.distanceBand || 'all') + '] ' + l.name, canvas: layerCanvas(p, l), left: Math.round(l.x * p.canvas.width), top: Math.round(l.y * p.canvas.height), opacity: l.opacity, hidden: !l.visible, blendMode: ({ 'source-over': 'normal', multiply: 'multiply', screen: 'screen', overlay: 'overlay', 'soft-light': 'soft light', lighter: 'linear dodge' })[l.blend] || 'normal' });
  children.push({ name: 'UV guide (hidden)', hidden: true, canvas: makeUV(p, true) });
  download(globalThis.agPsd.writePsd({ width: p.canvas.width, height: p.canvas.height, canvas: p.canvas, children }, { generateThumbnail: false }), p.output + '.psd'); toast('已导出分层 PSD：底图、栅格图层和隐藏 UV 参考层。');
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'X-Studio-Token': apiToken, ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
  const data = await response.json(); if (!response.ok) throw Error(data.error || '本地文件连接失败'); return data;
}
function watchDescription(link) { const p = state.parts.find(p => p.id === link.partId); return link.target === 'composite' ? `${p?.name} / PS 合成图层` : link.target === 'base' ? `${p?.name} / 底图` : link.target === 'projection' ? '整组投射源图片' : `${p?.name} / 图片图层`; }
function refreshLinks() {
  $('watchList').replaceChildren(...state.links.map(link => { const row = document.createElement('div'); row.className = 'watch-item'; const button = document.createElement('button'); button.textContent = '断开'; button.onclick = async () => { try { await api('/api/watch/' + link.id, { method: 'DELETE' }); state.links = state.links.filter(l => l.id !== link.id); refreshLinks(); } catch (e) { fail(e); } }; const name = document.createElement('div'); name.textContent = link.path; const status = document.createElement('span'); status.className = 'watch-status' + (link.error ? ' watch-error' : ''); status.textContent = watchDescription(link) + ' · ' + (link.error || link.status || '等待同步'); row.append(button, name, status); return row; }));
}
async function disconnectAll() { for (const link of state.links) { try { await api('/api/watch/' + link.id, { method: 'DELETE' }); } catch {} } state.links = []; refreshLinks(); }
async function connectPS() {
  if (draft) throw Error('请先结束当前投射。'); const target = $('watchTarget').value, l = selected(), p = part();
  if (target === 'layer' && (!l || ['projection', 'paint', 'fill'].includes(l.kind))) throw Error('请先选择普通图片或文字图层。');
  if (target === 'projection' && l?.kind !== 'projection') throw Error('请先选中一个模型投射图层。');
  const info = await api('/api/watch', { method: 'POST', body: JSON.stringify({ path: $('watchPath').value.trim() }) });
  const link = { id: info.id, path: info.path, target, partId: p.id, layerId: target === 'composite' ? null : l?.id, projectionId: l?.projectionId, stamp: null, status: '连接成功，正在读取…' }; state.links.push(link); refreshLinks(); await synchronize(link, info.stamp);
}
async function synchronize(link, stamp) {
  if (state.busy || draft || link.loading) return; link.loading = true;
  try {
    const response = await fetch('/api/watch/' + link.id + '/file', { headers: { 'X-Studio-Token': apiToken } }); if (!response.ok) { const error = await response.json(); throw Error(error.error); }
    const im = await readImage(new Uint8Array(await response.arrayBuffer()), link.path);
    const p = state.parts.find(p => p.id === link.partId); if (!p) throw Error('目标材质已不存在，请断开后重新连接。');
    if (link.target === 'composite') {
      if (im.width !== p.canvas.width || im.height !== p.canvas.height) throw Error(`PS 合成图需要 ${p.canvas.width} × ${p.canvas.height}`);
      let l = p.layers.find(l => l.id === link.layerId);
      if (!l && !link.compositeCreated) { checkpoint(); l = newLayer('PS · ' + link.path.replaceAll('\\', '/').split('/').pop(), 'external', { x: 0, y: 0, w: 1, h: 1 }); link.layerId = l.id; link.compositeCreated = true; p.layers.push(l); if (p === part()) state.selected = l.id; }
      if (!l) throw Error('PS 合成图层已删除，请重新连接。'); l.image = im; compose(p);
    }
    else if (link.target === 'base') { if (im.width !== p.canvas.width || im.height !== p.canvas.height) throw Error(`底图需要 ${p.canvas.width} × ${p.canvas.height}，当前为 ${im.width} × ${im.height}`); const split = splitBase(im); p.base = split.base; if (/\.dds$/i.test(link.path)) p.alpha = split.alpha; p.original.image = p.base; p.original.needsUpdate = true; compose(p); }
    else if (link.target === 'layer') { const l = p.layers.find(l => l.id === link.layerId); if (!l) throw Error('目标图层已删除，请重新连接。'); l.image = im; compose(p); }
    else { const record = state.projections.find(d => d.id === link.projectionId); if (!record) throw Error('目标投射已删除，请重新连接。'); const result = await bakeProjection({ renderer, model, geometries, parts: state.parts.filter(p => record.targets.includes(p.id)), camera: restoreCamera(record.camera), image: im, rect: record.rect, viewport: record.viewport, occlusion: record.occlusion, mirror: record.mirror }); record.image = im; commitResult(record, result); composeAll(); }
    editorRevision++; link.stamp = stamp; link.error = ''; link.status = '已同步 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }); refreshLayers(); say('PS 文件已同步：' + watchDescription(link));
  } catch (error) { link.error = error.message; } finally { link.loading = false; refreshLinks(); }
}
setInterval(async () => { if (!apiToken || !state.links.length || state.busy || draft) return; try { const info = await api('/api/watch'); for (const link of state.links) { const item = info.files.find(f => f.id === link.id); if (item?.error) { link.error = item.error; refreshLinks(); } else if (item && item.stamp !== link.stamp) await synchronize(link, item.stamp); } } catch {} }, 1200);

function agentContext() {
  const clean = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'number' ? Math.round(v * 100000) / 100000 : v));
  const currentCamera = captureCamera(camera, controls.target), views = { current: currentCamera };
  for (const [name, position] of Object.entries({ left: [8.8, 1.7, 0], right: [-8.8, 1.7, 0], front: [0, 1.7, 8.8], top: [0, 9, .001] })) {
    const c = camera.clone(); c.position.set(...position); c.lookAt(0, 1.05, 0); c.updateMatrixWorld(true); views[name] = captureCamera(c, new THREE.Vector3(0, 1.05, 0));
  }
  return clean({ version: 1, editorRevision, mipmap: state.mipmap, mipPreview: { mode: state.mipPreview, level: state.mipLevel }, vehicle: state.vehicle, selectedPart: part()?.id, selectedLayerId: state.selected, camera: currentCamera, views, viewport: { width: $('viewport').clientWidth, height: $('viewport').clientHeight },
    parts: state.parts.map(p => ({ id: p.id, key: p.key, name: p.name, width: p.canvas.width, height: p.canvas.height, output: p.output, layers: p.layers.map(l => ({ id: l.id, name: l.name, kind: l.kind, distanceBand: l.distanceBand || 'all', x: l.x, y: l.y, w: l.w, h: l.h, scale: l.scale, angle: l.angle, dx: l.dx, dy: l.dy, opacity: l.opacity, blend: l.blend, visible: l.visible, color: l.color, fill: l.fill, projectionId: l.projectionId, agent: l.agent })) })),
    projections: state.projections.map(d => ({ id: d.id, name: d.name, camera: d.camera, rect: d.rect, viewport: d.viewport, targets: d.targets, distanceBand: d.distanceBand || 'all', occlusion: d.occlusion })),
  });
}
function agentPreview() {
  renderer.render(scene, camera); const source = renderer.domElement, scale = Math.min(1, 1000 / source.width, 800 / source.height), c = canvas(Math.max(1, Math.round(source.width * scale)), Math.max(1, Math.round(source.height * scale))); c.getContext('2d').drawImage(source, 0, 0, c.width, c.height); return c.toDataURL('image/png');
}
async function fetchAgentAsset(id) { const response = await fetch('/api/agent/assets/' + encodeURIComponent(id) + '/file', { headers: { 'X-Studio-Token': apiToken } }); if (!response.ok) throw Error('Agent 素材不存在或读取失败'); return response; }
function resolveAgentParts(targets) {
  const result = targets?.length ? state.parts.filter(p => targets.some(t => [p.id, p.key, p.name, p.output].includes(t))) : [...state.parts];
  if (!result.length) throw Error('未匹配到目标材质，请重新读取 context'); return result;
}
function agentLayerMetadata(l, op, assetId) {
  if (op.distanceBand !== undefined) setLayerDistance(l, op.distanceBand);
  const old = l.agent || {}, versions = [...(old.versions || [])];
  if (assetId && versions.at(-1)?.assetId !== assetId) versions.push({ assetId, prompt: op.prompt || '', time: new Date().toISOString() });
  l.agent = { ...old, block: op.block || old.block || 'decoration', stage: op.stage ?? old.stage, prompt: op.prompt ?? old.prompt ?? '', assetId: assetId || old.assetId, versions, updatedAt: new Date().toISOString() };
}
function checkAgentLayer(l) { if (l?.agent?.locked) throw Error('图层已锁定：' + l.name); }
function validateAgentRect(rect) {
  for (const key of ['x', 'y', 'w', 'h']) if (!Number.isFinite(rect[key])) throw Error('图层区域需要有限数值 x/y/w/h');
  if (rect.w < .001 || rect.w > 2 || rect.h < .001 || rect.h > 2 || Math.abs(rect.x) > 2 || Math.abs(rect.y) > 2) throw Error('图层区域超出可用范围'); return rect;
}
async function applyAgentOperation(op, guard, userAction = false) {
  if (draft) throw Error('用户正在调整模型投射，请先结束该调整');
  if (op.type === 'preview') {
    if (op.mipPreview) {
      const { mode = 'manual', level = state.mipLevel } = op.mipPreview;
      if (!['manual', 'auto'].includes(mode) || !Number.isFinite(level) || level < 0 || level > 14) throw Error('预览模式或层级无效');
      if (!(await guard())) throw Error('任务已暂停或修改');
      state.mipPreview = mode; state.mipLevel = level; syncMipmapUI(); composeAll();
    }
    return { message: '已提供当前模型预览', layerIds: [] };
  }
  if (op.distanceBand !== undefined && !DISTANCE_BANDS.includes(op.distanceBand)) throw Error('距离分组无效');
  if (op.values?.distanceBand !== undefined && !DISTANCE_BANDS.includes(op.values.distanceBand)) throw Error('距离分组无效');
  const mipmap = op.mipmap ? validateMipmap({ ...state.mipmap, ...op.mipmap }) : null;
  const startRevision = editorRevision; let image, asset;
  if (op.type === 'image') {
    asset = agentWorkspace.session?.assets.find(a => a.id === op.assetId); const response = await fetchAgentAsset(op.assetId);
    image = await readImage(new Uint8Array(await response.arrayBuffer()), asset?.filename || 'asset.png');
  }
  if (!(await guard()) || startRevision !== editorRevision) throw Error('用户已暂停或修改画布，结果保留在素材库，请使用最新任务重新处理');
  const originalApplying = agentApplying; agentApplying = !userAction;
  const affected = [];
  try {
    if (op.type === 'update' && mipmap) {
      checkpoint(); state.mipmap = mipmap; syncMipmapUI(); composeAll();
    } else if (op.type === 'update') {
      const layers = state.parts.flatMap(p => p.layers).filter(l => (op.layerIds || [op.targetLayerId]).includes(l.id)); if (!layers.length) throw Error('要修改的图层不存在'); layers.forEach(checkAgentLayer);
      if (op.values?.distanceBand !== undefined) for (const l of layers) if (l.projectionId) state.parts.flatMap(p => p.layers).filter(n => n.projectionId === l.projectionId).forEach(checkAgentLayer);
      const values = {}; for (const [key, value] of Object.entries(op.values || {})) { if (['x', 'y', 'w', 'h', 'scale', 'dx', 'dy', 'angle', 'opacity'].includes(key)) { if (!Number.isFinite(value)) throw Error('属性数值无效'); values[key] = value; } else if (['visible', 'fill'].includes(key)) values[key] = !!value; else if (key === 'color' && /^#[\da-f]{6}$/i.test(value)) values[key] = value; else if (key === 'blend' && ['source-over', 'multiply', 'screen', 'overlay', 'soft-light', 'lighter'].includes(value)) values[key] = value; }
      for (const l of layers) validateAgentRect({ ...l, ...values }); checkpoint(); for (const l of layers) { Object.assign(l, values); if (op.values?.distanceBand !== undefined) setLayerDistance(l, op.values.distanceBand); agentLayerMetadata(l, op); affected.push(l.id); } composeAll(); refreshLayers();
    } else if (op.type === 'image' && op.targetLayerId) {
      const p = state.parts.find(p => p.layers.some(l => l.id === op.targetLayerId)), l = p?.layers.find(l => l.id === op.targetLayerId); if (!l) throw Error('目标图层已删除，请重新读取任务'); checkAgentLayer(l);
      if (l.kind === 'projection') {
        const record = state.projections.find(d => d.id === l.projectionId); if (!record) throw Error('投射源不存在');
        for (const p of state.parts) for (const sibling of p.layers.filter(s => s.projectionId === record.id)) checkAgentLayer(sibling);
        const placement = op.placement, revised = placement ? { ...record, camera: placement.camera || agentContext().views[placement.view || 'current'], viewport: placement.viewport || record.viewport, rect: { ...record.rect, ...placement.rect }, occlusion: placement.occlusion ?? record.occlusion, mirror: placement.mirror ?? record.mirror } : record;
        if (!revised.camera || !Object.values(revised.rect).every(Number.isFinite) || revised.rect.w <= 0 || revised.rect.h <= 0 || revised.rect.w > 4 || revised.rect.h > 4) throw Error('投射参数无效');
        const result = await bakeProjection({ renderer, model, geometries, parts: state.parts.filter(p => record.targets.includes(p.id)), camera: restoreCamera(revised.camera), image, rect: revised.rect, viewport: revised.viewport, occlusion: revised.occlusion, mirror: revised.mirror });
        if (!result.size) throw Error('修改后投射未覆盖模型，请重新定位');
        if (startRevision !== editorRevision || !(await guard())) throw Error('用户已修改要求，投射未落图');
        checkpoint(); Object.assign(record, revised); record.image = image; commitResult(record, result);
        for (const p of state.parts) for (const sibling of p.layers.filter(s => s.projectionId === record.id)) { agentLayerMetadata(sibling, op, op.assetId); affected.push(sibling.id); }
      } else { checkpoint(); l.image = image; if (l.kind === 'fill') { l.kind = 'image'; l.fill = false; } agentLayerMetadata(l, op, op.assetId); affected.push(l.id); }
      state.part = state.parts.indexOf(p); state.selected = l.id; composeAll(); refresh();
    } else if (op.type === 'image') {
      const placement = op.placement || asset?.placement || agentWorkspace.session?.job.placement || { mode: 'projection', view: 'current' };
      const parts = resolveAgentParts(op.targets || placement.targets);
      if (placement.mode === 'uv') {
        const rect = validateAgentRect(placement.rect || { x: .25, y: .25, w: .5, h: .5 }); checkpoint();
        for (const p of parts) { const l = newLayer(op.name || asset?.name || 'Agent 图片', 'image', rect); l.image = image; l.distanceBand = op.distanceBand || 'all'; agentLayerMetadata(l, op, op.assetId); p.layers.push(l); affected.push(l.id); }
      } else {
        const snapshot = placement.camera || agentContext().views[placement.view || 'current']; if (!snapshot) throw Error('投射视角不存在');
        const viewport = placement.viewport || { width: 1000 * snapshot.aspect, height: 1000 }, rect = { cx: .5, cy: .5, w: .35, h: .35 * snapshot.aspect * image.height / image.width, angle: 0, ...placement.rect };
        for (const value of Object.values(rect)) if (!Number.isFinite(value)) throw Error('投射参数无效'); if (rect.w <= 0 || rect.h <= 0 || rect.w > 4 || rect.h > 4) throw Error('投射尺寸无效');
        const record = { id: crypto.randomUUID(), name: op.name || asset?.name || 'Agent 投射', image, camera: snapshot, viewport, rect, targets: parts.map(p => p.id), occlusion: placement.occlusion !== false, mirror: !!placement.mirror, distanceBand: op.distanceBand || 'all' };
        const result = await bakeProjection({ renderer, model, geometries, parts, camera: restoreCamera(snapshot), image, rect, viewport, occlusion: record.occlusion, mirror: record.mirror });
        if (!result.size) throw Error('图片未覆盖所选模型表面，请重新定位后重试');
        if (startRevision !== editorRevision || !(await guard())) throw Error('用户已修改要求，投射未落图');
        checkpoint(); state.projections.push(record); commitResult(record, result); for (const p of parts) for (const l of p.layers.filter(l => l.projectionId === record.id)) { agentLayerMetadata(l, op, op.assetId); affected.push(l.id); }
      }
      const p = state.parts.find(p => p.layers.some(l => affected.includes(l.id))); state.part = state.parts.indexOf(p); state.selected = p.layers.find(l => affected.includes(l.id)).id; composeAll(); refresh();
    } else if (['fill', 'text'].includes(op.type)) {
      const parts = resolveAgentParts(op.targets), rect = validateAgentRect(op.rect || (op.type === 'fill' ? { x: 0, y: 0, w: 1, h: 1 } : { x: .2, y: .4, w: .6, h: .2 }));
      const color = op.color || '#a8cbe4'; if (!/^#[\da-f]{6}$/i.test(color)) throw Error('颜色须为 #RRGGBB');
      checkpoint(); for (const p of parts) {
        const l = newLayer(op.name || (op.type === 'text' ? 'Agent 文字' : 'Agent 底色'), op.type, rect); l.opacity = clamp(op.opacity ?? 1, 0, 1); l.blend = ['source-over', 'multiply', 'screen', 'overlay', 'soft-light', 'lighter'].includes(op.blend) ? op.blend : 'source-over';
        if (op.type === 'fill') { l.fill = true; l.color = color; } else { l.text = String(op.text || '').slice(0, 2000); l.font = ['Arial', 'Microsoft YaHei', 'Georgia', 'Impact', 'Consolas'].includes(op.font) ? op.font : 'Arial'; l.textColor = color; l.image = textImage(l); }
        l.distanceBand = op.distanceBand || 'all'; agentLayerMetadata(l, op); p.layers.push(l); affected.push(l.id);
      }
      state.part = state.parts.indexOf(parts[0]); state.selected = parts[0].layers.at(-1).id; composeAll(); refresh();
    } else throw Error('未知 Agent 操作');
    return { message: mipmap ? '已更新可选距离渐变设置，现有图层保留' : `已同步 ${affected.length} 个独立图层，其他图层保留`, layerIds: affected };
  } finally { agentApplying = originalApplying; }
}

// Distance settings are project data; preview movement does not pause the agent.
$('mipEnabled').onchange = () => { checkpoint(); state.mipmap.enabled = $('mipEnabled').checked; syncMipmapUI(); composeAll(); };
for (const id of ['mipMid', 'mipFar', 'mipSmooth']) $(id).onchange = () => { try { const value = validateMipmap({ enabled: state.mipmap.enabled, midLevel: Number($('mipMid').value), farLevel: Number($('mipFar').value), smooth: $('mipSmooth').checked }); checkpoint(); state.mipmap = value; syncMipmapUI(); composeAll(); } catch (e) { syncMipmapUI(); fail(e); } };
$('mipMode').onchange = () => { state.mipPreview = $('mipMode').value; syncMipmapUI(); composeAll(); };
$('mipLevel').oninput = () => { state.mipLevel = Number($('mipLevel').value); syncMipmapUI(); composeAll(); };
for (const band of ['near', 'mid', 'far']) $('preview' + band).onclick = () => { state.mipPreview = 'manual'; state.mipLevel = { near: 0, mid: state.mipmap.midLevel, far: state.mipmap.farLevel }[band]; syncMipmapUI(); composeAll(); };
$('creationDistance').onchange = () => state.creationDistance = $('creationDistance').value;
$('layerDistance').onchange = () => { if (!selected()) return; checkpoint(); setLayerDistance(selected(), $('layerDistance').value); composeAll(); refreshLayers(); };
$('copyDistance').onclick = () => { const l = selected(); if (!l) return; checkpoint(); const band = $('copyDistanceTarget').value;
  let projectionId; if (l.projectionId) { const original = state.projections.find(p => p.id === l.projectionId); projectionId = crypto.randomUUID(); state.projections.push({ ...original, id: projectionId, name: original.name + ' / ' + band, rect: { ...original.rect }, targets: [...original.targets], distanceBand: band }); }
  for (const p of state.parts) for (const old of [...p.layers].filter(n => l.projectionId ? n.projectionId === l.projectionId : n.id === l.id)) { const copy = cloneLayers([old])[0]; copy.id = crypto.randomUUID(); copy.name += ' / ' + band; copy.distanceBand = band; if (projectionId) copy.projectionId = projectionId; p.layers.push(copy); if (old.id === l.id) state.selected = copy.id; }
  composeAll(); refreshLayers(); toast('已复制到距离分组，源图层保留。');
};
syncMipmapUI();
// UI bindings.
for (const k of ['x', 'y', 'w', 'h', 'scale', 'dx', 'dy', 'angle', 'opacity']) { $(k).onpointerdown = () => { if (selected()) checkpoint(); }; $(k).onkeydown = e => { if (e.key.startsWith('Arrow') && selected()) checkpoint(); }; $(k).oninput = () => { if (selected()) { selected()[k] = Number($(k).value); syncProperties(); compose(); } }; }
$('part').onchange = () => { state.part = Number($('part').value); state.selected = null; refresh(); fit(); };
$('layerName').onchange = () => { if (selected()) { checkpoint(); selected().name = $('layerName').value; refreshLayers(); } };
for (const [id, key] of [['blend', 'blend'], ['fillColor', 'color'], ['fillEnabled', 'fill'], ['flip', 'flip']]) $(id).onchange = () => { if (selected()) { checkpoint(); selected()[key] = $(id).type === 'checkbox' ? $(id).checked : $(id).value; compose(); } };
$('addImage').onclick = () => pick('.png,.jpg,.jpeg,.webp,.psd,.tga,.dds', async f => addImage(await fileImage(f), f.name));
$('sourceImage').onclick = () => { if (selected()?.kind === 'projection') { beginProjection(state.projections.find(d => d.id === selected().projectionId)); return; } pick('.png,.jpg,.jpeg,.webp,.psd,.tga,.dds', async f => { const image = await fileImage(f); checkpoint(); selected().image = image; compose(); refreshLayers(); }); };
$('addText').onclick = () => { checkpoint(); const l = newLayer('文字图层', 'text', { x: .2, y: .4, w: .6, h: .2 }); Object.assign(l, { text: 'SKIN STUDIO', font: 'Arial', textColor: '#e6edf2' }); l.image = textImage(l); part().layers.push(l); state.selected = l.id; compose(); refreshLayers(); };
$('updateText').onclick = () => { const l = selected(); if (!l) return; checkpoint(); Object.assign(l, { text: $('textValue').value, font: $('font').value, textColor: $('textColor').value }); l.image = textImage(l); compose(); refreshLayers(); };
$('addFill').onclick = () => { checkpoint(); const l = newLayer('色块', 'fill'); l.fill = true; l.color = $('paintColor').value; part().layers.push(l); state.selected = l.id; compose(); refreshLayers(); };
function addPaint() { checkpoint(); const l = newLayer('绘画图层', 'paint', { x: 0, y: 0, w: 1, h: 1 }); l.image = canvas(part().canvas.width, part().canvas.height); part().layers.push(l); state.selected = l.id; refreshLayers(); setTool('paint'); }
$('addPaint').onclick = addPaint;
$('deleteLayer').onclick = () => { if (selected()) { checkpoint(); if (selected().projectionId) { const d = state.projections.find(d => d.id === selected().projectionId); if (d) d.targets = d.targets.filter(id => id !== part().id); state.projections = state.projections.filter(d => d.targets.length); } part().layers = part().layers.filter(l => l.id !== state.selected); state.selected = null; compose(); refreshLayers(); } };
$('duplicate').onclick = () => { const l = selected(); if (!l) return; checkpoint(); const next = cloneLayers([l])[0]; next.id = crypto.randomUUID(); next.name += ' 副本'; if (next.kind === 'projection') { next.kind = 'image'; delete next.projectionId; } part().layers.push(next); state.selected = next.id; compose(); refreshLayers(); };
for (const [id, delta] of [['layerUp', 1], ['layerDown', -1]]) $(id).onclick = () => { const i = part().layers.findIndex(l => l.id === state.selected), j = i + delta; if (i >= 0 && j >= 0 && j < part().layers.length) { checkpoint(); [part().layers[i], part().layers[j]] = [part().layers[j], part().layers[i]]; compose(); refreshLayers(); } };
$('resetTransform').onclick = () => { if (selected()) { checkpoint(); Object.assign(selected(), { scale: 1, dx: 0, dy: 0, angle: 0, flip: false }); compose(); syncProperties(); } };
$('resetMask').onclick = () => { if (selected()) { checkpoint(); const g = selected().mask.getContext('2d'); g.globalCompositeOperation = 'source-over'; g.fillStyle = '#fff'; g.fillRect(0, 0, 512, 512); compose(); } };
for (const id of ['move', 'draw', 'eraseMask', 'paintMask', 'paint', 'erasePaint']) $(id).onclick = () => { if (id.endsWith('Mask') && !selected()) { toast('请先选择图层。'); return; } if (id === 'paint' && selected()?.kind !== 'paint') { addPaint(); return; } setTool(id); };
$('brush').oninput = () => { state.brush = Number($('brush').value); $('brush').nextElementSibling.value = state.brush; };
$('fit').onclick = fit; $('uv').onchange = drawEditor; $('undo').onclick = () => travel(state.history, state.redo); $('redo').onclick = () => travel(state.redo, state.history);
$('compare').onchange = () => { model?.traverse(o => { if (o.isMesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m.userData.part) { m.map = $('compare').checked ? m.userData.part.original : m.userData.part.texture; m.needsUpdate = true; } }); drawEditor(); };
$('wireframe').onchange = () => model?.traverse(o => { if (o.isMesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.wireframe = $('wireframe').checked; });
$('resetCamera').onclick = () => resetCamera(); $('leftView').onclick = () => resetCamera('left'); $('rightView').onclick = () => resetCamera('right');
$('exposure').oninput = () => { renderer.toneMappingExposure = Number($('exposure').value); $('exposure').nextElementSibling.value = renderer.toneMappingExposure.toFixed(2); };
$('screenshot').onclick = () => { renderer.render(scene, camera); renderer.domElement.toBlob(b => download(b, state.vehicle + '-preview.png')); };
$('png').onclick = () => { if (draft) return toast('请先结束当前投射。'); part().canvas.toBlob(b => download(b, part().output + '.png')); };
$('blankBase').onclick = () => { checkpoint([part().id]); const g = part().base.getContext('2d'); g.fillStyle = $('baseColor').value; g.fillRect(0, 0, part().base.width, part().base.height); part().original.needsUpdate = true; compose(); };
$('importBase').onclick = () => pick('.png,.jpg,.jpeg,.webp,.psd,.tga,.dds', async f => { const image = await fileImage(f), p = part(); if (image.width !== p.canvas.width || image.height !== p.canvas.height) throw Error(`底图需要 ${p.canvas.width} × ${p.canvas.height}`); checkpoint([p.id]); const split = splitBase(image); p.base = split.base; if (/\.dds$/i.test(f.name)) p.alpha = split.alpha; p.original.image = p.base; p.original.needsUpdate = true; compose(); });
$('saveProject').onclick = () => task('保存工程…', saveProject); $('openProject').onclick = () => pick('.zip', openProject); $('importModel').onclick = () => pick('.zip', importModel); $('export').onclick = () => task('生成 DDS 与 BLK…', exportSkin);
$('exportPSD').onclick = () => task('生成分层 PSD…', exportPSD); $('exportUV').onclick = () => makeUV(part(), true).toBlob(b => download(b, part().output + '-UV.png'));
for (const [id, key] of [['fromName', 'from'], ['outputName', 'output'], ['rule', 'rule']]) $(id).onchange = () => part()[key] = $(id).value.trim(); $('camoParam').onchange = () => part().param = $('camoParam').checked;
$('importBlk').onclick = () => pick('.blk', async f => { const text = await f.text(); let count = 0; for (const m of text.matchAll(/(replace_tex|set_tex)\s*\{([^}]+)\}/g)) { const from = m[2].match(/from:t\s*=\s*"([^"]+)"/)?.[1], to = m[2].match(/to:t\s*=\s*"([^"]+)"/)?.[1]; const p = state.parts.find(p => p.output + '.dds' === to || p.from === from?.replace(/\*$/, '')); if (p) { p.from = from.replace(/\*$/, ''); p.rule = m[1]; p.param = m[2].includes('camo_skin_tex'); count++; } } refresh(); toast('已导入 ' + count + ' 条颜色贴图规则。'); });
$('startProjection').onclick = () => { beginProjection(); $('projectionImage').click(); };
$('projectionImage').onclick = () => pick('.png,.jpg,.jpeg,.webp,.psd,.tga', async f => setDraftImage(await fileImage(f), f.name));
$('editProjection').onclick = () => { const d = state.projections.find(d => d.id === selected()?.projectionId); if (d) beginProjection(d); };
$('deleteProjection').onclick = () => { const id = selected()?.projectionId; if (!id) return; checkpoint(); for (const p of state.parts) p.layers = p.layers.filter(l => l.projectionId !== id); state.projections = state.projections.filter(d => d.id !== id); state.selected = null; composeAll(); refreshLayers(); };
$('projectionReference').onchange = updateSticker;
$('cancelProjection').onclick = cancelProjection; $('applyProjection').onclick = () => task('将图片投射到各材质…', applyProjection);
$('projectionAngle').oninput = () => { if (draft) { draft.rect.angle = Number($('projectionAngle').value); updateSticker(); scheduleDraft(); } };
$('projectionSize').oninput = () => { if (draft) { const factor = Number($('projectionSize').value) / draft.rect.w; draft.rect.w *= factor; draft.rect.h *= factor; updateSticker(); scheduleDraft(); } };
$('projectionOcclusion').onchange = () => { if (draft) { draft.occlusion = $('projectionOcclusion').checked; scheduleDraft(); } }; $('projectionMirror').onchange = () => { if (draft) { draft.mirror = $('projectionMirror').checked; updateSticker(); scheduleDraft(); } }; $('projectionLive').onchange = () => { if (!$('projectionLive').checked) composeAll(); else scheduleDraft(); };
$('connectPS').onclick = () => connectPS().catch(fail); $('browsePS').onclick = () => task('选择 Photoshop 联动文件…', async () => { const result = await api('/api/browse', { method: 'POST' }); if (result.path) $('watchPath').value = result.path; });
new ResizeObserver(drawEditor).observe($('editorWrap'));
await task('加载模型与原车贴图…', async () => { init3D(); const info = await fetch('/api/session').then(r => r.json()); apiToken = info.token; await loadBuiltin(); });
if (model && !new URLSearchParams(location.search).has('test')) agentWorkspace = new AgentWorkspace({ api, context: agentContext, preview: agentPreview, fetchAsset: fetchAgentAsset, selected, busy: () => state.busy || !!draft || !!drag,
  selectedSource: () => { const l = selected(); const image = l?.projectionId ? state.projections.find(d => d.id === l.projectionId)?.image : l?.image; return image ? getImageSrc(image) : null; },
  lockLayer: locked => { const l = selected(); if (!l) return; checkpoint(); l.agent = { ...l.agent, locked }; refreshLayers(); },
  apply: applyAgentOperation, toast, fail,
  beginRegion: () => { if (draft) { toast('请先结束当前模型投射'); return false; } controls.update(); controls.enabled = false; return true; }, endRegion: () => controls.enabled = true,
});

// Isolated browser checks never publish canvas context to the user's agent task.
if (new URLSearchParams(location.search).has('test')) globalThis.studioTest = { AgentWorkspace, state, apply: op => applyAgentOperation(op, async () => true), composeAll, distanceSources, distanceMipmaps, blendDistance, serializeLayer, hydrateLayer, snapshot, travel, restoreProject, getImageSrc, context: agentContext, renderer, scene, camera, controls };
