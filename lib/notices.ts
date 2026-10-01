/**
 * Telegram operator notices
 * Zones: telegram ui, tui
 * Owns the one-off host toasts (owner paired, connection recovered, reply not delivered) and their throttling
 */

import {
  sanitizeTelegramStatusText,
  summarizeTelegramStatusError,
} from "./status.ts";

export type TelegramNoticeLevel = "info" | "warning" | "error";

/** A failed delivery raises at most one notice per this window. */
export const TELEGRAM_DELIVERY_FAILED_NOTICE_COOLDOWN_MS = 30_000;

export interface TelegramNoticeRuntimeDeps<TContext> {
  /** Current session context, when the bridge has one. */
  getContext: () => TContext | undefined;
  notify: (ctx: TContext, message: string, level: TelegramNoticeLevel) => void;
  recordRuntimeEvent: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  now?: () => number;
}

export interface TelegramNoticeRuntime<TContext> {
  /** The first Telegram user was accepted as the bridge owner. */
  paired: (userId: number, ctx: TContext) => void;
  /** Polling works again after at least one failed attempt. */
  recovered: (ctx: TContext) => void;
  /** A message could not be delivered; throttled, uses the current context. */
  deliveryFailed: (error: unknown) => void;
}

function describeTelegramDeliveryFailure(error: unknown): {
  reason: string;
  level: TelegramNoticeLevel;
} {
  const message = error instanceof Error ? error.message : String(error);
  const summary = summarizeTelegramStatusError(message);
  if (summary) {
    return {
      reason: summary.label,
      level: summary.kind === "fatal" ? "error" : "warning",
    };
  }
  const raw = sanitizeTelegramStatusText(message);
  return {
    reason: raw.length > 80 ? `${raw.slice(0, 79)}…` : raw,
    level: "error",
  };
}

/**
 * Toasts never propagate failures into the path that raised them: a stale
 * session context only produces a recorded runtime event.
 */
export function createTelegramNoticeRuntime<TContext>(
  deps: TelegramNoticeRuntimeDeps<TContext>,
): TelegramNoticeRuntime<TContext> {
  const now = deps.now ?? Date.now;
  let lastDeliveryNoticeAtMs: number | undefined;
  const show = (
    ctx: TContext,
    message: string,
    level: TelegramNoticeLevel,
  ): void => {
    try {
      deps.notify(ctx, message, level);
    } catch (error) {
      deps.recordRuntimeEvent("status", error, { phase: "notice" });
    }
  };
  return {
    paired(userId, ctx) {
      show(ctx, `Telegram paired with user ${userId}`, "info");
    },
    recovered(ctx) {
      show(ctx, "Telegram reconnected", "info");
    },
    deliveryFailed(error) {
      const ctx = deps.getContext();
      if (ctx === undefined) return;
      const nowMs = now();
      if (
        lastDeliveryNoticeAtMs !== undefined &&
        nowMs - lastDeliveryNoticeAtMs <
          TELEGRAM_DELIVERY_FAILED_NOTICE_COOLDOWN_MS
      ) {
        return;
      }
      lastDeliveryNoticeAtMs = nowMs;
      const { reason, level } = describeTelegramDeliveryFailure(error);
      show(ctx, `Telegram: reply not delivered (${reason})`, level);
    },
  };
}
