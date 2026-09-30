import { eq, sql } from "drizzle-orm";
import { db } from "../../config/database.js";
import { users } from "../../database/schema.js";
import { NotFoundError, ValidationError } from "../../utils/errors.js";
import { auditLog } from "../../audit/index.js";
import { cacheDel, cacheKey } from "../../cache/index.js";
import type { CreditAdjustmentResult } from "./admin-users.types.js";

export class AdminUsersService {
  /**
   * Atomically deduct credits from a user's balance.
   *
   * ## Why this is race-condition-free
   *
   * A naive implementation would:
   *   1. SELECT credits FROM users WHERE id = ?          -- read
   *   2. if (credits < amount) throw ValidationError     -- check
   *   3. UPDATE users SET credits = credits - amount     -- write
   *
   * Between steps 1 and 3 any concurrent reward claim or admin grant can
   * change the balance, so two concurrent deductions of 80 against a balance
   * of 100 could both pass the check and produce -60. This is the classic
   * TOCTOU (Time-Of-Check-Time-Of-Use) race condition.
   *
   * This implementation collapses the check and write into a single atomic
   * UPDATE statement:
   *
   *   UPDATE users
   *   SET    credits = credits - amount
   *   WHERE  id = ?
   *   AND    credits >= amount     ← balance check is inside the same statement
   *   RETURNING id, credits
   *
   * PostgreSQL evaluates the WHERE clause and applies the SET in the same row
   * lock, so no concurrent transaction can slip a write in between. If the
   * balance is insufficient the WHERE clause matches zero rows and `updated`
   * is undefined — we can then distinguish "user not found" from "insufficient
   * balance" with a second lightweight EXISTS check.
   */
  async deductCredits(
    userId: string,
    amount: number,
    reason: string,
    adminNote?: string,
  ): Promise<CreditAdjustmentResult> {
    const [updated] = await db
      .update(users)
      .set({
        credits: sql`${users.credits} - ${amount}`,
        updatedAt: new Date(),
      })
      .where(
        sql`${users.id} = ${userId}
            AND ${users.credits} >= ${amount}`,
      )
      .returning({ id: users.id, credits: users.credits });

    if (!updated) {
      // Distinguish "user doesn't exist" from "insufficient balance" so the
      // caller gets the correct HTTP status (404 vs 422).
      const exists = await db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { id: true },
      });

      if (!exists) {
        throw new NotFoundError("User");
      }

      // User exists but the WHERE credits >= amount condition failed.
      throw new ValidationError({
        amount: [
          "Insufficient credits: user does not have enough credits for this deduction",
        ],
      });
    }

    const newCredits = updated.credits;
    const previousCredits = newCredits + amount;

    auditLog("admin.credits.deducted", {
      userId,
      amount,
      previousCredits,
      newCredits,
      reason,
      ...(adminNote ? { adminNote } : {}),
    });

    await cacheDel(cacheKey("user", "profile", userId));
    await cacheDel(cacheKey("user", "progress", userId));

    return { userId, previousCredits, newCredits, delta: -amount };
  }

  /**
   * Atomically grant credits to a user's balance.
   *
   * Uses `credits + amount` unconditionally — there is no upper bound today,
   * so the only safety requirement is that the user actually exists. The
   * returning clause gives us the new balance in the same round-trip,
   * letting us derive previousCredits without a pre-read.
   */
  async grantCredits(
    userId: string,
    amount: number,
    reason: string,
    adminNote?: string,
  ): Promise<CreditAdjustmentResult> {
    const [updated] = await db
      .update(users)
      .set({
        credits: sql`${users.credits} + ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning({ id: users.id, credits: users.credits });

    if (!updated) {
      throw new NotFoundError("User");
    }

    const newCredits = updated.credits;
    const previousCredits = newCredits - amount;

    auditLog("admin.credits.granted", {
      userId,
      amount,
      previousCredits,
      newCredits,
      reason,
      ...(adminNote ? { adminNote } : {}),
    });

    await cacheDel(cacheKey("user", "profile", userId));
    await cacheDel(cacheKey("user", "progress", userId));

    return { userId, previousCredits, newCredits, delta: amount };
  }
}

export const adminUsersService = new AdminUsersService();
