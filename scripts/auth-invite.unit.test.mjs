import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClient } from '@supabase/supabase-js'
import { cleanAuthReturn, createInviteFlow, createInvitePasswordWriter, isInviteSession, passwordError, readAuthReturn } from '../src/features/auth/inviteFlow.ts'

function fixture(method = 'otp') {
  const user = { id: 'owner', invited_at: '2026-10-20T00:00:00Z', email_confirmed_at: '2026-10-20T00:01:00Z' }
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', session_id: 'local-session', amr: [{ method }], exp: Date.now() / 1000 + 3600 })).toString('base64url')}.local`
  const session = { user, access_token: token }
  const map = new Map()
  const storage = { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) }
  const calls = { verify: 0, update: 0 }
  const client = { auth: {
    getSession: async () => ({ data: { session }, error: null }),
    getUser: async token => { assert.equal(token, session.access_token); calls.verify++; return { data: { user }, error: null } },
    updateUser: async input => { assert.deepEqual(Object.keys(input), ['password']); calls.update++; return { data: { user }, error: null } },
  } }
  const callback = readAuthReturn(`https://kafka-core.pages.dev/#type=invite&access_token=${token}`)
  const paths = []
  const writer = async (verified, password, assertCurrent) => {
    assert.equal(verified.access_token, token)
    await assertCurrent()
    return client.auth.updateUser({ password })
  }
  const flow = createInviteFlow(callback, storage, path => paths.push(path), writer)
  return { user, token, session, map, storage, calls, client, flow, paths, writer }
}

