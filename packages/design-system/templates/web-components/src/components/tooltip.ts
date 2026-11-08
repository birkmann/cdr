import { LitElement, css, html } from 'lit'
import { base, type } from '../base.js'

/**
 * A short hint for the slotted trigger, shown on hover and keyboard focus, hidden with Esc.
 * The hint becomes the trigger's accessible description (`aria-description`).
 * @element __P__-tooltip
 * @slot - the trigger (a focusable element)
 */
export class Tooltip extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        position: relative;
        display: inline-flex;
      }
      .tip {
        ${type('body-compact-01')}
        position: absolute;
        z-index: 20;
        width: max-content;
        max-width: 18rem;
        padding: var(--__P__-spacing-03) var(--__P__-spacing-05);
        border-radius: var(--__P__-radius-field);
        background: var(--__P__-background-inverse);
        color: var(--__P__-text-inverse);
        box-shadow: var(--__P__-shadow-02);
        pointer-events: none;
        opacity: 0;
        transition: opacity var(--__P__-duration-fast-02) var(--__P__-easing-standard-productive);
      }
      :host([open]) .tip {
        opacity: 1;
      }
      :host(:not([align])) .tip,
      :host([align='top']) .tip {
        bottom: calc(100% + 0.5rem);
        left: 50%;
        transform: translateX(-50%);
      }
      :host([align='bottom']) .tip {
        top: calc(100% + 0.5rem);
        left: 50%;
        transform: translateX(-50%);
      }
      :host([align='left']) .tip {
        right: calc(100% + 0.5rem);
        top: 50%;
        transform: translateY(-50%);
      }
      :host([align='right']) .tip {
        left: calc(100% + 0.5rem);
        top: 50%;
        transform: translateY(-50%);
      }
    `,
  ]
  static override properties = {
    label: { type: String },
    align: { type: String, reflect: true },
    open: { type: Boolean, reflect: true },
  }
  declare label: string
  /** top | bottom | left | right */
  declare align: 'top' | 'bottom' | 'left' | 'right'
  declare open: boolean
  #show = () => (this.open = true)
  #hide = () => (this.open = false)
  #key = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.open) {
      e.stopPropagation()
      this.open = false
    }
  }
  constructor() {
    super()
    this.label = ''
    this.align = 'top'
    this.open = false
    this.addEventListener('mouseenter', this.#show)
    this.addEventListener('mouseleave', this.#hide)
    this.addEventListener('focusin', this.#show)
    this.addEventListener('focusout', this.#hide)
    this.addEventListener('keydown', this.#key)
  }
  #describe() {
    const slot = this.renderRoot.querySelector('slot')
    for (const el of slot?.assignedElements() ?? []) el.setAttribute('aria-description', this.label)
  }
  protected override updated() {
    this.#describe()
  }
  override render() {
    return html`<slot @slotchange=${() => this.#describe()}></slot><span class="tip" role="tooltip" aria-hidden="true">${this.label}</span>`
  }
}
