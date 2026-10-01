// src/modules/quizzes/quiz.service.ts (Service method addition)
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service'; // or appropriate path

export interface QuizAttemptResponse {
  attemptNumber: number;
  score: number;
  maxScore: number;
  percentage: number;
  passed: boolean;
  submittedAt: Date;
  quizId: string;
  quizTitle: string;
}

@Injectable()
export class QuizService {
  constructor(private readonly prisma: PrismaService) {}

  async getAttemptsByCourseModule(courseId: string, moduleId: string, userId: string): Promise<QuizAttemptResponse[]> {
    // 1. Verify module exists and belongs to course (or fetch quizzes directly linked to the module)
    const quizzes = await this.prisma.quiz.findMany({
      where: { moduleId, courseId },
      select: { id: true, title: true, maxScore: true },
    });

    if (!quizzes || quizzes.length === 0) {
      throw new NotFoundException(`No quizzes found for module ${moduleId} in course ${courseId}`);
    }

    const quizIds = quizzes.map((q) => q.id);
    const quizMap = new Map(quizzes.map((q) => [q.id, q]));

    // 2. Fetch all submissions for the user across these quizzes, ordered by submittedAt ascending (oldest first)
    const submissions = await this.prisma.quizSubmission.findMany({
      where: {
        userId,
        quizId: { in: quizIds },
      },
      orderBy: { submittedAt: 'asc' },
    });

    // 3. Map submissions and calculate attempt numbers per quiz or globally per module
    return submissions.map((sub, index) => {
      const quiz = quizMap.get(sub.quizId);
      const maxScore = quiz?.maxScore || 100;
      const percentage = (sub.score / maxScore) * 100;

      return {
        attemptNumber: index + 1,
        score: sub.score,
        maxScore,
        percentage: Number(percentage.toFixed(2)),
        passed: sub.passed,
        submittedAt: sub.submittedAt,
        quizId: sub.quizId,
        quizTitle: quiz?.title || 'Unknown Quiz',
      };
    });
  }
}