import { useLayoutEffect, useRef } from 'react'

import { cubicBezier } from '../shared/motion'
import { BUILD_PHASES } from './phases'

/**
 * The send animation, two layers from where the composer sits:
 * - the prompt's text glides to the top of the build page and shrinks, dimming until it
 *   lands exactly on the build page's caption (same width, wrap and colour);
 * - the composer's white card glides up beside it and spreads into the build bar across
 *   the top of the page, turning from white into the bar's dark glass; the real bar takes
 *   over where it lands.
 */

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

export interface Intro {
  id: string // the workflow being built
  prompt: string
  from: Box // where the composer was
  width: number // the caption's text width: the composer's, scaled by SCALE
  landed: boolean
}

// The composer's text is 15px; the caption's 13px. Everything scales by the same factor,
// so the text wraps identically all the way up.
export const SCALE = 13 / 15
const PAD_X = 16 // the composer's padding
const PAD_Y = 18

export function captionWidth(from: Box): number {
  return (from.width - PAD_X * 2) * SCALE
}

export const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

export { DROP_SPRING } from '../shared/motion'

const GLIDE = { duration: 860, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' } as const
const glideEase = cubicBezier(0.22, 1, 0.36, 1)
const RADIUS = 12 // the composer's corners; the bar's are square

export function PromptFlight({ intro, anchor, card, onLanded }: { intro: Intro; anchor: HTMLElement; card: HTMLElement; onLanded: () => void }) {
  const text = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const edge = useRef<HTMLOListElement>(null)

  useLayoutEffect(() => {
    const words = text.current
    const shell = box.current
    if (!words || !shell) return
    const from = intro.from

    // Everything that moves here moves by transform alone, so it runs on the compositor with
    // sub-pixel steps: animating left/top/width/height instead lays the page out every frame
    // and snaps to whole pixels, which the glide's long, slow tail shows as a stutter.

    // The text: laid out where it lands; the animation starts it back where the composer was.
    // (Its height needn't follow: it has no background and is clamped to two lines anyway.)
    const to = anchor.getBoundingClientRect()
    const left = to.left - PAD_X * SCALE
    const top = to.top - PAD_Y * SCALE
    const height = to.height + PAD_Y * SCALE * 2
    Object.assign(words.style, { left: `${left}px`, top: `${top}px`, width: `${intro.width + PAD_X * SCALE * 2}px`, height: `${height}px` })
    const glide = words.animate(
      [{ transform: `translate(${from.left - left}px, ${from.top - top}px) scale(${1 / SCALE})` }, { transform: 'none' }],
      GLIDE,
    )
    const dim = words.animate(
      [{ color: 'rgb(36, 36, 36)' }, { offset: 0.45, color: 'rgba(255, 255, 255, 0.85)' }, { color: 'rgba(255, 255, 255, 0.5)' }],
      { duration: 700, easing: 'ease-in-out', fill: 'both' },
    )

    // The box: from the composer's to the build bar's (full width, against the top edge),
    // white to the bar's dark glass. Laid out as the bar, and scaled down to the composer.
    const target = card.getBoundingClientRect()
    Object.assign(shell.style, { left: `${target.left}px`, top: `${target.top}px`, width: `${target.width}px`, height: `${target.height}px` })
    const sx = from.width / target.width
    const sy = from.height / target.height
    const reshape = shell.animate(
      [{ transform: `translate(${from.left - target.left}px, ${from.top - target.top}px) scale(${sx}, ${sy})` }, { transform: 'none' }],
      GLIDE,
    )
    const darken = shell.animate(
      [
        { backgroundColor: 'rgb(255, 255, 255)', boxShadow: 'inset 0 0 0 1px rgba(0, 0, 0, 0.21), 0 18px 50px rgba(0, 0, 0, 0.18)' },
        { offset: 0.5, backgroundColor: 'rgba(120, 110, 104, 0.9)', boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.06), 0 18px 50px rgba(0, 0, 0, 0)' },
        { backgroundColor: 'rgba(34, 33, 32, 0.62)', boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0), 0 18px 50px rgba(0, 0, 0, 0)' },
      ],
      { duration: 450, easing: 'ease-out', fill: 'both' },
    )
    // The bar is square: the corners stay round until the box is nearly there (85% of the
    // way, on the same easing as the glide), then square off as it meets the edges. The box
    // is scaled, unevenly, so its radii are set against the scale to look round and 12px.
    const steps = 32
    const square = shell.animate(
      Array.from({ length: steps + 1 }, (_, i) => {
        const p = glideEase(i / steps)
        const r = p < 0.85 ? RADIUS : (RADIUS * (1 - p)) / 0.15
        return { offset: i / steps, borderRadius: `${r / (sx + (1 - sx) * p)}px / ${r / (sy + (1 - sy) * p)}px` }
      }),
      { duration: GLIDE.duration, fill: 'both' },
    )
    // The bar's progress segments along the box's bottom edge, plain grey, coming in as it
    // darkens and spreading out as it widens; the real ones land in the same place. (Their
    // orange, the labels and the bar's title row come in once the bar has settled.)
    const segments = edge.current?.animate([{ opacity: 0 }, { offset: 0.3, opacity: 0 }, { opacity: 1 }], { duration: 450, easing: 'ease-out', fill: 'both' })

    Promise.all([glide.finished, reshape.finished]).then(onLanded, () => {})
    return () => {
      for (const a of [glide, dim, reshape, darken, square, segments]) a?.cancel()
    }
    // Runs once per flight: the anchors and intro are fixed for its duration.
  }, [])

  return (
    <>
      {/* Styled as the build bar, so its progress row lays out the same; just the grey segments show. */}
      <div className="flight-card build-bar" ref={box} aria-hidden="true">
        <ol className="phases" ref={edge}>
          {BUILD_PHASES.map((p) => (
            <li key={p.id}>
              <span className="phase-dot" />
              <span className="phase-label" style={{ visibility: 'hidden' }}>
                {p.label}
              </span>
            </li>
          ))}
        </ol>
      </div>
      <div className="flight" ref={text} aria-hidden="true">
        {/* Quoted like the caption it lands on, so it wraps the same all the way up. */}
        <div className="flight-text">“{intro.prompt}”</div>
      </div>
    </>
  )
}
