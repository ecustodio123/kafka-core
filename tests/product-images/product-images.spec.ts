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

async function harness(page: Page, initial: Partial<Product> = {}, catalogSize = 1) {
  const db = { product: { ...original, ...initial } }
  const files = new Map<string, Buffer>([[original.image_path, smallWebp]])
  const pendingUploads = new Map<string, Buffer>()
  const calls = { create: 0, metadata: 0, upload: 0, link: 0, productReads: 0, remove: 0, external: 0, uploadPaths: [] as string[] }
  const behavior = { failLink: 0, failUpload: 0, failMetadata: 0, loseUpload: false, loseLink: false, changeAfterUpload: false, cleanupPending: false, cleanupError: false }
  await page.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url())
    if (url.origin !== 'http://127.0.0.1:5197') { calls.external++; return route.abort() }
    const respond = (json: unknown, status = 200) => route.fulfill({ status, json })
    if (url.pathname === '/functions/v1/catalog-delete') {
      expect(request.postDataJSON().action).toBe('cleanup')
      if (behavior.cleanupError) return respond({ error: 'LOCAL private cleanup error' }, 503)
      return respond({ deleted: false, cleanup: behavior.cleanupPending ? 'pending' : 'complete' })
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
        return respond(url.searchParams.has('id') ? [db.product] : Array.from({ length: catalogSize }, (_, index) =>
          index === 0 ? db.product : { ...db.product, id: original.id + index, name: `LOCAL PRODUCT ${index + 1}` }))
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

test('create draft survives reload, asks to reselect image and clears after successful save', async ({ page }) => {
  const f = await harness(page)
  await page.getByRole('button', { name: 'Nuevo producto', exact: true }).click()
  await page.getByLabel('Nombre', { exact: true }).fill('MOBILE DRAFT')
  await page.getByLabel('Descripcion', { exact: true }).fill('Texto antes de abrir la galeria')
  await page.getByLabel('Precio', { exact: true }).fill('25.50')
  await page.locator('#product-image').setInputFiles({ name: 'mobile.png', mimeType: 'image/png', buffer: await png(page) })
  await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
  await page.reload()
  await page.getByRole('button', { name: 'Recuperar borrador', exact: true }).click()
  await expect(page.getByLabel('Nombre', { exact: true })).toHaveValue('MOBILE DRAFT')
  await expect(page.getByRole('textbox', { name: 'Descripcion', exact: true })).toHaveValue('Texto antes de abrir la galeria')
  await expect(page.getByLabel('Precio', { exact: true })).toHaveValue('25.50')
  await expect(page.getByText(/Selecciona nuevamente la imagen pendiente/)).toBeVisible()
  expect(f.calls.create + f.calls.metadata + f.calls.upload).toBe(0)
  await page.getByRole('button', { name: 'Quitar seleccion', exact: true }).click()
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByText('Producto creado correctamente.')).toBeVisible()
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('kafka.product-draft.')))).toEqual([])
  expect(f.calls.create).toBe(1)
})

test('empty file selection preserves the valid image and allows selecting the same file again', async ({ page }) => {
  const f = await harness(page)
  await page.getByRole('button', { name: 'Editar producto', exact: true }).click()
  const file = { name: 'retained-mobile.png', mimeType: 'image/png', buffer: await png(page) }
  await page.locator('#product-image').setInputFiles(file)
  await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
  await page.locator('#product-image').setInputFiles([])
  await expect(page.getByText(file.name, { exact: true })).toBeVisible()
  await page.locator('#product-image').setInputFiles(file)
  await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByText('Producto actualizado correctamente.')).toBeVisible()
  expect(f.calls.upload).toBe(1); expect(f.calls.link).toBe(1); expect(f.calls.metadata).toBe(0)
})

test('edit draft never overrides a product changed since the draft baseline', async ({ page }) => {
  const f = await harness(page)
  await page.getByRole('button', { name: 'Editar producto', exact: true }).click()
  await page.getByLabel('Nombre', { exact: true }).fill('LOCAL UNSAVED EDIT')
  f.db.product.name = 'NEW SERVER VALUE'
  await page.reload()
  await page.getByRole('button', { name: 'Recuperar borrador', exact: true }).click()
  await expect(page.getByText(/El producto cambio desde el borrador/)).toBeVisible()
  await expect(page.getByLabel('Nombre', { exact: true })).toHaveCount(0)
  expect(f.calls.metadata + f.calls.upload + f.calls.create).toBe(0)
  await page.getByRole('button', { name: 'Descartar borrador', exact: true }).click()
  await page.getByRole('button', { name: 'Editar producto', exact: true }).click()
  await expect(page.getByLabel('Nombre', { exact: true })).toHaveValue('NEW SERVER VALUE')
})

