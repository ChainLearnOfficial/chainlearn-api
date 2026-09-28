import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export interface CourseModuleDefinition {
  id: string;
  title: string;
  description: string;
  order: number;
}

// ─── Users ──────────────────────────────────────────────────────────────────

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stellarAddress: varchar("stellar_address", { length: 56 })
      .notNull()
      .unique(),
    displayName: varchar("display_name", { length: 100 }),
    avatarUrl: text("avatar_url"),
    background: text("background"),
    learningGoal: text("learning_goal"),
    pace: varchar("pace", { length: 20 }).default("medium"),
    language: varchar("language", { length: 10 }).default("en"),
    credits: integer("credits").notNull().default(0),
    isAdmin: boolean("is_admin").notNull().default(false),
    // Set by AdminUsersService.banUser (#226). A non-null bannedAt makes
    // authGuard reject the user with 403 before any route handler runs, so a
    // ban takes effect on the next request without needing to revoke tokens.
    bannedAt: timestamp("banned_at", { withTimezone: true }),
    banReason: text("ban_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Maintained by the `update_users_updated_at` BEFORE UPDATE trigger
    // (migration 0009), not by the application. Do not set this column
    // manually — the trigger overwrites it with NOW() on every UPDATE so that
    // credit changes and other non-profile writes are reflected too (#229).
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Set by UserService.deleteAccount (#290). Null means the account is
    // active. Once set, authGuard treats the user as if they no longer
    // exist, so any JWT issued before deletion stops working. Deliberately
    // a soft delete — the row (and its enrollments/credentials, which are
    // never touched here) is preserved for on-chain record consistency.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [index("idx_users_stellar_address").on(table.stellarAddress)]
);

// ─── Courses ────────────────────────────────────────────────────────────────

export const courses = pgTable(
  "courses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description").notNull(),
    difficulty: varchar("difficulty", { length: 20 })
      .notNull()
      .default("beginner"),
    contentHash: varchar("content_hash", { length: 64 }),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    courseModules: jsonb("course_modules").$type<Array<{
      id: string;
      title: string;
      description?: string;
      estimatedDurationMinutes?: number;
    }>>(),
    // Admin-defined module structure (#304): id/title/description/order.
    // Independent of the moduleId strings quizzes reference — this is the
    // authoring-time definition, not derived from existing quizzes.
    modules: jsonb("modules")
      .$type<CourseModuleDefinition[]>()
      .notNull()
      .default([]),
    isActive: boolean("is_active").notNull().default(true),
    // True while the course is a saved draft (#376). Tracked separately from
    // isActive: a draft is never active, and publishing clears this flag.
    isDraft: boolean("is_draft").notNull().default(false),
    // Set by CourseService.archiveCourse (#358) when the course is hidden
    // from listings. Distinguishes a deliberate archive from a course that
    // was merely never published or was soft-deleted (both just isActive =
    // false). Null for courses that were never archived.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    // 0–100 accessibility score for the course's authored content (#326),
    // recomputed on every create/update. Null until first written. Advisory
    // only — a low score never blocks saving the course.
    accessibilityScore: integer("accessibility_score"),
    // Course IDs that should be completed before this one (#354). Purely
    // advisory — CourseService.enroll() never enforces this, it's surfaced
    // to the client as a warning via getCoursePrerequisites().
    prerequisites: jsonb("prerequisites")
      .$type<string[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_courses_difficulty").on(table.difficulty),
    index("idx_courses_is_active").on(table.isActive),
    // Matches the listCourses access pattern (WHERE is_active = true
    // ORDER BY created_at DESC) so the ordering is served by the index
    // instead of a sort step (#230).
    index("idx_courses_active_created").on(
      table.isActive,
      sql`${table.createdAt} DESC`
    ),
  ]
);

// ─── Course Shares (referral links) ─────────────────────────────────────────

export const courseShares = pgTable(
  "course_shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    // Short token embedded in the shareable URL. Unique so a code can be
    // resolved to exactly one (user, course) pair.
    referralCode: varchar("referral_code", { length: 16 }).notNull().unique(),
    clickCount: integer("click_count").notNull().default(0),
    enrollmentCount: integer("enrollment_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_course_shares_user_course").on(
      table.userId,
      table.courseId
    ),
    index("idx_course_shares_referral_code").on(table.referralCode),
  ]
);

