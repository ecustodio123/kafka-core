import { test, expect, type Page } from '@playwright/test'

const owner = '11111111-1111-4111-8111-111111111111'
const stores = [
  { id: 1, name: 'Alpha', slug: 'alpha', owner_user_id: owner },
  { id: 2, name: 'Beta', slug: 'beta', owner_user_id: '22222222-2222-4222-8222-222222222222' },
  { id: 3, name: 'Legacy', slug: 'legacy', owner_user_id: owner },
]
type Flags = { store_id: number; commerce_enabled: boolean; services_enabled: boolean; staff_enabled: boolean; publications_enabled: boolean }
async function setup(page: Page, role: string | null = 'admin') {
  const metadata = role === null ? {} : { global_role: role }
  await page.addInitScript(({ owner, metadata }) => {
    const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_')
    const token = `${encode({ alg: 'none' })}.${encode({ sub: owner, exp: Math.floor(Date.now() / 1000) + 3600 })}.local-test`
    localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: token, refresh_token: 'local-test-only', token_type: 'bearer', expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: owner, email: 'owner@example.com', app_metadata: metadata, user_metadata: {}, aud: 'authenticated' } }))
  }, { owner, metadata })
  const db = new Map<number, Flags>([[1, { store_id: 1, commerce_enabled: true, services_enabled: true, staff_enabled: false, publications_enabled: false }], [2, { store_id: 2, commerce_enabled: true, services_enabled: false, staff_enabled: false, publications_enabled: false }]])
  const calls = { writes: 0, products: [] as number[], categories: [] as number[], external: 0, featureReads: [] as number[] }
  const behavior = { failRead: false, failSave: false, conflict: false, delay: 0, productDelay: 0 }
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url())
    if (url.origin !== 'http://127.0.0.1:5197') { calls.external++; return route.abort() }
    if (url.pathname === '/auth/v1/user') return route.fulfill({ json: { id: owner, email: 'owner@example.com', app_metadata: metadata, user_metadata: {}, aud: 'authenticated' } })
    if (url.pathname === '/rest/v1/stores') {
      if (role !== 'super_admin') expect(url.searchParams.get('owner_user_id')).toBe(`eq.${owner}`)
      return route.fulfill({ json: stores.filter(s => role === 'super_admin' || s.owner_user_id === owner) })
    }
    if (url.pathname === '/rest/v1/store_features') {
      const id = Number(url.searchParams.get('store_id')?.replace('eq.', '') ?? req.postDataJSON()?.store_id)
      if (req.method() === 'GET') {
        calls.featureReads.push(id)
        const row = db.get(id)
        if (behavior.delay) await new Promise(resolve => setTimeout(resolve, behavior.delay))
        if (behavior.failRead) return route.fulfill({ status: 500, json: { message: 'local failure' } })
        return route.fulfill({ json: row ? [row] : [] })
      }
      calls.writes++
      expect(role).toBe('super_admin')
      if (behavior.failSave) return route.fulfill({ status: 403, json: { message: 'local denial' } })
      if (req.method() === 'PATCH') {
        const row = db.get(id)!
        for (const key of ['commerce_enabled', 'services_enabled', 'staff_enabled', 'publications_enabled'] as const) expect(url.searchParams.get(key)).toBe(`eq.${row[key]}`)
        if (behavior.conflict) return route.fulfill({ json: [] })
        const next = { ...row, ...req.postDataJSON() }; db.set(id, next)
        return route.fulfill({ json: [next] })
      }
      const next = req.postDataJSON(); db.set(next.store_id, next)
      return route.fulfill({ json: next })
    }
    if (url.pathname === '/rest/v1/products' || url.pathname === '/rest/v1/categories') {
      expect(req.method()).toBe('GET')
      const id = Number(url.searchParams.get('store_id')?.replace('eq.', ''))
      calls[url.pathname.endsWith('products') ? 'products' : 'categories'].push(id)
      if (url.pathname.endsWith('products') && id === 1 && behavior.productDelay) {
        await new Promise(resolve => setTimeout(resolve, behavior.productDelay))
        return route.fulfill({ json: [{ id: 10, store_id: 1, name: 'DELAYED ALPHA PRODUCT', description: '', price: 20,
          discount_active: false, discount_price: null, visual_rating: 5, category_id: null, image_path: null,
          available: true, active: true, created_at: '2026-10-20T00:00:00Z' }] })
      }
      return route.fulfill({ json: [] })
    }
    if (url.pathname === '/rest/v1/services' || url.pathname === '/rest/v1/staff') {
      expect(req.method()).toBe('GET')
      expect(url.searchParams.get('store_id')).toMatch(/^eq\.[123]$/)
      return route.fulfill({ json: [] })
    }
    if (url.pathname.startsWith('/rest/') || url.pathname.startsWith('/storage/')) throw new Error(`Unexpected local API ${req.method()} ${url.pathname}`)
    return route.continue()
  })
  await page.goto('/tests/admin-navigation/browser.html')
  await expect(page.getByLabel('Tienda', { exact: true })).toBeEnabled()
  return { db, calls, behavior }
}

