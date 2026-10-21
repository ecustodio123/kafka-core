import { expect, test, type Page } from '@playwright/test'
import type { Product } from '../../src/types/database'

const original = { id: 7, store_id: 1, name: 'LOCAL PRODUCT', description: '', price: 20,
  discount_active: false, discount_price: null, visual_rating: 5, category_id: null,
  image_path: '1/7/image.webp', available: true, active: true, created_at: '2026-10-17T00:00:00Z' } satisfies Product
const smallWebp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64')

async function png(page: Page, width = 64, height = 32) {
  const data = await page.evaluate(async ({ width, height }) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
    canvas.getContext('2d')!.fillRect(0, 0, width, height)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
    return Array.from(new Uint8Array(await blob.arrayBuffer()))
  }, { width, height })
  return Buffer.from(data)
}

async function harness(page: Page, initial: Partial<Product> = {}) {
  const db = { product: { ...original, ...initial } }
  const files = new Map<string, Buffer>([[original.image_path, smallWebp]])
  const pendingUploads = new Map<string, Buffer>()
  const calls = { create: 0, metadata: 0, upload: 0, link: 0, productReads: 0, remove: 0, external: 0, uploadPaths: [] as string[] }
  const behavior = { failLink: 0, failUpload: 0, failMetadata: 0, loseUpload: false, loseLink: false, changeAfterUpload: false }
  await page.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url())
    if (url.origin !== 'http://127.0.0.1:5197') { calls.external++; return route.abort() }
    const respond = (json: unknown, status = 200) => route.fulfill({ status, json })
    if (url.pathname === '/functions/v1/catalog-delete') {
      expect(request.postDataJSON().action).toBe('cleanup')
      return respond({ deleted: false, cleanup: 'complete' })
    }
    if (request.method() === 'DELETE' || request.method() === 'PUT') { calls.remove++; return route.abort() }
    if (url.pathname === '/rest/v1/categories') return respond([])
    if (url.pathname === '/rest/v1/rpc/create_product_idempotent') {
      calls.create++
      const body = request.postDataJSON()
      db.product = { ...original, ...body.p_input, id: 8, image_path: null }
      return respond({ status: 'found', product: db.product, replayed: false })
    }
    if (url.pathname === '/rest/v1/products') {
      if (request.method() === 'GET') {
        if (url.searchParams.has('id')) calls.productReads++
        return respond([db.product])
      }
      const patch = request.postDataJSON()
      if ('image_path' in patch) {
        expect(Object.keys(patch)).toEqual(['image_path'])
        calls.link++
        expect(url.searchParams.get('store_id')).toBe('eq.1')
        expect(url.searchParams.get('id')).toBe(`eq.${db.product.id}`)
        if (behavior.failLink-- > 0) return respond({ code: 'XX000', message: 'LOCAL link failure' }, 500)
        const expected = url.searchParams.get('image_path')
        if (expected !== (db.product.image_path === null ? 'is.null' : `eq.${db.product.image_path}`)) return respond([])
        Object.assign(db.product, patch)
        if (behavior.loseLink) { behavior.loseLink = false; return route.abort('failed') }
      } else {
        calls.metadata++
        if (behavior.failMetadata-- > 0) return respond({ code: 'XX000', message: 'LOCAL metadata failure' }, 500)
        Object.assign(db.product, patch)
      }
      return respond(request.headers().accept?.includes('vnd.pgrst.object') ? db.product : [db.product])
    }
    if (url.pathname.startsWith('/storage/v1/object/')) {
      let path = decodeURIComponent(url.pathname.replace('/storage/v1/object/', ''))
      path = path.replace(/^public\//, '').replace(/^product-images\//, '')
      if (request.method() === 'POST') {
        calls.upload++
        calls.uploadPaths.push(path)
        expect(request.headers()['x-upsert']).toBe('false')
        if (files.has(path)) return respond({ code: 'ResourceAlreadyExists', message: 'exists' }, 409)
        const body = request.postDataBuffer()!
        const form = await new Response(new Uint8Array(body).buffer, {
          headers: { 'Content-Type': request.headers()['content-type'] },
        }).formData()
        const file = [...form.values()].find((value) => value instanceof Blob) as Blob
        const bytes = Buffer.from(await file.arrayBuffer())
        if (behavior.failUpload-- > 0) {
          pendingUploads.set(path, bytes)
          return respond({ code: 'InternalError', message: 'LOCAL ambiguous upload response' }, 500)
        }
        files.set(path, bytes)
        if (behavior.changeAfterUpload) db.product.image_path = '1/7/other-session.webp'
        if (behavior.loseUpload) { behavior.loseUpload = false; return route.abort('failed') }
        return respond({ Key: `product-images/${path}`, Id: 'local-object' })
      }
      if (!files.has(path)) return respond({ code: 'NoSuchKey', message: 'missing' }, 404)
      return route.fulfill({ status: 200, body: files.get(path)!, contentType: 'image/webp' })
    }
    return route.continue()
  })
  await page.goto('/tests/product-images/browser.html')
  await expect(page.getByText('LOCAL PRODUCT', { exact: true })).toBeVisible()
  return { db, files, pendingUploads, calls, behavior }
}

