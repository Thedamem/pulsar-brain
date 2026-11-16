import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

// ───────────────────────────────────────────────────────────────── layout ──

export function PageHeader(props: {
  title: string;
  description?: string;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-header-main">
        <h1 id="page-title" tabIndex={-1}>
          {props.title}
        </h1>
        {props.description ? <p className="page-description">{props.description}</p> : null}
        {props.meta ? <p className="page-meta">{props.meta}</p> : null}
      </div>
      {props.actions ? <div className="page-actions">{props.actions}</div> : null}
    </header>
  );
}

export function Section(props: {
  id: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section" id={props.id} aria-labelledby={`${props.id}-title`}>
      <div className="section-head">
        <h2 id={`${props.id}-title`}>{props.title}</h2>
        {props.actions ? <div className="section-actions">{props.actions}</div> : null}
      </div>
      {props.description ? <p className="section-description">{props.description}</p> : null}
      {props.children}
    </section>
  );
}

export function TableScroll(props: { children: ReactNode; label?: string }) {
  return (
    <div className="table-scroll" role="region" aria-label={props.label} tabIndex={0}>
      {props.children}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── states ──

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function LoadingBlock(props: { label: string }) {
  return (
    <div className="state-block" role="status" aria-live="polite">
      <p className="state-line">
        <Spinner /> {props.label}
      </p>
      <div className="skeleton" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

export function ErrorBlock(props: { message: string; onRetry?: () => void; title?: string }) {
  return (
    <div className="state-block state-block--error" role="alert">
      <p className="state-title">{props.title ?? "Не удалось загрузить"}</p>
      <p className="state-text">{props.message}</p>
      {props.onRetry ? (
        <button type="button" className="btn btn--secondary" onClick={props.onRetry}>
          Повторить
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState(props: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="state-block">
      <p className="state-text">{props.children}</p>
      {props.action ? <div className="state-action">{props.action}</div> : null}
    </div>
  );
}

export type NoticeKind = "success" | "error" | "warning" | "info";

export function Notice(props: { kind: NoticeKind; children: ReactNode; id?: string }) {
  return (
    <div
      id={props.id}
      className={`notice notice--${props.kind}`}
      role={props.kind === "error" ? "alert" : "status"}
    >
      {props.children}
    </div>
  );
}

export function StatusText(props: {
  tone: "ok" | "error" | "warning" | "neutral" | "accent";
  children: ReactNode;
}) {
  return <span className={`status status--${props.tone}`}>{props.children}</span>;
}

// ────────────────────────────────────────────────────────────────── forms ──

export function Field(props: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className={`field${props.error ? " field--error" : ""}`}>
      <label className="field-label" htmlFor={props.id}>
        {props.label}
      </label>
      {props.children}
      {props.hint ? (
        <p className="field-hint" id={`${props.id}-hint`}>
          {props.hint}
        </p>
      ) : null}
      {props.error ? (
        <p className="field-error" id={`${props.id}-error`}>
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

export function NumberField(props: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  error?: string;
}) {
  const [text, setText] = useState(String(props.value));

  useEffect(() => {
    setText(String(props.value));
  }, [props.value]);

  const commit = () => {
    const parsed = Number(text.replace(",", "."));
    if (!Number.isFinite(parsed)) {
      setText(String(props.value));
      return;
    }
    const min = props.min ?? Number.NEGATIVE_INFINITY;
    const max = props.max ?? Number.POSITIVE_INFINITY;
    const next = Math.min(max, Math.max(min, parsed));
    props.onChange(next);
    setText(String(next));
  };

  return (
    <Field id={props.id} label={props.label} hint={props.hint} error={props.error}>
      <input
        id={props.id}
        type="number"
        inputMode="decimal"
        value={text}
        min={props.min}
        max={props.max}
        step={props.step}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
      />
    </Field>
  );
}

export function CheckboxField(props: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="field field--checkbox">
      <input
        id={props.id}
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <div>
        <label className="field-label field-label--inline" htmlFor={props.id}>
          {props.label}
        </label>
        {props.hint ? <p className="field-hint">{props.hint}</p> : null}
      </div>
    </div>
  );
}

export function FormActions(props: {
  dirty: boolean;
  saving: boolean;
  savedAt: number | null;
  onSave: () => void;
  disabled?: boolean;
}) {
  const { dirty, saving, savedAt, onSave } = props;
  return (
    <div className="form-actions">
      <button
        type="button"
        className="btn btn--primary"
        disabled={!dirty || saving || props.disabled === true}
        onClick={onSave}
        title={!dirty ? "Изменений нет" : undefined}
      >
        {saving ? "Сохранение…" : "Сохранить"}
      </button>
      <span className="form-actions-state" aria-live="polite">
        {saving
          ? "Отправляю на сервер."
          : dirty
            ? "Есть несохранённые изменения."
            : savedAt
              ? "Сохранено."
              : "Изменений нет."}
      </span>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────── toast ──

type Notify = (message: string, kind?: "success" | "error") => void;

interface ToastItem {
  id: number;
  message: string;
  kind: "success" | "error";
}

const ToastContext = createContext<Notify | null>(null);

export function ToastProvider(props: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastItem | null>(null);
  const counter = useRef(0);
  const timer = useRef<number | null>(null);

  const notify = useCallback<Notify>((message, kind = "success") => {
    counter.current += 1;
    setToast({ id: counter.current, message, kind });
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), kind === "error" ? 6000 : 4000);
  }, []);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  const value = useMemo(() => notify, [notify]);

  return (
    <ToastContext.Provider value={value}>
      {props.children}
      <div className="toast-region" role="status" aria-live="polite">
        {toast ? (
          <div className={`toast toast--${toast.kind}`} key={toast.id}>
            {toast.message}
          </div>
        ) : null}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): Notify {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside ToastProvider");
  return context;
}
