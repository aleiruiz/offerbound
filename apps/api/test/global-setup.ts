import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Brings the test database to the latest schema by resetting it and replaying every migration.
 * Destructive by design: DATABASE_URL must point at a throwaway database.
 */
export default function setup(): void {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to run the integration tests.");
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to reset the database while NODE_ENV is production.");
  }
  try {
    execFileSync(
      "pnpm",
      ["exec", "prisma", "migrate", "reset", "--force", "--skip-seed", "--skip-generate"],
      { cwd: repoRoot, env: process.env, stdio: "pipe", encoding: "utf8" },
    );
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    throw new Error(
      `prisma migrate reset failed\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`.trim(),
    );
  }
}
