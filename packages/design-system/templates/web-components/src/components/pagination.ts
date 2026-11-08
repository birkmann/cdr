import { LitElement, css, html } from 'lit'
import { base, emit, type, uid } from '../base.js'
import { icon } from '../icons.js'

/**
 * Pages through a long list: page size, current range, page select, previous / next.
 * @element __P__-pagination
 * @fires __P__-page-change - detail { page, pageSize }
 */
export class Pagination extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        display: block;
      }
      .bar {
        ${type('body-compact-01')}
        display: flex;
        align-items: center;
        min-height: var(--__P__-size-md);
        background: var(--__P__-layer-01);
        border-top: 1px solid var(--__P__-border-subtle-01);
        color: var(--__P__-text-primary);
        flex-wrap: wrap;
      }
      .group {
        display: flex;
        align-items: center;
        gap: var(--__P__-spacing-03);
        padding: 0 var(--__P__-spacing-05);
        min-height: var(--__P__-size-md);
      }
      .spacer {
        flex: 1;
      }
      select {
        ${type('body-compact-01')}
        height: var(--__P__-size-md);
        padding: 0 var(--__P__-spacing-05);
        border: 0;
        background: transparent;
        color: var(--__P__-text-primary);
        cursor: pointer;
      }
      select:hover {
        background: var(--__P__-layer-01-hover);
      }
      select:focus-visible,
      button:focus-visible {
        outline: 2px solid var(--__P__-focus);
        outline-offset: -2px;
      }
      button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--__P__-size-md);
        height: var(--__P__-size-md);
        border: 0;
        border-left: 1px solid var(--__P__-border-subtle-01);
        background: transparent;
        color: var(--__P__-icon-primary);
        cursor: pointer;
      }
      button:hover:not(:disabled) {
        background: var(--__P__-layer-01-hover);
      }
      button:disabled {
        color: var(--__P__-icon-disabled);
        cursor: not-allowed;
      }
      .muted {
        color: var(--__P__-text-secondary);
      }
    `,
  ]
  static override properties = {
    page: { type: Number, reflect: true },
    pageSize: { type: Number, attribute: 'page-size', reflect: true },
    totalItems: { type: Number, attribute: 'total-items' },
    pageSizes: { type: String, attribute: 'page-sizes' },
    disabled: { type: Boolean, reflect: true },
  }
  /** 1-based */
  declare page: number
  declare pageSize: number
  declare totalItems: number
  /** comma-separated, e.g. "10,20,50" */
  declare pageSizes: string
  declare disabled: boolean
  #id = uid('pagination')
  constructor() {
    super()
    this.page = 1
    this.pageSize = 10
    this.totalItems = 0
    this.pageSizes = '10,20,30,50'
    this.disabled = false
  }
  get totalPages(): number {
    return Math.max(1, Math.ceil(this.totalItems / Math.max(1, this.pageSize)))
  }
  #go(page: number, pageSize = this.pageSize) {
    const p = Math.max(1, Math.min(Math.max(1, Math.ceil(this.totalItems / Math.max(1, pageSize))), page))
    if (p === this.page && pageSize === this.pageSize) return
    this.page = p
    this.pageSize = pageSize
    emit(this, 'page-change', { page: p, pageSize })
  }
  override render() {
    const sizes = this.pageSizes
      .split(',')
      .map((s) => parseInt(s, 10))
      .filter((n) => n > 0)
    const from = this.totalItems ? (this.page - 1) * this.pageSize + 1 : 0
    const to = Math.min(this.totalItems, this.page * this.pageSize)
    const pages = Array.from({ length: this.totalPages }, (_, i) => i + 1)
    return html`<nav class="bar" aria-label="Pagination">
      <div class="group">
        <label class="muted" for="${this.#id}-size">Items per page:</label>
        <select
          id="${this.#id}-size"
          ?disabled=${this.disabled}
          @change=${(e: Event) => this.#go(1, parseInt((e.target as HTMLSelectElement).value, 10))}
        >
          ${sizes.map((n) => html`<option value=${n} ?selected=${n === this.pageSize}>${n}</option>`)}
        </select>
        <span aria-live="polite">${from}–${to} of ${this.totalItems} items</span>
      </div>
      <span class="spacer"></span>
      <div class="group">
        <select
          aria-label="Page number"
          ?disabled=${this.disabled}
          @change=${(e: Event) => this.#go(parseInt((e.target as HTMLSelectElement).value, 10))}
        >
          ${pages.map((n) => html`<option value=${n} ?selected=${n === this.page}>${n}</option>`)}
        </select>
        <span class="muted">of ${this.totalPages} pages</span>
      </div>
      <button type="button" aria-label="Previous page" ?disabled=${this.disabled || this.page <= 1} @click=${() => this.#go(this.page - 1)}>
        ${icon('chevron-left', 16)}
      </button>
      <button
        type="button"
        aria-label="Next page"
        ?disabled=${this.disabled || this.page >= this.totalPages}
        @click=${() => this.#go(this.page + 1)}
      >
        ${icon('chevron-right', 16)}
      </button>
    </nav>`
  }
}
