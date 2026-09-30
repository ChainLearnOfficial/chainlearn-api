import { integer, pgTable, serial, text, timestamp, varchar, boolean, jsonb, primaryKey } from 'drizzle-orm/pg-core';

// Users table
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  username: varchar('username', { length: 255 }).notNull().unique(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  password_hash: varchar('password_hash', { length: 255 }).notNull(),
  first_name: varchar('first_name', { length: 100 }),
  last_name: varchar('last_name', { length: 100 }),
  is_active: boolean('is_active').default(true),
  is_verified: boolean('is_verified').default(false),
  role: varchar('role', { length: 20 }).default('user'),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
  last_login: timestamp('last_login'),
  profile_picture: varchar('profile_picture', { length: 500 }),
  bio: text('bio'),
  stellar_address: varchar('stellar_address', { length: 56 }),
  evm_address: varchar('evm_address', { length: 42 }),
});

// Courses table
export const courses = pgTable('courses', {
  id: serial('id').primaryKey(),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description').notNull(),
  instructor_id: integer('instructor_id').references(() => users.id),
  category: varchar('category', { length: 100 }),
  difficulty: varchar('difficulty', { length: 20 }).default('beginner'),
  price: integer('price').default(0),
  is_published: boolean('is_published').default(false),
  thumbnail_url: varchar('thumbnail_url', { length: 500 }),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

// Course modules table
export const course_modules = pgTable('course_modules', {
  id: serial('id').primaryKey(),
  course_id: integer('course_id').references(() => courses.id).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  order: integer('order').notNull(),
  is_published: boolean('is_published').default(false),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

// Module lessons table
export const module_lessons = pgTable('module_lessons', {
  id: serial('id').primaryKey(),
  module_id: integer('module_id').references(() => course_modules.id).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  content: text('content').notNull(),
  order: integer('order').notNull(),
  video_url: varchar('video_url', { length: 500 }),
  duration: integer('duration'),
  is_published: boolean('is_published').default(false),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

// Module quizzes table
export const module_quizzes = pgTable('module_quizzes', {
  id: serial('id').primaryKey(),
  module_id: integer('module_id').references(() => course_modules.id).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  passing_score: integer('passing_score').default(70),
  time_limit: integer('time_limit'),
  is_published: boolean('is_published').default(false),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

// Quiz questions table
export const quiz_questions = pgTable('quiz_questions', {
  id: serial('id').primaryKey(),
  quiz_id: integer('quiz_id').references(() => module_quizzes.id).notNull(),
  question_text: text('question_text').notNull(),
  question_type: varchar('question_type', { length: 20 }).notNull(),
  points: integer('points').default(1),
  order: integer('order').notNull(),
  options: jsonb('options'),
  correct_answer: jsonb('correct_answer').notNull(),
  explanation: text('explanation'),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

// User progress table
export const user_progress = pgTable('user_progress', {
  id: serial('id').primaryKey(),
  user_id: integer('user_id').references(() => users.id).notNull(),
  course_id: integer('course_id').references(() => courses.id).notNull(),
  module_id: integer('module_id').references(() => course_modules.id),
  lesson_id: integer('lesson_id').references(() => module_lessons.id),
  progress_percentage: integer('progress_percentage').default(0),
  is_completed: boolean('is_completed').default(false),
  last_accessed: timestamp('last_accessed'),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

// User quiz attempts table
export const user_quiz_attempts = pgTable('user_quiz_attempts', {
  id: serial('id').primaryKey(),
  user_id: integer('user_id').references(() => users.id).notNull(),
  quiz_id: integer('quiz_id').references(() => module_quizzes.id).notNull(),
  attempt_number: integer('attempt_number').notNull(),
  score: integer('score').notNull(),
  is_passed: boolean('is_passed').default(false),
  started_at: timestamp('started_at').notNull(),
  completed_at: timestamp('completed_at'),
  answers: jsonb('answers').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
});

// Enrollments table
export const enrollments = pgTable('enrollments', {
  id: serial('id').primaryKey(),
  user_id: integer('user_id').references(() => users.id).notNull(),
  course_id: integer('course_id').references(() => courses.id).notNull(),
  enrollment_date: timestamp('enrollment_date').defaultNow().notNull(),
  completion_date: timestamp('completion_date'),
  is_active: boolean('is_active').default(true),
  certificate_id: varchar('certificate_id', { length: 100 }),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

// Certificates table
export const certificates = pgTable('certificates', {
  id: serial('id').primaryKey(),
  enrollment_id: integer('enrollment_id').references(() => enrollments.id).notNull(),
  certificate_hash: varchar('certificate_hash', { length: 64 }).notNull().unique(),
  issued_at: timestamp('issued_at').defaultNow().notNull(),
  expires_at: timestamp('expires_at'),
  is_revoked: boolean('is_revoked').default(false),
  revocation_reason: text('revocation_reason'),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

// Course reviews table
export const course_reviews = pgTable('course_reviews', {
  id: serial('id').primaryKey(),
  course_id: integer('course_id').references(() => courses.id).notNull(),
  user_id: integer('user_id').references(() => users.id).notNull(),
  rating: integer('rating').notNull(),
  comment: text('comment'),
  is_approved: boolean('is_approved').default(false),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

// User bookmarks table
export const user_bookmarks = pgTable('user_bookmarks', {
  id: serial('id').primaryKey(),
  user_id: integer('user_id').references(() => users.id).notNull(),
  course_id: integer('course_id').references(() => courses.id),
  module_id: integer('module_id').references(() => course_modules.id),
  lesson_id: integer('lesson_id').references(() => module_lessons.id),
  created_at: timestamp('created_at').defaultNow().notNull(),
});

// Notifications table
export const notifications = pgTable('notifications', {
  id: serial('id').primaryKey(),
  user_id: integer('user_id').references(() => users.id).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  message: text('message').notNull(),
  is_read: boolean('is_read').default(false),
  related_entity_type: varchar('related_entity_type', { length: 50 }),
  related_entity_id: integer('related_entity_id'),
  created_at: timestamp('created_at').defaultNow().notNull(),
});

// Payment transactions table
export const payment_transactions = pgTable('payment_transactions', {
  id: serial('id').primaryKey(),
  user_id: integer('user_id').references(() => users.id).notNull(),
  course_id: integer('course_id').references(() => courses.id),
  amount: integer('amount').notNull(),
  currency: varchar('currency', { length: 3 }).default('USD'),
  payment_method: varchar('payment_method', { length: 50 }).notNull(),
  transaction_hash: varchar('transaction_hash', { length: 100 }),
  status: varchar('status', { length: 20 }).default('pending'),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

// Junction table for course tags
export const course_tags = pgTable('course_tags', {
  course_id: integer('course_id').references(() => courses.id).notNull(),
  tag: varchar('tag', { length: 50 }).notNull(),
}, (table) => {
  return {
    pk: primaryKey({ columns: [table.course_id, table.tag] }),
  };
});

// Junction table for user skills
export const user_skills = pgTable('user_skills', {
  user_id: integer('user_id').references(() => users.id).notNull(),
  skill: varchar('skill', { length: 50 }).notNull(),
  proficiency: varchar('proficiency', { length: 20 }).default('beginner'),
}, (table) => {
  return {
    pk: primaryKey({ columns: [table.user_id, table.skill] }),
  };
});

// Badges table
export const badges = pgTable('badges', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  image_url: varchar('image_url', { length: 500 }),
  criteria: jsonb('criteria').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
});

// User badges junction table
export const user_badges = pgTable('user_badges', {
  user_id: integer('user_id').references(() => users.id).notNull(),
  badge_id: integer('badge_id').references(() => badges.id).notNull(),
  awarded_at: timestamp('awarded_at').defaultNow().notNull(),
}, (table) => {
  return {
    pk: primaryKey({ columns: [table.user_id, table.badge_id] }),
  };
});

// Learning paths table
export const learning_paths = pgTable('learning_paths', {
  id: serial('id').primaryKey(),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  creator_id: integer('creator_id').references(() => users.id).notNull(),
  is_published: boolean('is_published').default(false),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

// Learning path courses junction table
export const learning_path_courses = pgTable('learning_path_courses', {
  learning_path_id: integer('learning_path_id').references(() => learning_paths.id).notNull(),
  course_id: integer('course_id').references(() => courses.id).notNull(),
  order: integer('order').notNull(),
}, (table) => {
  return {
    pk: primaryKey({ columns: [table.learning_path_id, table.course_id] }),
  };
});

// User learning paths junction table
export const user_learning_paths = pgTable('user_learning_paths', {
  user_id: integer('user_id').references(() => users.id).notNull(),
  learning_path_id: integer('learning_path_id').references(() => learning_paths.id).notNull(),
  progress_percentage: integer('progress_percentage').default(0),
  is_completed: boolean('is_completed').default(false),
  started_at: timestamp('started_at').defaultNow().notNull(),
  completed_at: timestamp('completed_at'),
}, (table) => {
  return {
    pk: primaryKey({ columns: [table.user_id, table.learning_path_id] }),
  };
});

// Discussion forums table
export const discussion_forums = pgTable('discussion_forums', {
  id: serial('id').primaryKey(),
  course_id: integer('course_id').references(() => courses.id),
  module_id: integer('module_id').references(() => course_modules.id),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  created_by: integer('created_by').references(() => users.id).notNull(),
  is_locked: boolean('is_locked').default(false),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

// Discussion threads table
export const discussion_threads = pgTable('discussion_threads', {
  id: serial('id').primaryKey(),
  forum_id: integer('forum_id').references(() => discussion_forums.id).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  content: text('content').notNull(),
  created_by: integer('created_by').references(() => users.id).notNull(),
  is_pinned: boolean('is_pinned').default(false),
  is_locked: boolean('is_locked').default(false),
  view_count: integer('view_count').default(0),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

// Discussion posts table
export const discussion_posts = pgTable('discussion_posts', {
  id: serial('id').primaryKey(),
  thread_id: integer('thread_id').references(() => discussion_threads.id).notNull(),
  content: text('content').notNull(),
  created_by: integer('created_by').references(() => users.id).notNull(),
  parent_id: integer('parent_id').references(() => discussion_posts.id),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

// System logs table
export const system_logs = pgTable('system_logs', {
  id: serial('id').primaryKey(),
  user_id: integer('user_id').references(() => users.id),
  action: varchar('action', { length: 100 }).notNull(),
  entity_type: varchar('entity_type', { length: 50 }).notNull(),
  entity_id: integer('entity_id'),
  metadata: jsonb('metadata'),
  ip_address: varchar('ip_address', { length: 45 }),
  user_agent: text('user_agent'),
  created_at: timestamp('created_at').defaultNow().notNull(),
});

// API keys table
export const api_keys = pgTable('api_keys', {
  id: serial('id').primaryKey(),
  user_id: integer('user_id').references(() => users.id).notNull(),
  key: varchar('key', { length: 64 }).notNull().unique(),
  secret: varchar('secret', { length: 64 }).notNull(),
  name: varchar('name', { length: 100 }),
  permissions: jsonb('permissions').notNull(),
  is_active: boolean('is_active').default(true),
  last_used: timestamp('last_used'),
  created_at: timestamp('created_at').defaultNow().notNull(),
  expires_at: timestamp('expires_at'),
});

// Webhook endpoints table
export const webhook_endpoints = pgTable('webhook_endpoints', {
  id: serial('id').primaryKey(),
  user_id: integer('user_id').references(() => users.id).notNull(),
  url: varchar('url', { length: 500 }).notNull(),
  events: jsonb('events').notNull(),
  secret: varchar('secret', { length: 64 }),
  is_active: boolean('is_active').default(true),
  last_triggered: timestamp('last_triggered'),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

// Webhook deliveries table
export const webhook_deliveries = pgTable('webhook_deliveries', {
  id: serial('id').primaryKey(),
  endpoint_id: integer('endpoint_id').references(() => webhook_endpoints.id).notNull(),
  event_type: varchar('event_type', { length: 100 }).notNull(),
  payload: jsonb('payload').notNull(),
  response_status: integer('response_status'),
  response_body: text('response_body'),
  attempts: integer('attempts').default(0),
  max_attempts: integer('max_attempts').default(3),
  next_attempt: timestamp('next_attempt'),
  created_at: timestamp('created_at').defaultNow().notNull(),
});

// Rate limiting table
export const rate_limits = pgTable('rate_limits', {
  id: serial('id').primaryKey(),
  identifier: varchar('identifier', { length: 255 }).notNull(),
  endpoint: varchar('endpoint', { length: 255 }).notNull(),
  count: integer('count').default(0),
  reset_at: timestamp('reset_at').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (table) => {
  return {
    pk: primaryKey({ columns: [table.identifier, table.endpoint] }),
  };
});