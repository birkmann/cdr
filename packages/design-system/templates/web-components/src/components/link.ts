import { LitElement, css, html, nothing } from 'lit'
import { base, type } from '../base.js'

/**
 * Navigates to another page or place. Disabled links are not focusable and do not navigate.
 * @element __P__-link
 * @slot - the link text
 * @csspart link - the native link
 */
export class Link extends LitElement {
  static override shadowRootOptions = { ...LitElement.shadowRootOptions, delegatesFocus: true }
  static override styles = [
    base,
    css`
      :host {
        display: inline;
      }
      a {
        ${type('body-compact-01')}
        color: var(--__P__-link-primary);
        text-decoration: none;
        outline: none;
      }
      :host([size='lg']) a {
        ${type('body-compact-02')}
      }
      :host([inline]) a {
        font: inherit;
        text-decoration: underline;
      }
      a:hover {
        color: var(--__P__-link-primary-hover);
        text-decoration: underline;
      }
      a:visited {
        color: var(--__P__-link-primary);
      }
      :host([visited]) a:visited {
        color: var(--__P__-link-visited);
      }
      a:focus-visible {
        outline: 1px solid var(--__P__-focus);
        outline-offset: 1px;
      }
      a[aria-disabled='true'] {
        color: var(--__P__-text-disabled);
        text-decoration: none;
        cursor: not-allowed;
      }
    `,
  ]
  static override properties = {
    href: { type: String, reflect: true },
    target: { type: String },
    inline: { type: Boolean, reflect: true },
    visited: { type: Boolean, reflect: true },
    disabled: { type: Boolean, reflect: true },
    size: { type: String, reflect: true },
  }
  declare href: string
  declare target?: string
  /** inside running text: inherits the text style and is underlined */
  declare inline: boolean
  /** show visited links in the visited colour */
  declare visited: boolean
  declare disabled: boolean
  declare size: 'sm' | 'md' | 'lg'
  constructor() {
    super()
    this.href = ''
    this.inline = false
    this.visited = false
    this.disabled = false
    this.size = 'md'
  }
  override render() {
    return html`<a
      part="link"
      href=${this.disabled ? nothing : this.href}
      target=${this.target ?? nothing}
      rel=${this.target === '_blank' ? 'noopener noreferrer' : nothing}
      aria-disabled=${this.disabled ? 'true' : nothing}
      role=${this.disabled ? 'link' : nothing}
      ><slot></slot
    ></a>`
  }
}
