import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { friendly, jobTitle, recentSteps, stepProgress } from './BuildCard'
import { api, live, pipChipHover, stopLive, type JobEvent, type JobSnapshot } from './api'
import { DROP_MS, DROP_SPRING, LEAVE_EASE, LEAVE_MS } from '../shared/motion'
import { prefersReducedMotion } from './Flight'
import { BUILD_PHASES, buildPhase } from './phases'

const POLL_MS = 800

type LiveJob = JobSnapshot & { title: string; expected_steps: number | null }

/**
 * How far along it is, in segments: a build's phases, or the steps a run took last time it
 * worked (null until there's been one). `at` is the segment it's on; past the end when done.
 */
function segments(job: LiveJob): { count: number; at: number } | null {
  if (job.kind === 'build')
    return {
      count: BUILD_PHASES.length,
      at: job.status === 'passed' ? BUILD_PHASES.length : buildPhase(job),
    }
  if (!job.expected_steps) return null
  const at = job.events.reduce((most, e) => Math.max(most, Number(/^Step (\d+):/.exec(e.label)?.[1] ?? 0)), 0)
  return { count: Math.max(job.expected_steps, at), at: Math.max(0, at - 1) }
}

/**
 * A ring of `count` segments around the top-right corner: done ones lit, the current one
 * glowing. `full` (a run passed): one solid ring instead, no segments, drawn in round from
 * the top over a plain track (Shell.css).
 */
function ProgressRing({ count, at, paused, full }: { count: number; at: number; paused: boolean; full: boolean }) {
  const gap = 5 // of the ring's 100, between segments
  const length = 100 / count - gap
  return (
    <svg className={`pip-ring${full ? ' full' : ''}`} width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      {full ? (
        <>
          <circle cx="10" cy="10" r="8" />
          <circle className="done" cx="10" cy="10" r="8" pathLength="100" />
        </>
      ) : (
        Array.from({ length: count }, (_, i) => (
          <circle
            key={i}
            className={i < at ? 'done' : i === at ? `now${paused ? ' held' : ''}` : ''}
            cx="10"
            cy="10"
            r="8"
            pathLength="100"
            strokeDasharray={`${length} ${100 - length}`}
            strokeDashoffset={-(i * (100 / count) + gap / 2)}
          />
        ))
      )}
    </svg>
  )
}

/**
 * The last few steps, newest at the bottom: a new one slides in from below and pushes the
 * rest up, the oldest fading under the panel's top edge (more are kept than fit, so they
 * leave there rather than vanishing). A whole new set (the first, or a new build's or run's)
 * fades in quickly where it is. Steps that come in together (a poll can bring a batch) are
 * let in one after another, STEP_GAP_MS apart, so the list climbs through them rather than
 * jumping; each move adds to the one under way, so they run on smoothly into each other.
 */
const KEEP = 8 // shown: more than fit, so the oldest leave under the top edge
const STEP_GAP_MS = 160
function Steps({ jobId, steps, events }: { jobId: string; steps: JobEvent[]; events: JobEvent[] }) {
  const list = useRef<HTMLUListElement>(null)
  const tops = useRef(new Map<string, number>())
  const last = steps[steps.length - 1]?.i ?? -1
  // The newest step let in so far; a new build or run starts with all of its steps in.
  const [shown, setShown] = useState({ jobId, upTo: last })
  let upTo = shown.jobId === jobId ? shown.upTo : last
  // Never more than a screenful behind: past that, skip to the last KEEP waiting.
  const waiting = steps.filter((e) => e.i > upTo)
  if (prefersReducedMotion()) upTo = last
  else if (waiting.length > KEEP) upTo = waiting[waiting.length - KEEP - 1]!.i
  if (shown.jobId !== jobId || shown.upTo !== upTo) setShown({ jobId, upTo })
  const next = waiting.find((e) => e.i > upTo)?.i
  useEffect(() => {
    if (next === undefined) return
    const timer = setTimeout(() => setShown({ jobId, upTo: next }), STEP_GAP_MS)
    return () => clearTimeout(timer)
  }, [jobId, next])
  const visible = steps.filter((e) => e.i <= upTo).slice(-KEEP)

  useLayoutEffect(() => {
    const el = list.current
    if (!el) return
    const motion = !prefersReducedMotion()
    const items = Array.from(el.children) as HTMLElement[]
    const fresh = !items.some((li) => tops.current.has(li.dataset.key!)) // nothing carried over
    const next = new Map<string, number>()
    for (const li of items) {
      const key = li.dataset.key!
      const top = li.offsetTop
      next.set(key, top)
      if (!motion) continue
      if (fresh) {
        li.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 250,
          easing: 'ease-out',
        })
        continue
      }
      const before = tops.current.get(key)
      // Added to any move already under way: from where it is on screen, not where it was laid out.
      const move = {
        duration: 450,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        composite: 'add',
      } as const
      if (before === undefined) {
        li.animate([{ transform: `translateY(${li.offsetHeight + 6}px)` }, { transform: 'translateY(0)' }], move)
        li.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 300,
          easing: 'ease-out',
        })
      } else if (before !== top) li.animate([{ transform: `translateY(${before - top}px)` }, { transform: 'translateY(0)' }], move)
    }
    tops.current = next
  })
  return (
    <ul className="pip-steps" aria-label="Recent steps" ref={list}>
      {visible.map((e) => (
        <li key={`${jobId}:${e.i}`} data-key={`${jobId}:${e.i}`}>
          <span className={`dot dot-${e.kind}`} aria-hidden="true" />
          <span className="hint-text">{friendly(e, events)}</span>
        </li>
      ))}
    </ul>
  )
}

