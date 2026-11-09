import { css, html, nothing } from 'lit'
import { base, emitChange, type, uid } from '../base.js'
import { FormControl } from '../form.js'

/**
 * An on / off switch (`role="switch"`). Click, Space or Enter toggles it.
 * @element __P__-toggle
 * @fires change - when toggled by the user
 * @csspart switch - the switch button
 */
export class Toggle extends FormControl {
  static override styles = [
    base,
    css`
      :host {
        display: block;
      }
      .label {
        ${type('label-01')}
        color: var(--__P__-text-secondary);
        display: block;
        margin-bottom: var(--__P__-spacing-03);
      }
      .row {
        display: inline-flex;
        align-items: center;
        gap: var(--__P__-spacing-03);
      }
      button {
        position: relative;
        width: var(--__P__-dim-3rem);
        height: var(--__P__-dim-1-5rem);
        padding: 0;
        border: 0;
        border-radius: var(--__P__-radius-pill);
        background: var(--__P__-toggle-off);
        cursor: pointer;
        transition: background-color var(--__P__-duration-fast-02) var(--__P__-easing-standard-productive);
      }
      button::after {
        content: '';
        position: absolute;
        top: var(--__P__-dim-0-1875rem);
        left: var(--__P__-dim-0-1875rem);
        width: var(--__P__-dim-1-125rem);
        height: var(--__P__-dim-1-125rem);
        border-radius: 50%;
        background: var(--__P__-icon-on-color);
        transition: transform var(--__P__-duration-fast-02) var(--__P__-easing-standard-productive);
      }
      button[aria-checked='true'] {
        background: var(--__P__-support-success);
      }
      button[aria-checked='true']::after {
        transform: translateX(var(--__P__-dim-1-5rem));
      }
      :host([size='sm']) button {
        width: var(--__P__-dim-2rem);
        height: var(--__P__-dim-1rem);
      }
      :host([size='sm']) button::after {
        top: var(--__P__-dim-0-1875rem);
        left: var(--__P__-dim-0-1875rem);
        width: var(--__P__-dim-0-625rem);
        height: var(--__P__-dim-0-625rem);
      }
      :host([size='sm']) button[aria-checked='true']::after {
        transform: translateX(var(--__P__-dim-1rem));
      }
      button:focus-visible {
        outline: 2px solid var(--__P__-focus);
        outline-offset: 2px;
      }
      button:disabled {
        background: var(--__P__-button-disabled);
        cursor: not-allowed;
      }
      .state {
        ${type('body-compact-01')}
        color: var(--__P__-text-primary);
      }
      :host([disabled]) .state,
      :host([disabled]) .label {
        color: var(--__P__-text-disabled);
      }
    `,
  ]
  static override properties = {
    ...FormControl.properties,
    checked: { type: Boolean, reflect: true },
    label: { type: String },
    labelOn: { type: String, attribute: 'label-on' },
    labelOff: { type: String, attribute: 'label-off' },
    hideLabel: { type: Boolean, attribute: 'hide-label' },
    size: { type: String, reflect: true },
    value: { type: String },
  }
  declare checked: boolean
  declare label: string
  declare labelOn: string
  declare labelOff: string
  declare hideLabel: boolean
  /** sm | md */
  declare size: 'sm' | 'md'
  declare value: string
  #id = uid('toggle')
  #initial: boolean | undefined
  constructor() {
    super()
    this.checked = false
    this.label = ''
    this.labelOn = 'On'
    this.labelOff = 'Off'
    this.hideLabel = false
    this.size = 'md'
    this.value = 'on'
  }
  override connectedCallback() {
    super.connectedCallback()
    this.#initial ??= this.checked
  }
  protected formValue() {
    return this.checked ? this.value : null
  }
  formResetCallback() {
    this.checked = this.#initial ?? false
  }
  toggle() {
    if (this.disabled) return
    this.checked = !this.checked
    emitChange(this)
  }
  override render() {
    return html`<span class="label ${this.hideLabel ? 'visually-hidden' : ''}" id="${this.#id}-label">${this.label}</span>
      <span class="row">
        <button
          part="switch"
          type="button"
          role="switch"
          aria-checked=${this.checked ? 'true' : 'false'}
          aria-labelledby="${this.#id}-label"
          aria-describedby="${this.#id}-state"
          ?disabled=${this.disabled}
          @click=${() => this.toggle()}
        ></button>
        <span class="state" id="${this.#id}-state" aria-hidden=${this.size === 'sm' ? 'true' : nothing}
          >${this.checked ? this.labelOn : this.labelOff}</span
        >
      </span>`
  }
}
