// src/modules/quizzes/admin-quiz.controller.ts
import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards, Req } from '@nestjs/common';
import { AdminQuizService } from './admin-quiz.service';
import { CreateQuizDto, UpdateQuizDto } from './dto/manage-quiz.dto';
// import { AdminGuard } from '../auth/guards/admin.guard';

@Controller('api/v1/admin/courses')
export class AdminQuizController {
  constructor(private readonly adminQuizService: AdminQuizService) {}

  @Get(':courseId/modules/:moduleId/quizzes')
  // @UseGuards(AdminGuard)
  async listQuizzes(
    @Param('courseId') courseId: string,
    @Param('moduleId') moduleId: string,
  ) {
    const quizzes = await this.adminQuizService.listModuleQuizzes(courseId, moduleId);
    return { success: true, data: quizzes };
  }

  @Post(':courseId/modules/:moduleId/quizzes')
  // @UseGuards(AdminGuard)
  async createQuiz(
    @Param('courseId') courseId: string,
    @Param('moduleId') moduleId: string,
    @Body() dto: CreateQuizDto,
    @Req() req: any,
  ) {
    const adminId = req.user?.id || 'mock-admin-id';
    const quiz = await this.adminQuizService.createQuiz(adminId, courseId, moduleId, dto);
    return { success: true, message: 'Quiz created successfully', data: quiz };
  }

  @Put('quizzes/:quizId')
  // @UseGuards(AdminGuard)
  async updateQuiz(
    @Param('quizId') quizId: string,
    @Body() dto: UpdateQuizDto,
    @Req() req: any,
  ) {
    const adminId = req.user?.id || 'mock-admin-id';
    const quiz = await this.adminQuizService.updateQuiz(adminId, quizId, dto);
    return { success: true, message: 'Quiz updated successfully', data: quiz };
  }

  @Delete('quizzes/:quizId')
  // @UseGuards(AdminGuard)
  async deleteQuiz(
    @Param('quizId') quizId: string,
    @Req() req: any,
  ) {
    const adminId = req.user?.id || 'mock-admin-id';
    const result = await this.adminQuizService.deleteQuiz(adminId, quizId);
    return { success: true, message: 'Quiz deleted successfully', data: result };
  }
}