// ─── Enrollments ────────────────────────────────────────────────────────────

export const enrollments = pgTable(
  "enrollments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("idx_enrollments_user_course").on(
      table.userId,
      table.courseId
    ),
  ]
);

// ─── Quizzes ────────────────────────────────────────────────────────────────

export const quizzes = pgTable(
  "quizzes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    moduleId: varchar("module_id", { length: 100 }).notNull(),
    questions: jsonb("questions").notNull(),
    generatedFor: uuid("generated_for").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_quizzes_course_module_generated_for").on(
      table.courseId,
      table.moduleId,
      table.generatedFor
    ),
  ]
);

// ─── Quiz Submissions ───────────────────────────────────────────────────────

export const quizSubmissions = pgTable(
  "quiz_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quizId: uuid("quiz_id")
      .notNull()
      .references(() => quizzes.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    answers: jsonb("answers").notNull(),
    score: integer("score"),
    feedback: text("feedback"),
    rewardClaimed: boolean("reward_claimed").notNull().default(false),
    rewardPending: boolean("reward_pending").notNull().default(false),
    rewardFailed: boolean("reward_failed").notNull().default(false),
    // The actual credit amount granted when this submission's reward was
    // claimed. Null until claimed. Historical records must read this back
    // rather than the current REWARD_AMOUNT constant, since that constant
    // can change over time (issue #153).
    rewardAmount: integer("reward_amount"),
    txHash: varchar("tx_hash", { length: 64 }),
    // Set when a retry (POST /quizzes/:id/retry, issue #295) generates a
    // fresh quiz for the same module — the previous submission is kept for
    // history/audit rather than deleted, just marked superseded so it no
    // longer counts as "the" submission for its quiz.
    superseded: boolean("superseded").notNull().default(false),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_quiz_submissions_quiz_user").on(
      table.quizId,
      table.userId
    ),
    index("idx_quiz_submissions_user_id").on(table.userId),
    index("idx_quiz_submissions_reward_failed").on(table.rewardFailed),
    check(
      "chk_reward_mutex",
      sql`(
        (reward_claimed::int + reward_pending::int + reward_failed::int) <= 1
      )`
    ),
  ]
);

// ─── Quiz Feedback ──────────────────────────────────────────────────────────

export const quizFeedback = pgTable(
  "quiz_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quizId: uuid("quiz_id")
      .notNull()
      .references(() => quizzes.id, { onDelete: "cascade" }),
    questionId: varchar("question_id", { length: 100 }).notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 20 }).notNull(),
    comment: text("comment"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One feedback submission per (quiz, question, user) — a second
    // submission is rejected rather than silently overwriting the first.
    uniqueIndex("idx_quiz_feedback_unique").on(
      table.quizId,
      table.questionId,
      table.userId
    ),
    index("idx_quiz_feedback_quiz_question").on(
      table.quizId,
      table.questionId
    ),
    check(
      "chk_quiz_feedback_type",
      sql`type IN ('unclear', 'wrong', 'other')`
    ),
  ]
);

// ─── Course Reviews / Ratings ───────────────────────────────────────────────

export const courseReviews = pgTable(
  "course_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    rating: integer("rating").notNull(),
    reviewText: text("review_text"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_course_reviews_user_course").on(
      table.userId,
      table.courseId
    ),
    index("idx_course_reviews_course_id").on(table.courseId),
    // Rating is a 1–5 star value; the DB rejects anything outside that
    // range so a bad write can't skew a course's average rating.
    check("chk_course_reviews_rating", sql`rating >= 1 AND rating <= 5`),
  ]
);

// ─── Notifications ──────────────────────────────────────────────────────────

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 50 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    message: text("message").notNull(),
    read: boolean("read").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_notifications_user_created").on(
      table.userId,
      sql`${table.createdAt} DESC`
    ),
    index("idx_notifications_user_read").on(table.userId, table.read),
  ]
);

// ─── Announcements ──────────────────────────────────────────────────────────

