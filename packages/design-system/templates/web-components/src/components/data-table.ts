import { LitElement, css, html, nothing } from 'lit'
import { base, emit, type } from '../base.js'
import { icon } from '../icons.js'

export interface TableColumn {
  key: string
  header: string
  sortable?: boolean
  /** start | end (numbers) */
  align?: 'start' | 'end'
}
export type TableRow = Record<string, string | number | boolean | null | undefined> & { id?: string | number }

/**
 * A data table from `columns` and `rows` (properties). Sortable headers set `aria-sort`.
 * @element __P__-data-table
 * @fires __P__-sort - detail { key, direction: "ascending" | "descending" | "none" }
 */
export class DataTable extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        display: block;
        max-width: 100%;
        overflow-x: auto;
      }
      .head {
        padding: var(--__P__-spacing-05) var(--__P__-spacing-05) var(--__P__-spacing-06);
        background: var(--__P__-layer-01);
      }
      .title {
        ${type('heading-03')}
        margin: 0;
      }
      .description {
        ${type('body-compact-01')}
        color: var(--__P__-text-secondary);
        margin: var(--__P__-spacing-02) 0 0;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        ${type('body-compact-01')}
      }
      th {
        ${type('heading-compact-01')}
        height: var(--__P__-size-lg);
        padding: 0 var(--__P__-spacing-05);
        background: var(--__P__-layer-accent-01);
        color: var(--__P__-text-primary);
        text-align: left;
        white-space: nowrap;
      }
      th[data-align='end'],
      td[data-align='end'] {
        text-align: right;
      }
      th.sortable {
        padding: 0;
      }
      th button {
        ${type('heading-compact-01')}
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--__P__-spacing-03);
        width: 100%;
        height: var(--__P__-size-lg);
        padding: 0 var(--__P__-spacing-05);
        border: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
        text-align: inherit;
      }
      th button:hover {
        background: var(--__P__-layer-01-active);
      }
      th button:focus-visible {
        outline: 2px solid var(--__P__-focus);
        outline-offset: -2px;
      }
      .sort {
        display: inline-flex;
        opacity: 0;
      }
      th button:hover .sort,
      th[aria-sort] .sort {
        opacity: 1;
      }
      td {
        height: var(--__P__-size-lg);
        padding: 0 var(--__P__-spacing-05);
        background: var(--__P__-layer-01);
        color: var(--__P__-text-secondary);
        border-top: 1px solid var(--__P__-border-subtle-01);
      }
      :host([size='sm']) th,
      :host([size='sm']) td,
      :host([size='sm']) th button {
        height: var(--__P__-size-sm);
      }
      :host([size='md']) th,
      :host([size='md']) td,
      :host([size='md']) th button {
        height: var(--__P__-size-md);
      }
      tbody tr:hover td {
        background: var(--__P__-layer-01-hover);
        color: var(--__P__-text-primary);
      }
      :host([zebra]) tbody tr:nth-child(even) td {
        background: var(--__P__-layer-02);
      }
      .empty {
        text-align: center;
        color: var(--__P__-text-secondary);
      }
    `,
  ]
  static override properties = {
    columns: { type: Array },
    rows: { type: Array },
    heading: { type: String },
    description: { type: String },
    size: { type: String, reflect: true },
    zebra: { type: Boolean, reflect: true },
    sortKey: { type: String, attribute: 'sort-key' },
    sortDirection: { type: String, attribute: 'sort-direction' },
    emptyText: { type: String, attribute: 'empty-text' },
  }
  declare columns: TableColumn[]
  declare rows: TableRow[]
  declare heading: string
  declare description: string
  /** sm | md | lg */
  declare size: 'sm' | 'md' | 'lg'
  declare zebra: boolean
  declare sortKey: string
  /** ascending | descending | none */
  declare sortDirection: 'ascending' | 'descending' | 'none'
  declare emptyText: string
  constructor() {
    super()
    this.columns = []
    this.rows = []
    this.heading = ''
    this.description = ''
    this.size = 'lg'
    this.zebra = false
    this.sortKey = ''
    this.sortDirection = 'none'
    this.emptyText = 'No data'
  }
  /** The rows in display order. */
  get sortedRows(): TableRow[] {
    if (!this.sortKey || this.sortDirection === 'none') return this.rows
    const k = this.sortKey
    const dir = this.sortDirection === 'ascending' ? 1 : -1
    return [...this.rows].sort((a, b) => {
      const x = a[k],
        y = b[k]
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir
      return String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true }) * dir
    })
  }
  #sort(key: string) {
    const next = this.sortKey !== key ? 'ascending' : this.sortDirection === 'ascending' ? 'descending' : this.sortDirection === 'descending' ? 'none' : 'ascending'
    this.sortKey = next === 'none' ? '' : key
    this.sortDirection = next
    emit(this, 'sort', { key, direction: next })
  }
  override render() {
    const titleId = 'table-title'
    return html`${this.heading || this.description
        ? html`<div class="head">
            ${this.heading ? html`<h3 class="title" id=${titleId}>${this.heading}</h3>` : nothing}
            ${this.description ? html`<p class="description">${this.description}</p>` : nothing}
          </div>`
        : nothing}
      <table aria-labelledby=${this.heading ? titleId : nothing}>
        <thead>
          <tr>
            ${this.columns.map((c) => {
              const active = this.sortKey === c.key && this.sortDirection !== 'none'
              if (!c.sortable) return html`<th scope="col" data-align=${c.align ?? 'start'}>${c.header}</th>`
              return html`<th class="sortable" scope="col" data-align=${c.align ?? 'start'} aria-sort=${active ? this.sortDirection : nothing}>
                <button type="button" @click=${() => this.#sort(c.key)}>
                  ${c.header}<span class="sort"
                    >${icon(active ? (this.sortDirection === 'ascending' ? 'arrow-up' : 'arrow-down') : 'arrows-vertical', 16)}</span
                  >
                </button>
              </th>`
            })}
          </tr>
        </thead>
        <tbody>
          ${this.rows.length
            ? this.sortedRows.map(
                (r) => html`<tr>
                  ${this.columns.map((c) => html`<td data-align=${c.align ?? 'start'}>${r[c.key] ?? ''}</td>`)}
                </tr>`,
              )
            : html`<tr>
                <td class="empty" .colSpan=${this.columns.length || 1}>${this.emptyText}</td>
              </tr>`}
        </tbody>
      </table>`
  }
}
