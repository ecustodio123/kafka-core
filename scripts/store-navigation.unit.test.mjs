import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allowedSections, resolveGlobalRole } from '../src/features/stores/storeAccess.ts'

const own = { id: 1, owner_user_id: 'owner' }
const foreign = { id: 2, owner_user_id: 'other' }
const flags = { store_id: 1, commerce_enabled: false, services_enabled: false, staff_enabled: false }
test('only two explicit roles; missing role supports existing owners only', () => {
  for (const role of ['super_admin', 'admin']) assert.equal(resolveGlobalRole({ global_role: role }, [], 'owner'), role)
  assert.equal(resolveGlobalRole({}, [own], 'owner'), 'admin')
  for (const metadata of [{ global_role: null }, { global_role: 'owner' }, { global_role: '' }]) assert.equal(resolveGlobalRole(metadata, [own], 'owner'), null)
  assert.equal(resolveGlobalRole({}, [foreign], 'owner'), null)
})
test('missing config preserves owner catalog without enabling modules', () => {
  assert.deepEqual(allowedSections('admin', 'owner', own, null), ['products', 'categories', 'modules'])
  assert.deepEqual(allowedSections('admin', 'owner', own, flags), ['modules'])
})
test('all flag combinations protect direct navigation and foreign catalog', () => {
  for (let mask = 0; mask < 8; mask++) {
    const f = { ...flags, commerce_enabled: !!(mask & 1), services_enabled: !!(mask & 2), staff_enabled: !!(mask & 4) }
    const admin = allowedSections('admin', 'owner', own, f)
    assert.equal(admin.includes('products'), f.commerce_enabled)
    assert.equal(admin.includes('categories'), f.commerce_enabled)
    assert.equal(admin.includes('services'), f.services_enabled)
    assert.equal(admin.includes('staff'), f.staff_enabled)
    const superAdmin = allowedSections('super_admin', 'owner', foreign, f)
    assert.deepEqual(superAdmin, ['services', 'staff', 'modules'])
    assert.equal(allowedSections('super_admin', 'owner', own, f).includes('products'), f.commerce_enabled)
  }
})
test('nullable flags never enable a module', () => {
  assert.deepEqual(allowedSections('admin', 'owner', own, { ...flags, commerce_enabled: null, services_enabled: null, staff_enabled: null }), ['modules'])
})
