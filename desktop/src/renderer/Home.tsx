import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react'

import { api, inElectron, openPrivacy, type Health } from './api'
import arrow from './assets/arrow-up-right.svg'
import { COMPOSER_SHADOW, GLIDE, glideEase, RADIUS, type Box } from './Flight'

// Short teasers on the stage; picking one puts the whole prompt in the composer.
const SUGGESTIONS = [
  {
    label: 'Every friday, read my payments...',
    prompt: 'Every Friday, read the payments in my GnuCash checking account and email me a summary of anything over $1,000.',
  },
  {
    label: 'Copy new bills from Outlook into...',
    prompt: 'Copy new bills from my Outlook inbox into GnuCash as vendor bills.',
  },
  {
    label: 'Create matching invoices per job...',
    prompt: 'Every work order my vendor emails me, total it per work-order number and create a matching invoice in GnuCash for that customer.',
  },
]

// The glass tiles around the composer and suggestions, as [column, row] in a 12 × 8 grid.
const TILES: [number, number][] = [
  ...[1, 2, 11, 12].map((c): [number, number] => [c, 3]),
  ...[1, 2, 3, 10, 11, 12].map((c): [number, number] => [c, 4]),
  ...[5, 6, 7, 8].flatMap((r) => Array.from({ length: 12 }, (_, i): [number, number] => [i + 1, r])),
]

const at = (column: number, row: number, span = 1): CSSProperties => ({ gridColumn: `${column} / span ${span}`, gridRow: row })

/** A tile's blink: its own slow cycle, a start part-way through it, and how bright it gets. */
function blink(): CSSProperties {
  const duration = 5 + Math.random() * 9
  return {
    '--bit-duration': `${duration.toFixed(2)}s`,
    '--bit-delay': `${(-Math.random() * duration).toFixed(2)}s`,
    '--bit-peak': (0.35 + Math.random() * 0.65).toFixed(2),
  } as CSSProperties
}

const COMPOSER_INSET = 24 // the composer's distance from the edges of its slot
const BELOW_HERO = 32 // how close the growing composer may come to the subtitle

function Check({ ok, label, detail, fix }: { ok: boolean | null; label: string; detail: string; fix?: { label: string; run: () => void } }) {
  return (
    <li className={`check ${ok === null ? 'check-unknown' : ok ? 'check-ok' : 'check-bad'}`}>
      <span className="check-mark" aria-hidden="true">{ok === null ? '·' : ok ? '✓' : '!'}</span>
      <span className="check-text">
        <span className="check-label">{label}</span>
        <span className="muted small">{detail}</span>
      </span>
      {fix && !ok && (
        <button type="button" className="secondary small-button" onClick={fix.run}>
          {fix.label}
        </button>
      )}
    </li>
  )
}

const PLACEHOLDER =
  'Take the work order emails that my vendor emails me, add up each order, and create the invoices in my accounting software'

// Coming in from Home's New workflow button: the send animation (Flight.tsx) run the other
// way, with the same glide, timings and fades. The orange button glides into the composer's
// Build workflow button, and at the same time the white composer glides and expands out
// from under it, from the page's top-right corner where the button was.
const FROM_LABEL = '+ New workflow'
const TO_LABEL = 'Build workflow'
const FROM_PX = 12.5 // the New workflow button's text; Build workflow's is 12px
const BUTTON_RADIUS = 4 // both buttons' corners
const STEPS = 32

/**
 * A box scaled unevenly from (sx, sy) to full size along the glide, its corners going from
 * r0 to r1 and set against the scale so they look round all the way (as Flight.tsx does).
 */
function corners(sx: number, sy: number, r0: number, r1: number): Keyframe[] {
  return Array.from({ length: STEPS + 1 }, (_, i) => {
    const p = glideEase(i / STEPS)
    const r = r0 + (r1 - r0) * p
    return { offset: i / STEPS, borderRadius: `${r / (sx + (1 - sx) * p)}px / ${r / (sy + (1 - sy) * p)}px` }
  })
}

/** The transform that puts a box laid out at `to` back where `from` was. */
const flip = (from: Box, to: DOMRect) =>
  `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`

