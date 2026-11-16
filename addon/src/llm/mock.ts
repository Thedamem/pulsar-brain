/**
 * Deterministic mock provider for tests and demos without API keys.
 *
 * The mock answers like a real model: it returns tool calls for action requests, waits for
 * tool results (the brain appends them to the history) and then produces a short natural
 * confirmation. Tool argument schemas are the canonical ones from docs/contracts.md §5.2:
 *   ha.call_service        { domain, service, entity_id, data? }
 *   scheduler.add_once     { in_seconds | at, label, action }
 *   scheduler.cancel       { id: "all" }
 *   scheduler.add_recurring{ phrase, action, label? }
 *
 * Modes come from config.provider.mock.mode: smart (scenario parser), echo (repeat the input)
 * and scripted (steps from a JSON file in the addon data dir).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type {
  ChatMessage,
  LoggerLike,
  MockProviderConfig,
  ProviderCapabilities,
  ProviderContext,
  ProviderReply,
  ProviderLike,
  ToolCall,
  ToolSpec,
} from "../shared/types.js";
import {
  formatClock,
  formatMoscowDate,
  formatMoscowIso,
  formatMoscowTime,
  formatMoscowWeekday,
  nextMoscowClock,
  tryParseJson,
} from "./util.js";

export const MOCK_CAPABILITIES: ProviderCapabilities = {
  streaming: false,
  tools: true,
  nativeAudio: false,
  tts: false,
  models: false,
};

const DEFAULT_DATA_DIR = "/data";
const DEFAULT_LIGHT_ENTITY = "light.kitchen";
const DEFAULT_TV_ENTITY = "switch.tv";

// ─────────────────────────────────────────────────────────────── scenario model ──

type DeviceKind = "light" | "tv";
type DeviceService = "turn_on" | "turn_off";

interface DeviceAction {
  kind: DeviceKind;
  domain: string;
  service: DeviceService;
  entityId: string;
}

type MockIntent =
  | { kind: "cancel" }
  | { kind: "actions"; actions: DeviceAction[] }
  | { kind: "duration"; actions: DeviceAction[]; minutes: number }
  | { kind: "at_time"; actions: DeviceAction[]; at: number }
  | { kind: "recurring"; actions: DeviceAction[]; phrase: string; scheduleLabel: string }
  | { kind: "question"; text: string }
  | { kind: "unknown"; clarify: string };

export interface MockPlanOptions {
  /** Phrase fragment → entity_id; the provider passes config.aliases. */
  aliases?: Record<string, string>;
  /** Clock injection for deterministic tests, epoch ms. */
  now?: number;
}

export interface MockTurnPlan {
  text: string;
  speech: string;
  toolCalls: ToolCall[];
  finish: ProviderReply["finish"];
}

interface ObservedToolResult {
  name: string;
  ok: boolean;
  error: string | null;
}

// ──────────────────────────────────────────────────────────────── vocabulary ──

const ON_VERB_PREFIXES = ["включ", "вруб", "зажги", "зажгу", "подключ", "открой", "открыть", "запусти"];
const OFF_VERB_PREFIXES = ["выключ", "отключ", "погас", "потуши", "выруб", "закрой", "закрыть", "останови"];
/** Directionless verbs used by follow-up phrases like "а теперь сделай". */
const REPEAT_VERB_PREFIXES = ["сделай", "сделать", "повтори", "повторить"];
const LIGHT_PREFIXES = ["свет", "ламп", "люстр", "освещ", "торшер", "бра"];
const TV_PREFIXES = ["телевизор", "телека", "телик", "тели"];
const CANCEL_PREFIXES = ["отмен"];

