import { useEffect, useState } from 'react'

import { api, live, type JobSnapshot, type Workflow } from './api'

const POLL_MS = 1500
const ENDED_MS = 2600 // how long a finished card stays green (or red) before settling

const STATUS: Record<Workflow['status'], { dot: string; label: string }> = {
  building: { dot: 'dot-info dot-live', label: 'Building' },
  ready: { dot: 'dot-ok', label: 'Ready' },
  needs_attention: { dot: 'dot-ui', label: 'Needs attention' },
  failed: { dot: 'dot-fail', label: 'Failed' },
}

/** "3m ago", "2h ago", "Mar 4": when it last ran. */
function ago(seconds: number): string {
  const s = Date.now() / 1000 - seconds
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(seconds * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** The last time it ran (not its build), if it has. */
export function lastRun(wf: Workflow) {
  return wf.runs.find((r) => r.kind !== 'build') ?? null
}

/**
 * A card's part in a run started from Home: running (orange, with a shimmer), passed or
 * failed (green or red for a moment), idle (greyed while another card runs), or none.
 */
type CardState = 'running' | 'passed' | 'failed' | 'idle' | null

/** One workflow: its name and prompt, with Open in the top corner and Run stacked under it. */
function WorkflowCard({
  wf,
  state,
  error,
  onRun,
  onOpen,
}: {
  wf: Workflow
  state: CardState
  error: string | null
  onRun: () => void
  onOpen: () => void
}) {
  const last = lastRun(wf)
  const running = state === 'running'
  const status = running ? { dot: 'dot-info dot-live', label: 'Running' } : STATUS[wf.status]
  const label = state === 'passed' ? 'Run passed' : state === 'failed' ? 'Run failed' : status.label
  const tone = state === 'passed' ? 'text-ok' : state === 'failed' || (!state && (wf.status === 'needs_attention' || wf.status === 'failed')) ? 'text-warn' : 'muted'

  return (
    <article className={`wf-card${state ? ` ${state}` : ''}`} aria-busy={running}>
      <div className="wf-card-text">
        <div className="wf-card-top">
          <span className={`dot ${status.dot}`} aria-hidden="true" />
          <h2 title={wf.title}>{wf.title}</h2>
        </div>
        <p className="wf-card-goal muted" title={wf.goal}>
          {wf.goal}
        </p>
        <p className="wf-card-meta small">
          <span className={tone}>{label}</span>
          {last && <span className="subtle"> · last run {ago(last.started)}</span>}
        </p>
        {error && <p className="request-error small">{error}</p>}
      </div>
      <div className="wf-card-actions">
        {(wf.runnable || wf.script) && (
          <button
            type="button"
            className="wf-card-run"
            onClick={onRun}
            disabled={running || state === 'idle' || wf.status === 'building'}
            aria-label={running ? 'Running' : undefined}
          >
            {/* Too narrow for "Running…": just the spinner while it goes (the status line says it). */}
            {running ? <span className="spinner" aria-hidden="true" /> : 'Run'}
          </button>
        )}
        <button type="button" className="secondary wf-card-open" onClick={onOpen} title="Open in full">
          Open
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 3h6v6M21 3l-9 9M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
          </svg>
        </button>
      </div>
    </article>
  )
}

type Sort = 'run' | 'created'
const SORT_KEY = 'home-sort'
const SORTS: { value: Sort; label: string }[] = [
  { value: 'run', label: 'Last run' },
  { value: 'created', label: 'Created' },
]

function loadSort(): Sort {
  try {
    return localStorage.getItem(SORT_KEY) === 'created' ? 'created' : 'run'
  } catch {
    return 'run'
  }
}

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

/** The Home tab: every workflow as a wide card, searchable, by last run or by creation. */
export function Dashboard({
  workflows,
  onOpen,
  onNew,
  onChanged,
}: {
  workflows: Workflow[]
  onOpen: (id: string) => void
  onNew: () => void
  onChanged: () => void
}) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>(loadSort)
  function pickSort(next: Sort) {
    setSort(next)
    try {
      localStorage.setItem(SORT_KEY, next)
    } catch {
      // storage can be unavailable; the choice just isn't remembered
    }
  }
  // Matching the search in its name or prompt, then newest first by the chosen date;
  // by last run, ones that never ran come after, newest built first.
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const sorted = workflows
    .filter((w) => words.every((word) => `${w.title} ${w.goal}`.toLowerCase().includes(word)))
    .sort((a, b) => (sort === 'run' ? (lastRun(b)?.started ?? 0) - (lastRun(a)?.started ?? 0) : 0) || b.created - a.created)
  // One run at a time from here: the card running it, and once over, how it went.
  const [running, setRunning] = useState<{ id: string; job: JobSnapshot } | null>(null)
  const [ended, setEnded] = useState<{ id: string; ok: boolean } | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  // Follow the run until it ends, then let the list catch up.
  useEffect(() => {
    if (!running) return
    const timer = setTimeout(async () => {
      try {
        const job = await api<JobSnapshot>(`/jobs/${running.job.job_id}`)
        if (live(job.status)) return setRunning({ id: running.id, job })
        setRunning(null)
        setEnded({ id: running.id, ok: job.status === 'passed' })
        onChanged()
      } catch {
        setRunning(null)
      }
    }, POLL_MS)
    return () => clearTimeout(timer)
  }, [running, onChanged])

  // The finished card holds its colour a moment, then eases back.
  useEffect(() => {
    if (!ended) return
    const timer = setTimeout(() => setEnded(null), ENDED_MS)
    return () => clearTimeout(timer)
  }, [ended])

  async function run(id: string) {
    setErrors(({ [id]: _, ...rest }) => rest)
    setEnded(null)
    try {
      const { job_id } = await api<{ job_id: string }>(`/workflows/${id}/run`, {})
      setRunning({ id, job: await api<JobSnapshot>(`/jobs/${job_id}`) })
      onChanged()
    } catch (e) {
      setErrors((all) => ({ ...all, [id]: (e as Error).message }))
    }
  }

  const stateOf = (id: string): CardState =>
    running ? (running.id === id ? 'running' : 'idle') : ended?.id === id ? (ended.ok ? 'passed' : 'failed') : null

  return (
    <div className="page dashboard">
      <header className="view-head">
        <div className="view-title">
          <h1>Home</h1>
        </div>
        <div className="view-actions">
          <button type="button" onClick={onNew}>
            + New workflow
          </button>
        </div>
      </header>
      {workflows.length > 0 && (
        <div className="dash-tools">
          <label className="dash-search">
            <SearchIcon />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
              placeholder="Search workflows"
              aria-label="Search workflows"
            />
          </label>
          <label className="dash-sort">
            <select value={sort} onChange={(e) => pickSort(e.target.value as Sort)} aria-label="Sort by" title="Sort by">
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {workflows.length > 0 && sorted.length === 0 ? (
        <p className="muted dash-none">No workflows match “{query.trim()}”.</p>
      ) : sorted.length === 0 ? (
        <div className="dash-empty">
          <p className="muted">Nothing automated yet.</p>
          <button type="button" className="secondary" onClick={onNew}>
            Build your first workflow
          </button>
        </div>
      ) : (
        <div className="wf-grid">
          {sorted.map((wf) => (
            <WorkflowCard
              key={wf.id}
              wf={wf}
              state={stateOf(wf.id)}
              error={errors[wf.id] ?? null}
              onRun={() => run(wf.id)}
              onOpen={() => onOpen(wf.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
