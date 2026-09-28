import { Controller, Get, Param, Req, UseGuards, Res } from '@nestjs/common';
import { Response } from 'express';
import { QuizService, QuizAttemptResponse } from './quiz.service';
// Assuming JwtAuthGuard and current user extraction decorator exist in project
// import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
// import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Controller('api/v1/courses')
export class QuizController {
  constructor(private readonly quizService: QuizService) {}

  @Get(':courseId/modules/:moduleId/quiz-attempts')
  // @UseGuards(JwtAuthGuard)
  async getCourseModuleQuizAttempts(
    @Param('courseId') courseId: string,
    @Param('moduleId') moduleId: string,
    // @CurrentUser() user: { id: string },
    @Req() req: any,
    @Res() res: Response,
  ): Promise<void> {
    const userId = req.user?.id || 'mock-user-id';

    const attempts = await this.quizService.getAttemptsByCourseModule(courseId, moduleId, userId);

    // Set Cache-Control header for 30 seconds caching as specified in requirements
    res.setHeader('Cache-Control', 'private, max-age=30');
    res.status(200).json({
      success: true,
      data: attempts,
    });
  }
}