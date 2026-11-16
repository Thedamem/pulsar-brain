/**
 * Brain orchestrator: one voice turn = system prompt + history + tools → provider →
 * tool execution loop → final answer. Providers are called at most once per tool round and
 * the loop stops when the model returns no tool calls, the round limit is reached, the turn
 * times out or a barge-in aborts the request.
 */

import type {
  AppConfig,
  BrainLike,
  BrainReply,
  BrainRequest,
  BrainToolTrace,
  ChatMessage,
  ConfigStoreLike,
  HaClientLike,
  LoggerLike,
  McpToolProxyLike,
  ProviderContext,
  ProviderRegistryLike,
  ProviderReply,
  SchedulerApiLike,
  ToolContext,
  ToolRegistryLike,
  ToolResult,
} from "../shared/types.js";
import { errorMessage } from "../llm/util.js";
import { buildSystemPrompt } from "./prompt.js";

const TIMEOUT_TEXT = "Не успела обработать запрос.";
const PROVIDER_ERROR_TEXT = "Не получилось получить ответ.";
const EMPTY_REPLY_TEXT = "Не поняла запрос. Скажите иначе, пожалуйста.";

export interface BrainDeps {
  configStore: ConfigStoreLike;
  providers: ProviderRegistryLike;
  tools: ToolRegistryLike;
  ha: HaClientLike;
  scheduler: SchedulerApiLike;
  mcp: McpToolProxyLike;
  log: LoggerLike;
  /** Clock injection for tests; defaults to Date.now. */
  now?: () => number;
}

