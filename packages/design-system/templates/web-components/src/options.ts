/** An option read from light-DOM <option> children. */
export interface OptionData {
  value: string
  label: string
  disabled: boolean
  selected: boolean
}

/** The <option> children of `host` (also inside <optgroup>), as data. */
export function readOptions(host: HTMLElement): OptionData[] {
  return [...host.querySelectorAll('option')].map((o) => ({
    value: o.value,
    label: (o.label || o.textContent || '').trim(),
    disabled: o.disabled,
    selected: o.hasAttribute('selected'),
  }))
}

/** Re-run `sync` whenever the host's options change. */
export function watchOptions(host: HTMLElement, sync: () => void): MutationObserver {
  const mo = new MutationObserver(sync)
  mo.observe(host, { childList: true, subtree: true, attributes: true, characterData: true })
  return mo
}
