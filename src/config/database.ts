import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "./index.js";
import * as schema from "../database/schema.js";

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  console.error("Unexpected PG pool error:", err);
});

export { pool };
export const db = drizzle(pool, { schema });

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
