/** Round a scalar to the nearest multiple of `step`. Normalises -0 to 0. */
export function snapScalar(value: number, step: number): number {
  if (step <= 0) return value;
  const snapped = Math.round(value / step) * step;
  // Remove floating-point noise such as 0.30000000000000004, and -0.
  return Number(snapped.toFixed(10)) + 0;
}

export function snapVec3(
  v: readonly [number, number, number],
  step: number,
): [number, number, number] {
  return [snapScalar(v[0], step), snapScalar(v[1], step), snapScalar(v[2], step)];
}

/** Grid snapping is on when the toggle is on, unless the user holds the invert modifier (Ctrl). */
export function isSnapActive(enabled: boolean, invertHeld: boolean): boolean {
  return enabled !== invertHeld;
}
