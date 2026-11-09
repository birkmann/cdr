import { LitElement, css, html, nothing } from 'lit'
import { base, emit, type } from '../base.js'
import { icon } from '../icons.js'

/**
 * A short label for categories, statuses or filters. `filter` adds a remove button.
 * @element __P__-tag
 * @slot - the text
 * @fires __P__-dismiss - when the remove button was used (cancelable; the tag hides itself unless cancelled)
 */
export class Tag extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        display: inline-flex;
      }
      .tag {
        ${type('label-01')}
        display: inline-flex;
        align-items: center;
        gap: var(--__P__-spacing-02);
        min-height: var(--__P__-dim-1-5rem);
        padding: 0 var(--__P__-spacing-03);
        border-radius: var(--__P__-radius-pill);
        background: var(--__P__-layer-accent-01);
        color: var(--__P__-text-primary);
        white-space: nowrap;
      }
      :host([size='sm']) .tag {
        min-height: var(--__P__-dim-1-125rem);
        padding: 0 var(--__P__-spacing-02);
      }
      :host([type='error']) .tag {
        background: var(--__P__-support-error-subtle);
      }
      :host([type='success']) .tag {
        background: var(--__P__-support-success-subtle);
      }
      :host([type='warning']) .tag {
        background: var(--__P__-support-warning-subtle);
      }
      :host([type='info']) .tag {
        background: var(--__P__-support-info-subtle);
      }
      :host([type='brand']) .tag {
        background: var(--__P__-highlight);
      }
      :host([type='outline']) .tag {
        background: transparent;
        box-shadow: inset 0 0 0 1px var(--__P__-border-strong-01);
      }
      button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--__P__-dim-1-25rem);
        height: var(--__P__-dim-1-25rem);
        margin-right: calc(-1 * var(--__P__-spacing-02));
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: transparent;
        color: inherit;
        cursor: pointer;
      }
      button:hover {
        background: var(--__P__-background-hover);
      }
      button:focus-visible {
        outline: 2px solid var(--__P__-focus);
      }
      :host([disabled]) .tag {
        background: var(--__P__-layer-01);
        color: var(--__P__-text-disabled);
      }
      :host([disabled]) button {
        cursor: not-allowed;
      }
    `,
  ]
  static override properties = {
    type: { type: String, reflect: true },
    size: { type: String, reflect: true },
    filter: { type: Boolean, reflect: true },
    disabled: { type: Boolean, reflect: true },
    removeLabel: { type: String, attribute: 'remove-label' },
  }
  /** gray | brand | error | success | warning | info | outline */
  declare type: string
  /** sm | md */
  declare size: 'sm' | 'md'
  /** shows a remove button */
  declare filter: boolean
  declare disabled: boolean
  /** accessible name of the remove button (default "Remove <text>") */
  declare removeLabel?: string
  constructor() {
    super()
    this.type = 'gray'
    this.size = 'md'
    this.filter = false
    this.disabled = false
  }
  #dismiss() {
    if (this.disabled) return
    if (emit(this, 'dismiss', { text: this.textContent?.trim() ?? '' }, true)) this.hidden = true
  }
  override render() {
    const text = this.textContent?.trim() ?? ''
    return html`<span class="tag"
      ><slot></slot>${this.filter
        ? html`<button type="button" aria-label=${this.removeLabel ?? `Remove ${text}`} ?disabled=${this.disabled} @click=${this.#dismiss}>
            ${icon('close', 12)}
          </button>`
        : nothing}</span
    >`
  }
}
