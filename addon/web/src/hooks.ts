import { useCallback, useEffect, useRef, useState } from "react";
import type { DependencyList } from "react";
import { errorText } from "./api";

export interface LoadResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  refresh: () => Promise<void>;
  setData: (updater: T | ((previous: T) => T)) => void;
}

interface LoadState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/**
 * Loads data on mount and when deps change. `refresh` re-fetches without
 * switching the screen into a loading state, which is what polling needs.
 */
export function useLoader<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
): LoadResult<T> {
  const [state, setState] = useState<LoadState<T>>({ data: null, loading: true, error: null });
  const [version, setVersion] = useState(0);
  const loaderRef = useRef(load);
  loaderRef.current = load;
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState((previous) => ({ data: previous.data, loading: true, error: null }));
    loaderRef
      .current(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({ data, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState((previous) => ({ data: previous.data, loading: false, error: errorText(error) }));
      });
    return () => controller.abort();
    // The caller owns the dependency list; version is the manual reload trigger.
  }, [...deps, version]);

  const reload = useCallback(() => setVersion((current) => current + 1), []);

  const refresh = useCallback(async () => {
    try {
      const data = await loaderRef.current(new AbortController().signal);
      if (mountedRef.current) setState({ data, loading: false, error: null });
    } catch (error) {
      if (mountedRef.current) {
        setState((previous) => ({ data: previous.data, loading: false, error: errorText(error) }));
      }
    }
  }, []);

  const setData = useCallback((updater: T | ((previous: T) => T)) => {
    setState((previous) => {
      if (previous.data === null) return previous;
      const next =
        typeof updater === "function"
          ? (updater as (value: T) => T)(previous.data)
          : updater;
      return { ...previous, data: next };
    });
  }, []);

  return { data: state.data, loading: state.loading, error: state.error, reload, refresh, setData };
}

let pageDirty = false;

export function isPageDirty(): boolean {
  return pageDirty;
}

export function useUnsavedChanges(dirty: boolean): void {
  useEffect(() => {
    pageDirty = dirty;
    if (!dirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      pageDirty = false;
    };
  }, [dirty]);
}

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title === "" ? "pulsar-brain" : `${title} — pulsar-brain`;
  }, [title]);
}

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
