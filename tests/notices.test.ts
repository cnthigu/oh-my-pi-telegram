/**
 * Regression tests for the Telegram operator notices
 * Covers the toast wording, severity, throttling and failure isolation.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createTelegramNoticeRuntime,
  TELEGRAM_DELIVERY_FAILED_NOTICE_COOLDOWN_MS,
} from "../lib/notices.ts";

function createNoticeHarness(options: { notifyThrows?: boolean } = {}) {
  const notices: string[] = [];
  const recorded: string[] = [];
  let nowMs = 1_000_000;
  let context: string | undefined = "session";
  const runtime = createTelegramNoticeRuntime({
    getContext: () => context,
    notify: (ctx: string, message, level) => {
      if (options.notifyThrows) throw new Error("stale ctx");
      notices.push(`${level}|${ctx}|${message}`);
    },
    recordRuntimeEvent: (category, error, details) => {
      recorded.push(`${category}:${(error as Error).message}:${details?.phase}`);
    },
    now: () => nowMs,
  });
  return {
    runtime,
    notices,
    recorded,
    advance: (ms: number) => {
      nowMs += ms;
    },
    dropContext: () => {
      context = undefined;
    },
  };
}

test("Notices announce pairing and recovery as info toasts", () => {
  const { runtime, notices } = createNoticeHarness();
  runtime.paired(777, "ctx-a");
  runtime.recovered("ctx-b");
  assert.deepEqual(notices, [
    "info|ctx-a|Telegram paired with user 777",
    "info|ctx-b|Telegram reconnected",
  ]);
});

test("Delivery failures explain the reason and pick a severity from it", () => {
  const harness = createNoticeHarness();
  harness.runtime.deliveryFailed(
    new Error("Telegram API sendMessage failed: HTTP 429: Too Many Requests: retry after 12"),
  );
  harness.advance(TELEGRAM_DELIVERY_FAILED_NOTICE_COOLDOWN_MS);
  harness.runtime.deliveryFailed(new Error("Unable to connect. Is the computer able to access the url?"));
  harness.advance(TELEGRAM_DELIVERY_FAILED_NOTICE_COOLDOWN_MS);
  harness.runtime.deliveryFailed(new Error("Telegram API sendMessage failed: HTTP 401: Unauthorized"));
  harness.advance(TELEGRAM_DELIVERY_FAILED_NOTICE_COOLDOWN_MS);
  harness.runtime.deliveryFailed(new Error("message is too long"));
  harness.advance(TELEGRAM_DELIVERY_FAILED_NOTICE_COOLDOWN_MS);
  harness.runtime.deliveryFailed(
    new Error("Telegram API sendRichMessage may have committed before transport failed."),
  );
  assert.deepEqual(harness.notices, [
    "warning|session|Telegram: reply not delivered (rate limited 12s)",
    "warning|session|Telegram: reply not delivered (offline)",
    "error|session|Telegram: reply not delivered (invalid token)",
    "error|session|Telegram: reply not delivered (message is too long)",
    "warning|session|Telegram: reply delivery unconfirmed (check the chat)",
  ]);
});

test("Delivery failure notices are throttled and need a live context", () => {
  const harness = createNoticeHarness();
  harness.runtime.deliveryFailed(new Error("fetch failed"));
  harness.advance(TELEGRAM_DELIVERY_FAILED_NOTICE_COOLDOWN_MS - 1);
  harness.runtime.deliveryFailed(new Error("fetch failed"));
  assert.equal(harness.notices.length, 1);
  harness.advance(1);
  harness.runtime.deliveryFailed(new Error("fetch failed"));
  assert.equal(harness.notices.length, 2);
  harness.advance(TELEGRAM_DELIVERY_FAILED_NOTICE_COOLDOWN_MS);
  harness.dropContext();
  harness.runtime.deliveryFailed(new Error("fetch failed"));
  assert.equal(harness.notices.length, 2);
});

test("A failing toast is recorded and never reaches the caller", () => {
  const harness = createNoticeHarness({ notifyThrows: true });
  assert.doesNotThrow(() => {
    harness.runtime.paired(777, "ctx");
    harness.runtime.recovered("ctx");
    harness.runtime.deliveryFailed(new Error("fetch failed"));
  });
  assert.deepEqual(harness.recorded, [
    "status:stale ctx:notice",
    "status:stale ctx:notice",
    "status:stale ctx:notice",
  ]);
});

test("Delivery failure notices carry no control sequences from raw error text", () => {
  const harness = createNoticeHarness();
  harness.runtime.deliveryFailed(new Error("bad\u001b]0;pwned\u0007\u001b[31m text"));
  assert.equal(harness.notices.length, 1);
  assert.doesNotMatch(harness.notices[0], /[\u0000-\u001f\u007f-\u009f]/);
});
