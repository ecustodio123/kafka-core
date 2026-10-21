import { expect, test, type Page } from '@playwright/test'

const base = 'http://127.0.0.1:5197'
const owner = '11111111-1111-4111-8111-111111111111'
function token(method: string, sub = owner) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub, session_id: '22222222-2222-4222-8222-222222222222', amr: [{ method }], exp: Math.floor(Date.now() / 1000) + 3600 })}.bG9jYWw`
}

async function fixture(page: Page, options: { cached?: boolean; method?: string; assigned?: boolean; role?: string | null } = {}) {
  const inviteToken = token(options.method ?? 'otp')
  const passwordToken = token('password')
  const user = { id: owner, aud: 'authenticated', email: 'invited@example.com',
    invited_at: '2026-10-20T00:00:00Z', email_confirmed_at: '2026-10-20T00:01:00Z',
    app_metadata: options.role === null ? {} : { global_role: options.role ?? 'admin' }, user_metadata: {} }
  const session = { user, access_token: passwordToken, refresh_token: 'local-test-only', token_type: 'bearer', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600 }
  if (options.cached) await page.addInitScript(session => {
    if (!sessionStorage.getItem('local-seeded')) {
      localStorage.setItem('sb-127-auth-token', JSON.stringify(session))
      sessionStorage.setItem('local-seeded', 'true')
    }
  }, session)
  const calls = { updates: 0, stores: 0, logins: 0, other: 0 }
  const behavior = { rejectUser: false, failSave: false, delaySave: 0 }
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url())
    if (url.origin !== base) { calls.other++; return route.abort() }
    if (req.isNavigationRequest()) return route.continue()
    if (url.pathname === '/auth/v1/user') {
      if (behavior.rejectUser) return route.fulfill({ status: 401, json: { code: 'bad_jwt', message: 'LOCAL invalid token' } })
      expect([`Bearer ${inviteToken}`, `Bearer ${passwordToken}`]).toContain(req.headers().authorization)
      if (req.method() === 'PUT') {
        calls.updates++
        expect(req.postDataJSON()).toEqual({ password: 'local-test-password', code_challenge: null, code_challenge_method: null })
        if (behavior.delaySave) await new Promise(resolve => setTimeout(resolve, behavior.delaySave))
        if (behavior.failSave) return route.fulfill({ status: 422, headers: { 'x-supabase-api-version': '2024-01-01' }, json: { code: 'weak_password', message: 'LOCAL provider error not reflected' } })
      }
      return route.fulfill({ json: user })
    }
    if (url.pathname === '/auth/v1/token') {
      expect(url.searchParams.get('grant_type')).toBe('password')
      calls.logins++
      return route.fulfill({ json: session })
    }
    if (url.pathname === '/auth/v1/logout') return route.fulfill({ json: {} })
    if (url.pathname === '/rest/v1/stores') {
      calls.stores++
      return route.fulfill({ json: options.assigned ? [{ id: 1, name: 'Local Store', slug: 'local', owner_user_id: owner }] : [] })
    }
    if (url.pathname === '/rest/v1/store_features') return route.fulfill({ json: [{ store_id: 1, services_enabled: false, staff_enabled: false, commerce_enabled: false }] })
    if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/rest/') || url.pathname.startsWith('/storage/')) {
      calls.other++; return route.abort()
    }
    return route.continue()
  })
  const fragment = new URLSearchParams({ type: 'invite', access_token: inviteToken, refresh_token: 'local-test-only', expires_in: '3600', token_type: 'bearer' })
  return { calls, behavior, user, inviteToken, url: `/#${fragment}`, directUrl: `/auth/accept-invite#${fragment}` }
}

async function fill(page: Page, confirmation = 'local-test-password') {
  await page.getByLabel('Contrasena nueva', { exact: true }).fill('local-test-password')
  await page.getByLabel('Confirmar contrasena', { exact: true }).fill(confirmation)
}

