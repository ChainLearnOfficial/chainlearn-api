// src/modules/courses/course-publish.controller.ts

import { Controller, Post, Param, UseGuards } from '@nestjs/common';
import { CourseService } from './course.service';
import { AdminAuthGuard } from '../../common/guards/admin-auth.guard';

@Controller('api/v1/admin/courses')
@UseGuards(AdminAuthGuard)
export class CoursePublishController {
  constructor(private readonly courseService: CourseService) {}

  @Post(':id/publish-check')
  async checkPublishReadiness(@Param('id') courseId: string) {
    return this.courseService.validatePublishReadiness(courseId);
  }
}