import { LitElement, css, html } from 'lit'
import { base, emit, type, uid } from '../base.js'
import { icon } from '../icons.js'

/**
 * One section of an accordion: a heading button (`aria-expanded`) and its region.
 * @element __P__-accordion-item
 * @slot - the content
 * @fires __P__-toggle - when opened or closed by the user, detail { open }
 */
export class AccordionItem extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        display: block;
        border-top: 1px solid var(--__P__-border-subtle-01);
      }
      h3 {
        margin: 0;
      }
      button {
        ${type('body-compact-01')}
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--__P__-spacing-05);
        width: 100%;
        min-height: var(--__P__-size-md);
        padding: 0 var(--__P__-spacing-05);
        border: 0;
        background: transparent;
        color: var(--__P__-text-primary);
        text-align: left;
        cursor: pointer;
      }
      :host([align='start']) button {
        flex-direction: row-reverse;
        justify-content: flex-end;
      }
      button:hover {
        background: var(--__P__-layer-01-hover);
      }
      button:focus-visible {
        outline: 2px solid var(--__P__-focus);
        outline-offset: -2px;
      }
      .chevron {
        display: inline-flex;
        transition: transform var(--__P__-duration-fast-02) var(--__P__-easing-standard-productive);
      }
      :host([open]) .chevron {
        transform: rotate(180deg);
      }
      .region {
        ${type('body-01')}
        padding: var(--__P__-spacing-03) var(--__P__-spacing-05) var(--__P__-spacing-06);
      }
      :host([disabled]) button {
        color: var(--__P__-text-disabled);
        cursor: not-allowed;
      }
    `,
  ]
  static override properties = {
    title: { type: String },
    open: { type: Boolean, reflect: true },
    disabled: { type: Boolean, reflect: true },
    align: { type: String, reflect: true },
  }
  /** the heading text */
  declare title: string
  declare open: boolean
  declare disabled: boolean
  /** end (chevron at the end) | start */
  declare align: 'start' | 'end'
  #id = uid('accordion')
  constructor() {
    super()
    this.title = ''
    this.open = false
    this.disabled = false
    this.align = 'end'
  }
  override connectedCallback() {
    super.connectedCallback()
    // the heading text is rendered inside; keep the native tooltip off
    if (this.hasAttribute('title')) {
      this.title = this.getAttribute('title') ?? ''
      this.removeAttribute('title')
    }
  }
  toggle() {
    if (this.disabled) return
    this.open = !this.open
    emit(this, 'toggle', { open: this.open })
  }
  override render() {
    return html`<h3>
        <button
          type="button"
          id="${this.#id}-button"
          aria-expanded=${this.open ? 'true' : 'false'}
          aria-controls="${this.#id}-region"
          aria-disabled=${this.disabled ? 'true' : 'false'}
          @click=${() => this.toggle()}
        >
          <span>${this.title}</span><span class="chevron">${icon('chevron-down', 16)}</span>
        </button>
      </h3>
      <div class="region" id="${this.#id}-region" role="region" aria-labelledby="${this.#id}-button" ?hidden=${!this.open}>
        <slot></slot>
      </div>`
  }
}

/**
 * Stacked, collapsible sections. With `single`, opening one closes the others.
 * @element __P__-accordion
 * @slot - `__P__-accordion-item` elements
 */
export class Accordion extends LitElement {
  static override styles = css`
    :host {
      display: block;
      border-bottom: 1px solid var(--__P__-border-subtle-01);
    }
  `
  static override properties = {
    single: { type: Boolean, reflect: true },
    align: { type: String, reflect: true },
  }
  declare single: boolean
  declare align: 'start' | 'end'
  constructor() {
    super()
    this.single = false
    this.align = 'end'
    this.addEventListener('__P__-toggle', (e) => {
      const item = e.target as AccordionItem
      if (!this.single || !(e as CustomEvent<{ open: boolean }>).detail.open) return
      for (const other of this.querySelectorAll<AccordionItem>('__P__-accordion-item')) if (other !== item) other.open = false
    })
  }
  protected override updated() {
    for (const i of this.querySelectorAll<AccordionItem>('__P__-accordion-item')) if (!i.hasAttribute('align')) i.align = this.align
  }
  override render() {
    return html`<slot></slot>`
  }
}
