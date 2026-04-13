// Centralized keyboard shortcut handling.
// Arrow/Tab navigation lives in layoutControls.ts and chat-search specific keys in chatSearch.ts —
// this module owns the global, OS-standard shortcuts that previously lived scattered in app.ts.

export type ShortcutsDeps = {
  byId: (id: string) => HTMLElement;
  byIdOptional: <T extends HTMLElement>(id: string) => T | null;
  fullTextSearch: { clear: () => void };
  chatSearch: { clear: () => void; next: () => void; prev: () => void };
  getSelectedSession: () => string | null;
  getSelectedProject: () => string | null;
  setProjectFilter: (path: string | null) => void;
  toggleTerminal: () => void;
  focusFirstSession: () => void;
  focusLastSession: () => void;
  isModalOpen: () => boolean;
};

export function initShortcuts(deps: ShortcutsDeps): void {
  const {
    byId, byIdOptional,
    fullTextSearch, chatSearch,
    getSelectedSession, getSelectedProject, setProjectFilter,
    toggleTerminal,
    focusFirstSession, focusLastSession,
    isModalOpen,
  } = deps;

  function focusInputAndSelect(el: HTMLInputElement | null): void {
    if (!el) return;
    el.focus();
    el.select();
  }

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    const onlyMod = mod && !e.shiftKey && !e.altKey;
    const modShift = mod && e.shiftKey && !e.altKey;
    const key = e.key.toLowerCase();

    const active = document.activeElement as HTMLElement | null;
    const activeTag = active?.tagName;
    const activeIsTextInput = activeTag === 'INPUT' || activeTag === 'TEXTAREA';
    const chatInput = byIdOptional<HTMLInputElement>('chatSearch');
    const globalSearch = byId('search') as HTMLInputElement;

    // Find: Cmd+Shift+F always targets global search
    if (modShift && key === 'f') {
      e.preventDefault();
      focusInputAndSelect(globalSearch);
      return;
    }
    // Cmd+F: chat search if a session is open, otherwise global
    if (onlyMod && key === 'f') {
      e.preventDefault();
      focusInputAndSelect(getSelectedSession() && chatInput ? chatInput : globalSearch);
      return;
    }
    // Cmd+K: always global search
    if (onlyMod && key === 'k') {
      e.preventDefault();
      focusInputAndSelect(globalSearch);
      return;
    }
    // Cmd+G / Cmd+Shift+G: next/prev hit in chat search
    if ((onlyMod || modShift) && key === 'g') {
      if (!chatInput) return;
      e.preventDefault();
      if (e.shiftKey) chatSearch.prev();
      else chatSearch.next();
      return;
    }

    // Cmd+` : terminal toggle (selectedSession guarded inside)
    if (onlyMod && e.key === '`') {
      e.preventDefault();
      toggleTerminal();
      return;
    }
    // Cmd+ArrowUp / ArrowDown: jump to first/last session (only when not in a text input)
    if (onlyMod && !activeIsTextInput && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      if (e.key === 'ArrowUp') focusFirstSession();
      else focusLastSession();
      return;
    }

    // Escape: cascading close — modal > chat-search input > global-search input > project filter
    if (e.key === 'Escape') {
      if (isModalOpen()) return; // modal owns its own Escape
      if (activeIsTextInput) {
        if (active === chatInput) {
          chatSearch.clear();
          (active as HTMLInputElement).blur();
          return;
        }
        if (active === globalSearch) {
          fullTextSearch.clear();
          (active as HTMLInputElement).blur();
          return;
        }
        return;
      }
      if (getSelectedProject()) {
        e.preventDefault();
        setProjectFilter(null);
        return;
      }
    }
  });
}
