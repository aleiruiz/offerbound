import { ApiClientError } from "../api/client";

/** What the CV and spreadsheet choosers accept, and the size limits (PRD: CV <= 5 MB, CSV <= 2 MB). */

const MB = 1024 * 1024;
export const CV_MAX_BYTES = 5 * MB;
export const CSV_MAX_BYTES = 2 * MB;
export const CV_ACCEPT =
  ".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const CSV_ACCEPT = ".csv,text/csv";

/** The OS file picker can bypass `accept`, so the page checks the extension or MIME type too. */
export function hasAllowedType(file: File, accept: string): boolean {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return accept
    .split(",")
    .some((entry) => (entry.startsWith(".") ? name.endsWith(entry) : type === entry));
}

export type FileRejection = "unsupported_file" | "too_large";

/** Why a chosen file is turned away before it is sent, or null when it can go. */
export function rejectFile(file: File, accept: string, maxBytes: number): FileRejection | null {
  if (!hasAllowedType(file, accept)) return "unsupported_file";
  return file.size > maxBytes ? "too_large" : null;
}

/** What to tell the owner when a CV upload, or the page's own check, fails. */
export function cvErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    switch (error.code) {
      case "cv_no_text":
        return "We couldn't read text from that file. It may be a scan or an image; export a version with text you can select, then add it again.";
      case "unsupported_file":
        return "Offerbound reads PDF and DOCX files. Choose one of those.";
      case "too_large":
        return "That file is larger than 5 MB. Choose a smaller one.";
      default:
        return error.message;
    }
  }
  return "The upload didn't go through. Check your connection and try again.";
}

/** The page's own rejection of a CV, worded like the server's. */
export function cvRejectionMessage(reason: FileRejection): string {
  return cvErrorMessage(new ApiClientError({ status: 422, code: reason, message: "" }));
}
