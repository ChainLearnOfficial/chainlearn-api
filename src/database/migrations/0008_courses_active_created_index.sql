-- Add composite index on courses(is_active, created_at DESC) to support the
-- listCourses query in course.service.ts, which always filters on
-- is_active = true and orders by created_at DESC.
--
-- The existing single-column idx_courses_is_active can satisfy the filter but
-- not the ordering, so Postgres has to add a sort step whose cost grows with
-- the number of active courses. Matching the index order to the ORDER BY lets
-- the planner walk the index and stop after LIMIT rows instead.
CREATE INDEX IF NOT EXISTS idx_courses_active_created
  ON courses (is_active, created_at DESC);
