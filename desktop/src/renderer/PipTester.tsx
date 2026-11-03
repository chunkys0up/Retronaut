// TEMPORARY: a page for looking at the picture-in-picture card without a build or run.
// Open the renderer at #pip-test (e.g. http://localhost:5317/#pip-test with `npm run dev`).
// Delete this file and its two lines in main.tsx when done.

import { useEffect, useRef, useState } from 'react'

import { Pip } from './Pip'

type Activity = { active: boolean; app: string; paused: boolean; action: string; finished: boolean; review: boolean }

const STEPS = [
  'Opening GnuCash',
  'Finding the Accounts tab',
  'Opening Checking Account',
  'Reading the register',
  'Importing the CSV',
  'Matching transactions',
  'Saving the book',
  'Checking the balance',
]
const EXPECTED = STEPS.length

const ACTIONS = ['Typing “~/Downloads/statement-october.csv”', 'Clicking Import', 'Pressing ⌘S', 'Choosing the Checking Account']

// The fake run the card polls (/api/live): one more step every couple of seconds.
let steps = 3
let liveJob = true
function fakeJob() {
  const now = Date.now() / 1000
  return {
    job_id: 'test-run',
    kind: 'run',
    workflow_id: 'test',
    status: 'running',
    started: now - 60,
    finished: null,
    result: null,
    requests: [],
    title: 'Import bank statement',
    expected_steps: EXPECTED,
    events: Array.from({ length: steps }, (_, i) => ({
      i,
      ts: now - (steps - i) * 2,
      kind: 'step',
      label: `Step ${(i % EXPECTED) + 1}: ${STEPS[i % STEPS.length]}`,
      detail: '',
    })),
  }
}
// Only on the tester's own page: anywhere else this would feed the real card fake steps.
const realFetch = window.fetch.bind(window)
if (window.location.hash === '#pip-test')
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.endsWith('/api/live')) return Promise.resolve(new Response(JSON.stringify(liveJob ? fakeJob() : null)))
    return realFetch(input, init)
  }

const send = (a: Activity) => (window as Window & { pipActivity?: (a: Activity) => void }).pipActivity?.(a)

export function PipTester() {
  const [state, setState] = useState<'off' | 'working' | 'using' | 'waiting' | 'finished' | 'review'>('off')
  const [cycling, setCycling] = useState(false)
  const [growing, setGrowing] = useState(true)
  const [shown, setShown] = useState(true)
  const actionAt = useRef(0)

  useEffect(() => {
    const app = 'GnuCash'
    const finished = false
    const review = false
    if (state === 'off') send({ active: false, app, paused: false, action: '', finished, review })
    if (state === 'working') send({ active: true, app, paused: false, action: ACTIONS[actionAt.current % ACTIONS.length]!, finished, review })
    if (state === 'using') send({ active: true, app, paused: false, action: '', finished, review })
    if (state === 'waiting') send({ active: true, app, paused: true, action: ACTIONS[actionAt.current % ACTIONS.length]!, finished, review })
    if (state === 'finished') send({ active: false, app, paused: false, action: '', finished: true, review })
    if (state === 'review') send({ active: false, app, paused: false, action: '', finished, review: true })
  }, [state])

  // New steps keep arriving, so the steps panel scrolls as it would.
  useEffect(() => {
    if (!growing) return
    const timer = setInterval(() => steps++, 2000)
    return () => clearInterval(timer)
  }, [growing])

  // Off → working → waiting → working → off, over and over, to watch the transitions.
  useEffect(() => {
    if (!cycling) return
    const order = ['working', 'waiting', 'working', 'off'] as const
    let i = 0
    const timer = setInterval(() => {
      if (order[i] === 'working') actionAt.current++
      setState(order[i]!)
      i = (i + 1) % order.length
    }, 2500)
    return () => clearInterval(timer)
  }, [cycling])

  const pick = (s: typeof state) => {
    setCycling(false)
    if (s === 'working') actionAt.current++
    setState(s)
  }
  const button = (label: string, on: boolean, onClick: () => void) => (
    <button type="button" onClick={onClick} style={{ ...btn, ...(on ? btnOn : null) }}>
      {label}
    </button>
  )

  return (
    <div style={{ display: 'flex', gap: 32, padding: 32, minHeight: '100vh', boxSizing: 'border-box', background: '#2a2a2a' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: 220, color: '#ddd', font: '13px Inter, sans-serif' }}>
        <b style={{ fontSize: 15 }}>Picture-in-picture tester</b>
        <span style={{ opacity: 0.6 }}>Activity chip</span>
        {button('Off', state === 'off' && !cycling, () => pick('off'))}
        {button('Working (with action)', state === 'working' && !cycling, () => pick('working'))}
        {button('Working (no action)', state === 'using' && !cycling, () => pick('using'))}
        {button('Waiting for you', state === 'waiting' && !cycling, () => pick('waiting'))}
        {button('Finished (run passed)', state === 'finished' && !cycling, () => pick('finished'))}
        {button('Needs review (run stopped)', state === 'review' && !cycling, () => pick('review'))}
        {button('Cycle through them', cycling, () => setCycling((c) => !c))}
        <span style={{ opacity: 0.6, marginTop: 10 }}>Card</span>
        {button('Steps arriving', growing, () => setGrowing((g) => !g))}
        {button(shown ? 'Leave (run ends)' : 'Arrive (run starts)', false, () => {
          liveJob = !shown
          const own = window as Window & { pipLeave?: () => void; pipRefresh?: () => Promise<void> }
          if (shown) own.pipLeave?.()
          else void own.pipRefresh?.()
          setShown(!shown)
        })}
        <span style={{ opacity: 0.5, fontSize: 12, marginTop: 10 }}>
          The striped box is the window (500×450): the card’s 320×270 box with 90px of clear space round it. Move the pointer
          over or near the card to see the hole. Window glides aren’t simulated.
        </span>
      </div>
      <div style={window_}>
        <Pip />
      </div>
    </div>
  )
}

const window_: React.CSSProperties = {
  position: 'relative',
  width: 500, // the card's 320×270 box and its 90px clear margin all round (overlay.ts)
  height: 450,
  outline: '1px dashed rgba(255,255,255,.25)',
  background: 'repeating-linear-gradient(45deg, #3a3f4a 0 12px, #454b57 12px 24px)',
}
const btn: React.CSSProperties = {
  font: 'inherit',
  textAlign: 'left',
  padding: '7px 10px',
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,.15)',
  background: 'rgba(255,255,255,.05)',
  color: 'inherit',
  cursor: 'pointer',
}
const btnOn: React.CSSProperties = { background: 'rgba(255,70,8,.25)', borderColor: '#ff4608' }
