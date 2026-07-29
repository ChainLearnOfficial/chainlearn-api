import { db } from "../config/database.js";
import { idempotencyKeys } from "../database/schema.js";
import { eq, and, lt } from "drizzle-orm";
import { sha256Hash } from "../utils/crypto.js";
import { ConflictError } from "../utils/errors.js";

export async function checkIdempotency(
  key: string,
  userId: string,
  endpoint: string,
  requestBody: unknown
): Promise<{ cached: boolean; response?: { status: number; body: unknown } }> {
  const requestHash = sha256Hash(JSON.stringify(requestBody));

  // Scope lookup to userId AND endpoint so the same key value used by two
  // different users (or at two different endpoints) never returns a cached
  // response from the wrong context — closes #227.
  const existing = await db.query.idempotencyKeys.findFirst({
    where: and(
      eq(idempotencyKeys.key, key),
      eq(idempotencyKeys.userId, userId),
      eq(idempotencyKeys.endpoint, endpoint),
    ),
  });

  if (existing) {
    if (existing.requestHash === requestHash && existing.responseBody) {
      return {
        cached: true,
        response: {
          status: existing.responseStatus ?? 200,
          body: existing.responseBody,
        },
      };
    }
    throw new ConflictError("Idempotency key reused with different request body");
  }

  try {
    await db.insert(idempotencyKeys).values({
      key,
      userId,
      endpoint,
      requestHash,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
  } catch (err: unknown) {
    // Two concurrent requests can both pass the findFirst check above and
    // both reach this insert — the loser hits a unique-constraint violation
    // instead of a clean row insert. Recovering here (rather than letting
    // it propagate as a raw 500) closes that race — see #106.
    const isUniqueViolation =
      (err as { code?: string })?.code === "23505" ||
      (err instanceof Error &&
        (err.message.includes("unique constraint") ||
          err.message.includes("duplicate key") ||
          err.message.includes("idempotency_keys")));

    if (isUniqueViolation) {
      const concurrentRecord = await db.query.idempotencyKeys.findFirst({
        where: and(
          eq(idempotencyKeys.key, key),
          eq(idempotencyKeys.userId, userId),
          eq(idempotencyKeys.endpoint, endpoint),
        ),
      });

      if (
        concurrentRecord &&
        concurrentRecord.requestHash === requestHash &&
        concurrentRecord.responseBody
      ) {
        return {
          cached: true,
          response: {
            status: concurrentRecord.responseStatus ?? 200,
            body: concurrentRecord.responseBody,
          },
        };
      }

      throw new ConflictError(
        "Idempotency key reused with different request body"
      );
    }

    throw err;
  }

  return { cached: false };
}

export async function storeIdempotentResponse(
  key: string,
  status: number,
  body: unknown,
  txHash?: string
): Promise<void> {
  await db
    .update(idempotencyKeys)
    .set({
      responseStatus: status,
      responseBody: body,
      txHash: txHash ?? null,
    })
    .where(eq(idempotencyKeys.key, key));
}

export async function cleanupIdempotencyKeys(): Promise<number> {
  const result = await db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.expiresAt, new Date()))
    .returning({ key: idempotencyKeys.key });

  return result.length;
}