test('admin sees own stores and enabled modules; config is read-only', async ({ page }) => {
  const { calls } = await setup(page)
  await expect(page.getByRole('button', { name: 'Productos', exact: true })).toBeVisible()
  await expect(page.locator('#store-selector option')).toHaveText(['Alpha', 'Legacy'])
  await expect(page.getByRole('button', { name: /^Staff/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Servicios', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Servicios', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Modulos', exact: true }).click()
  await expect(page.getByLabel('Commerce', { exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Guardar cambios' })).toHaveCount(0)
  expect(calls.writes).toBe(0); expect(calls.external).toBe(0)
})

test('super admin sees all stores but cannot mount foreign catalog', async ({ page }) => {
  const { calls } = await setup(page, 'super_admin')
  await page.getByLabel('Tienda', { exact: true }).selectOption('2')
  await expect(page.getByRole('heading', { name: 'Modulos de la tienda' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Productos', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Servicios Deshabilitado' }).click()
  await expect(page.getByRole('heading', { name: 'Servicios', exact: true })).toBeVisible()
  expect(calls.products).toEqual([]); expect(calls.categories).toEqual([])
})

test('legacy owner without explicit role keeps catalog but flags stay false', async ({ page }) => {
  await setup(page, null)
  await page.getByLabel('Tienda', { exact: true }).selectOption('3')
  await expect(page.getByText(/acceso de compatibilidad/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Productos', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Modulos', exact: true }).click()
  for (const label of ['Commerce', 'Servicios', 'Staff']) await expect(page.getByLabel(label, { exact: true })).not.toBeChecked()
})

test('super admin explicitly creates missing flags; no writes on opening', async ({ page }) => {
  const { calls, db } = await setup(page, 'super_admin')
  await page.getByLabel('Tienda', { exact: true }).selectOption('3')
  await expect(page.getByRole('button', { name: 'Crear configuracion' })).toBeVisible()
  expect(calls.writes).toBe(0)
  await page.getByRole('button', { name: 'Crear configuracion' }).dblclick()
  await expect(page.getByText('Configuracion guardada.')).toBeVisible()
  expect(calls.writes).toBe(1)
  expect(db.get(3)).toEqual({ store_id: 3, commerce_enabled: false, services_enabled: false, staff_enabled: false, publications_enabled: false })
})

test('explicit save toggles flags and reports success', async ({ page }) => {
  const { calls, db } = await setup(page, 'super_admin')
  await page.getByLabel('Staff', { exact: true }).check()
  expect(calls.writes).toBe(0)
  await page.getByRole('button', { name: 'Guardar cambios' }).click()
  await expect(page.getByText('Configuracion guardada.')).toBeVisible()
  expect(db.get(1)?.staff_enabled).toBe(true); expect(calls.writes).toBe(1)
})

test('disabled commerce blocks owner catalog without applying legacy fallback', async ({ page }) => {
  const { db } = await setup(page)
  db.set(3, { store_id: 3, commerce_enabled: false, services_enabled: false, staff_enabled: false, publications_enabled: false })
  await page.getByLabel('Tienda', { exact: true }).selectOption('3')
  await expect(page.getByRole('heading', { name: 'Modulos de la tienda' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Productos', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Categorias', exact: true })).toHaveCount(0)
  await expect(page.getByText(/acceso de compatibilidad/)).toHaveCount(0)
})

test('store switch clears existing product form and scopes subsequent category reads', async ({ page }) => {
  const { calls } = await setup(page)
  await page.getByRole('button', { name: 'Nuevo producto', exact: true }).click()
  await page.getByLabel('Nombre', { exact: true }).fill('UNSAVED ALPHA')
  await page.getByLabel('Tienda', { exact: true }).selectOption('3')
  await expect(page.getByRole('button', { name: 'Nuevo producto', exact: true })).toBeVisible()
  await expect(page.locator('input[value="UNSAVED ALPHA"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Categorias', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Categorias', exact: true })).toBeVisible()
  expect(calls.products).toContain(3); expect(calls.categories).toContain(3)
})

test('late product response cannot populate the next store', async ({ page }) => {
  const { calls, behavior } = await setup(page)
  await page.getByLabel('Tienda', { exact: true }).selectOption('3')
  await expect(page.getByRole('button', { name: 'Nuevo producto', exact: true })).toBeVisible()
  behavior.productDelay = 350
  const before = calls.products.filter(id => id === 1).length
  await page.getByLabel('Tienda', { exact: true }).selectOption('1')
  await expect.poll(() => calls.products.filter(id => id === 1).length).toBeGreaterThan(before)
  await page.getByLabel('Tienda', { exact: true }).selectOption('3')
  await expect(page.getByRole('button', { name: 'Nuevo producto', exact: true })).toBeVisible()
  // Wait beyond the intentionally delayed old response, not just the new store's render.
  await page.waitForTimeout(450)
  await expect(page.getByText('DELAYED ALPHA PRODUCT')).toHaveCount(0)
  await expect(page.getByLabel('Tienda', { exact: true })).toHaveValue('3')
})

test('tab focus does not discard selected store or navigation', async ({ page }) => {
  await setup(page, 'super_admin')
  await page.getByLabel('Tienda', { exact: true }).selectOption('2')
  await page.getByRole('button', { name: 'Staff Deshabilitado' }).click()
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(page.getByLabel('Tienda', { exact: true })).toHaveValue('2')
  await expect(page.getByRole('heading', { name: 'Staff', exact: true })).toBeVisible()
})

test('failed module write does not change flags and requires explicit reload', async ({ page }) => {
  const { behavior, db, calls } = await setup(page, 'super_admin')
  behavior.failSave = true
  await page.getByLabel('Staff', { exact: true }).check()
  await page.getByRole('button', { name: 'Guardar cambios' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  expect(db.get(1)?.staff_enabled).toBe(false)
  behavior.failSave = false
  await page.getByRole('button', { name: 'Recargar configuracion' }).click()
  await expect(page.getByLabel('Staff', { exact: true })).not.toBeChecked()
  expect(calls.writes).toBe(1)
})

test('failed or concurrent save never silently overwrites; requires reload', async ({ page }) => {
  const { behavior, calls } = await setup(page, 'super_admin')
  behavior.conflict = true
  await page.getByLabel('Staff', { exact: true }).check()
  await page.getByRole('button', { name: 'Guardar cambios' }).click()
  await expect(page.getByRole('alert')).toContainText('No se confirmo')
  await expect(page.getByRole('button', { name: 'Guardar cambios' })).toBeDisabled()
  expect(calls.writes).toBe(1)
})

test('store switch ignores delayed flags from previous store', async ({ page }) => {
  const { behavior, calls } = await setup(page, 'super_admin')
  await expect(page.getByRole('heading', { name: 'Modulos de la tienda' })).toBeVisible()
  behavior.delay = 400
  await page.getByRole('button', { name: 'Recargar configuracion' }).click()
  await expect.poll(() => calls.featureReads.filter(id => id === 1).length).toBeGreaterThan(1)
  await page.getByLabel('Tienda', { exact: true }).selectOption('2')
  await expect(page.getByRole('heading', { name: 'Modulos de la tienda' })).toBeVisible()
  await expect(page.getByLabel('Servicios', { exact: true })).not.toBeChecked()
  await expect(page.getByRole('button', { name: 'Productos', exact: true })).toHaveCount(0)
  expect(calls.products).not.toContain(2)
})

test('read failure fails closed, never becomes legacy access', async ({ page }) => {
  const { behavior } = await setup(page, 'super_admin')
  behavior.failRead = true
  await page.getByLabel('Tienda', { exact: true }).selectOption('3')
  await expect(page.getByText('No se pudo consultar la configuracion de modulos.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Productos', exact: true })).toHaveCount(0)
  await expect(page.getByText(/acceso de compatibilidad/)).toHaveCount(0)
})

test('store selection survives navigation and mobile has no overflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await setup(page, 'super_admin')
  await page.getByLabel('Tienda', { exact: true }).selectOption('2')
  await page.getByRole('button', { name: 'Staff Deshabilitado' }).click()
  await page.getByRole('button', { name: 'Modulos', exact: true }).click()
  await expect(page.getByLabel('Tienda', { exact: true })).toHaveValue('2')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/admin-modules-mobile.png', fullPage: true })
  await page.setViewportSize({ width: 1280, height: 800 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/admin-modules-desktop.png', fullPage: true })
})
