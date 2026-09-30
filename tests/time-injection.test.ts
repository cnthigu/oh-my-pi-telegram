/**
 * Regression tests for the Telegram time-injection runtime
 * Covers injection mode gating, interval bookkeeping per chat, and timezone formatting
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveTelegramTimeConfig,
  type ResolvedTelegramTimeConfig,
} from "../lib/config.ts";
import {
  createTimeInjectionRuntime,
  formatTelegramTimeInjectionLine,
} from "../lib/time-injection.ts";

function makeRuntime(config: Partial<ResolvedTelegramTimeConfig>) {
  const resolved: ResolvedTelegramTimeConfig = {
    injectionMode: config.injectionMode ?? "hidden",
    interval: config.interval ?? 60 * 60 * 1000,
    timezone: config.timezone ?? "UTC",
  };
  return createTimeInjectionRuntime({ getConfig: () => resolved });
}

test("Time config resolves defaults when keys are missing", () => {
  const resolved = resolveTelegramTimeConfig(undefined);
  assert.equal(resolved.injectionMode, "hidden");
  assert.equal(resolved.interval, 60 * 60 * 1000);
  assert.equal(typeof resolved.timezone, "string");
  assert.ok(resolved.timezone.length > 0);
});

test("Time config maps legacy off mode to hidden", () => {
  const resolved = resolveTelegramTimeConfig({
    injectionMode: "off" as never,
  });
  assert.equal(resolved.injectionMode, "hidden");
});

test("Time config rejects non-positive interval", () => {
  const resolved = resolveTelegramTimeConfig({
    injectionMode: "interval",
    interval: 0,
  });
  assert.equal(resolved.interval, 60 * 60 * 1000);
});

test("Time config rejects non-finite intervals", () => {
  for (const interval of [NaN, Infinity, -Infinity]) {
    assert.equal(resolveTelegramTimeConfig({ injectionMode: "interval", interval }).interval, 3_600_000);
  }
});

test("Time injection recovers when the wall clock moves backwards", () => {
  const runtime = makeRuntime({ injectionMode: "interval", interval: 60_000, timezone: "UTC" });
  assert.ok(runtime.resolveLine(1, new Date("2026-05-16T15:00:00Z")));
  assert.ok(runtime.resolveLine(1, new Date("2026-05-16T14:00:00Z")));
  assert.equal(runtime.resolveLine(1, new Date("2026-05-16T14:00:30Z")), null);
  assert.ok(runtime.resolveLine(1, new Date("2026-05-16T14:01:00Z")));
});

test("Time injection runtime returns null for every call when injectionMode is hidden", () => {
  const runtime = makeRuntime({ injectionMode: "hidden", timezone: "UTC" });
  for (let i = 0; i < 5; i++) {
    assert.equal(runtime.resolveLine(1, new Date(i * 1000)), null);
  }
});

test("Time injection runtime returns formatted line on every call when injectionMode is always", () => {
  const runtime = makeRuntime({ injectionMode: "always", timezone: "UTC" });
  const first = runtime.resolveLine(1, new Date("2026-05-16T14:32:10Z"));
  const second = runtime.resolveLine(1, new Date("2026-05-16T14:32:11Z"));
  assert.equal(first, "2026-05-16 14:32:10 UTC");
  assert.equal(second, "2026-05-16 14:32:11 UTC");
});

test("Time injection runtime suppresses repeat lines within the interval window", () => {
  const runtime = makeRuntime({
    injectionMode: "interval",
    interval: 60_000,
    timezone: "UTC",
  });
  const t0 = new Date("2026-05-16T14:00:00Z");
  const tWithin = new Date("2026-05-16T14:00:30Z");
  const tAfter = new Date("2026-05-16T14:01:01Z");
  assert.equal(runtime.resolveLine(1, t0), "2026-05-16 14:00:00 UTC");
  assert.equal(runtime.resolveLine(1, tWithin), null);
  assert.equal(runtime.resolveLine(1, tAfter), "2026-05-16 14:01:01 UTC");
});

test("Time injection runtime tracks interval state per chatId", () => {
  const runtime = makeRuntime({
    injectionMode: "interval",
    interval: 60_000,
    timezone: "UTC",
  });
  const t0 = new Date("2026-05-16T14:00:00Z");
  const tWithin = new Date("2026-05-16T14:00:30Z");
  assert.ok(runtime.resolveLine(1, t0));
  assert.equal(runtime.resolveLine(1, tWithin), null);
  // Different chat should not be gated by chat 1's recent injection
  assert.ok(runtime.resolveLine(2, tWithin));
});

test("Time injection formatting honours the requested timezone", () => {
  const now = new Date("2026-05-16T14:32:10Z");
  assert.equal(
    formatTelegramTimeInjectionLine(now, "UTC"),
    "2026-05-16 14:32:10 UTC",
  );
  // Europe/Berlin is UTC+2 in May (CEST)
  assert.equal(
    formatTelegramTimeInjectionLine(now, "Europe/Berlin"),
    "2026-05-16 16:32:10 Europe/Berlin",
  );
});
