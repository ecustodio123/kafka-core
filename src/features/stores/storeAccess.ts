import type { Store, StoreFeatures } from '../../types/database.ts'

export type GlobalRole = 'super_admin' | 'admin'
export type AdminSection = 'products' | 'categories' | 'services' | 'staff' | 'modules'

export function resolveGlobalRole(metadata: Record<string, unknown>, stores: Store[], userId: string): GlobalRole | null {
  if (metadata.global_role === 'super_admin' || metadata.global_role === 'admin') return metadata.global_role
  if (!Object.hasOwn(metadata, 'global_role') && stores.some(s => s.owner_user_id === userId)) return 'admin'
  return null
}

export function allowedSections(role: GlobalRole, userId: string, store: Store, features: StoreFeatures | null): AdminSection[] {
  const sections: AdminSection[] = []
  // Missing configuration preserves only the owner's existing catalog, not an enabled flag.
  if (store.owner_user_id === userId && (!features || features.commerce_enabled === true)) sections.push('products', 'categories')
  if (role === 'super_admin' || features?.services_enabled === true) sections.push('services')
  if (role === 'super_admin' || features?.staff_enabled === true) sections.push('staff')
  sections.push('modules')
  return sections
}
