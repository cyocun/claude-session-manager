export const isTauri = Boolean(window.__TAURI__);
export async function invokeStrict(cmd, args = {}) {
    if (!isTauri) {
        throw new Error(`No Tauri runtime for command: ${cmd}`);
    }
    return await window.__TAURI__.core.invoke(cmd, args);
}
export async function invoke(cmd, args = {}) {
    if (!isTauri) {
        console.error('No Tauri', cmd);
        return null;
    }
    try {
        return await invokeStrict(cmd, args);
    }
    catch (e) {
        console.error('invoke error:', cmd, e);
        return null;
    }
}