export function createBrain(deps: BrainDeps): BrainLike {
  const log = deps.log;
  const clock = deps.now ?? (() => Date.now());
  let memory: ChatMessage[] = [];

  function historyLimit(config: AppConfig): number {
    const turns = Math.floor(config.conversation.maxHistoryTurns);
    return turns > 0 ? turns * 2 : 0;
  }

  async function respond(request: BrainRequest): Promise<BrainReply> {
    const startedAt = clock();
    const config = deps.configStore.get();
    const provider = deps.providers.get(config.provider.id);
    const toolSpecs = deps.tools.specs();
    const toolContext: ToolContext = {
      runId: request.runId,
      ha: deps.ha,
      scheduler: deps.scheduler,
      mcp: deps.mcp,
      log,
      config,
    };
    const conversationSettings = config.conversation;
    const controller = new AbortController();
    let timedOut = false;
    const timer =
      conversationSettings.requestTimeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, conversationSettings.requestTimeoutMs)
        : null;
    const onAbort = (): void => controller.abort(request.signal.reason);
    if (request.signal.aborted) controller.abort(request.signal.reason);
    else request.signal.addEventListener("abort", onAbort, { once: true });

    const conversation: ChatMessage[] = [...memory, { role: "user", content: request.text }];
    const toolTraces: BrainToolTrace[] = [];
    const audio: Int16Array[] = [];
    const toolSpeech: string[] = [];
    const maxToolRounds = Math.max(1, Math.floor(conversationSettings.llmMaxToolIterations) || 1);
    let toolRounds = 0;
    let finalText = "";
    let finalSpeech = "";
    let finish: BrainReply["finish"] = "stop";

    try {
      if (controller.signal.aborted) {
        finish = request.signal.aborted ? "cancelled" : "error";
        if (timedOut) finalText = TIMEOUT_TEXT;
      } else {
        for (;;) {
          let speechCallbackCount = 0;
          const providerContext: ProviderContext = {
            systemPrompt: buildSystemPrompt(config, clock()),
            history: [...conversation],
            tools: toolSpecs,
            config,
            signal: controller.signal,
            onDelta: (delta: string): void => {
              request.onDelta?.(delta);
            },
            onSpeechAudio: (chunk: Int16Array): void => {
              audio.push(chunk);
              speechCallbackCount += 1;
              request.onSpeechAudio?.(chunk);
            },
          };
          let reply: ProviderReply;
          try {
            reply = await provider.generate(providerContext);
          } catch (error) {
            if (controller.signal.aborted) {
              finish = request.signal.aborted ? "cancelled" : "error";
              if (timedOut) finalText = TIMEOUT_TEXT;
              log.info("brain turn aborted during provider call", { runId: request.runId, timedOut });
            } else {
              finish = "error";
              finalText = PROVIDER_ERROR_TEXT;
              log.error("provider call failed", { runId: request.runId, provider: provider.id, error: errorMessage(error) });
            }
            break;
          }
          if (controller.signal.aborted) {
            finish = request.signal.aborted ? "cancelled" : "error";
            if (timedOut) finalText = TIMEOUT_TEXT;
            break;
          }
          if (reply.audio !== undefined && reply.audio.length > 0 && speechCallbackCount === 0) {
            for (const chunk of reply.audio) audio.push(chunk);
          }
          if (reply.toolCalls.length === 0) {
            finalText = reply.text.trim();
            finalSpeech = reply.speech.trim().length > 0 ? reply.speech : finalText;
            finish = reply.finish === "error" ? "error" : "stop";
            break;
          }
          if (toolRounds >= maxToolRounds) {
            log.warn("tool iteration limit reached", { runId: request.runId, limit: maxToolRounds });
            finalText = reply.text.trim();
            finalSpeech = finalText;
            finish = "stop";
            break;
          }
          conversation.push({ role: "assistant", content: reply.text, toolCalls: reply.toolCalls });
          for (const call of reply.toolCalls) {
            if (controller.signal.aborted) break;
            const callStartedAt = clock();
            let result: ToolResult;
            try {
              result = await deps.tools.execute(call, toolContext);
            } catch (error) {
              result = { ok: false, error: errorMessage(error) };
            }
            toolTraces.push({ call, result, durationMs: clock() - callStartedAt });
            if (!result.ok) {
              log.warn("tool call failed", { runId: request.runId, tool: call.name, error: result.error ?? "" });
            }
            const speech = result.speech?.trim() ?? "";
            if (speech.length > 0) toolSpeech.push(speech);
            conversation.push({
              role: "tool",
              content: JSON.stringify(toolResultPayload(result)),
              toolCallId: call.id,
              toolName: call.name,
            });
          }
          if (controller.signal.aborted) {
            finish = request.signal.aborted ? "cancelled" : "error";
            if (timedOut) finalText = TIMEOUT_TEXT;
            break;
          }
          toolRounds += 1;
        }
      }
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      if (timer !== null) clearTimeout(timer);
    }

    if (finish === "stop" && finalText.length === 0) {
      if (finalSpeech.length > 0) {
        finalText = finalSpeech;
      } else if (toolSpeech.length > 0) {
        finalText = toolSpeech.join(" ");
        finalSpeech = finalText;
      } else if (toolTraces.length > 0) {
        finalText = "Готово.";
        finalSpeech = finalText;
      } else {
        finalText = EMPTY_REPLY_TEXT;
        finalSpeech = finalText;
      }
    }
    if (finish !== "cancelled") {
      memory.push({ role: "user", content: request.text });
      if (finalText.length > 0) memory.push({ role: "assistant", content: finalText });
      const limit = historyLimit(config);
      if (limit === 0) memory = [];
      else if (memory.length > limit) memory = memory.slice(memory.length - limit);
    }

    const durationMs = clock() - startedAt;
    log.debug("brain turn finished", { runId: request.runId, finish, toolCalls: toolTraces.length, durationMs });
    return { text: finalText, speech: finalSpeech, toolTraces, audio, finish, durationMs };
  }

  return {
    respond,
    newConversation: (): void => {
      memory = [];
      log.debug("conversation reset");
    },
    history: (): ChatMessage[] =>
      memory.map((message) =>
        message.toolCalls === undefined
          ? { ...message }
          : { ...message, toolCalls: message.toolCalls.map((call) => ({ ...call })) },
      ),
    resetHistory: (): void => {
      memory = [];
      log.debug("history cleared");
    },
  };
}

function toolResultPayload(result: ToolResult): Record<string, unknown> {
  const payload: Record<string, unknown> = { ok: result.ok };
  if (result.data !== undefined) payload.data = result.data;
  const error = result.error?.trim() ?? "";
  if (error.length > 0) payload.error = error;
  return payload;
}
