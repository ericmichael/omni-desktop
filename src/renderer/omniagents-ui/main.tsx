import './styles/index.css'

import React from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'

try {
  const theme = new URL(window.location.href).searchParams.get('theme')
  if (theme) {
document.documentElement.setAttribute('data-theme', theme)
}
} catch {}

const root = createRoot(document.getElementById('root')!)
root.render(<App />)
