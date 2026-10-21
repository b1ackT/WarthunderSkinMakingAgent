// Distance variants remain ordinary editable layers. Mip levels are not metres.
export const DISTANCE_BANDS = ['all', 'near', 'mid', 'far'];
export const DEFAULT_MIPMAP = Object.freeze({ enabled: false, midLevel: 3, farLevel: 6, smooth: true });
export function normalizeMipmap(value = {}) {
  const mid = Number.isFinite(value.midLevel) ? Math.max(1, Math.min(10, value.midLevel)) : 3;
  const far = Number.isFinite(value.farLevel) ? Math.max(mid + 1, Math.min(14, value.farLevel)) : Math.max(mid + 1, 6);
  return { enabled: !!value.enabled, midLevel: mid, farLevel: far, smooth: value.smooth !== false };
}
export function validateMipmap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('距离设置需要对象');
  for (const key of Object.keys(value)) if (!['enabled', 'midLevel', 'farLevel', 'smooth'].includes(key)) throw Error('未知距离设置：' + key);
  for (const key of ['enabled', 'smooth']) if (key in value && typeof value[key] !== 'boolean') throw Error(key + ' 需要布尔值');
  for (const key of ['midLevel', 'farLevel']) if (key in value && (!Number.isInteger(value[key]) || value[key] < 1 || value[key] > 14)) throw Error(key + ' 需要1至14的整数');
  const result = normalizeMipmap(value);
  if (('midLevel' in value && result.midLevel !== value.midLevel) || ('farLevel' in value && result.farLevel !== value.farLevel)) throw Error('中景层级须小于远景层级，中景最大10');
  return result;
}
export function mipWeights(level, config = DEFAULT_MIPMAP) {
  const c = normalizeMipmap(config), x = Math.max(0, Number.isFinite(level) ? level : 0);
  if (!c.enabled) return { near: 1, mid: 0, far: 0 };
  const first = x < c.midLevel, start = first ? 0 : c.midLevel, end = first ? c.midLevel : c.farLevel;
  let t = Math.max(0, Math.min(1, (x - start) / (end - start)));
  if (c.smooth) t = t * t * (3 - 2 * t);
  return first ? { near: 1 - t, mid: t, far: 0 } : { near: 0, mid: 1 - t, far: t };
}
export function mipDimensions(width, height) {
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 16384)) throw Error('无效贴图尺寸');
  const levels = [];
  for (;;) { levels.push({ width, height }); if (width === 1 && height === 1) return levels; width = Math.max(1, Math.floor(width / 2)); height = Math.max(1, Math.floor(height / 2)); }
}
export function layerInBand(layer, band) { return !layer.distanceBand || layer.distanceBand === 'all' || layer.distanceBand === band; }
