import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/config/database.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    query: {
      courses: { findFirst: vi.fn() },
      courseShares: { findFirst: vi.fn() },
    },
  },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("../../../src/utils/lock.js", () => ({
  withLock: vi.fn(async (_k: string, fn: () => Promise<any>) => fn()),
}));

vi.mock("../../../src/audit/index.js", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/stellar/progress-tracker.js", () => ({
  getOnChainContentHash: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../../src/cache/index.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheInvalidatePattern: vi.fn().mockResolvedValue(undefined),
  cacheKey: (...p: (string | number)[]) => p.join(":"),
  cacheKeyPattern: (...p: (string | number)[]) => `${p.join(":")}:*`,
}));

vi.mock("../../../src/config/index.js", () => ({
  config: { MAX_ENROLLMENTS: 10, PUBLIC_BASE_URL: "https://chainlearn.app" },
}));

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,QR") },
}));

import { db } from "../../../src/config/database.js";
import { courseService } from "../../../src/modules/courses/course.service.js";
import { NotFoundError } from "../../../src/utils/errors.js";

const mockDb = vi.mocked(db, true);

describe("CourseService — sharing / referrals (#325)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the existing share link when one already exists", async () => {
    (mockDb.query.courses.findFirst as any).mockResolvedValue({
      id: "c1",
      isActive: true,
    });
    (mockDb.query.courseShares.findFirst as any).mockResolvedValue({
      id: "sh1",
      userId: "u1",
      courseId: "c1",
      referralCode: "ABC123",
      clickCount: 4,
      enrollmentCount: 2,
    });

    const link = await courseService.createShareLink("u1", "c1");

    expect(link).toEqual({
      courseId: "c1",
      referralCode: "ABC123",
      url: "https://chainlearn.app/api/v1/courses/c1?ref=ABC123",
      qrCode: "data:image/png;base64,QR",
      clickCount: 4,
      enrollmentCount: 2,
    });
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("creates a new share link with a generated code", async () => {
    (mockDb.query.courses.findFirst as any).mockResolvedValue({
      id: "c1",
      isActive: true,
    });
    (mockDb.query.courseShares.findFirst as any).mockResolvedValue(undefined);
    const returning = vi.fn().mockResolvedValue([
      {
        id: "sh2",
        userId: "u1",
        courseId: "c1",
        referralCode: "GENERATED9",
        clickCount: 0,
        enrollmentCount: 0,
      },
    ]);
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({ returning }),
    } as any);

    const link = await courseService.createShareLink("u1", "c1");

    expect(link.referralCode).toBe("GENERATED9");
    expect(link.url).toContain("?ref=GENERATED9");
    expect(link.qrCode).toBe("data:image/png;base64,QR");
  });

  it("404s creating a link for an inactive course", async () => {
    (mockDb.query.courses.findFirst as any).mockResolvedValue({
      id: "c1",
      isActive: false,
    });
    await expect(courseService.createShareLink("u1", "c1")).rejects.toThrow(
      NotFoundError,
    );
  });

  it("counts a click when a non-owner resolves the link", async () => {
    (mockDb.query.courseShares.findFirst as any).mockResolvedValue({
      id: "sh1",
      userId: "owner",
      courseId: "c1",
      referralCode: "ABC123",
    });
    const where = vi.fn().mockResolvedValue(undefined);
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({ where }),
    } as any);
    vi.spyOn(courseService, "getCourseDetail").mockResolvedValue({
      id: "c1",
    } as any);

    const resolved = await courseService.resolveShareLink("ABC123", "viewer");

    expect(resolved.sharedByUserId).toBe("owner");
    expect(mockDb.update).toHaveBeenCalledOnce();
  });

  it("does not count a click when the owner opens their own link", async () => {
    (mockDb.query.courseShares.findFirst as any).mockResolvedValue({
      id: "sh1",
      userId: "owner",
      courseId: "c1",
      referralCode: "ABC123",
    });
    vi.spyOn(courseService, "getCourseDetail").mockResolvedValue({
      id: "c1",
    } as any);

    await courseService.resolveShareLink("ABC123", "owner");

    expect(mockDb.update).not.toHaveBeenCalled();
  });
});
