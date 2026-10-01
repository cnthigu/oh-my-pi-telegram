/**
 * pi SDK adapter boundary
 * Zones: pi agent sdk boundary, shared adapters
 * Owns direct pi SDK imports and exposes narrow bridge-facing helpers/types for the extension composition layer
 */

import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import {
  type AgentEndEvent,
  type AgentSettledEvent,
  type AgentStartEvent,
  type BeforeAgentStartEvent,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type InputEvent,
  type SessionBeforeCompactEvent,
  type SessionCompactEvent,
  type SessionShutdownEvent,
  type SessionStartEvent,
  type SlashCommandInfo,
  SettingsManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

export type {
  AgentEndEvent,
  AgentSettledEvent,
  AgentStartEvent,
  AssistantMessageEvent,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  SlashCommandInfo,
};

/**
 * Agent data directory owned by the host runtime. Pi returns its own root and
 * omp's legacy Pi shim forwards omp's profile-aware directory, so no argv or
 * executable sniffing is needed.
 */
export { getAgentDir as getHostAgentDir };

export interface ToolExecutionStartEvent {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolExecutionUpdateEvent {
  type: "tool_execution_update";
  toolCallId: string;
  toolName: string;
  args: unknown;
  partialResult: unknown;
}

export interface ToolExecutionEndEvent {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
}

export interface PiSettingsManager {
  reload: () => Promise<void>;
  flush: () => Promise<void>;
  getEnabledModels: () => string[] | undefined;
  setEnabledModels: (patterns: string[] | undefined) => void;
}

/**
 * omp's `Settings` is what its legacy shim returns from
 * `SettingsManager.create()`. It has no `reload()` or `get/setEnabledModels()`:
 * it reloads through `reloadFromDisk()` and keeps `enabledModels` as a
 * path-scoped typed setting.
 */
interface OmpSettingsSurface {
  reloadFromDisk: () => Promise<void>;
  flush: () => Promise<void>;
  getGlobalSettings: () => { enabledModels?: unknown };
}

function isOmpSettings(value: object): value is OmpSettingsSurface {
  return (
    "reloadFromDisk" in value &&
    "flush" in value &&
    "getGlobalSettings" in value
  );
}

export type PiSlashCommandInfo = SlashCommandInfo;
export type PiRunMode = "tui" | "rpc" | "json" | "print";

function isPiRunMode(value: unknown): value is PiRunMode {
  return (
    value === "tui" || value === "rpc" || value === "json" || value === "print"
  );
}

export function getExtensionContextMode(ctx: unknown): PiRunMode | undefined {
  const mode =
    typeof ctx === "object" && ctx !== null
      ? (ctx as { mode?: unknown }).mode
      : undefined;
  return isPiRunMode(mode) ? mode : undefined;
}

export function isExtensionContextPassiveRunMode(ctx: unknown): boolean {
  const mode = getExtensionContextMode(ctx);
  return mode === "print" || mode === "json";
}

export function canStartPollingInExtensionContext(ctx: unknown): boolean {
  return !isExtensionContextPassiveRunMode(ctx);
}

export function formatPollingStartBlockedByRunMode(ctx: unknown): string {
  const mode = getExtensionContextMode(ctx);
  return mode
    ? `Telegram polling is unavailable in Pi ${mode} mode. Use /telegram-connect from a long-lived Pi session.`
    : "Telegram polling is unavailable in this Pi run mode.";
}

export function getSessionCompactionReason(
  event: unknown,
): "manual" | "threshold" | "overflow" | "unknown" {
  const reason =
    event && typeof event === "object" && "reason" in event
      ? (event as { reason?: unknown }).reason
      : undefined;
  return reason === "manual" || reason === "threshold" || reason === "overflow"
    ? reason
    : "unknown";
}

export type PiSendUserMessageOptions = NonNullable<
  Parameters<ExtensionAPI["sendUserMessage"]>[1]
>;

export interface PiExtensionApiRuntimePorts {
  sendUserMessage: ExtensionAPI["sendUserMessage"];
  exec: ExtensionAPI["exec"];
  getCommands: ExtensionAPI["getCommands"];
  getThinkingLevel: ExtensionAPI["getThinkingLevel"];
  setThinkingLevel: ExtensionAPI["setThinkingLevel"];
  setModel: ExtensionAPI["setModel"];
}

export function createExtensionApiRuntimePorts(
  api: Pick<
    ExtensionAPI,
    | "sendUserMessage"
    | "exec"
    | "getCommands"
    | "getThinkingLevel"
    | "setThinkingLevel"
    | "setModel"
  >,
): PiExtensionApiRuntimePorts {
  return {
    sendUserMessage: (content, options) =>
      api.sendUserMessage(content, options),
    exec: (command, args, options) => api.exec(command, args, options),
    getCommands: () => api.getCommands(),
    getThinkingLevel: () => api.getThinkingLevel(),
    setThinkingLevel: (level) => api.setThinkingLevel(level),
    setModel: (model) => api.setModel(model),
  };
}

export function createSettingsManager(cwd: string): PiSettingsManager {
  const manager: PiSettingsManager = SettingsManager.create(cwd);
  if (!isOmpSettings(manager)) return manager;
  return {
    reload: () => manager.reloadFromDisk(),
    flush: () => manager.flush(),
    getEnabledModels: () => {
      const enabled = manager.getGlobalSettings().enabledModels;
      return Array.isArray(enabled) &&
        enabled.every((pattern) => typeof pattern === "string")
        ? enabled
        : undefined;
    },
    setEnabledModels: () => {
      throw new Error("Scoped model persistence is not supported on omp.");
    },
  };
}

export function createScopedModelPatternPersister(deps: {
  createSettingsManager: (cwd: string) => PiSettingsManager;
  clearCachedModelMenuInputs: () => void;
}): (patterns: string[], ctx: ExtensionContext) => Promise<void> {
  return async (patterns, ctx) => {
    const settingsManager = deps.createSettingsManager(ctx.cwd);
    settingsManager.setEnabledModels(
      patterns.length > 0 ? patterns : undefined,
    );
    await settingsManager.flush();
    deps.clearCachedModelMenuInputs();
  };
}

interface OmpModelQuery {
  current: () => ExtensionContext["model"];
}

function hasOmpModelQuery(
  ctx: ExtensionContext,
): ctx is ExtensionContext & { models: OmpModelQuery } {
  return (
    "models" in ctx &&
    typeof ctx.models === "object" &&
    ctx.models !== null &&
    "current" in ctx.models &&
    typeof ctx.models.current === "function"
  );
}

/**
 * omp builds command contexts by spreading a base context, which evaluates the
 * `model` getter once: a context stored from `/telegram-connect` would report
 * the model of that moment forever. omp's `ctx.models.current()` closes over
 * the live session model, so prefer it when present.
 */
export function getExtensionContextModel(
  ctx: ExtensionContext,
): ExtensionContext["model"] {
  return hasOmpModelQuery(ctx) ? ctx.models.current() : ctx.model;
}

export function getExtensionContextCwd(ctx: ExtensionContext): string {
  return ctx.cwd;
}

/**
 * True when the extension API belongs to omp. omp's `ExtensionAPI` carries
 * `typebox` and `pi` module facades that upstream Pi's API does not have.
 */
export function isOmpHost(api: ExtensionAPI): boolean {
  return "typebox" in api && "pi" in api;
}

/**
 * omp marks an `agent_end` with `willContinue: true` whenever it already
 * scheduled a retry, compaction continuation, todo/plan reminder, or async
 * wake. Any other `agent_end` is terminal, which is what Pi reports through
 * `agent_settled`.
 */
export function isTerminalAgentEnd(event: AgentEndEvent): boolean {
  return !("willContinue" in event && event.willContinue === true);
}

export function isExtensionContextIdle(ctx: ExtensionContext): boolean {
  return ctx.isIdle();
}

export function hasExtensionContextPendingMessages(
  ctx: ExtensionContext,
): boolean {
  return ctx.hasPendingMessages();
}

export function compactExtensionContext(
  ctx: ExtensionContext,
  callbacks: Parameters<ExtensionContext["compact"]>[0],
): ReturnType<ExtensionContext["compact"]> {
  return ctx.compact(callbacks);
}
