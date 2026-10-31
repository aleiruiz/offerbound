import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { es } from "./es";
import { esServer, esServerPatterns } from "./es-server";

/**
 * The interface language. English text is the message key: `t("Add application")` shows the
 * English as written, or its Spanish (Mexico) translation from `es.ts`. A key with no translation
 * falls back to the English, and `i18n.test.ts` fails when a `t()` or `msg()` literal in the source
 * has no Spanish entry. Only the interface is translated; what the AI writes keeps its language.
 */

export type Locale = "en" | "es";

export const LOCALES: readonly { value: Locale; label: string }[] = [
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
];

export const LOCALE_STORAGE_KEY = "ob.locale";

/** The BCP 47 tag the `Intl` formatters use for each language. */
const INTL_TAGS: Record<Locale, string> = { en: "en-US", es: "es-MX" };

const DICTIONARIES: Record<Locale, Readonly<Record<string, string>> | null> = { en: null, es };

/** The stored choice, else the browser's language: Spanish for any `es-*`, otherwise English. */
export function detectLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored === "en" || stored === "es") return stored;
  } catch {
    // storage is blocked: fall through to the browser's language
  }
  const languages =
    typeof navigator === "undefined" ? [] : (navigator.languages ?? [navigator.language]);
  const first = languages.find((l) => typeof l === "string" && l.length > 0) ?? "en";
  return first.toLowerCase().startsWith("es") ? "es" : "en";
}

let current: Locale = "en";

export function getLocale(): Locale {
  return current;
}

/** Sets the language the plain functions below use. The provider calls it; tests may too. */
export function setLocale(locale: Locale): void {
  current = locale;
  if (typeof document !== "undefined") document.documentElement.lang = INTL_TAGS[locale];
}

/** `en-US` or `es-MX`, for `Intl` formatters. */
export function intlLocale(): string {
  return INTL_TAGS[current];
}

type Vars = Record<string, string | number>;

function interpolate(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/** The current language's text for an English message, with `{name}` placeholders filled in. */
export function t(key: string, vars?: Vars): string {
  const dictionary = DICTIONARIES[current];
  if (!dictionary) return interpolate(key, vars);
  return interpolate(dictionary[key] ?? serverMessage(key) ?? key, vars);
}

/** Spanish for an error message from the API, when it is one the app knows. */
function serverMessage(message: string): string | undefined {
  if (current !== "es") return undefined;
  const exact = esServer[message];
  if (exact !== undefined) return exact;
  for (const [pattern, replacement] of esServerPatterns) {
    if (pattern.test(message)) return message.replace(pattern, replacement);
  }
  return undefined;
}

/**
 * Marks an English message for translation without translating it yet, for labels kept in
 * module-level constants; pass the value through `t()` where it is shown.
 */
export function msg(key: string): string {
  return key;
}

/**
 * Like `t()`, for a short word whose translation depends on where it is shown: `tc("lead tab",
 * "New")` is "Nuevas" on the Leads tabs while `t("New")` is the "Nueva" chip on a lead. The
 * dictionary key is `context|text`; English shows `text`.
 */
export function tc(context: string, text: string): string {
  const translated = DICTIONARIES[current]?.[`${context}|${text}`];
  return translated ?? text;
}

/** `one` when `count` is 1, otherwise `other`; `{count}` in either is the formatted count. */
export function tn(count: number, one: string, other: string, vars?: Vars): string {
  const formatted = new Intl.NumberFormat(intlLocale()).format(count);
  return t(count === 1 ? one : other, { count: formatted, ...vars });
}

/**
 * Like `t()`, for a message with elements inside it: `{name}` placeholders take React nodes.
 * `tx("Open {settings} to connect Gmail.", { settings: <Link …>Settings</Link> })`.
 */
export function tx(key: string, parts: Record<string, ReactNode>): ReactNode {
  const text = t(key);
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(/\{(\w+)\}/g)) {
    const name = match[1] as string;
    if (!(name in parts)) continue;
    out.push(text.slice(last, match.index));
    out.push(<Fragment key={`${name}-${match.index}`}>{parts[name]}</Fragment>);
    last = match.index + match[0].length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

interface LocaleValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

const LocaleContext = createContext<LocaleValue>({ locale: "en", setLocale: () => {} });

export function useLocale(): LocaleValue {
  return useContext(LocaleContext);
}

/**
 * Holds the language choice. Changing it re-mounts the app below, so every `t()` call renders
 * again in the new language (a rare, deliberate switch; open dialogs close).
 */
export function LocaleProvider({ children, initial }: { children: ReactNode; initial?: Locale }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const first = initial ?? detectLocale();
    setLocale(first);
    return first;
  });

  useEffect(() => {
    setLocale(locale);
  }, [locale]);

  const change = useCallback((next: Locale) => {
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // storage is blocked: the choice lasts until the page is closed
    }
    setLocale(next);
    setLocaleState(next);
  }, []);

  const value = useMemo(() => ({ locale, setLocale: change }), [locale, change]);
  return (
    <LocaleContext.Provider value={value}>
      <Fragment key={locale}>{children}</Fragment>
    </LocaleContext.Provider>
  );
}
