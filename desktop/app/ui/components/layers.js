// components/layers.js: the Escape stack (desktop/DESIGN.md §8.2; frontend report F-11). Whatever opened last closes first: popover → inline confirm →
// "?" expander → commit sheet. A component pushes a layer when it opens and drops it when it closes; the frame's one Escape handler closes the top.
// Escape never cancels a running write: the sheet's own close only hides it (views/tune/apply.js keeps the apply running).
const stack = [];

/** Register an open layer. `close()` must close it (and may call the returned `drop` itself). Returns `drop`. */
export function pushLayer(close, owner = null) {
  const entry = { close, owner };
  stack.push(entry);
  return () => {
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** Close the top layer. Returns false when nothing was open. */
export function closeTopLayer() {
  const top = stack.pop();
  if (!top) return false;
  top.close();
  return true;
}

export const layerCount = () => stack.length;
export const topLayerOwner = () => (stack.length ? stack[stack.length - 1].owner : null);
