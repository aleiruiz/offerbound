import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { TextDecoder } from "node:util";
import ipaddr from "ipaddr.js";
import { Agent } from "undici";

/**
 * SSRF-guarded fetcher for the link check (SECURITY §8, TECHNICAL_SPEC §7.2).
 *
 * The URLs come from emails, web search and pasted text, and the server shares a Docker network
 * with other services, so every request is made like this:
 *  1. Only http/https on port 80 or 443, with no credentials in the URL.
 *  2. The host is resolved here, every answer is checked, and the request connects to the address
 *     that was checked: the connection's own lookup is replaced by one that returns it, so nothing
 *     is resolved a second time (no DNS-rebinding window between check and connect).
 *  3. Redirects are followed by hand, and every hop goes through steps 1 and 2 again.
 *  4. One deadline covers resolution, connection, redirects and body; the body is cut at 1 MB and
 *     read only for text/html, text/plain and application/json (an ATS posting API, such as
 *     Workday's).
 *  5. No cookies, no credentials, a fixed user agent.
 *
 * Nothing here logs. Error messages name the host and never the path or query string.
 */

export const USER_AGENT = "Offerbound/1.0 (+https://offerbound.northsoftmx.com)";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 1_048_576;
const READABLE_TYPES: ReadonlySet<string> = new Set([
  "text/html",
  "text/plain",
  "application/json",
]);
const ALLOWED_PORTS: ReadonlySet<number> = new Set([80, 443]);
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** The cloud metadata address; it is link-local, so the range check also catches it. */
const METADATA_ADDRESS = "169.254.169.254";

type Address = ipaddr.IPv4 | ipaddr.IPv6;

/**
 * True for any address a link check must not connect to: everything ipaddr.js does not class as
 * ordinary unicast (loopback, private, link-local, CGNAT, multicast, unspecified, broadcast,
 * reserved, unique-local, 6to4, Teredo, NAT64, ...), the metadata address, and any IPv6 form that
 * wraps or embeds an IPv4 address (the wrapped address is judged instead). Text that is not an
 * IP address counts as forbidden, so a caller that forgets to resolve fails closed.
 */
export function isForbiddenAddress(ip: string): boolean {
  const text = ip.trim();
  // Only canonical spellings: ipaddr.js also reads "1.2.3" and "2130706433" as IPv4 addresses.
  if (!ipaddr.IPv4.isValidFourPartDecimal(text) && !ipaddr.IPv6.isValid(text)) return true;
  let address: Address;
  try {
    address = ipaddr.parse(text);
  } catch {
    return true;
  }
  if (address.kind() === "ipv6") {
    const v6 = address as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      address = v6.toIPv4Address();
    } else {
      const p = v6.parts;
      // ::/96 holds :: and the deprecated IPv4-compatible form ::a.b.c.d.
      if (p.slice(0, 6).every((part) => part === 0)) return true;
      // ISATAP embeds an IPv4 address after the interface id 0:5efe or 200:5efe.
      if ((p[4] === 0 || p[4] === 0x200) && p[5] === 0x5efe) return true;
    }
  }
  if (address.toString() === METADATA_ADDRESS) return true;
  return address.range() !== "unicast";
}

export type LinkFetchErrorCode =
  | "url"
  | "scheme"
  | "port"
  | "credentials"
  | "blocked"
  | "dns"
  | "redirects"
  | "timeout"
  | "encoding"
  | "network";

/** Why a fetch was refused or failed. The message never carries a path or query string. */
export class LinkFetchError extends Error {
  readonly code: LinkFetchErrorCode;
  constructor(code: LinkFetchErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LinkFetchError";
    this.code = code;
  }
}

export type LinkFetcher = (
  url: string,
) => Promise<{ status: number; finalUrl: string; contentType: string | null; body: string }>;

/** One request to an address that has already been validated. */
export type PinnedRequest = {
  url: URL;
  address: string;
  family: 4 | 6;
  headers: Record<string, string>;
  signal: AbortSignal;
};