test('real canvas conversion bounds product output and preserves category default dimensions', async ({ page }) => {
  await harness(page)
  const bytes = Array.from(await png(page, 2800, 1800))
  const result = await page.evaluate(async (bytes) => {
    const api = (window as unknown as { imageTests: {
      prepareProductImage: (file: File) => Promise<{ blob: Blob }>
      convertImageToWebp: (file: File) => Promise<Blob>
    } }).imageTests
    const source = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
    const canvas = document.createElement('canvas'); canvas.width = source.width; canvas.height = source.height
    canvas.getContext('2d')!.drawImage(source, 0, 0); source.close()
    const results = []
    for (const mime of ['image/png', 'image/jpeg', 'image/webp']) {
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), mime))
      const file = new File([blob], 'local-image', { type: mime })
      const prepared = await api.prepareProductImage(file)
      const product = await createImageBitmap(prepared.blob)
      const category = await createImageBitmap(await api.convertImageToWebp(file))
      results.push({ type: prepared.blob.type, width: product.width, height: product.height,
        categoryWidth: category.width, categoryHeight: category.height })
      product.close(); category.close()
    }
    canvas.width = 0; canvas.height = 0
    return results
  }, bytes)
  expect(result).toHaveLength(3)
  for (const image of result) {
    expect(image.type).toBe('image/webp'); expect(image.width).toBe(2048)
    expect(image.categoryWidth).toBe(2800); expect(image.categoryHeight).toBe(1800)
  }
})

for (const kind of ['invalid', 'conversion-failure', 'dimension-limit', 'mime-mismatch', 'hostile-header']) {
  test(`${kind}: real form performs zero writes`, async ({ page }) => {
    const f = await harness(page)
    await page.getByRole('button', { name: 'Nuevo producto' }).click()
    await page.getByLabel('Nombre', { exact: true }).fill('INVALID IMAGE TEST')
    await page.getByLabel('Precio', { exact: true }).fill('10')
    const buffer = kind === 'invalid' ? Buffer.from('not PNG')
      : kind === 'hostile-header' ? Buffer.alloc(512 * 1024) : await png(page)
    if (kind === 'dimension-limit') buffer.writeUInt32BE(10000, 16)
    if (kind === 'hostile-header') { buffer[0] = 255; buffer[1] = 216 }
    await page.locator('#product-image').setInputFiles({ name: 'bad.png',
      mimeType: kind === 'mime-mismatch' || kind === 'hostile-header' ? 'image/jpeg' : 'image/png',
      buffer: kind === 'conversion-failure' ? buffer.subarray(0, 33) : buffer })
    expect(await page.evaluate(() => 1 + 1)).toBe(2) // Header parsing cannot freeze the UI thread.
    await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Guardar', exact: true }).click()
    await expect(page.getByText('Selecciona una imagen valida o quita la seleccion antes de guardar.')).toBeVisible()
    expect(f.calls.create + f.calls.metadata + f.calls.upload + f.calls.link).toBe(0)
    expect(f.calls.external).toBe(0)
  })
}

