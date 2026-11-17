import { useCallback, useEffect, useRef, useState } from "react";
import type { ComponentType, FormEvent } from "react";
import { api, ApiError, checkToken, clearToken, errorText, getToken, setToken, setUnauthorizedHandler } from "./api";
import { isPageDirty, useDocumentTitle } from "./hooks";
import { hrefFor, SECTIONS, sectionFromLocation, sectionTitle } from "./router";
import type { SectionId } from "./router";
import { Field, Notice, Spinner } from "./components/ui";
import { OverviewPage } from "./pages/Overview";
import { ProvidersPage } from "./pages/Providers";
import { AssistantPage } from "./pages/Assistant";
import { McpPage } from "./pages/Mcp";
import { SchedulerPage } from "./pages/Scheduler";
import { StationPage } from "./pages/Station";
import { HistoryPage } from "./pages/History";
import { LogsPage } from "./pages/Logs";
import { TestPage } from "./pages/Test";
import { SettingsPage } from "./pages/Settings";

type AuthPhase = "checking" | "required" | "offline" | "ready";

const PAGES: Record<SectionId, ComponentType> = {
  overview: OverviewPage,
  providers: ProvidersPage,
  assistant: AssistantPage,
  mcp: McpPage,
  scheduler: SchedulerPage,
  station: StationPage,
  history: HistoryPage,
  logs: LogsPage,
  test: TestPage,
  settings: SettingsPage,
};

const CONFIRM_LEAVE = "На экране есть несохранённые изменения. Перейти и потерять их?";

