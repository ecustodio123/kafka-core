import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { Boxes, FileText, FolderTree, Loader2, LogOut, Package, Settings, Users, Wrench, RefreshCw, Save } from 'lucide-react'
import { AuthPage } from './features/auth/AuthPage'
import { AcceptInvitePage } from './features/auth/AcceptInvitePage'
import { CategoriesPage } from './features/categories/CategoriesPage'
import { ProductsPage } from './features/products/ProductsPage'
import { clearProductDrafts } from './features/products/productDraft'
import { ContentPage } from './features/content/ContentPage'
import { PublicationsPage } from './features/publications/PublicationsPage'
import { allowedSections, resolveGlobalRole } from './features/stores/storeAccess'
import type { AdminSection, GlobalRole } from './features/stores/storeAccess'
import { Toggle } from './components/Toggle'
import { useStoreFeatures } from './hooks/useStoreFeatures'
import { getSupabaseClient, hasSupabaseConfig, inviteFlow } from './lib/supabase'
import { getUserStores } from './services/stores'
import { moduleKeys } from './services/storeFeatures'
import type { ModuleFlags, Store, StoreFeatures } from './types/database'

const labels = { products: 'Productos', categories: 'Categorias', services: 'Servicios', staff: 'Staff', publications: 'Publicaciones', modules: 'Modulos' }
const icons = { products: Package, categories: FolderTree, services: Wrench, staff: Users, publications: FileText, modules: Settings }
const buttonClass = 'inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium disabled:opacity-50 hover:bg-slate-50'

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(hasSupabaseConfig)
  const [acceptingInvite, setAcceptingInvite] = useState(inviteFlow.active)
  useEffect(() => {
    if (!hasSupabaseConfig) return
    let current = true
    let eventReceived = false
    const client = getSupabaseClient()
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, next) => {
      if (_event === 'SIGNED_OUT') {
        try { clearProductDrafts(sessionStorage) } catch { /* Never block logout on browser storage. */ }
      }
      eventReceived = true
      if (current) { setSession(next); setLoading(false) }
    })
    void client.auth.getSession().then(({ data }) => {
      if (current && !eventReceived) { setSession(data.session); setLoading(false) }
    }).catch(() => { if (current) setLoading(false) })
    return () => { current = false; subscription.unsubscribe() }
  }, [])
  if (acceptingInvite) return <AcceptInvitePage onContinue={() => setAcceptingInvite(false)} />
  if (loading) return <State text="Validando sesion..." loading />
  if (!session) return <AuthPage />
  return <AdminWorkspace key={session.user.id} session={session} />
}

