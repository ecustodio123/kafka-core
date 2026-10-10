import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import {
  AlertCircle,
  Boxes,
  FolderTree,
  Loader2,
  LogOut,
  Package,
} from 'lucide-react'
import { AuthPage } from './features/auth/AuthPage'
import { CategoriesPage } from './features/categories/CategoriesPage'
import { ProductsPage } from './features/products/ProductsPage'
import { getSupabaseClient, hasSupabaseConfig } from './lib/supabase'
import { getCurrentUserStore } from './services/stores'
import type { Store } from './types/database'

type AdminSection = 'products' | 'categories'

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [store, setStore] = useState<Store | null>(null)
  const [loadingSession, setLoadingSession] = useState(hasSupabaseConfig)
  const [loadingStore, setLoadingStore] = useState(false)
  const [storeError, setStoreError] = useState<string | null>(null)
  const [activeSection, setActiveSection] = useState<AdminSection>('products')

  useEffect(() => {
    if (!hasSupabaseConfig) {
      return
    }

    const supabase = getSupabaseClient()

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoadingSession(false)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession)
      setStoreError(null)

      if (event === 'SIGNED_OUT') {
        setStore(null)
        setLoadingStore(false)
        return
      }

      if (nextSession?.user.id !== store?.owner_user_id) {
        setLoadingStore(Boolean(nextSession))
        setStore(null)
      }
    })

    return () => subscription.unsubscribe()
  }, [store?.owner_user_id])

  useEffect(() => {
    const userId = session?.user.id

    if (!userId) {
      setLoadingStore(false)
      return
    }

    const authenticatedUserId = userId
    let isCurrent = true

    async function loadStore() {
      try {
        setLoadingStore(true)
        setStoreError(null)
        const currentStore = await getCurrentUserStore(authenticatedUserId)

        if (!isCurrent) {
          return
        }

        setStore(currentStore)
        if (!currentStore) {
          setStoreError(
            'Tu usuario aun no tiene una tienda asociada en la tabla stores.',
          )
        }
      } catch (caughtError) {
        if (isCurrent) {
          setStoreError(getErrorMessage(caughtError))
        }
      } finally {
        if (isCurrent) {
          setLoadingStore(false)
        }
      }
    }

    void loadStore()

    return () => {
      isCurrent = false
    }
  }, [session?.user.id])

  async function handleSignOut() {
    await getSupabaseClient().auth.signOut()
  }

  if (loadingSession) {
    return <FullScreenState text="Validando sesion..." />
  }

  if (!session) {
    return <AuthPage />
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="flex min-h-16 flex-col gap-3 px-4 py-3 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-slate-950 text-white">
              <Boxes aria-hidden="true" size={20} />
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-500">
                Kafka Core
              </p>
              <h1 className="text-lg font-semibold leading-none">
                Kafka Admin
              </h1>
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="text-sm text-slate-600">
              {session.user.email}
              {store ? (
                <span className="ml-2 font-medium text-slate-950">
                  {store.name}
                </span>
              ) : null}
            </div>
            <button
              className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              onClick={() => void handleSignOut()}
              type="button"
            >
              <LogOut aria-hidden="true" size={16} />
              Salir
            </button>
          </div>
        </div>
      </header>

      <div className="grid min-h-[calc(100vh-4rem)] grid-cols-1 lg:grid-cols-[240px_1fr]">
        <aside className="border-b border-slate-200 bg-white px-4 py-3 lg:border-b-0 lg:border-r lg:px-5 lg:py-6">
          <nav aria-label="Modulos de Kafka Admin">
            <button
              className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm font-medium transition ${
                activeSection === 'products'
                  ? 'bg-slate-950 text-white'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
              onClick={() => setActiveSection('products')}
              type="button"
            >
              <Package aria-hidden="true" size={18} />
              Productos
            </button>
            <button
              className={`mt-2 flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm font-medium transition ${
                activeSection === 'categories'
                  ? 'bg-slate-950 text-white'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
              onClick={() => setActiveSection('categories')}
              type="button"
            >
              <FolderTree aria-hidden="true" size={18} />
              Categorias
            </button>
          </nav>
        </aside>

        <main className="px-4 py-6 sm:px-6 lg:px-8">
          {loadingStore ? (
            <PanelState text="Buscando la tienda asociada a tu usuario..." />
          ) : storeError ? (
            <PanelState icon="error" text={storeError} />
          ) : store && activeSection === 'products' ? (
            <ProductsPage store={store} />
          ) : store && activeSection === 'categories' ? (
            <CategoriesPage store={store} />
          ) : (
            <PanelState
              icon="error"
              text="No se encontro una tienda para este usuario."
            />
          )}
        </main>
      </div>
    </div>
  )
}

function FullScreenState({ text }: { text: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 shadow-sm">
        <Loader2 className="animate-spin" aria-hidden="true" size={18} />
        {text}
      </div>
    </main>
  )
}

function PanelState({
  icon = 'loading',
  text,
}: {
  icon?: 'error' | 'loading'
  text: string
}) {
  return (
    <section className="mx-auto flex min-h-80 max-w-3xl flex-col items-center justify-center rounded-lg border border-slate-200 bg-white px-6 py-12 text-center shadow-sm">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-md bg-slate-100 text-slate-500">
        {icon === 'error' ? (
          <AlertCircle aria-hidden="true" size={20} />
        ) : (
          <Loader2 className="animate-spin" aria-hidden="true" size={20} />
        )}
      </div>
      <p className="max-w-lg text-sm text-slate-600">{text}</p>
    </section>
  )
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }

  return 'Ocurrio un error inesperado.'
}

export default App
