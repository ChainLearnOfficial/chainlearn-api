import { z } from "zod";
import "dotenv/config";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),

  // Database
  DATABASE_URL: z.string().url(),

  // Redis
  REDIS_URL: z.string().default("redis://localhost:6379"),

  // JWT
  JWT_SECRET: z.string().min(32),

  // Stellar
  STELLAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  STELLAR_HORIZON_URL: z.string().url(),
  STELLAR_SOROBAN_RPC_URL: z.string().url(),
  STELLAR_PLATFORM_SECRET: z.string().min(1),
  STELLAR_QUIZ_CONTRACT_ID: z.string().min(1),
  STELLAR_REWARD_CONTRACT_ID: z.string().min(1),
  STELLAR_CREDENTIAL_CONTRACT_ID: z.string().min(1),

  // Rate limiting
  RATE_LIMIT_MAX: z.coerce.number().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
});

export type Env = z.infer<typeof envSchema>;

let _config: Env | null = null;

function loadConfig(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    if (process.env.NODE_ENV === "test") {
      // In test mode, warn but don't exit — tests mock what they need
      console.warn(
        "Missing env vars in test mode (expected if mocking config):",
        result.error.flatten().fieldErrors
      );
      return envSchema.parse({
        DATABASE_URL: "postgresql://localhost:5432/test",
        JWT_SECRET: "test-secret-key-that-is-at-least-64-characters-long",
        STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
        STELLAR_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
        STELLAR_PLATFORM_SECRET: "test",
        STELLAR_QUIZ_CONTRACT_ID: "test",
        STELLAR_REWARD_CONTRACT_ID: "test",
        STELLAR_CREDENTIAL_CONTRACT_ID: "test",
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

// Lazy config — loadConfig() only runs on first property access, not at import time
export const config: Env = new Proxy({} as Env, {
  get(_, prop) {
    return (ensureConfig() as any)[prop];
  },
});
