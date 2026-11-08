import { LitElement, css, html, nothing } from 'lit'
import { base, type } from '../base.js'

/**
 * One step of a breadcrumb. The last one with `current` is the page the user is on.
 * @element __P__-breadcrumb-item
 * @slot - the text
 */
export class BreadcrumbItem extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        display: inline-flex;
        align-items: center;
        ${type('body-compact-01')}
      }
      :host(:not(:last-of-type))::after {
        content: '/';
        margin: 0 var(--__P__-spacing-03);
        color: var(--__P__-text-secondary);
      }
      a {
        color: var(--__P__-link-primary);
        text-decoration: none;
      }
      a:hover {
        text-decoration: underline;
        color: var(--__P__-link-primary-hover);
      }
      a:focus-visible {
        outline: 1px solid var(--__P__-focus);
      }
      span[aria-current] {
        color: var(--__P__-text-primary);
      }
    `,
  ]
  static override properties = {
    href: { type: String },
    current: { type: Boolean, reflect: true },
  }
  declare href?: string
  declare current: boolean
  constructor() {
    super()
    this.current = false
  }
  override connectedCallback() {
    super.connectedCallback()
    this.setAttribute('role', 'listitem')
  }
  override render() {
    return this.href && !this.current
      ? html`<a href=${this.href}><slot></slot></a>`
      : html`<span aria-current=${this.current ? 'page' : nothing}><slot></slot></span>`
  }
}

/**
 * Where the current page sits in the site hierarchy.
 * @element __P__-breadcrumb
 * @slot - `__P__-breadcrumb-item` elements
 */
export class Breadcrumb extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }
    [role='list'] {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      margin: 0;
      padding: 0;
    }
  `
  static override properties = { label: { type: String } }
  /** accessible name of the navigation landmark */
  declare label: string
  constructor() {
    super()
    this.label = 'Breadcrumb'
  }
  override render() {
    return html`<nav aria-label=${this.label}><div role="list"><slot></slot></div></nav>`
  }
}
