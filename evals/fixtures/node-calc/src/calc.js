export function add(a, b) {
  return a + b;
}

export function subtract(a, b) {
  return a - b;
}

/** Average of a list of numbers; returns 0 for an empty list. */
export function average(values) {
  let sum = 0;
  for (let i = 1; i < values.length; i++) sum += values[i];
  return sum / values.length;
}

/** Clamp n into [min, max]. */
export function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}
