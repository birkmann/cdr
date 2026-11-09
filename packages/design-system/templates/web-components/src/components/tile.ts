import { LitElement, css, html, nothing } from 'lit'
import { base, emitChange, type } from '../base.js'
import { icon } from '../icons.js'

/**
 * A container for related content: static, clickable (a link) or selectable (checkbox semantics).
 * @element __P__-tile
 * @slot - the content
 * @fires change - selectable tiles, when the selection changed
 */
export class Tile extends LitElement {
  static override shadowRootOptions: ShadowRootInit = { ...LitElement.shadowRootOptions, delegatesFocus: true }
  static override styles = [
    base,
    css`
      :host {
        display: block;
      }
      .tile {
        ${type('body-01')}
        position: relative;
        display: block;
        min-height: var(--__P__-dim-4rem);
        padding: var(--__P__-spacing-05);
        background: var(--__P__-layer-01);
        color: var(--__P__-text-primary);
        border-radius: var(--__P__-radius-container);
        text-decoration: none;
        outline: none;
        border: 1px solid transparent;
        transition: background-color var(--__P__-duration-fast-01) var(--__P__-easing-standard-productive);
      }
      a.tile:hover,
      .tile[role='checkbox']:hover {
        background: var(--__P__-layer-01-hover);
        cursor: pointer;
      }
      .tile:focus-visible {
        outline: 2px solid var(--__P__-focus);
        outline-offset: -2px;
      }
      .tile[aria-checked='true'] {
        border-color: var(--__P__-border-interactive);
      }
      .check {
        position: absolute;
        top: var(--__P__-spacing-05);
        right: var(--__P__-spacing-05);
        display: inline-flex;
        width: var(--__P__-dim-1rem);
        height: var(--__P__-dim-1rem);
        border: 1px solid var(--__P__-icon-secondary);
        border-radius: 2px;
        color: var(--__P__-icon-on-color);
      }
      .tile[aria-checked='true'] .check {
        background: var(--__P__-icon-primary);
        border-color: var(--__P__-icon-primary);
        color: var(--__P__-background);
      }
      .arrow {
        position: absolute;
        right: var(--__P__-spacing-05);
        bottom: var(--__P__-spacing-05);
        color: var(--__P__-icon-primary);
        display: inline-flex;
      }
      :host([disabled]) .tile {
        color: var(--__P__-text-disabled);
        cursor: not-allowed;
      }
    `,
  ]
  static override properties = {
    variant: { type: String, reflect: true },
    href: { type: String },
    selected: { type: Boolean, reflect: true },
    disabled: { type: Boolean, reflect: true },
    label: { type: String },
  }
  /** static | clickable | selectable */
  declare variant: 'static' | 'clickable' | 'selectable'
  declare href?: string
  declare selected: boolean
  declare disabled: boolean
  /** accessible name of a selectable tile (default: its text) */
  declare label?: string
  constructor() {
    super()
    this.variant = 'static'
    this.selected = false
    this.disabled = false
  }
  toggle() {
    if (this.disabled || this.variant !== 'selectable') return
    this.selected = !this.selected
    emitChange(this)
  }
  override render() {
    if (this.variant === 'clickable')
      return html`<a class="tile" href=${this.disabled ? nothing : (this.href ?? '#')} aria-disabled=${this.disabled ? 'true' : nothing}
        ><slot></slot><span class="arrow">${icon('chevron-right', 16)}</span></a
      >`
    if (this.variant === 'selectable')
      return html`<div
        class="tile"
        role="checkbox"
        aria-checked=${this.selected ? 'true' : 'false'}
        aria-disabled=${this.disabled ? 'true' : 'false'}
        aria-label=${this.label ?? nothing}
        tabindex=${this.disabled ? '-1' : '0'}
        @click=${() => this.toggle()}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault()
            this.toggle()
          }
        }}
      >
        <slot></slot><span class="check">${this.selected ? icon('check', 14) : nothing}</span>
      </div>`
    return html`<div class="tile"><slot></slot></div>`
  }
}
