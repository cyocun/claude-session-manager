/**
 * Terminal module — embeds xterm.js in the detail pane and bridges I/O
 * to a PTY session managed by the Rust backend via Tauri commands/events.
 */
import { invoke, invokeStrict, isTauri } from './tauri.js';
const STORAGE_KEY_HEIGHT = 'csm-terminal-height';
const DEFAULT_HEIGHT = 300;
const MIN_HEIGHT = 150;
let activePtyId = null;
let activeTerminal = null;
let activeFitAddon = null;
let outputUnlisten = null;
let exitUnlisten = null;
let resizeObserver = null;
function isDark() {
    return document.documentElement.classList.contains('dark');
}
function getTermTheme() {
    const dark = isDark();
    return dark
        ? {
            background: '#1e1e2e',
            foreground: '#cdd6f4',
            cursor: '#f5e0dc',
            selectionBackground: '#585b7066',
            black: '#45475a',
            red: '#f38ba8',
            green: '#a6e3a1',
            yellow: '#f9e2af',
            blue: '#89b4fa',
            magenta: '#f5c2e7',
            cyan: '#94e2d5',
            white: '#bac2de',
            brightBlack: '#585b70',
            brightRed: '#f38ba8',
            brightGreen: '#a6e3a1',
            brightYellow: '#f9e2af',
            brightBlue: '#89b4fa',
            brightMagenta: '#f5c2e7',
            brightCyan: '#94e2d5',
            brightWhite: '#a6adc8',
        }
        : {
            background: '#ffffff',
            foreground: '#4c4f69',
            cursor: '#dc8a78',
            selectionBackground: '#acb0be66',
            black: '#5c5f77',
            red: '#d20f39',
            green: '#40a02b',
            yellow: '#df8e1d',
            blue: '#1e66f5',
            magenta: '#ea76cb',
            cyan: '#179299',
            white: '#acb0be',
            brightBlack: '#6c6f85',
            brightRed: '#d20f39',
            brightGreen: '#40a02b',
            brightYellow: '#df8e1d',
            brightBlue: '#1e66f5',
            brightMagenta: '#ea76cb',
            brightCyan: '#179299',
            brightWhite: '#bcc0cc',
        };
}
function b64Encode(str) {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);
    let binary = '';
    for (const b of bytes)
        binary += String.fromCharCode(b);
    return btoa(binary);
}
function b64Decode(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++)
        bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}
