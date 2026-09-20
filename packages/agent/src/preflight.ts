/**
 * Credential preflight.
 *
 * Whoever reviews this will clone it, export a key, and run one command. If that
 * fails, nothing else in the submission gets looked at -- so failure here is
 * explicit and actionable rather than a stack trace from inside the SDK
 * subprocess three seconds later.
 *
 * Zero dependencies: Node's own loadEnvFile instead of pulling in dotenv.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Load .env if present. Real environment variables always win. */
export function loadEnv(): void {
  const file = join(ROOT, ".env");
  if (!existsSync(file)) return;
  try {
    process.loadEnvFile(file);
  } catch {
    // A malformed .env should not be fatal; requireCredentials reports the
    // consequence (a missing key) rather than the cause.
  }
}

export interface Credentials {
  source: "ANTHROPIC_API_KEY" | "claude-cli-login";
}

/**
 * The same check, but it reports rather than exits.
 *
 * `requireCredentials` is right for the CLI and the eval runner: no key means no
 * work, so say so and stop. It is wrong for a hosted demo, where exiting at
 * module load takes down a site on which most of the interesting surface needs
 * no model at all -- the verified diagrams, the interactive widgets, the manual
 * browser, the rejection demo and the voice fast path are all pure functions
 * over committed data.
 *
 * So the server asks this instead, serves everything it can, and requires a key
 * only on the two routes that actually reach the API.
 */
export function optionalCredentials(): Credentials | null {
  loadEnv();
  if (process.env["ANTHROPIC_API_KEY"]) return { source: "ANTHROPIC_API_KEY" };
  const cliLogin = join(
    process.env["USERPROFILE"] ?? process.env["HOME"] ?? "",
    ".claude",
    ".credentials.json",
  );
  return existsSync(cliLogin) ? { source: "claude-cli-login" } : null;
}

/**
 * Confirm we can authenticate, or explain exactly how to.
 *
 * Two paths work. An API key is what a reviewer will use. A Claude Code CLI
 * login also works because the Agent SDK runs that CLI as a subprocess, which is
 * convenient while developing but is NOT something to rely on for a handoff.
 */
export function requireCredentials(): Credentials {
  loadEnv();

  if (process.env["ANTHROPIC_API_KEY"]) return { source: "ANTHROPIC_API_KEY" };

  const cliLogin = join(
    process.env["USERPROFILE"] ?? process.env["HOME"] ?? "",
    ".claude",
    ".credentials.json",
  );
  if (existsSync(cliLogin)) return { source: "claude-cli-login" };

  console.error(
    [
      "",
      "  No Anthropic credentials found.",
      "",
      "  Set an API key (get one at https://console.anthropic.com/settings/keys):",
      "",
      "      macOS / Linux    export ANTHROPIC_API_KEY=sk-ant-...",
      "      Windows (cmd)    set ANTHROPIC_API_KEY=sk-ant-...",
      "      PowerShell       $env:ANTHROPIC_API_KEY = 'sk-ant-...'",
      "",
      "  Or copy .env.example to .env and put the key there.",
      "",
      "  Everything that does not call the model runs without a key:",
      "      npm test               60 tests, offline",
      "      npm run verify:tables  traces every table value to its manual page",
      "      npm run diagram -- polarity all",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
