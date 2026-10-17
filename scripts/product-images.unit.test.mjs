import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProductImageCoordinator } from '../src/services/productImageOperation.ts';
import { prepareProductImage, imageDigest } from '../src/services/productImagePreparation.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhX8AAAAASUVORK5CYII=', 'base64');
const webp = new Blob([Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64')], { type: 'image/webp' });
const prepared = { selectionId: '11111111-1111-4111-8111-111111111111', blob: webp,
  sha256: await imageDigest(await webp.arrayBuffer()), size: webp.size };
const product = { id: 7, store_id: 1, name: 'LOCAL PRODUCT', image_path: '1/7/image.webp' };
function storage() {
  const map = new Map();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
}
function fixture() {
  const pending = storage(); const files = new Map([['1/7/image.webp', webp]]);
  const db = { ...product }; const calls = { upload: 0, link: 0, verify: 0 }; const states = [];
  const io = {
    readProduct: async () => ({ ...db }),
    upload: async (o, blob) => { calls.upload++; if (files.has(o.candidatePath)) throw new Error('exists'); files.set(o.candidatePath, blob); },
    verify: async (o) => { calls.verify++; const file = files.get(o.candidatePath); return !file ? 'absent'
      : await imageDigest(await file.arrayBuffer()) === o.sha256 ? 'match' : 'different'; },
    link: async (o) => {
      calls.link++;
      if (db.image_path !== o.expectedPath) return { status: 'conflict', product: { ...db } };
      db.image_path = o.candidatePath;
      return { status: 'linked', product: { ...db } };
    },
  };
  const coordinator = () => createProductImageCoordinator('owner', 1, pending, io, (o) => states.push(o.phase));
  return { pending, files, db, calls, states, io, coordinator };
}

test('preparation rejects MIME spoofing, empty/oversized files and header dimensions BEFORE conversion', async () => {
  let converts = 0;
  const convert = async () => { converts++; return webp; };
  const huge = Buffer.from(png); huge.writeUInt32BE(10000, 16);
  for (const file of [new File([], 'empty.png', { type: 'image/png' }),
    new File(['not a png'], 'fake.png', { type: 'image/png' }),
    new File([png], 'wrong.jpg', { type: 'image/jpeg' }),
    new File([huge], 'huge.png', { type: 'image/png' }),
    new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' })]) {
    await assert.rejects(prepareProductImage(file, convert));
  }
  assert.equal(converts, 0);
});

test('conversion failures and non-WebP/oversized output are rejected before a product can be saved', async () => {
  const file = new File([png], 'local.png', { type: 'image/png' });
  await assert.rejects(prepareProductImage(file, async () => { throw new Error('decoder failed'); }), /decoder/);
  for (const blob of [new Blob([png], { type: 'image/png' }), new Blob([], { type: 'image/webp' }),
    new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: 'image/webp' })]) {
    await assert.rejects(prepareProductImage(file, async () => blob));
  }
  const result = await prepareProductImage(file, async () => webp);
  assert.equal(result.sha256, prepared.sha256);
  assert.equal(result.size, webp.size);
});

test('successful upload/link emits clear phases, uses one candidate and preserves the original file', async () => {
  const f = fixture(); const c = f.coordinator();
  const o = c.begin(product, 'Veterinaria Kafka', prepared, product.image_path);
  assert.match(o.candidatePath, /^1-veterinaria-kafka\/products\/7-local-product\/principal-[a-f0-9-]+\.webp$/);
  assert.equal((await c.run(7, prepared)).status, 'linked');
  assert.deepEqual(f.states, ['prepared', 'uploading', 'uploaded', 'linking', 'linked']);
  assert.equal(f.calls.upload, 1); assert.equal(f.calls.link, 1);
  assert.ok(f.files.has(product.image_path)); assert.equal(f.pending.map.size, 0);
});

test('confirmed upload and failed linking retry ONLY linking, with unchanged candidate', async () => {
  const f = fixture(); const c = f.coordinator();
  const o = c.begin(product, 'store', prepared, product.image_path);
  const link = f.io.link;
  f.io.link = async () => ({ status: 'uncertain', product: { ...f.db } });
  assert.equal((await c.run(7, prepared)).status, 'uncertain');
  assert.equal(f.db.image_path, product.image_path);
  f.io.link = link;
  assert.equal((await c.run(7)).status, 'linked');
  assert.equal(f.db.image_path, o.candidatePath); assert.equal(f.calls.upload, 1);
});

test('lost upload response verifies candidate and never sends a second upload in that run', async () => {
  const f = fixture(); const upload = f.io.upload;
  f.io.upload = async (...args) => { await upload(...args); throw new Error('response lost'); };
  const c = f.coordinator(); c.begin(product, 'store', prepared, product.image_path);
  assert.equal((await c.run(7, prepared)).status, 'linked');
  assert.equal(f.calls.upload, 1); assert.equal(f.calls.verify, 1);
});

test('timed-out upload and repeated absence never authorize a second upload; late completion recovers', async () => {
  const f = fixture(); let completeLate;
  f.io.upload = async (operation, blob) => {
    f.calls.upload++;
    completeLate = () => f.files.set(operation.candidatePath, blob);
    throw new Error('deadline elapsed while request is still running');
  };
  const c = f.coordinator(); const o = c.begin(product, 'store', prepared, product.image_path);
  assert.equal((await c.run(7, prepared)).status, 'uncertain');
  assert.equal(f.calls.upload, 1);
  assert.equal((await c.run(7)).status, 'uncertain');
  assert.equal(f.calls.upload, 1);
  assert.equal((await c.run(7, prepared)).status, 'uncertain');
  assert.equal((await f.coordinator().run(7, prepared)).status, 'uncertain');
  assert.equal(f.calls.upload, 1); assert.equal(f.calls.link, 0);
  assert.equal(f.coordinator().load(7).candidatePath, o.candidatePath);
  completeLate();
  assert.equal((await f.coordinator().run(7)).status, 'linked');
  assert.equal(f.calls.upload, 1);
  assert.equal(f.db.image_path, o.candidatePath);
  assert.equal(f.files.size, 2); // Original plus one candidate, not duplicate candidates.
});

test('absent ambiguous upload stays uncertain even if the original never completes', async () => {
  const f = fixture();
  f.io.upload = async () => { f.calls.upload++; throw new Error('lost response'); };
  const c = f.coordinator(); c.begin(product, 'store', prepared, product.image_path);
  for (let i = 0; i < 3; i++) assert.equal((await f.coordinator().run(7, prepared)).status, 'uncertain');
  assert.equal(f.calls.upload, 1); assert.equal(f.calls.link, 0);
});

test('ambiguous link response is resolved by reading image_path, without another upload/link', async () => {
  const f = fixture(); const link = f.io.link;
  f.io.link = async (...args) => { await link(...args); throw new Error('response lost'); };
  const c = f.coordinator(); c.begin(product, 'store', prepared, product.image_path);
  assert.equal((await c.run(7, prepared)).status, 'uncertain');
  assert.equal((await c.run(7)).status, 'linked');
  assert.equal(f.calls.upload, 1); assert.equal(f.calls.link, 1);
});

test('refresh after upload recovers using metadata only and no local file', async () => {
  const f = fixture(); const c = f.coordinator(); const link = f.io.link;
  c.begin(product, 'store', prepared, product.image_path);
  f.io.link = async () => ({ status: 'uncertain', product: null });
  await c.run(7, prepared);
  const raw = [...f.pending.map.values()][0];
  assert.equal(raw.includes('blob'), false); assert.equal(raw.includes('credentials'), false);
  f.io.link = link;
  assert.equal((await f.coordinator().run(7)).status, 'linked');
  assert.equal(f.calls.upload, 1);
});

test('prepared refresh requires file re-selection; different bytes never upload', async () => {
  const f = fixture(); f.coordinator().begin(product, 'store', prepared, product.image_path);
  const refreshed = f.coordinator();
  assert.equal((await refreshed.run(7)).status, 'uncertain');
  assert.equal((await refreshed.run(7, { ...prepared, sha256: '0'.repeat(64) })).status, 'conflict');
  assert.equal(f.calls.upload, 0);
});

test('another session changing image_path causes conflict without overwriting or deleting', async () => {
  const f = fixture(); const c = f.coordinator(); c.begin(product, 'store', prepared, product.image_path);
  f.db.image_path = '1/7/other-session.webp';
  assert.equal((await c.run(7, prepared)).status, 'conflict');
  assert.equal(f.calls.upload, 0); assert.equal(f.calls.link, 0);
  assert.equal(f.db.image_path, '1/7/other-session.webp'); assert.ok(f.files.has(product.image_path));
});

test('concurrent sessions preserve one winning reference; losing candidate is retained, not deleted', async () => {
  const f = fixture(); const otherStorage = storage();
  const a = f.coordinator();
  const b = createProductImageCoordinator('owner', 1, otherStorage, f.io);
  a.begin(product, 'store', prepared, product.image_path);
  b.begin(product, 'store', { ...prepared, selectionId: '22222222-2222-4222-8222-222222222222' }, product.image_path);
  const results = await Promise.all([a.run(7, prepared), b.run(7, prepared)]);
  assert.equal(results.filter((r) => r.status === 'linked').length, 1);
  assert.equal(results.filter((r) => r.status === 'conflict').length, 1);
  assert.ok(f.files.has(product.image_path));
});

test('double click is refused before a second external call', async () => {
  const f = fixture(); let finish;
  const upload = f.io.upload;
  f.io.upload = (...args) => new Promise((resolve) => { finish = async () => { await upload(...args); resolve(); }; });
  const c = f.coordinator(); c.begin(product, 'store', prepared, product.image_path);
  const first = c.run(7, prepared);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(c.run(7, prepared), /en proceso/);
  await finish(); await first;
  assert.equal(f.calls.upload, 1);
});

test('corrupt/cross-tenant metadata fails closed and never causes a Storage request', async () => {
  const f = fixture(); const c = f.coordinator(); c.begin(product, 'store', prepared, product.image_path);
  const [key, raw] = [...f.pending.map][0];
  f.pending.setItem(key, JSON.stringify({ ...JSON.parse(raw), candidatePath: '2-other/products/7-other/principal.webp' }));
  assert.equal((await c.run(7, prepared)).status, 'uncertain');
  assert.equal(f.calls.upload, 0);
  assert.equal(createProductImageCoordinator('other-owner', 1, f.pending, f.io).load(7), null);
});

test('missing confirmed object is not automatically uploaded again; mismatched object is a conflict', async () => {
  const f = fixture(); const c = f.coordinator();
  const o = c.begin(product, 'store', prepared, product.image_path);
  f.io.link = async () => ({ status: 'uncertain', product: null });
  await c.run(7, prepared);
  f.files.delete(o.candidatePath);
  assert.equal((await c.run(7, prepared)).status, 'uncertain');
  assert.equal(f.calls.upload, 1);
  f.files.set(o.candidatePath, new Blob(['different']));
  assert.equal((await c.run(7, prepared)).status, 'conflict');
  assert.equal(f.calls.upload, 1);
});

test('discarding a pending change removes metadata only, leaving shared or unlinked files intact', async () => {
  const f = fixture(); const c = f.coordinator(); const o = c.begin(product, 'store', prepared, product.image_path);
  f.io.link = async () => ({ status: 'uncertain', product: null });
  await c.run(7, prepared);
  c.discard(7);
  assert.equal(f.pending.map.size, 0);
  assert.ok(f.files.has(o.candidatePath)); assert.ok(f.files.has(product.image_path));
});

test('failure to persist upload intent prevents the external write', async () => {
  const f = fixture(); const c = f.coordinator(); c.begin(product, 'store', prepared, product.image_path);
  const set = f.pending.setItem;
  f.pending.setItem = (key, value) => {
    if (JSON.parse(value).phase === 'uploading') throw new Error('local quota');
    set(key, value);
  };
  assert.equal((await c.run(7, prepared)).status, 'uncertain');
  assert.equal(f.calls.upload, 0); assert.equal(f.calls.link, 0);
});

test('verification outages never trigger another upload', async () => {
  const f = fixture(); const c = f.coordinator(); c.begin(product, 'store', prepared, product.image_path);
  f.io.upload = async () => { f.calls.upload++; throw new Error('lost upload'); };
  f.io.verify = async () => 'unknown';
  assert.equal((await c.run(7, prepared)).status, 'uncertain');
  assert.equal((await c.run(7, prepared)).status, 'uncertain');
  assert.equal(f.calls.upload, 1); assert.equal(f.calls.link, 0);
});

test('unavailable or cross-tenant products cannot cause a file write or expose a product', async () => {
  for (const row of [null, { ...product, store_id: 2 }]) {
    const f = fixture(); const c = f.coordinator(); c.begin(product, 'store', prepared, product.image_path);
    f.io.readProduct = async () => row;
    const result = await c.run(7, prepared);
    assert.equal(result.status, 'uncertain'); assert.equal(result.product, null);
    assert.equal(f.calls.upload, 0); assert.equal(f.calls.link, 0);
  }
});