const QUESTION_TIME_RE = /(котор(?:ый|ое)\s+час|сколько\s+(?:сейчас\s+)?врем|текущ\w*\s+врем)/;
const QUESTION_DATE_RE = /(какой\s+(?:сегодня\s+)?(?:день|число|дата)|какое\s+сегодня\s+число|какое\s+сегодня\s+число)/;
const QUESTION_SKILLS_RE = /(что\s+ты\s+умеешь|что\s+ты\s+можешь|какие\s+у\s+тебя\s+возможности|твои\s+возможности)/;
const QUESTION_WEATHER_RE = /погод/;
const QUESTION_GREETING_RE = /^(привет|здравствуй|здравствуйте|добрый\s+(?:день|вечер)|доброе\s+утро)(?![а-яё])/u;
const QUESTION_THANKS_RE = /(спасибо|благодар)/;
const QUESTION_HOW_ARE_YOU_RE = /(как\s+дела|как\s+ты\s+себя)/;
const QUESTION_WHO_RE = /(кто\s+ты|как\s+тебя\s+зовут)/;
const RECURRING_RE =
  /(кажд(?:ый|ую|ое|ые)\s+(?:день|утро|вечер|понедельник\w*|вторник\w*|сред\w*|четверг\w*|пятниц\w*|суббот\w*|воскресень\w*)|по\s+будням|по\s+выходным|ежедневно)/;

// ────────────────────────────────────────────────────────────── entry point ──

/**
 * Pure planner for one smart-mode mock turn. `messages` is the conversation as the brain
 * sends it: prior turns plus, after a tool round, role:"tool" results.
 */
export function planMockTurn(
  messages: readonly ChatMessage[],
  toolsAvailable: readonly ToolSpec[],
  options: MockPlanOptions = {},
): MockTurnPlan {
  const aliases = options.aliases ?? {};
  const now = options.now ?? Date.now();
  const toolNames = new Set(toolsAvailable.map((tool) => tool.name));
  const lastUserIndex = findLastUserIndex(messages);
  const userText = lastUserIndex >= 0 ? messages[lastUserIndex]?.content ?? "" : "";
  const turnMessages = lastUserIndex >= 0 ? messages.slice(lastUserIndex + 1) : [];
  const results = turnMessages.filter((message) => message.role === "tool").map(readToolResult);
  const firstCallNumber = results.length + 1;
  const implicitAction = resolveImplicitDevice(messages, lastUserIndex, aliases);
  if (results.length > 0) {
    return planAfterToolResults(userText, results, toolNames, aliases, now, firstCallNumber, implicitAction);
  }
  return planFirstStep(userText, toolNames, aliases, now, firstCallNumber, implicitAction);
}

function planFirstStep(
  userText: string,
  toolNames: ReadonlySet<string>,
  aliases: Record<string, string>,
  now: number,
  firstCallNumber: number,
  implicitAction: DeviceAction | undefined,
): MockTurnPlan {
  const intent = classifyIntent(userText, aliases, now, implicitAction);
  switch (intent.kind) {
    case "cancel": {
      if (!toolNames.has("scheduler.cancel")) return textPlan("Не могу отменить: инструменты планировщика недоступны.");
      return toolPlan([makeToolCall(firstCallNumber, "scheduler.cancel", { id: "all" })]);
    }
    case "duration": {
      if (!toolNames.has("ha.call_service")) return textPlan("Не могу управлять устройствами: инструмент HA недоступен.");
      return toolPlan(intent.actions.map((action, index) => haCallServiceCall(action, firstCallNumber + index)));
    }
    case "at_time": {
      if (!toolNames.has("scheduler.add_once")) return textPlan("Не могу поставить таймер: инструмент планировщика недоступен.");
      return toolPlan(
        intent.actions.map((action, index) =>
          scheduleOnceCall({ action, at: intent.at, inSeconds: null, label: actionLabel(action) }, firstCallNumber + index),
        ),
      );
    }
    case "recurring": {
      if (!toolNames.has("scheduler.add_recurring")) return textPlan("Не могу создать расписание: инструмент недоступен.");
      return toolPlan(
        intent.actions.map((action, index) => scheduleRecurringCall(intent.phrase, action, firstCallNumber + index)),
      );
    }
    case "actions": {
      if (!toolNames.has("ha.call_service")) return textPlan("Не могу управлять устройствами: инструмент HA недоступен.");
      return toolPlan(intent.actions.map((action, index) => haCallServiceCall(action, firstCallNumber + index)));
    }
    case "question":
      return textPlan(intent.text);
    case "unknown":
      return textPlan(intent.clarify);
  }
}

