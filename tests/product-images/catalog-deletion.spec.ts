import { expect, test, type Page } from '@playwright/test'

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const categoryId = 'aaaaaaaa-1111-4111-8111-111111111111'
async function fixture(page: Page, kind: 'product' | 'category' = 'product') {
  await page.addInitScript(owner => {
    const encode = (v: unknown) => btoa(JSON.stringify(v)).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_')
    localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: `${encode({alg:'none'})}.${encode({sub:owner,exp:Date.now()/1000+3600})}.local`,
      refresh_token: 'local-fixture', expires_at: Date.now()/1000+3600, user: { id: owner, app_metadata: {global_role:'admin'} } }))
  }, owner)
  const product = { id: 7, store_id: 1, name: 'LOCAL PRODUCT', description: '', price: 10, discount_active: false,
    discount_price: null, visual_rating: 5, category_id: null, image_path: '1/7/shared.webp', available: true, active: true, created_at: '2026-10-21' }
  const category = { id: categoryId, store_id: 1, name: 'LOCAL CATEGORY', slug: 'local-category', image_url: null, sort_order: 0, active: true, created_at: '2026-10-21' }
  let deleted = false
  const behavior = { hasProducts: false, reject: false, disabled: false, loseReply: false, pending: false, shared: false, unverified: false, unconfirmed: false }
  const calls = { requests: [] as Record<string, unknown>[], committed: 0, storageDeletes: 0, external: 0 }
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url())
    if (url.origin !== 'http://127.0.0.1:5197') { calls.external++; return route.abort() }
    if (url.pathname.startsWith('/storage/')) { if (req.method() === 'DELETE') calls.storageDeletes++; return route.fulfill({ status: 503, json: { message: 'LOCAL Storage unavailable' } }) }
    if (url.pathname === '/rest/v1/products') return route.fulfill({ json: kind === 'category'
      ? behavior.hasProducts ? [{category_id:categoryId}] : [] : deleted ? [] : [product] })
    if (url.pathname === '/rest/v1/categories') return route.fulfill({ json: kind === 'category' && !deleted ? [category] : [] })
    if (url.pathname === '/functions/v1/catalog-delete') {
      const body = req.postDataJSON(); calls.requests.push(body)
      expect(body).not.toHaveProperty('path'); expect(body).not.toHaveProperty('p_actor')
      expect(body.store_id).toBe(1); expect(body.kind).toBe(kind)
      expect(body.entity_id).toBe(kind === 'product' ? '7' : categoryId)
      if (behavior.disabled) return route.fulfill({ status: 503, json: { error: 'Eliminacion backend deshabilitada o pendiente de despliegue.' } })
      if (behavior.reject) return route.fulfill({ status: 403, json: { error: 'LOCAL denied' } })
      if (behavior.hasProducts) return route.fulfill({ status: 409, json: { error: 'La categoria tiene productos o existen referencias que impiden eliminar.' } })
      if (behavior.unconfirmed) return route.fulfill({ json: { deleted: false, cleanup: 'complete' } })
      const replayed = deleted
      if (!deleted) { calls.committed++; deleted = true }
      if (behavior.loseReply) { behavior.loseReply = false; return route.abort() }
      return route.fulfill({ json: { deleted: true, replayed, cleanup: behavior.pending ? 'pending' : behavior.shared ? 'retained_shared' : behavior.unverified ? 'retained_unverified' : 'complete' } })
    }
    if (url.pathname.startsWith('/rest/') || url.pathname.startsWith('/auth/')) return route.abort()
    return route.continue()
  })
  await page.goto(`/tests/product-images/catalog-browser.html?kind=${kind}`)
  await expect(page.getByText(kind === 'product' ? 'LOCAL PRODUCT' : 'LOCAL CATEGORY', { exact: true })).toBeVisible()
  return { calls, behavior }
}
for (const kind of ['product', 'category'] as const) {
  test(`${kind}: backend flags OFF returns 503, preserves row and never falls back to direct deletion`, async ({ page }) => {
    const f = await fixture(page, kind); f.behavior.disabled = true
    page.once('dialog', dialog => dialog.accept())
    await page.getByRole('button', { name: kind === 'product' ? 'Eliminar producto' : 'Eliminar categoria', exact: true }).click()
    await expect(page.getByText(/No se pudo confirmar la eliminación/)).toBeVisible()
    await expect(page.getByText(kind === 'product' ? 'LOCAL PRODUCT' : 'LOCAL CATEGORY', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Reintentar', exact: true })).toHaveCount(0)
    expect(f.calls.requests).toHaveLength(1)
    expect(f.calls.committed).toBe(0); expect(f.calls.storageDeletes).toBe(0); expect(f.calls.external).toBe(0)
  })
  test(`${kind}: confirmation cancel makes zero writes; accept uses only the backend`, async ({ page }) => {
    const f = await fixture(page, kind)
    page.once('dialog', dialog => dialog.dismiss())
    await page.getByRole('button', { name: kind === 'product' ? 'Eliminar producto' : 'Eliminar categoria', exact: true }).click()
    expect(f.calls.requests).toHaveLength(0)
    page.once('dialog', dialog => {
      expect(dialog.message()).toBe(`¿Eliminar ${kind === 'product' ? 'el producto "LOCAL PRODUCT"' : 'la categoría "LOCAL CATEGORY"'}? Esta acción no se puede deshacer.`)
      return dialog.accept()
    })
    await page.getByRole('button', { name: kind === 'product' ? 'Eliminar producto' : 'Eliminar categoria', exact: true }).click()
    await expect(page.getByText(kind === 'product' ? 'LOCAL PRODUCT' : 'LOCAL CATEGORY', { exact: true })).toHaveCount(0)
    await expect(page.getByText(kind === 'product' ? 'Producto eliminado correctamente.' : 'Categoría eliminada correctamente.', { exact: true })).toBeVisible()
    expect(f.calls.committed).toBe(1); expect(f.calls.storageDeletes).toBe(0); expect(f.calls.external).toBe(0)
  })
}
test('nonempty category is blocked in UI and backend rejects stale counts', async ({ page }) => {
  const f = await fixture(page, 'category'); f.behavior.hasProducts = true
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Eliminar categoria', exact: true }).click()
  await expect(page.getByText('No se puede eliminar la categoría porque tiene productos asociados o está en uso.')).toBeVisible()
  expect(f.calls.committed).toBe(0); expect(f.calls.storageDeletes).toBe(0)
})
test('lost committed response preserves operation UUID for an explicit delete retry without technical controls', async ({ page }) => {
  const f = await fixture(page); f.behavior.loseReply = true
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Eliminar producto', exact: true }).click()
  await expect(page.getByText(/No se pudo confirmar la eliminación/)).toBeVisible()
  await expect(page.getByText('Producto eliminado correctamente.')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Reintentar', exact: true })).toHaveCount(0)
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Eliminar producto', exact: true }).click()
  await expect(page.getByText('Producto eliminado correctamente.')).toBeVisible()
  expect(f.calls.requests).toHaveLength(2)
  expect(f.calls.requests[0].operation_id).toBe(f.calls.requests[1].operation_id)
  expect(f.calls.committed).toBe(1)
})
for (const kind of ['product', 'category'] as const) {
  for (const status of ['pending', 'shared', 'unverified'] as const) {
    test(`${kind}: ${status} cleanup logs only a safe status and shows the standard success`, async ({ page }) => {
      const warnings: string[] = []
      page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()) })
      const f = await fixture(page, kind); f.behavior[status] = true
      page.once('dialog', dialog => dialog.accept())
      await page.getByRole('button', { name: kind === 'product' ? 'Eliminar producto' : 'Eliminar categoria', exact: true }).click()
      await expect(page.getByText(kind === 'product' ? 'Producto eliminado correctamente.' : 'Categoría eliminada correctamente.', { exact: true })).toBeVisible()
      await expect(page.getByText(/limpieza|Storage|backend|referencias compartidas|operaci[oó]n pendiente/i)).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Reintentar', exact: true })).toHaveCount(0)
      expect(warnings).toEqual([`Catalog image cleanup requires review. {status: ${status === 'shared' ? 'retained_shared' : status === 'unverified' ? 'retained_unverified' : 'pending'}}`])
      expect(f.calls.committed).toBe(1); expect(f.calls.storageDeletes).toBe(0)
      await page.reload()
      await expect(page.getByRole('button', { name: 'Reintentar', exact: true })).toHaveCount(0)
      expect(f.calls.requests).toHaveLength(1)
    })
  }
  test(`${kind}: an unconfirmed record deletion never shows success or removes the row`, async ({ page }) => {
    const f = await fixture(page, kind); f.behavior.unconfirmed = true
    page.once('dialog', dialog => dialog.accept())
    await page.getByRole('button', { name: kind === 'product' ? 'Eliminar producto' : 'Eliminar categoria', exact: true }).click()
    await expect(page.getByText(/No se pudo confirmar la eliminación/)).toBeVisible()
    await expect(page.getByText(kind === 'product' ? 'LOCAL PRODUCT' : 'LOCAL CATEGORY', { exact: true })).toBeVisible()
    await expect(page.getByText(/eliminad[oa] correctamente/)).toHaveCount(0)
    expect(f.calls.committed).toBe(0)
  })
}
test('denied backend leaves product visible and never invokes Storage from the browser', async ({ page }) => {
  const f = await fixture(page); f.behavior.reject = true
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Eliminar producto', exact: true }).click()
  await expect(page.getByText(/No se pudo confirmar la eliminación/)).toBeVisible()
  await expect(page.getByText('LOCAL PRODUCT', { exact: true })).toBeVisible()
  expect(f.calls.committed + f.calls.storageDeletes).toBe(0)
})
