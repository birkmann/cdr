import { LitElement, css, html, nothing, type PropertyValues } from 'lit'
import { base, emit, type } from '../base.js'
import { icon, type IconName } from '../icons.js'

const KIND_ICON: Record<string, IconName> = { error: 'error', success: 'success', warning: 'warning', info: 'info' }

/**
 * A status message: inline, or a toast with `toast` (and `timeout` to close by itself).
 * Errors and warnings use `role="alert"`, others `role="status"`.
 * @element __P__-notification
 * @slot - the message (subtitle)
 * @slot actions - an action button
 * @fires __P__-close - before it closes (cancelable), detail { trigger: "button" | "timeout" }
 */
export class Notification extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        display: block;
      }
      .n {
        position: relative;
        display: flex;
        align-items: flex-start;
        gap: var(--__P__-spacing-05);
        padding: var(--__P__-spacing-05) var(--__P__-spacing-05) var(--__P__-spacing-05) var(--__P__-spacing-05);
        background: var(--__P__-background-inverse);
        color: var(--__P__-text-inverse);
        border-left: 3px solid var(--kind);
        border-radius: var(--__P__-radius-field);
        max-width: 48rem;
      }
      :host([toast]) .n {
        box-shadow: var(--__P__-shadow-02);
        width: 18rem;
        flex-wrap: wrap;
      }
      :host([kind='error']) {
        --kind: var(--__P__-support-error);
        --subtle: var(--__P__-support-error-subtle);
      }
      :host([kind='success']) {
        --kind: var(--__P__-support-success);
        --subtle: var(--__P__-support-success-subtle);
      }
      :host([kind='warning']) {
        --kind: var(--__P__-support-warning);
        --subtle: var(--__P__-support-warning-subtle);
      }
      :host([kind='info']) {
        --kind: var(--__P__-support-info);
        --subtle: var(--__P__-support-info-subtle);
      }
      :host([low-contrast]) .n {
        background: var(--subtle);
        color: var(--__P__-text-primary);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--kind) 40%, transparent);
      }
      .icon-wrap {
        display: inline-flex;
        color: var(--kind);
        margin-top: 0.125rem;
      }
      :host([kind='warning']:not([low-contrast])) .icon-wrap,
      :host([kind='warning']) .icon-wrap {
        color: var(--kind);
      }
      .text {
        flex: 1;
        min-width: 0;
        ${type('body-compact-01')}
      }
      .title {
        ${type('heading-compact-01')}
        margin-right: var(--__P__-spacing-03);
      }
      .caption {
        ${type('label-01')}
        display: block;
        margin-top: var(--__P__-spacing-05);
        opacity: 0.8;
      }
      button.close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 2rem;
        height: 2rem;
        margin: calc(-1 * var(--__P__-spacing-03)) calc(-1 * var(--__P__-spacing-03)) 0 0;
        border: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
        border-radius: var(--__P__-radius-control);
      }
      button.close:focus-visible {
        outline: 2px solid var(--__P__-focus);
        outline-offset: -2px;
      }
      ::slotted([slot='actions']) {
        margin-top: var(--__P__-spacing-03);
      }
    `,
  ]
  static override properties = {
    kind: { type: String, reflect: true },
    heading: { type: String },
    caption: { type: String },
    lowContrast: { type: Boolean, reflect: true, attribute: 'low-contrast' },
    hideCloseButton: { type: Boolean, attribute: 'hide-close-button' },
    toast: { type: Boolean, reflect: true },
    timeout: { type: Number },
    open: { type: Boolean, reflect: true },
    closeLabel: { type: String, attribute: 'close-label' },
  }
  /** error | success | warning | info */
  declare kind: 'error' | 'success' | 'warning' | 'info'
  /** bold first part of the message (not `title`, which would show the browser's tooltip) */
  declare heading: string
  /** toast only: a small line under the message, e.g. the time */
  declare caption: string
  declare lowContrast: boolean
  declare hideCloseButton: boolean
  declare toast: boolean
  /** toast only: ms until it closes by itself (0 = never) */
  declare timeout: number
  declare open: boolean
  declare closeLabel: string
  #timer?: ReturnType<typeof setTimeout>
  constructor() {
    super()
    this.kind = 'info'
    this.heading = ''
    this.caption = ''
    this.lowContrast = false
    this.hideCloseButton = false
    this.toast = false
    this.timeout = 0
    this.open = true
    this.closeLabel = 'Close notification'
  }
  /** Close it (fires a cancelable __P__-close first). */
  close(trigger: 'button' | 'timeout' | 'api' = 'api') {
    if (emit(this, 'close', { trigger }, true)) this.open = false
  }
  protected override updated(changed: PropertyValues) {
    if (changed.has('open') || changed.has('timeout')) {
      clearTimeout(this.#timer)
      if (this.open && this.toast && this.timeout > 0) this.#timer = setTimeout(() => this.close('timeout'), this.timeout)
    }
    this.hidden = !this.open
  }
  override disconnectedCallback() {
    super.disconnectedCallback()
    clearTimeout(this.#timer)
  }
  override render() {
    const role = this.kind === 'error' || this.kind === 'warning' ? 'alert' : 'status'
    return html`<div class="n" role=${role}>
      <span class="icon-wrap">${icon(KIND_ICON[this.kind] ?? 'info', 20, this.kind)}</span>
      <div class="text">
        ${this.heading ? html`<span class="title">${this.heading}</span>` : nothing}<slot></slot>
        ${this.toast && this.caption ? html`<span class="caption">${this.caption}</span>` : nothing}
        <div><slot name="actions"></slot></div>
      </div>
      ${this.hideCloseButton
        ? nothing
        : html`<button class="close" type="button" aria-label=${this.closeLabel} @click=${() => this.close('button')}>
            ${icon('close', 16)}
          </button>`}
    </div>`
  }
}
