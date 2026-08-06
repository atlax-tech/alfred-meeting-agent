import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { installDevInviewBridge } from './services/dev-inview'
import './index.css'

if (import.meta.env.DEV && !window.inview) installDevInviewBridge()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