test('production and localhost implicit returns are recognized without assuming every sign in is invited', () => {
  for (const host of ['https://kafka-core.pages.dev', 'http://127.0.0.1:5174']) {
    assert.equal(readAuthReturn(`${host}/#access_token=local&type=invite`).invite, true)
    assert.equal(readAuthReturn(`${host}/auth/accept-invite#access_token=local&type=invite`).route, true)
    assert.equal(readAuthReturn(`${host}/`).invite, false)
    assert.equal(readAuthReturn(`${host}/#type=signup`).invite, false)
  }
})
test('URL cleanup removes sensitive query and fragment without losing harmless query params', () => {
  assert.equal(cleanAuthReturn('https://kafka-core.pages.dev/?code=local&token_hash=local&next=keep#error_description=local&access_token=local', '/auth/accept-invite'), '/auth/accept-invite?next=keep')
  assert.equal(cleanAuthReturn('http://127.0.0.1:5174/#access_token=local&refresh_token=local&type=invite'), '/')
})
test('password confirmation and length are checked without trimming intended passwords', () => {
  assert.match(passwordError('short', 'short'), /8 caracteres/)
  assert.match(passwordError('        ', '        '), /8 caracteres/)
  assert.match(passwordError('long-password', 'different'), /no coinciden/)
  assert.match(passwordError('x'.repeat(129), 'x'.repeat(129)), /128/)
  assert.equal(passwordError(' correct password ', ' correct password '), null)
})
test('verified invitation needs invited/confirmed user and OTP session, not URL or cached user alone', () => {
  const f = fixture()
  assert.equal(isInviteSession(f.session, f.user), true)
  assert.equal(isInviteSession(f.session, { ...f.user, id: 'other' }), false)
  assert.equal(isInviteSession(f.session, { ...f.user, invited_at: undefined }), false)
  assert.equal(isInviteSession(f.session, { ...f.user, email_confirmed_at: undefined }), false)
  const password = fixture('password')
  assert.equal(isInviteSession(password.session, password.user), false)
  for (const body of [null, [], { sub: 'owner', session_id: 5, amr: [null] }]) {
    const malformed = `header.${Buffer.from(JSON.stringify(body)).toString('base64url')}.local`
    assert.equal(isInviteSession({ ...f.session, access_token: malformed }, f.user), false)
  }
})
test('StrictMode shares initialization and marker contains neither tokens nor passwords', async () => {
  const f = fixture()
  const results = await Promise.all([f.flow.initialize(f.client), f.flow.initialize(f.client)])
  assert.equal(results[0], results[1]); assert.equal(f.calls.verify, 1)
  assert.deepEqual(JSON.parse([...f.map.values()][0]), { userId: 'owner', sessionId: 'local-session' })
  assert.ok(![...f.map.values()][0].includes(f.token))
  assert.equal(f.paths.at(-1), '/auth/accept-invite')
})
test('refresh at root preserves pending gate, even after URL was cleaned', async () => {
  const f = fixture(); await f.flow.initialize(f.client)
  const recovered = createInviteFlow(readAuthReturn('https://kafka-core.pages.dev/'), f.storage, () => {}, f.writer)
  assert.equal(recovered.active, true)
  await recovered.initialize(f.client)
})
test('expired/error callback never falls back to an existing session; cleans URL on failure', async () => {
  const f = fixture()
  const flow = createInviteFlow(readAuthReturn('https://kafka-core.pages.dev/#error=access_denied&error_code=otp_expired'), f.storage, p => f.paths.push(p), f.writer)
  await assert.rejects(flow.initialize(f.client), /expirado/)
  assert.equal(f.calls.verify, 0); assert.equal(f.calls.update, 0)
  assert.equal(f.paths.at(-1), '/auth/accept-invite')
})
test('callback token must match SDK session, not a previously cached session', async () => {
  const f = fixture()
  const flow = createInviteFlow(readAuthReturn('https://kafka-core.pages.dev/#type=invite&access_token=another'), f.storage, () => {}, f.writer)
  await assert.rejects(flow.initialize(f.client), /valida/)
  assert.equal(f.calls.update, 0)
})
test('ordinary login and unsigned direct route never grant password setup', async () => {
  const f = fixture('password')
  await assert.rejects(f.flow.initialize(f.client), /valida/)
  const missing = createInviteFlow(readAuthReturn('https://kafka-core.pages.dev/auth/accept-invite'), null, () => {}, f.writer)
  await assert.rejects(missing.initialize({ auth: { getSession: async () => ({ data: { session: null } }) } }), /valida/)
  assert.equal(f.calls.update, 0)
})
test('password save revalidates Auth, persists no secrets and keeps success gated until explicit continue', async () => {
  const f = fixture(); await f.flow.initialize(f.client)
  await f.flow.updatePassword(f.client, 'owner', 'local test password')
  assert.equal(f.calls.verify, 2); assert.equal(f.calls.update, 1)
  assert.equal(f.map.size, 0); assert.equal(f.flow.active, true)
  assert.equal(f.paths.at(-1), '/')
  f.flow.finish(); assert.equal(f.flow.active, false)
})
test('Auth rejection, different account or revoked session cannot update a password', async () => {
  for (const mode of ['revoked', 'account', 'session']) {
    const f = fixture(); await f.flow.initialize(f.client)
    if (mode === 'revoked') f.client.auth.getUser = async () => ({ data: { user: null }, error: { message: 'not logged or reflected' } })
    if (mode === 'account') f.session.user = { ...f.user, id: 'other' }
    if (mode === 'session') f.session.access_token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', session_id: 'new-session', amr: [{ method: 'otp' }] })).toString('base64url')}.local`
    await assert.rejects(f.flow.updatePassword(f.client, 'owner', 'local test password'))
    assert.equal(f.calls.update, 0)
  }
})
test('unsupported PKCE/custom token-hash callbacks fail closed, without inventing a verifier', async () => {
  const f = fixture()
  for (const query of ['code=local', 'token_hash=local&type=invite']) {
    const flow = createInviteFlow(readAuthReturn(`https://kafka-core.pages.dev/auth/accept-invite?${query}`), f.storage, () => {}, f.writer)
    await assert.rejects(flow.initialize(f.client), /valida/)
  }
  assert.equal(f.calls.update, 0)
})

