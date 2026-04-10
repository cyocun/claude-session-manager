export function createEl(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'className')
            el.className = v;
        else if (k === 'textContent')
            el.textContent = v;
        else if (k.startsWith('on'))
            el.addEventListener(k.slice(2).toLowerCase(), v);
        else
            el.setAttribute(k, String(v));
    }
    for (const child of children) {
        if (typeof child === 'string')
            el.appendChild(document.createTextNode(child));
        else if (child)
            el.appendChild(child);
    }
    return el;
}
export function getById(id) {
    const el = document.getElementById(id);
    if (!el) {
        throw new Error(`Element not found: #${id}`);
    }
    return el;
}
const HIGHLIGHT_CLASS = 'accent-highlight';
/** Add accent outline that auto-removes after 2 s. */
export function flashHighlight(el) {
    el.classList.add(HIGHLIGHT_CLASS);
    setTimeout(() => el.classList.remove(HIGHLIGHT_CLASS), 2000);
}
/** Add/remove persistent accent outline (for selection state). */
export function setHighlight(el, on) {
    el.classList.toggle(HIGHLIGHT_CLASS, on);
}
