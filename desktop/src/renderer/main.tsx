import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter/wght.css'
import '@fontsource-variable/inter/wght-italic.css'
import './index.css'
import App from './App.tsx'
import { Pip } from './Pip.tsx'

// The same page serves the picture-in-picture window, at #pip.
const pip = window.location.hash === '#pip'

const root = createRoot(document.getElementById('root')!)
// TEMPORARY: the card tester, loaded only on its own page (it fakes the engine's /live).
if (window.location.hash === '#pip-test')
  void import('./PipTester.tsx').then(({ PipTester }) =>
    root.render(
      <StrictMode>
        <PipTester />
      </StrictMode>,
    ),
  )
else root.render(<StrictMode>{pip ? <Pip /> : <App />}</StrictMode>)
