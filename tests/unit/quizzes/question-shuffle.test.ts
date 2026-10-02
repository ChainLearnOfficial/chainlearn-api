import { describe, expect, it } from "vitest";
import { quizService } from "../../../src/modules/quizzes/quiz.service.js";
import type { QuizQuestion } from "../../../src/modules/quizzes/quiz.types.js";

type GeneratedQuestion = QuizQuestion & { correctIndex: number };
type StoredQuestion = GeneratedQuestion & {
  originalQuestionIndex: number;
  originalCorrectIndex: number;
  originalOptions: string[];
};

const service = quizService as unknown as {
  shuffleQuestions: (questions: GeneratedQuestion[]) => StoredQuestion[];
  toClientQuestions: (questions: StoredQuestion[]) => QuizQuestion[];
};

describe("quiz question shuffling", () => {
  it("recalculates correct indexes and hides internal order metadata", () => {
    const shuffled = service.shuffleQuestions([
      {
        id: "q1",
        text: "Which network supports Soroban?",
        options: ["Ethereum", "Stellar", "Bitcoin"],
        correctIndex: 1,
      },
      {
        id: "q2",
        text: "Which language is common for Soroban contracts?",
        options: ["Rust", "Ruby", "PHP"],
        correctIndex: 0,
      },
    ]);

    expect(shuffled).toHaveLength(2);
    for (const question of shuffled) {
      expect(question.options[question.correctIndex]).toBe(
        question.id === "q1" ? "Stellar" : "Rust",
      );
      expect(question.originalQuestionIndex).toEqual(expect.any(Number));
      expect(question.originalCorrectIndex).toEqual(expect.any(Number));
      expect(question.originalOptions).toEqual(
        question.id === "q1"
          ? ["Ethereum", "Stellar", "Bitcoin"]
          : ["Rust", "Ruby", "PHP"],
      );
    }

    const clientQuestions = service.toClientQuestions(shuffled);
    expect(clientQuestions).toHaveLength(2);
    for (const question of clientQuestions) {
      expect(question).not.toHaveProperty("correctIndex");
      expect(question).not.toHaveProperty("originalQuestionIndex");
      expect(question).not.toHaveProperty("originalCorrectIndex");
      expect(question).not.toHaveProperty("originalOptions");
    }
  });
});
