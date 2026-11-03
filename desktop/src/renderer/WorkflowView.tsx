import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'

import { BuildCard } from './BuildCard'
import { DROP_SPRING, prefersReducedMotion, type Intro } from './Flight'
import { ActivityPopup, FEED_OUT_MS, Popup, StepFeed } from './StepFeed'
import { api, live, openExternal, type JobSnapshot, type Plan, type RunSummary, type UserRequest, type Workflow } from './api'

const POLL_MS = 900

const HOW_LABEL: Record<string, string> = {
  connector: 'Account',
  file: 'Data file',
  menu: 'Menus',
  keyboard: 'Keyboard',
  accessibility: 'Accessibility',
  coordinates: 'Clicks',
  compute: 'Compute',
  verify: 'Check',
}

function when(ts: number): string {
  return new Date(ts * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function summaryText(summary: unknown): string {
  if (!summary || typeof summary !== 'object') return summary ? String(summary) : ''
  return Object.entries(summary as Record<string, unknown>)
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ')
}

// ---------- requests that wait on the user ----------

const BACKUP_LABEL: Record<string, string> = {
  files: 'Copies its data files',
  app: "Uses the app's own backup",
  export: 'Exports and re-imports',
  none: 'No backup',
}

function PlanSteps({ plan }: { plan: Plan }) {
  return (
    <>
      <PlanList plan={plan} />
      {plan.backup && (
        <div className={`plan-backup${plan.backup.method === 'none' ? ' plan-backup-none' : ''}`}>
          <div className="plan-title">
            Before each test <span className="how how-backup">{BACKUP_LABEL[plan.backup.method] ?? plan.backup.method}</span>
          </div>
          <div className="muted small">
            {plan.backup.method === 'none'
              ? `${plan.backup.detail} With no automatic undo, the builder reverses each test by hand.`
              : `${plan.backup.detail} Retronaut restores this backup after each test, so your first run does the work.`}
          </div>
        </div>
      )}
    </>
  )
}

/** Each step's detail is cut to one line; the step (anywhere on it, or its read button, which
 *  keyboards and screen readers use) opens the whole step in a Popup. */
function PlanList({ plan }: { plan: Plan }) {
  const [reading, setReading] = useState<number | null>(null)
  const step = reading === null ? null : plan.steps[reading]
  return (
    <>
      <ol className="plan-steps">
        {plan.steps.map((s, i) => (
          <li key={i} onClick={() => setReading(i)}>
            <span className="plan-num">{i + 1}</span>
            <div className="plan-body">
              <span className={`how how-${s.how}`}>{HOW_LABEL[s.how] ?? s.how}</span>
              <div className="plan-title plan-step-name">{s.title}</div>
              <div className="plan-detail muted small">{s.detail}</div>
            </div>
            <button type="button" className="plan-read" aria-label={`Read step ${i + 1}`} title="Read" aria-haspopup="dialog" onClick={() => setReading(i)}>
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M8 4.2C6.8 3.3 5 2.8 2.5 2.8v9.4c2.5 0 4.3.5 5.5 1.4 1.2-.9 3-1.4 5.5-1.4V2.8c-2.5 0-4.3.5-5.5 1.4Zm0 0v9.4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </li>
        ))}
      </ol>
      <Popup open={step !== null} label="Plan step" title={step?.title} onClose={() => setReading(null)}>
        {step && reading !== null && (
          <div className="plan-read-view">
            <div className="plan-read-meta">
              <span className="plan-num">{reading + 1}</span>
              <span className="muted small">
                Step {reading + 1} of {plan.steps.length}
              </span>
              <span className={`how how-${step.how}`}>{HOW_LABEL[step.how] ?? step.how}</span>
            </div>
            <p className="plan-read-text">{step.detail}</p>
          </div>
        )}
      </Popup>
    </>
  )
}

function RequestCard({ request, onAnswer }: { request: UserRequest; onAnswer: (approved: boolean, feedback?: string) => Promise<void> }) {
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const answer = async (approved: boolean, text?: string) => {
    setBusy(true)
    try {
      await onAnswer(approved, text)
    } finally {
      setBusy(false)
    }
  }

  if (request.kind === 'plan') {
    const plan = request.data.plan as Plan
    return (
      <section className="card request request-plan" aria-label="Review the plan">
        <div className="request-head">
          <span className="request-icon" aria-hidden="true">✦</span>
          <div>
            <h2>Here's the plan</h2>
            <p className="muted">{plan.summary}</p>
          </div>
        </div>
        <PlanSteps plan={plan} />
        <textarea
          className="feedback"
          placeholder="Anything to change? (optional)"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          rows={2}
        />
        <div className="request-actions">
          <button type="button" className="secondary" disabled={busy || !feedback.trim()} onClick={() => answer(false, feedback)}>
            Send changes
          </button>
          <button type="button" disabled={busy} onClick={() => answer(true, feedback)}>
            Approve plan
          </button>
        </div>
      </section>
    )
  }

  if (request.kind === 'question') {
    return <QuestionCard request={request} onAnswer={answer} busy={busy} />
  }

  if (request.kind === 'connector') {
    const url = String(request.data.url ?? '')
    const name = String(request.data.connector ?? '')
    return (
      <section className="card request request-attention" aria-label={request.title}>
        <div className="request-head">
          <span className="request-icon connector" aria-hidden="true">@</span>
          <div>
            <h2>{request.title}</h2>
            <p className="muted">{request.reason}</p>
            <p className="small muted">
              Retronaut uses Factory's {name || 'account'} connector: you sign in once, and Factory keeps the access token. Nothing is sent or changed without being part of your plan.
            </p>
          </div>
        </div>
        <div className="request-actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => answer(false)}>
            Not now
          </button>
          {url && (
            <button type="button" className="secondary" onClick={() => openExternal(url)}>
              Open sign-in
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => answer(true)}>
            I've connected it
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="card request request-attention" aria-label={request.title}>
      <div className="request-head">
        <span className="request-icon" aria-hidden="true">⌘</span>
        <div>
          <h2>{request.title}</h2>
          <p className="muted">{request.reason}</p>
          <p className="small muted">
            Retronaut will open it, read its windows and data, and click and type only inside it.
            {request.data.kind === 'gtk' && ' It mostly uses menus and the keyboard here, since this app shows little to accessibility.'}
          </p>
        </div>
      </div>
      <div className="request-actions">
        <button type="button" className="secondary" disabled={busy} onClick={() => answer(false)}>
          Don't allow
        </button>
        <button type="button" disabled={busy} onClick={() => answer(true)}>
          Allow
        </button>
      </div>
    </section>
  )
}

type Asked = { index: number; topic: string; question: string; options: string[]; multiSelect?: boolean }

/** droid's AskUser: one or more questions, each with options and room for your own answer, shown one at a time. */
function QuestionCard({ request, onAnswer, busy }: { request: UserRequest; onAnswer: (approved: boolean, feedback?: string) => Promise<void>; busy: boolean }) {
  const asked = (request.data.questions as Asked[] | undefined) ?? []
  const [answers, setAnswers] = useState<string[]>(() => asked.map(() => ''))
  const [step, setStep] = useState(0)
  const set = (i: number, value: string) => setAnswers((prev) => prev.map((a, j) => (j === i ? value : a)))
  const toggle = (i: number, option: string) => {
    const picked = answers[i] ? answers[i].split('; ') : []
    set(i, (picked.includes(option) ? picked.filter((p) => p !== option) : [...picked, option]).join('; '))
  }
  const q = asked[step]
  const last = step >= asked.length - 1
  const answered = Boolean(answers[step]?.trim())
  return (
    <section className="card request request-attention" aria-label={request.title}>
      <div className="request-head">
        <span className="request-icon" aria-hidden="true">?</span>
        <div>
          <h2>The builder has {asked.length === 1 ? 'a question' : 'some questions'}</h2>
        </div>
        {asked.length > 1 && (
          <span className="request-count" aria-label={`Question ${step + 1} of ${asked.length}`}>
            {step + 1}/{asked.length}
          </span>
        )}
      </div>
      {q && (
        <div key={q.index} className="question">
          <div className="question-text">{q.question}</div>
          <div className="options">
            {q.options.map((o) => {
              const chosen = q.multiSelect ? answers[step].split('; ').includes(o) : answers[step] === o
              return (
                <button key={o} type="button" className={`option${chosen ? ' chosen' : ''}`} onClick={() => (q.multiSelect ? toggle(step, o) : set(step, o))}>
                  {o}
                </button>
              )
            })}
          </div>
          <input
            className="feedback"
            placeholder="Or write your own answer"
            value={q.options.includes(answers[step]) ? '' : answers[step]}
            onChange={(e) => set(step, e.target.value)}
          />
        </div>
      )}
      <div className="request-actions">
        <button type="button" className="secondary" disabled={busy} onClick={() => onAnswer(false)}>
          Skip
        </button>
        {step > 0 && (
          <button type="button" className="secondary" disabled={busy} onClick={() => setStep(step - 1)}>
            Back
          </button>
        )}
        {last ? (
          <button type="button" disabled={busy || answers.some((a) => !a.trim())} onClick={() => onAnswer(true, JSON.stringify(answers))}>
            Answer
          </button>
        ) : (
          <button type="button" disabled={!answered} onClick={() => setStep(step + 1)}>
            Next
          </button>
        )}
      </div>
    </section>
  )
}

/** A card arriving under the build bar: from `from` px above, behind the bar, to its place,
 *  coming into focus on the way. The blur has its own smooth ease (the spring's overshoot would
 *  push it below zero) and clears just as the card settles. */
function dropIn(card: HTMLElement, from: number, delay: number): void {
  card.animate(
    [
      { transform: `translateY(${from}px) scale(0.96)`, opacity: 0 },
      { offset: 0.06, opacity: 1 },
      { transform: 'none', opacity: 1 },
    ],
    { duration: 900, delay, easing: DROP_SPRING, fill: 'backwards' },
  )
  card.animate([{ filter: 'blur(24px)' }, { filter: 'blur(0)' }], {
    duration: 850,
    delay,
    easing: 'cubic-bezier(0.4, 0, 0.6, 1)',
    fill: 'backwards',
  })
}

/** An answered card leaving: back up `to` px to the top of the screen, behind the bar, growing
 *  a little small and blurring away as it goes (drop-in in reverse). */
function leaveUp(card: HTMLElement, to: number, done: () => void): void {
  card.animate(
    [
      { transform: 'none', filter: 'blur(0)', opacity: 1 },
      { offset: 0.7, opacity: 1 },
      { transform: `translateY(${to}px) scale(0.96)`, filter: 'blur(24px)', opacity: 0 },
    ],
    { duration: 550, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' },
  ).onfinish = done
}

/** The cards to show for the pending requests: answered ones stay in place, leaving, when
 *  `animate`; new ones arrive where `pending` has them. */
function withLeaving(
  cards: { r: UserRequest; leaving: boolean }[],
  pending: UserRequest[],
  animate: boolean,
): { r: UserRequest; leaving: boolean }[] {
  const ids = new Set(pending.map((r) => r.id))
  const next = pending.map((r) => ({ r, leaving: false }))
  if (!animate) return next
  cards.forEach((c, i) => {
    if (ids.has(c.r.id)) return
    // After the nearest card above it that's still there, or at the very top.
    const above = cards.slice(0, i).reverse().find((a) => next.some((n) => n.r.id === a.r.id))
    next.splice(above ? next.findIndex((n) => n.r.id === above.r.id) + 1 : 0, 0, { r: c.r, leaving: true })
  })
  return next
}

/** A card that has moved (`by` px, from where it was to where it is now) glides there rather
 *  than jumping. Added to any glide it's already on, so a second move mid-way doesn't jump
 *  either. */
function glide(card: HTMLElement, by: number): void {
  card.animate([{ transform: `translateY(${by}px)` }, { transform: 'none' }], {
    duration: 500,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    composite: 'add',
  })
}

/** A build that has just started and reported nothing yet. */
function startingJob(workflowId: string): JobSnapshot {
  return { job_id: '', kind: 'build', workflow_id: workflowId, status: 'running', started: Date.now() / 1000, finished: null, result: null, requests: [], events: [] }
}

// ---------- activity ----------

/** The live job: what the agent is doing right now, and what it needs from the user. */
function JobPanel({
  job,
  onAnswer,
  onStop,
  onPause,
  spring = false,
  withCard = true,
}: {
  job: JobSnapshot
  onAnswer: (r: UserRequest, approved: boolean, feedback?: string) => Promise<void>
  onStop: () => Promise<void>
  onPause: (paused: boolean) => Promise<void>
  /** While a workflow builds: new cards drop in at the top, under the bar, one after another. */
  spring?: boolean
  /** The progress card; a build shows its progress in the bar at the top instead. */
  withCard?: boolean
}) {
  const [open, setOpen] = useState(false)
  const running = live(job.status)
  // Newest first: a new card arrives at the top and the others make room below it.
  const pending = job.requests.filter((r) => r.status === 'pending').reverse()

  // While building, an answered card doesn't vanish: it stays where it was, marked leaving,
  // until it has flown back up under the bar (leaveUp), then it's dropped.
  const [cards, setCards] = useState(() => pending.map((r) => ({ r, leaving: false })))
  const pendingKey = pending.map((r) => r.id).join()
  const [seenKey, setSeenKey] = useState(pendingKey)
  if (pendingKey !== seenKey) {
    setSeenKey(pendingKey)
    setCards(withLeaving(cards, pending, spring && !prefersReducedMotion()))
  }
  const fresh = new Map(pending.map((r) => [r.id, r]))
  const gone = useCallback((id: string) => setCards((cs) => cs.filter((c) => !(c.leaving && c.r.id === id))), [])

  // When a card arrives or leaves, the ones that move glide to their new place (FLIP: from
  // where they were to where they are now) rather than jumping. While building, a new card
  // drops in from the very top of the screen, behind the bar, like an iOS notification, and
  // an answered one flies back up there.
  const list = useRef<HTMLDivElement>(null)
  const tops = useRef(new Map<string, number>())
  const resized = useRef<ResizeObserver | null>(null) // watching the cards' sizes (below)
  useLayoutEffect(() => {
    const el = list.current
    if (!el) return
    const motion = !prefersReducedMotion()
    const parent = (el.offsetParent as HTMLElement | null) ?? document.body
    const parentTop = parent.getBoundingClientRect().top - parent.scrollTop
    const children = Array.from(el.children) as HTMLElement[]
    // Lift leaving cards out of the flow first, so the others close the gap (and glide there).
    for (const child of children) {
      if (child.dataset.leaving === undefined || child.style.position === 'absolute') continue
      const { offsetTop: top, offsetLeft: left, offsetWidth: width } = child
      Object.assign(child.style, { position: 'absolute', top: `${top}px`, left: `${left}px`, width: `${width}px`, zIndex: '0' })
      leaveUp(child, -(parentTop + top), () => gone(child.dataset.key!))
    }
    const next = new Map<string, number>()
    // The first cards to arrive while building wait for the step in the middle to blur away.
    let arriving = 0
    const clear = spring && tops.current.size === 0 ? FEED_OUT_MS : 0
    for (const child of children) {
      const key = child.dataset.key
      if (!key || child.dataset.leaving !== undefined) continue
      const top = child.offsetTop // where it lands; its own transforms don't change this
      next.set(key, top)
      const before = tops.current.get(key)
      if (!motion) continue
      if (before === undefined) {
        // From the top of the screen (how far up that is from where it lands), a little
        // small, growing as it glides down, on one soft spring; one after another.
        if (spring) dropIn(child, -(parentTop + top), clear + arriving++ * 80)
      } else if (before !== top) {
        glide(child, before - top)
      }
    }
    tops.current = next
    for (const child of children) resized.current?.observe(child)
  })

  // A card changing size on its own (an answer making it shorter, say) moves the cards
  // around it, and itself, since they're centred: they glide there too, not only when the
  // list re-renders.
  useEffect(() => {
    const el = list.current
    if (!el || prefersReducedMotion()) return
    const watch = new ResizeObserver(() => {
      for (const child of Array.from(el.children) as HTMLElement[]) {
        const key = child.dataset.key
        if (!key || child.dataset.leaving !== undefined) continue // leaving: leaveUp has it
        const before = tops.current.get(key)
        if (before === undefined) continue // just arrived: dropIn has it
        const top = child.offsetTop
        if (before !== top) glide(child, before - top)
        tops.current.set(key, top)
      }
    })
    resized.current = watch
    for (const child of Array.from(el.children)) watch.observe(child)
    return () => {
      watch.disconnect()
      resized.current = null
    }
  }, [])

  return (
    <>
      <div className={`job${spring ? ' springing' : ''}`} ref={list}>
        {withCard && (
          <div data-key="progress">
            <BuildCard job={job} onStop={onStop} onPause={onPause} />
          </div>
        )}

        {cards.map(({ r: last, leaving }) => {
          const r = fresh.get(last.id) ?? last
          return (
            <div key={r.id} data-key={r.id} data-leaving={leaving || undefined} inert={leaving}>
              <RequestCard request={r} onAnswer={(approved, feedback) => onAnswer(r, approved, feedback)} />
            </div>
          )
        })}

        {!running && job.result?.error != null && (
          <section data-key="result"  className={`alert${job.result.review ? "" : " alert-error"}`} role="alert">
            <div className="alert-body">
              <h2>{job.result.review ? 'Needs your review' : job.kind === 'build' ? 'The build needs a human' : 'This run needs a human'}</h2>
              {job.result.review === true && <p className="small">The workflow stopped on purpose: this needs your decision, so nothing was healed or retried.</p>}
              <p className="mono small">{String(job.result.error)}</p>
            </div>
          </section>
        )}

        {!spring && (
          <section data-key="activity" className="card events" aria-label="Activity">
            <button type="button" className="events-bar" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
              <span className="events-bar-name">Activity</span>
              <span className="events-bar-latest muted">{job.events.length} events</span>
              <span className="events-bar-chevron" aria-hidden="true">
                <svg width="10" height="10" viewBox="0 0 10 10">
                  <path d="M3.5 2 6.5 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </button>
            <ActivityPopup open={open} events={job.events} start={job.started} onClose={() => setOpen(false)} />
          </section>
        )}
      </div>

      {/* While building, what it's doing sits in the middle of the page instead, out of the
          cards' way until they've all been answered and flown off. */}
      {spring && <StepFeed job={job} away={cards.length > 0} />}
    </>
  )
}

/** How long a passed run's card stays, green, before it closes (its colour eases over 0.4s of it). */
const FINISH_HOLD_MS = 1500

/** The workflow bar's tabs: an overview, the plan and its script, and the runs. */
const WF_TABS = ['Overview', 'Workflow details', 'Run history']

/** A past run in Run history: clicked, its log opens in a popup, as the live run's Activity does. */
function RunRow({ wfId, run }: { wfId: string; run: RunSummary }) {
  const [detail, setDetail] = useState<JobSnapshot | null>(null)
  const [open, setOpen] = useState(false)
  const show = async () => {
    const snap = detail ?? (await api<JobSnapshot>(`/workflows/${wfId}/runs/${run.job_id}`).catch(() => null))
    if (!snap) return
    setDetail(snap)
    setOpen(true)
  }
  const ok = run.status === 'passed'
  const name = run.kind === 'build' ? 'Build + test run' : run.healed ? 'Run · healed' : 'Run'
  return (
    <li className="run">
      <button type="button" className="run-row" onClick={show} aria-haspopup="dialog">
        <span className={`dot ${ok ? 'dot-ok' : 'dot-fail'}`} aria-hidden="true" />
        <span className="run-kind">{name}</span>
        <span className="muted small run-what">{ok ? summaryText(run.summary) : run.error}</span>
        <span className="muted small run-when">{when(run.started)}</span>
      </button>
      {detail && (
        <ActivityPopup
          open={open}
          title={`${name} · ${when(run.started)}`}
          events={detail.events.filter((e) => e.kind !== 'agent')}
          start={detail.started}
          onClose={() => setOpen(false)}
        />
      )}
    </li>
  )
}

export function WorkflowView({
  id,
  intro = null,
  introAnchor,
  introCard,
  onChanged,
  onDeleted,
}: {
  id: string
  /** Set when this page is the end of the send animation. */
  intro?: Intro | null
  /** The caption the flying prompt lands on. */
  introAnchor?: (el: HTMLElement | null) => void
  /** The progress card the composer's box becomes. */
  introCard?: (el: HTMLElement | null) => void
  onChanged: () => void
  onDeleted: () => void
}) {
  const [wf, setWf] = useState<Workflow | null>(null)
  const [job, setJob] = useState<JobSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showScript, setShowScript] = useState(false)
  const [tab, setTab] = useState(0)
  const page = useRef<HTMLDivElement>(null)

  const loadWorkflow = useCallback(async () => {
    const next = await api<Workflow>(`/workflows/${id}`)
    setWf(next)
    return next
  }, [id])

  // On open: the workflow, and its build job if that's still going.
  useEffect(() => {
    setJob(null)
    setShowScript(false)
    loadWorkflow()
      .then(async (w) => {
        const latest = w.runs[0]?.job_id ?? w.build_job
        const candidate = w.status === 'building' ? w.build_job : latest
        if (candidate) {
          const snap = await api<JobSnapshot>(`/jobs/${candidate}`).catch(() => null)
          if (snap && live(snap.status)) setJob(snap)
        }
      })
      .catch((e: Error) => setError(e.message))
  }, [id, loadWorkflow])

  // Follow the live job; refresh the workflow when it ends.
  const jobId = job?.job_id
  const jobLive = live(job?.status)
  useEffect(() => {
    if (!jobId || !jobLive) return
    let stopped = false
    const tick = async () => {
      try {
        // The whole snapshot each time: it's local, and a few hundred events at most.
        const snap = await api<JobSnapshot>(`/jobs/${jobId}`)
        if (stopped) return
        setJob(snap)
        if (!live(snap.status)) {
          await loadWorkflow()
          onChanged()
          return
        }
        // The plan and connectors land on the workflow while building.
        if (snap.requests.some((r) => r.status === 'pending')) void loadWorkflow()
      } catch (e) {
        setError((e as Error).message)
      }
      if (!stopped) setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      stopped = true
    }
  }, [jobId, jobLive, loadWorkflow, onChanged])

  async function answer(r: UserRequest, approved: boolean, feedback = '') {
    if (!job) return
    const updated = await api<UserRequest>(`/jobs/${job.job_id}/requests/${r.id}`, { approved, feedback })
    setJob((prev) => (prev ? { ...prev, requests: prev.requests.map((x) => (x.id === updated.id ? updated : x)), status: 'running' } : prev))
  }

  async function stop() {
    if (!job) return
    setJob(await api<JobSnapshot>(`/jobs/${job.job_id}/stop`, {}))
    await loadWorkflow()
    onChanged()
  }

  async function pause(paused: boolean) {
    if (!job) return
    setJob(await api<JobSnapshot>(`/jobs/${job.job_id}/${paused ? 'pause' : 'resume'}`, {}))
  }

  async function run() {
    setError(null)
    try {
      const { job_id } = await api<{ job_id: string }>(`/workflows/${id}/run`, {})
      setJob(await api<JobSnapshot>(`/jobs/${job_id}`))
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function remove() {
    try {
      await api(`/workflows/${id}`, undefined, 'DELETE')
      onDeleted()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // While it builds, its progress is a bar across the top of the page, with the prompt in
  // it as a dim caption; the send animation's box becomes that bar, its text the caption.
  const building = wf ? wf.status === 'building' : intro !== null
  // Until the build reports in, the bar shows a fresh "starting" build.
  const starting = useMemo(() => (building ? startingJob(id) : null), [building, id])
  const shown = job ?? starting
  const arriving = intro !== null && !intro.landed
  const bar = building && shown && (
    // landing: set once the box has landed, so the contents' fade-in starts then (not while hidden).
    <div className={`build-bar-wrap${arriving ? ' arriving' : ''}${intro?.landed ? ' landing' : ''}`}>
      <BuildCard
        job={shown}
        onStop={stop}
        onPause={pause}
        cardRef={introCard}
        bar={{
          caption: (
            <p className="build-caption" ref={introAnchor} style={intro ? { width: intro.width } : undefined}>
              “{wf?.goal ?? intro?.prompt}”
            </p>
          ),
        }}
      />
    </div>
  )

  // The cards under the bar spring in when it settles (with its progress starting), even if
  // the workflow itself hasn't loaded yet. They mount a couple of frames after the bar takes
  // over, so the frame where the flight hands off to the bar is just that swap, not the
  // panel's mount and measuring as well.
  const [held, setHeld] = useState(arriving)
  useEffect(() => {
    if (arriving) return setHeld(true)
    let frame = requestAnimationFrame(() => (frame = requestAnimationFrame(() => setHeld(false))))
    return () => cancelAnimationFrame(frame)
  }, [arriving])
  const panel = shown && !arriving && !held && (
    // A run's progress card is up in the workflow bar instead (below); the rest stays here.
    <JobPanel job={shown} onAnswer={answer} onStop={stop} onPause={pause} spring={building} withCard={!building && shown.kind !== 'run'} />
  )

  const built = !building && wf !== null
  // What scrolls up under the workflow bar fades out as the full log does under the build
  // bar (Shell.css .step-list): clear from 20px under the window's top, whole again 16px
  // under the bar. The page scrolls with the main area, the bar pinned in it, so the fade is
  // kept where the window's top and the bar are as it scrolls (Shell.css .fade-under-bar).
  useLayoutEffect(() => {
    const el = page.current
    const main = el?.closest('.main')
    const bar = main?.querySelector('.wf-bar')
    if (!built || !el || !main || !bar) return
    const place = () => {
      const top = el.getBoundingClientRect().top
      el.style.setProperty('--fade-from', `${main.getBoundingClientRect().top + 20 - top}px`)
      el.style.setProperty('--fade-to', `${bar.getBoundingClientRect().bottom + 16 - top}px`)
    }
    place()
    main.addEventListener('scroll', place, { passive: true })
    const resized = new ResizeObserver(place)
    resized.observe(bar)
    resized.observe(el)
    return () => {
      main.removeEventListener('scroll', place)
      resized.disconnect()
    }
  }, [built])

  // Scrolled down the page, the header closes up to just its title row (the prompt under it,
  // or a run's progress card), opening again only back at the very top. Only if the page
  // stays scrolled once it's closed: on a short page, closing would pull it back to the top,
  // open it again, and loop.
  const busy = live(job?.status)
  const runningNow = busy && job?.kind === 'run'
  // A run that passes doesn't close at once: its card turns green (border and blocks) and
  // stays a moment, then closes; one that stops on purpose for review does the same in yellow.
  // Failed or stopped, it closes straight away (the alert under the bar says why). Worked out
  // as the run stops, in the same render (not after it), so the card is never closed for a
  // frame in between; it keeps its colour, closed, until the next run.
  const [wasRunning, setWasRunning] = useState(runningNow)
  const [finishing, setFinishing] = useState(false)
  const [ending, setEnding] = useState<'passed' | 'review' | null>(null)
  if (wasRunning !== runningNow) {
    setWasRunning(runningNow)
    const how =
      runningNow || job?.kind !== 'run' ? null : job.status === 'passed' ? 'passed' : job.result?.review === true ? 'review' : null
    setFinishing(how !== null)
    setEnding(how)
  }
  useEffect(() => {
    if (!finishing) return
    const timer = setTimeout(() => setFinishing(false), FINISH_HOLD_MS)
    return () => clearTimeout(timer)
  }, [finishing])
  const cardOpen = runningNow || finishing

  const [tucked, setTucked] = useState(false)
  useEffect(() => {
    const main = page.current?.closest('.main')
    if (!built || !main) return
    const onScroll = () => {
      if (main.scrollTop <= 2) return setTucked(false)
      setTucked((was) => {
        if (was) return true
        const part =
          main.querySelector<HTMLElement>('.wf-head.running .wf-bar-run-inner') ?? main.querySelector<HTMLElement>('.wf-head .wf-goal-inner')
        return part !== null && main.scrollHeight - main.clientHeight - part.offsetHeight > 2
      })
    }
    onScroll()
    main.addEventListener('scroll', onScroll, { passive: true })
    return () => main.removeEventListener('scroll', onScroll)
  }, [built])

  if (!wf) {
    return (
      <>
        {bar}
        <div className="page workflow">
          {panel}
          {error ? <p className="request-error">{error}</p> : !intro && <p className="muted">Loading…</p>}
        </div>
      </>
    )
  }

  // Once built, the title, the prompt, its status and Run now sit in a glass bar across the
  // top, as the build's progress did, with tabs along its bottom edge where the progress was.
  const head = !building && (
    <div className="build-bar-wrap">
      <section className="build-bar wf-bar">
        <div className="build-bar-inner">
          {/* While a run goes, the header becomes the top of its progress card: the card fades
              and settles in around it, the header shrinking a little into it, and the run's
              progress opens under it. When the run ends, it all eases back. */}
          <div className={`wf-head${cardOpen ? ' running' : ''}${ending ? ` ${ending}` : ''}${tucked ? ' tucked' : ''}`}>
            <header className="view-head">
              <div className="view-title">
                <h1 title={wf.title}>{wf.title}</h1>
                {/* The prompt under the title, until a run's progress takes its place or the
                    page is scrolled (then just the title shows). */}
                <div className="wf-goal" inert={cardOpen || tucked}>
                  <div className="wf-goal-inner">
                    <p className="muted goal" title={wf.goal}>
                      “{wf.goal}”
                    </p>
                  </div>
                </div>
              </div>
              <div className="view-actions">
                {/* While its run goes, Run now becomes its Stop (the card under it has none); while
                    the card holds its colour as the run ends (green, passed; yellow, stopped for
                    review), a greyed-out Ending, until it closes. All three labels sit in the
                    button, the others hidden, so it keeps Run now's width. */}
                {wf.script && (
                  <button
                    type="button"
                    className={`run-stop${runningNow ? ' secondary stop' : finishing ? ' secondary' : ''}`}
                    onClick={runningNow ? stop : run}
                    disabled={(busy && !runningNow) || finishing}
                  >
                    <span className={runningNow || finishing ? 'off' : undefined}>Run now</span>
                    <span className={runningNow ? undefined : 'off'}>Stop</span>
                    <span className={finishing ? undefined : 'off'}>Ending</span>
                  </button>
                )}
              </div>
            </header>
            <div className="wf-bar-run" inert={!cardOpen}>
              <div className="wf-bar-run-inner">{job?.kind === 'run' && <BuildCard job={job} onPause={pause} bare />}</div>
            </div>
          </div>
        </div>
        <div className="wf-tabs" role="tablist" aria-label="Workflow sections">
          {WF_TABS.map((label, i) => (
            <button
              key={label}
              type="button"
              role="tab"
              id={`wf-tab-${i}`}
              aria-controls="wf-tab-panel"
              aria-selected={tab === i}
              className={`wf-tab${tab === i ? ' on' : ''}`}
              onClick={() => setTab(i)}
            >
              {label}
            </button>
          ))}
          {/* One underline, sliding to whichever tab is chosen. */}
          <span className="wf-tab-line" aria-hidden="true" style={{ '--tab': tab, '--tabs': WF_TABS.length } as CSSProperties} />
        </div>
        {/* The window drags by this strip along the bar's top edge only (Shell.css .wf-bar-drag).
            Last in the bar: Electron reads drag areas in document order, a later no-drag one
            (the bar's contents, which reach up under the strip) cutting out an earlier drag one,
            so first it would be cut away entirely. */}
        <div className="wf-bar-drag" aria-hidden="true" />
      </section>
    </div>
  )
  return (
    <>
      {bar}
      {head}
      <div ref={page} className={`page workflow${building ? ' is-building' : ' fade-under-bar'}`}>

        {error && <p className="request-error">{error}</p>}

        {/* While building there are no tabs: what it's doing sits here. Once built, it's on the
            Overview tab (below). */}
        {wf.status === 'building' && panel}

        {wf.status !== 'building' && (
          <div className="wf-tab-panel" id="wf-tab-panel" role="tabpanel" aria-labelledby={`wf-tab-${tab}`}>
            {tab === 0 && (
              <>
                {/* The run's activity, and anything it needs from you (an approval, or why it
                    stopped), only here, above the prompt. */}
                {panel}
                <section className="card">
                  <div className="card-head">
                    <h2>Prompt</h2>
                  </div>
                  <p className="muted goal">“{wf.goal}”</p>
                </section>
              </>
            )}

            {tab === 1 && (
              <section className="card">
                <div className="card-head">
                  <h2>How it works</h2>
                  <span className="muted small">
                    {[...wf.apps.map((a) => a.app), ...wf.connectors.map((c) => c[0].toUpperCase() + c.slice(1))].join(' · ')}
                  </span>
                </div>
                {wf.plan ? <PlanSteps plan={wf.plan} /> : <p className="muted small">{wf.note || 'No plan was recorded.'}</p>}
                {wf.script && (
                  <div className="script">
                    <button type="button" className="link" onClick={() => setShowScript(!showScript)}>
                      {showScript ? 'Hide the script' : 'Show the script'}
                    </button>
                    {showScript && <pre className="code">{wf.script}</pre>}
                  </div>
                )}
              </section>
            )}

            {/* Just the runs, newest first, as a list on the page rather than in a card. */}
            {tab === 2 && (
              <section className="run-history" aria-label="Run history">
                {wf.runs.length === 0 ? (
                  <p className="muted small">No runs yet.</p>
                ) : (
                  <ul className="runs">
                    {wf.runs.map((r) => (
                      <RunRow key={r.job_id} wfId={wf.id} run={r} />
                    ))}
                  </ul>
                )}
                {!busy && (
                  <button type="button" className="link danger" onClick={remove}>
                    Delete workflow
                  </button>
                )}
              </section>
            )}
          </div>
        )}
      </div>
    </>
  )
}
