/**
 * How the cards move, for the page (as CSS easings) and the main process (which moves the
 * picture-in-picture's window by hand, so it needs them as functions of time).
 */

// A soft spring: about 1.5% past, then settling.
const DROP_POINTS = [
  0, 0.0427, 0.1438, 0.2719, 0.4062, 0.5337, 0.647, 0.7429, 0.8208, 0.8817, 0.9276, 0.9609, 0.984, 0.9991, 1.0083, 1.0131, 1.015,
  1.015, 1.0137, 1.0119, 1.0099, 1.0079, 1.0061, 1.0045, 1.0032, 1.0022, 1.0014, 1.0008, 1.0004, 1.0001, 1,
]
export const DROP_SPRING = `linear(${DROP_POINTS.join(', ')})`
/** Arriving: on the spring, from above. */
export const DROP_MS = 900

/** Leaving: back up and away, quick to start and slowing to the end. */
export const LEAVE_EASE = 'cubic-bezier(0.4, 0, 0.2, 1)'
export const LEAVE_MS = 550

/** The spring at `t` (0 to 1), as CSS's linear() reads its evenly spaced points. */
export function dropSpring(t: number): number {
  const at = Math.min(1, Math.max(0, t)) * (DROP_POINTS.length - 1)
  const i = Math.min(DROP_POINTS.length - 2, Math.floor(at))
  return DROP_POINTS[i]! + (DROP_POINTS[i + 1]! - DROP_POINTS[i]!) * (at - i)
}

/** A CSS cubic-bezier() easing as a function: its progress where its time is `t` (0 to 1). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const bez = (s: number, a: number, b: number) => 3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s * s * b + s ** 3
  return (t) => {
    let lo = 0
    let hi = 1
    for (let n = 0; n < 30; n++) {
      const mid = (lo + hi) / 2
      if (bez(mid, x1, x2) < t) lo = mid
      else hi = mid
    }
    return bez((lo + hi) / 2, y1, y2)
  }
}

/** LEAVE_EASE at `t` (0 to 1). */
export const leaveEase = cubicBezier(0.4, 0, 0.2, 1)
