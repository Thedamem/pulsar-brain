export interface HeaderLinesResult {
  headers: Record<string, string>;
  error: string | null;
}

export function formatHeaderLines(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

export function parseHeaderLines(text: string): HeaderLinesResult {
  const headers: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (line === "") continue;
    const separator = line.indexOf(":");
    if (separator <= 0) {
      return {
        headers,
        error: `Строка ${index + 1}: нужен формат «Имя: значение».`,
      };
    }
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (name === "") {
      return { headers, error: `Строка ${index + 1}: имя заголовка пустое.` };
    }
    if (Object.prototype.hasOwnProperty.call(headers, name)) {
      return { headers, error: `Заголовок «${name}» указан больше одного раза.` };
    }
    headers[name] = value;
  }
  return { headers, error: null };
}

export function parseArgLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
