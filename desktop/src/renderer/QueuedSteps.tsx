import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { JobEvent } from './api'
import { prefersReducedMotion } from './Flight'

/** Steps that come in together are let in one after another, this far apart. */
const STEP_GAP_MS = 160

/**
 * The newest of `steps` let in so far. Steps that come in together (a poll can bring a
 * batch) are let in one after another, STEP_GAP_MS apart; a new build or run starts with all
 * of its steps in; and it never falls more than `keep` behind (it skips ahead instead).
 */
export function useStepQueue(jobId: string, steps: JobEvent[], keep: number): number {
  const last = steps[steps.length - 1]?.i ?? -1
  // The newest step let in so far; a new build or run starts with all of its steps in.
  const [shown, setShown] = useState({ jobId, upTo: last })
  let upTo = shown.jobId === jobId ? shown.upTo : last
  // Never more than a screenful behind: past that, skip to the last `keep` waiting.
  const waiting = steps.filter((e) => e.i > upTo)
  if (prefersReducedMotion()) upTo = last
  else if (waiting.length > keep) upTo = waiting[waiting.length - keep - 1]!.i
  if (shown.jobId !== jobId || shown.upTo !== upTo) setShown({ jobId, upTo })
  const next = waiting.find((e) => e.i > upTo)?.i
  useEffect(() => {
    if (next === undefined) return
    const timer = setTimeout(() => setShown({ jobId, upTo: next }), STEP_GAP_MS)
    return () => clearTimeout(timer)
  }, [jobId, next])
  return upTo
}

/**
 * The last few steps, newest at the bottom: a new one slides in from below and pushes the
 * rest up, the oldest fading under the list's top edge (more are kept than fit, so they
 * leave there rather than vanishing). A whole new set (the first, or a new build's or run's)
 * fades in quickly where it is. Steps that come in together (a poll can bring a batch) are
 * let in one after another, STEP_GAP_MS apart, so the list climbs through them rather than
 * jumping; each move adds to the one under way, so they run on smoothly into each other.
 *
 * Used by the picture-in-picture's card and the workflow bar's run card; each styles the
 * list by its class (the list itself only sets the motion). Where they're let in up to is
 * the caller's (useStepQueue), so what else counts steps (the picture-in-picture's ring and
 * "Step 4/8") moves with the list rather than ahead of it.
 */
export function QueuedSteps({
  className,
  jobId,
  steps,
  upTo,
  keep,
  describe,
}: {
  className: string
  jobId: string
  steps: JobEvent[]
  /** The newest step let in so far (useStepQueue). */
  upTo: number
  /** How many are kept in the list: more than fit, so the oldest leave under its top edge. */
  keep: number
  /** A step's line. */
  describe: (e: JobEvent) => string
}) {
  const list = useRef<HTMLUListElement>(null)
  const tops = useRef(new Map<string, number>())
  const visible = steps.filter((e) => e.i <= upTo).slice(-keep)

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
    <ul className={className} aria-label="Recent steps" ref={list}>
      {visible.map((e) => (
        <li key={`${jobId}:${e.i}`} data-key={`${jobId}:${e.i}`}>
          <span className={`dot dot-${e.kind}`} aria-hidden="true" />
          <span className="hint-text">{describe(e)}</span>
        </li>
      ))}
    </ul>
  )
}
