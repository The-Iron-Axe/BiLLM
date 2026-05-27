import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "light" | "dark" | "system";

/** @deprecated Use ThemePreference */
export type Theme = ThemePreference;

export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "billm.theme";

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref === "system") return getSystemTheme();
  return pref;
}

function readInitialPreference(): ThemePreference {
  if (typeof window === "undefined") return "dark";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (
      stored === "light" ||
      stored === "dark" ||
      stored === "system"
    ) {
      return stored;
    }
  } catch {
    // ignore
  }
  return "system";
}

function applyTheme(t: ResolvedTheme) {
  const root = document.documentElement;
  if (t === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemePreference>(readInitialPreference);

  useEffect(() => {
    applyTheme(resolveTheme(theme));
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);

  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme(getSystemTheme());
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback((t: ThemePreference) => setThemeState(t), []);
  const toggle = useCallback(() => {
    setThemeState((t) => {
      const resolved = resolveTheme(t);
      return resolved === "dark" ? "light" : "dark";
    });
  }, []);

  return { theme, setTheme, toggle, resolvedTheme: resolveTheme(theme) };
}
