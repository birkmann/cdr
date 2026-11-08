import { css, html, nothing } from 'lit'
import { base, emitChange, fieldStyles, uid } from '../base.js'
import { FormControl } from '../form.js'
import { icon } from '../icons.js'
import { readOptions, watchOptions, type OptionData } from '../options.js'

/**
 * A styled native select. Options are light-DOM `<option>` children.
 * @element __P__-select
 * @fires change - when an option was chosen
 * @csspart select - the native select
 */
export class Select extends FormControl {
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
      select.control {
        appearance: none;
        padding-right: var(--__P__-spacing-09);
        cursor: pointer;
      }
      .chevron {
        position: absolute;
        right: var(--__P__-spacing-05);
        pointer-events: none;
        display: inline-flex;
        color: var(--__P__-icon-primary);
      }
      ::slotted(*) {
        display: none;
      }
    `,
  ]
  static override properties = {
    ...FormControl.properties,
    label: { type: String },
    helperText: { type: String, attribute: 'helper-text' },
    value: { type: String },
    invalid: { type: Boolean, reflect: true },
    invalidText: { type: String, attribute: 'invalid-text' },
    size: { type: String, reflect: true },
    hideLabel: { type: Boolean, attribute: 'hide-label' },
    options: { state: true },
  }
  declare label: string
  declare helperText: string
  declare value: string
  declare invalid: boolean
  declare invalidText: string
  declare size: 'sm' | 'md' | 'lg'
  declare hideLabel: boolean
  declare options: OptionData[]
  #id = uid('select')
  #initial: string | undefined
  #mo?: MutationObserver
  constructor() {
    super()
    this.label = ''
    this.helperText = ''
    this.value = ''
    this.invalid = false
    this.invalidText = ''
    this.size = 'md'
    this.hideLabel = false
    this.options = []
  }
  override connectedCallback() {
    super.connectedCallback()
    this.#sync()
    this.#mo = watchOptions(this, () => this.#sync())
  }
  override disconnectedCallback() {
    super.disconnectedCallback()
    this.#mo?.disconnect()
  }
  #sync() {
    this.options = readOptions(this)
    if (!this.value) this.value = (this.options.find((o) => o.selected) ?? this.options.find((o) => !o.disabled))?.value ?? ''
    this.#initial ??= this.value
  }
  protected formValue() {
    return this.value
  }
  protected override validity() {
    if (this.invalid) return { flags: { customError: true }, message: this.invalidText || 'Invalid value.' }
    return super.validity()
  }
  formResetCallback() {
    this.value = this.#initial ?? ''
  }
  override render() {
    const msg = this.invalid ? `${this.#id}-msg` : this.helperText ? `${this.#id}-help` : undefined
    return html`<div class="field">
      <label for=${this.#id} class=${this.hideLabel ? 'visually-hidden' : ''}>${this.label}</label>
      <div class="wrap">
        <select
          part="select"
          class="control"
          id=${this.#id}
          name=${this.name || nothing}
          ?disabled=${this.disabled}
          ?required=${this.required}
          aria-invalid=${this.invalid ? 'true' : 'false'}
          aria-describedby=${msg ?? nothing}
          @change=${(e: Event) => {
            this.value = (e.target as HTMLSelectElement).value
            emitChange(this)
          }}
        >
          ${this.options.map(
            (o) => html`<option value=${o.value} ?disabled=${o.disabled} ?selected=${o.value === this.value}>${o.label}</option>`,
          )}
        </select>
        <span class="chevron">${icon('chevron-down', 16)}</span>
      </div>
      ${this.invalid
        ? html`<p class="error" id="${this.#id}-msg">${this.invalidText}</p>`
        : this.helperText
          ? html`<p class="helper" id="${this.#id}-help">${this.helperText}</p>`
          : nothing}
      <slot></slot>
    </div>`
  }
}
