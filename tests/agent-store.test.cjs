const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AgentStore, decodeImage } = require('../agent-store.cjs');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skin-agent-test-'));
  t.after(async () => { const target = path.resolve(root); assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep + 'skin-agent-test-')); await fs.rm(target, { recursive: true, force: true }); });
  const s = new AgentStore(root); await s.ready;
  await s.updateContext({ editorRevision: 1, parts: [] });
  await s.start({ brief: 'Layered demonstration' }); await s.claim(); return s;
}
test('pause rejects late operations and invalidates queued work', async t => {
  const s = await fixture(t), revision = s.job.revision;
  const c = await s.enqueue({ revision, operation: { type: 'fill' } });
  await s.control('pause'); assert.equal(c.status, 'cancelled');
  await assert.rejects(s.enqueue({ revision, operation: { type: 'fill' } }), /任务已修改/);
  await assert.rejects(s.acknowledge(c.id, { success: true }), /任务已修改/);
  assert.deepEqual(await s.pollCommands(), []);
});
test('stage review pauses, continue requires a new claim and revision', async t => {
  const s = await fixture(t), oldRevision = s.job.revision;
  await s.stage({ revision: oldRevision, index: 0, status: 'completed' });
  assert.equal(s.job.status, 'paused'); await s.control('resume');
  assert.equal(s.job.status, 'queued'); await assert.rejects(s.enqueue({ revision: s.job.revision, operation: { type: 'fill' } }), /未运行/);
  await s.claim(); const c = await s.enqueue({ revision: s.job.revision, operation: { type: 'fill' } });
  await s.acknowledge(c.id, { success: true, context: { editorRevision: 1 } }); assert.equal(c.status, 'applied');
});
test('user canvas edits pause the job, agent acknowledgements do not', async t => {
  const s = await fixture(t), revision = s.job.revision;
  const c = await s.enqueue({ revision, operation: { type: 'fill' } });
  await s.acknowledge(c.id, { success: true, context: { editorRevision: 1 } });
  assert.equal(s.job.status, 'running'); await s.updateContext({ editorRevision: 2 });
  assert.equal(s.job.status, 'paused'); assert.ok(s.job.revision > revision);
});
test('restart preserves assets and pauses interrupted creation', async t => {
  const s = await fixture(t); const revision = s.job.revision;
  await s.enqueue({ revision, operation: { type: 'preview' } });
  const restored = new AgentStore(s.projectRoot); await restored.ready;
  assert.equal(restored.job.status, 'paused'); assert.equal(restored.commands[0].status, 'cancelled');
  assert.equal(restored.job.brief, 'Layered demonstration');
});
test('image registration validates signatures and late new reference pauses', async t => {
  assert.throws(() => decodeImage('data:image/png;base64,aGVsbG8='), /格式与内容/);
  const s = await fixture(t), dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
  const a = await s.addAsset({ dataUrl, name: 'reference.png', source: 'upload' });
  assert.equal(s.job.status, 'paused'); assert.ok(s.job.references.includes(a.id));
  assert.ok((await s.assetFile(a.id)).path.startsWith(s.assetsDir + path.sep));
});
