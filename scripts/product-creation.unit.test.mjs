import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProductCreationCoordinator, productCreationError } from '../src/services/productCreation.ts';
import { parseProductForm } from '../src/features/products/productForm.ts';

const uuid = '11111111-1111-4111-8111-111111111111';
const input = { name: 'LOCAL', description: 'catalog description', price: 20,
  discount_active: false, discount_price: null, visual_rating: 5,
  category_id: null, available: true };
const product = { id: 1, store_id: 1, ...input, active: true, image_path: null };
const found = { status: 'found', product, replayed: false };
const storage = () => {
  const map = new Map();
  return { map, getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
};
const coordinator = (s, transport, owner = 'owner', store = 1) =>
  createProductCreationCoordinator(owner, store, s, transport, () => uuid);

test('lost response / timeout preserves UUID and retries the exact original input', async () => {
  const s = storage(); const calls = [];
  const c = coordinator(s, async (id, payload) => {
    calls.push([id, payload]);
    if (calls.length === 1) throw new Error('timeout after commit');
    return found;
  });
  await assert.rejects(c.create(input), /timeout/);
  assert.deepEqual([...s.map.values()], [uuid]);
  assert.equal((await c.create(input)).id, 1);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(s.map.size, 0);
});

test('changed payload after uncertain result does not send another request', async () => {
  let calls = 0;
  const c = coordinator(storage(), async () => { calls++; throw new Error('lost'); });
  await assert.rejects(c.create(input));
  await assert.rejects(c.create({ ...input, price: 21 }), /mismos datos/);
  assert.equal(calls, 1);
});

test('double submit is rejected immediately with one transport call', async () => {
  let finish; let calls = 0;
  const c = coordinator(storage(), () => {
    calls++;
    return new Promise((resolve) => { finish = resolve; });
  });
  const first = c.create(input);
  await assert.rejects(c.create(input), /en curso/);
  await assert.rejects(c.recover(), /en curso/);
  assert.equal(calls, 1);
  finish(found);
  assert.equal((await first).id, 1);
});

test('refresh recovers via lookup only; browser persists UUID, not input or secrets', async () => {
  const s = storage();
  const first = coordinator(s, async () => { throw new Error('lost'); });
  await assert.rejects(first.create(input));
  assert.deepEqual([...s.map.values()], [uuid]);
  const calls = [];
  const refreshed = coordinator(s, async (...args) => { calls.push(args); return found; });
  assert.equal((await refreshed.recover()).id, 1);
  assert.deepEqual(calls, [[uuid, null]]);
});

test('not-yet-visible recovery and failed lookup preserve the same pending UUID', async () => {
  const s = storage();
  await assert.rejects(coordinator(s, async () => { throw new Error('lost'); }).create(input));
  const c = coordinator(s, async () => ({ status: 'not_found', product: null }));
  assert.equal(await c.recover(), null);
  assert.deepEqual([...s.map.values()], [uuid]);
  await assert.rejects(coordinator(s, async () => { throw new Error('lookup failed'); }).recover());
  assert.deepEqual([...s.map.values()], [uuid]);
});

test('not_found after refresh then payload conflict explains recovery without changing UUID or storing input', async () => {
  const s = storage();
  await assert.rejects(coordinator(s, async () => { throw new Error('lost response'); }).create(input));
  const requests = [];
  let phase = 'not_found';
  const refreshed = createProductCreationCoordinator('owner', 1, s, async (id, payload) => {
    requests.push([id, payload]);
    if (phase === 'not_found') return { status: 'not_found', product: null };
    if (phase === 'conflict') throw productCreationError({ code: 'PT409', message: 'Conflicto de operacion' });
    return found;
  }, () => { throw new Error('must not generate a replacement UUID'); });
  assert.equal(await refreshed.recover(), null);
  phase = 'conflict';
  await assert.rejects(refreshed.create({ ...input, price: 21 }), (error) => {
    assert.match(error.message, /Puede existir una creacion anterior/);
    assert.match(error.message, /Vuelve a abrir "Nuevo producto"/);
    return true;
  });
  assert.deepEqual([...s.map.values()], [uuid]);
  assert.deepEqual(requests.map(([id]) => id), [uuid, uuid]);
  phase = 'found';
  assert.equal((await refreshed.recover()).id, product.id);
  assert.deepEqual(requests.at(-1), [uuid, null]);
  assert.equal(s.map.size, 0);
  assert.equal(productCreationError({ code: '42501', message: 'Operacion no autorizada' }).message, 'Operacion no autorizada');
});

test('deleted result never automatically creates again', async () => {
  let calls = 0;
  const c = coordinator(storage(), async () => { calls++; return { status: 'deleted', product: null }; });
  await assert.rejects(c.create(input), /eliminado/);
  await assert.rejects(c.create(input), /eliminado/);
  assert.equal(calls, 1);
});

test('pending operations are isolated by owner and store', async () => {
  const s = storage();
  await assert.rejects(coordinator(s, async () => { throw new Error('lost'); }).create(input));
  let calls = 0;
  const lookup = async () => { calls++; return found; };
  assert.equal(await coordinator(s, lookup, 'other-owner').recover(), null);
  assert.equal(await coordinator(s, lookup, 'owner', 2).recover(), null);
  assert.equal(calls, 0);
});

test('storage failure and invalid recovered tenant fail closed', async () => {
  let calls = 0;
  const c = coordinator({ getItem: () => null, setItem: () => { throw new Error('storage unavailable'); }, removeItem() {} },
    async () => { calls++; return found; });
  await assert.rejects(c.create(input), /storage unavailable/);
  assert.equal(calls, 0);
  const s = storage();
  await assert.rejects(coordinator(s, async () => ({ ...found, product: { ...product, store_id: 2 } })).create(input), /confirmar/);
  assert.equal(s.map.size, 1);
});

const form = { name: ' LOCAL ', description: '', price: '20', discount_active: false,
  discount_price: '', visual_rating: '5', category_id: '', available: true };

test('form rejects empty or whitespace-only price but accepts an intentional zero', () => {
  for (const price of ['', '   ', '\t\n']) {
    assert.ok('error' in parseProductForm({ ...form, price }, [], 1));
  }
  for (const price of ['0', '0.00', ' 0 ']) {
    const result = parseProductForm({ ...form, price }, [], 1);
    assert.ok('value' in result);
    assert.equal(result.value.price, 0);
  }
});

test('form rejects discounts beyond SQL precision/range, including inactive offers', () => {
  for (const patch of [{ discount_price: '1.001' }, { discount_price: '1e-3' },
    { price: '100000001', discount_price: '100000000' },
    { discount_active: true, discount_price: '' }, { discount_price: '20' }]) {
    assert.ok('error' in parseProductForm({ ...form, ...patch }, [], 1));
  }
  for (const discount of ['1.1', '0.29', '1e-2']) {
    const result = parseProductForm({ ...form, discount_price: discount }, [], 1);
    assert.ok('value' in result);
    assert.equal(result.value.discount_price, Number(discount));
  }
});

test('form keeps numeric price semantics and one-decimal rating normalization', () => {
  const result = parseProductForm({ ...form, price: '1.001', visual_rating: '4.55' }, [], 1);
  assert.ok('value' in result);
  assert.equal(result.value.price, 1.001); // products.price is numeric, not numeric(10,2).
  assert.equal(result.value.visual_rating, 4.6);
  for (const patch of [{ price: '-1' }, { price: 'Infinity' },
    { visual_rating: '5.01' }, { visual_rating: 'NaN' }]) {
    assert.ok('error' in parseProductForm({ ...form, ...patch }, [], 1));
  }
});

test('form category must be a UUID in the current store list; no category is NULL', () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.equal(parseProductForm(form, [], 1).value.category_id, null);
  assert.equal(parseProductForm({ ...form, category_id: id }, [{ id, store_id: 1 }], 1).value.category_id, id);
  assert.ok('error' in parseProductForm({ ...form, category_id: id }, [{ id, store_id: 2 }], 1));
  assert.ok('error' in parseProductForm({ ...form, category_id: id }, [], 1));
  assert.ok('error' in parseProductForm({ ...form, category_id: 'invalid' }, [], 1));
});

test('form enforces SQL name/description length limits before submitting', () => {
  assert.ok('error' in parseProductForm({ ...form, name: 'x'.repeat(121) }, [], 1));
  assert.ok('error' in parseProductForm({ ...form, description: 'x'.repeat(501) }, [], 1));
  assert.ok('value' in parseProductForm({ ...form, name: 'x'.repeat(120), description: 'x'.repeat(500) }, [], 1));
});
