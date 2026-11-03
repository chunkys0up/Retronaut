/**
 * What's on screen while Retronaut works, outside its own window:
 *
 * - The frame: a border around the display. Dull while a build or run is going (so you
 *   know automation is about), bright while Retronaut is actually driving an app (yellow
 *   while that waits on you to let go of the mouse), one frame handing over to the next.
 *   Clicks always pass through it.
 * - The picture-in-picture: what the build or run is doing and its last few steps, in
 *   the top-right corner, for the whole build or run. While Retronaut drives an app, a
 *   chip naming the action (and a Stop button) opens under the steps, the card growing
 *   down to hold it. A run that passes ends on a green chip saying so (a check mark in
 *   place of Stop), the card staying a moment to show it, then leaving with it. Clicks pass
 *   through the card, and near the pointer it opens a soft hole that follows it, showing
 *   what's under, the chip staying whole above it (and taking the Stop button's click). Its window reaches a little past the card on every side, all
 *   of it clear, so the card hears the pointer coming near its edges too.
 *
 * Neither window ever takes focus, so neither can steal input meant for the app being
 * driven, and the agent's screenshots capture only that app's window. Electron only.
 */

import { BrowserWindow, ipcMain, screen, type Display } from 'electron'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

import * as mac from '../shared/macos'
import { DROP_MS, dropSpring, LEAVE_MS, leaveEase } from '../shared/motion'
import { JOBS, liveJob, onJobsChange } from './jobs'
import * as ui from './uiActivity'