function planAfterToolResults(
  userText: string,
  results: readonly ObservedToolResult[],
  toolNames: ReadonlySet<string>,
  aliases: Record<string, string>,
  now: number,
  firstCallNumber: number,
  implicitAction: DeviceAction | undefined,
): MockTurnPlan {
  const intent = classifyIntent(userText, aliases, now, implicitAction);
  const failed = results.find((result) => !result.ok);
  if (intent.kind === "recurring" && failed !== undefined) {
    return textPlan("Не смогла разобрать расписание. Скажите точнее: каждый день, по будням или в конкретный день недели?");
  }
  if (failed !== undefined) return textPlan(`Не получилось: ${failed.error ?? failed.name}.`);
  switch (intent.kind) {
    case "duration": {
      const scheduled = results.some((result) => result.name === "scheduler.add_once");
      const onlyDeviceCalls = results.every((result) => result.name === "ha.call_service");
      if (!scheduled && onlyDeviceCalls) {
        if (!toolNames.has("scheduler.add_once")) return textPlan("Не могу поставить таймер: инструмент планировщика недоступен.");
        const calls = intent.actions.map((action, index) => {
          const reverse = reverseAction(action);
          return scheduleOnceCall(
            { action: reverse, at: null, inSeconds: intent.minutes * 60, label: actionLabel(reverse) },
            firstCallNumber + index,
          );
        });
        return toolPlan(calls);
      }
      return textPlan(durationConfirmation(intent));
    }
    case "at_time":
      return textPlan(atTimeConfirmation(intent));
    case "recurring":
      return textPlan("Готово, повторяющееся действие создано.");
    case "cancel":
      return textPlan("Отменила все таймеры.");
    case "actions":
      return textPlan(actionsConfirmation(intent.actions));
    case "question":
      return textPlan(intent.text);
    case "unknown":
      return textPlan("Готово.");
  }
}

// ──────────────────────────────────────────────────────────────── classifying ──

function classifyIntent(
  userText: string,
  aliases: Record<string, string>,
  now: number,
  implicitAction: DeviceAction | undefined,
): MockIntent {
  const norm = normalize(userText);
  if (norm.length === 0) return { kind: "unknown", clarify: "Не расслышала. Повторите, пожалуйста." };
  const tokens = tokenize(norm);
  const negated = /(?:^|\s)не\s+\S*отмен/.test(norm);
  if (!negated && hasAnyPrefix(tokens, CANCEL_PREFIXES)) return { kind: "cancel" };
  const actions = planDeviceActions(norm, aliases);
  // Follow-up ellipsis: "а теперь выключи" has a verb but no device; reuse the previous one.
  if (actions.length === 0 && implicitAction !== undefined) {
    const requested = requestedService(tokens);
    if (requested !== null) {
      const service = requested === "repeat" ? implicitAction.service : requested;
      actions.push({ ...implicitAction, service });
    }
  }
  const recurring = parseRecurring(norm);
  const durationMinutes = parseDurationMinutes(norm);
  const at = parseAtTime(norm, now);
  if (recurring !== null && actions.length > 0) {
    return { kind: "recurring", actions, phrase: userText.trim(), scheduleLabel: recurring.scheduleLabel };
  }
  if (durationMinutes !== null && actions.length > 0) return { kind: "duration", actions, minutes: durationMinutes };
  if (at !== null && actions.length > 0) return { kind: "at_time", actions, at };
  if (actions.length > 0) return { kind: "actions", actions };
  const answer = answerQuestion(norm, now);
  if (answer !== null) return { kind: "question", text: answer };
  if (requestedService(tokens) !== null) {
    return { kind: "unknown", clarify: "Уточните, пожалуйста: какое устройство включить или выключить?" };
  }
  return { kind: "unknown", clarify: "Не поняла запрос. Скажите иначе, пожалуйста." };
}

