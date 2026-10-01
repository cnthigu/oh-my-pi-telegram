/**
 * Telegram per-chat time injection runtime
 * Zones: telegram inbound, prompt content
 * Owns the formatted `[time]` line and the per-chat interval bookkeeping that decides when to emit it
 */

import type { ResolvedTelegramTimeConfig } from "./config.ts";

export interface TimeInjectionRuntime {
  resolveLine: (chatId: number, now?: Date) => string | null;
}

export interface TimeInjectionRuntimeDeps {
  getConfig: () => ResolvedTelegramTimeConfig;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export function formatTelegramTimeInjectionLine(
  now: Date,
  timezone: string,
): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hourRaw = get("hour");
  const hour = hourRaw === "24" ? "00" : hourRaw;
  const minute = get("minute");
  const second = get("second");
  return `${year}-${month}-${day} ${hour}:${minute}:${second} ${timezone}`;
}

export function createTimeInjectionRuntime(
  deps: TimeInjectionRuntimeDeps,
): TimeInjectionRuntime {
  const lastInjectedAt = new Map<number, number>();
  return {
    resolveLine: (chatId, now = new Date()) => {
      const config = deps.getConfig();
      if (config.injectionMode === "hidden") return null;
      let line: string;
      try {
        line = formatTelegramTimeInjectionLine(now, config.timezone);
      } catch (error) {
        deps.recordRuntimeEvent?.("time-injection", error, {
          timezone: config.timezone,
        });
        return null;
      }
      if (config.injectionMode === "always") return line;
      const previous = lastInjectedAt.get(chatId);
      const nowMs = now.getTime();
      if (
        previous !== undefined &&
        nowMs >= previous &&
        nowMs - previous < config.interval
      ) {
        return null;
      }
      lastInjectedAt.set(chatId, nowMs);
      return line;
    },
  };
}
