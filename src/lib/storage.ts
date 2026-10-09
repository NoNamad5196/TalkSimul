import type { SessionRecord, SessionConfig } from "../../shared/types";
const KEY = "talksimul.sessions.v1";
export type StorageResult = { records: SessionRecord[]; error: string | null };
export function loadRecords(): StorageResult {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { records: [], error: null };
    const data = JSON.parse(raw);
    if (
      !Array.isArray(data) ||
      data.some(
        (r) =>
          !r ||
          typeof r.id !== "string" ||
          !isConfig(r.config) ||
          !Array.isArray(r.messages) ||
          !Number.isFinite(r.startedAt) ||
          !Number.isFinite(r.duration) ||
          r.messages.some((m: unknown) => !isMessage(m)) ||
          !isReview(r.review),
      )
    )
      throw new Error("invalid");
    return { records: data, error: null };
  } catch {
    return {
      records: [],
      error:
        "저장된 기록을 읽지 못했어요. 기존 데이터는 그대로 두었어요. 브라우저 저장 공간을 확인해 주세요.",
    };
  }
}
export function isConfig(v: unknown): v is SessionConfig {
  if (!v || typeof v !== "object") return false;
  const c = v as SessionConfig;
  return (
    ["en", "ja"].includes(c.language) &&
    ["beginner", "basic", "challenge"].includes(c.level) &&
    ["free", "cafe", "hotel", "friends", "directions"].includes(c.scenario) &&
    ["demo", "live"].includes(c.mode)
  );
}
function isMessage(v: unknown) {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    ["user", "assistant"].includes(m.role as string) &&
    typeof m.text === "string" &&
    typeof m.timestamp === "number"
  );
}
function isReview(v: unknown) {
  if (v === null) return true;
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.summary === "string" &&
    typeof r.insufficient === "boolean" &&
    Array.isArray(r.feedback) &&
    r.feedback.every(
      (f) =>
        f &&
        ["messageId", "original", "improved", "explanation", "category"].every(
          (k) => typeof f[k] === "string",
        ),
    ) &&
    !!r.assessment &&
    ["delivery", "naturalness", "grammar", "vocabulary"].every(
      (k) => typeof (r.assessment as Record<string, unknown>)[k] === "string",
    )
  );
}
export function saveRecord(record: SessionRecord): StorageResult {
  const current = loadRecords();
  if (current.error) return current;
  const records = [
    record,
    ...current.records.filter((r) => r.id !== record.id),
  ];
  return persist(records);
}
export function deleteRecord(id: string): StorageResult {
  const current = loadRecords();
  if (current.error) return current;
  return persist(current.records.filter((r) => r.id !== id));
}
function persist(records: SessionRecord[]): StorageResult {
  try {
    localStorage.setItem(KEY, JSON.stringify(records));
    return { records, error: null };
  } catch {
    return {
      records: loadRecords().records,
      error:
        "기록을 저장하지 못했어요. 저장 공간이 부족하거나 브라우저가 저장을 막고 있어요. 화면을 닫기 전에 대화를 확인해 주세요.",
    };
  }
}