/**
 * Follow-up ellipsis support: "а теперь выключи" has a verb but no device, so the device is
 * taken from the previous successful action in the history — a recorded ha.call_service tool
 * call first, then the last user phrase that mentioned a device and was not answered with an
 * error. Returns undefined when there is nothing to infer from.
 */
function resolveImplicitDevice(
  messages: readonly ChatMessage[],
  lastUserIndex: number,
  aliases: Record<string, string>,
): DeviceAction | undefined {
  const previous = messages.slice(0, Math.max(0, lastUserIndex));
  for (let index = previous.length - 1; index >= 0; index -= 1) {
    const message = previous[index];
    if (message?.role !== "assistant") continue;
    const toolCalls = message.toolCalls ?? [];
    for (let callIndex = toolCalls.length - 1; callIndex >= 0; callIndex -= 1) {
      const call = toolCalls[callIndex];
      if (call === undefined || call.name !== "ha.call_service") continue;
      if (!toolCallSucceeded(previous, call.id)) continue;
      const action = deviceActionFromToolCall(call);
      if (action !== undefined) return action;
    }
  }
  for (let index = previous.length - 1; index >= 0; index -= 1) {
    const message = previous[index];
    if (message?.role !== "user") continue;
    const actions = planDeviceActions(normalize(message.content), aliases);
    const lastAction = actions[actions.length - 1];
    if (lastAction === undefined) continue;
    if (answeredWithError(previous, index)) continue;
    return lastAction;
  }
  return undefined;
}

/** Direction requested by the current phrase, or "repeat" for directionless verbs. */
function requestedService(tokens: readonly string[]): DeviceService | "repeat" | null {
  if (hasAnyPrefix(tokens, OFF_VERB_PREFIXES)) return "turn_off";
  if (hasAnyPrefix(tokens, ON_VERB_PREFIXES)) return "turn_on";
  if (hasAnyPrefix(tokens, REPEAT_VERB_PREFIXES)) return "repeat";
  return null;
}

function toolCallSucceeded(messages: readonly ChatMessage[], callId: string): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "tool" || message.toolCallId !== callId) continue;
    const parsed = tryParseJson(message.content);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return (parsed as Record<string, unknown>).ok !== false;
    }
    return true;
  }
  // The result may not be part of the retained history yet; the recorded call is still a valid
  // device context.
  return true;
}

function answeredWithError(messages: readonly ChatMessage[], userIndex: number): boolean {
  for (let index = userIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === "user") return false;
    if (message?.role === "assistant") return message.content.trimStart().startsWith("Не получилось");
  }
  return false;
}

function deviceActionFromToolCall(call: ToolCall): DeviceAction | undefined {
  const args = tryParseJson(call.argumentsJson);
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  const domain = typeof record.domain === "string" ? record.domain : "";
  const entityId = typeof record.entity_id === "string" ? record.entity_id : "";
  const service = record.service === "turn_on" ? "turn_on" : record.service === "turn_off" ? "turn_off" : null;
  if (entityId.length === 0 || service === null) return undefined;
  if (domain !== "light" && domain !== "switch" && domain !== "media_player") return undefined;
  const kind: DeviceKind = domain === "light" ? "light" : "tv";
  return { kind, domain, service, entityId };
}

function planDeviceActions(norm: string, aliases: Record<string, string>): DeviceAction[] {
  const clauses = splitClauses(norm);
  const actions: DeviceAction[] = [];
  let currentService: DeviceService | null = null;
  for (const clause of clauses) {
    const tokens = tokenize(clause);
    if (hasAnyPrefix(tokens, OFF_VERB_PREFIXES)) currentService = "turn_off";
    else if (hasAnyPrefix(tokens, ON_VERB_PREFIXES)) currentService = "turn_on";
    const devices = detectDevices(tokens);
    for (const device of devices) {
      actions.push(buildDeviceAction(device, currentService ?? "turn_on", norm, aliases));
    }
  }
  return dedupeActions(actions);
}