// The card's box (width, height) is taller than the card ever gets (Pip, Shell.css .pip):
// the card is 170 tall and grows down into the clear space below while its activity chip
// shows (about 60 more), with room to spare so the chip is never clipped. The window is
// that box with `pad` more clear space on every side (Shell.css .pip-window's padding), so
// the card hears the pointer coming near its edges from outside it too (its hole that
// follows the pointer, Pip). The clear space lets clicks through.
const PIP = { width: 320, height: 270, margin: 14, pad: 90 }
/** The window's size: the card's box and its clear margin all round. */
const PIP_WINDOW = { width: PIP.width + 2 * PIP.pad, height: PIP.height + 2 * PIP.pad }
// A MacBook's built-in display has rounded corners; the frame follows its edge (external
// displays are square). The corners are a fixed size on the panel, so they're set in the
// panel's own pixels and turned into points for the current scaling ("More Space" makes a
// point fewer pixels). Matched by eye on a 14-inch MacBook Pro (M4 Pro).
const CORNERS_PX = { top: 40, bottom: 30 } // its bottom corners are tighter than its top ones

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
    font: 13px/1.3 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; -webkit-user-select: none; cursor: default; }
  /* Three frames, one per state: passive (a build or run is going), orange (driving an app
     right now) and yellow (driving, but paused while you use the mouse or keyboard). Each
     rests 8px past the screen's edges (its border 8px thicker to match), so it can spring a
     little inward without uncovering the edge, and waits 20px out, unseen. Switching is a
     handover: the frame leaving swells back out there as it fades, while the one arriving
     (drawn over it, for a warning) closes in as it fades in. They move the same 12px on every
     side, not a scale, which would reach further out on the long sides. */
  :root { --spring: linear(0, 0.0272, 0.0995, 0.2033, 0.3264, 0.4582, 0.5898, 0.7145, 0.8272, 0.9245, 1.0048, 1.0675, 1.1131, 1.1429, 1.1588, 1.163, 1.1577, 1.1453, 1.128, 1.1077, 1.0862, 1.0648, 1.0446, 1.0265, 1.0109, 0.9981, 0.9881, 0.981, 0.9763, 0.974, 0.9735, 0.9744, 0.9766, 0.9795, 0.9828, 0.9863, 0.9898, 0.993, 0.996, 0.9985, 1.0005, 1.0021, 1.0032, 1.0039, 1); }
  .frame { position: fixed; inset: -20px; border-radius: calc(var(--top-r, 0px) + 8px) calc(var(--top-r, 0px) + 8px) calc(var(--bottom-r, 0px) + 8px) calc(var(--bottom-r, 0px) + 8px); opacity: 0;
    transition: inset .5s cubic-bezier(0.5, 0, 0.75, 0), opacity .4s cubic-bezier(0.4, 0, 1, 1), box-shadow .8s ease-in-out; }
  body.session:not(.on) .passive, body.on:not(.paused) .drive, body.on.paused .wait { inset: -8px; opacity: 1;
    transition: inset .6s cubic-bezier(0.22, 1, 0.36, 1), opacity .45s cubic-bezier(0.33, 1, 0.68, 1), box-shadow .8s ease-in-out; }
  /* The passive frame's first arrival, as a build or run starts (.intro, for its length), is
     its own: over 3.1s on a slow, heavy spring, about 2px inward (its peak, at 35%) and back,
     fading in from the moment its ring comes on screen (0.45s, the ring starting just past
     the edge) over 1s. */
  body.session.intro:not(.on) .passive {
    transition: inset 3.1s var(--spring), opacity 1s cubic-bezier(0.33, 1, 0.68, 1) .45s, box-shadow .8s ease-in-out; }
  /* Passive: its border is a ring (masked to the edge) lit by one radial glow, brightest at
     its centre, whose centre travels around the edge of the screen (the orbit keyframes are
     written for the screen's size below). */
  .passive { box-shadow: inset 0 0 22px 8px rgba(255, 70, 8, 0.22); }
  @property --gx { syntax: '<length>'; inherits: false; initial-value: 0px; }
  @property --gy { syntax: '<length>'; inherits: false; initial-value: 0px; }
  @property --glow-r { syntax: '<length>'; inherits: false; initial-value: 700px; }
  .passive::before { content: ''; position: absolute; inset: 0; padding: 13px; border-radius: inherit; opacity: 0;
    background: radial-gradient(circle var(--glow-r) at var(--gx) var(--gy), rgb(255, 190, 140), rgba(255, 125, 54, 0.85) 30%, rgba(255, 110, 40, 0.3));
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude;
    transition: opacity .3s; animation: orbit 8s linear infinite; }
  /* Appearing, the whole ring starts as bright as the glow's centre, then the brightness
     condenses into the moving glow (its radius shrinking from far past the screen to 700px)
     from when the frame swings back from its overshoot (1.05s, the spring's peak), over about
     2s. The radius runs quickly through the sizes far past the screen, where little changes,
     and eases through the last ones, where the ring visibly dims, coming to rest without a
     step. */
  body.session .passive::before { opacity: 1; animation: orbit 8s linear infinite, glow-in 3.2s linear both; transition: opacity .8s ease-in-out; }
  @keyframes glow-in { 0%, 33% { --glow-r: 9000px; animation-timing-function: cubic-bezier(0.3, 0.55, 0.35, 1); } }
  /* The build is paused: the glow stops where it is and fades away, leaving the plain ring
     (::after, under it), and the whole frame dims a little; unpausing reverses both, the glow
     moving on from where it stopped. The plain ring only shows while paused, so it doesn't
     brighten the glowing ring's dim stretches. */
  .passive::before { z-index: 1; }
  .passive::after { content: ''; position: absolute; inset: 0; padding: 13px; border-radius: inherit; z-index: 0;
    background: rgba(255, 110, 40, 0.3); opacity: 0; transition: opacity .8s ease-in-out;
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude; }
  body.held .passive::after { opacity: 1; }
  body.held:not(.on) .passive { opacity: .7; box-shadow: inset 0 0 22px 8px rgba(255, 70, 8, 0.12);
    transition: inset 3.1s var(--spring), opacity .8s ease-in-out, box-shadow .8s ease-in-out; }
  body.held .passive::before { opacity: 0; animation-play-state: paused; }
  /* Driving an app right now: hands off. */
  .drive { border: 14px solid #ff4608; box-shadow: inset 0 0 36px 16px rgba(255, 70, 8, 0.45); }
  .wait { border: 14px solid #fbbf24; box-shadow: inset 0 0 36px 16px rgba(251, 191, 36, 0.4); }
</style></head><body>
  <div class="frame passive"></div>
  <div class="frame drive"></div>
  <div class="frame wait"></div>
<script>
  // The glow's path: clockwise along the screen's edge from the top-left, each side taking
  // time in proportion to its length, so it moves at one speed all the way round. Redrawn
  // whenever the frame updates: the window starts small and hidden, then fills the screen.
  const orbit = document.createElement('style')
  document.head.appendChild(orbit)
  let orbitFor = ''
  const drawOrbit = () => {
    const w = innerWidth, h = innerHeight, p = 2 * (w + h)
    if (!w || !h || orbitFor === w + 'x' + h) return
    orbitFor = w + 'x' + h
    const at = (d) => (100 * d / p).toFixed(3) + '%'
    orbit.textContent = '@keyframes orbit {' +
      '0%, 100% { --gx: 0vw; --gy: 0vh }' +
      at(w) + ' { --gx: 100vw; --gy: 0vh }' +
      at(w + h) + ' { --gx: 100vw; --gy: 100vh }' +
      at(2 * w + h) + ' { --gx: 0vw; --gy: 100vh } }'
  }
  drawOrbit()
  addEventListener('resize', drawOrbit)
  // .intro: the passive frame's first arrival (its spring) and a little longer.
  let introTimer = 0
  window.render = (s) => {
    drawOrbit()
    if (s.session && !document.body.classList.contains('session')) {
      document.body.classList.add('intro')
      clearTimeout(introTimer)
      introTimer = setTimeout(() => document.body.classList.remove('intro'), 3300)
    }
    document.body.classList.toggle('session', s.session)
    document.body.classList.toggle('on', s.active)
    document.body.classList.toggle('paused', s.paused)
    document.body.classList.toggle('held', s.held)
    document.documentElement.style.setProperty('--top-r', s.corners.top + 'px')
    document.documentElement.style.setProperty('--bottom-r', s.corners.bottom + 'px')
  }
</script></body></html>`

const PANEL = {
  type: 'panel', // an NSPanel: showing it never activates Retronaut
  frame: false,
  transparent: true,
  hasShadow: false,
  focusable: false,
  resizable: false,
  movable: false,
  skipTaskbar: true,
  show: false,
  // macOS otherwise keeps windows clear of the menu bar and the Dock.
  enableLargerThanScreen: true,
  webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
} as const

let frame: BrowserWindow | null = null
let pip: BrowserWindow | null = null
let rendererUrl = ''
let display: Display | null = null
let session = false
let held = false // the live build is paused
// A run just ended, passing or stopping on purpose for review: the picture-in-picture shows
// its green or yellow chip a moment, then leaves.
let ended: 'passed' | 'review' | null = null
let finishTimer: ReturnType<typeof setTimeout> | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null
let pipGlide: ReturnType<typeof setInterval> | null = null
let pipLeaving = false
let pipWait: ReturnType<typeof setTimeout> | null = null
// The passive frame's ring comes on screen this long after a build or run starts (its fade's
// delay, HTML above): the picture-in-picture comes in with it, not ahead of it.
const FRAME_ON_SCREEN_MS = 450
// A build's frame and picture-in-picture come in this long after it starts: the send
// animation (0.86s) lands, then "Starting the agent…" blurs in (StepFeed's START_MS, 1.5s,
// after the page settles, over 0.55s); they start just after.
const BUILD_ENTRY_DELAY_MS = 2900
// How long the picture-in-picture stays once a run passes (or stops for review): its green (or
// yellow) chip opens (the card
// growing down, then the chip, about 0.6s), stays a moment to be read, then the card leaves with it.
const FINISHED_MS = 2200

function floating(win: BrowserWindow): BrowserWindow {
  win.setAlwaysOnTop(true, 'screen-saver')
  // skipTransformProcessType: without it, macOS briefly turns Retronaut into a background
  // app, which hides its windows and Dock icon. The cost: nothing over full-screen spaces.
  win.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true })
  win.setIgnoreMouseEvents(true, { forward: true })
  return win
}

function frameWindow(): BrowserWindow {
  if (frame && !frame.isDestroyed()) return frame
  frame = floating(new BrowserWindow(PANEL))
  void frame.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`)
  return frame
}

