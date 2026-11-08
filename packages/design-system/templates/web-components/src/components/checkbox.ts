import { css, html, nothing, type PropertyValues } from 'lit'
import { base, emitChange, type, uid } from '../base.js'
import { FormControl } from '../form.js'

/**
 * A yes / no choice. Space toggles it. Submits `value` (default "on") when checked.
 * @element __P__-checkbox
 * @slot - the label (or use the `label` attribute)
 * @fires change - when toggled by the user
 * @csspart input - the native checkbox
 */
export class Checkbox extends FormControl {
  static override styles = [
    base,
    css`
      :host {
        display: block;
      }
      .wrap {
        display: inline-flex;
        align-items: flex-start;
        gap: var(--__P__-spacing-03);
        cursor: pointer;
        ${type('body-compact-01')}
        color: var(--__P__-text-primary);
      }
      input {
        appearance: none;
        flex-shrink: 0;
        width: 1rem;
        height: 1rem;
        margin: 0.125rem 0 0;
        border: 1px solid var(--__P__-icon-primary);
        border-radius: min(var(--__P__-radius-control), 4px);
        background: transparent;
        display: grid;
        place-content: center;
        cursor: pointer;
      }
      input::before {
        content: '';
        width: 0.625rem;
        height: 0.625rem;
        transform: scale(0);
        background: var(--__P__-icon-on-color);
        clip-path: polygon(14% 44%, 0 65%, 50% 100%, 100% 16%, 80% 0%, 43% 62%);
      }
      input:checked,
      input:indeterminate {
        background: var(--__P__-icon-primary);
        border-color: var(--__P__-icon-primary);
      }
      input:checked::before {
        transform: scale(1);
        background: var(--__P__-background);
      }
      input:indeterminate::before {
        transform: scale(1);
        clip-path: inset(40% 10%);
        background: var(--__P__-background);
      }
      input:focus-visible {
        outline: 2px solid var(--__P__-focus);
        outline-offset: 1px;
      }
      :host([invalid]) input {
        border-color: var(--__P__-support-error);
        outline: 1px solid var(--__P__-support-error);
      }
      :host([disabled]) .wrap {
        color: var(--__P__-text-disabled);
        cursor: not-allowed;
      }
      :host([disabled]) input {
        border-color: var(--__P__-icon-disabled);
        cursor: not-allowed;
      }
      :host([disabled]) input:checked {
        background: var(--__P__-icon-disabled);
      }
      .helper {
        ${type('helper-text-01')}
        color: var(--__P__-text-helper);
        margin: var(--__P__-spacing-02) 0 0 calc(1rem + var(--__P__-spacing-03));
      }
      :host([invalid]) .helper {
        color: var(--__P__-text-error);
      }
    `,
  ]
  static override properties = {
    ...FormControl.properties,
    checked: { type: Boolean, reflect: true },
    indeterminate: { type: Boolean, reflect: true },
    value: { type: String },
    label: { type: String },
    helperText: { type: String, attribute: 'helper-text' },
    invalid: { type: Boolean, reflect: true },
  }
  declare checked: boolean
  declare indeterminate: boolean
  declare value: string
  declare label: string
  declare helperText: string
  declare invalid: boolean
  #id = uid('checkbox')
  #initial: boolean | undefined
  constructor() {
    super()
    this.checked = false
    this.indeterminate = false
    this.value = 'on'
    this.label = ''
    this.helperText = ''
    this.invalid = false
  }
  override connectedCallback() {
    super.connectedCallback()
    this.#initial ??= this.checked
  }
  protected formValue() {
    return this.checked ? this.value : null
  }
  protected override validity() {
    const missing = this.required && !this.checked
    return { flags: missing ? { valueMissing: true } : {}, message: missing ? 'Please check this box.' : '' }
  }
  formResetCallback() {
    this.checked = this.#initial ?? false
    this.indeterminate = false
  }
  /** Toggle as if the user clicked it (fires change). */
  toggle() {
    if (this.disabled) return
    this.checked = !this.checked
    this.indeterminate = false
    emitChange(this)
  }
  protected override updated(changed: PropertyValues) {
    super.updated(changed)
    const input = this.renderRoot.querySelector('input')
    if (input) input.indeterminate = this.indeterminate
  }
  override render() {
    return html`<label class="wrap" for=${this.#id}>
        <input
          part="input"
          id=${this.#id}
          type="checkbox"
          .checked=${this.checked}
          ?disabled=${this.disabled}
          ?required=${this.required}
          aria-invalid=${this.invalid ? 'true' : 'false'}
          aria-checked=${this.indeterminate ? 'mixed' : this.checked ? 'true' : 'false'}
          aria-describedby=${this.helperText ? `${this.#id}-help` : nothing}
          @change=${(e: Event) => {
            this.checked = (e.target as HTMLInputElement).checked
            this.indeterminate = false
            emitChange(this)
          }}
        />
        <span><slot>${this.label}</slot></span>
      </label>
      ${this.helperText ? html`<p class="helper" id="${this.#id}-help">${this.helperText}</p>` : nothing}`
  }
}
