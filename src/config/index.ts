import { z } from "zod";
import dotenv from "dotenv";

// Test mode gets its own optional .env.test file (#475), gitignored like
// .env — see .env.test.example. dotenv never overwrites a value already set
// in process.env, so real CI-provided environment variables still win over
// anything in either file; this only fills in what's missing.
dotenv.config({ path: process.env.NODE_ENV === "test" ? ".env.test" : ".env" });

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),

  // Database
  DATABASE_URL: z
    .string()
    .url()
    .refine(
      (url) => url.startsWith("postgresql://") || url.startsWith("postgres://"),
      { message: "DATABASE_URL must be a PostgreSQL connection string" }
    ),

  // Redis
  REDIS_URL: z.string().default("redis://localhost:6379"),

  // CORS — comma-separated allow-list of browser origins, e.g.
  // "https://chainlearn.io,https://app.chainlearn.io". Optional: when unset,
  // a per-environment default is used (see `corsOrigins` below). Parsed into
  // an array of trimmed, non-empty origin strings.
  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((val) =>
      val
        ? val
            .split(",")
            .map((origin) => origin.trim())
            .filter(Boolean)
        : undefined,
    ),

  // JWT — OWASP recommends 256 bits (>= 64 chars) and a non-placeholder value.
  JWT_SECRET: z
    .string()
    .min(64, "JWT_SECRET must be at least 64 characters (256 bits)")
    .refine(
      (val) =>
        val !== "your-secret-key" && !val.includes("change-in-production"),
      "JWT_SECRET must be a real secret, not a placeholder"
    ),

  // Stellar
  STELLAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  STELLAR_HORIZON_URL: z.string().url(),
  STELLAR_SOROBAN_RPC_URL: z.string().url(),
  STELLAR_PLATFORM_SECRET: z.string().regex(
    /^S[A-Z2-7]{55}$/,
    { message: "Invalid Stellar secret key format" }
  ),
  STELLAR_QUIZ_CONTRACT_ID: z.string().min(1),
  STELLAR_REWARD_CONTRACT_ID: z.string().min(1),
  STELLAR_CREDENTIAL_CONTRACT_ID: z.string().min(1),
  // Optional: enables on-chain contentHash verification on enrollment
  // (#294). Unset by default — the check is skipped (non-blocking) until a
  // progress-tracker contract is deployed and configured.
  STELLAR_PROGRESS_TRACKER_CONTRACT_ID: z.string().optional(),

  // Rate limiting
  RATE_LIMIT_MAX: z.coerce.number().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),

  // Max number of courses a user can be actively enrolled in at once (#306).
  // Completed enrollments (completedAt set) don't count toward this.
  MAX_ENROLLMENTS: z.coerce.number().int().positive().default(10),

  // Request timeout middleware (#305)
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  QUIZ_GENERATION_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  // Request body limits
  REQUEST_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
  MULTIPART_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(5_242_880),
  AVATAR_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(2_097_152),
  AVATAR_UPLOAD_DIR: z.string().default("uploads/avatars"),
  PUBLIC_BASE_URL: z.string().url().optional(),

  // AI service (chainlearn-ai) used for quiz generation
  AI_SERVICE_URL: z.string().url().default("http://localhost:8000"),
  AI_TIMEOUT_MS: z.coerce.number().default(30_000),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Last-resort values for the schema fields that have no zod `.default()`
 * (they're `required` in every other environment), used only when NODE_ENV
 * is "test" and neither a real environment variable nor .env.test supplies
 * one (#475). Fields the schema already defaults (RATE_LIMIT_MAX,
 * REQUEST_TIMEOUT_MS, AI_SERVICE_URL, etc.) don't need an entry here —
 * envSchema.parse() applies its own default when the field is undefined.
 *
 * These are placeholder shapes, not real credentials: STELLAR_PLATFORM_SECRET
 * in particular must be syntactically valid (`/^S[A-Z2-7]{55}$/`) or every
 * test run fails config validation before a single test executes, which is
 * exactly what the literal string "test" used to do here.
 */
const TEST_FALLBACKS = {
  DATABASE_URL: "postgresql://chainlearn_test:test_password@localhost:5432/chainlearn_test",
  JWT_SECRET: "test-secret-key-that-is-at-least-sixty-four-characters-long-for-tests",
  STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
  STELLAR_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  STELLAR_PLATFORM_SECRET: "S" + "A".repeat(55),
  STELLAR_QUIZ_CONTRACT_ID: "test-quiz-contract",
  STELLAR_REWARD_CONTRACT_ID: "test-reward-contract",
  STELLAR_CREDENTIAL_CONTRACT_ID: "test-credential-contract",
} as const;

let _config: Env | null = null;

// Test-mode-only placeholders for non-critical vars (contract IDs, public
// testnet URLs) whose exact value doesn't matter for most tests. These are
// deliberately NOT secret-shaped — "CHANGE_ME_IN_TEST_ENV" can never be
// mistaken for a real credential — unlike the old hardcoded fallbacks this
// replaces (#475).
const TEST_MODE_NON_SECRET_DEFAULTS = {
  STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
  STELLAR_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  STELLAR_QUIZ_CONTRACT_ID: "CHANGE_ME_IN_TEST_ENV",
  STELLAR_REWARD_CONTRACT_ID: "CHANGE_ME_IN_TEST_ENV",
  STELLAR_CREDENTIAL_CONTRACT_ID: "CHANGE_ME_IN_TEST_ENV",
} as const;

// Vars that must NEVER fall back to a hardcoded value, even a fake-looking
// one, because a real value is required for the app/tests to behave
// meaningfully (a real DB, a JWT secret whose length actually matters for
// signing, a Stellar secret key whose format is validated and used to
// derive a real keypair). Missing one of these in test mode is a config
// error, not something to paper over — loadConfig throws a clear message
// naming exactly which var(s) are missing (#475). See .env.test.example.
const REQUIRED_IN_TEST_MODE = [
  "DATABASE_URL",
  "JWT_SECRET",
  "STELLAR_PLATFORM_SECRET",
] as const;

function loadConfig(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    if (process.env.NODE_ENV === "test") {
      const missingRequired = REQUIRED_IN_TEST_MODE.filter(
        (key) => !process.env[key],
      );
      if (missingRequired.length > 0) {
        throw new Error(
          `Missing required test environment variable(s): ${missingRequired.join(", ")}. ` +
            "No hardcoded fallback is used for these, even in test mode, so tests never " +
            "silently run against a fake-but-real-looking secret. Copy the matching " +
            "entries from .env.test.example into your local .env with real test values.",
        );
      }

      // In test mode, warn but don't exit — tests mock what they need.
      // Merge with process.env so CI-provided values (DATABASE_URL, REDIS_URL, etc.)
      // are preserved; only non-critical vars get obviously-fake test defaults.
      // Every field is passed through from process.env (populated above by
      // real environment variables, then .env.test, in that precedence)
      // consistently, not just the ones that happened to need a fallback —
      // config.NODE_ENV itself was previously dropped this way and silently
      // defaulted to "development", which meant logger.ts's test-mode branch
      // never actually activated during a test run.
      console.warn(
        "Missing env vars in test mode (expected if mocking config):",
        result.error.flatten().fieldErrors
      );
      return envSchema.parse({
        DATABASE_URL: process.env.DATABASE_URL,
        REDIS_URL: process.env.REDIS_URL || "redis://localhost:6379",
        CORS_ORIGINS: process.env.CORS_ORIGINS,
        JWT_SECRET: process.env.JWT_SECRET,
        STELLAR_HORIZON_URL:
          process.env.STELLAR_HORIZON_URL ||
          TEST_MODE_NON_SECRET_DEFAULTS.STELLAR_HORIZON_URL,
        STELLAR_SOROBAN_RPC_URL:
          process.env.STELLAR_SOROBAN_RPC_URL ||
          TEST_MODE_NON_SECRET_DEFAULTS.STELLAR_SOROBAN_RPC_URL,
        STELLAR_PLATFORM_SECRET: process.env.STELLAR_PLATFORM_SECRET,
        STELLAR_QUIZ_CONTRACT_ID:
          process.env.STELLAR_QUIZ_CONTRACT_ID ||
          TEST_MODE_NON_SECRET_DEFAULTS.STELLAR_QUIZ_CONTRACT_ID,
        STELLAR_REWARD_CONTRACT_ID:
          process.env.STELLAR_REWARD_CONTRACT_ID ||
          TEST_MODE_NON_SECRET_DEFAULTS.STELLAR_REWARD_CONTRACT_ID,
        STELLAR_CREDENTIAL_CONTRACT_ID:
          process.env.STELLAR_CREDENTIAL_CONTRACT_ID ||
          TEST_MODE_NON_SECRET_DEFAULTS.STELLAR_CREDENTIAL_CONTRACT_ID,
        REQUEST_BODY_LIMIT_BYTES: process.env.REQUEST_BODY_LIMIT_BYTES,
        MULTIPART_BODY_LIMIT_BYTES: process.env.MULTIPART_BODY_LIMIT_BYTES,
        AVATAR_UPLOAD_MAX_BYTES: process.env.AVATAR_UPLOAD_MAX_BYTES,
        AVATAR_UPLOAD_DIR: process.env.AVATAR_UPLOAD_DIR,
        PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: process.env.DATABASE_URL || TEST_FALLBACKS.DATABASE_URL,
        JWT_SECRET: process.env.JWT_SECRET || TEST_FALLBACKS.JWT_SECRET,
        STELLAR_HORIZON_URL: process.env.STELLAR_HORIZON_URL || TEST_FALLBACKS.STELLAR_HORIZON_URL,
        STELLAR_SOROBAN_RPC_URL: process.env.STELLAR_SOROBAN_RPC_URL || TEST_FALLBACKS.STELLAR_SOROBAN_RPC_URL,
        STELLAR_PLATFORM_SECRET: process.env.STELLAR_PLATFORM_SECRET || TEST_FALLBACKS.STELLAR_PLATFORM_SECRET,
        STELLAR_QUIZ_CONTRACT_ID: process.env.STELLAR_QUIZ_CONTRACT_ID || TEST_FALLBACKS.STELLAR_QUIZ_CONTRACT_ID,
        STELLAR_REWARD_CONTRACT_ID: process.env.STELLAR_REWARD_CONTRACT_ID || TEST_FALLBACKS.STELLAR_REWARD_CONTRACT_ID,
        STELLAR_CREDENTIAL_CONTRACT_ID:
          process.env.STELLAR_CREDENTIAL_CONTRACT_ID || TEST_FALLBACKS.STELLAR_CREDENTIAL_CONTRACT_ID,
      });
    }
    console.error(
      "Invalid environment variables:",
      result.error.flatten().fieldErrors
    );
    process.exit(1);
  }
  return result.data;
}

function ensureConfig(): Env {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

// Eagerly load config at module import time to preserve type safety
// (test-mode fallback is handled in loadConfig())
export const config: Env = ensureConfig();

/**
 * Resolved CORS allow-list passed to @fastify/cors.
 *
 * When CORS_ORIGINS is set it wins outright. Otherwise this falls back to the
 * exact per-environment defaults the server used before CORS_ORIGINS existed —
 * chainlearn.io in production, localhost:3000 everywhere else — so an unset
 * CORS_ORIGINS is a no-op change in behavior.
 */
export const corsOrigins: string[] =
  config.CORS_ORIGINS && config.CORS_ORIGINS.length > 0
    ? config.CORS_ORIGINS
    : config.NODE_ENV === "production"
      ? ["https://chainlearn.io"]
      : ["http://localhost:3000"];