test('edit draft restores after remount without leaking into another product', async ({ page }) => {
  const f = await harness(page, {}, 2)
  await page.getByRole('button', { name: 'Editar producto', exact: true }).first().click()
  await page.getByLabel('Nombre', { exact: true }).fill('RECOVERABLE EDIT')
  await page.getByLabel('Precio', { exact: true }).fill('29')
  await page.reload()
  await page.getByRole('button', { name: 'Editar producto', exact: true }).nth(1).click()
  await expect(page.getByLabel('Nombre', { exact: true })).toHaveValue('LOCAL PRODUCT 2')
  await page.getByRole('button', { name: 'Cerrar formulario', exact: true }).click()
  await page.getByRole('button', { name: 'Editar producto', exact: true }).first().click()
  await expect(page.getByLabel('Nombre', { exact: true })).toHaveValue('RECOVERABLE EDIT')
  await expect(page.getByLabel('Precio', { exact: true })).toHaveValue('29')
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByText('Producto actualizado correctamente.')).toBeVisible()
  expect(f.calls.metadata).toBe(1)
  expect(f.calls.create + f.calls.upload).toBe(0)
})

test('closing a product form explicitly discards only its draft', async ({ page }) => {
  await harness(page)
  await page.getByRole('button', { name: 'Nuevo producto', exact: true }).click()
  await page.getByLabel('Nombre', { exact: true }).fill('DISCARDED')
  await page.getByRole('button', { name: 'Cerrar formulario', exact: true }).click()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Recuperar borrador', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Nuevo producto', exact: true }).click()
  await expect(page.getByLabel('Nombre', { exact: true })).toHaveValue('')
})

test('new products default to available, reset when reopened and preserve unavailable products on edit', async ({ page }) => {
  const f = await harness(page, { available: false })
  await page.getByRole('button', { name: 'Editar producto', exact: true }).click()
  await expect(page.getByLabel('Agotado', { exact: true })).not.toBeChecked()
  await page.getByRole('button', { name: 'Cerrar formulario', exact: true }).click()
  await page.getByRole('button', { name: 'Nuevo producto', exact: true }).click()
  await expect(page.getByLabel('Disponible', { exact: true })).toBeChecked()
  await page.getByLabel('Disponible', { exact: true }).uncheck()
  await page.getByRole('button', { name: 'Cerrar formulario', exact: true }).click()
  await page.getByRole('button', { name: 'Nuevo producto', exact: true }).click()
  await expect(page.getByLabel('Disponible', { exact: true })).toBeChecked()
  expect(f.calls.create + f.calls.metadata + f.calls.upload + f.calls.link).toBe(0)
})

for (const mobile of [false, true]) {
  test(`edit from the bottom automatically scrolls to the product form (${mobile ? 'mobile, reduced motion' : 'desktop'})`, async ({ page }) => {
    await page.setViewportSize(mobile ? { width: 375, height: 812 } : { width: 1280, height: 800 })
    await page.emulateMedia({ reducedMotion: mobile ? 'reduce' : 'no-preference' })
    const f = await harness(page, {}, 30)
    const edit = page.getByRole('button', { name: 'Editar producto', exact: true }).last()
    await edit.scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(500)
    await edit.click()
    await expect(page.getByLabel('Nombre', { exact: true })).toHaveValue('LOCAL PRODUCT 30')
    await expect.poll(async () => {
      const box = await page.getByRole('heading', { name: 'Editar producto', exact: true }).boundingBox()
      return box !== null && box.y >= 0 && box.y + box.height < 200
    }).toBe(true)
    expect(f.calls.create + f.calls.metadata + f.calls.upload + f.calls.link + f.calls.remove).toBe(0)
  })
}

for (const [width, height] of [[6000, 4000], [8000, 6000]]) {
  test(`${width}x${height} originals use resized bitmaps without the full-resolution Image fallback`, async ({ page }) => {
    await harness(page)
    const result = await page.evaluate(async ({ width, height }) => {
      const api = (window as unknown as { imageTests: {
        prepareProductImage: (file: File) => Promise<{ blob: Blob }>
        prepareCategoryImage: (file: File) => Promise<Blob>
        prepareModuleImage: (file: File) => Promise<{ blob: Blob }>
      } }).imageTests
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
      const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'))
      canvas.width = 0; canvas.height = 0
      const file = new File([blob], 'high-resolution.png', { type: 'image/png' })
      const original = window.Image
      window.Image = class { constructor() { throw new Error('Full-resolution fallback forbidden') } } as unknown as typeof Image
      try {
        const outputs = [(await api.prepareProductImage(file)).blob, await api.prepareCategoryImage(file), (await api.prepareModuleImage(file)).blob]
        return Promise.all(outputs.map(async output => {
          const image = await createImageBitmap(output)
          const result = [image.width, image.height]; image.close(); return result
        }))
      } finally { window.Image = original }
    }, { width, height })
    expect(result).toEqual(Array(3).fill([1200, Math.round(height * 1200 / width)]))
  })
}