function buildDeviceAction(
  kind: DeviceKind,
  service: DeviceService,
  normText: string,
  aliases: Record<string, string>,
): DeviceAction {
  if (kind === "light") {
    const entityId = findAliasEntity(normText, aliases, ["light."]) ?? DEFAULT_LIGHT_ENTITY;
    return { kind, domain: entityDomain(entityId, "light"), service, entityId };
  }
  const entityId = findAliasEntity(normText, aliases, ["switch.", "media_player."]) ?? DEFAULT_TV_ENTITY;
  return { kind, domain: entityDomain(entityId, "switch"), service, entityId };
}

function entityDomain(entityId: string, fallback: string): string {
  const separator = entityId.indexOf(".");
  return separator > 0 ? entityId.slice(0, separator) : fallback;
}

function findAliasEntity(normText: string, aliases: Record<string, string>, prefixes: readonly string[]): string | undefined {
  let best: { phraseLength: number; entityId: string } | undefined;
  for (const [phrase, entityId] of Object.entries(aliases)) {
    const normalizedPhrase = normalize(phrase);
    if (normalizedPhrase.length === 0 || !normText.includes(normalizedPhrase)) continue;
    if (!prefixes.some((prefix) => entityId.startsWith(prefix))) continue;
    if (best === undefined || normalizedPhrase.length > best.phraseLength) {
      best = { phraseLength: normalizedPhrase.length, entityId };
    }
  }
  return best?.entityId;
}

// ───────────────────────────────────────────────────────────────── parsing ──

function parseDurationMinutes(norm: string): number | null {
  const match = /на\s+(\d{1,3})\s*(минут(?:у|ы)?|мин|час(?:а|ов)?|ч)(?![а-яё])/u.exec(norm);
  if (match !== null) {
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) return null;
    const unit = match[2] ?? "мин";
    const minutes = unit.startsWith("мин") ? value : value * 60;
    return minutes > 0 && minutes <= 24 * 60 ? minutes : null;
  }
  if (/на\s+полчаса/.test(norm)) return 30;
  return null;
}

function parseAtTime(norm: string, now: number): number | null {
  const withMinutes = /(?:^|\s)в\s+(\d{1,2}):(\d{2})(?:\s|$)/.exec(norm);
  if (withMinutes !== null) {
    const hour = Number(withMinutes[1]);
    const minute = Number(withMinutes[2]);
    if (hour <= 23 && minute <= 59) return nextMoscowClock(hour, minute, now);
    return null;
  }
  const withWord = /(?:^|\s)в\s+(\d{1,2})\s*(?:час(?:а|ов)?|ч)(?![а-яё])/u.exec(norm);
  if (withWord !== null) {
    const hour = Number(withWord[1]);
    if (hour <= 23) return nextMoscowClock(hour, 0, now);
    return null;
  }
  const atEnd = /(?:^|\s)в\s+(\d{1,2})\s*$/.exec(norm);
  if (atEnd !== null) {
    const hour = Number(atEnd[1]);
    if (hour <= 23) return nextMoscowClock(hour, 0, now);
  }
  return null;
}

function parseRecurring(norm: string): { scheduleLabel: string } | null {
  const marker = RECURRING_RE.exec(norm);
  if (marker === null) return null;
  const tail = norm.slice(marker.index + marker[0].length);
  const withMinutes = /в\s+(\d{1,2}):(\d{2})/.exec(tail) ?? /в\s+(\d{1,2}):(\d{2})/.exec(norm);
  if (withMinutes !== null) {
    const hour = Number(withMinutes[1]);
    const minute = Number(withMinutes[2]);
    if (hour <= 23 && minute <= 59) return { scheduleLabel: `${marker[1] ?? marker[0]} в ${formatClock(hour, minute)}` };
    return null;
  }
  const hourOnly = /в\s+(\d{1,2})(?:\s*(?:час(?:а|ов)?|ч))?(?![а-яё])/u.exec(tail) ?? /в\s+(\d{1,2})(?:\s*(?:час(?:а|ов)?|ч))?(?![а-яё])/u.exec(norm);
  if (hourOnly !== null) {
    const hour = Number(hourOnly[1]);
    if (hour <= 23) return { scheduleLabel: `${marker[1] ?? marker[0]} в ${formatClock(hour, 0)}` };
  }
  return null;
}