for (const recovery of ['same-form', 'refresh', 'close-form'] as const) {
  test(`link failure retries without another upload, recovery=${recovery}`, async ({ page }, testInfo) => {
    const f = await harness(page); f.behavior.failLink = 1
    await page.getByRole('button', { name: 'Editar producto' }).click()
    await page.locator('#product-image').setInputFiles({ name: 'local.png', mimeType: 'image/png', buffer: await png(page) })
    await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Guardar', exact: true }).click()
    await expect(page.getByText('Imagen pendiente: Verificacion pendiente')).toBeVisible()
    expect(f.db.product.image_path).toBe(original.image_path)
    expect(f.calls.upload).toBe(1)
    if (recovery === 'same-form') {
      await page.getByRole('status').filter({ hasText: 'Imagen pendiente:' }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: testInfo.outputPath('pending-image-desktop.png') })
      await page.setViewportSize({ width: 375, height: 900 })
      await page.getByRole('status').filter({ hasText: 'Imagen pendiente:' }).scrollIntoViewIfNeeded()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.screenshot({ path: testInfo.outputPath('pending-image-mobile.png') })
    }
    if (recovery === 'refresh') {
      await page.reload()
      await page.getByRole('button', { name: 'Editar producto' }).click()
      await expect(page.getByText('Imagen pendiente: Verificacion pendiente')).toBeVisible()
    }
    if (recovery === 'close-form') {
      await page.getByRole('button', { name: 'Cerrar formulario' }).click()
      await page.getByRole('button', { name: 'Editar producto' }).click()
      await expect(page.getByText('Imagen pendiente: Verificacion pendiente')).toBeVisible()
    }
    await page.getByRole('button', { name: 'Reintentar imagen' }).click()
    await expect(page.getByText('Imagen vinculada correctamente.')).toBeVisible()
    expect(f.calls.upload).toBe(1); expect(f.calls.link).toBe(2)
    expect(f.calls.metadata).toBe(0)
    expect(f.files.has(original.image_path)).toBe(true)
    expect(f.calls.remove).toBe(0); expect(f.calls.external).toBe(0)
  })
}

for (const field of ['loseUpload', 'loseLink'] as const) {
  test(`${field}: SDK resolves ambiguous response without another candidate`, async ({ page }) => {
    const f = await harness(page); f.behavior[field] = true
    await page.getByRole('button', { name: 'Editar producto' }).click()
    await page.locator('#product-image').setInputFiles({ name: 'local.png', mimeType: 'image/png', buffer: await png(page) })
    await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Guardar', exact: true }).click()
    await expect(page.getByText('Producto actualizado correctamente.')).toBeVisible()
    expect(f.calls.upload).toBe(1); expect(f.calls.link).toBe(1)
    expect(f.files.size).toBe(2); expect(f.calls.remove).toBe(0)
  })
}

test('concurrent change after upload causes conflict without overwriting the other selection', async ({ page }) => {
  const f = await harness(page); f.behavior.changeAfterUpload = true
  await page.getByRole('button', { name: 'Editar producto' }).click()
  await page.locator('#product-image').setInputFiles({ name: 'local.png', mimeType: 'image/png', buffer: await png(page) })
  await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByText('Imagen pendiente: Conflicto')).toBeVisible()
  expect(f.db.product.image_path).toBe('1/7/other-session.webp'); expect(f.calls.link).toBe(0)
  expect(f.calls.metadata).toBe(0)
  await page.reload()
  await page.getByRole('button', { name: 'Editar producto' }).click()
  await page.getByRole('button', { name: 'Reintentar imagen' }).click()
  await expect(page.getByText('Imagen pendiente: Conflicto')).toBeVisible()
  expect(f.calls.upload).toBe(1); expect(f.calls.remove).toBe(0)
})

