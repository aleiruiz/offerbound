import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LinkFetchError,
  USER_AGENT,
  createSafeFetcher,
  isForbiddenAddress,
  pinnedLookup,
  undiciTransport,
  type PinnedRequest,
  type Transport,
  type TransportResponse,
} from "./ssrf.js";

const PUBLIC_IP = "93.184.216.34";

describe("isForbiddenAddress", () => {
  it("forbids 127.0.0.1, 10.1.2.3, 172.16.0.1, 192.168.1.1, 169.254.169.254, 100.64.0.1, 224.0.0.1, ::1, fc00::1, fe80::1 and ::ffff:127.0.0.1; allows 8.8.8.8", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "224.0.0.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isForbiddenAddress(ip), ip).toBe(true);
    }
    expect(isForbiddenAddress("8.8.8.8")).toBe(false);
  });

  it("forbids the unspecified, broadcast, docker bridge, reserved and benchmarking IPv4 ranges", () => {
    for (const ip of [
      "0.0.0.0",
      "0.1.2.3",
      "255.255.255.255",
      "172.17.0.2",
      "172.31.255.255",
      "192.0.0.1",
      "198.18.0.1",
      "240.0.0.1",
    ]) {
      expect(isForbiddenAddress(ip), ip).toBe(true);
    }
    expect(isForbiddenAddress("172.32.0.1")).toBe(false);
    expect(isForbiddenAddress("100.128.0.1")).toBe(false);
  });

  it("forbids IPv6 forms that wrap or embed a forbidden address", () => {
    for (const ip of [
      "::",
      "::ffff:7f00:1",
      "::ffff:10.0.0.1",
      "::ffff:169.254.169.254",
      "::ffff:a9fe:a9fe",
      "::7f00:1",
      "::127.0.0.1",
      "::a9fe:a9fe",
      "::ffff:0:127.0.0.1",
      "64:ff9b::7f00:1",
      "64:ff9b:1::1",
      "2002:7f00:1::",
      "2002:a00:1::1",
      "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      "2001:db8:1::5efe:7f00:1",
      "2001:4860:4860:0:200:5efe:7f00:1",
      "fd00:ec2::254",
      "fec0::1",
      "ff02::1",
      "100::1",
      "fe80::1%eth0",
    ]) {
      expect(isForbiddenAddress(ip), ip).toBe(true);
    }
  });

  it("allows public IPv6 and IPv4-mapped public addresses", () => {
    expect(isForbiddenAddress("2606:4700::1111")).toBe(false);
    expect(isForbiddenAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("fails closed on anything that is not an IP address", () => {
    for (const value of [
      "",
      "localhost",
      "example.com",
      "1.2.3",
      "1.2.3.4.5",
      "::g",
      "999.1.1.1",
    ]) {
      expect(isForbiddenAddress(value), value).toBe(true);
    }
  });
});

type Reply = Partial<{
  status: number;
  headers: Record<string, string>;
  chunks: Uint8Array[];
}>;

/** A transport that serves canned replies by URL and records every request it receives. */
function fakeTransport(serve: (req: PinnedRequest) => Reply | Promise<Reply>) {
  const calls: PinnedRequest[] = [];
  const closed: PinnedRequest[] = [];
  const consumed: PinnedRequest[] = [];
  const transport: Transport = async (req) => {
    calls.push(req);
    const reply = await serve(req);
    async function* body() {
      await Promise.resolve();
      consumed.push(req);
      for (const chunk of reply.chunks ?? []) yield chunk;
    }
    const response: TransportResponse = {
      status: reply.status ?? 200,
      headers: { "content-type": "text/html; charset=utf-8", ...reply.headers },
      body: body(),
      close: () => {
        closed.push(req);
      },
    };
    return response;
  };
  return { transport, calls, closed, consumed };
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const publicLookup = () => Promise.resolve([PUBLIC_IP]);
const redirect = (location: string): Reply => ({ status: 302, headers: { location } });

describe("createSafeFetcher", () => {
  it("refuses ftp: URLs and port 8080", async () => {
    const lookups: string[] = [];
    const { transport, calls } = fakeTransport(() => ({ chunks: [text("hi")] }));
    const fetcher = createSafeFetcher({
      lookup: (host) => {
        lookups.push(host);
        return Promise.resolve([PUBLIC_IP]);
      },
      transport,
    });
    await expect(fetcher("ftp://jobs.example/file")).rejects.toMatchObject({ code: "scheme" });
    await expect(fetcher("file:///etc/passwd")).rejects.toMatchObject({ code: "scheme" });
    await expect(fetcher("http://jobs.example:8080/")).rejects.toMatchObject({ code: "port" });
    await expect(fetcher("https://jobs.example:22/")).rejects.toMatchObject({ code: "port" });
    await expect(fetcher("not a url")).rejects.toMatchObject({ code: "url" });
    expect(lookups).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("allows the default ports and an explicit 80 or 443", async () => {
    const { transport, calls } = fakeTransport(() => ({ chunks: [text("ok")] }));
    const fetcher = createSafeFetcher({ lookup: publicLookup, transport });
    await fetcher("http://jobs.example/a");
    await fetcher("https://jobs.example:443/b");
    await fetcher("http://jobs.example:80/c");
    expect(calls).toHaveLength(3);
  });

  it("refuses URLs that carry credentials", async () => {
    const { transport, calls } = fakeTransport(() => ({}));
    const fetcher = createSafeFetcher({ lookup: publicLookup, transport });
    await expect(fetcher("https://user:secret@jobs.example/")).rejects.toMatchObject({
      code: "credentials",
    });
    expect(calls).toEqual([]);
  });

  it("refuses a host that resolves to a private address", async () => {
    const { transport, calls } = fakeTransport(() => ({}));
    for (const resolved of [
      ["10.0.0.5"],
      ["127.0.0.1"],
      ["::1"],
      ["::ffff:192.168.1.10"],
      ["169.254.169.254"],
      // One bad answer poisons the lot, whatever order they come in.
      [PUBLIC_IP, "127.0.0.1"],
      ["127.0.0.1", PUBLIC_IP],
    ]) {
      const fetcher = createSafeFetcher({ lookup: () => Promise.resolve(resolved), transport });
      await expect(fetcher("https://jobs.example/x"), resolved.join()).rejects.toMatchObject({
        code: "blocked",
      });
    }
    expect(calls).toEqual([]);
  });

  it("refuses IP-literal hosts in every spelling without a lookup", async () => {
    const { transport, calls } = fakeTransport(() => ({}));
    let lookups = 0;
    const fetcher = createSafeFetcher({
      lookup: () => {
        lookups += 1;
        return Promise.resolve([PUBLIC_IP]);
      },
      transport,
    });
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[fd00:ec2::254]/",
      "http://2130706433/",
      "http://0x7f.1/",
      "http://0177.0.0.1/",
    ]) {
      await expect(fetcher(url), url).rejects.toMatchObject({ code: "blocked" });
    }
    expect(lookups).toBe(0);
    expect(calls).toEqual([]);
  });

  it("refuses localhost through the system resolver", async () => {
    const { transport, calls } = fakeTransport(() => ({}));
    // The default lookup reads /etc/hosts for localhost; no network is involved.
    const fetcher = createSafeFetcher({ transport });
    await expect(fetcher("http://localhost/")).rejects.toMatchObject({ code: "blocked" });
    expect(calls).toEqual([]);
  });

  it("refuses an empty or failed resolution", async () => {
    const { transport, calls } = fakeTransport(() => ({}));
    const empty = createSafeFetcher({ lookup: () => Promise.resolve([]), transport });
    await expect(empty("https://jobs.example/")).rejects.toMatchObject({ code: "dns" });
    const failing = createSafeFetcher({
      lookup: () => Promise.reject(new Error("ENOTFOUND")),
      transport,
    });
    await expect(failing("https://jobs.example/")).rejects.toMatchObject({ code: "dns" });
    expect(calls).toEqual([]);
  });

  it("connects to the address it validated, resolving each host once per hop", async () => {
    const lookups: string[] = [];
    const { transport, calls } = fakeTransport((req) =>
      req.url.hostname === "jobs.example"
        ? redirect("https://careers.example/role")
        : { chunks: [text("hello")] },
    );
    const answers: Record<string, string[]> = {
      "jobs.example": ["2606:4700::1111", PUBLIC_IP],
      "careers.example": ["8.8.8.8"],
    };
    const fetcher = createSafeFetcher({
      lookup: (host) => {
        lookups.push(host);
        return Promise.resolve(answers[host] ?? []);
      },
      transport,
    });
    const result = await fetcher("https://jobs.example/start");
    expect(lookups).toEqual(["jobs.example", "careers.example"]);
    expect(calls.map((c) => [c.url.hostname, c.address, c.family])).toEqual([
      ["jobs.example", PUBLIC_IP, 4],
      ["careers.example", "8.8.8.8", 4],
    ]);
    expect(result.finalUrl).toBe("https://careers.example/role");
  });

  it("uses an IPv6 answer when there is no IPv4 one", async () => {
    const { transport, calls } = fakeTransport(() => ({ chunks: [text("x")] }));
    const fetcher = createSafeFetcher({
      lookup: () => Promise.resolve(["2606:4700::1111"]),
      transport,
    });
    await fetcher("https://jobs.example/");
    expect(calls[0]).toMatchObject({ address: "2606:4700::1111", family: 6 });
  });

  it("re-validates a redirect to http://169.254.169.254/ and refuses it", async () => {
    const { transport, calls } = fakeTransport((req) =>
      req.url.hostname === "jobs.example"
        ? redirect("http://169.254.169.254/latest/meta-data/")
        : {},
    );
    const fetcher = createSafeFetcher({ lookup: publicLookup, transport });
    await expect(fetcher("https://jobs.example/start")).rejects.toMatchObject({ code: "blocked" });
    expect(calls.map((c) => c.url.hostname)).toEqual(["jobs.example"]);
  });

  it("re-validates a redirect to a host that resolves to a private address, a bad scheme or a bad port", async () => {
    for (const [location, code] of [
      ["https://internal.example/", "blocked"],
      ["ftp://jobs.example/file", "scheme"],
      ["http://jobs.example:8080/", "port"],
      ["http://[::1]/", "blocked"],
      ["https://user:pw@jobs.example/", "credentials"],
    ] as const) {
      const { transport, calls } = fakeTransport((req) =>
        req.url.pathname === "/start" ? redirect(location) : {},
      );
      const fetcher = createSafeFetcher({
        lookup: (host) => Promise.resolve(host === "internal.example" ? ["10.0.0.9"] : [PUBLIC_IP]),
        transport,
      });
      await expect(fetcher("https://jobs.example/start"), location).rejects.toMatchObject({ code });
      expect(calls).toHaveLength(1);
    }
  });

  it("resolves a relative redirect against the current URL", async () => {
    const { transport, calls } = fakeTransport((req) =>
      req.url.pathname === "/a/b" ? redirect("../c?x=1") : { chunks: [text("end")] },
    );
    const fetcher = createSafeFetcher({ lookup: publicLookup, transport });
    const result = await fetcher("https://jobs.example/a/b");
    expect(result.finalUrl).toBe("https://jobs.example/c?x=1");
    expect(calls).toHaveLength(2);
  });

  it("follows 5 redirects and refuses the 6th", async () => {
    const chain = (hops: number) =>
      fakeTransport((req) => {
        const n = Number(req.url.pathname.slice(1));
        return n < hops ? redirect(`/${n + 1}`) : { chunks: [text("done")] };
      });
    const five = chain(5);
    const ok = await createSafeFetcher({ lookup: publicLookup, transport: five.transport })(
      "https://jobs.example/0",
    );
    expect(ok.status).toBe(200);
    expect(five.calls).toHaveLength(6);

    const six = chain(6);
    await expect(
      createSafeFetcher({ lookup: publicLookup, transport: six.transport })(
        "https://jobs.example/0",
      ),
    ).rejects.toMatchObject({ code: "redirects" });
    expect(six.calls).toHaveLength(6);
  });

  it("returns a redirect status without a Location as it is", async () => {
    const { transport } = fakeTransport(() => ({ status: 302 }));
    const fetcher = createSafeFetcher({ lookup: publicLookup, transport });
    expect(await fetcher("https://jobs.example/")).toMatchObject({ status: 302, body: "" });
  });

  it("sends the fixed user agent and no cookies or credentials, on every hop", async () => {
    const { transport, calls } = fakeTransport((req) =>
      req.url.pathname === "/start"
        ? { status: 302, headers: { location: "/next", "set-cookie": "sid=abc; Path=/" } }
        : { chunks: [text("ok")] },
    );
    const fetcher = createSafeFetcher({ lookup: publicLookup, transport });
    await fetcher("https://jobs.example/start");
    expect(USER_AGENT).toBe("Offerbound/1.0 (+https://offerbound.northsoftmx.com)");
    for (const call of calls) {
      expect(call.headers["user-agent"]).toBe(USER_AGENT);
      const names = Object.keys(call.headers).map((n) => n.toLowerCase());
      expect(names).not.toContain("cookie");
      expect(names).not.toContain("authorization");
      expect(names).not.toContain("referer");
    }
  });

  it("reads at most 1 MB, and only from text/html or text/plain", async () => {
    const chunk = new Uint8Array(600_000).fill(97);
    const big = fakeTransport(() => ({ chunks: [chunk, chunk, chunk] }));
    const result = await createSafeFetcher({ lookup: publicLookup, transport: big.transport })(
      "https://jobs.example/",
    );
    expect(result.body).toHaveLength(1_048_576);
    expect(big.closed).toHaveLength(1);

    for (const contentType of ["text/plain", "TEXT/HTML; charset=iso-8859-1"]) {
      const t = fakeTransport(() => ({
        headers: { "content-type": contentType },
        chunks: [text("x")],
      }));
      const r = await createSafeFetcher({ lookup: publicLookup, transport: t.transport })(
        "https://jobs.example/",
      );
      expect(r.body, contentType).toBe("x");
      expect(r.contentType).toBe(contentType);
    }
    for (const contentType of ["application/pdf", "image/png", "application/json", ""]) {
      const t = fakeTransport(() => ({
        headers: { "content-type": contentType },
        chunks: [text("x")],
      }));
      const r = await createSafeFetcher({ lookup: publicLookup, transport: t.transport })(
        "https://jobs.example/",
      );
      expect(r.body, contentType).toBe("");
      expect(t.consumed, contentType).toEqual([]);
      expect(t.closed, contentType).toHaveLength(1);
    }
  });

  it("does not read the body of an error status", async () => {
    const t = fakeTransport(() => ({ status: 500, chunks: [text("boom")] }));
    const r = await createSafeFetcher({ lookup: publicLookup, transport: t.transport })(
      "https://jobs.example/",
    );
    expect(r).toMatchObject({ status: 500, body: "" });
    expect(t.consumed).toEqual([]);
  });

  it("refuses a compressed body it was not asked for", async () => {
    const t = fakeTransport(() => ({
      headers: { "content-encoding": "gzip" },
      chunks: [text("x")],
    }));
    await expect(
      createSafeFetcher({ lookup: publicLookup, transport: t.transport })("https://jobs.example/"),
    ).rejects.toMatchObject({ code: "encoding" });
    expect(t.closed).toHaveLength(1);
  });

  it("times out a request that never answers, a resolver that never answers and a body that stalls", async () => {
    const hang = new Promise<never>(() => undefined);

    const stalled: Transport = () => hang;
    await expect(
      createSafeFetcher({ lookup: publicLookup, transport: stalled, timeoutMs: 20 })(
        "https://jobs.example/",
      ),
    ).rejects.toMatchObject({ code: "timeout" });

    await expect(
      createSafeFetcher({ lookup: () => hang, transport: stalled, timeoutMs: 20 })(
        "https://jobs.example/",
      ),
    ).rejects.toMatchObject({ code: "timeout" });

    const slowBody: Transport = () =>
      Promise.resolve({
        status: 200,
        headers: { "content-type": "text/html" },
        body: (async function* () {
          yield text("start");
          await hang;
        })(),
        close: () => undefined,
      });
    await expect(
      createSafeFetcher({ lookup: publicLookup, transport: slowBody, timeoutMs: 20 })(
        "https://jobs.example/",
      ),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("applies one deadline across all redirect hops", async () => {
    const transport: Transport = async (req) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return {
        status: 302,
        headers: { location: `/${req.url.pathname.length}x` },
        body: (async function* () {})(),
        close: () => undefined,
      };
    };
    await expect(
      createSafeFetcher({ lookup: publicLookup, transport, timeoutMs: 40 })(
        "https://jobs.example/0",
      ),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("puts only the host, never the path or query, in error messages", async () => {
    const { transport } = fakeTransport(() => ({}));
    const fetcher = createSafeFetcher({ lookup: () => Promise.resolve(["10.0.0.1"]), transport });
    const error = await fetcher("https://jobs.example/secret/path?token=abc123").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(LinkFetchError);
    expect((error as Error).message).not.toMatch(/secret|token|abc123/);
    expect((error as Error).message).toContain("jobs.example");
  });
});

describe("pinnedLookup", () => {
  it("answers every lookup with the pinned address, in both callback shapes", () => {
    const lookup = pinnedLookup("93.184.216.34", 4);
    lookup("other.example", {}, (err, address, family) => {
      expect([err, address, family]).toEqual([null, "93.184.216.34", 4]);
    });
    // Node 20+ asks for every address when happy eyeballs is on.
    lookup("other.example", { all: true }, (err, addresses) => {
      expect([err, addresses]).toEqual([null, [{ address: "93.184.216.34", family: 4 }]]);
    });
  });
});

describe("undiciTransport (against a local server)", () => {
  let server: Server;
  let port: number;
  const seen: { url: string; headers: IncomingHttpHeaders }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ url: req.url ?? "", headers: req.headers });
      if (req.url?.startsWith("/redirect")) {
        res.writeHead(302, { location: "http://169.254.169.254/", "set-cookie": "sid=1" });
        res.end();
      } else if (req.url?.startsWith("/slow")) {
        res.writeHead(200, { "content-type": "text/html" });
        res.write("start");
      } else {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<p>hello</p>");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function drain(response: TransportResponse): Promise<string> {
    const parts: string[] = [];
    for await (const chunk of response.body) parts.push(Buffer.from(chunk).toString("utf8"));
    response.close();
    return parts.join("");
  }

  it("connects to the pinned address and never resolves the URL's host", async () => {
    // pinned-host.invalid cannot resolve: reaching the server proves the pinned address was used.
    const response = await undiciTransport({
      url: new URL(`http://pinned-host.invalid:${port}/page?q=1#frag`),
      address: "127.0.0.1",
      family: 4,
      headers: { "user-agent": USER_AGENT, accept: "text/html" },
      signal: new AbortController().signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(await drain(response)).toBe("<p>hello</p>");
    const request = seen.at(-1);
    expect(request?.url).toBe("/page?q=1");
    expect(request?.headers.host).toBe(`pinned-host.invalid:${port}`);
    expect(request?.headers["user-agent"]).toBe(USER_AGENT);
    expect(request?.headers.cookie).toBeUndefined();
    expect(request?.headers.authorization).toBeUndefined();
  });

  it("does not follow redirects itself", async () => {
    const response = await undiciTransport({
      url: new URL(`http://pinned-host.invalid:${port}/redirect`),
      address: "127.0.0.1",
      family: 4,
      headers: { "user-agent": USER_AGENT },
      signal: new AbortController().signal,
    });
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("http://169.254.169.254/");
    await drain(response);
  });

  it("stops when the signal aborts", async () => {
    const controller = new AbortController();
    const response = await undiciTransport({
      url: new URL(`http://pinned-host.invalid:${port}/slow`),
      address: "127.0.0.1",
      family: 4,
      headers: { "user-agent": USER_AGENT },
      signal: controller.signal,
    });
    const reading = drain(response);
    controller.abort(new Error("stop"));
    await expect(reading).rejects.toThrow();
  });
});
