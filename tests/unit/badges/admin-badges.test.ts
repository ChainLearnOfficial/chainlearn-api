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
import { badgeService } from "../../../src/modules/badges/badge.service.js";

const mockDb = vi.mocked(db);

function selectChain(result: unknown[]) {
  const chain: any = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.orderBy = vi.fn().mockResolvedValue(result);
  chain.then = (resolve: any) => resolve(result);
  return chain;
}

describe("BadgeService — Admin Badges Management (#380)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a badge definition with criteria and logs audit", async () => {
    const badgeRow = {
      id: "b1-uuid",
      name: "First Step",
      description: "Enrolled in your first course",
      iconUrl: "https://example.com/icons/first-step.png",
      type: "enrollment",
      criteria: { count: 1 },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([badgeRow]),
      }),
    } as any);

    const result = await badgeService.createBadge({
      name: "First Step",
      description: "Enrolled in your first course",
      iconUrl: "https://example.com/icons/first-step.png",
      type: "enrollment",
      criteria: { count: 1 },
    });

    expect(result.id).toBe("b1-uuid");
    expect(result.name).toBe("First Step");
    expect(result.type).toBe("enrollment");
    expect(auditLog).toHaveBeenCalledWith("badge.created", {
      badgeId: "b1-uuid",
      badgeType: "enrollment",
      badgeName: "First Step",
    });
  });

  it("lists all badge definitions", async () => {
    const badges = [
      {
        id: "b1",
        name: "Badge 1",
        description: "Desc 1",
        iconUrl: "https://example.com/1.png",
        type: "enrollment",
        criteria: { count: 1 },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "b2",
        name: "Badge 2",
        description: "Desc 2",
        iconUrl: "https://example.com/2.png",
        type: "quiz_completion",
        criteria: { count: 5 },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    mockDb.select.mockReturnValue(selectChain(badges));

    const result = await badgeService.listBadges();

    expect(result.length).toBe(2);
    expect(result[0].name).toBe("Badge 1");
    expect(result[1].type).toBe("quiz_completion");
  });

  it("gets badge by ID", async () => {
    const badge = {
      id: "b1",
      name: "Quiz Champion",
      description: "Completed 10 quizzes",
      iconUrl: "https://example.com/quiz.png",
      type: "quiz_completion",
      criteria: { count: 10 },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([badge]),
      }),
    } as any);

    const result = await badgeService.getBadge("b1");

    expect(result.id).toBe("b1");
    expect(result.name).toBe("Quiz Champion");
  });

  it("updates a badge definition and logs audit", async () => {
    const updatedBadge = {
      id: "b1",
      name: "Quiz Master",
      description: "Completed 15 quizzes",
      iconUrl: "https://example.com/quiz-master.png",
      type: "quiz_completion",
      criteria: { count: 15 },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([updatedBadge]),
        }),
      }),
    } as any);

    const result = await badgeService.updateBadge("b1", {
      name: "Quiz Master",
      criteria: { count: 15 },
    });

    expect(result.name).toBe("Quiz Master");
    expect(auditLog).toHaveBeenCalledWith("badge.updated", {
      badgeId: "b1",
      badgeType: "quiz_completion",
      badgeName: "Quiz Master",
    });
  });

  it("deletes a badge definition and logs audit", async () => {
    const deletedBadge = {
      id: "b1",
      name: "Quiz Master",
    };

    mockDb.delete.mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([deletedBadge]),
      }),
    } as any);

    await badgeService.deleteBadge("b1");

    expect(auditLog).toHaveBeenCalledWith("badge.deleted", {
      badgeId: "b1",
      badgeName: "Quiz Master",
    });
  });
});
