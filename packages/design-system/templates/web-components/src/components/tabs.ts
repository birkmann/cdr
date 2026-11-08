import { LitElement, css, html } from 'lit'
import { base, emit, type, uid } from '../base.js'

/**
 * One view of a tab set: its `label` becomes the tab, its content the panel.
 * @element __P__-tab
 * @slot - the panel content
 */
export class Tab extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }
  `
  static override properties = {
    value: { type: String, reflect: true },
    label: { type: String, reflect: true },
    disabled: { type: Boolean, reflect: true },
  }
  declare value: string
  declare label: string
  declare disabled: boolean
  constructor() {
    super()
    this.value = ''
    this.label = ''
    this.disabled = false
  }
  override render() {
    return html`<slot></slot>`
  }
}

/**
 * Tabs (APG, automatic activation): ← → move and select, Home / End jump; one Tab stop for the tab list.
 * @element __P__-tabs
 * @slot - `__P__-tab` elements
 * @fires __P__-change - when the selected tab changed, detail { value }
 */
export class Tabs extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        display: block;
      }
      [role='tablist'] {
        display: flex;
        overflow-x: auto;
        scrollbar-width: none;
        box-shadow: inset 0 -1px 0 var(--__P__-border-subtle-01);
      }
      [role='tab'] {
        ${type('body-compact-01')}
        flex: 0 0 auto;
        min-height: var(--__P__-size-md);
        padding: 0 var(--__P__-spacing-05);
        border: 0;
        border-bottom: 2px solid var(--__P__-border-subtle-01);
        background: transparent;
        color: var(--__P__-text-secondary);
        cursor: pointer;
        white-space: nowrap;
      }
      [role='tab']:hover {
        color: var(--__P__-text-primary);
        border-bottom-color: var(--__P__-border-strong-01);
      }
      [role='tab'][aria-selected='true'] {
        ${type('heading-compact-01')}
        color: var(--__P__-text-primary);
        border-bottom-color: var(--__P__-border-interactive);
      }
      [role='tab']:focus-visible {
        outline: 2px solid var(--__P__-focus);
        outline-offset: -2px;
      }
      [role='tab'][aria-disabled='true'] {
        color: var(--__P__-text-disabled);
        border-bottom-color: var(--__P__-border-disabled);
        cursor: not-allowed;
      }
      :host([type='contained']) [role='tab'] {
        background: var(--__P__-layer-accent-01);
        border-bottom: 0;
        border-top: 2px solid transparent;
        min-height: var(--__P__-size-lg);
      }
      :host([type='contained']) [role='tab'][aria-selected='true'] {
        background: var(--__P__-layer-01);
        border-top-color: var(--__P__-border-interactive);
      }
      [role='tabpanel'] {
        padding: var(--__P__-spacing-05) 0;
      }
      [role='tabpanel']:focus-visible {
        outline: 2px solid var(--__P__-focus);
      }
    `,
  ]
  static override properties = {
    value: { type: String, reflect: true },
    label: { type: String },
    type: { type: String, reflect: true },
  }
  /** value of the selected tab (default: the first enabled one) */
  declare value: string
  /** accessible name of the tab list */
  declare label: string
  /** line | contained */
  declare type: 'line' | 'contained'
  #id = uid('tabs')
  constructor() {
    super()
    this.value = ''
    this.label = ''
    this.type = 'line'
  }
  get tabs(): Tab[] {
    return [...this.querySelectorAll<Tab>(':scope > __P__-tab')]
  }
  #valueOf(t: Tab, i: number) {
    return t.value || String(i)
  }
  #select(i: number, focus: boolean) {
    const t = this.tabs[i]
    if (!t || t.disabled) return
    const v = this.#valueOf(t, i)
    const changed = v !== this.value
    this.value = v
    if (focus) this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>(`#${this.#id}-tab-${i}`)?.focus())
    if (changed) emit(this, 'change', { value: v })
  }
  #onKey(e: KeyboardEvent) {
    const tabs = this.tabs
    const enabled = tabs.map((t, i) => (t.disabled ? -1 : i)).filter((i) => i >= 0)
    const cur = enabled.indexOf(tabs.findIndex((t, i) => this.#valueOf(t, i) === this.value))
    let next: number | undefined
    if (e.key === 'ArrowRight') next = enabled[(cur + 1) % enabled.length]
    else if (e.key === 'ArrowLeft') next = enabled[(cur - 1 + enabled.length) % enabled.length]
    else if (e.key === 'Home') next = enabled[0]
    else if (e.key === 'End') next = enabled[enabled.length - 1]
    if (next === undefined) return
    e.preventDefault()
    this.#select(next, true)
  }
  protected override willUpdate() {
    const tabs = this.tabs
    if (!tabs.some((t, i) => this.#valueOf(t, i) === this.value && !t.disabled)) {
      const first = tabs.findIndex((t) => !t.disabled)
      if (first >= 0) this.value = this.#valueOf(tabs[first]!, first)
    }
    tabs.forEach((t, i) => (t.slot = `panel-${i}`))
  }
  override render() {
    const tabs = this.tabs
    return html`<div role="tablist" aria-label=${this.label} @keydown=${this.#onKey}>
        ${tabs.map((t, i) => {
          const sel = this.#valueOf(t, i) === this.value
          return html`<button
            role="tab"
            type="button"
            id="${this.#id}-tab-${i}"
            aria-selected=${sel ? 'true' : 'false'}
            aria-controls="${this.#id}-panel-${i}"
            aria-disabled=${t.disabled ? 'true' : 'false'}
            tabindex=${sel ? '0' : '-1'}
            @click=${() => this.#select(i, false)}
          >
            ${t.label}
          </button>`
        })}
      </div>
      ${tabs.map((t, i) => {
        const sel = this.#valueOf(t, i) === this.value
        return html`<div role="tabpanel" id="${this.#id}-panel-${i}" aria-labelledby="${this.#id}-tab-${i}" tabindex="0" ?hidden=${!sel}>
          <slot name="panel-${i}"></slot>
        </div>`
      })}
      <slot @slotchange=${() => this.requestUpdate()} hidden></slot>`
  }
}