export type TransportResponse = {
  status: number;
  /** Header names in lower case; a repeated header keeps its first value. */
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  /** Releases the connection; called exactly once per response. */
  close: () => void;
};

export type Transport = (request: PinnedRequest) => Promise<TransportResponse>;

/**
 * A connection lookup that always answers with one address. Node asks for every address
 * (`all: true`) when it tries IPv4 and IPv6 in turn, and for a single one otherwise.
 */
export function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

/**
 * The real transport: an undici Agent per request whose connect lookup is pinned to the validated
 * address. TLS still verifies the certificate against the URL's host name. Redirects are not
 * followed, there is no cookie jar and nothing is decompressed.
 */
export const undiciTransport: Transport = async (request) => {
  const agent = new Agent({
    connect: { lookup: pinnedLookup(request.address, request.family) },
    connections: 1,
  });
  const release = (): void => {
    void agent.destroy().catch(() => undefined);
  };
  try {
    const response = await agent.request({
      origin: request.url.origin,
      path: `${request.url.pathname}${request.url.search}`,
      method: "GET",
      headers: request.headers,
      signal: request.signal,
    });
    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(response.headers)) {
      headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
    }
    return {
      status: response.statusCode,
      headers,
      body: response.body,
      close: () => {
        response.body.destroy();
        release();
      },
    };
  } catch (error) {
    release();
    throw error;
  }
};

async function systemLookup(host: string): Promise<string[]> {
  const answers = await dnsLookup(host, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new LinkFetchError("network", "The link check was cancelled");
}

/** Settles with `promise`, or rejects with the signal's reason as soon as the signal aborts. */
function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  dispose?: (late: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      void promise.then(dispose, () => undefined);
      reject(abortReason(signal));
      return;
    }
    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (aborted) dispose?.(value);
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (aborted) return;
        reject(
          error instanceof Error
            ? error
            : new LinkFetchError("network", "The request failed", { cause: error }),
        );
      },
    );
  });
}

function checkedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LinkFetchError("url", "The link is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LinkFetchError("scheme", "Only http and https links can be checked");
  }
  if (url.username !== "" || url.password !== "") {
    throw new LinkFetchError("credentials", `The link to ${url.hostname} carries credentials`);
  }
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!ALLOWED_PORTS.has(port)) {
    throw new LinkFetchError("port", `Port ${port} on ${url.hostname} is not allowed`);
  }
  return url;
}

function isIpLiteral(hostname: string): boolean {
  return hostname.startsWith("[") || ipaddr.IPv4.isValidFourPartDecimal(hostname);
}

type Target = { address: string; family: 4 | 6 };

/** Resolves the host, checks every answer, and returns the one address to connect to. */
async function validatedTarget(
  url: URL,
  lookup: (host: string) => Promise<string[]>,
  signal: AbortSignal,
): Promise<Target> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let answers: string[];
  if (isIpLiteral(url.hostname)) {
    answers = [host];
  } else {
    try {
      answers = await abortable(lookup(host), signal);
    } catch (error) {
      if (error instanceof LinkFetchError) throw error;
      throw new LinkFetchError("dns", `Could not resolve ${host}`, { cause: error });
    }
  }
  if (answers.length === 0) throw new LinkFetchError("dns", `Could not resolve ${host}`);
  if (answers.some(isForbiddenAddress)) {
    throw new LinkFetchError("blocked", `${host} resolves to an address that is not allowed`);
  }
  const parsed = answers.map((answer): Target => {
    const address = ipaddr.parse(answer.trim());
    if (address.kind() === "ipv6" && (address as ipaddr.IPv6).isIPv4MappedAddress()) {
      return { address: (address as ipaddr.IPv6).toIPv4Address().toString(), family: 4 };
    }
    return { address: answer.trim(), family: address.kind() === "ipv6" ? 6 : 4 };
  });
  // Prefer IPv4: the server's network is more likely to reach it.
  return parsed.find((target) => target.family === 4) ?? parsed[0]!;
}