for (const failure of ['missing-api', 'ignored-resize', 'decode-error']) {
  test(`high-resolution ${failure} fails safely without a full-size fallback or upload`, async ({ page }) => {
    const f = await harness(page)
    if (failure === 'ignored-resize') {
      await page.route('**/imageResize.worker.ts*', async route => {
        const response = await route.fetch()
        await route.fulfill({ response, body: `const nativeBitmap = self.createImageBitmap; self.createImageBitmap = (blob) => nativeBitmap(blob);\n${await response.text()}` })
      })
    }
    const result = await page.evaluate(async failure => {
      const api = (window as unknown as { imageTests: { prepareProductImage: (file: File) => Promise<unknown> } }).imageTests
      const canvas = document.createElement('canvas'); canvas.width = 6000; canvas.height = 4000
      const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'))
      canvas.width = 0; canvas.height = 0
      const file = new File([failure === 'decode-error' ? blob.slice(0, 33) : blob], 'large.png', { type: 'image/png' })
      if (failure === 'missing-api') Object.defineProperty(window, 'createImageBitmap', { configurable: true, value: undefined })
      let fullSizeLoads = 0
      window.Image = class { constructor() { fullSizeLoads++; throw new Error('Unsafe full-size decode') } } as unknown as typeof Image
      try { await api.prepareProductImage(file); return { error: '', fullSizeLoads } }
      catch (error) { return { error: (error as Error).message, fullSizeLoads } }
    }, failure)
    expect(result.error).toMatch(/forma segura|menor resolucion/)
    expect(result.fullSizeLoads).toBe(0)
    expect(f.calls.upload + f.calls.link + f.calls.create + f.calls.metadata).toBe(0)
  })
}

test('browser without createImageBitmap can still optimize safely bounded small images', async ({ page }) => {
  await harness(page)
  const result = await page.evaluate(async () => {
    const api = (window as unknown as { imageTests: { prepareProductImage: (file: File) => Promise<{ blob: Blob }> } }).imageTests
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 32
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'))
    Object.defineProperty(window, 'createImageBitmap', { configurable: true, value: undefined })
    return (await api.prepareProductImage(new File([blob], 'small.png', { type: 'image/png' }))).blob.type
  })
  expect(result).toBe('image/webp')
})

for (const originalMB of [10, 30, 60]) {
  test(`${originalMB} MB original is decoded and optimized by product, category and service/staff entry points`, async ({ page }) => {
    await harness(page)
    const result = await page.evaluate(async originalMB => {
      const api = (window as unknown as { imageTests: {
        prepareProductImage: (file: File) => Promise<{ blob: Blob }>
        prepareModuleImage: (file: File) => Promise<{ blob: Blob }>
        prepareCategoryImage: (file: File) => Promise<Blob>
      } }).imageTests
      const canvas = document.createElement('canvas'); canvas.width = 2400; canvas.height = 1600
      const png = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'))
      // Padding after PNG IEND increases compressed file size without allocating
      // a huge bitmap; real browser decoding and the real Worker still run.
      const file = new File([png, new Uint8Array(originalMB * 1024 * 1024 - png.size)], 'large.png', { type: 'image/png' })
      const outputs = [(await api.prepareProductImage(file)).blob, await api.prepareCategoryImage(file), (await api.prepareModuleImage(file)).blob]
      return Promise.all(outputs.map(async blob => {
        const image = await createImageBitmap(blob)
        const value = { inputSize: file.size, size: blob.size, type: blob.type, width: image.width, height: image.height }
        image.close(); return value
      }))
    }, originalMB)
    for (const output of result) {
      expect(output.inputSize).toBe(originalMB * 1024 * 1024)
      expect(output.size).toBeLessThanOrEqual(2 * 1024 * 1024)
      expect(output.type).toBe('image/webp'); expect([output.width, output.height]).toEqual([1200, 800])
    }
  })
}

