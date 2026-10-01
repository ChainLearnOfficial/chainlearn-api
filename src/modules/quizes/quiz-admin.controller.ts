// src/modules/quizzes/quiz-admin.controller.ts

import { Controller, Post, Param, Body, UseGuards, Req } from '@nestjs/common';
import { QuizService } from './quiz.service';
import { GenerateQuizDto } from './dto/generate-quiz.dto';
import { AdminAuthGuard } from '../../common/guards/admin-auth.guard';

@Controller('api/v1/admin/courses')
@UseGuards(AdminAuthGuard)
export class QuizAdminController {
  constructor(private readonly quizService: QuizService) {}

  @Post(':id/modules/:moduleId/quizzes/generate')
  async generateModuleQuiz(
    @Param('id') courseId: string,
    @Param('moduleId') moduleId: string,
    @Body() dto: GenerateQuizDto,
    @Req() req: any,
  ) {
    const adminId = req.user?.id;
    return this.quizService.generateAndStoreQuiz(courseId, moduleId, dto, adminId);
  }
}