function pipWindow(): BrowserWindow {
  if (pip && !pip.isDestroyed()) return pip
  // Not rounded by macOS: the window is taller than the card (room for its activity chip),
  // so the card rounds its own corners (Shell.css .pip).
  pip = floating(new BrowserWindow({ ...PANEL, ...PIP_WINDOW, roundedCorners: false }))
  void pip.loadURL(`${rendererUrl.replace(/#.*$/, '')}#pip`)
  return pip
}

/**
 * Where the picture-in-picture's window rests: placed so its card sits in the top-right corner
 * of the display's work area, the window's clear margin reaching past the screen's edges there.
 */
function pipCorner(): { x: number; y: number } {
  const d = display ?? screen.getPrimaryDisplay()
  return { x: d.workArea.x + d.workArea.width - PIP.width - PIP.margin - PIP.pad, y: d.workArea.y + PIP.margin - PIP.pad }
}

function place(): void {
  const d = display ?? screen.getPrimaryDisplay()
  frameWindow().setBounds(d.bounds)
  // While it glides, the glide takes it to the new corner.
  if (!pipGlide) pipWindow().setBounds({ ...pipCorner(), ...PIP_WINDOW })
}

/**
 * The picture-in-picture comes and goes past the top edge of the screen, as the cards under
 * the build bar do (the same curves and timings, shared/motion): arriving, its window starts
 * just above the display and glides down into the corner on the soft spring; leaving, it
 * glides back up past the edge, then hides. Its card grows in and blurs out alongside (Pip). The window moves (its card can't leave it), from
 * wherever it is, so arriving mid-departure turns it straight round.
 */