test('2A creation keeps its ID across failed image linking; retry does not create another product', async ({ page }) => {
  const f = await harness(page); f.behavior.failLink = 1
  await page.getByRole('button', { name: 'Nuevo producto' }).click()
  await page.getByLabel('Nombre', { exact: true }).fill('CREATED WITH IMAGE')
  await page.getByLabel('Precio', { exact: true }).fill('10')
  await page.locator('#product-image').setInputFiles({ name: 'local.png', mimeType: 'image/png', buffer: await png(page) })
  await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
  await page.evaluate(() => { const form = document.querySelector('form')!; form.requestSubmit(); form.requestSubmit() })
  await expect(page.getByText('Imagen pendiente: Verificacion pendiente')).toBeVisible()
  expect(f.calls.create).toBe(1); expect(f.db.product.id).toBe(8)
  await page.getByRole('button', { name: 'Reintentar imagen' }).click()
  await expect(page.getByText('Imagen vinculada correctamente.')).toBeVisible()
  expect(f.calls.create).toBe(1); expect(f.calls.upload).toBe(1); expect(f.calls.metadata).toBe(0)
})

test('refresh and re-selection after an ambiguous upload never reupload; late completion recovers', async ({ page }) => {
  const f = await harness(page); f.behavior.failUpload = 1
  const buffer = await png(page)
  await page.getByRole('button', { name: 'Editar producto' }).click()
  await page.locator('#product-image').setInputFiles({ name: 'local.png', mimeType: 'image/png', buffer })
  await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByText('Imagen pendiente: Verificacion pendiente')).toBeVisible()
  expect(f.calls.upload).toBe(1)
  await page.reload()
  await page.getByRole('button', { name: 'Editar producto' }).click()
  await page.getByRole('button', { name: 'Reintentar imagen', exact: true }).click()
  await expect(page.getByText(/La subida anterior puede seguir en curso/)).toBeVisible()
  expect(f.calls.upload).toBe(1)
  await page.locator('#product-image').setInputFiles({ name: 'local.png', mimeType: 'image/png', buffer })
  await expect(page.getByRole('button', { name: 'Reintentar imagen', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Reintentar imagen', exact: true }).click()
  await expect(page.getByText(/La subida anterior puede seguir en curso/)).toBeVisible()
  expect(f.calls.upload).toBe(1); expect(f.calls.link).toBe(0)
  for (const [path, bytes] of f.pendingUploads) f.files.set(path, bytes)
  await page.getByRole('button', { name: 'Reintentar imagen', exact: true }).click()
  await expect(page.getByText('Imagen vinculada correctamente.')).toBeVisible()
  expect(f.calls.upload).toBe(1)
  expect(new Set(f.calls.uploadPaths).size).toBe(1)
  expect(f.files.size).toBe(2); expect(f.calls.remove).toBe(0)
})

test('clearing the selection resets the native file input and permits re-selecting the same pending image', async ({ page }) => {
  const f = await harness(page); f.behavior.failUpload = 1
  const file = { name: 'local.png', mimeType: 'image/png', buffer: await png(page) }
  await page.getByRole('button', { name: 'Editar producto' }).click()
  await page.locator('#product-image').setInputFiles(file)
  await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByText('Imagen pendiente: Verificacion pendiente')).toBeVisible()
  await page.getByRole('button', { name: 'Quitar seleccion', exact: true }).click()
  expect(await page.locator('#product-image').evaluate((node: HTMLInputElement) => node.files?.length)).toBe(0)
  await page.locator('#product-image').setInputFiles(file)
  await expect(page.getByRole('button', { name: 'Reintentar imagen', exact: true })).toBeEnabled()
  for (const [path, bytes] of f.pendingUploads) f.files.set(path, bytes)
  await page.getByRole('button', { name: 'Reintentar imagen', exact: true }).click()
  await expect(page.getByText('Imagen vinculada correctamente.')).toBeVisible()
  expect(new Set(f.calls.uploadPaths).size).toBe(1)
  expect(f.calls.remove).toBe(0)
})

test('invalid replacement preserves the previous prepared selection and its identity', async ({ page }) => {
  const f = await harness(page)
  await page.getByRole('button', { name: 'Editar producto' }).click()
  await page.locator('#product-image').setInputFiles({ name: 'valid.png', mimeType: 'image/png', buffer: await png(page) })
  await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
  await page.locator('#product-image').setInputFiles({ name: 'invalid.png', mimeType: 'image/png', buffer: Buffer.from('invalid') })
  await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
  await expect(page.getByText('valid.png', { exact: true })).toBeVisible()
  expect(f.calls.upload + f.calls.metadata).toBe(0)
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByText('Producto actualizado correctamente.')).toBeVisible()
  expect(f.calls.upload).toBe(1); expect(f.calls.link).toBe(1)
})

