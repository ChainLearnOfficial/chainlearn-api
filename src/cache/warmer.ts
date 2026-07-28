import { logger } from "../utils/logger.js";
import { courseService } from "../modules/courses/course.service.js";

/**
 * Warms the course listing cache by calling listCourses() itself, the same
 * way a real request would. listCourses() already writes its own result to
 * the cache (with its own 30s TTL) on a miss — the warmer used to also
 * cacheSet the same key with a second, hardcoded 60s TTL of its own (#148).
 * That meant the warmed entry's actual expiry silently disagreed with
 * every other write to the same key, and the two TTLs could drift apart
 * again the moment either one changed. Only calling listCourses() removes
 * the second TTL entirely — there's now exactly one place that decides
 * how long this cache key lives.
 */
export async function warmCourseCache(): Promise<void> {
  try {
    logger.info("Starting course listing cache warming cycle...");

    const landingPageQuery = { page: 1, limit: 20 };
    await courseService.listCourses(null, landingPageQuery);

    logger.info("Course listing cache successfully warmed");
  } catch (err) {
    logger.error({ err }, "Cache warming cycle failed step execution");
  }
}