function glidePip(arriving: boolean): void {
  const win = pipWindow()
  if (arriving && !win.isVisible()) {
    if (pipWait) return // already on its way
    pipWait = setTimeout(() => {
      pipWait = null
      if (session && !win.isVisible()) glide(win, true) // shown just above the screen, then down
    }, FRAME_ON_SCREEN_MS)
    return
  }
  if (pipWait) clearTimeout(pipWait)
  pipWait = null
  glide(win, arriving)
}

function glide(win: BrowserWindow, arriving: boolean): void {
  if (pipGlide) clearInterval(pipGlide)
  pipLeaving = !arriving
  const d = display ?? screen.getPrimaryDisplay()
  const above = d.bounds.y - PIP.pad - PIP.height - PIP.margin // its card wholly off the top of the screen
  if (arriving && !win.isVisible()) {
    // The card catches up with the new build or run while it's still out of sight (Pip).
    void win.webContents.executeJavaScript('window.pipRefresh && window.pipRefresh()').catch(() => {})
    win.setBounds({ x: pipCorner().x, y: above, ...PIP_WINDOW })
    win.showInactive()
  }
  if (!arriving) void win.webContents.executeJavaScript('window.pipLeave && window.pipLeave()').catch(() => {})
  const from = win.getBounds().y
  const started = Date.now()
  const duration = arriving ? DROP_MS : LEAVE_MS
  const finish = () => {
    if (pipGlide) clearInterval(pipGlide)
    pipGlide = null
    if (arriving) return
    pipLeaving = false
    win.hide()
  }
  pipGlide = setInterval(() => {
    if (win.isDestroyed()) return
    const t = Math.min(1, (Date.now() - started) / duration)
    const to = arriving ? pipCorner().y : above
    const k = arriving ? dropSpring(t) : leaveEase(t)
    // Only moved, never resized: setBounds would take the resize path every frame, costing
    // the card's own animation frames. `|| 0`: crossing the screen's top edge, a step can
    // round to -0, which Electron refuses as a position ("conversion failure").
    try {
      win.setPosition(pipCorner().x, Math.round(from + (to - from) * k) || 0)
    } catch {
      // Never stuck mid-glide, failing every step: straight to where it was going.
      if (arriving) win.setBounds({ ...pipCorner(), ...PIP_WINDOW })
      finish()
      return
    }
    if (t === 1) finish()
  }, 16)
}

/** Move to the display the app's front window is on (the primary display until we know). */
async function followApp(app: string): Promise<void> {
  let next = screen.getPrimaryDisplay()
  try {
    const front = await mac.frontWindow({ app })
    if (front) next = screen.getDisplayMatching({ x: front.x, y: front.y, width: front.w, height: front.h })
  } catch {
    // window lookup failed; the primary display is a fine place for the frame
  }
  if (display?.id === next.id) return
  display = next
  place()
}

// The built-in panel's width in pixels (e.g. 3024), read once; null until known.
let panelWidth: number | null = null
async function readPanelWidth(): Promise<void> {
  try {
    const { stdout } = await promisify(execFile)('system_profiler', ['SPDisplaysDataType'], { timeout: 15_000 })
    // The built-in panel's own section (the GPU's also says "Built-In", but has no resolution).
    const builtIn = stdout.split(/\n(?=\s{8}\S)/).find((block) => /Resolution:/.test(block) && /Built-in|Internal/i.test(block)) ?? ''
    const width = Number(/Resolution:\s*(\d+)\s*x\s*\d+/.exec(builtIn)?.[1])
    if (width > 0) panelWidth = width
  } catch {
    // cornerRadii falls back to the display's scale factor
  }
}

/** The frame's corner radii in points on this display. */
function cornerRadii(d: Display): { top: number; bottom: number } {
  if (!d.internal) return { top: 0, bottom: 0 }
  const pixelsPerPoint = panelWidth ? panelWidth / d.size.width : d.scaleFactor
  const points = (px: number) => Math.round((px / pixelsPerPoint) * 10) / 10
  return { top: points(CORNERS_PX.top), bottom: points(CORNERS_PX.bottom) }
}

