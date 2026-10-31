import TextField from "@mui/material/TextField";
import { isHttpUrl } from "../lib/url";
import { msg, t } from "../i18n";

export const REQUIRED_COMPANY = msg("Enter the company name");
export const REQUIRED_ROLE = msg("Enter the role");
export const BAD_LINK = msg("Enter a link that starts with http or https");

/** The error for a job link field, or null when it is empty or an http(s) address. */
export function jobLinkError(link: string): string | null {
  return link.trim() !== "" && !isHttpUrl(link.trim()) ? t(BAD_LINK) : null;
}

export interface CoreValues {
  company: string;
  role: string;
  jobUrl: string;
}

export type CoreErrors = Partial<Record<"companyName" | "title" | "jobUrl", string>>;

/** Company, role and job link: the fields *Add application* and *Edit details* share. */
export function CoreFields({
  values,
  errors,
  onChange,
  autoFocus = false,
}: {
  values: CoreValues;
  errors: CoreErrors;
  onChange: (change: Partial<CoreValues>) => void;
  autoFocus?: boolean;
}) {
  return (
    <>
      <TextField
        label={t("Company")}
        value={values.company}
        onChange={(e) => onChange({ company: e.target.value })}
        error={Boolean(errors.companyName)}
        helperText={errors.companyName}
        autoFocus={autoFocus}
        fullWidth
        slotProps={{ htmlInput: { "aria-required": true } }}
      />
      <TextField
        label={t("Role")}
        value={values.role}
        onChange={(e) => onChange({ role: e.target.value })}
        error={Boolean(errors.title)}
        helperText={errors.title}
        fullWidth
        slotProps={{ htmlInput: { "aria-required": true } }}
      />
      <TextField
        label={t("Job link")}
        type="url"
        value={values.jobUrl}
        onChange={(e) => onChange({ jobUrl: e.target.value })}
        error={Boolean(errors.jobUrl)}
        helperText={errors.jobUrl}
        fullWidth
      />
    </>
  );
}