for (const mode of ['create', 'edit'] as const) {
for (const changeData of [false, true]) {
test(`images.begin failure after ${mode}: retry ${changeData ? 'saves real edits' : 'does not repeat metadata writes'}`, async ({ page }) => {
  const f = await harness(page)
  await page.getByRole('button', { name: mode === 'create' ? 'Nuevo producto' : 'Editar producto' }).click()
  await page.getByLabel('Nombre', { exact: true }).fill('BEGIN FAILURE TEST')
  await page.getByLabel('Precio', { exact: true }).fill('10')
  await page.locator('#product-image').setInputFiles({ name: 'valid.png', mimeType: 'image/png', buffer: await png(page) })
  await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith('kafka.product-image.')) {
        Storage.prototype.setItem = setItem
        throw new DOMException('LOCAL metadata unavailable', 'QuotaExceededError')
      }
      return setItem.call(this, key, value)
    }
  })
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByText(/Producto guardado; falta completar la imagen/)).toBeVisible()
  const productId = mode === 'create' ? 8 : 7
  expect(f.calls.create).toBe(mode === 'create' ? 1 : 0)
  expect(f.calls.metadata).toBe(mode === 'edit' ? 1 : 0)
  expect(f.db.product.id).toBe(productId)
  expect(f.calls.upload + f.calls.link).toBe(0)
  if (changeData) {
    await page.getByLabel('Nombre', { exact: true }).fill('EDITED AFTER IMAGE FAILURE')
    await page.getByLabel('Precio', { exact: true }).fill('15')
  } else {
    // Equivalent normalized data must not count as an edit.
    await page.getByLabel('Nombre', { exact: true }).fill('  BEGIN FAILURE TEST  ')
    await page.getByLabel('Precio', { exact: true }).fill('10.00')
  }
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByText('Producto actualizado correctamente.')).toBeVisible()
  expect(f.calls.create).toBe(mode === 'create' ? 1 : 0)
  expect(f.calls.metadata).toBe((mode === 'edit' ? 1 : 0) + (changeData ? 1 : 0))
  expect(f.db.product.id).toBe(productId)
  expect(f.db.product.name).toBe(changeData ? 'EDITED AFTER IMAGE FAILURE' : 'BEGIN FAILURE TEST')
  expect(f.db.product.price).toBe(changeData ? 15 : 10)
  expect(f.calls.upload).toBe(1); expect(f.calls.link).toBe(1)
})
}
}

test('failed data edit after images.begin failure is not misreported as an image failure or cached as saved', async ({ page }) => {
  const f = await harness(page)
  await page.getByRole('button', { name: 'Nuevo producto' }).click()
  await page.getByLabel('Nombre', { exact: true }).fill('BEGIN FAILURE TEST')
  await page.getByLabel('Precio', { exact: true }).fill('10')
  await page.locator('#product-image').setInputFiles({ name: 'valid.png', mimeType: 'image/png', buffer: await png(page) })
  await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith('kafka.product-image.')) {
        Storage.prototype.setItem = setItem
        throw new DOMException('LOCAL metadata unavailable', 'QuotaExceededError')
      }
      return setItem.call(this, key, value)
    }
  })
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByText(/Producto guardado; falta completar la imagen/)).toBeVisible()
  await page.getByLabel('Precio', { exact: true }).fill('25')
  f.behavior.failMetadata = 1
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByText(/No se pudieron guardar los datos del producto/)).toBeVisible()
  await expect(page.getByText(/Producto guardado; falta completar la imagen/)).toHaveCount(0)
  expect(f.calls.upload + f.calls.link).toBe(0)
  expect(f.db.product.price).toBe(10)
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByText('Producto actualizado correctamente.')).toBeVisible()
  expect(f.calls.create).toBe(1); expect(f.calls.metadata).toBe(2)
  expect(f.db.product.id).toBe(8); expect(f.db.product.price).toBe(25)
  expect(f.calls.upload).toBe(1); expect(f.calls.link).toBe(1)
})

