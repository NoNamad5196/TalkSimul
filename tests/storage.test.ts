import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteRecord, loadRecords, saveRecord } from "../src/lib/storage";
import type { SessionRecord } from "../shared/types";

const STORAGE_KEY = "talksimul.sessions.v1";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  failReads = false;
  failWrites = false;
  writes = 0;
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string) {
    if (this.failReads) throw new Error("Storage access denied");
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.writes++;
    if (this.failWrites) throw new Error("QuotaExceededError");
    this.values.set(key, String(value));
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

function record(id = "session-1"): SessionRecord {
  return {
    id,
    config: { language: "en", level: "basic", scenario: "free", mode: "demo" },
    startedAt: 1_700_000_000_000,
    duration: 42,
    messages: [
      {
        id: `${id}-user`,
        role: "user",
        text: `My practice: ${id}`,
        timestamp: 1_700_000_000_001,
        source: "typed",
      },
    ],
    review: {
      summary: "내가 말한 문장",
      feedback: [
        {
          messageId: `${id}-user`,
          original: `My practice: ${id}`,
          improved: `My practice: ${id}`,
          explanation: "데모에서 평가하지 않음",
          category: "발화 돌아보기",
        },
      ],
      assessment: {
        delivery: "평가 안 함",
        naturalness: "평가 안 함",
        grammar: "평가 안 함",
        vocabulary: "평가 안 함",
      },
      insufficient: true,
    },
  };
}

describe("device-local practice storage", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts with a usable empty history", () => {
    expect(loadRecords()).toEqual({ records: [], error: null });
    expect(storage.writes).toBe(0);
  });

  it("saves a complete record, reopens it after module reload, and deletes only the selected record", async () => {
    const first = record("first");
    const second = record("second");
    second.config = {
      language: "ja",
      level: "challenge",
      scenario: "hotel",
      mode: "demo",
    };
    expect(saveRecord(first).error).toBeNull();
    expect(saveRecord(second).error).toBeNull();

    vi.resetModules();
    const reloaded = await import("../src/lib/storage");
    const reopened = reloaded.loadRecords();
    expect(reopened).toEqual({ records: [second, first], error: null });
    expect(
      reopened.records.find((r) => r.id === "first")?.review?.feedback[0]
        .messageId,
    ).toBe("first-user");
    expect(reloaded.deleteRecord("first")).toEqual({
      records: [second],
      error: null,
    });
    expect(reloaded.loadRecords()).toEqual({ records: [second], error: null });
    expect(reloaded.deleteRecord("second")).toEqual({
      records: [],
      error: null,
    });
    expect(reloaded.loadRecords()).toEqual({ records: [], error: null });
  });

  it("keeps retries isolated by session id and updates an existing id without duplication", () => {
    const first = record("first");
    const retry = record("retry");
    saveRecord(first);
    saveRecord(retry);
    const revised = { ...first, duration: 75, review: null };
    expect(saveRecord(revised)).toEqual({
      records: [revised, retry],
      error: null,
    });
    const loaded = loadRecords().records;
    expect(loaded).toHaveLength(2);
    expect(loaded.find((r) => r.id === "retry")?.messages).toEqual(
      retry.messages,
    );
    expect(
      loaded
        .find((r) => r.id === "retry")
        ?.messages.some((m) => m.id === "first-user"),
    ).toBe(false);
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["non-list JSON", JSON.stringify({ records: [] })],
    ["missing settings", JSON.stringify([{ ...record(), config: null }])],
    [
      "unsupported language",
      JSON.stringify([
        { ...record(), config: { ...record().config, language: "ko" } },
      ]),
    ],
    [
      "invalid messages",
      JSON.stringify([
        {
          ...record(),
          messages: [{ id: "x", role: "system", text: "bad", timestamp: 0 }],
        },
      ]),
    ],
    [
      "invalid review",
      JSON.stringify([{ ...record(), review: { summary: "incomplete" } }]),
    ],
  ])("preserves original bytes when history contains %s", (_label, raw) => {
    storage.setItem(STORAGE_KEY, raw);
    const initialWrites = storage.writes;
    expect(loadRecords()).toMatchObject({
      records: [],
      error: expect.any(String),
    });
    expect(saveRecord(record("new"))).toMatchObject({
      records: [],
      error: expect.any(String),
    });
    expect(deleteRecord("session-1")).toMatchObject({
      records: [],
      error: expect.any(String),
    });
    expect(storage.getItem(STORAGE_KEY)).toBe(raw);
    expect(storage.writes).toBe(initialWrites);
  });

  it("returns the saved history and a clear failure when a new write exceeds quota", () => {
    const existing = record("saved");
    saveRecord(existing);
    const persisted = storage.getItem(STORAGE_KEY);
    storage.failWrites = true;
    const result = saveRecord(record("unsaved"));
    expect(result.records).toEqual([existing]);
    expect(result.error).toContain("저장하지 못했어요");
    expect(storage.getItem(STORAGE_KEY)).toBe(persisted);
    expect(loadRecords().records).toEqual([existing]);
  });

  it("does not claim deletion succeeded when persisting the deletion fails", () => {
    const existing = record();
    saveRecord(existing);
    storage.failWrites = true;
    expect(deleteRecord(existing.id)).toMatchObject({
      records: [existing],
      error: expect.any(String),
    });
    expect(loadRecords().records).toEqual([existing]);
  });

  it("handles denied storage access without throwing or writing over unreadable data", () => {
    storage.failReads = true;
    expect(loadRecords()).toMatchObject({
      records: [],
      error: expect.any(String),
    });
    expect(saveRecord(record()).error).toBeTruthy();
    expect(deleteRecord("session-1").error).toBeTruthy();
    expect(storage.writes).toBe(0);
  });
});