// The production SDK reads mutable storage again inside updateUser(). All HTTP
// below is intercepted; synthetic JWTs are never sent to a Supabase project.
async function sdkFixture(t, options = {}) {
  const endpoint = 'https://supabase.example.test'
  const key = 'local-auth'
  const user = id => ({ id, aud: 'authenticated', role: 'authenticated', email: `${id}@example.test`,
    invited_at: '2026-10-20T00:00:00Z', email_confirmed_at: '2026-10-20T00:01:00Z', app_metadata: {}, user_metadata: {} })
  const session = (id, suffix = 'original', seconds = 3600) => ({
    access_token: `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: id, session_id: `${id}-session`, amr: [{ method: 'otp' }], exp: Math.floor(Date.now() / 1000) + seconds, suffix })).toString('base64url')}.bG9jYWw`,
    refresh_token: 'local-only-refresh', token_type: 'bearer', expires_at: Math.floor(Date.now() / 1000) + 3600, user: user(id),
  })
  const a = session('invite-A', 'original', options.expiry ?? 3600), b = session('account-B'), refreshed = session('invite-A', 'refreshed')
  const tokens = new Map([a, b, refreshed].map(s => [s.access_token, s.user]))
  const values = new Map([[key, JSON.stringify(a)]])
  const initial = JSON.stringify(a)
  const behavior = { onRead: null, onPut: null, rejectUser: false, loseReply: false, failVerify: false, malformedReply: false, inconsistentPrivateUser: false }
  const calls = { writes: [], requests: [], reads: 0 }
  const transport = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    assert.equal(url.href, `${endpoint}/auth/v1/user`, 'no refresh or other HTTP endpoint is permitted')
    const method = init.method ?? 'GET'
    calls.requests.push(method)
    const authenticated = tokens.get(new Headers(init.headers).get('authorization')?.replace(/^Bearer /, ''))
    assert.ok(authenticated, 'only a known synthetic bearer is accepted')
    if (method === 'GET' && behavior.failVerify) throw new Error('local network unavailable')
    if (behavior.rejectUser) return new Response(JSON.stringify({ code: 'bad_jwt', message: 'local rejected session' }), { status: 401 })
    if (method === 'PUT') {
      assert.equal(JSON.parse(init.body).password, 'local-test-password')
      calls.writes.push(authenticated.id)
      await behavior.onPut?.()
      if (behavior.loseReply) throw new Error('local lost committed response')
      if (behavior.malformedReply) return new Response('{}', { status: 200 })
    }
    const responseUser = behavior.inconsistentPrivateUser && calls.requests.length === 3 ? b.user : authenticated
    return new Response(JSON.stringify(responseUser), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const client = createClient(endpoint, 'local-public-fixture', { auth: { storageKey: key,
    storage: { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) },
    autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport } })
  t.after(() => client.auth.dispose())
  const original = client.auth.getSession.bind(client.auth)
  client.auth.getSession = async () => {
    const result = await original()
    calls.reads++
    await behavior.onRead?.(calls.reads)
    return result
  }
  const map = new Map()
  const marker = { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) }
  const writer = options.legacy ? async (_verified, password) => client.auth.updateUser({ password })
    : createInvitePasswordWriter(endpoint, 'local-public-fixture', transport)
  const flow = createInviteFlow(readAuthReturn(`https://kafka-core.pages.dev/#type=invite&access_token=${a.access_token}`), marker, () => {}, writer)
  const switchTo = s => s ? values.set(key, JSON.stringify(s)) : values.delete(key)
  return { flow, client, behavior, calls, a, b, refreshed, switchTo, values, initial, map, key }
}
const save = f => f.flow.updatePassword(f.client, f.a.user.id, 'local-test-password')