function mediaType(contentType: string | undefined): string {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase();
}

function decoderFor(contentType: string | undefined): TextDecoder {
  const charset = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType ?? "")?.[1];
  if (charset) {
    try {
      return new TextDecoder(charset);
    } catch {
      // An unknown label: fall back to UTF-8.
    }
  }
  return new TextDecoder("utf-8");
}

async function readCapped(
  body: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const read = async (): Promise<void> => {
    for await (const chunk of body) {
      const room = MAX_BODY_BYTES - total;
      if (chunk.length >= room) {
        chunks.push(chunk.subarray(0, room));
        total += room;
        return;
      }
      chunks.push(chunk);
      total += chunk.length;
    }
  };
  await abortable(read(), signal);
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return all;
}

export type SafeFetcherOptions = {
  /** Resolves a host name to its addresses. Defaults to the system resolver. */
  lookup?: (host: string) => Promise<string[]>;
  timeoutMs?: number;
  /** Sends a request to a validated address. Defaults to undici; tests replace it. */
  transport?: Transport;
};

export function createSafeFetcher(opts: SafeFetcherOptions = {}): LinkFetcher {
  const lookup = opts.lookup ?? systemLookup;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const transport = opts.transport ?? undiciTransport;
  const headers = {
    "user-agent": USER_AGENT,
    accept: "text/html, text/plain;q=0.9, application/json;q=0.5",
    "accept-encoding": "identity",
  };

  async function run(
    startUrl: string,
    signal: AbortSignal,
  ): Promise<{ status: number; finalUrl: string; contentType: string | null; body: string }> {
    let next = startUrl;
    for (let redirects = 0; ; redirects += 1) {
      const url = checkedUrl(next);
      const target = await validatedTarget(url, lookup, signal);
      let response: TransportResponse;
      try {
        response = await abortable(
          transport({ url, address: target.address, family: target.family, headers, signal }),
          signal,
          (late) => late.close(),
        );
      } catch (error) {
        if (error instanceof LinkFetchError) throw error;
        if (signal.aborted) throw abortReason(signal);
        throw new LinkFetchError("network", `The request to ${url.hostname} failed`, {
          cause: error,
        });
      }
      try {
        const contentType = response.headers["content-type"];
        if (REDIRECT_STATUSES.has(response.status) && response.headers.location) {
          if (redirects >= MAX_REDIRECTS) {
            throw new LinkFetchError("redirects", "Too many redirects");
          }
          try {
            next = new URL(response.headers.location, url).href;
          } catch {
            throw new LinkFetchError("url", `A redirect from ${url.hostname} is not a valid URL`);
          }
          continue;
        }
        const result = {
          status: response.status,
          finalUrl: url.href,
          contentType: contentType ?? null,
          body: "",
        };
        const readable =
          response.status >= 200 &&
          response.status < 300 &&
          READABLE_TYPES.has(mediaType(contentType));
        if (!readable) return result;
        const encoding = (response.headers["content-encoding"] ?? "identity").trim().toLowerCase();
        if (encoding !== "identity") {
          throw new LinkFetchError("encoding", `${url.hostname} sent a compressed body`);
        }
        try {
          result.body = decoderFor(contentType).decode(await readCapped(response.body, signal));
        } catch (error) {
          if (error instanceof LinkFetchError) throw error;
          if (signal.aborted) throw abortReason(signal);
          throw new LinkFetchError("network", `Reading the page from ${url.hostname} failed`, {
            cause: error,
          });
        }
        return result;
      } finally {
        response.close();
      }
    }
  }

  return async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new LinkFetchError("timeout", "The link check timed out"));
    }, timeoutMs);
    try {
      return await run(url, controller.signal);
    } finally {
      clearTimeout(timer);
      // Releases anything a stalled step left behind.
      controller.abort(new LinkFetchError("network", "The link check finished"));
    }
  };
}
