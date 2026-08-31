import { z } from "zod";
import "dotenv/config";

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

let _config: Env | null = null;

function loadConfig(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    if (process.env.NODE_ENV === "test") {
      // In test mode, warn but don't exit — tests mock what they need.
      // Merge with process.env so CI-provided values (DATABASE_URL, REDIS_URL, etc.)
      // are preserved; only truly missing vars get test defaults.
      console.warn(
        "Missing env vars in test mode (expected if mocking config):",
        result.error.flatten().fieldErrors
      );
      return envSchema.parse({
        DATABASE_URL: process.env.DATABASE_URL || "postgresql://chainlearn_test:test_password@localhost:5432/chainlearn_test",
        REDIS_URL: process.env.REDIS_URL || "redis://localhost:6379",
        CORS_ORIGINS: process.env.CORS_ORIGINS,
        JWT_SECRET:
          process.env.JWT_SECRET || "test-secret-key-that-is-at-least-sixty-four-characters-long-for-tests",
        STELLAR_HORIZON_URL: process.env.STELLAR_HORIZON_URL || "https://horizon-testnet.stellar.org",
        STELLAR_SOROBAN_RPC_URL: process.env.STELLAR_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org",
        STELLAR_PLATFORM_SECRET: process.env.STELLAR_PLATFORM_SECRET || "test",
        STELLAR_QUIZ_CONTRACT_ID: process.env.STELLAR_QUIZ_CONTRACT_ID || "test",
        STELLAR_REWARD_CONTRACT_ID: process.env.STELLAR_REWARD_CONTRACT_ID || "test",
        STELLAR_CREDENTIAL_CONTRACT_ID: process.env.STELLAR_CREDENTIAL_CONTRACT_ID || "test",
        REQUEST_BODY_LIMIT_BYTES: process.env.REQUEST_BODY_LIMIT_BYTES,
        MULTIPART_BODY_LIMIT_BYTES: process.env.MULTIPART_BODY_LIMIT_BYTES,
        AVATAR_UPLOAD_MAX_BYTES: process.env.AVATAR_UPLOAD_MAX_BYTES,
        AVATAR_UPLOAD_DIR: process.env.AVATAR_UPLOAD_DIR,
        PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
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