/** The hole the pointer opens in the card: its radius, its soft edge starting about halfway in. */
const HOLE_R = 100

/** Switching between the chips (orange, yellow, green): the one leaving, then the one arriving. */
const CHIP_LEAVE_MS = 160
const CHIP_ARRIVE_MS = 400

/** What Retronaut is doing in an app right now (overlay.ts sends it, from uiActivity). */
type Activity = {
  active: boolean
  app: string
  paused: boolean
  action: string
  /** A run just passed: the green chip, the card leaving with it a moment later. */
  finished: boolean
}

/** Which chip: working (orange), waiting for you (yellow), or the run passed (green). */
type ChipFace = 'work' | 'wait' | 'done'

/**
 * The activity chip, under the steps and outside their panel, as the title row sits above
 * them: what Retronaut is doing in an app (yellow while it waits for you to let go of the
 * mouse and keyboard) and a Stop button. It opens while Retronaut drives an app, the card
 * growing down to hold it, and closes after, keeping its last words while it shrinks away.
 * The pointer over it doesn't fade the card, so Stop can be reached and clicked.
 * When a run passes it opens (or hands over) once more, green, saying so, a check mark in
 * place of Stop, and stays as the card leaves.
 */
function ActivityChip({ activity }: { activity: Activity }) {
  // The last thing it said, kept while it closes.
  const [last, setLast] = useState(activity)
  const open = activity.active || activity.finished
  if (open && activity !== last) setLast(activity)
  const { app, paused, action, finished } = open ? activity : last
  const kind: ChipFace = finished ? 'done' : paused ? 'wait' : 'work'
  // The row opens to the chip's measured height (CSS can't animate to `auto`), kept current
  // as the chip's text changes, so the card always grows exactly enough to hold it.
  const row = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = inner.current
    if (!el) return
    const measure = () => row.current?.style.setProperty('--chip-h', `${el.offsetHeight}px`)
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(el)
    return () => watch.disconnect()
  }, [])

  // Which chip shows: the orange one (working), the yellow one (waiting for you) or the green
  // one (the run passed). Opening from closed (or closing), it's whichever is wanted. Switching
  // while it's open, one hands over to the other: the one showing leaves as the chip does when
  // it closes (scaling down and fading), the other takes its place unseen, then arrives as the
  // chip does when it opens (scaling up and fading in), the row holding its height throughout.
  // A switch back while the first is still leaving just brings in whichever is wanted by then.
  const chip = useRef<HTMLDivElement>(null)
  const [face, setFace] = useState<ChipFace>(kind)
  const wasOpen = useRef(open)
  if (!wasOpen.current && open && kind !== face) setFace(kind) // opening: no handover
  useEffect(() => {
    wasOpen.current = open
  })
  const [arrivals, setArrivals] = useState(0) // each handover's arrival
  const wanted = useRef(kind)
  wanted.current = kind
  const leaving = useRef<Animation | null>(null)
  useEffect(() => {
    if (kind === face || leaving.current) return
    const el = chip.current
    if (!el || !open || prefersReducedMotion()) {
      setFace(kind) // closed, or no motion: just the other one
      return
    }
    const out = el.animate(
      [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: 'scale(0.94)' },
      ],
      {
        duration: CHIP_LEAVE_MS,
        easing: 'cubic-bezier(0.4, 0, 1, 1)',
        fill: 'forwards',
      },
    )
    leaving.current = out
    out.finished.then(
      () => {
        setFace(wanted.current)
        setArrivals((n) => n + 1)
      },
      () => {
        leaving.current = null
      },
    )
  }, [kind, face, open])
  useLayoutEffect(() => {
    if (!arrivals) return
    const el = chip.current
    leaving.current?.cancel() // off its faded-out last frame, into the arrival's first
    leaving.current = null
    el?.animate(
      [
        { opacity: 0, transform: 'scale(0.94)' },
        { opacity: 1, transform: 'none' },
      ],
      {
        duration: CHIP_ARRIVE_MS,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
    )
  }, [arrivals])
  const waiting = face === 'wait'
  const done = face === 'done'

  return (
    <div
      ref={row}
      className={`pip-activity${open ? ' open' : ''}${waiting ? ' paused' : ''}${done ? ' finished' : ''}`}
      aria-hidden={!open}
    >
      <div className="pip-activity-inner" ref={inner}>
        <div className="pip-chip" ref={chip} role="status" onMouseEnter={() => pipChipHover(true)} onMouseLeave={() => pipChipHover(false)}>
          <span className="pip-chip-text">
            {/* What's asked of you on top, what it's doing (or how to let it go on) under it. */}
            <b className="pip-chip-main">{done ? 'Workflow finished' : waiting ? 'Waiting for you' : 'Hands off'}</b>
            {done ? (
              // Unseen, the two lines the other chips have, so this one is as tall as they
              // are, its one line centred over them.
              <span className="pip-chip-ghost" aria-hidden="true">
                <b className="pip-chip-main">&nbsp;</b>
                <span className="pip-chip-sub">&nbsp;</span>
              </span>
            ) : (
              <span className="pip-chip-sub">
                {waiting ? 'Let go of the mouse and keyboard' : action ? `${app || 'App'}: ${action}` : `Using ${app || 'an app'}`}
              </span>
            )}
          </span>
          {done ? (
            <span className="pip-chip-check" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="16" height="16">
                <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          ) : (
            <button type="button" className="pip-chip-stop" onClick={stopLive} tabIndex={activity.active ? 0 : -1}>
              Stop
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** Arriving, as the cards under the build bar drop in (WorkflowView's dropIn), but sharp
 *  throughout: its window glides down from past the top of the screen on the spring
 *  (overlay.ts) while the card grows a little on the same spring, showing at once. */
function arrive(card: HTMLElement): void {
  // .arriving: the chip, if it's showing, comes in as part of the card, not opening on its own.
  card.classList.add('arriving')
  const done = () => card.classList.remove('arriving')
  card
    .animate(
      [
        { transform: 'scale(0.96)', opacity: 0 },
        { offset: 0.06, opacity: 1 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: DROP_MS, easing: DROP_SPRING },
    )
    .finished.then(done, done)
}

/** Leaving, as they fly back up (WorkflowView's leaveUp): its window glides back past the top
 *  of the screen (overlay.ts) while the card shrinks a little and blurs, fading in its last
 *  stretch. It stays that way until the next build or run brings it back. */
function leave(card: HTMLElement): Animation {
  return card.animate(
    [
      { transform: 'none', filter: 'blur(0)', opacity: 1 },
      { offset: 0.7, opacity: 1 },
      { transform: 'scale(0.96)', filter: 'blur(24px)', opacity: 0 },
    ],
    { duration: LEAVE_MS, easing: LEAVE_EASE, fill: 'forwards' },
  )
}

/**
 * The picture-in-picture: what the build or run is doing and its last few steps,
 * floating in a corner of the screen while one is going. Display only; clicks pass
 * through its window, and the window fades away while the pointer is over the card.
 */
export function Pip() {
  const [job, setJob] = useState<LiveJob | null>(null)
  // The build or run has ended: the last card stays as it leaves (overlay.ts glides its
  // window away and hides it).
  const [leaving, setLeaving] = useState(false)
  const [activity, setActivity] = useState<Activity>({
    active: false,
    app: '',
    paused: false,
    action: '',
    finished: false,
  })

  useEffect(() => {
    document.body.classList.add('pip-body')
    let stopped = false
    const load = async () => {
      try {
        const live = await api<LiveJob | null>('/live')
        // Only coming back is up to the poll: leaving waits for overlay.ts (pipLeave), which
        // keeps the card a moment after a run passes, for its green chip.
        if (!stopped && live) {
          setJob(live)
          setLeaving(false)
        }
      } catch {
        // the engine is restarting; keep the last card
      }
    }
    const tick = async () => {
      await load()
      if (!stopped) setTimeout(tick, POLL_MS)
    }
    void tick()
    // overlay.ts, as the window starts gliding in: the new build or run, at once, not on the
    // next poll, so the last one's card isn't what comes down.
    // And as it starts gliding away: the card leaves with it, not on the next poll.
    // And whenever what it's doing in an app changes: the activity chip, at once.
    const own = window as Window & {
      pipRefresh?: () => Promise<void>
      pipLeave?: () => void
      pipActivity?: (a: Activity) => void
    }
    own.pipRefresh = load
    own.pipLeave = () => setLeaving(true)
    own.pipActivity = setActivity
    return () => {
      stopped = true
      delete own.pipRefresh
      delete own.pipLeave
      delete own.pipActivity
    }
  }, [])

  // While the card leaves, the chip holds what it showed as it started to go, so it blurs
  // away with the card as one piece rather than closing on its own under it (the run's end
  // also ends what it was doing in the app, closing the chip at the same moment).
  const held = useRef(activity)
  if (!leaving) held.current = activity

  const card = useRef<HTMLDivElement>(null)
  const shown = Boolean(job)

  // The pointer near the card opens a soft hole in it that follows the pointer, showing
  // what's under it (Shell.css .pip's mask), rather than hiding the whole card. The chip
  // sits above the hole, whole, so its Stop button can still be clicked, and the hole
  // closes while the pointer is on it. The window reaches
  // a clear margin past the card on every side (overlay.ts's PIP.pad), and though it ignores
  // the mouse it still hears it move, so the card knows when the pointer comes near.
  useEffect(() => {
    const follow = (e: MouseEvent) => {
      const el = card.current
      if (!el) return
      const box = el.getBoundingClientRect()
      // Over the chip, the hole closes (shrinking smoothly, Shell.css), so the chip and its
      // Stop button sit on whole card; it opens again as the pointer leaves the chip.
      const chip = el.querySelector('.pip-activity.open .pip-chip')?.getBoundingClientRect()
      const overChip = chip && e.clientX >= chip.left && e.clientX <= chip.right && e.clientY >= chip.top && e.clientY <= chip.bottom
      el.style.setProperty('--hole-x', `${e.clientX - box.left}px`)
      el.style.setProperty('--hole-y', `${e.clientY - box.top}px`)
      el.style.setProperty('--hole-r', overChip ? '0px' : `${HOLE_R}px`)
    }
    const away = () => card.current?.style.setProperty('--hole-r', '0px')
    window.addEventListener('mousemove', follow)
    document.documentElement.addEventListener('mouseleave', away)
    return () => {
      window.removeEventListener('mousemove', follow)
      document.documentElement.removeEventListener('mouseleave', away)
    }
  }, [])
  useLayoutEffect(() => {
    const el = card.current
    if (!el || prefersReducedMotion()) return
    if (!leaving) {
      arrive(el)
      return
    }
    const out = leave(el)
    return () => out.cancel() // a new build or run: it arrives again
  }, [shown, leaving])

  if (!job) return null
  const ring = segments(job)
  // A run that passed reads as every step done, whatever step it last reported.
  const reported = stepProgress(job, job.expected_steps)
  const total = ring?.count ?? Number(/^Step (\d+)/.exec(reported ?? '')?.[1] ?? 0)
  const progress = held.current.finished && total ? `Step ${total}/${total}` : reported
  // The window ignores the mouse except over the activity chip, which takes clicks (its Stop).
  return (
    <div className="pip-window">
      <div className={`pip${leaving ? ' leaving' : ''}`} ref={card}>
        <div className="pip-main">
          <div className="pip-title">
            <span className="pip-name">{jobTitle(job)}</span>
            {progress && <span className="pip-count">{progress}</span>}
            {ring && (
              <ProgressRing
                count={ring.count}
                at={ring.at}
                paused={Boolean(job.paused) || !live(job.status)}
                full={held.current.finished} // with the green chip, solid and green (Shell.css)
              />
            )}
          </div>
          <div className="pip-panel">
            <Steps jobId={job.job_id} steps={recentSteps(job, KEEP * 3)} events={job.events} />
          </div>
        </div>
        <ActivityChip activity={held.current} />
      </div>
    </div>
  )
}
