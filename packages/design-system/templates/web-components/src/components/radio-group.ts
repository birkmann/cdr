import { LitElement, css, html, nothing } from 'lit'
import { base, emitChange, type, uid } from '../base.js'
import { FormControl } from '../form.js'

/**
 * One option of a radio group.
 * @element __P__-radio
 * @slot - the label (or use the `label` attribute)
 */
export class Radio extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        display: block;
      }
      .radio {
        display: inline-flex;
        align-items: center;
        gap: var(--__P__-spacing-03);
        ${type('body-compact-01')}
        color: var(--__P__-text-primary);
        cursor: pointer;
        outline: none;
        border-radius: 2px;
      }
      .dot {
        width: var(--__P__-dim-1-125rem);
        height: var(--__P__-dim-1-125rem);
        border: 1px solid var(--__P__-icon-primary);
        border-radius: 50%;
        display: grid;
        place-content: center;
        flex-shrink: 0;
      }
      .dot::after {
        content: '';
        width: var(--__P__-dim-0-5rem);
        height: var(--__P__-dim-0-5rem);
        border-radius: 50%;
        background: var(--__P__-icon-primary);
        transform: scale(0);
        transition: transform var(--__P__-duration-fast-01) var(--__P__-easing-standard-productive);
      }
      :host([checked]) .dot::after {
        transform: scale(1);
      }
      .radio:focus-visible .dot {
        outline: 2px solid var(--__P__-focus);
        outline-offset: 1px;
      }
      :host([disabled]) .radio {
        color: var(--__P__-text-disabled);
        cursor: not-allowed;
      }
      :host([disabled]) .dot {
        border-color: var(--__P__-icon-disabled);
      }
      :host([disabled]) .dot::after {
        background: var(--__P__-icon-disabled);
      }
    `,
  ]
  static override properties = {
    value: { type: String, reflect: true },
    label: { type: String },
    checked: { type: Boolean, reflect: true },
    disabled: { type: Boolean, reflect: true },
    focusable: { type: Boolean },
  }
  declare value: string
  declare label: string
  declare checked: boolean
  declare disabled: boolean
  /** set by the group (roving tabindex) */
  declare focusable: boolean
  constructor() {
    super()
    this.value = ''
    this.label = ''
    this.checked = false
    this.disabled = false
    this.focusable = false
  }
  override focus(options?: FocusOptions) {
    this.renderRoot.querySelector<HTMLElement>('.radio')?.focus(options)
  }
  override render() {
    return html`<span
      class="radio"
      role="radio"
      aria-checked=${this.checked ? 'true' : 'false'}
      aria-disabled=${this.disabled ? 'true' : 'false'}
      tabindex=${this.focusable && !this.disabled ? '0' : '-1'}
      ><span class="dot"></span><span><slot>${this.label}</slot></span></span
    >`
  }
}

/**
 * Choose one of several options. Arrow keys move the selection, one Tab stop for the whole group.
 * @element __P__-radio-group
 * @slot - `__P__-radio` elements
 * @fires change - when the selection changed
 */
export class RadioGroup extends FormControl {
  static override shadowRootOptions: ShadowRootInit = { ...LitElement.shadowRootOptions, delegatesFocus: false }
  static override styles = [
    base,
    css`
      :host {
        display: block;
      }
      fieldset {
        border: 0;
        margin: 0;
        padding: 0;
        min-width: 0;
      }
      legend {
        ${type('label-01')}
        color: var(--__P__-text-secondary);
        margin-bottom: var(--__P__-spacing-03);
        padding: 0;
      }
      .options {
        display: flex;
        flex-direction: column;
        gap: var(--__P__-spacing-03);
      }
      :host([orientation='horizontal']) .options {
        flex-direction: row;
        flex-wrap: wrap;
        gap: var(--__P__-spacing-06);
      }
      .error {
        ${type('helper-text-01')}
        color: var(--__P__-text-error);
        margin: var(--__P__-spacing-03) 0 0;
      }
      .helper {
        ${type('helper-text-01')}
        color: var(--__P__-text-helper);
        margin: var(--__P__-spacing-03) 0 0;
      }
    `,
  ]
  static override properties = {
    ...FormControl.properties,
    legend: { type: String },
    value: { type: String, reflect: true },
    orientation: { type: String, reflect: true },
    invalid: { type: Boolean, reflect: true },
    invalidText: { type: String, attribute: 'invalid-text' },
    helperText: { type: String, attribute: 'helper-text' },
  }
  declare legend: string
  declare value: string
  /** vertical | horizontal */
  declare orientation: 'vertical' | 'horizontal'
  declare invalid: boolean
  declare invalidText: string
  declare helperText: string
  #id = uid('radio-group')
  #initial: string | undefined
  constructor() {
    super()
    this.legend = ''
    this.value = ''
    this.orientation = 'vertical'
    this.invalid = false
    this.invalidText = ''
    this.helperText = ''
    this.addEventListener('click', (e) => {
      const r = (e.target as HTMLElement).closest?.('__P__-radio') as Radio | null
      if (r && this.contains(r)) this.#select(r, true)
    })
    this.addEventListener('keydown', (e) => this.#onKey(e))
  }
  get radios(): Radio[] {
    return [...this.querySelectorAll<Radio>('__P__-radio')]
  }
  override connectedCallback() {
    super.connectedCallback()
    this.#initial ??= this.value || this.radios.find((r) => r.checked)?.value || ''
  }
  protected formValue() {
    return this.value || null
  }
  protected override validity() {
    if (this.invalid) return { flags: { customError: true }, message: this.invalidText || 'Invalid value.' }
    const missing = this.required && !this.value
    return { flags: missing ? { valueMissing: true } : {}, message: missing ? 'Please select an option.' : '' }
  }
  formResetCallback() {
    this.value = this.#initial ?? ''
  }
  #select(r: Radio, user: boolean) {
    if (r.disabled || this.disabled) return
    const changed = this.value !== r.value
    this.value = r.value
    r.focus()
    if (changed && user) emitChange(this)
  }
  #onKey(e: KeyboardEvent) {
    const enabled = this.radios.filter((r) => !r.disabled)
    if (!enabled.length || this.disabled) return
    const cur = enabled.findIndex((r) => r.value === this.value || r.matches(':focus-within'))
    let next: number
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (cur + 1) % enabled.length
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (cur - 1 + enabled.length) % enabled.length
    else if (e.key === ' ') next = Math.max(0, cur)
    else return
    e.preventDefault()
    this.#select(enabled[next]!, true)
  }
  protected override willUpdate() {
    const radios = this.radios
    if (!this.value) this.value = radios.find((r) => r.checked)?.value ?? ''
    const tab = radios.find((r) => r.value === this.value && !r.disabled) ?? radios.find((r) => !r.disabled)
    for (const r of radios) {
      r.checked = r.value === this.value
      r.focusable = r === tab
      if (this.disabled) r.disabled = true
    }
  }
  override render() {
    return html`<fieldset ?disabled=${this.disabled} aria-invalid=${this.invalid ? 'true' : 'false'}>
      <legend id="${this.#id}-legend">${this.legend}</legend>
      <div class="options" role="radiogroup" aria-labelledby="${this.#id}-legend" aria-required=${this.required ? 'true' : 'false'}>
        <slot @slotchange=${() => this.requestUpdate()}></slot>
      </div>
      ${this.invalid
        ? html`<p class="error">${this.invalidText}</p>`
        : this.helperText
          ? html`<p class="helper">${this.helperText}</p>`
          : nothing}
    </fieldset>`
  }
}
