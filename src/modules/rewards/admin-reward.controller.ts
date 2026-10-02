// src/modules/rewards/admin-reward.controller.ts (Controller endpoint)
import { Controller, Post, Body, Param, UseGuards, Req } from '@nestjs/common';
import { RewardService } from './reward.service';
import { DeductCreditsDto } from './dto/deduct-credits.dto';
// import { AdminGuard } from '../auth/guards/admin.guard';
// import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Controller('api/v1/admin/users')
export class AdminRewardController {
  constructor(private readonly rewardService: RewardService) {}

  @Post(':id/credits/deduct')
  // @UseGuards(AdminGuard)
  async deductCredits(
    @Param('id') userId: string,
    @Body() dto: DeductCreditsDto,
    @Req() req: any,
  ) {
    const adminId = req.user?.id || 'mock-admin-id';
    const result = await this.rewardService.deductCredits(adminId, userId, dto);

    return {
      success: true,
      message: 'Credits successfully deducted',
      data: result,
    };
  }
}