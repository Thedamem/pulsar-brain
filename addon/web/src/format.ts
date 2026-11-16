const dateTimeFormatter = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const timestampFormatter = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const numberFormatter = new Intl.NumberFormat("ru-RU");

export function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

export function formatDateTime(value: number | null | undefined): string {
  if (!value) return "—";
  return dateTimeFormatter.format(new Date(value)).replace(",", "");
}

export function formatTimestamp(value: number | null | undefined): string {
  if (!value) return "—";
  return timestampFormatter.format(new Date(value)).replace(",", "");
}

export function formatLogTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(
    date.getMilliseconds(),
    3,
  )}`;
}

export function formatNumber(value: number): string {
  return numberFormatter.format(value);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} мс`;
  if (ms < 60_000) return `${(ms / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} с`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds > 0 ? `${minutes} мин ${seconds} с` : `${minutes} мин`;
}

export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} с`;
  const totalMinutes = Math.floor(seconds / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} д`);
  if (hours > 0) parts.push(`${hours} ч`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes} мин`);
  return parts.join(" ");
}

export function formatRelative(value: number | null | undefined, now = Date.now()): string {
  if (!value) return "—";
  const diff = now - value;
  if (diff < 0) {
    const ahead = Math.round(-diff / 1000);
    if (ahead < 60) return `через ${ahead} с`;
    if (ahead < 3600) return `через ${Math.round(ahead / 60)} мин`;
    if (ahead < 86_400) return `через ${Math.round(ahead / 3600)} ч`;
    return formatDateTime(value);
  }
  if (diff < 10_000) return "только что";
  if (diff < 60_000) return `${Math.round(diff / 1000)} с назад`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} мин назад`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} ч назад`;
  return formatDateTime(value);
}
