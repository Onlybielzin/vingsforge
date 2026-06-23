/**
 * Design tokens (Spec 06 §2). Dark by default, light optional. Emitted as CSS
 * custom properties so components style via var(--vf-*) and theme switches with
 * a single data-theme attribute on the root.
 */
export type ThemeName = 'dark' | 'light';

const dark: Record<string, string> = {
  '--vf-bg': '#0e1014',
  '--vf-bg-raised': '#16191f',
  '--vf-bg-inset': '#0a0c0f',
  '--vf-surface': '#1b1f27',
  '--vf-border': '#272c36',
  '--vf-border-strong': '#39404e',
  '--vf-text': '#e6e9ef',
  '--vf-text-muted': '#9aa3b2',
  '--vf-text-faint': '#5f6877',
  '--vf-accent': '#6ea8fe',
  '--vf-accent-weak': '#1d2c44',
  '--vf-ok': '#5cc98a',
  '--vf-warn': '#e0b341',
  '--vf-danger': '#e06c75',
  '--vf-diff-add': '#1b3326',
  '--vf-diff-del': '#3a1d20',
  '--vf-font': "'Inter', ui-sans-serif, system-ui, sans-serif",
  '--vf-mono': "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
};

const light: Record<string, string> = {
  '--vf-bg': '#f6f7f9',
  '--vf-bg-raised': '#ffffff',
  '--vf-bg-inset': '#eceef1',
  '--vf-surface': '#ffffff',
  '--vf-border': '#dfe2e7',
  '--vf-border-strong': '#c4c9d2',
  '--vf-text': '#1a1d23',
  '--vf-text-muted': '#5a6472',
  '--vf-text-faint': '#94a0b0',
  '--vf-accent': '#2f6fed',
  '--vf-accent-weak': '#dbe7ff',
  '--vf-ok': '#1f9d57',
  '--vf-warn': '#a6791a',
  '--vf-danger': '#c83b45',
  '--vf-diff-add': '#dbf3e3',
  '--vf-diff-del': '#fbe0e2',
  '--vf-font': "'Inter', ui-sans-serif, system-ui, sans-serif",
  '--vf-mono': "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
};

export const THEMES: Record<ThemeName, Record<string, string>> = { dark, light };

/** Applies a theme's tokens to the document root. */
export function applyTheme(theme: ThemeName): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  for (const [key, value] of Object.entries(THEMES[theme])) {
    root.style.setProperty(key, value);
  }
}
