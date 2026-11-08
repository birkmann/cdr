import { svg, html, LitElement, css, type SVGTemplateResult } from 'lit'

/** Icon paths on a 16 × 16 grid (stroke-free, filled), drawn for this design system. */
export const ICONS = {
  close: svg`<path d="M12.2 3 8 7.2 3.8 3 3 3.8 7.2 8 3 12.2l.8.8L8 8.8l4.2 4.2.8-.8L8.8 8 13 3.8z"/>`,
  'chevron-down': svg`<path d="M8 11 3 6l.7-.7L8 9.6l4.3-4.3.7.7z"/>`,
  'chevron-up': svg`<path d="m8 5 5 5-.7.7L8 6.4l-4.3 4.3L3 10z"/>`,
  'chevron-left': svg`<path d="m5 8 5-5 .7.7L6.4 8l4.3 4.3-.7.7z"/>`,
  'chevron-right': svg`<path d="m11 8-5 5-.7-.7L9.6 8 5.3 3.7 6 3z"/>`,
  check: svg`<path d="M6.5 11.3 3 7.8l.7-.7 2.8 2.8 5.8-5.8.7.7z"/>`,
  subtract: svg`<path d="M4 7.5h8v1H4z"/>`,
  add: svg`<path d="M8.5 7.5V3h-1v4.5H3v1h4.5V13h1V8.5H13v-1z"/>`,
  search: svg`<path d="m14.5 13.8-3.8-3.8a5 5 0 1 0-.7.7l3.8 3.8zM3 6.5a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0"/>`,
  info: svg`<path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1m.5 11h-1V7h1zM8 5.6a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6"/>`,
  warning: svg`<path d="M8 1 .5 14.5h15zm.5 11h-1v-1h1zm0-2h-1V6h1z"/>`,
  error: svg`<path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1m2.7 10.4L8 8.7l-2.7 2.7-.7-.7L7.3 8 4.6 5.3l.7-.7L8 7.3l2.7-2.7.7.7L8.7 8l2.7 2.7z"/>`,
  success: svg`<path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1M7 11 4 8l.7-.7L7 9.6l4.3-4.3.7.7z"/>`,
  menu: svg`<path d="M2 3.5h12v1H2zm0 4h12v1H2zm0 4h12v1H2z"/>`,
  overflow: svg`<path d="M8 4.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2m0 4.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2m0 4.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2"/>`,
  'arrow-up': svg`<path d="M8 2 3.5 6.5l.7.7L7.5 3.9V14h1V3.9l3.3 3.3.7-.7z"/>`,
  'arrow-down': svg`<path d="m8 14 4.5-4.5-.7-.7-3.3 3.3V2h-1v10.1L4.2 8.8l-.7.7z"/>`,
  'arrows-vertical': svg`<path d="M5 2 2 5l.7.7L4.5 3.9V14h1V3.9l1.8 1.8L8 5zm6 12 3-3-.7-.7-1.8 1.8V2h-1v10.1l-1.8-1.8L8 11z"/>`,
} satisfies Record<string, SVGTemplateResult>

export type IconName = keyof typeof ICONS

/** An inline SVG icon (decorative unless `label` is given). */
export const icon = (name: IconName, size = 16, label?: string) =>
  html`<svg
    class="icon"
    width=${size}
    height=${size}
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden=${label ? 'false' : 'true'}
    role=${label ? 'img' : 'presentation'}
    aria-label=${label ?? ''}
    focusable="false"
  >${ICONS[name]}</svg>`

/**
 * An icon by name.
 * @element __P__-icon
 */
export class Icon extends LitElement {
  static override styles = css`
    :host {
      display: inline-flex;
      color: inherit;
      line-height: 0;
    }
  `
  static override properties = {
    name: { type: String, reflect: true },
    size: { type: Number },
    label: { type: String },
  }
  declare name: IconName
  declare size: number
  declare label?: string
  constructor() {
    super()
    this.name = 'info'
    this.size = 16
  }
  override render() {
    return ICONS[this.name] ? icon(this.name, this.size, this.label) : null
  }
}
