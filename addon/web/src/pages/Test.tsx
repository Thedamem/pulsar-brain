import { useState } from "react";
import type { FormEvent } from "react";
import { api, errorText } from "../api";
import { useDocumentTitle } from "../hooks";
import { formatDuration, formatNumber } from "../format";
import type { TestAudioResponse, TestTextResponse } from "../../../src/shared/protocol";
import type { BrainToolTrace } from "../../../src/shared/types";
import {
  Field,
  LoadingBlock,
  Notice,
  PageHeader,
  Section,
  StatusText,
  TableScroll,
} from "../components/ui";

export function TestPage() {
  useDocumentTitle("Тест");
  const [text, setText] = useState("");
  const [textResult, setTextResult] = useState<TestTextResponse | null>(null);
  const [textLoading, setTextLoading] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [audioResult, setAudioResult] = useState<TestAudioResponse | null>(null);
  const [audioLoading, setAudioLoading] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);

  const submitText = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (text.trim() === "") {
      setTextError("Введите текст команды.");
      return;
    }
    setTextLoading(true);
    setTextError(null);
    try {
      const result = await api.testText(text.trim());
      setTextResult(result);
    } catch (caught) {
      setTextError(errorText(caught));
    } finally {
      setTextLoading(false);
    }
  };

  const submitAudio = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file) {
      setAudioError("Выберите WAV-файл.");
      return;
    }
    setAudioLoading(true);
    setAudioError(null);
    try {
      const result = await api.testAudio(file);
      setAudioResult(result);
    } catch (caught) {
      setAudioError(errorText(caught));
    } finally {
      setAudioLoading(false);
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Тест"
        description="Прогон текста и WAV через мозг без колонки. Показываются ответ, вызовы инструментов и тайминги."
      />

      <Section
        id="text-test"
        title="Текст"
        description="Команда проходит через модель и инструменты так же, как голосовая, только без распознавания речи."
      >
        <form className="form" onSubmit={(event) => void submitText(event)} noValidate>
          <Field id="test-text" label="Команда" hint="Например: включи свет на кухне.">
            <textarea
              id="test-text"
              rows={3}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Текст команды"
            />
          </Field>
          <div className="inline-actions">
            <button
              type="submit"
              className="btn btn--primary"
              disabled={textLoading}
              title={text.trim() === "" ? "Введите текст команды" : undefined}
            >
              {textLoading ? "Выполнение…" : "Отправить"}
            </button>
          </div>
        </form>

        {textLoading ? <LoadingBlock label="Модель обрабатывает команду…" /> : null}
        {textError ? <Notice kind="error">{textError}</Notice> : null}
        {textResult ? (
          <div className="result" aria-live="polite">
            <ResultMeta
              provider={textResult.provider}
              timings={[
                ["Модель", textResult.timings.llmMs],
                ["Всего", textResult.timings.totalMs],
              ]}
            />
            {textResult.transcript ? (
              <>
                <h3>Распознано</h3>
                <p className="prose">{textResult.transcript}</p>
              </>
            ) : null}
            <h3>Ответ</h3>
            <p className="prose">{textResult.text || "Пустой ответ."}</p>
            {textResult.speech && textResult.speech !== textResult.text ? (
              <>
                <h3>Озвучено</h3>
                <p className="prose">{textResult.speech}</p>
              </>
            ) : null}
            <ToolTraces traces={textResult.toolTraces} />
          </div>
        ) : null}
      </Section>

      <Section
        id="audio-test"
        title="Аудио"
        description="WAV уходит в распознавание речи, затем текст проходит тот же путь, что и в текстовом тесте."
      >
        <form className="form" onSubmit={(event) => void submitAudio(event)} noValidate>
          <Field
            id="test-audio-file"
            label="Файл WAV"
            hint="Моно, 16 кГц. Другие форматы могут не распознаться."
          >
            <input
              id="test-audio-file"
              type="file"
              accept=".wav,audio/wav,audio/x-wav"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setAudioError(null);
              }}
            />
          </Field>
          {file ? (
            <p className="field-hint">
              {file.name}, {formatNumber(Math.max(1, Math.round(file.size / 1024)))} КБ
            </p>
          ) : null}
          <div className="inline-actions">
            <button
              type="submit"
              className="btn btn--secondary"
              disabled={audioLoading}
              title={file === null ? "Выберите WAV-файл" : undefined}
            >
              {audioLoading ? "Распознавание…" : "Распознать WAV"}
            </button>
          </div>
        </form>

        {audioLoading ? <LoadingBlock label="Распознаю и обрабатываю аудио…" /> : null}
        {audioError ? <Notice kind="error">{audioError}</Notice> : null}
        {audioResult ? (
          <div className="result" aria-live="polite">
            <ResultMeta
              provider={audioResult.provider}
              timings={[
                ["Распознавание", audioResult.timings.sttMs],
                ["Модель", audioResult.timings.llmMs],
                ["Всего", audioResult.timings.totalMs],
              ]}
            />
            <h3>Распознано</h3>
            <p className="prose">{audioResult.transcript || "Речь не распознана."}</p>
            <h3>Ответ</h3>
            <p className="prose">{audioResult.text || "Пустой ответ."}</p>
            {audioResult.speech && audioResult.speech !== audioResult.text ? (
              <>
                <h3>Озвучено</h3>
                <p className="prose">{audioResult.speech}</p>
              </>
            ) : null}
            <ToolTraces traces={audioResult.toolTraces} />
          </div>
        ) : null}
      </Section>
    </div>
  );
}

function ResultMeta(props: { provider: string; timings: Array<[string, number]> }) {
  return (
    <p className="result-meta">
      <span>
        <span className="muted">Провайдер:</span> <span className="mono">{props.provider}</span>
      </span>
      {props.timings.map(([label, value]) => (
        <span key={label}>
          <span className="muted">{label}:</span>{" "}
          <span className="num">{formatDuration(value)}</span>
        </span>
      ))}
    </p>
  );
}

function ToolTraces(props: { traces: BrainToolTrace[] }) {
  if (props.traces.length === 0) {
    return (
      <>
        <h3>Инструменты</h3>
        <p className="muted">Инструменты не вызывались.</p>
      </>
    );
  }
  return (
    <>
      <h3>Инструменты</h3>
      <TableScroll label="Вызовы инструментов">
        <table className="table table--compact">
          <thead>
            <tr>
              <th scope="col">Инструмент</th>
              <th scope="col">Аргументы</th>
              <th scope="col">Результат</th>
              <th scope="col" className="num">
                Время
              </th>
            </tr>
          </thead>
          <tbody>
            {props.traces.map((trace, index) => (
              <tr key={`${trace.call.name}-${index}`}>
                <td className="mono">{trace.call.name}</td>
                <td className="mono cell-detail">{trace.call.argumentsJson || "—"}</td>
                <td>
                  <StatusText tone={trace.result.ok ? "ok" : "error"}>
                    {trace.result.ok ? "Успешно" : "Ошибка"}
                  </StatusText>
                  {!trace.result.ok && trace.result.error ? (
                    <span className="cell-note cell-note--error">{trace.result.error}</span>
                  ) : null}
                </td>
                <td className="num">{formatDuration(trace.durationMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </>
  );
}