for (const kind of ['product', 'category'] as const) {
  test(`${kind} shows processing and disables saving while a 60 MB original is optimized`, async ({ page }) => {
    const f = await harness(page)
    if (kind === 'category') await page.goto('/tests/product-images/catalog-browser.html?kind=category')
    await page.getByRole('button', { name: kind === 'product' ? 'Nuevo producto' : 'Nueva categoria', exact: true }).click()
    await page.route('**/productImageHeader.worker.ts*', async route => {
      await new Promise(resolve => setTimeout(resolve, 500)); await route.continue()
    })
    await page.locator(kind === 'product' ? '#product-image' : '#category-image').evaluate(async element => {
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64
      const png = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'))
      const file = new File([png, new Uint8Array(60 * 1024 * 1024 - png.size)], 'large.png', { type: 'image/png' })
      const data = new DataTransfer(); data.items.add(file)
      ;(element as HTMLInputElement).files = data.files
      element.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await expect(page.getByText('Preparando imagen...', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /Guardando|Guardar/, exact: false })).toBeDisabled()
    await expect(page.getByText('Preparando imagen...', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
    expect(f.calls.upload + f.calls.link + f.calls.create + f.calls.metadata).toBe(0)
  })
}

test('all image preparation flows resize large JPG/PNG/WebP proportionally to 1200 px', async ({ page }) => {
  await harness(page)
  const bytes = Array.from(await png(page, 2800, 1800))
  const result = await page.evaluate(async (bytes) => {
    const api = (window as unknown as { imageTests: {
      prepareProductImage: (file: File) => Promise<{ blob: Blob }>
      optimizeImage: (file: File, maxBytes: number) => Promise<Blob>
      prepareModuleImage: (file: File) => Promise<{ blob: Blob }>
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
      const category = await createImageBitmap(await api.optimizeImage(file, 2 * 1024 * 1024))
      const module = await createImageBitmap((await api.prepareModuleImage(file)).blob)
      results.push({ type: prepared.blob.type, width: product.width, height: product.height,
        categoryWidth: category.width, categoryHeight: category.height, moduleWidth: module.width, moduleHeight: module.height })
      product.close(); category.close(); module.close()
    }
    canvas.width = 0; canvas.height = 0
    return results
  }, bytes)
  expect(result).toHaveLength(3)
  for (const image of result) {
    expect(image.type).toBe('image/webp'); expect(image.width).toBe(1200); expect(image.height).toBe(771)
    expect(image.categoryWidth).toBe(1200); expect(image.categoryHeight).toBe(771)
    expect(image.moduleWidth).toBe(1200); expect(image.moduleHeight).toBe(771)
  }
})

test('category upload uses the shared optimizer before Storage and rejects invalid input without uploading', async ({ page }) => {
  const f = await harness(page)
  const bytes = [...await png(page, 2400, 1600)]
  await page.evaluate(async bytes => {
    const { uploadCategoryImage } = (window as unknown as { imageTests: { uploadCategoryImage: (input: {
      file: File; storeId: number; storeSlug: string; categoryId: string; categorySlug: string
    }) => Promise<unknown> } }).imageTests
    const input = { storeId: 1, storeSlug: 'local', categoryId: 'aaaaaaaa-1111-4111-8111-111111111111', categorySlug: 'local' }
    let rejected = false
    try { await uploadCategoryImage({ ...input, file: new File(['not PNG'], 'invalid.png', { type: 'image/png' }) }) }
    catch { rejected = true }
    if (!rejected) throw new Error('Invalid category image accepted')
    await uploadCategoryImage({ ...input, file: new File([new Uint8Array(bytes)], 'large.png', { type: 'image/png' }) })
  }, bytes)
  expect(f.calls.upload).toBe(1)
  const path = f.calls.uploadPaths[0]
  expect(path).toMatch(/^category-images\/1-local\/categories\/aaaaaaaa-1111-4111-8111-111111111111-local\/principal-\d+\.webp$/)
  const dimensions = await page.evaluate(async bytes => {
    const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/webp' }))
    const result = [image.width, image.height]; image.close(); return result
  }, [...f.files.get(path)!])
  expect(dimensions).toEqual([1200, 800])
})

test('small transparent PNG stays small, retains alpha and encodes WebP at quality 0.80', async ({ page }) => {
  await harness(page)
  const result = await page.evaluate(async () => {
    const { optimizeImage } = (window as unknown as { imageTests: { optimizeImage: (file: File) => Promise<Blob> } }).imageTests
    const source = document.createElement('canvas'); source.width = 64; source.height = 32
    source.getContext('2d')!.fillRect(0, 0, 16, 16)
    const input = await new Promise<Blob>(resolve => source.toBlob(blob => resolve(blob!), 'image/png'))
    const original = HTMLCanvasElement.prototype.toBlob
    const qualities: (number | undefined)[] = []
    HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) {
      qualities.push(quality); return original.call(this, callback, type, quality)
    }
    try {
      const output = await optimizeImage(new File([input], 'transparent.png', { type: 'image/png' }))
      const image = await createImageBitmap(output)
      const decoded = document.createElement('canvas'); decoded.width = image.width; decoded.height = image.height
      const context = decoded.getContext('2d')!; context.drawImage(image, 0, 0); image.close()
      return { type: output.type, width: decoded.width, height: decoded.height, qualities,
        transparent: context.getImageData(40, 20, 1, 1).data[3], opaque: context.getImageData(5, 5, 1, 1).data[3] }
    } finally { HTMLCanvasElement.prototype.toBlob = original }
  })
  expect(result).toEqual({ type: 'image/webp', width: 64, height: 32, qualities: [0.8], transparent: 0, opaque: 255 })
})

test('already-sized WebP is decoded and validated without recompression or byte growth', async ({ page }) => {
  await harness(page)
  const result = await page.evaluate(async () => {
    const { optimizeImage } = (window as unknown as { imageTests: { optimizeImage: (file: File) => Promise<Blob> } }).imageTests
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 32
    const input = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/webp', 0.8))
    const file = new File([input], 'optimized.webp', { type: 'image/webp' })
    const original = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = () => { throw new Error('Unnecessary recompression') }
    try {
      const output = await optimizeImage(file)
      return { same: output === file, size: output.size, originalSize: file.size,
        bytesEqual: String(new Uint8Array(await output.arrayBuffer())) === String(new Uint8Array(await file.arrayBuffer())) }
    } finally { HTMLCanvasElement.prototype.toBlob = original }
  })
  expect(result.same).toBe(true); expect(result.bytesEqual).toBe(true); expect(result.size).toBe(result.originalSize)
})

for (const kind of ['invalid', 'conversion-failure', 'dimension-limit', 'mime-mismatch', 'hostile-header']) {
  test(`${kind}: real form performs zero writes`, async ({ page }) => {
    const f = await harness(page)
    await page.getByRole('button', { name: 'Nuevo producto' }).click()
    await page.getByLabel('Nombre', { exact: true }).fill('INVALID IMAGE TEST')
    await page.getByLabel('Precio', { exact: true }).fill('10')
    const buffer = kind === 'invalid' ? Buffer.from('not PNG')
      : kind === 'hostile-header' ? Buffer.alloc(512 * 1024) : await png(page)
    if (kind === 'dimension-limit') buffer.writeUInt32BE(20000, 16)
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

for (const mode of ['cleanupPending', 'cleanupError'] as const) {
  test(`replacement ${mode}: successful save stays clean and technical details go only to a sanitized warning`, async ({ page }) => {
    const warnings: string[] = []
    page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()) })
    const f = await harness(page); f.behavior[mode] = true
    await page.getByRole('button', { name: 'Editar producto' }).click()
    await page.locator('#product-image').setInputFiles({ name: 'valid.png', mimeType: 'image/png', buffer: await png(page) })
    await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Guardar', exact: true }).click()
    await expect(page.getByText('Producto actualizado correctamente.')).toBeVisible()
    await expect(page.getByText(/limpieza|Storage|backend|LOCAL private/i)).toHaveCount(0)
    expect(warnings).toEqual([mode === 'cleanupPending'
      ? 'Catalog image cleanup requires review. {status: pending}'
      : 'Catalog image cleanup could not be confirmed.'])
    expect(f.calls.upload).toBe(1); expect(f.calls.link).toBe(1); expect(f.calls.remove).toBe(0)
    expect(f.files.has(original.image_path)).toBe(true)
  })
}

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

// Stability regressions: all HTTP is intercepted by harness; no remote data is used.
for (const mode of ['create', 'edit'] as const) {
  test(`stability ${mode}: render failure is contained and the draft can be recovered`, async ({ page }) => {
    const f = await harness(page)
    await page.getByRole('button', { name: mode === 'create' ? 'Nuevo producto' : 'Editar producto', exact: true }).click()
    await page.locator('#product-name').fill('RECOVERABLE TEXT')
    const bytes = await png(page)
    await page.locator('#product-image').evaluate((input: HTMLInputElement, bytes) => {
      const file = new File([new Uint8Array(bytes)], 'private.png', { type: 'image/png' })
      const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files
      const descriptor = Object.getOwnPropertyDescriptor(File.prototype, 'name')!
      Object.defineProperty(File.prototype, 'name', { configurable: true, get() { throw new Error('synthetic render failure') } })
      Object.assign(window, { restoreFileName: () => Object.defineProperty(File.prototype, 'name', descriptor) })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }, [...bytes])
    await expect(page.getByText('No se pudo mostrar esta pantalla')).toBeVisible()
    await page.evaluate(() => (window as unknown as { restoreFileName: () => void }).restoreFileName())
    await page.getByRole('button', { name: 'Volver a intentar', exact: true }).click()
    await page.getByRole('button', { name: 'Recuperar borrador', exact: true }).click()
    await expect(page.locator('#product-name')).toHaveValue('RECOVERABLE TEXT')
    expect(f.calls.create + f.calls.metadata + f.calls.upload).toBe(0)
  })
  test(`stability ${mode}: blocked sessionStorage never blanks the form or sends unsafe writes`, async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('blocked', 'SecurityError') } }))
    const f = await harness(page)
    await page.getByRole('button', { name: mode === 'create' ? 'Nuevo producto' : 'Editar producto', exact: true }).click()
    await page.locator('#product-name').fill('IN MEMORY')
    await page.locator('#product-price').fill('20')
    await page.locator('#product-image').setInputFiles({ name: 'private.png', mimeType: 'image/png', buffer: await png(page) })
    await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
    await expect(page.getByText(/No se puede guardar un borrador recuperable/)).toBeVisible()
    await expect(page.locator('#product-name')).toHaveValue('IN MEMORY')
    expect(f.calls.upload + f.calls.create).toBe(0)
  })
}

