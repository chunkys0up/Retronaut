import { useEffect, useState } from 'react'

import { api, live, type JobSnapshot, type Workflow } from './api'

const POLL_MS = 1500

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

/** One workflow: its name and prompt, with Run and Open on the right. */
function WorkflowCard({ wf, onOpen, onChanged }: { wf: Workflow; onOpen: () => void; onChanged: () => void }) {
  const [job, setJob] = useState<JobSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const running = live(job?.status)

  // Follow a run started here until it ends, then let the list catch up.
  useEffect(() => {
    if (!job || !live(job.status)) return
    const timer = setTimeout(async () => {
      try {
        const next = await api<JobSnapshot>(`/jobs/${job.job_id}`)
        setJob(next)
        if (!live(next.status)) onChanged()
      } catch {
        setJob(null)
      }
    }, POLL_MS)
    return () => clearTimeout(timer)
  }, [job, onChanged])

  async function run() {
    setError(null)
    try {
      const { job_id } = await api<{ job_id: string }>(`/workflows/${wf.id}/run`, {})
      setJob(await api<JobSnapshot>(`/jobs/${job_id}`))
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const last = lastRun(wf)
  const status = running ? { dot: 'dot-info dot-live', label: 'Running' } : STATUS[wf.status]
  const ended = job && !running ? (job.status === 'passed' ? 'Run passed' : 'Run ended') : null
  const alarm = !running && (wf.status === 'needs_attention' || wf.status === 'failed')

  return (
    <article className="wf-card">
      <div className="wf-card-text">
        <div className="wf-card-top">
          <span className={`dot ${status.dot}`} aria-hidden="true" />
          <h2 title={wf.title}>{wf.title}</h2>
        </div>
        <p className="wf-card-goal muted" title={wf.goal}>
          {wf.goal}
        </p>
        <p className="wf-card-meta small">
          <span className={alarm ? 'text-warn' : 'muted'}>{ended ?? status.label}</span>
          {last && <span className="subtle"> · last run {ago(last.started)}</span>}
        </p>
        {error && <p className="request-error small">{error}</p>}
      </div>
      <div className="wf-card-actions">
        {wf.script && (
          <button type="button" onClick={run} disabled={running || wf.status === 'building'}>
            {running && <span className="spinner" aria-hidden="true" />}
            {running ? 'Running…' : 'Run'}
          </button>
        )}
        <button type="button" className="secondary" onClick={onOpen} title="Open in full">
          Open
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 3h6v6M21 3l-9 9M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
          </svg>
        </button>
      </div>
    </article>
  )
}

/** The Home tab: every workflow as a wide card, the most recently touched first. */
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
  const sorted = [...workflows].sort((a, b) => b.updated - a.updated)
  return (
    <div className="page dashboard">
      <header className="view-head">
        <div className="view-title">
          <h1>Home</h1>
          <p className="muted">Run a workflow from here, or open it for its details and history.</p>
        </div>
        <div className="view-actions">
          <button type="button" onClick={onNew}>
            + New workflow
          </button>
        </div>
      </header>
      {sorted.length === 0 ? (
        <div className="dash-empty">
          <p className="muted">Nothing automated yet.</p>
          <button type="button" className="secondary" onClick={onNew}>
            Build your first workflow
          </button>
        </div>
      ) : (
        <div className="wf-grid">
          {sorted.map((wf) => (
            <WorkflowCard key={wf.id} wf={wf} onOpen={() => onOpen(wf.id)} onChanged={onChanged} />
          ))}
        </div>
      )}
    </div>
  )
}
