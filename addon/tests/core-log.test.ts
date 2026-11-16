import { describe, expect, it } from "vitest";
import { createLogger } from "../src/log/logger.js";
import type { LogEntry } from "../src/shared/types.js";

describe("logger ring buffer", () => {
  it("keeps only the newest entries and exposes seq-bounded slices", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "trace", capacity: 3, write: (line) => lines.push(line) });

    logger.info("one");
    logger.info("two");
    logger.info("three");
    logger.info("four");
    logger.info("five");

    const all = logger.since(0);
    expect(all.map((entry) => entry.msg)).toEqual(["three", "four", "five"]);
    expect(all.map((entry) => entry.seq)).toEqual([3, 4, 5]);
    expect(lines).toHaveLength(5);

    expect(logger.since(4).map((entry) => entry.msg)).toEqual(["five"]);
    expect(logger.since(0, 2).map((entry) => entry.msg)).toEqual(["three", "four"]);
    expect(logger.since(5)).toEqual([]);
    expect(logger.since(-10).map((entry) => entry.msg)).toEqual(["three", "four", "five"]);
  });

  it("filters by level and honours PULSAR_BRAIN_LOG_LEVEL", () => {
    const logger = createLogger({ level: "warn", write: () => undefined });
    logger.info("hidden");
    logger.warn("shown");
    logger.error("also shown");
    expect(logger.since(0).map((entry) => entry.msg)).toEqual(["shown", "also shown"]);

    logger.setLevel("debug");
    logger.debug("now visible");
    expect(logger.since(0).at(-1)?.msg).toBe("now visible");

    const fromEnv = createLogger({ level: "error", write: () => undefined, env: { PULSAR_BRAIN_LOG_LEVEL: "debug" } });
    expect(fromEnv.level()).toBe("debug");
  });

  it("scopes child loggers", () => {
    const logger = createLogger({ level: "trace", write: () => undefined });
    logger.child("stt").child("wyoming").info("connected");
    logger.info("root");
    const entries = logger.since(0);
    expect(entries.map((entry) => entry.scope)).toEqual(["stt.wyoming", ""]);
  });

  it("notifies subscribers and stops after unsubscribe", () => {
    const logger = createLogger({ level: "trace", write: () => undefined });
    const received: LogEntry[] = [];
    const unsubscribe = logger.subscribe((entry) => received.push(entry));

    logger.info("first");
    logger.info("second");
    expect(received.map((entry) => entry.msg)).toEqual(["first", "second"]);

    unsubscribe();
    logger.info("third");
    expect(received.map((entry) => entry.msg)).toEqual(["first", "second"]);
  });

  it("writes one JSON line per entry", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info", write: (line) => lines.push(line) });
    logger.info("hello", { runId: "run-1" });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "{}") as LogEntry;
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("hello");
    expect(parsed.scope).toBe("");
    expect(parsed.seq).toBe(1);
    expect(Number.isNaN(Date.parse(parsed.ts))).toBe(false);
    expect(parsed.data).toEqual({ runId: "run-1" });
  });
});

describe("logger secret redaction", () => {
  it("masks sensitive keys recursively before they reach the ring buffer or stdout", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "trace", write: (line) => lines.push(line) });
    logger.info("call", {
      token: "super-secret-token",
      apiKey: "sk-secret",
      nested: { password: "hunter2", authorization: "Bearer abc", value: 42 },
      list: [{ clientSecret: "abc", name: "visible" }],
      note: "ordinary text",
    });

    const entry = logger.since(0)[0];
    expect(entry?.data).toEqual({
      token: "***",
      apiKey: "***",
      nested: { password: "***", authorization: "***", value: 42 },
      list: [{ clientSecret: "***", name: "visible" }],
      note: "ordinary text",
    });
    const stdout = lines.join("\n");
    expect(stdout).not.toContain("super-secret-token");
    expect(stdout).not.toContain("sk-secret");
    expect(stdout).not.toContain("hunter2");
    expect(stdout).toContain("ordinary text");
  });

  it("serializes errors without stack internals", () => {
    const logger = createLogger({ level: "trace", write: () => undefined });
    logger.error("failed", { cause: new Error("boom") });
    expect(logger.since(0)[0]?.data).toEqual({ cause: { name: "Error", message: "boom" } });
  });
});
