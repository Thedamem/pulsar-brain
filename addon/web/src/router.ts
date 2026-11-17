export type SectionId =
  | "overview"
  | "providers"
  | "assistant"
  | "mcp"
  | "scheduler"
  | "station"
  | "history"
  | "logs"
  | "diagnostics"
  | "test"
  | "settings";

export interface SectionDefinition {
  id: SectionId;
  path: string;
  title: string;
  group: "Наблюдение" | "Настройка";
}

export const SECTIONS: ReadonlyArray<SectionDefinition> = [
  { id: "overview", path: "", title: "Обзор", group: "Наблюдение" },
  { id: "history", path: "history", title: "История", group: "Наблюдение" },
  { id: "logs", path: "logs", title: "Логи", group: "Наблюдение" },
  { id: "diagnostics", path: "diagnostics", title: "Диагностика", group: "Наблюдение" },
  { id: "test", path: "test", title: "Тест", group: "Наблюдение" },
  { id: "providers", path: "providers", title: "Провайдеры", group: "Настройка" },
  { id: "assistant", path: "assistant", title: "Ассистент", group: "Настройка" },
  { id: "mcp", path: "mcp", title: "MCP", group: "Настройка" },
  { id: "scheduler", path: "scheduler", title: "Планировщик", group: "Настройка" },
  { id: "station", path: "station", title: "Станция", group: "Настройка" },
  { id: "settings", path: "settings", title: "Настройки", group: "Настройка" },
];

/**
 * The ingress prefix is unknown and may end with a segment that matches a tab name,
 * so derive it from the loaded module URL: .../assets/index-*.js or .../src/main.tsx.
 */
function computeBasePath(): string {
  const modulePath = new URL(import.meta.url).pathname;
  for (const marker of ["/assets/", "/src/"]) {
    const index = modulePath.lastIndexOf(marker);
    if (index >= 0) return modulePath.slice(0, index + 1);
  }
  return "/";
}

/** Trailing-slash base keeps navigation working behind the HA ingress prefix. */
export const BASE_PATH = computeBasePath();

export function hrefFor(section: SectionId): string {
  const definition = SECTIONS.find((item) => item.id === section);
  return `${BASE_PATH}${definition?.path ?? ""}`;
}

export function sectionFromLocation(): SectionId {
  const rest = window.location.pathname.slice(BASE_PATH.length).replace(/\/+$/, "");
  const first = rest.split("/")[0] ?? "";
  return SECTIONS.find((item) => item.path === first)?.id ?? "overview";
}

export function sectionTitle(id: SectionId): string {
  return SECTIONS.find((item) => item.id === id)?.title ?? "Обзор";
}
