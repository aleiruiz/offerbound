import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageSelect } from "../components/LanguageSelect";
import { formatCompensation, formatDate, formatRelative, rowsLabel } from "../lib/format";
import { es } from "./es";
import {
  LOCALE_STORAGE_KEY,
  LocaleProvider,
  detectLocale,
  getLocale,
  setLocale,
  t,
  tc,
  tn,
  tx,
} from "./index";

// Every source file of the app, as text, to find the messages it shows.
const SOURCES = import.meta.glob<string>(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}", "!./**"], {
  query: "?raw",
  import: "default",
  eager: true,
});

const LITERAL = String.raw`"((?:[^"\\]|\\.)*)"`;

function messagesInSource(): Map<string, string> {
  const found = new Map<string, string>();
  const add = (raw: string, file: string) => {
    const key = JSON.parse(`"${raw}"`) as string;
    if (!found.has(key)) found.set(key, file);
  };
  for (const [file, text] of Object.entries(SOURCES)) {
    for (const m of text.matchAll(
      new RegExp(String.raw`(?<![\w.])(?:t|msg|tx)\(\s*${LITERAL}`, "g"),
    )) {
      add(m[1] as string, file);
    }
    for (const m of text.matchAll(
      new RegExp(String.raw`(?<![\w.])tn\(\s*[^,]+,\s*${LITERAL},\s*${LITERAL}`, "g"),
    )) {
      add(m[1] as string, file);
      add(m[2] as string, file);
    }
    for (const m of text.matchAll(
      new RegExp(String.raw`(?<![\w.])tc\(\s*${LITERAL},\s*${LITERAL}`, "g"),
    )) {
      add(`${m[1] as string}|${m[2] as string}`, file);
    }
  }
  return found;
}

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("the Spanish dictionary", () => {
  const messages = messagesInSource();

  it("uses the context for words that need one", () => {
    setLocale("es");
    expect(t("New")).toBe("Nueva");
    expect(tc("lead tab", "New")).toBe("Nuevas");
    setLocale("en");
    expect(tc("lead tab", "New")).toBe("New");
  });

  it("finds the app's messages", () => {
    expect(messages.size).toBeGreaterThan(500);
  });

  it("has a translation for every message the app shows", () => {
    const missing = [...messages].filter(([key]) => !(key in es)).map(([k, f]) => `${f}: ${k}`);
    expect(missing).toEqual([]);
  });

  it("has no entry the app no longer uses", () => {
    expect(Object.keys(es).filter((key) => !messages.has(key))).toEqual([]);
  });

  it("keeps every placeholder of the English text", () => {
    const broken = Object.entries(es)
      .filter(([key, value]) => {
        const want = new Set(placeholders(key));
        const have = new Set(placeholders(value));
        return want.size !== have.size || [...want].some((p) => !have.has(p));
      })
      .map(([key]) => key);
    expect(broken).toEqual([]);
  });
});

describe("where messages are translated", () => {
  // A message translated while a module loads is frozen in English: it has to be translated
  // inside a function (at render), or kept with `msg()` and passed through `t()` where it is shown.
  it("never calls t(), tn() or tx() at module level", () => {
    const found: string[] = [];
    for (const [file, text] of Object.entries(SOURCES)) {
      const source = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const visit = (node: ts.Node, inFunction: boolean) => {
        const inside = inFunction || ts.isFunctionLike(node);
        if (
          !inside &&
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          ["t", "tn", "tx", "tc"].includes(node.expression.text)
        ) {
          found.push(`${file}: ${node.getText(source)}`);
        }
        ts.forEachChild(node, (child) => visit(child, inside));
      };
      visit(source, false);
    }
    expect(found).toEqual([]);
  });
});

describe("t, tn and tx", () => {
  it("shows the English text in English and the Spanish one in Spanish", () => {
    expect(t("Sync now")).toBe("Sync now");
    setLocale("es");
    expect(t("Sync now")).toBe("Sincronizar ahora");
  });

  it("falls back to the English text when a message has no translation", () => {
    setLocale("es");
    expect(t("A server message nobody translated.")).toBe("A server message nobody translated.");
  });

  it("translates the API's own error messages, including those with a value in them", () => {
    setLocale("es");
    expect(t("No such lead.")).toBe("No existe esa vacante.");
    expect(t('Status "Ghosted" isn\'t one Offerbound imports.')).toBe(
      'El estado "Ghosted" no es uno de los que Offerbound importa.',
    );
    setLocale("en");
    expect(t("No such lead.")).toBe("No such lead.");
  });

  it("fills placeholders, and leaves unknown ones as they are", () => {
    setLocale("es");
    expect(t("Added {company}", { company: "Kestrel" })).toBe("Se agregó Kestrel");
    expect(t("Added {company}")).toBe("Se agregó {company}");
  });

  it("picks the singular for 1 and formats the count for the language", () => {
    expect(tn(1, "1 lead", "{count} leads")).toBe("1 lead");
    expect(tn(2148, "1 lead", "{count} leads")).toBe("2,148 leads");
    setLocale("es");
    expect(tn(1, "1 lead", "{count} leads")).toBe("1 vacante");
    expect(tn(2148, "1 lead", "{count} leads")).toBe("2,148 vacantes");
  });

  it("puts elements into a translated sentence", () => {
    setLocale("es");
    render(
      <p>
        {tx("Run a search now, or turn the daily search on in {settings}.", {
          settings: <a href="/settings">x</a>,
        })}
      </p>,
    );
    expect(screen.getByText(/Busca ahora o activa la búsqueda diaria en/)).toHaveTextContent(
      "Busca ahora o activa la búsqueda diaria en x.",
    );
    expect(screen.getByRole("link", { name: "x" })).toBeInTheDocument();
  });
});

// A component, so its text is rendered again when the language changes (as `<App />` is).
function Shortcuts() {
  return <p>{t("Keyboard shortcuts")}</p>;
}

describe("the language choice", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("follows the browser when nothing is stored: Spanish for any es-*, otherwise English", () => {
    vi.stubGlobal("navigator", { ...navigator, languages: ["es-MX", "en"], language: "es-MX" });
    expect(detectLocale()).toBe("es");
    vi.stubGlobal("navigator", { ...navigator, languages: ["es-419"], language: "es-419" });
    expect(detectLocale()).toBe("es");
    vi.stubGlobal("navigator", { ...navigator, languages: ["pt-BR"], language: "pt-BR" });
    expect(detectLocale()).toBe("en");
  });

  it("prefers the stored choice over the browser", () => {
    vi.stubGlobal("navigator", { ...navigator, languages: ["es-MX"], language: "es-MX" });
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    expect(detectLocale()).toBe("en");
  });

  it("the Language select switches the page to Spanish, keeps the choice and sets <html lang>", async () => {
    const user = userEvent.setup({ delay: null });
    render(
      <LocaleProvider initial="en">
        <Shortcuts />
        <LanguageSelect />
      </LocaleProvider>,
    );
    expect(screen.getByText("Keyboard shortcuts")).toBeInTheDocument();
    await act(() => user.selectOptions(screen.getByRole("combobox", { name: "Language" }), "es"));
    expect(screen.getByText("Atajos de teclado")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Idioma" })).toHaveValue("es");
    expect(getLocale()).toBe("es");
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("es");
    expect(document.documentElement.lang).toBe("es-MX");
  });
});

describe("formats in Spanish", () => {
  it("writes dates, relative times, row counts and pay the Mexican way", () => {
    setLocale("es");
    expect(formatDate("2026-10-30T18:00:00Z", "America/Monterrey")).toBe("vie 30 de oct");
    const now = new Date("2026-10-30T18:00:00Z");
    expect(formatRelative("2026-10-28T18:00:00Z", now)).toBe("hace 2 días");
    expect(formatRelative("2026-10-30T17:59:50Z", now)).toBe("justo ahora");
    expect(rowsLabel(1)).toBe("1 fila");
    expect(rowsLabel(2148)).toBe("2,148 filas");
    expect(
      formatCompensation({
        min: 9500,
        max: 11000,
        currency: "USD",
        period: "month",
        isEstimate: false,
        basis: null,
      }),
    ).toBe("US$9.5–11k / mes");
    expect(
      formatCompensation({
        min: 8000,
        max: null,
        currency: "USD",
        period: "month",
        isEstimate: false,
        basis: null,
      }),
    ).toBe("Desde US$8k / mes");
  });
});
