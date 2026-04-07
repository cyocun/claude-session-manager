export function getThemePref() {
  return localStorage.getItem('csm-theme') || 'system';
}

export function applyTheme(themePref: string) {
  let dark;
  if (themePref === 'dark') dark = true;
  else if (themePref === 'light') dark = false;
  else dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.toggle('dark', dark);
  const darkTheme = document.getElementById('hljs-theme-dark') as HTMLLinkElement | null;
  const lightTheme = document.getElementById('hljs-theme-light') as HTMLLinkElement | null;
  if (darkTheme) darkTheme.disabled = !dark;
  if (lightTheme) lightTheme.disabled = dark;
}

export function watchSystemTheme(onChange: (e: MediaQueryListEvent) => void) {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', onChange);
}