function AdminWorkspace({ session }: { session: Session }) {
  const [context, setContext] = useState<{ role: GlobalRole; stores: Store[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let current = true
    async function load() {
      try {
        const { data, error: authError } = await getSupabaseClient().auth.getUser()
        if (authError || !data.user || data.user.id !== session.user.id) throw new Error('No se pudo verificar tu usuario.')
        const metadata = data.user.app_metadata
        const stores = await getUserStores(data.user.id, metadata.global_role === 'super_admin')
        const role = resolveGlobalRole(metadata, stores, data.user.id)
        if (!role) {
          if (!Object.hasOwn(metadata, 'global_role') && stores.length === 0) {
            if (current) setError('Tu usuario esta autenticado, pero aun no tiene una tienda asignada. Contacta a Kafka.')
            return
          }
          throw new Error('Tu usuario no tiene un rol autorizado.')
        }
        if (current) {
          setSelectedId(previous => stores.some(item => item.id === previous) ? previous : stores[0]?.id ?? null)
          setContext({ role, stores })
          setError(null)
        }
      } catch {
        if (current) { setContext(null); setError('No se pudo cargar el acceso a tus tiendas. Reintenta o inicia sesion nuevamente.') }
      }
    }
    void load()
    return () => { current = false }
  }, [session.user.id, revision])
  const store = context?.stores.find(item => item.id === selectedId) ?? context?.stores[0]
  return <div className="min-h-screen bg-slate-100 text-slate-950">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-4 sm:px-6">
      <div className="flex items-center gap-3"><Boxes size={24} aria-hidden="true" /><h1 className="text-lg font-semibold">Kafka Admin</h1></div>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <span className="break-all text-sm text-slate-600">{session.user.email}</span>
        <span className="text-xs font-semibold">{context?.role === 'super_admin' ? 'Super Admin' : context ? 'Admin' : ''}</span>
        <button className={buttonClass} onClick={() => void getSupabaseClient().auth.signOut()}><LogOut size={16} />Salir</button>
      </div>
    </header>
    <div className="border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
      <div className="flex max-w-xl items-center gap-3">
        <label htmlFor="store-selector" className="text-sm font-medium">Tienda</label>
        <select id="store-selector" className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" value={store?.id ?? ''} disabled={!context?.stores.length}
          onChange={event => setSelectedId(Number(event.target.value))}>
          {!context?.stores.length && <option value="">Sin tiendas disponibles</option>}
          {context?.stores.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <button className={buttonClass} aria-label="Recargar tiendas" title="Recargar tiendas" onClick={() => { setContext(null); setError(null); setRevision(n => n + 1) }}><RefreshCw size={16} /></button>
      </div>
    </div>
    {error ? <State text={error} /> : !context ? <State text="Cargando tiendas..." loading /> : !store ? <State text="No tienes tiendas asociadas." /> :
      <StoreWorkspace key={store.id} store={store} userId={session.user.id} role={context.role} />}
  </div>
}

function StoreWorkspace({ store, userId, role }: { store: Store; userId: string; role: GlobalRole }) {
  const features = useStoreFeatures(store.id)
  const [section, setSection] = useState<AdminSection>(role === 'super_admin' ? 'modules' : 'products')
  if (features.loading) return <State text="Consultando modulos..." loading />
  if (features.error) return <div><State text={features.error} /><button className={buttonClass} onClick={() => void features.reload()}><RefreshCw size={16} />Reintentar</button></div>
  const sections = allowedSections(role, userId, store, features.row)
  const active = sections.includes(section) ? section : sections[0]
  const legacy = !features.row && store.owner_user_id === userId
  return <div className="grid grid-cols-1 lg:grid-cols-[240px_minmax(0,1fr)]">
    <aside className="border-b border-slate-200 bg-white p-4 lg:min-h-[calc(100vh-9rem)] lg:border-r">
      <nav aria-label="Modulos de Kafka Admin" className="space-y-1">
        {sections.map(item => {
          const Icon = icons[item]
          const disabled = (item === 'services' && features.row?.services_enabled !== true) || (item === 'staff' && features.row?.staff_enabled !== true) || (item === 'publications' && features.row?.publications_enabled !== true)
          return <button key={item} onClick={() => setSection(item)} aria-current={active === item ? 'page' : undefined}
            className={`flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left text-sm font-medium ${active === item ? 'bg-slate-950 text-white' : 'text-slate-700 hover:bg-slate-100'}`}>
            <Icon size={18} aria-hidden="true" /><span>{labels[item]}{disabled && <span className="block text-xs font-normal">Deshabilitado</span>}</span>
          </button>
        })}
      </nav>
    </aside>
    <main className="min-w-0 space-y-4 px-4 py-6 sm:px-6">
      {legacy && <p role="status" className="border-l-4 border-amber-500 bg-amber-50 p-3 text-sm text-amber-950">Esta tienda aun no tiene configuracion de modulos. Commerce figura deshabilitado; conservas el acceso de compatibilidad a tu catalogo existente.</p>}
      {active === 'products' && <ProductsPage store={store} userId={userId} onLeave={() => setSection(sections.includes('categories') ? 'categories' : 'modules')} />}
      {active === 'categories' && <CategoriesPage store={store} />}
      {active === 'modules' && <ModuleSettings row={features.row} superAdmin={role === 'super_admin'} saving={features.saving} save={features.save} reload={features.reload} />}
      {(active === 'services' || active === 'staff') && <ContentPage key={active} kind={active} store={store} enabled={features.row?.[active === 'services' ? 'services_enabled' : 'staff_enabled'] === true} />}
      {active === 'publications' && <PublicationsPage store={store} enabled={features.row?.publications_enabled === true} />}
    </main>
  </div>
}

function ModuleSettings({ row, superAdmin, saving, save, reload }: {
  row: StoreFeatures | null; superAdmin: boolean; saving: boolean
  save: (flags: ModuleFlags) => Promise<void>; reload: () => Promise<void>
}) {
  const [draft, setDraft] = useState<ModuleFlags>(() => ({
    commerce_enabled: row?.commerce_enabled === true, services_enabled: row?.services_enabled === true, staff_enabled: row?.staff_enabled === true,
    publications_enabled: row?.publications_enabled === true,
  }))
  const [message, setMessage] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const unchanged = row && moduleKeys.every(key => draft[key] === (row[key] === true))
  async function submit() {
    try {
      setMessage(null); setFailed(false)
      await save(draft)
      setMessage('Configuracion guardada.')
    } catch {
      setFailed(true)
      setMessage('No se confirmo el guardado. Recarga la configuracion antes de reintentar; puede haber cambios en otra sesion.')
    }
  }
  return <section className="max-w-xl space-y-4">
    <h2 className="text-xl font-semibold">Modulos de la tienda</h2>
    {!row && <p className="text-sm text-slate-600">Sin configuracion. Todos los modulos estan deshabilitados.</p>}
    <fieldset disabled={!superAdmin || saving || failed} className="space-y-3">
      <Toggle label="Commerce" checked={draft.commerce_enabled === true} onChange={value => setDraft(s => ({ ...s, commerce_enabled: value }))} />
      <Toggle label="Servicios" checked={draft.services_enabled === true} onChange={value => setDraft(s => ({ ...s, services_enabled: value }))} />
      <Toggle label="Staff" checked={draft.staff_enabled === true} onChange={value => setDraft(s => ({ ...s, staff_enabled: value }))} />
      <Toggle label="Publicaciones" checked={draft.publications_enabled === true} onChange={value => setDraft(s => ({ ...s, publications_enabled: value }))} />
      {superAdmin && <button className={buttonClass} disabled={Boolean(unchanged)} onClick={() => void submit()}><Save size={16} />{saving ? 'Guardando...' : row ? 'Guardar cambios' : 'Crear configuracion'}</button>}
    </fieldset>
    {!superAdmin && <p className="text-sm text-slate-600">Solo Super Admin puede modificar los modulos.</p>}
    {message && <p role={failed ? 'alert' : 'status'} className="text-sm">{message}</p>}
    {superAdmin && <button className={buttonClass} disabled={saving} onClick={() => void reload()}><RefreshCw size={16} />Recargar configuracion</button>}
  </section>
}

function State({ text, loading = false }: { text: string; loading?: boolean }) {
  return <div role="status" className="flex min-h-48 items-center justify-center gap-3 px-4 py-10 text-sm text-slate-600">{loading && <Loader2 className="animate-spin" size={18} />}{text}</div>
}