function answerQuestion(norm: string, now: number): string | null {
  if (QUESTION_TIME_RE.test(norm)) return `Сейчас ${formatMoscowTime(now)}.`;
  if (QUESTION_DATE_RE.test(norm)) return `Сегодня ${formatMoscowWeekday(now)}, ${formatMoscowDate(now)}.`;
  if (QUESTION_SKILLS_RE.test(norm)) {
    return "Включаю и выключаю свет, управляю телевизором, ставлю таймеры и напоминания, отвечаю на вопросы.";
  }
  if (QUESTION_WEATHER_RE.test(norm)) {
    return "Погоду я не знаю: у меня нет доступа к прогнозу. Могу включить свет или поставить таймер.";
  }
  if (QUESTION_GREETING_RE.test(norm)) return "Здравствуйте. Слушаю.";
  if (QUESTION_THANKS_RE.test(norm)) return "Пожалуйста.";
  if (QUESTION_HOW_ARE_YOU_RE.test(norm)) return "Всё в порядке, работаю.";
  if (QUESTION_WHO_RE.test(norm)) return "Я голосовой ассистент умного дома.";
  return null;
}

// ─────────────────────────────────────────────────────────────── confirmations ──

function actionsConfirmation(actions: readonly DeviceAction[]): string {
  const first = actions[0];
  if (first === undefined) return "Готово.";
  if (actions.every((action) => action.service === first.service)) {
    const devices = joinNatural(actions.map((action) => deviceAccusative(action.kind)));
    return `${pastVerb(first.service)} ${devices}.`;
  }
  const parts = actions.map(
    (action) => `${deviceAccusative(action.kind)} ${pastVerbShort(action.service)}`,
  );
  return `Готово: ${parts.join(", ")}.`;
}

function durationConfirmation(intent: Extract<MockIntent, { kind: "duration" }>): string {
  const first = intent.actions[0];
  if (first === undefined) return "Готово.";
  const devices = joinNatural(intent.actions.map((action) => deviceAccusative(action.kind)));
  return `${pastVerb(first.service)} ${devices} на ${intent.minutes} ${minutesWord(intent.minutes)}.`;
}

function atTimeConfirmation(intent: Extract<MockIntent, { kind: "at_time" }>): string {
  const first = intent.actions[0];
  if (first === undefined) return "Готово.";
  const devices = joinNatural(intent.actions.map((action) => deviceAccusative(action.kind)));
  return `Хорошо, ${futureVerb(first.service)} ${devices} в ${formatMoscowTime(intent.at)}.`;
}

function deviceAccusative(kind: DeviceKind): string {
  return kind === "light" ? "свет" : "телевизор";
}

function pastVerb(service: DeviceService): string {
  return service === "turn_on" ? "Включила" : "Выключила";
}

function pastVerbShort(service: DeviceService): string {
  return service === "turn_on" ? "включила" : "выключила";
}

function futureVerb(service: DeviceService): string {
  return service === "turn_on" ? "включу" : "выключу";
}

function minutesWord(minutes: number): string {
  const mod10 = minutes % 10;
  const mod100 = minutes % 100;
  if (mod10 === 1 && mod100 !== 11) return "минуту";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "минуты";
  return "минут";
}

function joinNatural(items: readonly string[]): string {
  if (items.length === 0) return "";
  const first = items[0];
  if (first === undefined) return "";
  if (items.length === 1) return first;
  if (items.length === 2) return `${first} и ${items[1] ?? ""}`;
  return `${items.slice(0, -1).join(", ")} и ${items[items.length - 1] ?? ""}`;
}

// ───────────────────────────────────────────────────────────────── tool calls ──

