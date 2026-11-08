import { LitElement, css, html, nothing, type PropertyValues } from 'lit'
import { base, emit, type, uid } from '../base.js'
import { icon } from '../icons.js'

/**
 * A dialog on the native `<dialog>` (focus trap, Esc, focus returns to the opener).
 * @element __P__-modal
 * @slot - the body
 * @slot footer - replaces the default buttons
 * @fires __P__-close - before it closes (cancelable), detail { trigger: "escape" | "close-button" | "secondary" | "backdrop" | "api" }
 * @fires __P__-submit - when the primary button was pressed
 * @csspart dialog - the native dialog
 */
export class Modal extends LitElement {
  static override styles = [
    base,
    css`
      dialog {
        padding: 0;
        border: 0;
        border-radius: var(--__P__-radius-container);
        background: var(--__P__-layer-01);
        color: var(--__P__-text-primary);
        box-shadow: var(--__P__-shadow-03);
        width: min(48rem, calc(100vw - 2rem));
        max-height: calc(100vh - 4rem);
        overflow: hidden;
        display: none;
        flex-direction: column;
      }
      dialog[open] {
        display: flex;
        animation: enter var(--__P__-duration-moderate-02) var(--__P__-easing-entrance-expressive);
      }
      @keyframes enter {
        from {
          opacity: 0;
          transform: translateY(1.5rem);
        }
      }
      dialog::backdrop {
        background: var(--__P__-overlay);
      }
      :host([size='xs']) dialog {
        width: min(24rem, calc(100vw - 2rem));
      }
      :host([size='sm']) dialog {
        width: min(32rem, calc(100vw - 2rem));
      }
      :host([size='lg']) dialog {
        width: min(64rem, calc(100vw - 2rem));
      }
      header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--__P__-spacing-05);
        padding: var(--__P__-spacing-05) var(--__P__-spacing-05) var(--__P__-spacing-03) var(--__P__-spacing-05);
      }
      .eyebrow {
        ${type('label-01')}
        color: var(--__P__-text-secondary);
        margin: 0 0 var(--__P__-spacing-02);
      }
      h2 {
        ${type('heading-03')}
        margin: 0;
      }
      .close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 3rem;
        height: 3rem;
        margin: calc(-1 * var(--__P__-spacing-05)) calc(-1 * var(--__P__-spacing-05)) 0 0;
        border: 0;
        background: transparent;
        color: var(--__P__-icon-primary);
        cursor: pointer;
      }
      .close:hover {
        background: var(--__P__-layer-01-hover);
      }
      .close:focus-visible {
        outline: 2px solid var(--__P__-focus);
        outline-offset: -2px;
      }
      .body {
        ${type('body-01')}
        padding: 0 var(--__P__-spacing-05) var(--__P__-spacing-07);
        overflow: auto;
      }
      footer {
        display: flex;
        border-top: 1px solid var(--__P__-border-subtle-01);
      }
      footer button {
        ${type('body-compact-01')}
        flex: 1;
        min-height: 4rem;
        padding: var(--__P__-spacing-04) var(--__P__-spacing-05) var(--__P__-spacing-07);
        border: 0;
        text-align: left;
        cursor: pointer;
      }
      footer .secondary {
        background: var(--__P__-button-secondary);
        color: var(--__P__-button-secondary-text);
      }
      footer .secondary:hover {
        background: var(--__P__-button-secondary-hover);
      }
      footer .primary {
        background: var(--__P__-button-primary);
        color: var(--__P__-button-primary-text);
      }
      footer .primary:hover {
        background: var(--__P__-button-primary-hover);
      }
      :host([danger]) footer .primary {
        background: var(--__P__-button-danger);
        color: var(--__P__-button-danger-text);
      }
      footer button:focus-visible {
        outline: 2px solid var(--__P__-focus);
        outline-offset: -2px;
        box-shadow: inset 0 0 0 3px var(--__P__-focus-inset);
      }
      footer button:disabled {
        background: var(--__P__-button-disabled);
        color: var(--__P__-text-on-color);
        cursor: not-allowed;
      }
      @media (prefers-reduced-motion: reduce) {
        dialog[open] {
          animation: none;
        }
      }
    `,
  ]
  static override properties = {
    open: { type: Boolean, reflect: true },
    heading: { type: String },
    label: { type: String },
    size: { type: String, reflect: true },
    danger: { type: Boolean, reflect: true },
    primaryButtonText: { type: String, attribute: 'primary-button-text' },
    secondaryButtonText: { type: String, attribute: 'secondary-button-text' },
    primaryButtonDisabled: { type: Boolean, attribute: 'primary-button-disabled' },
    passive: { type: Boolean },
    preventCloseOnClickOutside: { type: Boolean, attribute: 'prevent-close-on-click-outside' },
    closeLabel: { type: String, attribute: 'close-label' },
  }
  declare open: boolean
  declare heading: string
  /** small text above the heading */
  declare label: string
  /** xs | sm | md | lg */
  declare size: 'xs' | 'sm' | 'md' | 'lg'
  declare danger: boolean
  declare primaryButtonText: string
  declare secondaryButtonText: string
  declare primaryButtonDisabled: boolean
  /** no buttons (information only) */
  declare passive: boolean
  declare preventCloseOnClickOutside: boolean
  declare closeLabel: string
  #id = uid('modal')
  constructor() {
    super()
    this.open = false
    this.heading = ''
    this.label = ''
    this.size = 'md'
    this.danger = false
    this.primaryButtonText = 'Save'
    this.secondaryButtonText = 'Cancel'
    this.primaryButtonDisabled = false
    this.passive = false
    this.preventCloseOnClickOutside = false
    this.closeLabel = 'Close'
  }
  get dialog(): HTMLDialogElement | null {
    return this.renderRoot?.querySelector('dialog') ?? null
  }
  show() {
    this.open = true
  }
  /** Close (fires a cancelable __P__-close first). */
  close(trigger: string = 'api') {
    if (!this.open) return
    if (emit(this, 'close', { trigger }, true)) this.open = false
  }
  protected override updated(changed: PropertyValues) {
    const d = this.dialog
    if (!d || !changed.has('open')) return
    if (this.open && !d.open) d.showModal()
    else if (!this.open && d.open) d.close()
  }
  override render() {
    return html`<dialog
      part="dialog"
      aria-labelledby="${this.#id}-heading"
      aria-modal="true"
      @cancel=${(e: Event) => {
        e.preventDefault()
        this.close('escape')
      }}
      @close=${() => (this.open = false)}
      @click=${(e: MouseEvent) => {
        if (e.target === this.dialog && !this.preventCloseOnClickOutside) {
          const r = this.dialog!.getBoundingClientRect()
          const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
          if (!inside) this.close('backdrop')
        }
      }}
    >
      <header>
        <div>
          ${this.label ? html`<p class="eyebrow">${this.label}</p>` : nothing}
          <h2 id="${this.#id}-heading">${this.heading}</h2>
        </div>
        <button class="close" type="button" aria-label=${this.closeLabel} @click=${() => this.close('close-button')}>
          ${icon('close', 20)}
        </button>
      </header>
      <div class="body"><slot></slot></div>
      <slot name="footer">
        ${this.passive
          ? nothing
          : html`<footer>
              ${this.secondaryButtonText
                ? html`<button class="secondary" type="button" @click=${() => this.close('secondary')}>${this.secondaryButtonText}</button>`
                : nothing}
              <button class="primary" type="button" ?disabled=${this.primaryButtonDisabled} @click=${() => emit(this, 'submit', {})}>
                ${this.primaryButtonText}
              </button>
            </footer>`}
      </slot>
    </dialog>`
  }
}
