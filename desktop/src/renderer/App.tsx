import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import './Shell.css'

import { api, onAttention, type Health, type Workflow } from './api'
import { Dashboard, lastRun } from './Dashboard'
import { GmailConnect } from './GmailConnect'
import logo from './assets/logo.png'
import { DataView } from './DataView'
import { captionWidth, prefersReducedMotion, PromptFlight, type Box, type Intro } from './Flight'
import { Home } from './Home'
import { WorkflowView } from './WorkflowView'

// home: the dashboard of workflow cards; new: the prompt box that builds one.
type View = { name: 'home' } | { name: 'new' } | { name: 'workflow'; id: string } | { name: 'data' }

const DOT: Record<Workflow['status'], string> = {
  building: 'dot-info dot-live',
  ready: 'dot-ok',
  needs_attention: 'dot-ui',
  failed: 'dot-fail',
}

/** Online accounts: Gmail directly, or through Factory's connector. */
function Accounts({ open, gmail, onClose, onChanged }: { open: boolean; gmail: string | null; onClose: () => void; onChanged: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = dialog.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])

  return (
    <dialog ref={dialog} className="accounts" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <div className="accounts-body">
        <div className="accounts-head">
          <div>
            <h2>Accounts</h2>
            <p className="muted small">
              Gmail connected in Factory (Settings › Connectors) works as is. Connecting it here as well makes searches direct and much faster, with no agent reading your mail.
            </p>
          </div>
          <button type="button" className="secondary small-button" onClick={onClose}>
            Done
          </button>
        </div>
        {gmail ? (
          <p className="small">
            <span className="text-ok">Gmail connected</span> <span className="muted">· {gmail}</span>{' '}
            <button type="button" className="link inline" onClick={() => api('/connectors/gmail', undefined, 'DELETE').then(onChanged)}>
              Disconnect
            </button>
          </p>
        ) : (
          <GmailConnect onConnected={onChanged} />
        )}
      </div>
    </dialog>
  )
}

/** The sidebar-panel icon: collapse when expanded, expand when collapsed. */
function PanelIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9.5 4v16" />
    </svg>
  )
}

function HomeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />
    </svg>
  )
}

function DataIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <ellipse cx="12" cy="5.5" rx="8" ry="2.5" />
      <path d="M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5" />
    </svg>
  )
}

const SIDEBAR_KEY = 'sidebar-collapsed'
const TABS_KEY = 'open-workflows'
const RECENT_S = 24 * 3600 // a run within this long puts its workflow under Recently run
const RECENT_MAX = 5

