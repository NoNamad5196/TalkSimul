import { afterEach, expect, it, vi } from "vitest";
import { registerPracticeTool } from "../src/lib/practice-tool";

afterEach(() => vi.unstubAllGlobals());

it("registers a preparation-only action, validates input and unregisters", () => {
  const registerTool = vi.fn();
  vi.stubGlobal("document", { modelContext: { registerTool } });
  const stage = vi.fn((config) => ({
    page: "prepare",
    config,
    started: false,
  }));
  const cleanup = registerPracticeTool(stage);
  const [tool, options] = registerTool.mock.calls[0];
  expect(tool.name).toBe("stage_conversation_practice");
  const config = {
    language: "ja",
    level: "beginner",
    scenario: "cafe",
    mode: "live",
  };
  expect(tool.execute(config)).toEqual({
    page: "prepare",
    config,
    started: false,
  });
  for (const invalid of [
    { ...config, language: "xx" },
    { ...config, consent: true },
    { language: "en" },
    null,
    [],
  ]) {
    expect(() => tool.execute(invalid)).toThrow(
      "Invalid practice configuration",
    );
  }
  expect(stage).toHaveBeenCalledTimes(1);
  cleanup?.();
  expect(options.signal.aborted).toBe(true);
});

it("leaves unsupported browsers unchanged", () => {
  vi.stubGlobal("document", {});
  const stage = vi.fn();
  expect(registerPracticeTool(stage)).toBeUndefined();
  expect(stage).not.toHaveBeenCalled();
});