export const announcements = pgTable(
  "announcements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: varchar("title", { length: 255 }).notNull(),
    message: text("message").notNull(),
    priority: varchar("priority", { length: 20 }).notNull().default("normal"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    // Matches the public listing's access pattern (WHERE active = true AND
    // (expires_at IS NULL OR expires_at > now()) ORDER BY created_at DESC).
    index("idx_announcements_active_created").on(
      table.active,
      sql`${table.createdAt} DESC`
    ),
  ]
);

// ─── Credentials (NFT Certificates) ────────────────────────────────────────

export const credentials = pgTable(
  "credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    score: integer("score").notNull(),
    nftAssetCode: varchar("nft_asset_code", { length: 12 }),
    nftIssuer: varchar("nft_issuer", { length: 56 }),
    mintTxHash: varchar("mint_tx_hash", { length: 64 }),
    revoked: boolean("revoked").notNull().default(false),
    mintedAt: timestamp("minted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_credentials_user_course").on(
      table.userId,
      table.courseId
    ),
  ]
);

// ─── Idempotency Keys ─────────────────────────────────────────────────────

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    key: varchar("key", { length: 64 }).primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: varchar("endpoint", { length: 255 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body"),
    txHash: varchar("tx_hash", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("idx_idempotency_expires").on(table.expiresAt)]
);

// ─── Enrollment Waitlist ────────────────────────────────────────────────────

export const enrollmentWaitlist = pgTable(
  "enrollment_waitlist",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_waitlist_user_course").on(table.userId, table.courseId),
    index("idx_waitlist_course_position").on(table.courseId, table.position),
  ]
);

// ─── Webhooks ───────────────────────────────────────────────────────────────

export const webhooks = pgTable(
  "webhooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    url: varchar("url", { length: 2048 }).notNull(),
    events: jsonb("events").$type<string[]>().notNull(), // e.g., ["enrollment", "quiz.completed", "reward.claimed"]
    secret: varchar("secret", { length: 256 }).notNull(), // HMAC secret for signing payloads
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_webhooks_active").on(table.active),
  ]
);

// ─── Webhook Attempts (for retry tracking) ──────────────────────────────────

export const webhookAttempts = pgTable(
  "webhook_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    webhookId: uuid("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    event: varchar("event", { length: 100 }).notNull(),
    payload: jsonb("payload").notNull(),
    statusCode: integer("status_code"),
    responseBody: text("response_body"),
    errorMessage: text("error_message"),
    retryCount: integer("retry_count").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    succeededAt: timestamp("succeeded_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_webhook_attempts_webhook_id").on(table.webhookId),
    index("idx_webhook_attempts_event").on(table.event),
    index("idx_webhook_attempts_next_retry").on(table.nextRetryAt),
    index("idx_webhook_attempts_succeeded").on(table.succeededAt),
  ]
);

// ─── Course Reports ─────────────────────────────────────────────────────────

export const courseReports = pgTable(
  "course_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: varchar("reason", { length: 20 }).notNull(),
    description: text("description"),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_course_reports_user_course").on(
      table.userId,
      table.courseId
    ),
    index("idx_course_reports_course_id").on(table.courseId),
    index("idx_course_reports_status").on(table.status),
    check(
      "chk_course_reports_reason",
      sql`${table.reason} IN ('inappropriate', 'outdated', 'error', 'other')`
    ),
    check(
      "chk_course_reports_status",
      sql`${table.status} IN ('pending', 'reviewed', 'dismissed')`
    ),
  ]
);

// ─── Sessions ───────────────────────────────────────────────────────────────

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // The JWT's `jti` claim. Unique so authGuard can upsert the same row on
    // every request from the same token instead of inserting a new one.
    tokenId: varchar("token_id", { length: 64 }).notNull(),
    deviceInfo: text("device_info"),
    ipAddress: varchar("ip_address", { length: 45 }),
    lastActive: timestamp("last_active", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Set by SessionService.revokeSession. The session's jti is also added
    // to the JWT denylist at the same time, so a revoked session's token
    // stops working immediately rather than only once this row is checked.
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_sessions_token_id").on(table.tokenId),
    index("idx_sessions_user_revoked").on(table.userId, table.revokedAt),
  ]
);

