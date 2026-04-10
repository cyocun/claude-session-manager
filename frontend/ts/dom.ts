export function createEl(
  tag: string,
  attrs: Record<string, any> = {},
  children: any[] = []
): HTMLElement {
  const el = document.createElement(tag) as HTMLElement;
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') el.className = v;
    else if (k === 'textContent') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, String(v));
  }
  for (const child of children) {
    if (typeof child === 'string') el.appendChild(document.createTextNode(child));
    else if (child) el.appendChild(child);
  }
  return el;
}

export function getById<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Element not found: #${id}`);
  }
  return el as T;
}

const HIGHLIGHT_CLASS = 'accent-highlight';

/** Add accent outline that auto-removes after 2 s. */
export function flashHighlight(el: HTMLElement): void {
  el.classList.add(HIGHLIGHT_CLASS);
  setTimeout(() => el.classList.remove(HIGHLIGHT_CLASS), 2000);
}

/** Add/remove persistent accent outline (for selection state). */
export function setHighlight(el: HTMLElement, on: boolean): void {
  el.classList.toggle(HIGHLIGHT_CLASS, on);
}
