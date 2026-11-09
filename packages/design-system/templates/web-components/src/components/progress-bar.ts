import { LitElement, css, html, nothing } from 'lit'
import { base, type, uid } from '../base.js'
import { icon } from '../icons.js'

/**
 * How far a task has got (`role="progressbar"`); `indeterminate` when that is unknown.
 * @element __P__-progress-bar
 */
export class ProgressBar extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        display: block;
      }
      .top {
        display: flex;
        justify-content: space-between;
        align-items: center;
        ${type('body-compact-01')}
        margin-bottom: var(--__P__-spacing-03);
      }
      .track {
        position: relative;
        height: var(--__P__-dim-0-5rem);
        overflow: hidden;
        background: var(--__P__-layer-accent-01);
        border-radius: var(--__P__-radius-pill);
      }
      :host([size='small']) .track {
        height: var(--__P__-dim-0-25rem);
      }
      .bar {
        height: 100%;
        background: var(--__P__-interactive);
        border-radius: inherit;
        transition: width var(--__P__-duration-moderate-01) var(--__P__-easing-standard-productive);
      }
      :host([status='finished']) .bar {
        background: var(--__P__-support-success);
      }
      :host([status='error']) .bar {
        background: var(--__P__-support-error);
        width: 100% !important;
      }
      :host([indeterminate]) .bar {
        position: absolute;
        width: 40% !important;
        animation: slide 1.4s var(--__P__-easing-standard-productive) infinite;
      }
      @keyframes slide {
        from {
          left: -40%;
        }
        to {
          left: 100%;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        :host([indeterminate]) .bar {
          animation: none;
          left: 30%;
        }
      }
      .helper {
        ${type('helper-text-01')}
        color: var(--__P__-text-helper);
        margin: var(--__P__-spacing-03) 0 0;
      }
      :host([status='error']) .helper {
        color: var(--__P__-text-error);
      }
      .status-icon {
        display: inline-flex;
      }
      :host([status='finished']) .status-icon {
        color: var(--__P__-support-success);
      }
      :host([status='error']) .status-icon {
        color: var(--__P__-support-error);
      }
    `,
  ]
  static override properties = {
    value: { type: Number },
    max: { type: Number },
    label: { type: String },
    helperText: { type: String, attribute: 'helper-text' },
    status: { type: String, reflect: true },
    indeterminate: { type: Boolean, reflect: true },
    size: { type: String, reflect: true },
    hideLabel: { type: Boolean, attribute: 'hide-label' },
  }
  declare value: number
  declare max: number
  declare label: string
  declare helperText: string
  /** active | finished | error */
  declare status: 'active' | 'finished' | 'error'
  declare indeterminate: boolean
  /** small | big */
  declare size: 'small' | 'big'
  declare hideLabel: boolean
  #id = uid('progress')
  constructor() {
    super()
    this.value = 0
    this.max = 100
    this.label = ''
    this.helperText = ''
    this.status = 'active'
    this.indeterminate = false
    this.size = 'big'
    this.hideLabel = false
  }
  override render() {
    const pct = this.max > 0 ? Math.max(0, Math.min(100, (this.value / this.max) * 100)) : 0
    const busy = this.status === 'active'
    return html`<div class="top ${this.hideLabel ? 'visually-hidden' : ''}">
        <span id="${this.#id}-label">${this.label}</span>
        ${this.status === 'finished'
          ? html`<span class="status-icon">${icon('success', 16, 'Finished')}</span>`
          : this.status === 'error'
            ? html`<span class="status-icon">${icon('error', 16, 'Error')}</span>`
            : nothing}
      </div>
      <div
        class="track"
        role="progressbar"
        aria-labelledby="${this.#id}-label"
        aria-describedby=${this.helperText ? `${this.#id}-help` : nothing}
        aria-valuemin="0"
        aria-valuemax=${this.max}
        aria-valuenow=${this.indeterminate || this.status === 'error' ? nothing : String(Math.round(this.status === 'finished' ? this.max : this.value))}
        aria-busy=${busy ? 'true' : 'false'}
      >
        <div class="bar" style="width: ${this.status === 'finished' ? 100 : pct}%"></div>
      </div>
      ${this.helperText ? html`<p class="helper" id="${this.#id}-help">${this.helperText}</p>` : nothing}`
  }
}
