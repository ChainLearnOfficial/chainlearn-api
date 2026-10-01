-- Indexes to support the getRecommendedCourses query pattern.
--
-- Query 1 (user context): fetches all of a user's enrollments with
-- completed_at and joins to credentials. The existing unique index
-- idx_enrollments_user_course covers (user_id, course_id) but does not
-- include completed_at, so a partial scan is needed to filter completed rows.
-- This composite index lets the planner satisfy
--   WHERE user_id = ?
-- and cover completed_at without a heap fetch.
CREATE INDEX IF NOT EXISTS idx_enrollments_user_completed
  ON enrollments (user_id, completed_at);

-- Query 2 (peer collaborative filtering): finds peers who share any of the
-- current user's enrolled courses, then aggregates their other enrollments.
-- The join condition is  WHERE course_id = ANY(?) which requires an index
-- on course_id alone. The leading-column of the unique index is user_id,
-- so it is not used for course-first lookups on all planner configurations.
CREATE INDEX IF NOT EXISTS idx_enrollments_course_id
  ON enrollments (course_id);

-- Query 3 (candidate courses): every recommendation query filters by
-- is_active = true and optionally by difficulty. A composite covering index
-- lets the planner satisfy both predicates without visiting the table heap
-- for the filter pass.
CREATE INDEX IF NOT EXISTS idx_courses_active_difficulty
  ON courses (is_active, difficulty);
