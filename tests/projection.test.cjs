const { test } = require('node:test');
const assert = require('node:assert/strict');

test('UV baking retains world coordinates and separates material groups', async () => {
  const THREE = await import('three');
  const { buildUVGeometry } = await import('../projection.js');
  const p1 = { id: 'body' }, p2 = { id: 'turret' };
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 1,0,0, 0,1,0, 0,0,1, 1,0,1, 0,1,1], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([3.2,-1.8, 3.8,-1.8, 3.2,-1.2, 0,0, 1,0, 0,1], 2));
  g.addGroup(0, 3, 0); g.addGroup(3, 3, 1);
  const m1 = new THREE.MeshBasicMaterial(), m2 = new THREE.MeshBasicMaterial(); m1.userData.part = p1; m2.userData.part = p2;
  const mesh = new THREE.Mesh(g, [m1, m2]); mesh.position.set(4, 2, 3); mesh.scale.setScalar(2);
  const model = new THREE.Group(); model.add(mesh);
  const baked = buildUVGeometry(model, [p1, p2]);
  assert.equal(baked.get('body').attributes.position.count, 3);
  assert.equal(baked.get('turret').attributes.position.count, 3);
  const pos = baked.get('body').attributes.position, uv = baked.get('body').attributes.atlas;
  assert.deepEqual([pos.getX(1), pos.getY(1), pos.getZ(1)], [6, 2, 3]);
  assert.ok(Math.abs(uv.getX(0) - .2) < 1e-5); assert.ok(Math.abs(uv.getY(0) - .2) < 1e-5);
  assert.equal(baked.get('turret').attributes.atlas.getX(1), 1, 'exact integer endpoints must not wrap to zero');
});

test('triangles crossing a UV tile edge are copied and clipped, not fractured', async () => {
  const THREE = await import('three'); const { buildUVGeometry } = await import('../projection.js');
  const p = { id: 'body' }, m = new THREE.MeshBasicMaterial(); m.userData.part = p;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 1,0,0, 0,1,0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([.9,.2, 1.1,.2, .9,.8], 2));
  const model = new THREE.Group(); model.add(new THREE.Mesh(g, m)); const atlas = buildUVGeometry(model, [p]).get('body').attributes.atlas;
  assert.equal(atlas.count, 6); assert.ok(atlas.getX(1) > 1); assert.ok(atlas.getX(3) < 0);
});

test('reopening a projector in a wider panel preserves its world-space framing', async () => {
  const { reframeRectangle } = await import('../projection.js');
  const before = { cx: .65, cy: .4, w: .4, h: .3, angle: 25 };
  const after = reframeRectangle(before, 1, 2);
  assert.ok(Math.abs(after.cx - .575) < 1e-10);
  assert.equal(after.w, .2); assert.equal(after.h, .3); assert.equal(after.angle, 25);
});
