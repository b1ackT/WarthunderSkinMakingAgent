const { test } = require('node:test');
const assert = require('node:assert/strict');
test('fixed tank camouflage uses set_tex and the required camo slot', async () => {
  const { exportPolicy, skinConfig } = await import('../skin-export.js');
  const p = { from: 'hstv_l_body_c', output: 'hstv_l_body_c', rule: 'set_tex', param: false };
  assert.deepEqual(exportPolicy(p), { rule: 'set_tex', param: true, alphaOverride: undefined });
  assert.match(skinConfig([p]), /set_tex\{[\s\S]*param:t="camo_skin_tex"/);
});
test('old built-in projects migrate the broken white-alpha replacement combination', async () => {
  const { exportPolicy, skinConfig } = await import('../skin-export.js');
  const parts = ['body','turret','gun','mg'].map(k => ({ from: `hstv_l_${k}_c`, output: `hstv_l_${k}_c`, rule: 'replace_tex', param: true }));
  const original = JSON.stringify(parts), blk = skinConfig(parts, { builtin: true });
  assert.equal((blk.match(/set_tex\{/g) || []).length, 4); assert.ok(!blk.includes('replace_tex'));
  assert.equal(JSON.stringify(parts), original); assert.equal(exportPolicy(parts[0], { builtin: true }).alphaOverride, undefined);
});
test('explicit direct replacement exports black albedo alpha and no camo slot', async () => {
  const { exportPolicy, skinConfig } = await import('../skin-export.js');
  const p = { from: 'hstv_l_body_c', output: 'body', rule: 'replace_tex', param: false };
  assert.deepEqual(exportPolicy(p, { builtin: true }), { rule: 'replace_tex', param: false, alphaOverride: 0 });
  assert.ok(!skinConfig([p], { builtin: true }).includes('camo_skin_tex'));
  assert.equal(exportPolicy({ ...p, from: 'hstv_l_body_n' }).alphaOverride, undefined);
});
test('DDS writer changes only alpha for direct replacement, fixed mode stays opaque', async () => {
  const { toDDS } = await import('../image-io.js');
  const rgba = new Uint8ClampedArray([19,45,99,255, 240,120,60,255]);
  const p = { canvas: { width: 2, height: 1, getContext: () => ({ getImageData: () => ({ data: rgba }) }) } };
  const fixed = toDDS(p), direct = toDDS(p, { alphaOverride: 0 });
  assert.deepEqual([...fixed.slice(128)], [99,45,19,255, 60,120,240,255]);
  assert.deepEqual([...direct.slice(128)], [99,45,19,0, 60,120,240,0]);
  assert.deepEqual([...fixed.slice(0,128)], [...direct.slice(0,128)]);
});
