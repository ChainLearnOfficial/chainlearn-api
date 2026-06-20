import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requiredEnv = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/chainlearn",
  JWT_SECRET: "x".repeat(32),
  STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
  STELLAR_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  STELLAR_PLATFORM_SECRET: "S".repeat(56),
  STELLAR_QUIZ_CONTRACT_ID: "quiz-contract",
  STELLAR_REWARD_CONTRACT_ID: "reward-contract",
  STELLAR_CREDENTIAL_CONTRACT_ID: "credential-contract",
  AI_SERVICE_URL: "http://ai-service.test",
};

describe("quiz AI client", () => {
  beforeEach(() => {
    Object.assign(process.env, requiredEnv);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("normalizes AI service questions into stored quiz questions", async () => {
    const { normalizeAiQuizQuestions } = await import(
      "../../src/modules/quizzes/ai-client.js"
    );

    expect(
      normalizeAiQuizQuestions([
        {
          prompt: "What does Stellar optimize for?",
          options: ["Storage", "Payments", "Rendering", "Mining"],
          correct_index: 1,
        },
      ])
    ).toEqual([
      {
        id: "q1",
        text: "What does Stellar optimize for?",
        options: ["Storage", "Payments", "Rendering", "Mining"],
        correctIndex: 1,
      },
    ]);
  });

  it("posts the expected generate-quiz payload", async () => {
    const { generateQuizFromAI } = await import(
      "../../src/modules/quizzes/ai-client.js"
    );

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        quiz_id: "quiz-from-ai",
        questions: [
          {
            prompt: "Which network is used?",
            options: ["A", "B", "C", "D"],
            correct_index: 2,
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const questions = await generateQuizFromAI({
      userId: "user-1",
      courseId: "course-1",
      moduleId: "module-1",
      difficulty: "intermediate",
      numQuestions: 5,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://ai-service.test/generate-quiz",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: "user-1",
          course_id: "course-1",
          module_id: "module-1",
          difficulty: "intermediate",
          num_questions: 5,
        }),
      }
    );
    expect(questions).toHaveLength(1);
    expect(questions[0]?.prompt).toBe("Which network is used?");
  });

  it("throws when the AI service returns an error", async () => {
    const { generateQuizFromAI } = await import(
      "../../src/modules/quizzes/ai-client.js"
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
      })
    );

    await expect(
      generateQuizFromAI({
        userId: "user-1",
        courseId: "course-1",
        moduleId: "module-1",
        difficulty: "beginner",
        numQuestions: 5,
      })
    ).rejects.toThrow("AI service returned 503");
  });
});
