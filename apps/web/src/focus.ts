import { type RefObject, useEffect } from "react";

/**
 * A control's focus key: its `data-focus-key`, else its id, else a button's text. A control
 * rebuilt after a reconnect or a re-render keeps its key, so focus can return to it.
 */
function keyOf(element: HTMLElement): string | undefined {
  if (element.dataset.focusKey) return `key:${element.dataset.focusKey}`;
  if (element.id) return `id:${element.id}`;
  if (element instanceof HTMLButtonElement) return `button:${element.textContent ?? ""}`;
  return undefined;
}

function find(root: HTMLElement, key: string): HTMLElement | undefined {
  for (const candidate of root.querySelectorAll<HTMLElement>("[data-focus-key], [id], button"))
    if (keyOf(candidate) === key) return candidate;
  return undefined;
}

/**
 * A focus request expires after 5 s. This is a decision: the requested element follows one read
 * (a selection's history), and a request that read never satisfies, for example a failed selection,
 * must not steal focus from a later user action or keep the observer searching the shell.
 */
const REQUEST_EXPIRY_MS = 5000;
let requested: string | undefined;
let expiry: ReturnType<typeof setTimeout> | undefined;
/** Asks the shell to focus the element with this id as soon as it is present, within the expiry. */
export function focusWhenPresent(id: string): void {
  const key = `id:${id}`;
  requested = key;
  clearTimeout(expiry);
  expiry = setTimeout(() => {
    if (requested === key) requested = undefined;
  }, REQUEST_EXPIRY_MS);
  // An element already present after this render is focused without waiting for a mutation.
  setTimeout(() => {
    const target = document.getElementById(id);
    if (requested !== key || !target) return;
    requested = undefined;
    target.focus();
  }, 0);
}

/**
 * Keeps keyboard focus through re-renders and reconnects: when the focused control leaves the
 * document and focus has fallen to the body, the control with the same key takes it back.
 */
export function useFocusRecovery(root: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const shell = root.current;
    if (!shell) return;
    let last: { readonly element: HTMLElement; readonly key: string } | undefined;
    const remember = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      const key = keyOf(target);
      last = key === undefined ? undefined : { element: target, key };
    };
    const observer = new MutationObserver(() => {
      if (requested !== undefined) {
        const target = find(shell, requested);
        if (target) {
          requested = undefined;
          target.focus();
          return;
        }
      }
      if (!last || last.element.isConnected) return;
      if (document.activeElement && document.activeElement !== document.body) return;
      find(shell, last.key)?.focus();
    });
    shell.addEventListener("focusin", remember);
    observer.observe(shell, { childList: true, subtree: true });
    return () => {
      shell.removeEventListener("focusin", remember);
      observer.disconnect();
    };
  }, [root]);
}
