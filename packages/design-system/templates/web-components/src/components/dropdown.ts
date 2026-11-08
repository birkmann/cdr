import { css, html, nothing } from 'lit'
import { base, emitChange, fieldStyles, type, uid } from '../base.js'
import { FormControl } from '../form.js'
import { icon } from '../icons.js'
import { readOptions, watchOptions, type OptionData } from '../options.js'

/**
 * A custom listbox (APG select-only combobox). Options are light-DOM `<option>` children.
 * Space / Enter / Alt+↓ open it; ↑ ↓ Home End move; typing jumps to an option; Enter selects; Esc closes.
 * @element __P__-dropdown
 * @fires change - when an option was selected
 * @csspart trigger - the combobox button
 * @csspart listbox - the list of options
 */
export class Dropdown extends FormControl {
  static override styles = [
    base,
    fieldStyles,
    css`
      :host {
        display: block;
        position: relative;
      }
      .trigger {
        display: flex;
        align-items: center;
        justify-content: space-between;
        text-align: left;
        cursor: pointer;
      }
      .trigger .placeholder {
        color: var(--__P__-text-placeholder);
      }
      .chevron {
        display: inline-flex;
        transition: transform var(--__P__-duration-fast-02) var(--__P__-easing-standard-productive);
      }
      [aria-expanded='true'] .chevron {
        transform: rotate(180deg);
      }
      ul {
        position: absolute;
        z-index: 10;
        left: 0;
        right: 0;
        margin: 0;
        padding: 0;
        list-style: none;
        max-height: 16rem;
        overflow: auto;
        background: var(--__P__-layer-01);
        box-shadow: var(--__P__-shadow-02);
        border-radius: 0 0 var(--__P__-radius-field) var(--__P__-radius-field);
      }
      li {
        ${type('body-compact-01')}
        display: flex;
        align-items: center;
        justify-content: space-between;
        min-height: var(--__P__-size-md);
        padding: 0 var(--__P__-spacing-05);
        color: var(--__P__-text-secondary);
        cursor: pointer;
        border-top: 1px solid var(--__P__-border-subtle-01);
      }
      li:first-child {
        border-top-color: transparent;
      }
      li[aria-selected='true'] {
        color: var(--__P__-text-primary);
        background: var(--__P__-layer-01-active);
      }
      li.active {
        background: var(--__P__-layer-01-hover);
        color: var(--__P__-text-primary);
        outline: 2px solid var(--__P__-focus);
        outline-offset: -2px;
      }
      li[aria-disabled='true'] {
        color: var(--__P__-text-disabled);
        cursor: not-allowed;
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
    placeholder: { type: String },
    value: { type: String },
    invalid: { type: Boolean, reflect: true },
    invalidText: { type: String, attribute: 'invalid-text' },
    size: { type: String, reflect: true },
    open: { type: Boolean, reflect: true },
    options: { state: true },
    active: { state: true },
  }
  declare label: string
  declare helperText: string
  declare placeholder: string
  declare value: string
  declare invalid: boolean
  declare invalidText: string
  declare size: 'sm' | 'md' | 'lg'
  declare open: boolean
  declare options: OptionData[]
  declare active: number
  #id = uid('dropdown')
  #initial: string | undefined
  #mo?: MutationObserver
  #typed = ''
  #typedAt = 0
  #outside = (e: Event) => {
    if (!e.composedPath().includes(this)) this.open = false
  }
  constructor() {
    super()
    this.label = ''
    this.helperText = ''
    this.placeholder = 'Choose an option'
    this.value = ''
    this.invalid = false
    this.invalidText = ''
    this.size = 'md'
    this.open = false
    this.options = []
    this.active = -1
  }
  override connectedCallback() {
    super.connectedCallback()
    this.#sync()
    this.#mo = watchOptions(this, () => this.#sync())
    document.addEventListener('pointerdown', this.#outside)
  }
  override disconnectedCallback() {
    super.disconnectedCallback()
    this.#mo?.disconnect()
    document.removeEventListener('pointerdown', this.#outside)
  }
  #sync() {
    this.options = readOptions(this)
    if (!this.value) this.value = this.options.find((o) => o.selected)?.value ?? ''
    this.#initial ??= this.value
  }
  protected formValue() {
    return this.value || null
  }
  protected override validity() {
    if (this.invalid) return { flags: { customError: true }, message: this.invalidText || 'Invalid value.' }
    return super.validity()
  }
  formResetCallback() {
    this.value = this.#initial ?? ''
  }
  get selectedLabel(): string {
    return this.options.find((o) => o.value === this.value)?.label ?? ''
  }
  #enabled(i: number) {
    return i >= 0 && i < this.options.length && !this.options[i]!.disabled
  }
  #move(from: number, step: 1 | -1) {
    for (let i = from + step; i >= 0 && i < this.options.length; i += step) if (this.#enabled(i)) return i
    return from
  }
  #openList() {
    if (this.disabled) return
    this.open = true
    const sel = this.options.findIndex((o) => o.value === this.value)
    this.active = this.#enabled(sel) ? sel : this.#move(-1, 1)
  }
  #choose(i: number) {
    if (!this.#enabled(i)) return
    const changed = this.options[i]!.value !== this.value
    this.value = this.options[i]!.value
    this.open = false
    this.renderRoot.querySelector<HTMLElement>('.trigger')?.focus()
    if (changed) emitChange(this)
  }
  #onKey(e: KeyboardEvent) {
    if (this.disabled) return
    const k = e.key
    if (!this.open) {
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ') {
        e.preventDefault()
        this.#openList()
      } else if (k.length === 1) this.#typeahead(k)
      return
    }
    if (k === 'ArrowDown') this.active = this.#move(this.active, 1)
    else if (k === 'ArrowUp') this.active = e.altKey ? this.active : this.#move(this.active, -1)
    else if (k === 'Home') this.active = this.#move(-1, 1)
    else if (k === 'End') this.active = this.#move(this.options.length, -1)
    else if (k === 'Enter' || k === ' ') this.#choose(this.active)
    else if (k === 'Escape') this.open = false
    else if (k === 'Tab') {
      this.open = false
      return
    } else if (k.length === 1) {
      this.#typeahead(k)
      return
    } else return
    e.preventDefault()
  }
  #typeahead(ch: string) {
    const now = Date.now()
    this.#typed = now - this.#typedAt < 600 ? this.#typed + ch.toLowerCase() : ch.toLowerCase()
    this.#typedAt = now
    const start = this.open ? this.active : this.options.findIndex((o) => o.value === this.value)
    const order = [...this.options.keys()].map((i) => (start + 1 + i) % this.options.length)
    const hit = order.find((i) => this.#enabled(i) && this.options[i]!.label.toLowerCase().startsWith(this.#typed))
    if (hit === undefined) return
    if (this.open) this.active = hit
    else this.#choose(hit)
  }
  override render() {
    const listId = `${this.#id}-list`
    const activeId = this.open && this.active >= 0 ? `${this.#id}-opt-${this.active}` : undefined
    const msg = this.invalid ? `${this.#id}-msg` : this.helperText ? `${this.#id}-help` : undefined
    return html`<div class="field">
      <span class="label" id="${this.#id}-label">${this.label}</span>
      <div
        part="trigger"
        class="control trigger focusable"
        role="combobox"
        tabindex=${this.disabled ? '-1' : '0'}
        aria-labelledby="${this.#id}-label"
        aria-controls=${listId}
        aria-expanded=${this.open ? 'true' : 'false'}
        aria-haspopup="listbox"
        aria-activedescendant=${activeId ?? nothing}
        aria-disabled=${this.disabled ? 'true' : 'false'}
        aria-invalid=${this.invalid ? 'true' : 'false'}
        aria-describedby=${msg ?? nothing}
        @click=${() => (this.open ? (this.open = false) : this.#openList())}
        @keydown=${this.#onKey}
        @blur=${(e: FocusEvent) => {
          if (!this.renderRoot.contains(e.relatedTarget as Node)) this.open = false
        }}
      >
        ${this.value ? html`<span>${this.selectedLabel}</span>` : html`<span class="placeholder">${this.placeholder}</span>`}
        <span class="chevron">${icon('chevron-down', 16)}</span>
      </div>
      <ul part="listbox" id=${listId} role="listbox" aria-labelledby="${this.#id}-label" ?hidden=${!this.open} tabindex="-1">
        ${this.options.map(
          (o, i) => html`<li
            id="${this.#id}-opt-${i}"
            role="option"
            class=${i === this.active ? 'active' : ''}
            aria-selected=${o.value === this.value ? 'true' : 'false'}
            aria-disabled=${o.disabled ? 'true' : nothing}
            @pointerdown=${(e: Event) => e.preventDefault()}
            @click=${() => this.#choose(i)}
          >
            ${o.label}${o.value === this.value ? icon('check', 16) : nothing}
          </li>`,
        )}
      </ul>
      ${this.invalid
        ? html`<p class="error" id="${this.#id}-msg">${this.invalidText}</p>`
        : this.helperText
          ? html`<p class="helper" id="${this.#id}-help">${this.helperText}</p>`
          : nothing}
      <slot></slot>
    </div>`
  }
}
