import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/config/index.js", () => ({
  config: {
    AI_SERVICE_URL: "http://ai.test",
    AI_TIMEOUT_MS: 200,
  },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), fatal: vi.fn() },
}));

const baseParams = {
  userId: "user-1",
  courseId: "course-1",
  moduleId: "module-1",
  difficulty: "beginner" as const,
  numQuestions: 2,
};

async function loadClient() {
  vi.resetModules();
  return import("../../../src/modules/quizzes/ai-client.js");
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("generateQuizFromAI", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed questions on a valid response", async () => {
    const validBody = {
      quiz_id: "quiz-1",
      questions: [{ prompt: "Q1", options: ["a", "b"], correct_index: 0 }],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, validBody)));

    const { generateQuizFromAI } = await loadClient();
    const result = await generateQuizFromAI(baseParams);

    expect(result).toEqual(validBody.questions);
  });

  it("throws when the AI response shape is malformed instead of crashing (#142)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { quiz_id: 123, questions: "not-an-array" }))
    );

    const { generateQuizFromAI } = await loadClient();

    await expect(generateQuizFromAI(baseParams)).rejects.toThrow(
      "AI service returned a malformed response"
    );
  });

  it("throws on a response missing the questions field entirely (#142)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { quiz_id: "quiz-1" })));

    const { generateQuizFromAI } = await loadClient();

    await expect(generateQuizFromAI(baseParams)).rejects.toThrow(
      "AI service returned a malformed response"
    );
  });

  it("retries transient failures and eventually succeeds (#141)", async () => {
    const validBody = {
      quiz_id: "quiz-1",
      questions: [{ prompt: "Q1", options: ["a", "b"], correct_index: 1 }],
    };
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:8000"))
      .mockResolvedValueOnce(jsonResponse(200, validBody));
    vi.stubGlobal("fetch", fetchMock);

    const { generateQuizFromAI } = await loadClient();
    const result = await generateQuizFromAI(baseParams);

    expect(result).toEqual(validBody.questions);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-transient (4xx) failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(400, {}));
    vi.stubGlobal("fetch", fetchMock);

    const { generateQuizFromAI } = await loadClient();

    await expect(generateQuizFromAI(baseParams)).rejects.toThrow("AI service returned 400");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("opens the circuit after repeated failures and fails fast without calling fetch (#141)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:8000"));
    vi.stubGlobal("fetch", fetchMock);

    const { generateQuizFromAI } = await loadClient();

    for (let i = 0; i < 5; i++) {
      await expect(generateQuizFromAI(baseParams)).rejects.toThrow();
    }

    fetchMock.mockClear();

    await expect(generateQuizFromAI(baseParams)).rejects.toThrow("Circuit breaker is open");
    expect(fetchMock).not.toHaveBeenCalled();
  }, 10_000);

  it("aborts and reports a timeout instead of hanging when the AI service never responds (#140 regression)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const err = new Error("This operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      })
    );

    const { generateQuizFromAI } = await loadClient();

    await expect(generateQuizFromAI(baseParams)).rejects.toThrow(
      "AI service request timed out after 200ms"
    );
  }, 10_000);
});