export function Home({
  onStart,
  leaving = false,
  from = null,
}: {
  onStart: (prompt: string, from?: Box) => Promise<void>
  leaving?: boolean
  /** Where the New workflow button was: it glides into the composer, and the screen ripples in around it. */
  from?: Box | null
}) {
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const blinks = useMemo(() => TILES.map(blink), [])
  const hero = useRef<HTMLDivElement>(null)
  const slot = useRef<HTMLDivElement>(null)
  const form = useRef<HTMLFormElement>(null)

  // The composer fills its slot, grows upwards with its text until it nears the
  // headline, then stops and scrolls inside.
  const fit = useCallback(() => {
    const text = box.current
    const card = form.current
    if (!text || !card || !slot.current || !hero.current) return
    text.style.height = '0px'
    const chrome = card.offsetHeight // padding, button row and gaps, without the text
    const content = text.scrollHeight
    const slotBox = slot.current.getBoundingClientRect()
    const stacked = getComputedStyle(card).position !== 'absolute' // small screens: no growing upwards
    const smallest = stacked ? 96 : slotBox.height - COMPOSER_INSET * 2 - chrome
    const tallest = stacked
      ? 280
      : slotBox.bottom - COMPOSER_INSET - (hero.current.getBoundingClientRect().bottom + BELOW_HERO) - chrome
    const height = Math.max(smallest, Math.min(content, Math.max(smallest, tallest)))
    text.style.height = `${height}px`
    text.style.overflowY = content > height ? 'auto' : 'hidden'
  }, [])

  useLayoutEffect(fit, [fit, prompt, error])

  // The button's glide, built as the send animation is (Flight.tsx): layers moved by
  // transform alone, so it runs on the compositor with sub-pixel steps.
  // - the button: laid out as Build workflow, scaled back to the New workflow button and
  //   glided across on the send's curve, landing exactly on Build workflow;
  // - its label: the two buttons' words stacked, crossfading as it goes, on the send's
  //   450ms schedule for what a flying box carries in and out;
  // - the composer: laid out as itself and started as the New workflow button's box, top
  //   right, so it glides and expands out from under the button as the button glides, its
  //   hairline ring and shadow coming in as it grows;
  // - its placeholder: unscaled, carried at its place in the growing box (clipped to it)
  //   and fading in on the way, so it's already there when the box lands.
  const ghostBox = useRef<HTMLDivElement>(null)
  const ghostButton = useRef<HTMLDivElement>(null)
  const ghostLabel = useRef<HTMLDivElement>(null)
  const ghostHint = useRef<HTMLDivElement>(null)
  const submitButton = useRef<HTMLButtonElement>(null)
  const [landed, setLanded] = useState(from === null)
  useLayoutEffect(() => {
    const shell = ghostBox.current
    const pill = ghostButton.current
    const words = ghostLabel.current
    const hint = ghostHint.current
    const card = form.current
    const build = submitButton.current
    const text = box.current
    if (!from || !shell || !pill || !words || !hint || !card || !build || !text) return
    const place = (el: HTMLElement, r: DOMRect) =>
      Object.assign(el.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })

    // The button.
    const button = build.getBoundingClientRect()
    place(pill, button)
    const bx = from.width / button.width
    const by = from.height / button.height
    const glide = pill.animate([{ transform: flip(from, button) }, { transform: 'none' }], GLIDE)
    const pillCorners = pill.animate(corners(bx, by, BUTTON_RADIUS, BUTTON_RADIUS), { duration: GLIDE.duration, fill: 'both' })
    // Build workflow sits disabled until there's a prompt, a little faded: so does the copy, by the end.
    const settle = pill.animate([{ opacity: 1 }, { opacity: 0.85 }], { duration: 450, easing: 'ease-out', fill: 'both' })

    // Its label: laid out on Build workflow, moved (not stretched) from the button's centre,
    // and scaled from its 12.5px to 12px.
    place(words, button)
    const s = FROM_PX / 12
    const dx = from.left + from.width / 2 - (button.left + button.width / 2)
    const dy = from.top + from.height / 2 - (button.top + button.height / 2)
    const carry = words.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${s})` }, { transform: 'none' }], GLIDE)
    const [oldWords, newWords] = Array.from(words.children) as HTMLElement[]
    const out = oldWords.animate([{ opacity: 1 }, { offset: 0.3, opacity: 1 }, { opacity: 0 }], { duration: 450, easing: 'ease-out', fill: 'both' })
    const into = newWords.animate([{ opacity: 0 }, { offset: 0.3, opacity: 0 }, { opacity: 1 }], { duration: 450, easing: 'ease-out', fill: 'both' })

    // The composer: from the New workflow button's box, top right, to its own, gliding and
    // expanding alongside the button on the same curve, under it all the way.
    const target = card.getBoundingClientRect()
    place(shell, target)
    const cx = from.width / target.width
    const cy = from.height / target.height
    const grow = shell.animate([{ transform: flip(from, target) }, { transform: 'none' }], GLIDE)
    const boxCorners = shell.animate(corners(cx, cy, BUTTON_RADIUS, RADIUS), { duration: GLIDE.duration, fill: 'both' })
    const appear = shell.animate(
      [
        { opacity: 0, boxShadow: 'inset 0 0 0 1px rgba(0, 0, 0, 0), 0 18px 50px rgba(0, 0, 0, 0)' },
        { offset: 0.3, opacity: 1 },
        { opacity: 1, boxShadow: COMPOSER_SHADOW },
      ],
      { duration: 450, easing: 'ease-out', fill: 'both' },
    )

    // The placeholder: laid out where the composer's text sits, and kept at that place in the
    // box as it glides (following its top-left corner, not scaled), clipped to the box's
    // edges so it never shows outside it. The box's corner and size move linearly in the
    // glide's progress, so each step is worked out on the glide's curve, as its corners are.
    const at = text.getBoundingClientRect()
    place(hint, at)
    const ox = at.left - target.left // the text's place inside the composer
    const oy = at.top - target.top
    const carryHint = hint.animate(
      Array.from({ length: STEPS + 1 }, (_, i) => {
        const p = glideEase(i / STEPS)
        const width = from.width + (target.width - from.width) * p
        const height = from.height + (target.height - from.height) * p
        const right = Math.max(0, at.width - (width - ox))
        const bottom = Math.max(0, at.height - (height - oy))
        return {
          offset: i / STEPS,
          transform: `translate(${(from.left - target.left) * (1 - p)}px, ${(from.top - target.top) * (1 - p)}px)`,
          clipPath: `inset(0 ${right}px ${bottom}px 0)`,
        }
      }),
      { duration: GLIDE.duration, fill: 'both' },
    )
    // Fading in only near the end, as the box settles: hidden until 65% of the way, there as it lands.
    const showHint = hint.animate([{ opacity: 0 }, { offset: 0.65, opacity: 0 }, { opacity: 1 }], {
      duration: GLIDE.duration,
      easing: 'ease-out',
      fill: 'both',
    })

    Promise.all([glide.finished, grow.finished]).then(() => {
      setLanded(true)
      text.focus()
    }, () => {})
    return () => {
      for (const a of [glide, pillCorners, settle, carry, out, into, grow, boxCorners, appear, carryHint, showHint]) a.cancel()
    }
    // Runs once, as it arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [fit])

  useEffect(() => {
    const load = () => api<Health>('/health').then(setHealth).catch(() => setHealth(null))
    load()
    // Permissions are granted in System Settings, outside the app; notice when that happens.
    const timer = setInterval(load, 4000)
    return () => clearInterval(timer)
  }, [])

  async function submit(e?: FormEvent) {
    e?.preventDefault()
    if (!prompt.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = form.current?.getBoundingClientRect()
      await onStart(prompt.trim(), r && { left: r.left, top: r.top, width: r.width, height: r.height })
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  // A click anywhere in the composer types into it, not just on the text area: its padding
  // and the row beside the button too. The caret goes to the end.
  function focusComposer(e: MouseEvent<HTMLFormElement>) {
    const text = box.current
    if (!text || e.target === text || (e.target as HTMLElement).closest('button, a, input')) return
    e.preventDefault() // keep the focus from leaving the text area
    text.focus()
    text.setSelectionRange(text.value.length, text.value.length)
  }

  function suggest(text: string) {
    setPrompt(text)
    box.current?.focus()
  }

  const ready = health && health.droid && health.api_key && health.accessibility !== false && health.screen_recording !== 'denied'

  return (
    <div className={`home${leaving ? ' leaving' : ''}${from ? ' entering' : ''}`}>
      {health && !ready && (
        <section className="notice home-notice" aria-label="Before you start">
          <h2>Before you start</h2>
          <ul className="checks">
            <Check ok={Boolean(health.droid)} label="Droid CLI" detail={health.droid ? `version ${health.droid}` : 'Install it: curl -fsSL https://app.factory.ai/cli | sh'} />
            <Check ok={health.api_key} label="Factory API key" detail={health.api_key ? 'found' : `Add FACTORY_API_KEY to ${health.env_files[0]}`} />
            <Check
              ok={health.accessibility}
              label="Accessibility"
              detail={health.accessibility === null ? 'checked inside the app' : 'lets Retronaut click and type in your apps'}
              fix={inElectron ? { label: 'Open settings', run: () => openPrivacy('accessibility') } : undefined}
            />
            <Check
              ok={health.screen_recording === null ? null : health.screen_recording === 'granted'}
              label="Screen Recording"
              detail={health.screen_recording === null ? 'checked inside the app' : 'lets Retronaut see app windows'}
              fix={inElectron ? { label: 'Open settings', run: () => openPrivacy('screen') } : undefined}
            />
          </ul>
        </section>
      )}

      <div className="home-hero" ref={hero}>
        <h1>
          Let’s <span className="retro">Retro</span>automate your
          <br />
          legacy finance workflows.
        </h1>
      </div>

      <div className="home-stage">
        {TILES.map(([c, r], i) => (
          <span
            key={`${c}-${r}`}
            className="tile"
            style={
              {
                ...at(c, r),
                ...blinks[i],
                '--out-delay': `${(r - 3) * 45 + Math.abs(c - 6.5) * 12}ms`,
                // Coming in, the same ripple from the other end: the bottom row first, up.
                '--in-delay': `${(8 - r) * 45 + Math.abs(c - 6.5) * 12}ms`,
              } as CSSProperties
            }
            aria-hidden="true"
          />
        ))}

        <div className="composer-slot" ref={slot}>
          <form className={`composer${landed ? '' : ' awaiting'}`} ref={form} onSubmit={submit} onMouseDown={focusComposer}>
            <textarea
              ref={box}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={PLACEHOLDER}
              autoFocus
              aria-label="Describe the workflow to automate"
            />
            {error && <p className="request-error">{error}</p>}
            <div className="composer-foot">
              {prompt && <span className="hint">Enter to build · Shift+Enter for a new line</span>}
              <button type="submit" ref={submitButton} disabled={!prompt.trim() || busy}>
                {busy && <span className="spinner" aria-hidden="true" />}
                {busy ? 'Starting…' : 'Build workflow'}
              </button>
            </div>
          </form>
        </div>

        {SUGGESTIONS.map((s, i) => (
          <button
            key={s.label}
            type="button"
            className="chip"
            style={{ ...at(4 + i * 2, 4, 2), '--in-delay': `${(8 - 4) * 45 + Math.abs(4.5 + i * 2 - 6.5) * 12}ms` } as CSSProperties}
            onClick={() => suggest(s.prompt)}
            title={s.prompt}
          >
            <span>{s.label}</span>
            <img src={arrow} width={20} height={20} alt="" />
          </button>
        ))}
      </div>

      {/* The glide's layers, placed and animated by the effect above: the composer growing
          under the button with its placeholder, the button, and its two labels crossfading. */}
      {from && !landed && (
        <>
          <div ref={ghostBox} className="new-glide-box" aria-hidden="true" />
          <div ref={ghostHint} className="new-glide-hint" aria-hidden="true">
            {PLACEHOLDER}
          </div>
          <div ref={ghostButton} className="new-glide-button" aria-hidden="true" />
          <div ref={ghostLabel} className="new-glide-label" aria-hidden="true">
            <span>{FROM_LABEL}</span>
            <span>{TO_LABEL}</span>
          </div>
        </>
      )}
    </div>
  )
}
