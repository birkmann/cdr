import { css, html, nothing } from 'lit'
import { base, emit, emitChange, fieldStyles, uid } from '../base.js'
import { FormControl } from '../form.js'
import { icon } from '../icons.js'

/**
 * A search field: Enter searches, Esc or the clear button empties it.
 * @element __P__-search
 * @fires input - while typing
 * @fires __P__-search - on Enter, detail { value }
 * @fires __P__-clear - when cleared
 * @csspart input - the native input
 */
export class Search extends FormControl {
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
      .magnifier {
        position: absolute;
        left: var(--__P__-spacing-05);
        display: inline-flex;
        color: var(--__P__-icon-secondary);
        pointer-events: none;
      }
      input.control {
        padding-left: var(--__P__-spacing-09);
        padding-right: var(--__P__-spacing-09);
      }
      input::-webkit-search-cancel-button {
        display: none;
      }
      .clear {
        position: absolute;
        right: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--__P__-size-md);
        height: 100%;
        border: 0;
        background: transparent;
        color: var(--__P__-icon-primary);
        cursor: pointer;
      }
      .clear:hover {
        background: var(--__P__-field-hover);
      }
      .clear:focus-visible {
        outline: 2px solid var(--__P__-focus);
        outline-offset: -2px;
      }
    `,
  ]
  static override properties = {
    ...FormControl.properties,
    label: { type: String },
    placeholder: { type: String },
    value: { type: String },
    size: { type: String, reflect: true },
  }
  /** accessible name (shown only to assistive technology) */
  declare label: string
  declare placeholder: string
  declare value: string
  declare size: 'sm' | 'md' | 'lg'
  #id = uid('search')
  constructor() {
    super()
    this.label = 'Search'
    this.placeholder = 'Search'
    this.value = ''
    this.size = 'md'
  }
  protected formValue() {
    return this.value
  }
  formResetCallback() {
    this.value = ''
  }
  #clear() {
    if (!this.value) return
    this.value = ''
    emit(this, 'clear', {})
    emitChange(this)
    this.renderRoot.querySelector('input')?.focus()
  }
  #onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      this.#clear()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      emit(this, 'search', { value: this.value })
    }
  }
  override render() {
    return html`<div class="wrap" role="search">
      <label class="visually-hidden" for=${this.#id}>${this.label}</label>
      <span class="magnifier">${icon('search', 16)}</span>
      <input
        part="input"
        class="control"
        id=${this.#id}
        type="search"
        .value=${this.value}
        name=${this.name || nothing}
        placeholder=${this.placeholder}
        ?disabled=${this.disabled}
        autocomplete="off"
        @input=${(e: Event) => (this.value = (e.target as HTMLInputElement).value)}
        @change=${() => emitChange(this)}
        @keydown=${this.#onKey}
      />
      ${this.value && !this.disabled
        ? html`<button class="clear" type="button" aria-label="Clear search" @click=${this.#clear}>${icon('close', 16)}</button>`
        : nothing}
    </div>`
  }
}
