// src/modules/quizzes/admin-quiz.service.ts
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CreateQuizDto, UpdateQuizDto } from './dto/manage-quiz.dto';

@Injectable()
export class AdminQuizService {
  constructor(private readonly prisma: PrismaService) {}

  async listModuleQuizzes(courseId: string, moduleId: string) {
    const module = await this.prisma.courseModule.findFirst({
      where: { id: moduleId, courseId },
    });

    if (!module) {
      throw new NotFoundException(`Module ${moduleId} not found in course ${courseId}`);
    }

    return this.prisma.quiz.findMany({
      where: { moduleId },
      include: { questions: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createQuiz(adminId: string, courseId: string, moduleId: string, dto: CreateQuizDto) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Verify module exists and belongs to course
      const module = await tx.courseModule.findFirst({
        where: { id: moduleId, courseId },
      });

      if (!module) {
        throw new NotFoundException(`Module ${moduleId} not found in course ${courseId}`);
      }

      // 2. Validate question options & correct indexes
      for (const [index, q] of dto.questions.entries()) {
        if (!q.options || q.options.length < 2) {
          throw new BadRequestException(`Question #${index + 1} must have at least 2 options.`);
        }
        if (q.correctOptionIndex < 0 || q.correctOptionIndex >= q.options.length) {
          throw new BadRequestException(`Question #${index + 1} has an invalid correctOptionIndex.`);
        }
      }

      // 3. Create quiz with nested questions
      const quiz = await tx.quiz.create({
        data: {
          title: dto.title,
          description: dto.description,
          maxScore: dto.maxScore || dto.questions.length * 10,
          moduleId,
          courseId,
          questions: {
            create: dto.questions.map((q) => ({
              questionText: q.questionText,
              options: q.options,
              correctOptionIndex: q.correctOptionIndex,
              explanation: q.explanation,
            })),
          },
        },
        include: { questions: true },
      });

      // 4. Record audit log
      await tx.auditLog.create({
        data: {
          actorId: adminId,
          action: 'QUIZ_CREATE',
          targetId: quiz.id,
          metadata: { courseId, moduleId, quizTitle: quiz.title, questionCount: quiz.questions.length },
        },
      });

      return quiz;
    });
  }

  async updateQuiz(adminId: string, quizId: string, dto: UpdateQuizDto) {
    return this.prisma.$transaction(async (tx) => {
      const existingQuiz = await tx.quiz.findUnique({
        where: { id: quizId },
        include: { questions: true },
      });

      if (!existingQuiz) {
        throw new NotFoundException(`Quiz with ID ${quizId} not found`);
      }

      // If questions are provided, replace them or update
      if (dto.questions) {
        await tx.quizQuestion.deleteMany({ where: { quizId } });
      }

      const updatedQuiz = await tx.quiz.update({
        where: { id: quizId },
        data: {
          title: dto.title,
          description: dto.description,
          maxScore: dto.maxScore,
          questions: dto.questions
            ? {
                create: dto.questions.map((q) => ({
                  questionText: q.questionText,
                  options: q.options,
                  correctOptionIndex: q.correctOptionIndex,
                  explanation: q.explanation,
                })),
              }
            : undefined,
        },
        include: { questions: true },
      });

      await tx.auditLog.create({
        data: {
          actorId: adminId,
          action: 'QUIZ_UPDATE',
          targetId: quizId,
          metadata: { quizTitle: updatedQuiz.title },
        },
      });

      return updatedQuiz;
    });
  }

  async deleteQuiz(adminId: string, quizId: string) {
    return this.prisma.$transaction(async (tx) => {
      const quiz = await tx.quiz.findUnique({ where: { id: quizId } });
      if (!quiz) {
        throw new NotFoundException(`Quiz with ID ${quizId} not found`);
      }

      await tx.quizQuestion.deleteMany({ where: { quizId } });
      await tx.quiz.delete({ where: { id: quizId } });

      await tx.auditLog.create({
        data: {
          actorId: adminId,
          action: 'QUIZ_DELETE',
          targetId: quizId,
          metadata: { quizTitle: quiz.title, courseId: quiz.courseId, moduleId: quiz.moduleId },
        },
      });

      return { success: true, deletedQuizId: quizId };
    });
  }
}