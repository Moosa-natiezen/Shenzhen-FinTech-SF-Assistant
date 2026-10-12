"use client";
/**
 * High-contrast mode for the sponsor persona (design doc: "high-contrast,
 * straightforward navigation for older parents and sponsors"). Toggled globally
 * via a data attribute on <html>; persisted to localStorage.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

interface ThemeValue {
  highContrast: boolean;
  toggleHighContrast: () => void;
}

const ThemeContext = createContext<ThemeValue>({ highContrast: false, toggleHighContrast: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [highContrast, setHighContrast] = useState(false);

  useEffect(() => {
    const saved = typeof window !== "undefined" && window.localStorage.getItem("contrast") === "high";
    setHighContrast(saved);
  }, []);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.dataset.contrast = highContrast ? "high" : "normal";
    }
    if (typeof window !== "undefined") {
      window.localStorage.setItem("contrast", highContrast ? "high" : "normal");
    }
  }, [highContrast]);

  const toggleHighContrast = useCallback(() => setHighContrast((v) => !v), []);
  return <ThemeContext.Provider value={{ highContrast, toggleHighContrast }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  return useContext(ThemeContext);
}
