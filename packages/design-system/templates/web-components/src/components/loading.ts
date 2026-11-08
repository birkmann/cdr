import { LitElement, css, html } from 'lit'
import { base } from '../base.js'

/**
 * A spinner for work in progress (`role="status"` with a label).
 * @element __P__-loading
 */
export class Loading extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        display: inline-flex;
      }
      svg {
        width: 5.5rem;
        height: 5.5rem;
        animation: spin 690ms linear infinite;
      }
      :host([size='small']) svg {
        width: 1rem;
        height: 1rem;
      }
      circle {
        fill: none;
        stroke-width: 10;
        stroke-linecap: round;
      }
      .bg {
        stroke: var(--__P__-layer-accent-01);
      }
      .fg {
        stroke: var(--__P__-interactive);
        stroke-dasharray: 276;
        stroke-dashoffset: 200;
      }
      :host([size='small']) circle {
        stroke-width: 14;
      }
      :host(:not([active])) {
        display: none;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        svg {
          animation-duration: 3s;
        }
      }
    `,
  ]
  static override properties = {
    size: { type: String, reflect: true },
    description: { type: String },
    active: { type: Boolean, reflect: true },
  }
  /** small | large */
  declare size: 'small' | 'large'
  /** accessible label */
  declare description: string
  declare active: boolean
  constructor() {
    super()
    this.size = 'large'
    this.description = 'Loading'
    this.active = true
  }
  override render() {
    return html`<span role="status" aria-label=${this.description} aria-live="polite">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle class="bg" cx="50" cy="50" r="44"></circle>
        <circle class="fg" cx="50" cy="50" r="44"></circle>
      </svg>
    </span>`
  }
}
