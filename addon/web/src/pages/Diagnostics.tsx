import { useCallback, useState } from "react";
import { api, errorText } from "../api";
import { useDocumentTitle, useLoader } from "../hooks";
import { formatDateTime, formatRelative } from "../format";
import type { DiagnosticsResponse } from "../../../src/shared/protocol";
import {
  ErrorBlock,
  LoadingBlock,
  Notice,
  PageHeader,
  Section,
  StatusText,
  TableScroll,
  useToast,
} from "../components/ui";

const DISCOVERY_LABELS: Record<DiagnosticsResponse["addon"]["discovery"]["state"], string> = {
  announced: "Объявлен Supervisor'у",
  failed: "Не удалось отправить",
  not_supervisor: "Нет SUPERVISOR_TOKEN",
  pending: "Ещё не отправлен",
};

function discoveryTone(state: DiagnosticsResponse["addon"]["discovery"]["state"]): "ok" | "warning" | "error" {
  if (state === "announced") return "ok";
  if (state === "failed") return "error";
  return "warning";
}

function ageText(timestamp: number | null): string {
  if (timestamp === null) return "ещё не было";
  return `${formatDateTime(timestamp)} (${formatRelative(timestamp)})`;
}

export function DiagnosticsPage() {
  useDocumentTitle("Диагностика");
  const notify = useToast();
  const load = useCallback((signal: AbortSignal) => api.diagnostics(signal), []);
  const { data, loading, error, reload, refresh } = useLoader<DiagnosticsResponse>(load, []);
  const [busy, setBusy] = useState<"discovery" | "autodetect" | null>(null);
  const [actionError, setActionError] = useState("");
  const [actionNotice, setActionNotice] = useState("");

  const runRediscovery = useCallback(async () => {
    setBusy("discovery");
    setActionError("");
    setActionNotice("");
    try {
      const result = await api.rediscover();
      if (result.announced) {
        setActionNotice(`Discovery отправлен, hostname: ${result.host ?? "неизвестен"}.`);
      } else {
        setActionError(`Supervisor отклонил discovery: ${result.reason ?? "неизвестная причина"}.`);
      }
      await refresh();
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const runAutodetect = useCallback(async () => {
    setBusy("autodetect");
    setActionError("");
    setActionNotice("");
    try {
      const result = await api.autodetect();
      setActionNotice(result.details);
      notify(result.applied ? "Адреса Whisper/Piper обновлены" : "Изменений не потребовалось");
      await refresh();
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setBusy(null);
    }
  }, [notify, refresh]);

  return (
    <>
      <PageHeader
        title="Диагностика"
        description="Состояние аддона, discovery, связи с Home Assistant и сервисами распознавания/синтеза."
        actions={
          <button type="button" className="btn btn--secondary" onClick={reload} disabled={loading}>
            {loading ? "Обновление…" : "Обновить"}
          </button>
        }
      />

      {error && data === null ? <ErrorBlock message={error} onRetry={reload} /> : null}
      {error && data !== null ? (
        <Notice kind="error">
          Не удалось обновить диагностику: {error}{" "}
          <button type="button" className="btn btn--quiet" onClick={reload}>
            Повторить
          </button>
        </Notice>
      ) : null}
      {actionError ? <Notice kind="error">{actionError}</Notice> : null}
      {actionNotice ? <Notice kind="success">{actionNotice}</Notice> : null}

      {loading && data === null ? <LoadingBlock label="Собираю диагностику…" /> : null}

      {data ? (
        <>
          <Section
            id="discovery"
            title="Аддон и discovery"
            description="Через discovery Home Assistant узнаёт адрес и токен аддона и создаёт интеграцию без полей."
            actions={
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => void runRediscovery()}
                disabled={busy !== null}
              >
                {busy === "discovery" ? "Отправляю…" : "Переотправить discovery"}
              </button>
            }
          >
            <dl className="dl">
              <dt>Версия</dt>
              <dd className="num">{data.version}</dd>
              <dt>Uptime</dt>
              <dd className="num">{data.uptimeSec} с</dd>
              <dt>Hostname аддона</dt>
              <dd className="mono">{data.addon.hostname ?? "неизвестен"}</dd>
              <dt>Порт API</dt>
              <dd className="num">{data.addon.port}</dd>
              <dt>Discovery</dt>
              <dd>
                <StatusText tone={discoveryTone(data.addon.discovery.state)}>
                  {DISCOVERY_LABELS[data.addon.discovery.state]}
                </StatusText>
                {data.addon.discovery.reason ? <span> — {data.addon.discovery.reason}</span> : null}
              </dd>
              <dt>Когда</dt>
              <dd className="num">{ageText(data.addon.discovery.at)}</dd>
              <dt>SUPERVISOR_TOKEN</dt>
              <dd>{data.addon.supervisorTokenConfigured ? "есть" : "нет"}</dd>
              <dt>access_token</dt>
              <dd>
                {data.addon.accessTokenConfigured
                  ? "задан: API доступен с Bearer-токеном"
                  : "не задан: внешний API и debug-роуты закрыты"}
              </dd>
            </dl>
            {!data.addon.supervisorTokenConfigured ? (
              <Notice kind="warning">
                Аддон запущен без SUPERVISOR_TOKEN (не через Supervisor). Автонастройка интеграции
                через discovery невозможна — настройте её вручную или устанавливайте аддон из
                магазина.
              </Notice>
            ) : null}
          </Section>

          <Section id="checks" title="Проверки">
            <TableScroll label="Состояние компонентов">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Компонент</th>
                    <th scope="col">Состояние</th>
                    <th scope="col">Детали</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Home Assistant</td>
                    <td>
                      <StatusText tone={data.checks.ha.ok ? "ok" : "error"}>
                        {data.checks.ha.ok ? "Доступен" : "Ошибка"}
                      </StatusText>
                    </td>
                    <td>{data.checks.ha.detail}</td>
                  </tr>
                  <tr>
                    <td>Распознавание речи</td>
                    <td>
                      <StatusText tone={data.checks.stt.ok ? "ok" : "error"}>
                        {data.checks.stt.ok ? "Работает" : "Ошибка"}
                      </StatusText>
                    </td>
                    <td>{data.checks.stt.detail}</td>
                  </tr>
                  <tr>
                    <td>Синтез речи</td>
                    <td>
                      <StatusText tone={data.checks.tts.ok ? "ok" : "error"}>
                        {data.checks.tts.ok ? "Работает" : "Ошибка"}
                      </StatusText>
                    </td>
                    <td>{data.checks.tts.detail}</td>
                  </tr>
                  <tr>
                    <td>Интеграция Pulsar Brain</td>
                    <td>
                      <StatusText tone={data.integration.connected ? "ok" : "warning"}>
                        {data.integration.connected ? "На связи" : "Нет данных"}
                      </StatusText>
                    </td>
                    <td>Список станций: {ageText(data.integration.lastStationsAt)}</td>
                  </tr>
                  <tr>
                    <td>Станция</td>
                    <td>
                      <StatusText tone={data.station.bound ? "ok" : "warning"}>
                        {data.station.bound ? "Привязана" : "Не привязана"}
                      </StatusText>
                    </td>
                    <td>{data.station.name ?? "выберите станцию в разделе «Станция»"}</td>
                  </tr>
                </tbody>
              </table>
            </TableScroll>
          </Section>

          <Section
            id="audio"
            title="Whisper и Piper"
            description="TCP-проверка настроенных адресов. Автоопределение ищет официальные аддоны по именам в сети Supervisor."
            actions={
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => void runAutodetect()}
                disabled={busy !== null}
              >
                {busy === "autodetect" ? "Ищу…" : "Автоопределить"}
              </button>
            }
          >
            <dl className="dl">
              <dt>Whisper (STT)</dt>
              <dd className="mono">
                {data.config.stt.host}:{data.config.stt.port}{" "}
                <StatusText tone={data.probes.stt.ok ? "ok" : "error"}>
                  {data.probes.stt.ok ? `${data.probes.stt.latencyMs} мс` : data.probes.stt.error}
                </StatusText>
              </dd>
              <dt>Piper (TTS)</dt>
              <dd className="mono">
                {data.config.tts.host}:{data.config.tts.port}{" "}
                <StatusText tone={data.probes.tts.ok ? "ok" : "error"}>
                  {data.probes.tts.ok ? `${data.probes.tts.latencyMs} мс` : data.probes.tts.error}
                </StatusText>
              </dd>
              <dt>Режим озвучки</dt>
              <dd>
                {data.config.tts.mode}, голос {data.config.tts.voice}
              </dd>
            </dl>
            {!data.probes.stt.ok || !data.probes.tts.ok ? (
              <Notice kind="warning">
                Если Whisper/Piper установлены аддонами, нажмите «Автоопределить»: аддон найдёт их
                по именам `core-whisper` и `core-piper` и сохранит адреса.
              </Notice>
            ) : null}
          </Section>

          <Section
            id="access"
            title="Внешний доступ к API"
            description="Нужен для отладки с другого устройства или агента. По умолчанию порт выключен."
          >
            {data.addon.accessTokenConfigured ? (
              <p>
                Включите порт <code>8097</code> в настройках сети аддона и обращайтесь к
                <code> http://&lt;IP-аддона&gt;:8097/api/debug/diagnostics</code> с заголовком
                <code> Authorization: Bearer &lt;access_token&gt;</code>.
              </p>
            ) : (
              <Notice kind="warning">
                Задайте <code>access_token</code> в разделе «Конфигурация» аддона и включите порт
                <code> 8097</code> в «Сети», чтобы открыть API для отладки. Без токена внешний
                доступ закрыт.
              </Notice>
            )}
          </Section>
        </>
      ) : null}
    </>
  );
}
