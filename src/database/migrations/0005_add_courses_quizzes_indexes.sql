-- Add index on courses.difficulty to speed up listCoursesSchema difficulty filter
CREATE INDEX IF NOT EXISTS idx_courses_difficulty ON courses (difficulty);

-- Add index on courses.is_active since every course list query filters by is_active = true
CREATE INDEX IF NOT EXISTS idx_courses_is_active ON courses (is_active);

-- Add composite index on quizzes(course_id, module_id, generated_for) to match
-- the lookup in quiz.service.ts (WHERE course_id AND module_id AND generated_for)
CREATE INDEX IF NOT EXISTS idx_quizzes_course_module_generated_for
  ON quizzes (course_id, module_id, generated_for);
