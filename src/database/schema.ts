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
} from "drizzle-orm/pg-core";

// ─── Users ──────────────────────────────────────────────────────────────────

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stellarAddress: varchar("stellar_address", { length: 56 })
      .notNull()
      .unique(),
    displayName: varchar("display_name", { length: 100 }),
    background: text("background"),
    learningGoal: text("learning_goal"),
    pace: varchar("pace", { length: 20 }).default("medium"),
    language: varchar("language", { length: 10 }).default("en"),
    credits: integer("credits").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("idx_users_stellar_address").on(table.stellarAddress)]
);

// ─── Courses ────────────────────────────────────────────────────────────────

export const courses = pgTable("courses", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description").notNull(),
  difficulty: varchar("difficulty", { length: 20 })
    .notNull()
    .default("beginner"),
  contentHash: varchar("content_hash", { length: 64 }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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

export const quizzes = pgTable("quizzes", {
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
});

// ─── Quiz Submissions ───────────────────────────────────────────────────────

export const quizSubmissions = pgTable("quiz_submissions", {
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
  txHash: varchar("tx_hash", { length: 64 }),
  submittedAt: timestamp("submitted_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ─── Credentials (NFT Certificates) ────────────────────────────────────────

export const credentials = pgTable("credentials", {
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
});