test('SDK control reproduces the old vulnerability: global updateUser writes B before detecting mismatch', async t => {
  const f = await sdkFixture(t, { legacy: true })
  await f.flow.initialize(f.client)
  f.behavior.onRead = n => { if (n === 3) f.switchTo(f.b) }
  await assert.rejects(save(f))
  assert.deepEqual(f.calls.writes, ['account-B'])
})
test('SDK isolated writer accepts the verified invitation without changing global storage or persisting another session', async t => {
  const f = await sdkFixture(t)
  await f.flow.initialize(f.client)
  await save(f)
  assert.deepEqual(f.calls.writes, ['invite-A'])
  assert.equal(f.values.size, 1)
  assert.equal(f.values.get(f.key), f.initial)
  assert.equal(f.map.size, 0)
  assert.deepEqual(f.calls.requests, ['GET', 'GET', 'GET', 'PUT'])
})
for (const event of ['account', 'logout', 'refresh']) {
  test(`SDK ${event} between final validation and isolated write fails closed before PUT`, async t => {
    const f = await sdkFixture(t)
    await f.flow.initialize(f.client)
    f.behavior.onRead = n => { if (n === 3) f.switchTo(event === 'account' ? f.b : event === 'logout' ? null : f.refreshed) }
    await assert.rejects(save(f))
    assert.deepEqual(f.calls.writes, [])
    assert.equal(f.map.size, 1)
  })
  test(`SDK ${event} after the last check cannot redirect the bearer of an already authorized write`, async t => {
    const f = await sdkFixture(t)
    await f.flow.initialize(f.client)
    f.behavior.onRead = n => { if (n === 4) f.switchTo(event === 'account' ? f.b : event === 'logout' ? null : f.refreshed) }
    await save(f)
    assert.deepEqual(f.calls.writes, ['invite-A'])
    assert.equal(f.values.get(f.key), event === 'account' ? JSON.stringify(f.b) : event === 'logout' ? undefined : JSON.stringify(f.refreshed))
  })
}
test('SDK expired JWT is rejected before verification or password writes', async t => {
  const f = await sdkFixture(t, { expiry: -10 })
  await assert.rejects(f.flow.initialize(f.client))
  await assert.rejects(save(f))
  assert.deepEqual(f.calls.requests, [])
})
test('SDK server-revoked session cannot update a password, even with a locally unexpired JWT', async t => {
  const f = await sdkFixture(t)
  await f.flow.initialize(f.client)
  f.behavior.rejectUser = true
  await assert.rejects(save(f))
  assert.deepEqual(f.calls.writes, [])
})
test('SDK token expiring at the final dispatch boundary cannot authorize a PUT', async t => {
  const f = await sdkFixture(t)
  await f.flow.initialize(f.client)
  const expiresAfter = (JSON.parse(Buffer.from(f.a.access_token.split('.')[1], 'base64url')).exp + 1) * 1000
  f.behavior.onRead = n => { if (n === 4) t.mock.method(Date, 'now', () => expiresAfter) }
  await assert.rejects(save(f))
  assert.deepEqual(f.calls.writes, [])
})
test('SDK inconsistent user during isolated session establishment is rejected before PUT', async t => {
  const f = await sdkFixture(t)
  await f.flow.initialize(f.client)
  f.behavior.inconsistentPrivateUser = true
  await assert.rejects(save(f))
  assert.deepEqual(f.calls.writes, [])
})
test('SDK near-expiry snapshot never sends a refresh request; valid original bearer remains bound', async t => {
  const f = await sdkFixture(t, { expiry: 30 })
  await f.flow.initialize(f.client)
  await save(f)
  assert.deepEqual(f.calls.writes, ['invite-A'])
  assert.ok(f.calls.requests.every(method => method === 'GET' || method === 'PUT'))
})
test('SDK two simultaneous acceptance submissions produce only one PUT', async t => {
  const f = await sdkFixture(t)
  await f.flow.initialize(f.client)
  const results = await Promise.allSettled([save(f), save(f)])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(results.filter(r => r.status === 'rejected').length, 1)
  assert.deepEqual(f.calls.writes, ['invite-A'])
})
test('SDK verification network error causes zero PUT and does not clear the pending invitation', async t => {
  const f = await sdkFixture(t)
  await f.flow.initialize(f.client)
  f.behavior.failVerify = true
  await assert.rejects(save(f))
  assert.deepEqual(f.calls.writes, [])
  assert.equal(f.map.size, 1)
})
for (const mode of ['loseReply', 'malformedReply']) {
  test(`SDK ${mode} leaves result unconfirmed, never retries automatically or switches accounts`, async t => {
    const f = await sdkFixture(t)
    await f.flow.initialize(f.client)
    f.behavior[mode] = true
    f.behavior.onPut = () => f.switchTo(f.b)
    await assert.rejects(save(f), /No se confirmo/)
    assert.deepEqual(f.calls.writes, ['invite-A'])
    assert.equal(f.map.size, 1)
    await assert.rejects(save(f))
    assert.deepEqual(f.calls.writes, ['invite-A'])
  })
}