/** What the picture-in-picture's activity chip shows: what Retronaut is doing in an app now. */
function sendActivity(win: BrowserWindow): void {
  const { active, app, paused, action } = ui.current()
  const payload = JSON.stringify({ active, app, paused, action, finished: ended === 'passed', review: ended === 'review' })
  const send = () => void win.webContents.executeJavaScript(`window.pipActivity && window.pipActivity(${payload})`).catch(() => {})
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
  else send()
  // The chip closing takes its Stop button with it, perhaps from under the pointer.
  if (!active) chipHover(false)
}

/** The pointer is over the activity chip: the window takes clicks there, for its Stop button. */
function chipHover(over: boolean): void {
  if (!pip || pip.isDestroyed()) return
  pip.setIgnoreMouseEvents(!over, { forward: true })
}

function render(): void {
  const state = ui.current()
  const w = frameWindow()
  const d = display ?? screen.getPrimaryDisplay()
  const payload = JSON.stringify({ ...state, session, held, corners: cornerRadii(d) })
  const draw = () => void w.webContents.executeJavaScript(`window.render && window.render(${payload})`).catch(() => {})
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', draw)
  else draw()

  const visible = state.active || session
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = null
  if (visible) {
    if (!display) place()
    if (!w.isVisible()) w.showInactive()
  } else {
    hideTimer = setTimeout(() => w.hide(), 600) // let the frame leaving finish
  }
  const p = pipWindow()
  if (session && (!p.isVisible() || pipLeaving)) glidePip(true)
  if (!session && !ended && p.isVisible() && !pipLeaving) glidePip(false)
  // After the glide, so a card told to leave hears that first and keeps its chip as it was
  // (Pip's held): told the chip had closed first, it would snap shut as the card set off
  // (its transitions are off while it leaves), the card jumping shorter.
  sendActivity(p)
}

export function installOverlay(url: string): void {
  rendererUrl = url
  void readPanelWidth().then(render)
  ipcMain.on('pip-chip-hover', (_event, over: boolean) => chipHover(over && ui.current().active))
  ipcMain.on('overlay-stop', () => {
    const jobId = ui.current().jobId ?? liveJob()?.id
    if (jobId) void JOBS.get(jobId)?.stop()
  })
  let lastApp = ''
  ui.onChange((state) => {
    if (state.active && state.app !== lastApp) void followApp(state.app)
    lastApp = state.active ? state.app : ''
    render()
  })
  // Builds and runs live in the engine, in this process: it says when one starts, ends, or is
  // paused or resumed, and the frame follows at once. Except a build's arrival: the frame and
  // the picture-in-picture wait until the send animation has landed and "Starting the agent…"
  // has come in (StepFeed's START_MS after the page settles), so they don't compete with it.
  let entering: ReturnType<typeof setTimeout> | null = null
  let waited: string | null = null // the build whose wait is over
  let lastLive: string | null = null // the job last showing, kept once it ends to see how it ended
  const syncJobs = () => {
    const live = liveJob()
    if (live && !session && live.kind === 'build' && waited !== live.id) {
      entering ??= setTimeout(() => {
        entering = null
        waited = live.id
        syncJobs()
      }, BUILD_ENTRY_DELAY_MS)
      return
    }
    if (!live && entering) {
      clearTimeout(entering)
      entering = null
    }
    const now = live !== null
    const pausedNow = live?.paused ?? false
    const showing = lastLive
    if (live) lastLive = live.id
    if (now === session && pausedNow === held) return
    // A run that ended passing, or stopping on purpose for review: the picture-in-picture
    // (and the display it's on) stays while its green or yellow chip shows. A new build or
    // run cuts that short.
    const job = session && !now ? JOBS.get(showing ?? '') : undefined
    if (finishTimer) clearTimeout(finishTimer)
    finishTimer = null
    ended =
      job?.kind !== 'run' ? null : job.status === 'passed' ? 'passed' : job.status === 'failed' && job.result?.review === true ? 'review' : null
    if (ended) {
      finishTimer = setTimeout(() => {
        finishTimer = null
        ended = null
        if (!session) display = null
        render()
      }, FINISHED_MS)
    }
    session = now
    held = pausedNow
    if (!session && !ended) display = null
    render()
  }
  onJobsChange(syncJobs)
  syncJobs()
}
