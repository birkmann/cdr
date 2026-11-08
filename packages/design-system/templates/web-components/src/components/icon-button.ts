import { LitElement, css, html } from 'lit'
import { base } from '../base.js'
import { icon, type IconName } from '../icons.js'

/**
 * A button with only an icon. `label` is required: it is the accessible name and the tooltip.
 * @element __P__-icon-button
 * @csspart button - the native button
 */
export class IconButton extends LitElement {
  static override shadowRootOptions = { ...LitElement.shadowRootOptions, delegatesFocus: true }
  static override styles = [
    base,
    css`
      :host {
        display: inline-flex;
      }
      button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--__P__-size-md);
        height: var(--__P__-size-md);
        padding: 0;
        border: 1px solid transparent;
        border-radius: var(--__P__-radius-control);
        background: transparent;
        color: var(--__P__-icon-primary);
        cursor: pointer;
      }
      button:hover {
        background: var(--__P__-layer-01-hover);
      }
      :host([kind='primary']) button {
        background: var(--__P__-button-primary);
        color: var(--__P__-button-primary-text);
      }
      :host([kind='primary']) button:hover {
        background: var(--__P__-button-primary-hover);
      }
      :host([kind='secondary']) button {
        background: var(--__P__-button-secondary);
        color: var(--__P__-button-secondary-text);
      }
      :host([size='sm']) button {
        width: var(--__P__-size-sm);
        height: var(--__P__-size-sm);
      }
      :host([size='lg']) button {
        width: var(--__P__-size-lg);
        height: var(--__P__-size-lg);
      }
      button:focus-visible {
        outline: 2px solid var(--__P__-focus);
        outline-offset: -2px;
      }
      button:disabled {
        color: var(--__P__-icon-disabled);
        background: transparent;
        cursor: not-allowed;
      }
    `,
  ]
  static override properties = {
    label: { type: String },
    icon: { type: String },
    kind: { type: String, reflect: true },
    size: { type: String, reflect: true },
    disabled: { type: Boolean, reflect: true },
  }
  /** accessible name and tooltip (required) */
  declare label: string
  declare icon: IconName
  /** ghost | primary | secondary */
  declare kind: 'ghost' | 'primary' | 'secondary'
  declare size: 'sm' | 'md' | 'lg'
  declare disabled: boolean
  constructor() {
    super()
    this.label = ''
    this.icon = 'overflow'
    this.kind = 'ghost'
    this.size = 'md'
    this.disabled = false
  }
  override render() {
    return html`<button part="button" type="button" aria-label=${this.label} title=${this.label} ?disabled=${this.disabled}>
      ${icon(this.icon, this.size === 'lg' ? 20 : 16)}
    </button>`
  }
}