function makeToolCall(callNumber: number, name: string, args: Record<string, unknown>): ToolCall {
  return { id: `mock_call_${callNumber}`, name, argumentsJson: JSON.stringify(args) };
}

function haCallServiceCall(action: DeviceAction, callNumber: number): ToolCall {
  return makeToolCall(callNumber, "ha.call_service", {
    domain: action.domain,
    service: action.service,
    entity_id: action.entityId,
  });
}

function scheduleOnceCall(
  options: { action: DeviceAction; at: number | null; inSeconds: number | null; label: string },
  callNumber: number,
): ToolCall {
  const args: Record<string, unknown> = {
    label: options.label,
    action: canonicalAction(options.action),
  };
  if (options.inSeconds !== null) args.in_seconds = options.inSeconds;
  if (options.at !== null) args.at = formatMoscowIso(options.at);
  return makeToolCall(callNumber, "scheduler.add_once", args);
}

function scheduleRecurringCall(phrase: string, action: DeviceAction, callNumber: number): ToolCall {
  return makeToolCall(callNumber, "scheduler.add_recurring", {
    phrase,
    action: canonicalAction(action),
    label: actionLabel(action),
  });
}

function canonicalAction(action: DeviceAction): Record<string, unknown> {
  return {
    kind: "ha.call_service",
    request: { domain: action.domain, service: action.service, entity_id: action.entityId },
  };
}

function actionLabel(action: DeviceAction): string {
  const verb = action.service === "turn_on" ? "Включить" : "Выключить";
  return `${verb} ${deviceAccusative(action.kind)}`;
}

function reverseAction(action: DeviceAction): DeviceAction {
  return { ...action, service: action.service === "turn_on" ? "turn_off" : "turn_on" };
}

// ─────────────────────────────────────────────────────────────────── helpers ──

function textPlan(text: string): MockTurnPlan {
  return { text, speech: text, toolCalls: [], finish: "stop" };
}

function toolPlan(toolCalls: ToolCall[]): MockTurnPlan {
  return { text: "", speech: "", toolCalls, finish: "tool_calls" };
}