test('stability: quota warning survives successful image preparation', async ({ page }) => {
  await harness(page)
  await page.getByRole('button', { name: 'Editar producto', exact: true }).click()
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('full', 'QuotaExceededError') } })
  await page.locator('#product-name').fill('UNSAVED TEXT')
  await page.locator('#product-image').setInputFiles({ name: 'private.png', mimeType: 'image/png', buffer: await png(page) })
  await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
  await expect(page.getByText(/No se puede guardar un borrador recuperable/)).toBeVisible()
  await expect(page.locator('#product-name')).toHaveValue('UNSAVED TEXT')
})

for (const failure of ['read', 'fallback', 'canvas'] as const) {
  test(`stability: ${failure} that never resolves times out and preserves fields`, async ({ page }) => {
    const f = await harness(page)
    await page.getByRole('button', { name: 'Editar producto', exact: true }).click()
    await page.locator('#product-name').fill('PRESERVED')
    const bytes = await png(page)
    await page.evaluate(failure => {
      const native = window.setTimeout.bind(window)
      const deadline = { read: 5000, fallback: 8000, canvas: 10000 }[failure]
      window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => native(handler, delay === deadline ? 100 : delay, ...args)) as typeof setTimeout
      if (failure === 'read') FileReader.prototype.readAsArrayBuffer = function () { /* intentionally stalled */ }
      if (failure === 'canvas') HTMLCanvasElement.prototype.toBlob = function () { /* intentionally stalled */ }
      if (failure === 'fallback') {
        Object.defineProperty(window, 'createImageBitmap', { value: undefined, configurable: true })
        Object.defineProperty(window, 'Image', { value: function () {
          const image = document.createElement('img')
          Object.defineProperty(image, 'src', { set() { /* no load/error callback */ } })
          return image
        }, configurable: true })
      }
    }, failure)
    await page.locator('#product-image').setInputFiles({ name: 'private.png', mimeType: 'image/png', buffer: bytes })
    await expect(page.getByText(/La preparacion tardo demasiado/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
    await expect(page.locator('#product-name')).toHaveValue('PRESERVED')
    expect(f.calls.create + f.calls.metadata + f.calls.upload).toBe(0)
  })
}

for (const action of ['cancel', 'navigate', 'store', 'reselect'] as const) {
  test(`stability: ${action} terminates pending workers and ignores obsolete results`, async ({ page }) => {
    const f = await harness(page)
    await page.getByRole('button', { name: 'Editar producto', exact: true }).click()
    await page.locator('#product-name').fill('KEPT')
    const bytes = await png(page)
    await page.evaluate(() => {
      const NativeWorker = Worker
      const active = new Set<Worker>()
      Object.assign(window, { activeImageWorkers: active })
      window.Worker = class extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options); active.add(this)
          // Hold the first header response. Work must terminate on cancellation.
          Object.defineProperty(this, 'onmessage', { set() { /* intentionally held */ } })
        }
        terminate() { active.delete(this); super.terminate() }
      }
    })
    await page.locator('#product-image').setInputFiles({ name: 'first.png', mimeType: 'image/png', buffer: bytes })
    await expect.poll(() => page.evaluate(() => (window as unknown as { activeImageWorkers: Set<Worker> }).activeImageWorkers.size)).toBe(1)
    if (action === 'cancel') await page.getByRole('button', { name: 'Cancelar preparacion de imagen' }).click()
    if (action === 'navigate') await page.getByRole('button', { name: 'Test navegar' }).click()
    if (action === 'store') await page.getByRole('button', { name: 'Test cambiar tienda' }).click()
    if (action === 'reselect') {
      await page.locator('#product-image').setInputFiles({ name: 'second.png', mimeType: 'image/png', buffer: bytes })
      await expect.poll(() => page.evaluate(() => (window as unknown as { activeImageWorkers: Set<Worker> }).activeImageWorkers.size)).toBe(1)
      await page.getByRole('button', { name: 'Cancelar preparacion de imagen' }).click()
    }
    await expect.poll(() => page.evaluate(() => (window as unknown as { activeImageWorkers: Set<Worker> }).activeImageWorkers.size)).toBe(0)
    expect(f.calls.create + f.calls.metadata + f.calls.upload).toBe(0)
    if (action === 'cancel' || action === 'reselect') await expect(page.locator('#product-name')).toHaveValue('KEPT')
    if (action === 'navigate') {
      await page.getByRole('button', { name: 'Test navegar' }).click()
      await page.getByRole('button', { name: 'Recuperar borrador', exact: true }).click()
      await expect(page.locator('#product-name')).toHaveValue('KEPT')
    }
    if (action === 'store') await expect(page.getByRole('button', { name: 'Recuperar borrador', exact: true })).toHaveCount(0)
  })
}

