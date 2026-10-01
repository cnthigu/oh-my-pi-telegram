/**
 * Telegram bridge path resolution for Pi-compatible runtimes
 * Zones: telemetry paths, filesystem, runtime identity
 * Owns agent-dir resolution and extension-local path derivation
 *
 * This domain is pure/path-only: it resolves directories and file paths from
 * the environment and the host runtime's own agent directory. It does not read
 * config, manage state, or import broader Telegram domains or the Pi SDK.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface TelegramAgentDirResolutionInput {
  env?: Partial<Pick<NodeJS.ProcessEnv, "PI_CODING_AGENT_DIR">>;
}

let hostAgentDirResolver: (() => string) | undefined;

/**
 * Register the host runtime's own agent-directory lookup (the Pi SDK
 * `getAgentDir()`). It is registered by the composition root instead of
 * imported here: importing the Pi SDK from this leaf made every domain that
 * touches a path, and every child process the test suite spawns, pay about a
 * second of SDK startup.
 */
export function setHostAgentDirResolver(
  resolver: (() => string) | undefined,
): void {
  hostAgentDirResolver = resolver;
}

/**
 * Resolve the agent data directory for the current Pi-compatible runtime.
 *
 * Precedence:
 * 1. `PI_CODING_AGENT_DIR` env variable, when explicitly set.
 * 2. The registered host agent directory. Pi returns `~/.pi/agent`; omp's Pi
 *    shim returns its profile-aware directory (default `~/.omp/agent`). The
 *    executable and argv are not inspected: omp installed through Bun runs as
 *    `bun .../dist/cli.js`, which neither contains nor starts with `omp`.
 * 3. Fallback when no host is registered: `~/.pi/agent`.
 */
export function resolveAgentDir(
  input: TelegramAgentDirResolutionInput = {},
): string {
  const env = input.env ?? process.env;
  if (env.PI_CODING_AGENT_DIR) return resolve(env.PI_CODING_AGENT_DIR);
  return hostAgentDirResolver?.() ?? join(homedir(), ".pi", "agent");
}

/** Telegram bridge configuration file (<agentDir>/telegram.json). */
export function resolveTelegramConfigPath(): string {
  return join(resolveAgentDir(), "telegram.json");
}

/** Telegram singleton lock file (<agentDir>/locks.json). */
export function resolveTelegramLocksPath(): string {
  return join(resolveAgentDir(), "locks.json");
}

/** Telegram bridge temporary directory (<agentDir>/tmp/telegram). */
export function resolveTelegramTempDir(agentDir = resolveAgentDir()): string {
  return join(agentDir, "tmp", "telegram");
}

export function getTelegramProfilePathSuffix(profileName?: string): string {
  return profileName ? `.${profileName.replace(/[^a-zA-Z0-9._-]+/g, "_")}` : "";
}

export function resolveTelegramProfileTempFilePath(
  baseName: string,
  extension: string,
  agentDir = resolveAgentDir(),
  profileName?: string,
): string {
  return join(
    resolveTelegramTempDir(agentDir),
    `${baseName}${getTelegramProfilePathSuffix(profileName)}.${extension}`,
  );
}

export function getTelegramDiagnosticsDisplayPaths(profileName?: string): {
  state: string;
  logs: string;
} {
  const agentDir = resolveAgentDir();
  return {
    state: resolveTelegramProfileTempFilePath("state", "json", agentDir, profileName),
    logs: resolveTelegramProfileTempFilePath("logs", "jsonl", agentDir, profileName),
  };
}

/** Runtime event log (<agentDir>/tmp/telegram/logs.jsonl). */
export function resolveTelegramRuntimeLogPath(): string {
  return resolveTelegramProfileTempFilePath("logs", "jsonl");
}
