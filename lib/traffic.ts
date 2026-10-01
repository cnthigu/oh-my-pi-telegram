/**
 * Telegram bridge traffic counters
 * Zones: telegram transport, status
 * Owns in-memory received/sent message counts and last-activity time for the status bar
 *
 * This domain is pure: it counts, it does not read config, call Telegram, or import other domains.
 */

export interface TelegramTrafficSnapshot {
  /** Authorized messages received from the paired owner since the bridge loaded. */
  received: number;
  /** Messages the bridge delivered to Telegram since the bridge loaded. */
  sent: number;
  /** Messages that could not be delivered after the transport retries. */
  failed: number;
  /** Time of the latest received or sent message, when there was one. */
  lastAtMs?: number;
}

export interface TelegramTrafficCounters {
  recordReceived: () => void;
  recordSent: () => void;
  recordFailed: () => void;
  snapshot: () => TelegramTrafficSnapshot;
}

/**
 * Bot API methods that deliver a message the owner can read. Typing actions,
 * drafts, edits, reactions and callback answers are not messages.
 */
const TELEGRAM_OUTBOUND_MESSAGE_METHODS: Readonly<Record<string, true>> = {
  sendMessage: true,
  sendRichMessage: true,
  sendPhoto: true,
  sendDocument: true,
  sendAudio: true,
  sendVideo: true,
  sendVoice: true,
  sendAnimation: true,
  sendVideoNote: true,
  sendMediaGroup: true,
  sendSticker: true,
};

export function isTelegramOutboundMessageMethod(method: string): boolean {
  return Object.hasOwn(TELEGRAM_OUTBOUND_MESSAGE_METHODS, method);
}

export function createTelegramTrafficCounters(
  now: () => number = Date.now,
): TelegramTrafficCounters {
  let received = 0;
  let sent = 0;
  let failed = 0;
  let lastAtMs: number | undefined;
  return {
    recordReceived() {
      received += 1;
      lastAtMs = now();
    },
    recordSent() {
      sent += 1;
      lastAtMs = now();
    },
    recordFailed() {
      failed += 1;
    },
    snapshot: () => ({
      received,
      sent,
      failed,
      ...(lastAtMs === undefined ? {} : { lastAtMs }),
    }),
  };
}

export interface TelegramTrafficStatusBridgeDeps<TContext> {
  counters: TelegramTrafficCounters;
  /** Current session context, when the bridge has one. */
  getContext: () => TContext | undefined;
  updateStatus: (ctx: TContext) => void;
  recordRuntimeEvent: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  /** Told about every message delivery that failed, e.g. to raise a notice. */
  onDeliveryFailed?: (error: unknown) => void;
}

export interface TelegramTrafficStatusBridge<TContext> {
  /** Observer for successful Bot API calls; counts delivered messages. */
  onCallSucceeded: (method: string) => void;
  /** Observer for failed Bot API calls; counts undelivered messages. */
  onCallFailed: (method: string, error: unknown) => void;
  /** Observer for messages accepted from the paired owner. */
  onAuthorizedMessage: (ctx: TContext) => void;
}

/**
 * Counts traffic and refreshes the status bar so the counters stay current. A
 * status refresh failure (for example a stale session context) is recorded and
 * never propagates into the send or receive path that triggered it.
 */
export function createTelegramTrafficStatusBridge<TContext>(
  deps: TelegramTrafficStatusBridgeDeps<TContext>,
): TelegramTrafficStatusBridge<TContext> {
  const refreshStatus = (ctx: TContext): void => {
    try {
      deps.updateStatus(ctx);
    } catch (error) {
      deps.recordRuntimeEvent("status", error, { phase: "traffic-refresh" });
    }
  };
  return {
    onCallSucceeded(method) {
      if (!isTelegramOutboundMessageMethod(method)) return;
      deps.counters.recordSent();
      const ctx = deps.getContext();
      if (ctx !== undefined) refreshStatus(ctx);
    },
    onCallFailed(method, error) {
      if (!isTelegramOutboundMessageMethod(method)) return;
      deps.counters.recordFailed();
      deps.onDeliveryFailed?.(error);
      const ctx = deps.getContext();
      if (ctx !== undefined) refreshStatus(ctx);
    },
    onAuthorizedMessage(ctx) {
      deps.counters.recordReceived();
      refreshStatus(ctx);
    },
  };
}