function loadTabs(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(TABS_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
const NARROW = '(max-width: 760px)'

export default function App() {
  const [view, setView] = useState<View>({ name: 'home' })
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [offline, setOffline] = useState(false)
  const [gmail, setGmail] = useState<string | null>(null)
  const [accountsOpen, setAccountsOpen] = useState(false)
  // Workflows opened in full, kept as tabs in the sidebar until closed; remembered per machine.
  const [tabs, setTabs] = useState<string[]>(loadTabs)
  useEffect(() => {
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify(tabs))
    } catch {
      // storage can be unavailable; the tabs just aren't remembered
    }
  }, [tabs])
  const openTab = useCallback((id: string) => setTabs((t) => (t.includes(id) ? t : [...t, id])), [])
  const loadAccounts = useCallback(() => {
    api<Health>('/health')
      .then((h) => setGmail(h.gmail))
      .catch(() => {})
  }, [])
  useEffect(loadAccounts, [loadAccounts])
  // The sidebar can shrink to a strip of the logo and status dots; remembered per machine.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === '1'
    } catch {
      return false
    }
  })
  function collapse(next: boolean) {
    setCollapsed(next)
    try {
      localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0')
    } catch {
      // storage can be unavailable; the choice just isn't remembered
    }
  }
  // A narrow window has no room for the full sidebar: shrink it to the strip on the way
  // down (not remembered, so widening again keeps whatever was chosen).
  useEffect(() => {
    const narrow = window.matchMedia(NARROW)
    const onChange = () => narrow.matches && setCollapsed(true)
    onChange()
    narrow.addEventListener('change', onChange)
    return () => narrow.removeEventListener('change', onChange)
  }, [])
  // Sending a prompt: the home screen fades out around it while it flies to the build page.
  const [intro, setIntro] = useState<Intro | null>(null)
  const [leaving, setLeaving] = useState(false)
  const [glowSnap, setGlowSnap] = useState(false)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null) // the caption the text lands on
  const [cardAnchor, setCardAnchor] = useState<HTMLElement | null>(null) // the progress card the box becomes

  const loadWorkflows = useCallback(async () => {
    try {
      setWorkflows((await api<{ workflows: Workflow[] }>('/workflows')).workflows)
      setOffline(false)
    } catch {
      setOffline(true)
    }
  }, [])

  useEffect(() => {
    void loadWorkflows()
    const timer = setInterval(loadWorkflows, 5000)
    return () => clearInterval(timer)
  }, [loadWorkflows])

  // A question, card or result needs the person: open that workflow.
  useEffect(
    () =>
      onAttention((id) => {
        void loadWorkflows()
        openTab(id)
        setView({ name: 'workflow', id })
      }),
    [loadWorkflows, openTab],
  )

  function go(next: View) {
    if (next.name === 'workflow') openTab(next.id)
    if (next.name !== 'workflow' || next.id !== intro?.id) setIntro(null)
    setLeaving(false)
    // From home to a workflow, the home glow goes at once (fading, it lingers behind the
    // workflow); every other switch, and sending a new prompt, keeps its fade.
    setGlowSnap(view.name === 'new' && next.name === 'workflow')
    setView(next)
  }

  async function start(prompt: string, from?: Box) {
    const { workflow_id } = await api<{ workflow_id: string; job_id: string }>('/workflows', { prompt })
    void loadWorkflows()
    openTab(workflow_id)
    if (from && !prefersReducedMotion()) {
      setIntro({ id: workflow_id, prompt, from, width: captionWidth(from), landed: false })
      setLeaving(true)
      setTimeout(() => setLeaving(false), 900)
    }
    setView({ name: 'workflow', id: workflow_id })
  }

  function closeTab(id: string) {
    setTabs((t) => t.filter((x) => x !== id))
    if (view.name === 'workflow' && view.id === id) go({ name: 'home' })
  }

  // The sidebar's workflows, each in one place: needing the person first, then run in the
  // last day, then the rest of the tabs opened from Home. They move between them on their own.
  const now = Date.now() / 1000
  const attention = workflows.filter((w) => w.status === 'needs_attention' || w.status === 'failed')
  const recent = workflows
    .filter((w) => !attention.includes(w))
    .map((w) => ({ w, at: lastRun(w)?.started ?? 0 }))
    .filter(({ at }) => now - at < RECENT_S)
    .sort((a, b) => b.at - a.at)
    .slice(0, RECENT_MAX)
    .map(({ w }) => w)
  const byId = new Map(workflows.map((w) => [w.id, w]))
  const opened = tabs.map((id) => byId.get(id)).filter((w): w is Workflow => w !== undefined && !attention.includes(w) && !recent.includes(w))
  const sections = [
    { label: 'Needs attention', items: attention, closable: false },
    { label: 'Recently run', items: recent, closable: false },
    { label: 'Workflows', items: opened, closable: true },
  ]

  return (
    <div className={`shell${collapsed ? ' collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="drag" aria-hidden="true" />
        <div className="side-brand">
          {/* One element in both states, so the logo never moves; collapsed, it's the expand button. */}
          <button
            type="button"
            className="brand-button"
            onClick={collapsed ? () => collapse(false) : undefined}
            tabIndex={collapsed ? 0 : -1}
            aria-label={collapsed ? 'Expand sidebar' : undefined}
            title={collapsed ? 'Expand sidebar' : undefined}
          >
            <img className="brand-mark" src={logo} width={28} height={28} alt="" />
            <span className="brand-expand">
              <PanelIcon />
            </span>
          </button>
          <span className="side-name">
            <span className="retro">Retro</span>naut
          </span>
          <button type="button" className="side-toggle" onClick={() => collapse(true)} aria-label="Collapse sidebar" title="Collapse sidebar">
            <PanelIcon />
          </button>
        </div>
        <button
          type="button"
          className={`side-new${view.name === 'new' ? ' active' : ''}`}
          onClick={() => go({ name: 'new' })}
          aria-label="New workflow"
          title={collapsed ? 'New workflow' : undefined}
        >
          <span className="plus" aria-hidden="true">+</span>
          <span className="side-new-label">New workflow</span>
        </button>

        <nav className="side-section side-tabs" aria-label="Pages">
          <button
            type="button"
            className={`side-item${view.name === 'home' ? ' active' : ''}`}
            onClick={() => go({ name: 'home' })}
            title={collapsed ? 'Home' : undefined}
          >
            <span className="side-glyph" aria-hidden="true">
              <HomeIcon />
            </span>
            <span className="side-item-name">Home</span>
          </button>
          <button
            type="button"
            className={`side-item${view.name === 'data' ? ' active' : ''}`}
            onClick={() => go({ name: 'data' })}
            title={collapsed ? 'Data & read APIs' : undefined}
          >
            <span className="side-glyph" aria-hidden="true">
              <DataIcon />
            </span>
            <span className="side-item-name">Data &amp; read APIs</span>
          </button>
        </nav>

        <div className="side-scroll">
          {sections.map(
            (section) =>
              section.items.length > 0 && (
                <nav key={section.label} className="side-section" aria-label={section.label}>
                  <div className="side-label">{section.label}</div>
                  <ul>
                    {section.items.map((w) => (
                      <li key={w.id} className="side-tab">
                        <button
                          type="button"
                          className={`side-item${view.name === 'workflow' && view.id === w.id ? ' active' : ''}`}
                          onClick={() => go({ name: 'workflow', id: w.id })}
                          title={collapsed ? w.title : w.goal}
                        >
                          <span className={`dot ${DOT[w.status]}`} aria-hidden="true" />
                          <span className="side-item-name">{w.title}</span>
                        </button>
                        {section.closable && (
                          <button type="button" className="side-close" onClick={() => closeTab(w.id)} aria-label={`Close ${w.title}`} title="Close">
                            ×
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </nav>
              ),
          )}
        </div>

        <nav className="side-section side-bottom" aria-label="Accounts">
          <button type="button" className="side-item" onClick={() => setAccountsOpen(true)}>
            <span className="side-glyph" aria-hidden="true">@</span>
            <span className="side-item-name">Accounts</span>
            <span className="side-item-meta">{gmail ? 'Gmail' : 'Factory'}</span>
          </button>
          {offline && <p className="side-empty small offline">Engine not reachable</p>}
        </nav>
      </aside>

      {/* The home screen's full glow, crossfading with the dimmer one behind other pages. */}
      <div className={`glow-layer${view.name === 'new' && !leaving ? ' on' : ''}${glowSnap ? ' snap' : ''}`} aria-hidden="true" />

      <main className="main">
        <div className="drag" aria-hidden="true" />
        {view.name === 'home' && (
          <Dashboard workflows={workflows} onOpen={(id) => go({ name: 'workflow', id })} onNew={() => go({ name: 'new' })} onChanged={loadWorkflows} />
        )}
        {(view.name === 'new' || leaving) && <Home onStart={start} leaving={leaving} />}
        {view.name === 'workflow' && (
          <WorkflowView
            key={view.id}
            id={view.id}
            intro={intro?.id === view.id ? intro : null}
            introAnchor={setAnchor}
            introCard={setCardAnchor}
            onChanged={loadWorkflows}
            onDeleted={() => {
              setTabs((t) => t.filter((x) => x !== view.id))
              go({ name: 'home' })
              void loadWorkflows()
            }}
          />
        )}
        {view.name === 'data' && <DataView />}
      </main>

      {intro && !intro.landed && anchor && cardAnchor && view.name === 'workflow' && view.id === intro.id && (
        <PromptFlight intro={intro} anchor={anchor} card={cardAnchor} onLanded={() => setIntro((i) => (i ? { ...i, landed: true } : i))} />
      )}


      <Accounts open={accountsOpen} gmail={gmail} onClose={() => setAccountsOpen(false)} onChanged={loadAccounts} />
    </div>
  )
}
