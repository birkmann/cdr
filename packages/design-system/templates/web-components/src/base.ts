import { css, unsafeCSS, type CSSResult } from 'lit'

/** CSS that applies a type token (font family, size, weight, line height, letter spacing). */
export const type = (token: string): CSSResult =>
  unsafeCSS(
    `font-family: var(--__P__-${token}-font-family); font-size: var(--__P__-${token}-font-size); ` +
      `font-weight: var(--__P__-${token}-font-weight); line-height: var(--__P__-${token}-line-height); ` +
      `letter-spacing: var(--__P__-${token}-letter-spacing);`,
  )

/** Shared by every component: box sizing, the body font, [hidden], and the focus ring. */
export const base = css`
  :host {
    box-sizing: border-box;
    font-family: var(--__P__-font-sans);
    color: var(--__P__-text-primary);
  }
  :host([hidden]) {
    display: none !important;
  }
  *,
  *::before,
  *::after {
    box-sizing: inherit;
  }
  [hidden] {
    display: none !important;
  }
  .focusable:focus {
    outline: none;
  }
  .focusable:focus-visible {
    outline: 2px solid var(--__P__-focus);
    outline-offset: -2px;
    box-shadow: inset 0 0 0 3px var(--__P__-focus-inset);
  }
  .visually-hidden {
    position: absolute !important;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
`

/** Label, helper text and messages under form fields. */
export const fieldStyles = css`
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--__P__-spacing-03);
    width: 100%;
  }
  label,
  .label {
    ${type('label-01')}
    color: var(--__P__-text-secondary);
  }
  .helper {
    ${type('helper-text-01')}
    color: var(--__P__-text-helper);
    margin: 0;
  }
  .error {
    ${type('helper-text-01')}
    color: var(--__P__-text-error);
    margin: 0;
  }
  .warn {
    ${type('helper-text-01')}
    color: var(--__P__-text-primary);
    margin: 0;
  }
  :host([disabled]) label,
  :host([disabled]) .label,
  :host([disabled]) .helper {
    color: var(--__P__-text-disabled);
  }
  .control {
    ${type('body-compact-01')}
    width: 100%;
    min-height: var(--__P__-size-md);
    padding: 0 var(--__P__-spacing-05);
    color: var(--__P__-text-primary);
    background: var(--__P__-field-01);
    border: none;
    border-bottom: 1px solid var(--__P__-border-strong-01);
    border-radius: var(--__P__-radius-field) var(--__P__-radius-field) 0 0;
    transition: background-color var(--__P__-duration-fast-01) var(--__P__-easing-standard-productive);
  }
  .control:hover:not(:disabled) {
    background: var(--__P__-field-hover);
  }
  .control::placeholder {
    color: var(--__P__-text-placeholder);
  }
  .control:focus {
    outline: 2px solid var(--__P__-focus);
    outline-offset: -2px;
  }
  .control:disabled {
    color: var(--__P__-text-disabled);
    border-bottom-color: transparent;
    cursor: not-allowed;
  }
  .control[aria-invalid='true'] {
    outline: 2px solid var(--__P__-support-error);
    outline-offset: -2px;
  }
  :host([size='sm']) .control {
    min-height: var(--__P__-size-sm);
  }
  :host([size='lg']) .control {
    min-height: var(--__P__-size-lg);
  }
`

/** Dispatch a bubbling, composed custom event (`__P__-<name>`). Returns false when a listener cancelled it. */
export function emit<T>(el: HTMLElement, name: string, detail: T, cancelable = false): boolean {
  return el.dispatchEvent(new CustomEvent(`__P__-${name}`, { detail, bubbles: true, composed: true, cancelable }))
}

/** Re-dispatch a native `change` from the host (the inner one does not leave the shadow root). */
export function emitChange(el: HTMLElement): void {
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

let ids = 0
/** A unique id for ARIA references inside one shadow root. */
export const uid = (name: string) => `__P__-${name}-${++ids}`

/** ElementInternals when the platform has them (form participation, validity). */
export function internalsOf(el: HTMLElement): ElementInternals | undefined {
  try {
    return typeof el.attachInternals === 'function' ? el.attachInternals() : undefined
  } catch {
    return undefined
  }
}
