import type { ReactNode } from 'react'
import { AlertCircle } from 'lucide-react'

export const authInputClass = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200'
export const authButtonClass = 'inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400'

export function AuthLayout({ title = 'Kafka Admin', description, children }: {
  title?: string; description: string; children: ReactNode
}) {
  return <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10">
    <section className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-6">
        <p className="text-sm font-semibold text-slate-500">Kafka Core - Kafka Admin</p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-950">{title}</h1>
        <p className="mt-2 text-sm text-slate-600">{description}</p>
      </div>
      {children}
    </section>
  </main>
}

export function AuthNotice({ message }: { message: string }) {
  return <div role="alert" className="mb-5 flex items-start gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
    <AlertCircle aria-hidden="true" size={18} className="shrink-0" /><p>{message}</p>
  </div>
}
