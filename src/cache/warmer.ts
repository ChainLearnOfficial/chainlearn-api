import { cacheSet, cacheKey } from "./index.js";
import { logger } from "../utils/logger.js";
import { courseService } from "../modules/courses/course.service.js";

export async function warmCourseCache(): Promise<void> {
  try {
    logger.info("Starting course listing cache warming cycle...");

    const landingPageQuery = { page: 1, limit: 20 };
    const data = await courseService.listCourses(null, landingPageQuery);

    const key = cacheKey("courses", "list", "all", 1, 20);

    await cacheSet(key, data, 60);

    logger.info("Course listing cache successfully warmed");
  } catch (err) {
    logger.error({ err }, "Cache warming cycle failed step execution");
  }
}
