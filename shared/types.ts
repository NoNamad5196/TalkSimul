export type Language = "en" | "ja";
export type Level = "beginner" | "basic" | "challenge";
export type ScenarioId = "free" | "cafe" | "hotel" | "friends" | "directions";
export type SessionMode = "demo" | "live";
export interface SessionConfig {
  language: Language;
  level: Level;
  scenario: ScenarioId;
  mode: SessionMode;
}
export interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  source?: "voice" | "typed" | "demo";
}
export interface Hint {
  text: string;
  meaning: string;
  note?: string;
}
export interface Feedback {
  messageId: string;
  original: string;
  improved: string;
  explanation: string;
  category: string;
}
export interface Review {
  summary: string;
  feedback: Feedback[];
  assessment: {
    delivery: string;
    naturalness: string;
    grammar: string;
    vocabulary: string;
  };
  insufficient: boolean;
}
export interface SessionRecord {
  id: string;
  config: SessionConfig;
  startedAt: number;
  duration: number;
  messages: Message[];
  review: Review | null;
  reviewError?: string;
  incompleteTranscription?: boolean;
}
export type ConversationState =
  | "idle"
  | "connecting"
  | "listening"
  | "user-speaking"
  | "thinking"
  | "speaking"
  | "muted"
  | "error"
  | "ended";
export interface ApiStatus {
  configured: boolean;
  enabled: boolean;
  realtimeModel: string;
  textModel: string;
}