// ─── Audit Logs ─────────────────────────────────────────────────────────────
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    event: varchar("event", { length: 255 }).notNull(),
    fields: jsonb("fields"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Both indexes already exist in the database (migration 0006) but were
    // never reflected here in the Drizzle schema — added now so the ORM
    // schema matches reality and so admin-users' audit-log listing (#289)
    // is backed by an index for its `event` filter and its `created_at`
    // range/ordering.
    index("idx_audit_logs_event").on(table.event),
    index("idx_audit_logs_created_at").on(table.createdAt),
  ]
);

// ─── Announcements ──────────────────────────────────────────────────────────
export const announcements = pgTable(
  "announcements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: varchar("title", { length: 255 }).notNull(),
    message: text("message").notNull(),
    priority: varchar("priority", { length: 20 }).notNull().default("normal"),
    active: boolean("active").notNull().default(true),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_announcements_active").on(table.active),
  ]
);

// ─── Course Shares ──────────────────────────────────────────────────────────
export const courseShares = pgTable(
  "course_shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    referralCode: varchar("referral_code", { length: 64 }).notNull().unique(),
    clickCount: integer("click_count").notNull().default(0),
    enrollmentCount: integer("enrollment_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_course_shares_user_course").on(table.userId, table.courseId),
    index("idx_course_shares_referral_code").on(table.referralCode),
  ]
);

// ─── Course Reviews ─────────────────────────────────────────────────────────
export const courseReviews = pgTable(
  "course_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    rating: integer("rating").notNull(),
    reviewText: text("review_text"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_course_reviews_user_course").on(table.userId, table.courseId),
    index("idx_course_reviews_course_id").on(table.courseId),
  ]
);

// ─── Notifications ─────────────────────────────────────────────────────────
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 50 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    message: text("message").notNull(),
    read: boolean("read").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_notifications_user_id").on(table.userId),
    index("idx_notifications_user_read").on(table.userId, table.read),
  ]
);

// ─── Badges ─────────────────────────────────────────────────────────────────
export interface BadgeCriteria {
  type?: string;
  count?: number;
  threshold?: number;
  courseId?: string;
  action?: string;
  days?: number;
  [key: string]: unknown;
}

export const badges = pgTable(
  "badges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description").notNull(),
    iconUrl: text("icon_url").notNull(),
    type: varchar("type", { length: 50 }).notNull(), // 'enrollment', 'quiz_completion', 'credential', 'streak', 'course_completion'
    criteria: jsonb("criteria").$type<BadgeCriteria>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_badges_type").on(table.type),
  ]
);

// ─── User Badges ────────────────────────────────────────────────────────────
export const userBadges = pgTable(
  "user_badges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    badgeId: uuid("badge_id")
      .notNull()
      .references(() => badges.id, { onDelete: "cascade" }),
    earnedAt: timestamp("earned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    progress: jsonb("progress").$type<Record<string, unknown>>(),
  },
  (table) => [
    uniqueIndex("idx_user_badges_user_badge").on(table.userId, table.badgeId),
    index("idx_user_badges_user_id").on(table.userId),
  ]
);

// ─── Module Content ────────────────────────────────────────────────────────
export type ContentType = "text" | "video" | "quiz" | "exercise";

export interface TextContentPayload {
  body: string;
}

export interface VideoContentPayload {
  videoUrl: string;
  durationSeconds?: number;
  transcript?: string;
}

export interface QuizContentPayload {
  quizId?: string;
  questions?: Array<{
    id: string;
    text: string;
    options: string[];
    correctIndex: number;
    explanation?: string;
  }>;
}

export interface ExerciseContentPayload {
  instructions: string;
  starterCode?: string;
  solution?: string;
  language?: string;
}

export type ModuleContentPayload =
  | TextContentPayload
  | VideoContentPayload
  | QuizContentPayload
  | ExerciseContentPayload
  | Record<string, unknown>;

export const moduleContent = pgTable(
  "module_content",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    moduleId: varchar("module_id", { length: 100 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    type: varchar("type", { length: 20 }).notNull(), // 'text' | 'video' | 'quiz' | 'exercise'
    content: jsonb("content").$type<ModuleContentPayload>().notNull(),
    orderIndex: integer("order_index").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_module_content_course_module").on(table.courseId, table.moduleId),
    index("idx_module_content_module_order").on(table.moduleId, table.orderIndex),
    check(
      "chk_module_content_type",
      sql`type IN ('text', 'video', 'quiz', 'exercise')`
    ),
  ]
);
