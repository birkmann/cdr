/**
 * Source markup may contain custom elements (web components such as `<root-shell>`), which the component
 * compiler emits as JSX. React renders any hyphenated tag as a custom element; this lets them type-check.
 */
import "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      [tagName: `${string}-${string}`]: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & Record<string, unknown>;
    }
  }
}