test('stability: canvas allocation failure closes the decoded bitmap and allows re-selection', async ({ page }) => {
  await harness(page)
  await page.getByRole('button', { name: 'Editar producto', exact: true }).click()
  const bytes = await png(page)
  await page.evaluate(() => {
    const close = ImageBitmap.prototype.close
    Object.assign(window, { bitmapCloses: 0 })
    ImageBitmap.prototype.close = function () { (window as unknown as { bitmapCloses: number }).bitmapCloses++; close.call(this) }
    const create = document.createElement.bind(document)
    document.createElement = ((tag: string, options?: ElementCreationOptions) => {
      if (tag === 'canvas') throw new Error('synthetic allocation failure')
      return create(tag, options)
    }) as typeof document.createElement
  })
  await page.locator('#product-image').setInputFiles({ name: 'private.png', mimeType: 'image/png', buffer: bytes })
  await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
  await expect.poll(() => page.evaluate(() => (window as unknown as { bitmapCloses: number }).bitmapCloses)).toBe(1)
  await expect(page.locator('#product-name')).toHaveValue('LOCAL PRODUCT')
})

for (const stage of ['read', 'decode'] as const) {
  test(`stability: ${stage} rejection preserves a previous valid image and form`, async ({ page }) => {
    const f = await harness(page)
    await page.getByRole('button', { name: 'Editar producto', exact: true }).click()
    const bytes = await png(page)
    await page.locator('#product-image').setInputFiles({ name: 'first.png', mimeType: 'image/png', buffer: bytes })
    await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
    await page.locator('#product-name').fill('PRESERVED NAME')
    await page.evaluate(stage => {
      if (stage === 'read') FileReader.prototype.readAsArrayBuffer = function () { this.dispatchEvent(new ProgressEvent('error')) }
      else {
        const Native = Worker
        window.Worker = class extends Native {
          constructor(url: string | URL, options?: WorkerOptions) {
            super(url, options)
            if (String(url).includes('imageResize.worker')) Object.defineProperty(this, 'onmessage', { set(callback) {
              queueMicrotask(() => callback({ data: { failed: true } }))
            } })
          }
        }
        // Force the bounded HTML fallback to fail too.
        Object.defineProperty(window, 'Image', { value: function () { throw new Error('synthetic decode error') } })
      }
    }, stage)
    await page.locator('#product-image').setInputFiles({ name: 'second.png', mimeType: 'image/png', buffer: bytes })
    await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
    await expect(page.getByText('first.png', { exact: true })).toBeVisible()
    await expect(page.locator('#product-name')).toHaveValue('PRESERVED NAME')
    expect(f.calls.create + f.calls.metadata + f.calls.upload + f.calls.link).toBe(0)
  })
}

