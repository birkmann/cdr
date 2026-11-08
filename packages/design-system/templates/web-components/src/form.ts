import { LitElement, type PropertyValues } from 'lit'
import { internalsOf } from './base.js'

/**
 * Base of every form control: form association (value, reset, disabled from a fieldset), name, required and validity.
 * Subclasses implement `formValue()` and `validationTarget()`.
 */
export abstract class FormControl extends LitElement {
  static formAssociated = true
  static override shadowRootOptions: ShadowRootInit = { ...LitElement.shadowRootOptions, delegatesFocus: true }
  static override properties = {
    name: { type: String, reflect: true },
    disabled: { type: Boolean, reflect: true },
    required: { type: Boolean, reflect: true },
  }
  declare name: string
  declare disabled: boolean
  declare required: boolean
  protected readonly internals = internalsOf(this)

  constructor() {
    super()
    this.name = ''
    this.disabled = false
    this.required = false
  }

  /** The value submitted with the form (null: not submitted). */
  protected abstract formValue(): string | null
  /** What the form's validity reports (default: a required control without a value is missing). */
  protected validity(): { flags: ValidityStateFlags; message: string } {
    const missing = this.required && !this.formValue()
    return { flags: missing ? { valueMissing: true } : {}, message: missing ? 'Please fill out this field.' : '' }
  }
  /** The inner element validation messages anchor to. */
  protected validationTarget(): HTMLElement | undefined {
    return (this.renderRoot as ShadowRoot | undefined)?.querySelector<HTMLElement>('input, textarea, select, button, [tabindex]') ?? undefined
  }
  /** Back to the value the control was created with. */
  abstract formResetCallback(): void

  formDisabledCallback(disabled: boolean) {
    this.disabled = disabled
  }

  get form(): HTMLFormElement | null {
    return this.internals?.form ?? null
  }
  get validationMessage(): string {
    return this.internals?.validationMessage ?? ''
  }
  checkValidity(): boolean {
    return this.internals?.checkValidity?.() ?? true
  }
  reportValidity(): boolean {
    return this.internals?.reportValidity?.() ?? true
  }

  protected override updated(changed: PropertyValues) {
    super.updated(changed)
    // partial ElementInternals (older browsers, jsdom) have no form API: the control still works, it just does not submit
    if (typeof this.internals?.setFormValue !== 'function') return
    this.internals.setFormValue(this.formValue())
    const v = this.validity()
    const anchor = this.validationTarget()
    if (Object.keys(v.flags).length) this.internals.setValidity(v.flags, v.message, anchor)
    else this.internals.setValidity({})
  }
}
