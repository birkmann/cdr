// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
import type { SceneElement, SceneScreen } from "@harness/protocol";

let seq = 0;
export const newElementId = (prefix = "el") => `${prefix}-${Date.now().toString(36)}-${(++seq).toString(36)}`;

/** The active state of a state frame (SceneElement.states): the child it shows, by default the first. */
export function activeState(el: SceneElement): SceneElement | undefined {
  if (!el.states || !el.children?.length) return undefined;
  return el.children.find((c) => c.id === el.states!.active) ?? el.children[0];
}

/** The children a static render shows: a state frame only its active state. */
export function shownChildren(el: SceneElement): SceneElement[] {
  const a = activeState(el);
  return a ? [a] : (el.children ?? []);
}

export function walk(
  el: SceneElement,
  visit: (el: SceneElement, parent: SceneElement | null, depth: number) => void | false,
  parent: SceneElement | null = null,
  depth = 0,
): void {
  if (visit(el, parent, depth) === false) return;
  el.children?.forEach((c) => walk(c, visit, el, depth + 1));
}

export function findElement(root: SceneElement, id: string): SceneElement | null {
  let found: SceneElement | null = null;
  walk(root, (el) => {
    if (el.id === id) {
      found = el;
      return false;
    }
  });
  return found;
}

export function findParent(root: SceneElement, id: string): SceneElement | null {
  let found: SceneElement | null = null;
  walk(root, (el, parent) => {
    if (el.id === id) {
      found = parent;
      return false;
    }
  });
  return found;
}

/** Immutable update: returns a new root with the element patched (children of the patch replace entirely if given). */
export function updateElement(root: SceneElement, id: string, patch: Partial<SceneElement>): SceneElement {
  if (root.id === id) return { ...root, ...patch };
  if (!root.children) return root;
  let changed = false;
  const children = root.children.map((c) => {
    const n = updateElement(c, id, patch);
    if (n !== c) changed = true;
    return n;
  });
  return changed ? { ...root, children } : root;
}

export function removeElement(root: SceneElement, id: string): SceneElement {
  if (!root.children) return root;
  const filtered = root.children.filter((c) => c.id !== id);
  const children = filtered.map((c) => removeElement(c, id));
  return { ...root, children };
}

export function insertElement(
  root: SceneElement,
  parentId: string,
  el: SceneElement,
  index?: number,
): SceneElement {
  if (root.id === parentId) {
    const children = [...(root.children ?? [])];
    children.splice(index ?? children.length, 0, el);
    return { ...root, children };
  }
  if (!root.children) return root;
  return { ...root, children: root.children.map((c) => insertElement(c, parentId, el, index)) };
}

export function moveElement(
  root: SceneElement,
  id: string,
  newParentId: string,
  index: number,
): SceneElement {
  const el = findElement(root, id);
  if (!el) return root;
  return insertElement(removeElement(root, id), newParentId, el, index);
}

/** Re-id a subtree (for duplicates). */
export function cloneWithNewIds(el: SceneElement): SceneElement {
  return { ...el, id: newElementId(), children: el.children?.map(cloneWithNewIds) };
}

export function screenWithRoot(screen: SceneScreen, root: SceneElement): SceneScreen {
  return root === screen.root ? screen : { ...screen, root };
}
