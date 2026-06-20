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

  // AI service
  AI_SERVICE_URL: z.string().url().default("http://localhost:8000"),

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

function loadConfig(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error(
      "Invalid environment variables:",
      result.error.flatten().fieldErrors
    );
    process.exit(1);
  }
  return result.data;
}

export const config = loadConfig();
