import { LitElement, css, html, nothing } from 'lit'
import { base, type, internalsOf } from '../base.js'
import { icon, type IconName } from '../icons.js'

/**
 * Triggers an action. Inside a form, `type="submit"` submits it and `type="reset"` resets it.
 * @element __P__-button
 * @slot - the label
 * @csspart button - the native button or link
 */
export class Button extends LitElement {
  static formAssociated = true
  static override shadowRootOptions = { ...LitElement.shadowRootOptions, delegatesFocus: true }
  static override styles = [
    base,
    css`
      :host {
        display: inline-flex;
        vertical-align: top;
      }
      .btn {
        ${type('body-compact-01')}
        display: inline-flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--__P__-spacing-05);
        min-height: var(--__P__-size-md);
        padding: 0 var(--__P__-spacing-05);
        border: 1px solid transparent;
        border-radius: var(--__P__-radius-control);
        cursor: pointer;
        text-decoration: none;
        white-space: nowrap;
        transition:
          background-color var(--__P__-duration-fast-01) var(--__P__-easing-standard-productive),
          box-shadow var(--__P__-duration-fast-01) var(--__P__-easing-standard-productive);
      }
      :host([uppercase]) .btn {
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      :host([size='sm']) .btn {
        min-height: var(--__P__-size-sm);
        padding: 0 var(--__P__-spacing-04);
      }
      :host([size='lg']) .btn {
        min-height: var(--__P__-size-lg);
      }
      :host([full-width]) {
        display: flex;
      }
      :host([full-width]) .btn {
        width: 100%;
      }
      .btn,
      :host([kind='primary']) .btn {
        background: var(--__P__-button-primary);
        color: var(--__P__-button-primary-text);
      }
      .btn:hover,
      :host([kind='primary']) .btn:hover {
        background: var(--__P__-button-primary-hover);
      }
      .btn:active,
      :host([kind='primary']) .btn:active {
        background: var(--__P__-button-primary-active);
      }
      :host([kind='secondary']) .btn {
        background: var(--__P__-button-secondary);
        color: var(--__P__-button-secondary-text);
        border-color: var(--__P__-button-secondary-border);
      }
      :host([kind='secondary']) .btn:hover {
        background: var(--__P__-button-secondary-hover);
      }
      :host([kind='secondary']) .btn:active {
        background: var(--__P__-button-secondary-active);
      }
      :host([kind='tertiary']) .btn {
        background: transparent;
        color: var(--__P__-button-tertiary-text);
        border-color: var(--__P__-button-tertiary);
      }
      :host([kind='tertiary']) .btn:hover {
        background: var(--__P__-button-tertiary-hover);
        color: var(--__P__-text-on-color);
      }
      :host([kind='ghost']) .btn {
        background: transparent;
        color: var(--__P__-link-primary);
      }
      :host([kind='ghost']) .btn:hover {
        background: var(--__P__-layer-01-hover);
        color: var(--__P__-link-primary-hover);
      }
      :host([kind='danger']) .btn {
        background: var(--__P__-button-danger);
        color: var(--__P__-button-danger-text);
      }
      :host([kind='danger']) .btn:hover {
        background: var(--__P__-button-danger-hover);
      }
      :host([kind='danger']) .btn:active {
        background: var(--__P__-button-danger-active);
      }
      .btn:focus-visible {
        outline: 2px solid var(--__P__-focus);
        outline-offset: -2px;
        box-shadow: inset 0 0 0 3px var(--__P__-focus-inset);
      }
      .btn[aria-disabled='true'],
      .btn:disabled {
        background: var(--__P__-button-disabled) !important;
        color: var(--__P__-text-on-color) !important;
        border-color: transparent !important;
        cursor: not-allowed;
      }
      :host([kind='ghost']) .btn:disabled,
      :host([kind='tertiary']) .btn:disabled {
        background: transparent !important;
        color: var(--__P__-text-disabled) !important;
      }
      .icon {
        flex-shrink: 0;
      }
    `,
  ]
  static override properties = {
    kind: { type: String, reflect: true },
    size: { type: String, reflect: true },
    type: { type: String, reflect: true },
    disabled: { type: Boolean, reflect: true },
    href: { type: String, reflect: true },
    target: { type: String },
    icon: { type: String },
    fullWidth: { type: Boolean, reflect: true, attribute: 'full-width' },
    uppercase: { type: Boolean, reflect: true },
  }
  /** primary | secondary | tertiary | ghost | danger */
  declare kind: 'primary' | 'secondary' | 'tertiary' | 'ghost' | 'danger'
  /** sm | md | lg */
  declare size: 'sm' | 'md' | 'lg'
  /** button | submit | reset */
  declare type: 'button' | 'submit' | 'reset'
  declare disabled: boolean
  /** renders a link instead of a button */
  declare href?: string
  declare target?: string
  /** trailing icon name */
  declare icon?: IconName
  declare fullWidth: boolean
  declare uppercase: boolean
  readonly #internals = internalsOf(this)

  constructor() {
    super()
    this.kind = 'primary'
    this.size = 'md'
    this.type = 'button'
    this.disabled = false
    this.fullWidth = false
    this.uppercase = false
  }

  get form(): HTMLFormElement | null {
    return this.#internals?.form ?? this.closest('form')
  }

  #onClick(e: Event) {
    if (this.disabled) {
      e.preventDefault()
      e.stopImmediatePropagation()
      return
    }
    if (this.href) return
    const form = this.form
    if (!form) return
    if (this.type === 'submit') form.requestSubmit()
    else if (this.type === 'reset') form.reset()
  }

  override render() {
    const content = html`<slot></slot>${this.icon ? icon(this.icon, 16) : nothing}`
    if (this.href)
      return html`<a
        class="btn"
        part="button"
        href=${this.disabled ? nothing : this.href}
        target=${this.target ?? nothing}
        aria-disabled=${this.disabled ? 'true' : nothing}
        role=${this.disabled ? 'link' : nothing}
        @click=${this.#onClick}
        >${content}</a
      >`
    return html`<button class="btn" part="button" type="button" ?disabled=${this.disabled} @click=${this.#onClick}>
      ${content}
    </button>`
  }
}
