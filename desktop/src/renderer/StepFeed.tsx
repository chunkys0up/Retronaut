import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'

import { allSteps, EventList, friendly } from './BuildCard'
import { prefersReducedMotion } from './Flight'
import type { JobEvent, JobSnapshot } from './api'

/** How long each step stays up before the next queued one takes its place (ms); one with a
 *  screenshot stays a little longer, to give it a look. */
const HOLD_MS = 2500
const HOLD_SHOT_MS = 3500
/** How long the step takes to blur out of the cards' way (Shell.css's .step-feed.away): new
 *  cards wait for it, so they arrive where it was rather than over it. */
export const FEED_OUT_MS = 400
/** How long after the page opens the steps start showing ("Starting the agent…" too): they
 *  blur in once the page has settled. */
const START_MS = 1500
/** The most steps left waiting their turn; past that the oldest are skipped (the full list
 *  still has them), so the preview never falls far behind the build. */
const MAX_QUEUED = 6

// Google Material Icons: open_in_full and close_fullscreen.
const EXPAND = 'M21 11V3h-8l3.29 3.29-10 10L3 13v8h8l-3.29-3.29 10-10z'
const COLLAPSE = 'M22 3.41 16.71 8.7 20 12h-8V4l3.29 3.29L20.59 2 22 3.41zM3.41 22l5.29-5.29L12 20v-8H4l3.29 3.29L2 20.59 3.41 22z'

function Icon({ path }: { path: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path d={path} fill="currentColor" />
    </svg>
  )
}

/** Blur `el` out, then `done` (which swaps in what comes next; that blurs in as it mounts, Shell.css). */
function blurOut(el: HTMLElement | null, done: () => void): void {
  if (!el || prefersReducedMotion()) return done()
  el.animate([{ opacity: 1, filter: 'blur(0)' }, { opacity: 0, filter: 'blur(10px)' }], {
    duration: 400,
    easing: 'cubic-bezier(0.4, 0, 1, 1)',
    fill: 'forwards',
  }).onfinish = done
}

/**
 * Keeps `--bar-h` on the main area (around `el`) at how far the build bar reaches down it: the
 * full log starts (and its close button sits) just under it, scrolling up behind it, and the
 * cards centre on the window's middle line by it (Shell.css).
 */
function useBarHeight(el: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const main = el.current?.closest<HTMLElement>('.main')
    const bar = main?.querySelector('.build-bar-wrap')
    if (!main || !bar) return
    // Whole pixels: the cards centre by it, and half a pixel would leave them between two.
    const measure = () => main.style.setProperty('--bar-h', `${Math.round(bar.getBoundingClientRect().bottom - main.getBoundingClientRect().top)}px`)
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(bar)
    return () => {
      watch.disconnect()
      main.style.removeProperty('--bar-h')
    }
  }, [el])
}

/**
 * The step to show. Steps tend to arrive in batches: rather than jump to the newest, the ones
 * not shown yet queue up and take their turn, each held for a moment, blurring from one to the
 * next (`el` is the shown step's element).
 */
function useStepQueue(steps: JobEvent[], el: RefObject<HTMLElement | null>, started: boolean): JobEvent | undefined {
  const [at, setAt] = useState(steps.length - 1)
  const since = useRef(0) // when the shown step went up
  const leaving = useRef(false)
  const last = steps.length - 1
  if (at < last - MAX_QUEUED) setAt(last - MAX_QUEUED)
  const step = steps[Math.min(at, last)]
  const behind = at < last
  const shot = Boolean(step?.image)
  // Nothing moves on until it starts showing; the first step's hold counts from then.
  useEffect(() => {
    if (started) since.current = Date.now()
  }, [started])
  useEffect(() => {
    if (!started || !behind || leaving.current) return
    const hold = shot ? HOLD_SHOT_MS : HOLD_MS
    const timer = setTimeout(() => {
      leaving.current = true
      blurOut(el.current, () => {
        leaving.current = false
        since.current = Date.now()
        setAt((a) => a + 1)
      })
    }, Math.max(0, since.current + hold - Date.now()))
    return () => clearTimeout(timer)
  }, [at, behind, shot, el, started])
  return step
}

/** The full log, as it was recorded, newest at the bottom; it stays scrolled there unless the
 *  user scrolls up, gliding down to each new entry (opening, it starts there, or at the top
 *  `fromTop`, following new entries only once the user scrolls down to them). */