test('invalid replacement of a pending selection retains its hash, UUID and retryable file', async ({ page }) => {
  const f = await harness(page); f.behavior.failLink = 1
  await page.getByRole('button', { name: 'Editar producto' }).click()
  await page.locator('#product-image').setInputFiles({ name: 'retained.png', mimeType: 'image/png', buffer: await png(page) })
  await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByText('Imagen pendiente: Verificacion pendiente')).toBeVisible()
  const metadata = () => page.evaluate(() => Object.entries(sessionStorage).find(([key]) => key.startsWith('kafka.product-image.'))?.[1])
  const before = await metadata()
  expect(before).toBeTruthy()
  await page.locator('#product-image').setInputFiles({ name: 'invalid.png', mimeType: 'image/png', buffer: Buffer.from('invalid') })
  await expect(page.getByRole('button', { name: 'Reintentar imagen', exact: true })).toBeEnabled()
  await expect(page.getByText('retained.png', { exact: true })).toBeVisible()
  expect(await metadata()).toBe(before)
  await page.getByRole('button', { name: 'Reintentar imagen', exact: true }).click()
  await expect(page.getByText('Imagen vinculada correctamente.')).toBeVisible()
  expect(f.calls.upload).toBe(1); expect(f.calls.link).toBe(2)
})

for (const mode of ['image', 'metadata', 'both'] as const) {
  test(`edit ${mode}: sends only necessary writes and retains image verification reads`, async ({ page }) => {
    const f = await harness(page)
    await page.getByRole('button', { name: 'Editar producto' }).click()
    if (mode !== 'image') await page.getByLabel('Precio', { exact: true }).fill('25')
    if (mode !== 'metadata') {
      await page.locator('#product-image').setInputFiles({ name: 'valid.png', mimeType: 'image/png', buffer: await png(page) })
    }
    await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Guardar', exact: true }).click()
    await expect(page.getByText('Producto actualizado correctamente.')).toBeVisible()
    expect(f.calls.metadata).toBe(mode === 'image' ? 0 : 1)
    expect(f.calls.upload).toBe(mode === 'metadata' ? 0 : 1)
    expect(f.calls.link).toBe(mode === 'metadata' ? 0 : 1)
    expect(f.calls.productReads).toBe(mode === 'metadata' ? 0 : 2)
    expect(f.db.product.price).toBe(mode === 'image' ? 20 : 25)
    expect(f.calls.create + f.calls.remove + f.calls.external).toBe(0)
  })
}

test('equivalent normalized form preserves stored NULLs and does not write metadata', async ({ page }) => {
  const f = await harness(page, { description: null, visual_rating: null })
  await page.getByRole('button', { name: 'Editar producto' }).click()
  await page.getByLabel('Nombre', { exact: true }).fill('  LOCAL PRODUCT  ')
  await page.getByLabel('Descripcion', { exact: true }).fill('   ')
  await page.getByLabel('Precio', { exact: true }).fill('20.00')
  await page.locator('#product-rating').fill('5.0')
  await page.locator('#product-image').setInputFiles({ name: 'valid.png', mimeType: 'image/png', buffer: await png(page) })
  await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByText('Producto actualizado correctamente.')).toBeVisible()
  expect(f.calls.metadata).toBe(0); expect(f.calls.upload).toBe(1); expect(f.calls.link).toBe(1)
  expect(f.db.product.description).toBeNull(); expect(f.db.product.visual_rating).toBeNull()
  expect(f.db.product.category_id).toBeNull(); expect(f.db.product.discount_price).toBeNull()
})

for (const discount_active of [false, true]) {
  test(`equivalent discount/rating formatting with discount_active=${discount_active} does not write`, async ({ page }) => {
    const f = await harness(page, { discount_active, discount_price: 15, visual_rating: 4.5 })
    await page.getByRole('button', { name: 'Editar producto' }).click()
    if (!discount_active) await page.getByRole('checkbox', { name: 'Sin oferta' }).check()
    await page.getByLabel('Precio promocional', { exact: true }).fill('15.00')
    if (!discount_active) await page.getByRole('checkbox', { name: 'Oferta activa' }).uncheck()
    await page.locator('#product-rating').fill('4.50')
    await page.getByRole('button', { name: 'Guardar', exact: true }).click()
    await expect(page.getByText('Producto actualizado correctamente.')).toBeVisible()
    expect(f.calls.metadata + f.calls.upload + f.calls.link + f.calls.create).toBe(0)
    expect(f.db.product.discount_active).toBe(discount_active); expect(f.db.product.discount_price).toBe(15)
  })
}

