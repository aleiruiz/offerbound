import TextField from "@mui/material/TextField";
import { LOCALES, t, useLocale, type Locale } from "../i18n";

/**
 * The interface language, next to *Theme* in Settings and on the sign-in page. Each language is
 * named in itself, so the owner can find theirs whichever one is showing. The choice is kept in
 * this browser; without one, the browser's language decides.
 */
export function LanguageSelect({ size }: { size?: "small" | "medium" }) {
  const { locale, setLocale } = useLocale();
  return (
    <TextField
      select
      size={size}
      label={t("Language")}
      value={locale}
      onChange={(event) => setLocale(event.target.value as Locale)}
      slotProps={{ select: { native: true } }}
    >
      {LOCALES.map((option) => (
        <option key={option.value} value={option.value} lang={option.value}>
          {option.label}
        </option>
      ))}
    </TextField>
  );
}