function StepHistory({ events, start, fromTop = false }: { events: JobEvent[]; start: number; fromTop?: boolean }) {
  const list = useRef<HTMLDivElement>(null)
  const pinned = useRef(!fromTop)
  // While it glides down itself, the scrolls on the way aren't the user leaving the bottom.
  const gliding = useRef(false)
  const opened = useRef(fromTop) // starting at the top, the first follow glides too
  const stick = () => {
    const el = list.current
    if (!el || !pinned.current) return
    if (!opened.current || prefersReducedMotion()) {
      el.scrollTop = el.scrollHeight
      opened.current = true
      return
    }
    gliding.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }
  useLayoutEffect(stick, [events.length])
  return (
    <div
      ref={list}
      className="step-list"
      onScroll={(e) => {
        if (gliding.current) return
        const el = e.currentTarget
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
      onScrollEnd={() => (gliding.current = false)}
      // The user taking over mid-glide: it's theirs to place again.
      onWheel={() => (gliding.current = false)}
      onTouchStart={() => (gliding.current = false)}
      onLoadCapture={stick} // a screenshot loading in grows the list
    >
      <EventList events={events} start={start} />
    </div>
  )
}

/**
 * While a workflow builds: what it's doing right now, as a line of text (and its screenshot,
 * if it took one, above it) in the middle of the window. The button at its top right, fixed
 * however many lines the step takes, opens the full log, which runs up behind the build bar.
 * `away` while cards wait on the user: it blurs out of their way, and back once they're gone.
 */
export function StepFeed({ job, away }: { job: JobSnapshot; away: boolean }) {
  const steps = useMemo(() => allSteps(job), [job])
  const now = useRef<HTMLDivElement>(null)
  const [started, setStarted] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setStarted(true), START_MS)
    return () => clearTimeout(timer)
  }, [])
  const step = useStepQueue(steps, now, started)
  const [expanded, setExpanded] = useState(false)
  const view = useRef<HTMLElement>(null)
  const toggle = () => blurOut(view.current, () => setExpanded(!expanded))
  const feed = useRef<HTMLDivElement>(null)
  useBarHeight(feed)

  return (
    <div ref={feed} className={`step-feed${expanded ? ' expanded' : ''}${away || !started ? ' away' : ''}`} inert={away || !started}>
      {expanded ? (
        <section key="history" ref={view} className="step-view step-history" aria-label="Activity">
          <button type="button" className="step-toggle" aria-label="Back to the current step" title="Back to the current step" onClick={toggle}>
            <Icon path={COLLAPSE} />
          </button>
          <StepHistory events={job.events} start={job.started} />
        </section>
      ) : (
        <section key="preview" ref={view} className="step-view step-preview" aria-live="polite">
          <button type="button" className="step-toggle" aria-label="Show the full activity log" title="Show the full activity log" onClick={toggle}>
            <Icon path={EXPAND} />
          </button>
          <div key={step?.i ?? 'start'} ref={now} className="step-now">
            {step?.image && <img className="step-shot" src={`/api${step.image}`} alt={step.label} />}
            <p className="step-text">{step ? friendly(step, job.events) : 'Starting the agent…'}</p>
          </div>
        </section>
      )}
    </div>
  )
}

/**
 * A popup card like the Accounts one, over the main area (the sidebar stays clear,
 * undimmed). Escape, Done, or a click anywhere off the card closes it.
 */
export function Popup({ open, label, title, onClose, children }: { open: boolean; label: string; title: ReactNode; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const d = dialog.current
    if (!d) return
    if (!open) {
      if (d.open) d.close()
      return
    }
    // Over the main area only: the scrim starts where it does.
    const main = d.closest<HTMLElement>('.main')
    const measure = () => d.style.setProperty('--main-left', `${main?.getBoundingClientRect().left ?? 0}px`)
    measure()
    if (!d.open) d.showModal()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open])

  // Fades out, then closes (its onClose tells the parent).
  const close = () => {
    const d = dialog.current
    if (!d || prefersReducedMotion()) return d?.close()
    d.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' }).onfinish = () => {
      d.close()
      d.getAnimations().forEach((a) => a.cancel())
    }
  }

  return (
    <dialog
      ref={dialog}
      className="log-popup"
      aria-label={label}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault()
        close()
      }}
      onClick={(e) => !(e.target as HTMLElement).closest('.log-popup-view') && close()}
    >
      <div className="log-popup-scrim">
        {open && (
          <section className="log-popup-view">
            <div className="accounts-head">
              <h2>{title}</h2>
              <button type="button" className="secondary small-button" onClick={close}>
                Done
              </button>
            </div>
            {children}
          </section>
        )}
      </div>
    </dialog>
  )
}

/** The full log in a Popup: the same scroller as the build's full log, fading out at both ends. */
export function ActivityPopup({
  open,
  events,
  start,
  onClose,
  title = 'Activity',
}: {
  open: boolean
  events: JobEvent[]
  start: number
  onClose: () => void
  /** What the log is of: "Activity" for the live one, a past run's name and time in Run history. */
  title?: string
}) {
  return (
    <Popup open={open} label={title} title={title} onClose={onClose}>
      <StepHistory events={events} start={start} fromTop />
    </Popup>
  )
}