export function isTerminalOpen() {
    return activePtyId !== null;
}
export function getStoredHeight() {
    const v = localStorage.getItem(STORAGE_KEY_HEIGHT);
    if (v) {
        const n = parseInt(v, 10);
        if (!isNaN(n) && n >= MIN_HEIGHT)
            return n;
    }
    return DEFAULT_HEIGHT;
}
export function setStoredHeight(h) {
    localStorage.setItem(STORAGE_KEY_HEIGHT, String(Math.max(MIN_HEIGHT, Math.round(h))));
}
export async function openTerminal(sessionId, container, onExit) {
    if (!isTauri)
        return;
    // Close existing terminal if any
    await closeTerminal();
    const tauriEvent = window.__TAURI__.event;
    // Create xterm.js instance
    const term = new Terminal({
        theme: getTermTheme(),
        fontSize: 13,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        cursorBlink: true,
        allowProposedApi: true,
        scrollback: 5000,
        convertEol: false,
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();
    // Spawn PTY
    let ptyId;
    try {
        ptyId = await invokeStrict('pty_spawn', { sessionId });
    }
    catch (e) {
        term.writeln(`\x1b[31mFailed to spawn PTY: ${e}\x1b[0m`);
        activeTerminal = term;
        activeFitAddon = fitAddon;
        return;
    }
    activePtyId = ptyId;
    activeTerminal = term;
    activeFitAddon = fitAddon;
    // Send initial resize
    const dims = fitAddon.proposeDimensions();
    if (dims) {
        invoke('pty_resize', { ptyId, rows: dims.rows, cols: dims.cols });
    }
    // PTY output → xterm.js
    outputUnlisten = await tauriEvent.listen('pty-output', (event) => {
        const payload = event.payload;
        if (payload.ptyId !== ptyId)
            return;
        const text = b64Decode(payload.data);
        term.write(text);
    });
    // PTY exit → cleanup and notify caller
    exitUnlisten = await tauriEvent.listen('pty-exit', (event) => {
        const payload = event.payload;
        if (payload.ptyId !== ptyId)
            return;
        activePtyId = null;
        closeTerminal().then(() => onExit?.());
    });
    // Shift+Enter → send newline escape sequence (kitty keyboard protocol)
    term.attachCustomKeyEventHandler((e) => {
        if (e.type === 'keydown' && e.key === 'Enter' && e.shiftKey) {
            if (activePtyId) {
                invoke('pty_write', { ptyId: activePtyId, data: b64Encode('\x1b[13;2u') });
            }
            return false; // prevent default xterm handling
        }
        return true;
    });
    // xterm.js input → PTY
    term.onData((data) => {
        if (activePtyId) {
            invoke('pty_write', { ptyId: activePtyId, data: b64Encode(data) });
        }
    });
    // Resize handling
    resizeObserver = new ResizeObserver(() => {
        if (activeFitAddon) {
            activeFitAddon.fit();
            if (activePtyId) {
                const d = activeFitAddon.proposeDimensions();
                if (d) {
                    invoke('pty_resize', { ptyId: activePtyId, rows: d.rows, cols: d.cols });
                }
            }
        }
    });
    resizeObserver.observe(container);
    term.focus();
}
export async function openTerminalNew(project, container, onExit) {
    if (!isTauri)
        return;
    await closeTerminal();
    const tauriEvent = window.__TAURI__.event;
    const term = new Terminal({
        theme: getTermTheme(),
        fontSize: 13,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        cursorBlink: true,
        allowProposedApi: true,
        scrollback: 5000,
        convertEol: false,
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();
    let ptyId;
    try {
        ptyId = await invokeStrict('pty_spawn_new', { project });
    }
    catch (e) {
        term.writeln(`\x1b[31mFailed to spawn PTY: ${e}\x1b[0m`);
        activeTerminal = term;
        activeFitAddon = fitAddon;
        return;
    }
    activePtyId = ptyId;
    activeTerminal = term;
    activeFitAddon = fitAddon;
    const dims = fitAddon.proposeDimensions();
    if (dims) {
        invoke('pty_resize', { ptyId, rows: dims.rows, cols: dims.cols });
    }
    outputUnlisten = await tauriEvent.listen('pty-output', (event) => {
        const payload = event.payload;
        if (payload.ptyId !== ptyId)
            return;
        term.write(b64Decode(payload.data));
    });
    exitUnlisten = await tauriEvent.listen('pty-exit', (event) => {
        const payload = event.payload;
        if (payload.ptyId !== ptyId)
            return;
        activePtyId = null;
        closeTerminal().then(() => onExit?.());
    });
    // Shift+Enter → send newline escape sequence (kitty keyboard protocol)
    term.attachCustomKeyEventHandler((e) => {
        if (e.type === 'keydown' && e.key === 'Enter' && e.shiftKey) {
            if (activePtyId) {
                invoke('pty_write', { ptyId: activePtyId, data: b64Encode('\x1b[13;2u') });
            }
            return false;
        }
        return true;
    });
    term.onData((data) => {
        if (activePtyId) {
            invoke('pty_write', { ptyId: activePtyId, data: b64Encode(data) });
        }
    });
    resizeObserver = new ResizeObserver(() => {
        if (activeFitAddon) {
            activeFitAddon.fit();
            if (activePtyId) {
                const d = activeFitAddon.proposeDimensions();
                if (d) {
                    invoke('pty_resize', { ptyId: activePtyId, rows: d.rows, cols: d.cols });
                }
            }
        }
    });
    resizeObserver.observe(container);
    term.focus();
}
export async function closeTerminal() {
    if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
    }
    if (outputUnlisten) {
        outputUnlisten();
        outputUnlisten = null;
    }
    if (exitUnlisten) {
        exitUnlisten();
        exitUnlisten = null;
    }
    if (activePtyId) {
        await invoke('pty_close', { ptyId: activePtyId });
        activePtyId = null;
    }
    if (activeTerminal) {
        activeTerminal.dispose();
        activeTerminal = null;
        activeFitAddon = null;
    }
}
export function updateTerminalTheme() {
    if (activeTerminal) {
        activeTerminal.options.theme = getTermTheme();
    }
}
export function focusTerminal() {
    if (activeTerminal) {
        activeTerminal.focus();
    }
}
