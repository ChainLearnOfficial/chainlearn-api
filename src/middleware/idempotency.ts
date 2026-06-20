import crypto from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { db } from "../config/database.js";
import { idempotencyKeys } from "../database/schema.js";
import { ConflictError } from "../utils/errors.js";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 250;
const MAX_WAIT_MS = 30_000;

export interface IdempotencyRecord {
  key: string;
  userId: string;
  endpoint: string;
  requestHash: string;
  responseStatus: number | null;
  responseBody: unknown | null;
  txHash: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface IdempotencyReservation {
  state: "new" | "cached" | "resume";
  record: IdempotencyRecord;
}

type RawIdempotencyRow = typeof idempotencyKeys.$inferSelect;

export function hashRequestBody(requestBody: unknown): string {
  return crypto
    .createHash("sha256")
    .update(stableStringify(requestBody))
    .digest("hex");
}

export async function reserveIdempotencyKey(options: {
  key: string;
  userId: string;
  endpoint: string;
  requestBody: unknown;
}): Promise<IdempotencyReservation> {
  const key = options.key.trim();
  const requestHash = hashRequestBody(options.requestBody);

  while (true) {
    const existing = await loadIdempotencyKey(key);
    if (existing) {
      if (existing.expiresAt.getTime() <= Date.now()) {
        await deleteIdempotencyKey(key);
        continue;
      }

      assertIdempotencyOwnership(existing, options.userId, options.endpoint);

      if (existing.requestHash !== requestHash) {
        throw new ConflictError(
          "Idempotency key reused with different request body"
        );
      }

      if (existing.responseStatus !== null && existing.responseBody !== null) {
        return { state: "cached", record: existing };
      }

      if (existing.txHash !== null) {
        return { state: "resume", record: existing };
      }

      const deadline = Date.now() + MAX_WAIT_MS;
      while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        const latest = await loadIdempotencyKey(key);
        if (!latest) {
          break;
        }

        assertIdempotencyOwnership(latest, options.userId, options.endpoint);

        if (latest.requestHash !== requestHash) {
          throw new ConflictError(
            "Idempotency key reused with different request body"
          );
        }

        if (latest.responseStatus !== null && latest.responseBody !== null) {
          return { state: "cached", record: latest };
        }

        if (latest.txHash !== null) {
          return { state: "resume", record: latest };
        }
      }

      throw new ConflictError("Idempotency key is already being processed");
    }

    try {
      await db.insert(idempotencyKeys).values({
        key,
        userId: options.userId,
        endpoint: options.endpoint,
        requestHash,
        expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
      });

      const record = await loadIdempotencyKey(key);
      if (!record) {
        throw new Error("Failed to persist idempotency key");
      }

      return { state: "new", record };
    } catch (err) {
      if (isUniqueViolation(err)) {
        continue;
      }

      throw err;
    }
  }
}

export async function storeIdempotencyTxHash(
  key: string,
  txHash: string
): Promise<void> {
  await db
    .update(idempotencyKeys)
    .set({ txHash })
    .where(eq(idempotencyKeys.key, key));
}

export async function storeIdempotentResponse(
  key: string,
  status: number,
  body: unknown
): Promise<void> {
  await db
    .update(idempotencyKeys)
    .set({
      responseStatus: status,
      responseBody: body,
    })
    .where(eq(idempotencyKeys.key, key));
}

export async function deleteIdempotencyKey(key: string): Promise<void> {
  await db.delete(idempotencyKeys).where(eq(idempotencyKeys.key, key));
}

export async function cleanupExpiredIdempotencyKeys(): Promise<number> {
  const removed = await db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.expiresAt, new Date()))
    .returning({ key: idempotencyKeys.key });

  return removed.length;
}

function assertIdempotencyOwnership(
  record: IdempotencyRecord,
  userId: string,
  endpoint: string
): void {
  if (record.userId !== userId || record.endpoint !== endpoint) {
    throw new ConflictError(
      "Idempotency key is already associated with a different request"
    );
  }
}

async function loadIdempotencyKey(
  key: string
): Promise<IdempotencyRecord | null> {
  const row = await db.query.idempotencyKeys.findFirst({
    where: eq(idempotencyKeys.key, key),
  });

  return row ? mapRow(row) : null;
}

function mapRow(row: RawIdempotencyRow): IdempotencyRecord {
  return {
    key: row.key,
    userId: row.userId,
    endpoint: row.endpoint,
    requestHash: row.requestHash,
    responseStatus: row.responseStatus,
    responseBody: row.responseBody,
    txHash: row.txHash,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

function stableStringify(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entryKey, entryValue]) => {
      return `${JSON.stringify(entryKey)}:${stableStringify(entryValue)}`;
    });

  return `{${entries.join(",")}}`;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23505"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}