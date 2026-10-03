/**
 * Regression tests for Telegram thinking menu helpers
 * Exercises thinking-menu markup, callback routing, voice guards, and send/update helpers
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTelegramThinkingMenuRenderPayload,
  buildThinkingMenuReplyMarkup,
  handleTelegramThinkingMenuCallbackAction,
  openTelegramThinkingMenu,
  updateTelegramThinkingMenuMessage,
} from "../lib/menu-thinking.ts";
import type { TelegramModelMenuState } from "../lib/menu-model.ts";
import type { MenuModel, ThinkingLevel } from "../lib/model.ts";

const reasoningModel = {
  provider: "openai",
  id: "gpt-5",
  reasoning: true,
};

test("Thinking menus preserve the full ladder when reasoning capabilities are absent", () => {
  const markup = buildThinkingMenuReplyMarkup("medium", reasoningModel);
  assert.equal(markup.inline_keyboard[0]?.[0]?.callback_data, "menu:back");
  assert.deepEqual(
    markup.inline_keyboard.slice(1).flat().map((button) => button.callback_data),
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => `thinking:set:${level}`),
  );
  assert.equal(markup.inline_keyboard.find((row) => row[0]?.callback_data === "thinking:set:medium")?.[0]?.text, "🟢 medium");
});

test("Explicit non-reasoning metadata renders only off in the standalone thinking menu", () => {
  const markup = buildThinkingMenuReplyMarkup("off", { ...reasoningModel, reasoning: false });
  assert.deepEqual(markup.inline_keyboard.slice(1).flat().map((button) => button.callback_data), ["thinking:set:off"]);
});

test("Thinking payloads offer only supported efforts and do not mark unsupported current levels", () => {
  const model: MenuModel = { ...reasoningModel, thinking: { efforts: ["high", "low", "max"] } };
  const payload = buildTelegramThinkingMenuRenderPayload(model, "max");
  assert.deepEqual(payload.replyMarkup.inline_keyboard.slice(1).flat().map((button) => ({
    text: button.text,
    callback: button.callback_data,
  })), [
    { text: "low", callback: "thinking:set:low" },
    { text: "high", callback: "thinking:set:high" },
    { text: "🟢 max", callback: "thinking:set:max" },
  ]);
  const stale = buildThinkingMenuReplyMarkup("minimal", model);
  assert.equal(stale.inline_keyboard.flat().some((button) => button.text.startsWith("🟢")), false);
});

test("Empty efforts leave navigation available without invented thinking choices", () => {
  const markup = buildThinkingMenuReplyMarkup("high", { ...reasoningModel, thinking: { efforts: [] } });
  assert.deepEqual(markup.inline_keyboard.flat().map((button) => button.callback_data), ["menu:back"]);
});

test("Pi mapped thinking menus omit null and unadvertised extended levels", () => {
  const markup = buildThinkingMenuReplyMarkup("high", {
    ...reasoningModel,
    thinkingLevelMap: { off: null, minimal: null, xhigh: null, max: "budget-max" },
  });
  assert.deepEqual(markup.inline_keyboard.slice(1).flat().map((button) => button.callback_data), [
    "thinking:set:low", "thinking:set:medium", "thinking:set:high", "thinking:set:max",
  ]);
});

test("Stale thinking callbacks are rejected after switching to a limited model", async () => {
  const previousModel: MenuModel = { ...reasoningModel, thinking: { efforts: ["off", "minimal", "high", "max"] } };
  const activeModel: MenuModel = { ...reasoningModel, id: "limited", thinking: { efforts: ["low", "high"] } };
  const oldButtons = buildThinkingMenuReplyMarkup("high", previousModel).inline_keyboard.flat();
  let current: ThinkingLevel = "high";
  const answers: (string | undefined)[] = [];
  let updates = 0;
  for (const level of ["max", "minimal", "off"]) {
    const button = oldButtons.find((entry) => entry.callback_data === `thinking:set:${level}`);
    assert.ok(button);
    assert.equal(await handleTelegramThinkingMenuCallbackAction("stale", button.callback_data, activeModel, {
      setThinkingLevel: (next) => { current = next; },
      getCurrentThinkingLevel: () => current,
      updateStatusMessage: async () => { updates += 1; },
      answerCallbackQuery: async (_id, text) => { answers.push(text); },
    }), true);
  }
  assert.equal(current, "high");
  assert.equal(updates, 0);
  assert.deepEqual(answers, Array(3).fill("This model does not support that thinking level."));
});

test("Explicitly supported max is applied and reflected in thinking selection", async () => {
  const model: MenuModel = { ...reasoningModel, thinking: { efforts: ["high", "max"] } };
  let current: ThinkingLevel = "high";
  let answer: string | undefined;
  await handleTelegramThinkingMenuCallbackAction("max", "thinking:set:max", model, {
    setThinkingLevel: (next) => { current = next; },
    getCurrentThinkingLevel: () => current,
    updateStatusMessage: async () => {},
    answerCallbackQuery: async (_id, text) => { answer = text; },
  });
  assert.equal(current, "max");
  assert.equal(answer, "Thinking: max");
  assert.equal(buildThinkingMenuReplyMarkup(current, model).inline_keyboard.find((row) => row[0]?.callback_data === "thinking:set:max")?.[0]?.text, "🟢 max");
});

test("Thinking callback sets valid levels and reports current level", async () => {
  const calls: string[] = [];
  let current: ThinkingLevel = "low";

  const handled = await handleTelegramThinkingMenuCallbackAction(
    "q1",
    "thinking:set:high",
    reasoningModel,
    {
      setThinkingLevel: (level) => {
        current = level;
        calls.push(`set:${level}`);
      },
      getCurrentThinkingLevel: () => current,
      updateStatusMessage: async () => {
        calls.push("update-status");
      },
      answerCallbackQuery: async (_id, text) => {
        calls.push(text ?? "answered");
      },
    },
  );

  assert.equal(handled, true);
  assert.deepEqual(calls, ["set:high", "update-status", "Thinking: high"]);
});

test("Thinking callback handles invalid, voice-active, non-reasoning, and unrelated actions", async () => {
  const answered: string[] = [];
  const deps = {
    setThinkingLevel: () => {
      throw new Error("must not set level");
    },
    getCurrentThinkingLevel: () => "off" as const,
    updateStatusMessage: async () => {
      throw new Error("must not update status");
    },
    answerCallbackQuery: async (_id: string, text?: string) => {
      answered.push(text ?? "answered");
    },
  };

  assert.equal(
    await handleTelegramThinkingMenuCallbackAction(
      "q1",
      "thinking:set:nope",
      reasoningModel,
      deps,
    ),
    true,
  );
  assert.equal(
    await handleTelegramThinkingMenuCallbackAction(
      "q2",
      "thinking:set:low",
      reasoningModel,
      { ...deps, isVoiceReplyActive: () => true },
    ),
    true,
  );
  assert.equal(
    await handleTelegramThinkingMenuCallbackAction(
      "q3",
      "thinking:set:low",
      { provider: "x", id: "plain" },
      deps,
    ),
    true,
  );
  assert.equal(
    await handleTelegramThinkingMenuCallbackAction(
      "q4",
      "menu:model",
      reasoningModel,
      deps,
    ),
    false,
  );

  assert.deepEqual(answered, [
    "Invalid thinking level.",
    "Thinking controls are disabled during voice replies.",
    "This model has no reasoning controls.",
  ]);
});

test("Thinking menu open and update helpers apply thinking mode and respect voice guard", async () => {
  const state: TelegramModelMenuState = {
    chatId: 1,
    messageId: 2,
    mode: "status",
    page: 0,
    scope: "all",
    scopedModels: [],
    allModels: [],
  };
  const messages: unknown[] = [];
  const deps = {
    getModelMenuState: async () => state,
    getActiveModel: () => reasoningModel,
    getThinkingLevel: () => "medium" as const,
    storeModelMenuState: (nextState: unknown) =>
      messages.push(["store", nextState]),
    editInteractiveMessage: async (...args: unknown[]) => {
      messages.push(["edit", ...args]);
    },
    sendInteractiveMessage: async (...args: unknown[]) => {
      messages.push(["send", ...args]);
      return 99;
    },
  };

  await openTelegramThinkingMenu(deps);
  assert.equal(state.messageId, 99);
  assert.equal(state.mode, "thinking");

  await updateTelegramThinkingMenuMessage(state, reasoningModel, "high", deps);
  assert.equal(state.mode, "thinking");
  assert.equal(messages.length, 3);

  const beforeVoiceGuard = messages.length;
  await openTelegramThinkingMenu({ ...deps, isVoiceReplyActive: () => true });
  await updateTelegramThinkingMenuMessage(state, reasoningModel, "low", {
    ...deps,
    isVoiceReplyActive: () => true,
  });
  assert.equal(messages.length, beforeVoiceGuard);

  const payload = buildTelegramThinkingMenuRenderPayload(reasoningModel, "low");
  assert.equal(payload.nextMode, "thinking");
  assert.equal(payload.mode, "html");
});
