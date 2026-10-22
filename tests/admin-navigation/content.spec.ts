import { test, expect, type Page } from '@playwright/test'
import type { ModuleKind, ModuleRecord } from '../../src/types/database'

const owner = '11111111-1111-4111-8111-111111111111'
const storeRows = [
  { id: 1, name: 'Alpha', slug: 'alpha', owner_user_id: owner },
  { id: 2, name: 'Beta', slug: 'beta', owner_user_id: '22222222-2222-4222-8222-222222222222' },
  { id: 3, name: 'Gamma', slug: 'gamma', owner_user_id: owner },
]
async function setup(page: Page, kind: ModuleKind = 'services', role = 'admin') {
  const metadata = { global_role: role }
  await page.addInitScript(({ owner, metadata }) => {
    const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_')
    localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: `${encode({ alg: 'none' })}.${encode({ sub: owner, exp: Date.now() / 1000 + 3600 })}.local`, refresh_token: 'local-only', expires_at: Date.now() / 1000 + 3600,
      user: { id: owner, email: 'owner@example.com', app_metadata: metadata, user_metadata: {}, aud: 'authenticated' } }))
  }, { owner, metadata })
  const flags = new Map(storeRows.map(s => [s.id, { store_id: s.id, commerce_enabled: false, services_enabled: s.id !== 2, staff_enabled: s.id !== 2 }]))
  const rows: Record<ModuleKind, ModuleRecord[]> = { services: [], staff: [] }
  for (const module of ['services', 'staff'] as const) for (const id of [1, 2, 3]) {
    const row = { id: `${module === 'staff' ? '20000000' : '10000000'}-0000-4000-8000-00000000000${id}`, store_id: id, title: module === 'staff' ? 'Doctor' : `${id === 1 ? 'Alpha' : id === 2 ? 'Beta' : 'Gamma'} Service`,
      description: null, image_url: null, sort_order: 0, is_active: true }
    rows[module].push(module === 'staff' ? { ...row, name: `${id === 1 ? 'Alpha' : id === 2 ? 'Beta' : 'Gamma'} Person` } : row)
  }
  const files = new Map<string, Buffer>()
  const calls = { create: 0, update: 0, link: 0, remove: 0, upload: 0, deletes: 0, foreign: 0, paths: [] as string[], reads: [] as number[] }
  const behavior = { failList: false, failWrite: false, failStorage: false, failLink: 0, loseCreate: false, loseUpload: false, loseLink: false, conflictImage: false, delayedStore: 0 }
  let nextId = 10
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url())
    if (url.origin !== 'http://127.0.0.1:5197') { calls.foreign++; return route.abort() }
    const respond = (json: unknown, status = 200) => route.fulfill({ status, json })
    if (url.pathname === '/auth/v1/user') return respond({ id: owner, email: 'owner@example.com', app_metadata: metadata, user_metadata: {} })
    if (url.pathname === '/rest/v1/stores') return respond(storeRows.filter(s => role === 'super_admin' || s.owner_user_id === owner))
    if (url.pathname === '/rest/v1/store_features') return respond([flags.get(Number(url.searchParams.get('store_id')?.slice(3)))])
    const module = url.pathname.slice('/rest/v1/'.length) as ModuleKind
    if (url.pathname.startsWith('/rest/v1/') && ['services', 'staff'].includes(module)) {
      const body = req.method() === 'GET' || req.method() === 'DELETE' ? null : req.postDataJSON()
      const storeId = Number(url.searchParams.get('store_id')?.slice(3) ?? body?.store_id)
      const id = url.searchParams.get('id')?.slice(3)
      const allowed = role === 'super_admin' || storeRows.find(s => s.id === storeId)?.owner_user_id === owner && flags.get(storeId)?.[module === 'staff' ? 'staff_enabled' : 'services_enabled']
      const result = (data: ModuleRecord[]) => req.headers().accept?.includes('vnd.pgrst.object')
        ? data.length === 1 ? respond(data[0]) : respond({ code: 'PGRST116', message: 'local empty' }, 406)
        : respond(data)
      if (req.method() === 'GET') {
        calls.reads.push(storeId)
        if (behavior.failList) return respond({ message: 'local failure' }, 500)
        const data = rows[module].filter(row => allowed && row.store_id === storeId && (!id || row.id === id)).map(row => ({ ...row }))
          .sort((a, b) => (a.sort_order === null ? b.sort_order === null ? 0 : 1 : b.sort_order === null ? -1 : a.sort_order - b.sort_order) || a.id.localeCompare(b.id))
        expect(url.searchParams.has('is_active')).toBe(false)
        if (!id) expect(url.searchParams.get('order')).toBe('sort_order.asc,id.asc')
        if (behavior.delayedStore === storeId) await new Promise(resolve => setTimeout(resolve, 350))
        return result(data)
      }
      if (behavior.failWrite || !allowed) return respond({ code: '42501', message: 'local RLS denied' }, 403)
      if (req.method() === 'POST') {
        calls.create++
        expect(body).not.toHaveProperty('id'); expect(body).not.toHaveProperty('image_url')
        expect(Object.hasOwn(body, 'is_active')).toBe(true)
        const next = { ...body, id: `30000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`, image_url: null }
        rows[module].push(next)
        if (behavior.loseCreate) { behavior.loseCreate = false; return route.abort() }
        return result([next])
      }
      expect(id).toBeTruthy()
      const row = rows[module].find(row => row.store_id === storeId && row.id === id)
      if (req.method() === 'DELETE') {
        calls.deletes++
        rows[module] = rows[module].filter(row => !(row.store_id === storeId && row.id === id))
        return respond(row ? [{ id: row.id }] : [])
      }
      expect(body).not.toHaveProperty('id'); expect(body).not.toHaveProperty('store_id')
      if ('image_url' in body) {
        calls.link++
        if (behavior.failLink-- > 0) return respond({ message: 'local image link failure' }, 500)
        if (url.searchParams.get('image_url') !== (row?.image_url == null ? 'is.null' : `eq.${row.image_url}`)) return result([])
      } else calls.update++
      if (!row) return result([])
      Object.assign(row, body)
      if (behavior.loseLink && 'image_url' in body) { behavior.loseLink = false; return route.abort() }
      return result([{ ...row }])
    }
    if (url.pathname.startsWith('/storage/v1/object/')) {
      const path = decodeURIComponent(url.pathname.replace('/storage/v1/object/', '').replace(/^(public|authenticated)\//, ''))
      if (req.method() === 'DELETE' || req.method() === 'PUT') { calls.remove++; return route.abort() }
      if (req.method() === 'POST') {
        calls.upload++; calls.paths.push(path)
        expect(req.headers()['x-upsert']).toBe('false')
        if (behavior.failStorage) return respond({ message: 'bucket not configured' }, 403)
        expect(files.has(path)).toBe(false)
        const form = await new Response(new Uint8Array(req.postDataBuffer()!).buffer, { headers: { 'Content-Type': req.headers()['content-type'] } }).formData()
        const blob = [...form.values()].find(value => value instanceof Blob) as Blob
        files.set(path, Buffer.from(await blob.arrayBuffer()))
        if (behavior.conflictImage) rows[kind].find(row => row.store_id === 1)!.image_url = '/other-session.webp'
        if (behavior.loseUpload) { behavior.loseUpload = false; return route.abort() }
        return respond({ Key: path })
      }
      return files.has(path) ? route.fulfill({ status: 200, body: files.get(path), contentType: 'image/webp' }) : respond({ message: 'absent' }, 404)
    }
    if (url.pathname.startsWith('/rest/')) throw new Error(`Unexpected local content API: ${url.pathname}`)
    return route.continue()
  })
  await page.goto('/tests/admin-navigation/browser.html')
  await page.getByRole('button', { name: kind === 'staff' ? 'Staff' : 'Servicios', exact: true }).click()
  await expect(page.getByRole('button', { name: kind === 'staff' ? 'Nuevo profesional' : 'Nuevo servicio', exact: true })).toBeEnabled()
  return { rows, flags, files, calls, behavior }
}
async function png(page: Page, width = 64, height = 64) {
  return Buffer.from(await page.evaluate(async ({ width, height }) => {
    const c = document.createElement('canvas'); c.width = width; c.height = height
    c.getContext('2d')!.fillRect(0, 0, width, height)
    const blob = await new Promise<Blob>(resolve => c.toBlob(blob => resolve(blob!), 'image/png'))
    return [...new Uint8Array(await blob.arrayBuffer())]
  }, { width, height }))
}
async function select(page: Page, width = 64, height = 64, originalMB?: number) {
  const buffer = await png(page, width, height)
  const input = page.getByLabel('Imagen', { exact: true })
  if (originalMB) {
    await input.evaluate((element, { bytes, originalMB }) => {
      const file = new File([new Uint8Array(bytes), new Uint8Array(originalMB * 1024 * 1024 - bytes.length)], 'large.png', { type: 'image/png' })
      const data = new DataTransfer(); data.items.add(file)
      ;(element as HTMLInputElement).files = data.files
      element.dispatchEvent(new Event('change', { bubbles: true }))
    }, { bytes: [...buffer], originalMB })
  } else await input.setInputFiles({ name: 'local.png', mimeType: 'image/png', buffer })
  await expect(page.getByText('Preparando imagen...')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeEnabled()
}

for (const kind of ['services', 'staff'] as const) {
  const person = kind === 'staff'
  test(`${kind}: CRUD defaults to active and preserves explicit inactive edits with tenant scoped requests`, async ({ page }) => {
    const f = await setup(page, kind)
    await page.getByRole('button', { name: person ? 'Nuevo profesional' : 'Nuevo servicio', exact: true }).click()
    await expect(page.getByLabel('Activo - Publicar', { exact: true })).toBeChecked()
    await page.getByRole('button', { name: 'Guardar', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('obligatorio')
    expect(f.calls.create).toBe(0)
    await page.getByLabel(person ? 'Nombre' : 'Titulo', { exact: true }).fill('New Local')
    if (person) await page.getByLabel('Cargo o especialidad').fill('Specialist')
    await page.getByRole('button', { name: 'Guardar', exact: true }).dblclick()
    await expect(page.getByRole('heading', { name: 'New Local', exact: true })).toBeVisible()
    expect(f.calls.create).toBe(1)
    expect(f.rows[kind].find(row => (row.name ?? row.title) === 'New Local')?.is_active).toBe(true)
    await page.getByRole('button', { name: 'Editar New Local', exact: true }).click()
    await page.getByLabel(person ? 'Nombre' : 'Titulo', { exact: true }).fill('Changed Local')
    await page.getByLabel('Activo - Publicar', { exact: true }).uncheck()
    await page.getByRole('button', { name: 'Guardar', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Changed Local' })).toBeVisible()
    expect(f.rows[kind].find(row => (row.name ?? row.title) === 'Changed Local')?.is_active).toBe(false)
    await page.getByRole('button', { name: 'Editar Changed Local', exact: true }).click()
    await expect(page.getByLabel('Inactivo - Borrador', { exact: true })).not.toBeChecked()
    await page.getByLabel('Inactivo - Borrador').check()
    await page.getByRole('button', { name: 'Guardar', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Changed Local' })).toBeVisible()
    await page.getByRole('button', { name: 'Desactivar Changed Local', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Activar Changed Local', exact: true })).toBeVisible()
    page.once('dialog', dialog => dialog.dismiss())
    await page.getByRole('button', { name: 'Eliminar Changed Local', exact: true }).click()
    expect(f.calls.deletes).toBe(0)
    page.once('dialog', dialog => dialog.accept())
    await page.getByRole('button', { name: 'Eliminar Changed Local', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Changed Local' })).toHaveCount(0)
    expect(f.calls.deletes).toBe(1); expect(f.calls.foreign).toBe(0)
  })
  test(`${kind}: images upload, replacement and removal retain all Storage objects`, async ({ page }) => {
    const f = await setup(page, kind)
    await page.getByRole('button', { name: `Editar Alpha ${person ? 'Person' : 'Service'}`, exact: true }).click()
    await select(page, 2400, 1600, kind === 'staff' ? 60 : 30)
    await page.getByRole('button', { name: 'Guardar', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('guardado correctamente')
    expect(f.calls.upload).toBe(1); expect(f.calls.update).toBe(0)
    const dimensions = await page.evaluate(async bytes => {
      const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/webp' }))
      const result = [image.width, image.height]; image.close(); return result
    }, [...f.files.values().next().value!])
    expect(dimensions).toEqual([1200, 800])
    expect(f.calls.paths[0]).toMatch(new RegExp(`^${person ? 'staff' : 'service'}-images/1-alpha/${kind}/[a-f0-9-]+-alpha-.*principal-[a-f0-9-]+\\.webp$`))
    await page.getByRole('button', { name: `Editar Alpha ${person ? 'Person' : 'Service'}`, exact: true }).click()
    await select(page)
    await page.getByRole('button', { name: 'Guardar', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('guardado correctamente')
    expect(f.files.size).toBe(2)
    await page.getByRole('button', { name: `Editar Alpha ${person ? 'Person' : 'Service'}`, exact: true }).click()
    await page.getByRole('button', { name: 'Quitar imagen', exact: true }).click()
    await page.getByRole('button', { name: 'Guardar', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('guardado correctamente')
    expect(f.rows[kind].find(row => row.store_id === 1)?.image_url).toBe(null)
    expect(f.files.size).toBe(2); expect(f.calls.remove).toBe(0)
  })
}

test('create with unavailable Storage retains real ID; removing selection saves without another INSERT', async ({ page }) => {
  const f = await setup(page)
  f.behavior.failStorage = true
  await page.getByRole('button', { name: 'Nuevo servicio', exact: true }).click()
  await page.getByLabel('Titulo', { exact: true }).fill('Storage Pending')
  await select(page)
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('registro conserva su ID')
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Storage')
  expect(f.calls.create).toBe(1); expect(f.calls.upload).toBe(1)
  await page.getByRole('button', { name: 'Quitar imagen', exact: true }).click()
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('guardado correctamente')
  expect(f.calls.create).toBe(1); expect(f.calls.update).toBe(0)
})

test('lost committed INSERT response blocks blind retry; refresh recovers the existing record for editing', async ({ page }) => {
  const f = await setup(page)
  f.behavior.loseCreate = true
  await page.getByRole('button', { name: 'Nuevo servicio', exact: true }).click()
  await page.getByLabel('Titulo', { exact: true }).fill('Late Confirmed')
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('No se confirmo la creacion')
  await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeDisabled()
  expect(f.calls.create).toBe(1)
  await page.getByRole('button', { name: 'Cerrar formulario', exact: true }).click()
  await page.getByRole('button', { name: 'Actualizar', exact: true }).click()
  await page.getByRole('button', { name: 'Editar Late Confirmed', exact: true }).click()
  await page.getByLabel('Descripcion', { exact: true }).fill('Recovered')
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('guardado correctamente')
  expect(f.calls.create).toBe(1); expect(f.calls.update).toBe(1)
})

for (const scenario of ['link-failure', 'lost-upload', 'lost-link', 'image-conflict'] as const) {
  test(`${scenario}: no second upload or unsafe image overwrite`, async ({ page }) => {
    const f = await setup(page)
    f.behavior.failLink = scenario === 'link-failure' ? 1 : 0
    f.behavior.loseUpload = scenario === 'lost-upload'
    f.behavior.loseLink = scenario === 'lost-link'
    f.behavior.conflictImage = scenario === 'image-conflict'
    await page.getByRole('button', { name: 'Editar Alpha Service', exact: true }).click()
    await select(page)
    await page.getByRole('button', { name: 'Guardar', exact: true }).click()
    if (scenario === 'link-failure') {
      await expect(page.getByRole('alert')).toBeVisible()
      await page.getByRole('button', { name: 'Guardar', exact: true }).click()
    }
    if (scenario === 'image-conflict') {
      await expect(page.getByRole('alert')).toContainText('Otra sesion')
      expect(f.rows.services[0].image_url).toBe('/other-session.webp')
    } else await expect(page.getByRole('status')).toContainText('guardado correctamente')
    expect(f.calls.upload).toBe(1); expect(f.calls.remove).toBe(0)
  })
}

test('invalid image leaves prior selection usable and performs no writes', async ({ page }) => {
  const f = await setup(page)
  await page.getByRole('button', { name: 'Editar Alpha Service', exact: true }).click()
  await select(page)
  await page.getByLabel('Imagen', { exact: true }).setInputFiles({ name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('not an image') })
  await expect(page.getByRole('alert')).toBeVisible()
  expect(f.calls.update + f.calls.upload + f.calls.create).toBe(0)
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('guardado correctamente')
  expect(f.calls.upload).toBe(1)
})

test('disabled module backend denial preserves stored record; Super Admin manages disabled foreign module', async ({ page }) => {
  const f = await setup(page)
  await page.getByRole('button', { name: 'Editar Alpha Service', exact: true }).click()
  await page.getByLabel('Titulo', { exact: true }).fill('Denied')
  f.flags.get(1)!.services_enabled = false
  await page.getByRole('button', { name: 'Guardar', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('modulo sigue habilitado')
  expect(f.rows.services[0].title).toBe('Alpha Service')
})

test('super admin can edit disabled module in another tenant without Commerce access', async ({ page }) => {
  await setup(page, 'staff', 'super_admin')
  await page.getByLabel('Tienda', { exact: true }).selectOption('2')
  await page.getByRole('button', { name: 'Staff Deshabilitado' }).click()
  await expect(page.getByRole('button', { name: 'Editar Beta Person', exact: true })).toBeVisible()
  await expect(page.getByText('Modulo deshabilitado. Solo Super Admin puede administrar este contenido.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Productos', exact: true })).toHaveCount(0)
})

test('switching stores clears form and ignores delayed old response', async ({ page }) => {
  const f = await setup(page)
  await page.getByRole('button', { name: 'Editar Alpha Service', exact: true }).click()
  await page.getByLabel('Titulo', { exact: true }).fill('UNSAVED ALPHA')
  await select(page)
  await page.getByLabel('Tienda', { exact: true }).selectOption('3')
  await expect(page.getByRole('button', { name: 'Editar Gamma Service', exact: true })).toBeVisible()
  await expect(page.getByLabel('Titulo', { exact: true })).toHaveCount(0)
  f.behavior.delayedStore = 1
  await page.getByLabel('Tienda', { exact: true }).selectOption('1')
  await expect.poll(() => f.calls.reads.filter(id => id === 1).length).toBeGreaterThan(1)
  await page.getByLabel('Tienda', { exact: true }).selectOption('3')
  await expect(page.getByRole('button', { name: 'Editar Gamma Service', exact: true })).toBeVisible()
  await page.waitForTimeout(450)
  await expect(page.getByText('Alpha Service', { exact: true })).toHaveCount(0)
  expect(f.calls.upload + f.calls.create + f.calls.update).toBe(0)
})

test('load error has retry; stable priority order and mobile layout', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  const f = await setup(page)
  f.behavior.failList = true
  await page.getByRole('button', { name: 'Actualizar', exact: true }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  f.behavior.failList = false
  f.rows.services.push({ ...f.rows.services[0], id: '00000000-0000-4000-8000-000000000001', title: 'First Draft', sort_order: -1, is_active: false })
  await page.getByRole('button', { name: 'Actualizar', exact: true }).click()
  await expect(page.locator('main li h4')).toHaveText(['First Draft', 'Alpha Service'])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button', { name: 'Nuevo servicio', exact: true }).click()
  await page.screenshot({ path: 'test-results/content-mobile.png', fullPage: true })
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(page.getByRole('heading', { name: 'Kafka Admin', exact: true })).toHaveCount(1)
  await page.evaluate(async () => {
    window.scrollTo(0, 0)
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/content-desktop.png' })
})
