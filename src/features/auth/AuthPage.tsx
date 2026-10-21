import { useState } from 'react'
import type { FormEvent } from 'react'
import { Loader2, LogIn } from 'lucide-react'
import { getSupabaseClient, hasSupabaseConfig } from '../../lib/supabase'
import { AuthLayout, AuthNotice } from './AuthLayout'

export function AuthPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    if (!hasSupabaseConfig) {
      setError('Configura VITE_SUPABASE_URL y VITE_SUPABASE_PUBLISHABLE_KEY.')
      return
    }

    if (!email.trim() || password.length < 6) {
      setError('Ingresa un correo y una contrasena de al menos 6 caracteres.')
      return
    }

    try {
      setLoading(true)
      const { error: signInError } =
        await getSupabaseClient().auth.signInWithPassword({
          email,
          password,
        })

      if (signInError) {
        throw signInError
      }
    } catch (caughtError) {
      setError(getErrorMessage(caughtError))
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthLayout description="Ingresa con el usuario que Kafka haya creado previamente en Supabase Auth.">
        {error ? <AuthNotice message={error} /> : null}

        <form className="space-y-4" onSubmit={handleSubmit}>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-700">
              Correo
            </span>
            <input
              autoComplete="email"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="admin@kafka.pe"
              type="email"
              value={email}
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-700">
              Contrasena
            </span>
            <input
              autoComplete="current-password"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Minimo 6 caracteres"
              type="password"
              value={password}
            />
          </label>

          <button
            className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
            disabled={loading}
            type="submit"
          >
            {loading ? (
              <Loader2 className="animate-spin" aria-hidden="true" size={16} />
            ) : (
              <LogIn aria-hidden="true" size={16} />
            )}
            Entrar
          </button>
        </form>
    </AuthLayout>
  )
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }

  return 'Ocurrio un error inesperado.'
}