function findLastUserIndex(messages: readonly ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

function readToolResult(message: ChatMessage): ObservedToolResult {
  const name = message.toolName ?? "";
  const parsed = tryParseJson(message.content);
  let ok = true;
  let error: string | null = null;
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    if (record.ok === false) ok = false;
    if (typeof record.error === "string" && record.error.trim().length > 0) error = record.error.trim();
    if (!ok && error === null) error = "инструмент вернул ошибку";
  }
  return { name, ok, error };
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(norm: string): string[] {
  return norm.split(/[^a-zа-я0-9]+/).filter((token) => token.length > 0);
}

function hasAnyPrefix(tokens: readonly string[], prefixes: readonly string[]): boolean {
  return tokens.some((token) => prefixes.some((prefix) => token.startsWith(prefix)));
}

function detectDevices(tokens: readonly string[]): DeviceKind[] {
  const devices: DeviceKind[] = [];
  if (hasAnyPrefix(tokens, LIGHT_PREFIXES)) devices.push("light");
  if (tokens.includes("тв") || hasAnyPrefix(tokens, TV_PREFIXES)) devices.push("tv");
  return devices;
}

function splitClauses(norm: string): string[] {
  return norm
    .split(/\s+и\s+|,\s*|;\s*|\s+а\s+также\s+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

function dedupeActions(actions: readonly DeviceAction[]): DeviceAction[] {
  const seen = new Set<string>();
  const result: DeviceAction[] = [];
  for (const action of actions) {
    const key = `${action.entityId}|${action.service}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(action);
  }
  return result;
}

// ────────────────────────────────────────────────────────────────── scripted ──

const toolCallStepSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.unknown()).optional().default({}),
  id: z.string().min(1).optional(),
});

const scriptStepSchema = z.object({
  match: z.string().min(1),
  reply: z.string().optional().default(""),
  toolCalls: z.array(toolCallStepSchema).optional().default([]),
});

const mockScriptSchema = z.array(scriptStepSchema);

interface ScriptStep {
  match: RegExp;
  reply: string;
  toolCalls: ToolCall[];
}

async function loadScript(dataDir: string, scriptFile: string): Promise<ScriptStep[]> {
  const name = scriptFile.trim();
  if (name.length === 0) throw new Error("mock scripted mode: provider.mock.scriptFile is empty");
  const root = path.resolve(dataDir);
  const target = path.resolve(root, name);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`mock scripted mode: script file escapes the data dir: ${name}`);
  }
  const raw = await fs.readFile(target, "utf8");
  const parsed = mockScriptSchema.safeParse(tryParseJson(raw));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`mock scripted mode: invalid script file ${name}: ${issue?.message ?? "schema mismatch"}`);
  }
  return parsed.data.map((step, stepIndex) => ({
    match: compileMatchRegExp(step.match, stepIndex),
    reply: step.reply,
    toolCalls: step.toolCalls.map((call, callIndex) => ({
      id: call.id ?? `script_${stepIndex}_${callIndex}`,
      name: call.name,
      argumentsJson: JSON.stringify(call.arguments),
    })),
  }));
}

function compileMatchRegExp(pattern: string, stepIndex: number): RegExp {
  try {
    return new RegExp(pattern, "i");
  } catch (error) {
    throw new Error(`mock scripted mode: invalid match regex in step ${stepIndex}: ${String(error)}`);
  }
}

// ─────────────────────────────────────────────────────────────────── provider ──

export interface MockProviderDeps {
  log: LoggerLike;
  /** Addon data dir for scripted mode; defaults to PULSAR_BRAIN_DATA_DIR or /data. */
  dataDir?: string;
}

export function createMockProvider(deps: MockProviderDeps): ProviderLike {
  const log = deps.log.child("mock");
  const dataDir = deps.dataDir ?? process.env.PULSAR_BRAIN_DATA_DIR ?? DEFAULT_DATA_DIR;
  return {
    id: "mock",
    label: "Mock (тесты)",
    capabilities: MOCK_CAPABILITIES,
    health: async () => ({ ok: true, detail: "mock provider is local, no network involved" }),
    listModels: async () => ["mock:smart", "mock:echo", "mock:scripted"],
    generate: (ctx) => generateMockReply(ctx, log, dataDir),
  };
}

async function generateMockReply(ctx: ProviderContext, log: LoggerLike, dataDir: string): Promise<ProviderReply> {
  const mockConfig: MockProviderConfig = ctx.config.provider.mock;
  log.debug("mock turn", { mode: mockConfig.mode, historyMessages: ctx.history.length });
  if (mockConfig.mode === "echo") return stopReply(lastUserContent(ctx.history));
  if (mockConfig.mode === "scripted") return scriptedReply(ctx, dataDir);
  const plan = planMockTurn(ctx.history, ctx.tools, { aliases: ctx.config.aliases, now: Date.now() });
  return { text: plan.text, speech: plan.speech, toolCalls: plan.toolCalls, finish: plan.finish };
}

function stopReply(text: string): ProviderReply {
  return { text, speech: text, toolCalls: [], finish: "stop" };
}

async function scriptedReply(ctx: ProviderContext, dataDir: string): Promise<ProviderReply> {
  const steps = await loadScript(dataDir, ctx.config.provider.mock.scriptFile);
  const lastUserIndex = findLastUserIndex(ctx.history);
  const turnMessages = lastUserIndex >= 0 ? ctx.history.slice(lastUserIndex + 1) : [];
  if (turnMessages.some((message) => message.role === "tool")) return stopReply("Готово.");
  const userText = lastUserContent(ctx.history);
  const step = steps.find((candidate) => candidate.match.test(userText));
  if (step === undefined) return stopReply("Сценарий для этой фразы не задан.");
  return {
    text: step.reply,
    speech: step.reply,
    toolCalls: step.toolCalls,
    finish: step.toolCalls.length > 0 ? "tool_calls" : "stop",
  };
}

function lastUserContent(messages: readonly ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message.content;
  }
  return "";
}
