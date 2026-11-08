import { css, html, nothing } from 'lit'
import { base, emitChange, fieldStyles, uid } from '../base.js'
import { FormControl } from '../form.js'
import { flagsOf } from './text-input.js'

/**
 * A multi-line text field with label, helper text, validation and an optional character counter.
 * @element __P__-textarea
 * @fires input - while typing
 * @fires change - when the value was committed
 * @csspart textarea - the native textarea
 */
export class Textarea extends FormControl {
  static override styles = [
    base,
    fieldStyles,
    css`
      :host {
        display: block;
      }
      textarea.control {
        padding: var(--__P__-spacing-04) var(--__P__-spacing-05);
        resize: vertical;
        min-height: calc(var(--__P__-size-md) * 2);
      }
      .top {
        display: flex;
        justify-content: space-between;
      }
      .counter {
        color: var(--__P__-text-helper);
      }
    `,
  ]
  static override properties = {
    ...FormControl.properties,
    label: { type: String },
    helperText: { type: String, attribute: 'helper-text' },
    placeholder: { type: String },
    value: { type: String },
    rows: { type: Number },
    maxlength: { type: Number },
    invalid: { type: Boolean, reflect: true },
    invalidText: { type: String, attribute: 'invalid-text' },
    readonly: { type: Boolean, reflect: true },
    hideLabel: { type: Boolean, attribute: 'hide-label' },
  }
  declare label: string
  declare helperText: string
  declare placeholder: string
  declare value: string
  declare rows: number
  /** maximum characters; shows a counter */
  declare maxlength?: number
  declare invalid: boolean
  declare invalidText: string
  declare readonly: boolean
  declare hideLabel: boolean
  #id = uid('textarea')
  #initial: string | undefined
  constructor() {
    super()
    this.label = ''
    this.helperText = ''
    this.placeholder = ''
    this.value = ''
    this.rows = 4
    this.invalid = false
    this.invalidText = ''
    this.readonly = false
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
    const el = this.renderRoot?.querySelector('textarea')
    if (this.invalid) return { flags: { customError: true }, message: this.invalidText || 'Invalid value.' }
    if (el && !el.validity.valid) return { flags: flagsOf(el.validity), message: el.validationMessage }
    return super.validity()
  }
  formResetCallback() {
    this.value = this.#initial ?? ''
  }
  override render() {
    const msg = this.invalid ? `${this.#id}-msg` : this.helperText ? `${this.#id}-help` : undefined
    return html`<div class="field">
      <div class="top">
        <label for=${this.#id} class=${this.hideLabel ? 'visually-hidden' : ''}>${this.label}</label>
        ${this.maxlength ? html`<span class="label counter" aria-live="polite">${this.value.length}/${this.maxlength}</span>` : nothing}
      </div>
      <textarea
        part="textarea"
        class="control"
        id=${this.#id}
        .value=${this.value}
        rows=${this.rows}
        name=${this.name || nothing}
        placeholder=${this.placeholder || nothing}
        maxlength=${this.maxlength ?? nothing}
        ?disabled=${this.disabled}
        ?readonly=${this.readonly}
        ?required=${this.required}
        aria-invalid=${this.invalid ? 'true' : 'false'}
        aria-describedby=${msg ?? nothing}
        @input=${(e: Event) => (this.value = (e.target as HTMLTextAreaElement).value)}
        @change=${() => emitChange(this)}
      ></textarea>
      ${this.invalid
        ? html`<p class="error" id="${this.#id}-msg">${this.invalidText}</p>`
        : this.helperText
          ? html`<p class="helper" id="${this.#id}-help">${this.helperText}</p>`
          : nothing}
    </div>`
  }
}