test('stability: late bitmap delivery after cancellation is closed without changing the form', async ({ page }) => {
  const f = await harness(page)
  await page.getByRole('button', { name: 'Editar producto', exact: true }).click()
  const bytes = await png(page)
  await page.evaluate(async bytes => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
    Object.assign(window, { lateBitmapClosed: 0, resizeStarted: false })
    const close = bitmap.close.bind(bitmap)
    bitmap.close = () => { (window as unknown as { lateBitmapClosed: number }).lateBitmapClosed++; close() }
    const Native = Worker
    window.Worker = class extends Native {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        if (String(url).includes('imageResize.worker')) {
          Object.defineProperty(this, 'onmessage', { set(callback) {
            (window as unknown as { resizeStarted: boolean }).resizeStarted = true
            // Simulate an already queued transfer even though terminate() is called.
            setTimeout(() => callback({ data: { bitmap } }), 500)
          } })
        }
      }
    }
  }, [...bytes])
  await page.locator('#product-image').setInputFiles({ name: 'private.png', mimeType: 'image/png', buffer: bytes })
  await expect.poll(() => page.evaluate(() => (window as unknown as { resizeStarted: boolean }).resizeStarted)).toBe(true)
  await page.getByRole('button', { name: 'Cancelar preparacion de imagen' }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { lateBitmapClosed: number }).lateBitmapClosed)).toBe(1)
  await expect(page.locator('#product-name')).toHaveValue('LOCAL PRODUCT')
  expect(f.calls.create + f.calls.metadata + f.calls.upload + f.calls.link).toBe(0)
})

