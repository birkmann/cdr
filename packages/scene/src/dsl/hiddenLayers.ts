// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// How a hidden layer (meta.hidden) renders. In the earlier project this is a per-user canvas preference; a recreation always
// keeps hidden layers laid out ('keep': invisible, the page keeps its height and flow), unless a caller opts out.
import type { SceneElement } from "@harness/protocol";

export type HiddenLayerMode = "keep" | "remove";

let mode: HiddenLayerMode = "keep";

export const hiddenLayerMode = () => mode;
export const hiddenKeepsSpace = () => mode === "keep";

export function setHiddenLayerMode(next: HiddenLayerMode) {
  mode = next;
}

/** true when the layer is hidden and hidden layers are not rendered at all */
export const isRemoved = (el: SceneElement) => el.meta?.hidden === true && mode === "remove";
