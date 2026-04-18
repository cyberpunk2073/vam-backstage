import './assets/main.css'

// Suppress benign webview navigation abort noise from Electron's internal IPC layer
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason?.message || ''
  if (
    msg.includes('GUEST_VIEW_MANAGER_CALL') &&
    (msg.includes('ERR_ABORTED') || msg.includes('ERR_FAILED') || /\(-[23]\)/.test(msg))
  ) {
    e.preventDefault()
  }
})

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
