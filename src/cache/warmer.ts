import { cacheSet, cacheKey } from "./index.js";
import { logger } from "../utils/logger.js";
import { courseService } from "../modules/courses/course.service.js";

const WARM_PAGE_LIMIT = 20;

/**
 * Warms every page of the "all courses" listing (not just page 1), so
 * users on page 2+ hit a warm cache instead of always querying the
 * database (#147). Pages are fetched sequentially and each written to its
 * own cache key, mirroring CourseService.listCourses' own pagination.
 */
export async function warmCourseCache(): Promise<void> {
  try {
    logger.info("Starting course listing cache warming cycle...");

    let page = 1;
    let totalPages = 1;

    do {
      const data = await courseService.listCourses(null, {
        page,
        limit: WARM_PAGE_LIMIT,
      });

      const key = cacheKey("courses", "list", "all", page, WARM_PAGE_LIMIT);
      await cacheSet(key, data, 60);

      totalPages = Math.max(1, Math.ceil(data.total / WARM_PAGE_LIMIT));
      page++;
    } while (page <= totalPages);

    logger.info(
      { pagesWarmed: totalPages },
      "Course listing cache successfully warmed"
    );
  } catch (err) {
    logger.error({ err }, "Cache warming cycle failed step execution");
  }
}
