"use client";

import { useEffect, useSyncExternalStore } from "react";

type ThemeId = "a" | "b" | "c";

const THEMES: { id: ThemeId; label: string; colors: [string, string] }[] = [
  { id: "a", label: "Indigo + cam", colors: ["#4F46E5", "#FB923C"] },
  { id: "b", label: "Tím + vàng", colors: ["#7C3AED", "#FACC15"] },
  { id: "c", label: "Navy + san hô", colors: ["#1E3A5F", "#FF6B6B"] },
];

const STORAGE_KEY = "personal-english-lab-theme";
const THEME_EVENT = "personal-english-lab-theme-change";

function getThemeSnapshot(): ThemeId {
  const saved = window.localStorage.getItem(STORAGE_KEY);
  return saved === "b" || saved === "c" ? saved : "a";
}

function subscribeTheme(onStoreChange: () => void) {
  window.addEventListener(THEME_EVENT, onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    window.removeEventListener(THEME_EVENT, onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

export default function ThemeSwitcher() {
  const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot, () => "a");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  function selectTheme(nextTheme: ThemeId) {
    window.localStorage.setItem(STORAGE_KEY, nextTheme);
    window.dispatchEvent(new Event(THEME_EVENT));
  }

  return (
    <div className="rounded-2xl border-2 border-border bg-card p-2 shadow-sm" aria-label="Chọn bảng màu">
      <p className="px-2 pb-2 text-[11px] font-extrabold uppercase tracking-wider text-muted">
        Theme màu
      </p>
      <div className="flex flex-wrap gap-2" role="radiogroup">
        {THEMES.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={theme === item.id}
            onClick={() => selectTheme(item.id)}
            className={`flex items-center gap-2 rounded-xl border-2 px-3 py-2 text-xs font-extrabold transition ease-smooth ${
              theme === item.id
                ? "border-primary bg-highlight text-primary"
                : "border-transparent text-body hover:border-border hover:bg-background"
            }`}
          >
            <span className="flex -space-x-1" aria-hidden="true">
              {item.colors.map((color) => (
                <span
                  key={color}
                  className="h-4 w-4 rounded-full border-2 border-white"
                  style={{ backgroundColor: color }}
                />
              ))}
            </span>
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