test('changing metadata and restoring its initial values does not write', async ({ page }) => {
  const f = await harness(page)
  await page.getByRole('button', { name: 'Editar producto' }).click()
  await page.getByLabel('Nombre', { exact: true }).fill('TEMPORARY CHANGE')
  await page.getByLabel('Precio', { exact: true }).fill('25')
  await page.getByLabel('Nombre', { exact: true }).fill(original.name)
  await page.getByLabel('Precio', { exact: true }).fill('20.00')
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByText('Producto actualizado correctamente.')).toBeVisible()
  expect(f.calls.metadata + f.calls.upload + f.calls.link + f.calls.create).toBe(0)
})

test('image-only save preserves concurrent metadata edits from another session', async ({ page }) => {
  const f = await harness(page)
  await page.getByRole('button', { name: 'Editar producto' }).click()
  Object.assign(f.db.product, { name: 'OTHER SESSION', price: 35, description: 'Remote edit', available: false })
  await page.locator('#product-image').setInputFiles({ name: 'valid.png', mimeType: 'image/png', buffer: await png(page) })
  await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByText('Producto actualizado correctamente.')).toBeVisible()
  expect(f.calls.metadata).toBe(0); expect(f.calls.upload).toBe(1); expect(f.calls.link).toBe(1)
  expect(f.db.product).toMatchObject({ name: 'OTHER SESSION', price: 35, description: 'Remote edit', available: false })
})

test('image-only images.begin failure retries without INSERT or metadata UPDATE, then permits a real edit', async ({ page }) => {
  const f = await harness(page)
  await page.getByRole('button', { name: 'Editar producto' }).click()
  await page.locator('#product-image').setInputFiles({ name: 'valid.png', mimeType: 'image/png', buffer: await png(page) })
  await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith('kafka.product-image.')) {
        Storage.prototype.setItem = setItem
        throw new DOMException('LOCAL metadata unavailable', 'QuotaExceededError')
      }
      return setItem.call(this, key, value)
    }
  })
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByText(/Producto guardado; falta completar la imagen/)).toBeVisible()
  expect(f.calls.create + f.calls.metadata + f.calls.upload + f.calls.link).toBe(0)
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByText('Producto actualizado correctamente.')).toBeVisible()
  expect(f.calls.create + f.calls.metadata).toBe(0)
  expect(f.calls.upload).toBe(1); expect(f.calls.link).toBe(1)
  await page.getByRole('button', { name: 'Editar producto' }).click()
  await page.getByLabel('Precio', { exact: true }).fill('30')
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByText('Producto actualizado correctamente.')).toBeVisible()
  expect(f.calls.metadata).toBe(1); expect(f.db.product.price).toBe(30)
  expect(f.calls.upload).toBe(1); expect(f.calls.link).toBe(1)
})

test('failed metadata save does not advance the baseline or upload an image', async ({ page }) => {
  const f = await harness(page); f.behavior.failMetadata = 1
  await page.getByRole('button', { name: 'Editar producto' }).click()
  await page.getByLabel('Precio', { exact: true }).fill('25')
  await page.locator('#product-image').setInputFiles({ name: 'valid.png', mimeType: 'image/png', buffer: await png(page) })
  await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByText(/No se pudieron guardar los datos del producto/)).toBeVisible()
  expect(f.calls.metadata).toBe(1); expect(f.db.product.price).toBe(20)
  expect(f.calls.upload + f.calls.link).toBe(0)
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByText('Producto actualizado correctamente.')).toBeVisible()
  expect(f.calls.metadata).toBe(2); expect(f.db.product.price).toBe(25)
  expect(f.calls.upload).toBe(1); expect(f.calls.link).toBe(1)
})