for (const feature of ['at', 'scrollIntoView', 'matchMedia', 'throwing-scroll', 'throwing-match'] as const) {
  test(`hotfix: ${feature} missing or throwing cannot activate the boundary`, async ({ page }) => {
    if (feature === 'at') await page.addInitScript(() => { Array.prototype.at = undefined as unknown as typeof Array.prototype.at })
    const f = await harness(page)
    await page.evaluate(feature => {
      if (feature === 'scrollIntoView') Element.prototype.scrollIntoView = undefined as unknown as typeof Element.prototype.scrollIntoView
      if (feature === 'matchMedia') window.matchMedia = undefined as unknown as typeof window.matchMedia
      if (feature === 'throwing-scroll') Object.defineProperty(Element.prototype, 'scrollIntoView', { get() { throw new Error('optional API denied') } })
      if (feature === 'throwing-match') window.matchMedia = () => { throw new Error('optional API denied') }
    }, feature)
    await page.getByRole('button', { name: 'Editar producto', exact: true }).click()
    await expect(page.locator('#product-name')).toHaveValue('LOCAL PRODUCT')
    await page.locator('#product-image').setInputFiles({ name: 'safe.png', mimeType: 'image/png', buffer: await png(page) })
    await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Guardar', exact: true }).click()
    await expect(page.getByText('Producto actualizado correctamente.')).toBeVisible()
    await expect(page.getByText('No se pudo mostrar esta pantalla')).toHaveCount(0)
    expect(f.calls.upload).toBe(1); expect(f.calls.link).toBe(1)
  })
}

test('hotfix: absent randomUUID and AbortSignal.timeout preserve secure creation and image association', async ({ page }) => {
  const f = await harness(page)
  await page.evaluate(() => {
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined })
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined })
  })
  await page.getByRole('button', { name: 'Nuevo producto', exact: true }).click()
  await page.locator('#product-name').fill('SECURE COMPAT PRODUCT')
  await page.locator('#product-price').fill('12')
  await page.locator('#product-image').setInputFiles({ name: 'safe.png', mimeType: 'image/png', buffer: await png(page) })
  await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByText('Producto creado correctamente.')).toBeVisible()
  expect(f.calls.create).toBe(1); expect(f.calls.upload).toBe(1); expect(f.calls.link).toBe(1)
})

test('hotfix: UI incident correlates last image stage, reports once and preserves the draft', async ({ page }) => {
  const logs: string[] = []
  page.on('console', message => { if (message.text().includes('ui_incident')) logs.push(message.text()) })
  const f = await harness(page)
  await page.getByRole('button', { name: 'Editar producto', exact: true }).click()
  await page.locator('#product-name').fill('PRIVATE DRAFT CONTENT')
  const bytes = await png(page)
  await page.locator('#product-image').evaluate((input: HTMLInputElement, bytes) => {
    const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(bytes)], 'customer-secret.png', { type: 'image/png' })); input.files = dt.files
    const original = Object.getOwnPropertyDescriptor(File.prototype, 'name')!
    Object.assign(window, { restoreName: () => Object.defineProperty(File.prototype, 'name', original) })
    Object.defineProperty(File.prototype, 'name', { get() { throw new TypeError('customer-secret.png token=private') }, configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, [...bytes])
  await expect(page.getByText('No se pudo mostrar esta pantalla')).toBeVisible()
  const report = await page.evaluate(() => JSON.parse(Object.entries(sessionStorage).find(([k]) => k.endsWith('.incidents'))![1]))
  await expect(page.getByText(report.id, { exact: true })).toBeVisible()
  expect(report.id).toMatch(/^KC-/); expect(report.module).toBe('products'); expect(report.version).toBe('123abcd456ef')
  expect(report.image.stage).toBe('hashed'); expect(report.correlation).toBe('context_only')
  expect(JSON.stringify(report)).not.toMatch(/customer-secret|PRIVATE DRAFT|token=/)
  expect(logs).toHaveLength(1)
  await page.evaluate(() => (window as unknown as { restoreName: () => void }).restoreName())
  await page.getByRole('button', { name: 'Volver a intentar', exact: true }).click()
  await page.getByRole('button', { name: 'Recuperar borrador', exact: true }).click()
  await expect(page.locator('#product-name')).toHaveValue('PRIVATE DRAFT CONTENT')
  expect(f.calls.create + f.calls.metadata + f.calls.upload + f.calls.link).toBe(0)
})

for (const kind of ['effect', 'persistent', 'reporter'] as const) {
  test(`hotfix: ${kind} error stays recoverable even when instrumentation fails`, async ({ page }) => {
    const f = await harness(page)
    if (kind === 'reporter') await page.evaluate(() => {
      Storage.prototype.setItem = () => { throw new Error('storage failure') }
      console.error = () => { throw new Error('logging failure') }
    })
    await page.getByRole('button', { name: `Test fallo ${kind}`, exact: true }).click()
    await expect(page.getByText('No se pudo mostrar esta pantalla')).toBeVisible()
    await expect(page.getByText(/^KC-/, { exact: false })).toBeVisible()
    await page.getByRole('button', { name: 'Volver a intentar', exact: true }).click()
    await expect(page.getByText('No se pudo mostrar esta pantalla')).toBeVisible()
    await page.getByRole('button', { name: 'Volver a intentar', exact: true }).click()
    await expect(page.getByText(/El error persiste/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Volver a intentar', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Ir a otro modulo', exact: true }).click()
    await expect(page.getByText('LOCAL PRODUCT', { exact: true })).toBeVisible()
    expect(f.calls.create + f.calls.metadata + f.calls.upload + f.calls.link).toBe(0)
  })
}
