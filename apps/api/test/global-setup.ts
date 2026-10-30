import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

// "postgres" is the hostname of the CI service container.
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "postgres"]);

/** Throws unless DATABASE_URL points at a local or CI test database named offerbound*. */
function assertTestDatabase(): void {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required to run the integration tests.");
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to touch the database while NODE_ENV is production.");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL.");
  }
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!ALLOWED_HOSTS.has(url.hostname) || !database.startsWith("offerbound")) {
    throw new Error(
      `Refusing to run integration tests against host "${url.hostname}" database "${database}": ` +
        'the host must be localhost, 127.0.0.1 or postgres and the database name must start with "offerbound".',
    );
  }
}

function prisma(args: string[]): void {
  try {
    execFileSync("pnpm", ["exec", "prisma", ...args], {
      cwd: repoRoot,
      env: process.env,
      stdio: "pipe",
      encoding: "utf8",
    });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    throw new Error(
      `prisma ${args.join(" ")} failed\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`.trim(),
    );
  }
}

/**
 * Brings the test database to the latest schema. In CI the database is throwaway, so it is reset
 * and every migration is replayed. Elsewhere (including agent sessions, where Prisma refuses to
 * run a reset) pending migrations are applied and `resetDb` truncates tables per test.
 */
export default function setup(): void {
  assertTestDatabase();
  if (process.env.CI) {
    prisma(["migrate", "reset", "--force", "--skip-seed", "--skip-generate"]);
  } else {
    prisma(["migrate", "deploy"]);
  }
}
