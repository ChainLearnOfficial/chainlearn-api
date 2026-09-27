import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/config/database.js", () => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  return { db: mockDb };
});

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("../../../src/audit/index.js", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/modules/notifications/notification.service.js", () => ({
  notificationService: { create: vi.fn().mockResolvedValue(undefined) },
}));

import { db } from "../../../src/config/database.js";
import { auditLog } from "../../../src/audit/index.js";
import { notificationService } from "../../../src/modules/notifications/notification.service.js";
import { badgeService } from "../../../src/modules/badges/badge.service.js";

const mockDb = vi.mocked(db);

describe("BadgeService — User Badges & Automated Evaluation (#379)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("evaluates criteria, awards newly unlocked badges, triggers notifications, and returns progress", async () => {
    const userId = "user-123";

    const allBadges = [
      {
        id: "badge-enrollment-1",
        name: "First Step",
        description: "Enrolled in at least 1 course",
        iconUrl: "https://example.com/b1.png",
        type: "enrollment",
        criteria: { count: 1 },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "badge-quiz-5",
        name: "Quiz Wizard",
        description: "Complete 5 quizzes",
        iconUrl: "https://example.com/b2.png",
        type: "quiz_completion",
        criteria: { count: 5 },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    // User has 1 enrollment, 0 completed courses, 2 quizzes, 0 credentials
    const makeCountQuery = (val: number) => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ value: val }]),
      }),
    });

    // In evaluateUserBadges:
    // 1. check user
    // 2. 4 count queries (enrollments, completed courses, quizzes, credentials)
    // 3. allBadges select
    // 4. userBadges select
    // Then in getUserBadges:
    // 5. 4 count queries
    // 6. allBadges and userBadges

    let selectCallCount = 0;
    mockDb.select.mockImplementation(() => {
      selectCallCount++;
      // check user
      if (selectCallCount === 1) {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ id: userId }]),
          }),
        } as any;
      }
      // evaluate counts: enrollment (1), completed (0), quiz (2), credential (0)
      if (selectCallCount === 2) return makeCountQuery(1) as any;
      if (selectCallCount === 3) return makeCountQuery(0) as any;
      if (selectCallCount === 4) return makeCountQuery(2) as any;
      if (selectCallCount === 5) return makeCountQuery(0) as any;

      // allBadges
      if (selectCallCount === 6) {
        return {
          from: vi.fn().mockResolvedValue(allBadges),
        } as any;
      }

      // earned userBadges in evaluation (initially empty)
      if (selectCallCount === 7) {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        } as any;
      }

      // getUserBadges counts
      if (selectCallCount === 8) return makeCountQuery(1) as any;
      if (selectCallCount === 9) return makeCountQuery(0) as any;
      if (selectCallCount === 10) return makeCountQuery(2) as any;
      if (selectCallCount === 11) return makeCountQuery(0) as any;

      // getUserBadges allBadges
      if (selectCallCount === 12) {
        return {
          from: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(allBadges),
          }),
        } as any;
      }

      // getUserBadges userBadges (now contains First Step)
      if (selectCallCount === 13) {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { badgeId: "badge-enrollment-1", earnedAt: new Date("2026-01-01"), progress: {} },
            ]),
          }),
        } as any;
      }

      return makeCountQuery(0) as any;
    });

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);

    const response = await badgeService.getUserBadges(userId);

    // Verify notification was dispatched for First Step
    expect(notificationService.create).toHaveBeenCalledWith({
      userId,
      type: "badge_earned",
      title: "Badge Unlocked: First Step",
      message: 'Congratulations! You\'ve unlocked the "First Step" badge: Enrolled in at least 1 course',
    });

    // Verify audit log
    expect(auditLog).toHaveBeenCalledWith("badge.awarded", {
      userId,
      badgeId: "badge-enrollment-1",
      badgeName: "First Step",
    });

    // Verify response shape
    expect(response.totalEarned).toBe(1);
    expect(response.totalAvailable).toBe(2);

    expect(response.earned.length).toBe(1);
    expect(response.earned[0].id).toBe("badge-enrollment-1");
    expect(response.earned[0].name).toBe("First Step");

    expect(response.unearned.length).toBe(1);
    expect(response.unearned[0].id).toBe("badge-quiz-5");
    expect(response.unearned[0].progress).toEqual({
      current: 2,
      target: 5,
      percentage: 40,
    });
  });
});
