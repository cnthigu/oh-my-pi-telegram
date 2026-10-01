/**
 * Regression tests for the Telegram traffic counters
 * Covers what counts as a message, last-activity tracking, failed deliveries, and the /telegram-status line.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildTelegramBridgeStatusLines } from "../lib/status.ts";
import {
  createTelegramTrafficCounters,
  createTelegramTrafficStatusBridge,
  isTelegramOutboundMessageMethod,
} from "../lib/traffic.ts";

test("Traffic counters count every direction and remember the latest message", () => {
  let nowMs = 1_000;
  const counters = createTelegramTrafficCounters(() => nowMs);
  assert.deepEqual(counters.snapshot(), { received: 0, sent: 0, failed: 0 });
  counters.recordReceived();
  nowMs = 2_000;
  counters.recordSent();
  counters.recordSent();
  nowMs = 3_000;
  counters.recordFailed();
  assert.deepEqual(counters.snapshot(), {
    received: 1,
    sent: 2,
    failed: 1,
    lastAtMs: 2_000,
  });
});

test("Only calls that deliver a readable message count as sent", () => {
  for (const method of ["sendMessage", "sendRichMessage", "sendPhoto", "sendDocument", "sendVoice"]) {
    assert.equal(isTelegramOutboundMessageMethod(method), true, method);
  }
  for (const method of [
    "sendChatAction",
    "sendMessageDraft",
    "editMessageText",
    "setMessageReaction",
    "answerCallbackQuery",
    "getUpdates",
    "toString",
  ]) {
    assert.equal(isTelegramOutboundMessageMethod(method), false, method);
  }
});

test("Status lines report the message counters and the time of the last one", () => {
  const baseState = {
    botUsername: "demo_bot",
    allowedUserId: 7,
    pollingActive: true,
    pendingDispatch: false,
    compactionInProgress: false,
    activeToolExecutions: 0,
    pendingModelSwitch: false,
    queuedItems: [],
    recentRuntimeEvents: [],
  };
  const lastAtMs = new Date(2026, 9, 1, 14, 32).getTime();
  const clean = buildTelegramBridgeStatusLines({
    ...baseState,
    traffic: { received: 12, sent: 11, failed: 0, lastAtMs },
  });
  assert.ok(
    clean.includes("- messages: 12 received, 11 sent, last 14:32"),
    clean.join("\n"),
  );
  const withFailures = buildTelegramBridgeStatusLines({
    ...baseState,
    traffic: { received: 12, sent: 11, failed: 2, lastAtMs },
  });
  assert.ok(
    withFailures.includes("- messages: 12 received, 11 sent, 2 failed, last 14:32"),
    withFailures.join("\n"),
  );
  const withoutTraffic = buildTelegramBridgeStatusLines(baseState);
  assert.equal(withoutTraffic.some((line) => line.startsWith("- messages:")), false);
});

test("Traffic bridge counts delivered messages and refreshes the status with the current context", () => {
  const counters = createTelegramTrafficCounters();
  const refreshed: string[] = [];
  let context: string | undefined = "session-a";
  const bridge = createTelegramTrafficStatusBridge({
    counters,
    getContext: () => context,
    updateStatus: (ctx: string) => {
      refreshed.push(ctx);
    },
    recordRuntimeEvent: () => {},
  });
  bridge.onCallSucceeded("sendChatAction");
  bridge.onCallSucceeded("editMessageText");
  assert.deepEqual(counters.snapshot(), { received: 0, sent: 0, failed: 0 });
  assert.deepEqual(refreshed, []);
  bridge.onCallSucceeded("sendRichMessage");
  assert.equal(counters.snapshot().sent, 1);
  assert.deepEqual(refreshed, ["session-a"]);
  context = undefined;
  bridge.onCallSucceeded("sendMessage");
  assert.equal(counters.snapshot().sent, 2);
  assert.deepEqual(refreshed, ["session-a"]);
  bridge.onAuthorizedMessage("session-b");
  assert.equal(counters.snapshot().received, 1);
  assert.deepEqual(refreshed, ["session-a", "session-b"]);
});

test("Traffic bridge counts undelivered messages, reports them and refreshes the status", () => {
  const counters = createTelegramTrafficCounters();
  const refreshed: string[] = [];
  const failures: string[] = [];
  const bridge = createTelegramTrafficStatusBridge({
    counters,
    getContext: () => "session",
    updateStatus: (ctx: string) => {
      refreshed.push(ctx);
    },
    recordRuntimeEvent: () => {},
    onDeliveryFailed: (error) => {
      failures.push((error as Error).message);
    },
  });
  bridge.onCallFailed("getUpdates", new Error("poll failed"));
  bridge.onCallFailed("sendChatAction", new Error("typing failed"));
  assert.equal(counters.snapshot().failed, 0);
  assert.deepEqual(failures, []);
  assert.deepEqual(refreshed, []);
  bridge.onCallFailed("sendMessage", new Error("HTTP 500"));
  assert.equal(counters.snapshot().failed, 1);
  assert.equal(counters.snapshot().sent, 0);
  assert.deepEqual(failures, ["HTTP 500"]);
  assert.deepEqual(refreshed, ["session"]);
});

test("Traffic bridge records a failed status refresh instead of breaking the message path", () => {
  const counters = createTelegramTrafficCounters();
  const recorded: string[] = [];
  const bridge = createTelegramTrafficStatusBridge({
    counters,
    getContext: () => "session",
    updateStatus: () => {
      throw new Error("stale ctx");
    },
    recordRuntimeEvent: (category, error, details) => {
      recorded.push(`${category}:${(error as Error).message}:${details?.phase}`);
    },
  });
  bridge.onCallSucceeded("sendMessage");
  bridge.onAuthorizedMessage("session");
  bridge.onCallFailed("sendMessage", new Error("HTTP 500"));
  assert.equal(counters.snapshot().received, 1);
  assert.equal(counters.snapshot().sent, 1);
  assert.equal(counters.snapshot().failed, 1);
  assert.deepEqual(recorded, [
    "status:stale ctx:traffic-refresh",
    "status:stale ctx:traffic-refresh",
    "status:stale ctx:traffic-refresh",
  ]);
});
