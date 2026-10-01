/**
 * Regression tests for the Telegram traffic counters
 * Covers what counts as a message, last-activity tracking, and the /telegram-status line.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildTelegramBridgeStatusLines } from "../lib/status.ts";
import {
  createTelegramTrafficCounters,
  createTelegramTrafficStatusBridge,
  isTelegramOutboundMessageMethod,
} from "../lib/traffic.ts";

test("Traffic counters count both directions and remember the latest activity", () => {
  let nowMs = 1_000;
  const counters = createTelegramTrafficCounters(() => nowMs);
  assert.deepEqual(counters.snapshot(), { received: 0, sent: 0 });
  counters.recordReceived();
  nowMs = 2_000;
  counters.recordSent();
  counters.recordSent();
  assert.deepEqual(counters.snapshot(), {
    received: 1,
    sent: 2,
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
  const withTraffic = buildTelegramBridgeStatusLines({
    ...baseState,
    traffic: { received: 12, sent: 11, lastAtMs: new Date(2026, 9, 1, 14, 32).getTime() },
  });
  assert.ok(
    withTraffic.includes("- messages: 12 received, 11 sent, last 14:32"),
    withTraffic.join("\n"),
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
  assert.deepEqual(counters.snapshot(), { received: 0, sent: 0 });
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
  assert.deepEqual(counters.snapshot().received, 1);
  assert.deepEqual(counters.snapshot().sent, 1);
  assert.deepEqual(recorded, [
    "status:stale ctx:traffic-refresh",
    "status:stale ctx:traffic-refresh",
  ]);
});
