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
