import { useCallback, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';

const KEY = 'cockpit.theme';

function read(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* private browsing — fall through to the OS preference */
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * The inline script in index.html has already stamped data-theme before first paint;
 * this hook keeps React in step with it and persists an explicit choice.
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() =>
    (document.documentElement.getAttribute('data-theme') as Theme | null) ?? read(),
  );

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* the choice simply will not survive a reload */
    }
  }, [theme]);

  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);

  return { theme, toggle };
}
