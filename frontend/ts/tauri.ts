export const isTauri = Boolean(window.__TAURI__);

export async function invoke(cmd: string, args: Record<string, unknown> = {}): Promise<any> {
  if (!isTauri) {
    console.error('No Tauri', cmd);
    return null;
  }
  try {
    return await window.__TAURI__.core.invoke(cmd, args);
  } catch (e) {
    console.error('invoke error:', cmd, e);
    return null;
  }
}
