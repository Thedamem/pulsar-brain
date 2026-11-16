/**
 * System prompt assembly for the voice assistant brain.
 * The prompt is rebuilt on every turn so config changes (aliases, language) and the
 * current time are always fresh. `now` is injected for deterministic tests.
 */

import type { AppConfig } from "../shared/types.js";
import { formatMoscowDateTime, MOSCOW_TIME_ZONE } from "../llm/util.js";

const LANGUAGE_NAMES: Record<string, string> = {
  ru: "русский",
  en: "английский",
};

/** Builds the full system prompt for one turn. */
export function buildSystemPrompt(config: AppConfig, now: number = Date.now()): string {
  const sections: string[] = [
    "Ты — голосовой ассистент умного дома. Тебя слушают через колонку, поэтому ответы должны звучать естественно.",
    buildRules(languageName(config.prompt.language)),
    `Текущие дата и время (${MOSCOW_TIME_ZONE}): ${formatMoscowDateTime(now)}.`,
    buildAliasesSection(config.aliases),
  ];
  const extra = config.prompt.system.trim();
  if (extra.length > 0) sections.push(`Дополнительные инструкции:\n${extra}`);
  return sections.join("\n\n");
}

function languageName(code: string): string {
  const normalized = code.trim().toLowerCase();
  if (normalized.length === 0) return LANGUAGE_NAMES.ru ?? "русский";
  return LANGUAGE_NAMES[normalized] ?? normalized;
}

function buildRules(language: string): string {
  return [
    "Правила:",
    `- Язык ответа: ${language}.`,
    "- Отвечай кратко: одно-два предложения. Не пересказывай запрос и не извиняйся без причины.",
    "- Не читай вслух названия инструментов, их описания и JSON.",
    "- Не выдумывай устройства, сущности и entity_id. Используй точные entity_id из алиасов; если сущность неясна, задай один уточняющий вопрос.",
    "- Если в просьбе несколько действий, вызови несколько инструментов в одном ответе.",
    "- Время, таймеры, отложенные и повторяющиеся действия — только через инструменты планировщика. Не утверждай, что действие выполнено, пока инструмент не вернул успех.",
    "- Числа, время и суммы называй явно и цифрами: «через 10 минут», «в 22:00», «1 200 рублей».",
    "- Если инструмент вернул ошибку, честно скажи, что не получилось, и назови причину без технических подробностей.",
  ].join("\n");
}

function buildAliasesSection(aliases: Record<string, string>): string {
  const entries = Object.entries(aliases)
    .map(([phrase, entityId]) => [phrase.trim(), entityId.trim()] as const)
    .filter(([phrase, entityId]) => phrase.length > 0 && entityId.length > 0)
    .sort(([left], [right]) => left.localeCompare(right, "ru"));
  if (entries.length === 0) {
    return "Алиасы не настроены. Если нужной сущности нет, сначала вызови ha.list_entities или задай один уточняющий вопрос; не придумывай entity_id.";
  }
  const lines = entries.map(([phrase, entityId]) => `- «${phrase}» → ${entityId}`);
  return [
    "Алиасы сущностей (фраза → entity_id):",
    ...lines,
    "Если фразы нет в алиасах, не придумывай entity_id: вызови ha.list_entities или задай один уточняющий вопрос.",
  ].join("\n");
}
