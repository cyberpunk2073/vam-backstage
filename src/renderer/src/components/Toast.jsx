import { create } from 'zustand'
import { X, AlertTriangle, CheckCircle, Info } from 'lucide-react'

let toastId = 0

export const useToastStore = create((set, get) => ({
  toasts: [],
  add: (message, type = 'error', duration = 5000) => {
    const id = ++toastId
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }))
    if (duration > 0) setTimeout(() => get().dismiss(id), duration)
    return id
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

export function toast(message, type = 'error', duration = 5000) {
  if (type === 'error') console.error('[toast]', message)
  else console.log('[toast]', message)
  return useToastStore.getState().add(message, type, duration)
}

const ICON = {
  error: AlertTriangle,
  success: CheckCircle,
  info: Info,
}
const STYLES = {
  error: 'bg-base/55 border-error/30 text-error',
  success: 'bg-base/55 border-success/30 text-success',
  info: 'bg-base/55 border-accent-blue/30 text-accent-blue',
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)
  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-12 right-4 z-50 space-y-2 max-w-sm">
      {toasts.map((t) => {
        const Icon = ICON[t.type] || AlertTriangle
        return (
          <div
            key={t.id}
            className={`flex items-start gap-2 px-3 py-2.5 rounded-lg border backdrop-blur-xl text-xs shadow-xl animate-in slide-in-from-right ${STYLES[t.type] || STYLES.error}`}
          >
            <Icon size={14} className="shrink-0 mt-0.5" />
            <span className="flex-1 leading-relaxed select-text cursor-text">{t.message}</span>
            <button onClick={() => dismiss(t.id)} className="shrink-0 opacity-60 hover:opacity-100 cursor-pointer">
              <X size={12} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