export function App() {
  const [phase, setPhase] = useState<AuthPhase>("checking");
  const [authMessage, setAuthMessage] = useState("");
  const [section, setSection] = useState<SectionId>(() => sectionFromLocation());
  const sectionRef = useRef(section);
  sectionRef.current = section;
  const initialFocus = useRef(true);

  useDocumentTitle(phase === "ready" ? sectionTitle(section) : "");

  useEffect(() => {
    let cancelled = false;
    setUnauthorizedHandler(() => {
      clearToken();
      setAuthMessage("Сессия истекла. Введите токен снова.");
      setPhase("required");
    });

    const verify = async () => {
      // The API is reachable without a Bearer token behind the Supervisor ingress, so probe it
      // first; only a 401 means a token is actually required.
      const hadToken = getToken() !== "";
      try {
        await api.status();
        if (!cancelled) setPhase("ready");
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          clearToken();
          setAuthMessage(
            hadToken ? "Сохранённый токен не подошёл. Введите другой." : "",
          );
          setPhase("required");
        } else {
          setAuthMessage(errorText(error));
          setPhase("offline");
        }
      }
    };

    void verify();
    return () => {
      cancelled = true;
      setUnauthorizedHandler(null);
    };
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      const next = sectionFromLocation();
      if (next === sectionRef.current) return;
      if (isPageDirty() && !window.confirm(CONFIRM_LEAVE)) {
        window.history.pushState({ section: sectionRef.current }, "", hrefFor(sectionRef.current));
        return;
      }
      setSection(next);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
    if (initialFocus.current) {
      initialFocus.current = false;
      return;
    }
    document.getElementById("page-title")?.focus({ preventScroll: true });
  }, [section]);

  const go = useCallback((next: SectionId) => {
    if (next === sectionRef.current) return;
    if (isPageDirty() && !window.confirm(CONFIRM_LEAVE)) return;
    window.history.pushState({ section: next }, "", hrefFor(next));
    setSection(next);
  }, []);

  const retryAuth = useCallback(() => {
    setPhase("checking");
    setAuthMessage("");
    const hadToken = getToken() !== "";
    api
      .status()
      .then(() => setPhase("ready"))
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) {
          clearToken();
          setAuthMessage(hadToken ? "Сохранённый токен не подошёл. Введите другой." : "");
          setPhase("required");
        } else {
          setAuthMessage(errorText(error));
          setPhase("offline");
        }
      });
  }, []);

  if (phase === "checking") {
    return (
      <div className="gate-shell">
        <main className="gate">
          <p className="gate-brand">pulsar-brain</p>
          <p className="gate-loading" role="status" aria-live="polite">
            <Spinner /> Проверка доступа…
          </p>
        </main>
      </div>
    );
  }

  if (phase === "required") {
    return (
      <TokenGate
        message={authMessage}
        onAuthenticated={(value) => {
          setToken(value);
          setAuthMessage("");
          setPhase("ready");
        }}
      />
    );
  }

  if (phase === "offline") {
    return (
      <div className="gate-shell">
        <main className="gate">
          <p className="gate-brand">pulsar-brain</p>
          <h1>Сервер не отвечает</h1>
          <p className="gate-text">
            {authMessage || "Не удалось связаться с аддоном. Проверьте, что он запущен."}
          </p>
          <div className="gate-actions">
            <button type="button" className="btn btn--primary" onClick={retryAuth}>
              Повторить
            </button>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => {
                clearToken();
                setAuthMessage("");
                setPhase("required");
              }}
            >
              Сменить токен
            </button>
          </div>
        </main>
      </div>
    );
  }

  const Page = PAGES[section];
  const groups = ["Наблюдение", "Настройка"] as const;

  return (
    <div className="app">
      <a className="skip-link" href="#content">
        К содержанию
      </a>
      <aside className="rail">
        <div className="brand">
          <span className="brand-name">
            pulsar<span className="brand-accent">brain</span>
          </span>
          <span className="brand-sub">аддон Home Assistant</span>
        </div>
        <nav className="nav" aria-label="Разделы админки">
          {groups.map((group) => (
            <div className="nav-group" key={group}>
              <h2 className="nav-group-title">{group}</h2>
              <ul>
                {SECTIONS.filter((item) => item.group === group).map((item) => (
                  <li key={item.id}>
                    <a
                      href={hrefFor(item.id)}
                      aria-current={item.id === section ? "page" : undefined}
                      onClick={(event) => {
                        if (
                          event.button !== 0 ||
                          event.metaKey ||
                          event.ctrlKey ||
                          event.shiftKey ||
                          event.altKey
                        ) {
                          return;
                        }
                        event.preventDefault();
                        go(item.id);
                      }}
                    >
                      {item.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
      <main id="content" className="content" tabIndex={-1}>
        <Page key={section} />
      </main>
    </div>
  );
}

function TokenGate(props: {
  message: string;
  onAuthenticated: (token: string) => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const candidate = value.trim();
    if (candidate === "") {
      setError("Введите токен.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await checkToken(candidate);
      props.onAuthenticated(candidate);
    } catch (caught) {
      setError(errorText(caught));
      setBusy(false);
    }
  };

  return (
    <div className="gate-shell">
      <main className="gate">
        <p className="gate-brand">pulsar-brain</p>
        <h1>Вход в админку</h1>
        <p className="gate-text">
          Токен UI выдаёт аддон. Ссылка из ingress Home Assistant может содержать его
          в параметре <code>token</code>.
        </p>
        {props.message !== "" && error === "" ? (
          <Notice kind="warning">{props.message}</Notice>
        ) : null}
        <form onSubmit={(event) => void submit(event)} noValidate>
          <Field id="ui-token" label="Токен" hint="Сохраняется в этом браузере.">
            <input
              id="ui-token"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={value}
              onChange={(event) => setValue(event.target.value)}
              aria-invalid={error !== ""}
              aria-describedby={error !== "" ? "ui-token-error" : "ui-token-hint"}
            />
          </Field>
          {error ? (
            <Notice kind="error" id="ui-token-error">
              {error}
            </Notice>
          ) : null}
          <div className="gate-actions">
            <button type="submit" className="btn btn--primary" disabled={busy}>
              {busy ? "Проверка…" : "Войти"}
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}
