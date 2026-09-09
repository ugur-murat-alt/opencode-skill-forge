import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { tr } from "./tr";
import { en } from "./en";

export type Locale = "tr" | "en";
export type Theme = "light" | "dark";
export type Dict = typeof tr;

const dicts: Record<Locale, Dict> = { tr, en };
const LOCALES: readonly Locale[] = ["tr", "en"];
const THEMES: readonly Theme[] = ["light", "dark"];
const LANG_KEY = "forge-lang";
const THEME_KEY = "forge-theme";

type PathImpl<T, P extends string> = T extends string
  ? P
  : {
      [K in keyof T & string]: PathImpl<T[K], P extends "" ? K : `${P}.${K}`>;
    }[keyof T & string];
export type KeyPath = PathImpl<Dict, "">;
export type Params = Record<string, string | number>;

function lookup(dict: Dict, path: string): string {
  let node: unknown = dict;
  for (const part of path.split(".")) {
    if (!node || typeof node !== "object") return path;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : path;
}

export function fill(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (m, name: string) =>
    params[name] === undefined ? m : String(params[name]),
  );
}

function stored(
  raw: string | null,
  allowed: readonly string[],
  fallback: string,
): string {
  return raw && (allowed as readonly string[]).includes(raw) ? raw : fallback;
}

interface LangValue {
  lang: Locale;
  setLang: (l: Locale) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  t: (key: KeyPath, params?: Params) => string;
  tp: (base: string, count: number, params?: Params) => string;
  /** Render a server error code in the active locale (unknown-safe). */
  err: (code: string) => string;
  /** Render a status key in the active locale (passthrough for unknowns). */
  st: (key: string) => string;
}

const LangContext = createContext<LangValue | null>(null);

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Locale>(
    () =>
      stored(
        (() => {
          try {
            return localStorage.getItem(LANG_KEY);
          } catch {
            return null;
          }
        })(),
        LOCALES,
        document.documentElement.lang === "en" ? "en" : "tr",
      ) as Locale,
  );
  const [theme, setThemeState] = useState<Theme>(
    () =>
      stored(
        (() => {
          try {
            return localStorage.getItem(THEME_KEY);
          } catch {
            return null;
          }
        })(),
        THEMES,
        document.documentElement.dataset.theme === "dark" ? "dark" : "light",
      ) as Theme,
  );

  useEffect(() => {
    document.documentElement.lang = lang;
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch {}
  }, [lang]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    // Keep in sync with the pre-paint script in web/index.html (same values).
    document.documentElement.style.background =
      theme === "dark" ? "#0d1219" : "#fff";
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {}
  }, [theme]);

  // NOTE: never call hooks inside the useMemo factory below. A skipped
  // memo would change the hook count between renders (React #300).
  const value = useMemo<LangValue>(() => {
    const dict = dicts[lang];
    return {
      lang,
      setLang: setLangState,
      theme,
      setTheme: setThemeState,
      t: (key: KeyPath, params?: Params) => fill(lookup(dict, key), params),
      tp: (base: string, count: number, params?: Params) => {
        const suffix =
          new Intl.PluralRules(lang).select(count) === "one"
            ? "_one"
            : "_other";
        return fill(lookup(dict, `${base}${suffix}`), { ...params, count });
      },
      err: (code: string) => {
        const table = dict.errors as Record<string, string>;
        return table[code] ?? table.unknown!;
      },
      st: (key: string) => {
        const table = dict.status as Record<string, string>;
        return table[key] ?? key;
      },
    };
  }, [lang, theme]);

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang(): LangValue {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error("useLang outside LangProvider");
  return ctx;
}
