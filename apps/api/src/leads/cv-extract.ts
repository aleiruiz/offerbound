import { Worker } from "node:worker_threads";
import { assertZipWithinLimits, ZipLimitError } from "./cv-zip.js";

export type CvKind = "pdf" | "docx";

/** Thrown when a file cannot be read within the limits: corrupt, too heavy, too slow. */
export class CvExtractionError extends Error {}

/** Wall-clock budget for one extraction (the spec's profile flow allows the upload ~60 s). */
export const EXTRACT_TIMEOUT_MS = 10_000;
/** Pages read from a PDF; the rest of a long document is not a CV. */
const MAX_PDF_PAGES = 30;
/** Heap cap for the extraction thread; exceeding it kills the thread, not the API. */
const WORKER_HEAP_MB = 512;

/**
 * Runs in a worker thread (plain CommonJS so it needs no build step). The parsers are loaded here,
 * not in the API process: a crafted file can burn CPU or memory inside pdf.js or mammoth, and a
 * thread can be terminated on a timer where the main thread cannot. The text sent back is cut to
 * `limit` characters before it is copied. Bytes arrive by message, so nothing touches the disk.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { createRequire } = require("node:module");
const load = createRequire(workerData.resolveFrom);

async function pdf(bytes, limit, maxPages) {
  const { PDFParse } = load("pdf-parse");
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getText({ first: maxPages });
    return result.pages.map((page) => page.text).join("\\n");
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

async function docx(bytes) {
  const mammoth = load("mammoth");
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return result.value;
}

(async () => {
  const { kind, bytes, limit, maxPages } = workerData;
  const text = kind === "pdf" ? await pdf(bytes, limit, maxPages) : await docx(bytes);
  // Skip leading whitespace without copying, then cut: the text can be enormous.
  const start = text.search(/\\S/);
  parentPort.postMessage({ text: start < 0 ? "" : text.slice(start, start + limit) });
})().catch(() => parentPort.postMessage({ failed: true }));
`;

let queue: Promise<unknown> = Promise.resolve();

function runWorker(
  kind: CvKind,
  bytes: Uint8Array,
  limit: number,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        kind,
        bytes,
        limit,
        maxPages: MAX_PDF_PAGES,
        resolveFrom: import.meta.url,
      },
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB, maxYoungGenerationSizeMb: 64 },
      env: {},
    });
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new CvExtractionError("timed out")));
    }, timeoutMs);
    worker.once("message", (message: { text?: string; failed?: true }) => {
      finish(() =>
        typeof message.text === "string"
          ? resolve(message.text)
          : reject(new CvExtractionError("unreadable")),
      );
    });
    worker.once("error", () => finish(() => reject(new CvExtractionError("worker failed"))));
    worker.once("exit", () => finish(() => reject(new CvExtractionError("worker exited"))));
  });
}

/**
 * Extracts raw text from PDF or DOCX bytes in a worker thread with a wall-clock timeout, a heap cap
 * and (for DOCX) a verified inflated-size cap. At most `limit` characters come back. Extractions
 * run one at a time so memory use stays bounded. Any failure is a {@link CvExtractionError} that
 * carries no file content.
 */
export function extractRawText(
  kind: CvKind,
  bytes: Buffer,
  limit: number,
  timeoutMs: number = EXTRACT_TIMEOUT_MS,
): Promise<string> {
  const job = queue.then(async () => {
    if (kind === "docx") {
      try {
        await assertZipWithinLimits(bytes);
      } catch (error) {
        if (error instanceof ZipLimitError) throw new CvExtractionError("zip limits");
        throw new CvExtractionError("zip unreadable");
      }
    }
    // A copy: the worker thread gets its own bytes.
    return runWorker(kind, new Uint8Array(bytes), limit, timeoutMs);
  });
  queue = job.catch(() => undefined);
  return job;
}
