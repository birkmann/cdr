import { css, html, nothing } from 'lit'
import { base, emitChange, fieldStyles, uid } from '../base.js'
import { FormControl } from '../form.js'
import { icon } from '../icons.js'

/**
 * A single-line text field with label, helper text and validation.
 * @element __P__-text-input
 * @fires input - while typing (native, from the host)
 * @fires change - when the value was committed
 * @csspart input - the native input
 */
export class TextInput extends FormControl {
  static override styles = [
    base,
    fieldStyles,
    css`
      :host {
        display: block;
      }
      .wrap {
        position: relative;
        display: flex;
        align-items: center;
      }
      .status {
        position: absolute;
        right: var(--__P__-spacing-05);
        display: inline-flex;
        pointer-events: none;
      }
      .status.invalid {
        color: var(--__P__-support-error);
      }
      .status.warn {
        color: var(--__P__-support-warning);
      }
      .wrap:has(.status) input {
        padding-right: var(--__P__-spacing-09);
      }
      :host([readonly]) input {
        background: transparent;
        border-bottom-color: var(--__P__-border-subtle-01);
      }
    `,
  ]
  static override properties = {
    ...FormControl.properties,
    label: { type: String },
    helperText: { type: String, attribute: 'helper-text' },
    placeholder: { type: String },
    value: { type: String },
    type: { type: String },
    invalid: { type: Boolean, reflect: true },
    invalidText: { type: String, attribute: 'invalid-text' },
    warn: { type: Boolean, reflect: true },
    warnText: { type: String, attribute: 'warn-text' },
    readonly: { type: Boolean, reflect: true },
    size: { type: String, reflect: true },
    hideLabel: { type: Boolean, attribute: 'hide-label' },
    autocomplete: { type: String },
    maxlength: { type: Number },
    minlength: { type: Number },
    pattern: { type: String },
  }
  declare label: string
  declare helperText: string
  declare placeholder: string
  declare value: string
  /** text | email | password | tel | url | number | search */
  declare type: string
  declare invalid: boolean
  declare invalidText: string
  declare warn: boolean
  declare warnText: string
  declare readonly: boolean
  declare size: 'sm' | 'md' | 'lg'
  declare hideLabel: boolean
  declare autocomplete?: string
  declare maxlength?: number
  declare minlength?: number
  declare pattern?: string
  #id = uid('input')
  #initial: string | undefined

  constructor() {
    super()
    this.label = ''
    this.helperText = ''
    this.placeholder = ''
    this.value = ''
    this.type = 'text'
    this.invalid = false
    this.invalidText = ''
    this.warn = false
    this.warnText = ''
    this.readonly = false
    this.size = 'md'
    this.hideLabel = false
  }
  override connectedCallback() {
    super.connectedCallback()
    this.#initial ??= this.value
  }
  protected formValue() {
    return this.value
  }
  protected override validity() {
    const input = this.renderRoot?.querySelector('input')
    if (this.invalid) return { flags: { customError: true }, message: this.invalidText || 'Invalid value.' }
    if (input && !input.validity.valid) return { flags: { ...flagsOf(input.validity) }, message: input.validationMessage }
    return super.validity()
  }
  formResetCallback() {
    this.value = this.#initial ?? ''
  }
  #onInput(e: Event) {
    this.value = (e.target as HTMLInputElement).value
  }
  override render() {
    const describedBy = this.invalid ? `${this.#id}-msg` : this.warn ? `${this.#id}-msg` : this.helperText ? `${this.#id}-help` : undefined
    return html`<div class="field">
      <label for=${this.#id} class=${this.hideLabel ? 'visually-hidden' : ''}>${this.label}</label>
      <div class="wrap">
        <input
          part="input"
          class="control"
          id=${this.#id}
          .value=${this.value}
          type=${this.type}
          name=${this.name || nothing}
          placeholder=${this.placeholder || nothing}
          autocomplete=${this.autocomplete ?? nothing}
          maxlength=${this.maxlength ?? nothing}
          minlength=${this.minlength ?? nothing}
          pattern=${this.pattern ?? nothing}
          ?disabled=${this.disabled}
          ?readonly=${this.readonly}
          ?required=${this.required}
          aria-invalid=${this.invalid ? 'true' : 'false'}
          aria-describedby=${describedBy ?? nothing}
          @input=${this.#onInput}
          @change=${() => emitChange(this)}
        />
        ${this.invalid
          ? html`<span class="status invalid">${icon('error', 16)}</span>`
          : this.warn
            ? html`<span class="status warn">${icon('warning', 16)}</span>`
            : nothing}
      </div>
      ${this.invalid
        ? html`<p class="error" id="${this.#id}-msg">${this.invalidText}</p>`
        : this.warn
          ? html`<p class="warn" id="${this.#id}-msg">${this.warnText}</p>`
          : this.helperText
            ? html`<p class="helper" id="${this.#id}-help">${this.helperText}</p>`
            : nothing}
    </div>`
  }
}

/** The set flags of a ValidityState. */
export function flagsOf(v: ValidityState): ValidityStateFlags {
  const out: ValidityStateFlags = {}
  for (const k of ['badInput', 'patternMismatch', 'rangeOverflow', 'rangeUnderflow', 'stepMismatch', 'tooLong', 'tooShort', 'typeMismatch', 'valueMissing'] as const)
    if (v[k]) out[k] = true
  return out
}
