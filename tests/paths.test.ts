/**
 * Regression tests for Telegram bridge path resolution
 * Guards agent-dir detection for Pi-compatible runtimes and path derivation helpers.
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  resolveAgentDir,
  setHostAgentDirResolver,
  resolveTelegramConfigPath,
  resolveTelegramLocksPath,
  resolveTelegramTempDir,
  resolveTelegramRuntimeLogPath,
  getTelegramDiagnosticsDisplayPaths,
  resolveTelegramProfileTempFilePath,
} from "../lib/paths.ts";

test("Diagnostics use the resolved agent root and profile suffix", () => {
  const agentDir = resolveAgentDir();
  for (const profile of [undefined, "work"]) {
    assert.deepEqual(getTelegramDiagnosticsDisplayPaths(profile), {
      state: resolveTelegramProfileTempFilePath("state", "json", agentDir, profile),
      logs: resolveTelegramProfileTempFilePath("logs", "jsonl", agentDir, profile),
    });
  }
});

await test("resolveAgentDir", async (t) => {
  t.afterEach(() => setHostAgentDirResolver(undefined));

  await t.test("PI_CODING_AGENT_DIR wins over the host directory", () => {
    setHostAgentDirResolver(() => {
      throw new Error("host directory must not be consulted");
    });
    assert.equal(
      resolveAgentDir({ env: { PI_CODING_AGENT_DIR: "/custom/agent/dir" } }),
      resolve("/custom/agent/dir"),
    );
  });

  await t.test(
    "uses the registered host runtime directory when env is unset",
    () => {
      setHostAgentDirResolver(() => "/home/user/.omp/agent");
      assert.equal(resolveAgentDir({ env: {} }), "/home/user/.omp/agent");
    },
  );

  await t.test("falls back to ~/.pi/agent when no host is registered", () => {
    assert.equal(
      resolveAgentDir({ env: {} }),
      join(homedir(), ".pi", "agent"),
    );
  });
});

await test("resolveTelegramConfigPath", () => {
  assert.ok(
    resolveTelegramConfigPath().endsWith("telegram.json"),
    "config path ends with telegram.json",
  );
});

await test("resolveTelegramLocksPath", () => {
  assert.ok(
    resolveTelegramLocksPath().endsWith("locks.json"),
    "locks path ends with locks.json",
  );
});

await test("resolveTelegramTempDir", () => {
  assert.ok(
    resolveTelegramTempDir().endsWith("/tmp/telegram"),
    "temp dir ends with /tmp/telegram",
  );
});

await test("resolveTelegramRuntimeLogPath", () => {
  assert.ok(
    resolveTelegramRuntimeLogPath().endsWith("/tmp/telegram/logs.jsonl"),
    "runtime log path ends with logs.jsonl",
  );
});