test('Dashboard Site URL invite is gated, cleaned, confirmed and never grants store access', async ({ page }) => {
  const f = await fixture(page, { role: null })
  await page.goto(f.url)
  await expect(page.getByLabel('Contrasena nueva', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(`${base}/auth/accept-invite`)
  expect(f.calls.stores).toBe(0)
  await fill(page)
  await page.getByRole('button', { name: 'Guardar contrasena', exact: true }).click()
  await expect(page.getByText('Tu contrasena se guardo correctamente.')).toBeVisible()
  expect(f.calls.updates).toBe(1); expect(f.calls.stores).toBe(0)
  await expect(page.getByLabel('Tienda', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Continuar al panel' }).click()
  await expect(page.getByText('Tu usuario esta autenticado, pero aun no tiene una tienda asignada. Contacta a Kafka.')).toBeVisible()
  expect(f.calls.other).toBe(0)
})

test('dedicated callback preserves role/store rules after password confirmation', async ({ page }) => {
  const f = await fixture(page, { assigned: true })
  await page.goto(f.directUrl)
  await fill(page)
  await page.getByRole('button', { name: 'Guardar contrasena', exact: true }).click()
  await page.getByRole('button', { name: 'Continuar al panel' }).click()
  await expect(page.getByLabel('Tienda', { exact: true })).toHaveValue('1')
  await expect(page.getByRole('button', { name: 'Productos', exact: true })).toHaveCount(0)
  expect(f.calls.updates).toBe(1); expect(f.calls.other).toBe(0)
})

test('mismatched passwords and short passwords make zero Auth writes; visibility is local only', async ({ page }) => {
  const f = await fixture(page)
  await page.goto(f.url)
  await fill(page, 'different-password')
  await page.getByRole('button', { name: 'Guardar contrasena', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('no coinciden')
  await page.getByRole('button', { name: 'Mostrar contrasenas' }).click()
  await expect(page.getByLabel('Contrasena nueva', { exact: true })).toHaveAttribute('type', 'text')
  await page.getByLabel('Contrasena nueva', { exact: true }).fill('short')
  await page.getByLabel('Confirmar contrasena', { exact: true }).fill('short')
  await page.getByRole('button', { name: 'Guardar contrasena', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('8 caracteres')
  expect(f.calls.updates).toBe(0); expect(f.calls.stores).toBe(0)
})

test('expired link cannot use cached Super Admin session or disclose provider error', async ({ page }) => {
  const f = await fixture(page, { cached: true, role: 'super_admin', assigned: true })
  await page.goto('/#error=access_denied&error_code=otp_expired&error_description=PRIVATE_LOCAL_ERROR')
  await expect(page.getByRole('alert')).toContainText('ha expirado')
  await expect(page).toHaveURL(`${base}/auth/accept-invite`)
  await expect(page.getByText('PRIVATE_LOCAL_ERROR')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Guardar contrasena' })).toHaveCount(0)
  expect(f.calls.stores).toBe(0); expect(f.calls.updates).toBe(0)
  await page.getByRole('button', { name: 'Volver al inicio' }).click()
  await expect(page.getByLabel('Tienda', { exact: true })).toHaveValue('1')
})

test('rejected callback tokens do not fall back to an old session', async ({ page }) => {
  const f = await fixture(page)
  f.behavior.rejectUser = true
  await page.goto(f.url)
  await expect(page.getByRole('alert')).toContainText('no es valida')
  expect(f.calls.updates).toBe(0); expect(f.calls.stores).toBe(0)
  await expect(page).toHaveURL(`${base}/auth/accept-invite`)
})

test('direct route requires an invitation session, not merely a password login', async ({ page }) => {
  const f = await fixture(page, { cached: true })
  await page.goto('/auth/accept-invite')
  await expect(page.getByRole('alert')).toContainText('no es valida')
  expect(f.calls.updates).toBe(0); expect(f.calls.stores).toBe(0)
})

test('direct route without a session has no password form and no writes', async ({ page }) => {
  const f = await fixture(page)
  await page.goto('/auth/accept-invite')
  await expect(page.getByRole('alert')).toContainText('no es valida')
  await expect(page.getByLabel('Contrasena nueva', { exact: true })).toHaveCount(0)
  expect(f.calls.stores).toBe(0); expect(f.calls.updates).toBe(0)
})

test('forged invitation type cannot turn a normal password session into an invite', async ({ page }) => {
  const f = await fixture(page, { method: 'password' })
  await page.goto(f.url)
  await expect(page.getByRole('alert')).toContainText('no es valida')
  await expect(page.getByLabel('Contrasena nueva', { exact: true })).toHaveCount(0)
  expect(f.calls.updates).toBe(0); expect(f.calls.stores).toBe(0)
})

test('sign out during setup clears password fields and cannot update another session', async ({ page }) => {
  const f = await fixture(page)
  await page.goto(f.url)
  await fill(page)
  await page.evaluate(async () => {
    const modulePath = '/src/lib/supabase.ts'
    const { getSupabaseClient } = await import(modulePath)
    await getSupabaseClient().auth.signOut({ scope: 'local' })
  })
  await expect(page.getByRole('alert')).toContainText('sesion cambio o termino')
  await expect(page.getByLabel('Contrasena nueva', { exact: true })).toHaveCount(0)
  expect(f.calls.updates).toBe(0)
})

test('pending refresh at root cannot bypass setup; no password or token is stored outside SDK', async ({ page }) => {
  const f = await fixture(page)
  await page.goto(f.url)
  await expect(page.getByLabel('Contrasena nueva', { exact: true })).toBeVisible()
  await fill(page)
  await page.goto('/')
  await expect(page.getByLabel('Contrasena nueva', { exact: true })).toHaveValue('')
  await expect(page).toHaveURL(`${base}/auth/accept-invite`)
  const marker = await page.evaluate(() => localStorage.getItem('kafka-admin:pending-invite'))
  expect(JSON.parse(marker!)).toEqual({ userId: owner, sessionId: '22222222-2222-4222-8222-222222222222' })
  expect(marker).not.toContain(f.inviteToken); expect(marker).not.toContain('local-test-password')
  expect(f.calls.stores).toBe(0)
})

test('USER_UPDATED and duplicate submit do not skip success or write twice', async ({ page }) => {
  const f = await fixture(page)
  f.behavior.delaySave = 250
  await page.goto(f.url)
  await fill(page)
  await page.getByRole('button', { name: 'Guardar contrasena', exact: true }).dblclick()
  await expect(page.getByRole('button', { name: 'Continuar al panel' })).toBeVisible()
  expect(f.calls.updates).toBe(1); expect(f.calls.stores).toBe(0)
  await page.reload()
  await expect(page.getByText('No tienes tiendas asociadas.')).toBeVisible()
})

test('provider policy failure is safe and leaves invitation gated', async ({ page }) => {
  const f = await fixture(page)
  f.behavior.failSave = true
  await page.goto(f.url)
  await fill(page)
  await page.getByRole('button', { name: 'Guardar contrasena', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('contrasena mas segura')
  await expect(page.getByText('LOCAL provider error not reflected')).toHaveCount(0)
  expect(f.calls.stores).toBe(0)
  await expect(page.getByRole('button', { name: 'Continuar al panel' })).toHaveCount(0)
})

test('existing password login still works without invitation setup', async ({ page }) => {
  const f = await fixture(page)
  await page.goto('/')
  await page.getByLabel('Correo', { exact: true }).fill('invited@example.com')
  await page.getByLabel('Contrasena', { exact: true }).fill('existing-password')
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await expect(page.getByText('No tienes tiendas asociadas.')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Crea tu contrasena' })).toHaveCount(0)
  expect(f.calls.logins).toBe(1); expect(f.calls.updates).toBe(0)
})

test('mobile invitation layout is responsive', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  const f = await fixture(page)
  await page.goto(f.url)
  await expect(page.getByLabel('Contrasena nueva', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  // Never capture filled passwords or URL credentials.
  await page.screenshot({ path: 'test-results/accept-invite-mobile.png', fullPage: true })
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.screenshot({ path: 'test-results/accept-invite-desktop.png', fullPage: true })
})
