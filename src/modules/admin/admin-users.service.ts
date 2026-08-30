import { and, count, desc, ilike, or } from "drizzle-orm";
import { db } from "../../config/database.js";
import { users } from "../../database/schema.js";
import type { AdminUserSummary, ListUsersQuery } from "./admin.types.js";

export class AdminUsersService {
  /**
   * Paginated user listing for the admin console (#288). Search matches
   * either stellarAddress or displayName (case-insensitive, partial match)
   * so admins can look a user up by whichever identifier they have on hand.
   */
  async listUsers(
    query: ListUsersQuery,
  ): Promise<{ users: AdminUserSummary[]; total: number }> {
    const search = query.search?.trim() || undefined;
    const conditions = search
      ? [
          or(
            ilike(users.stellarAddress, `%${search}%`),
            ilike(users.displayName, `%${search}%`),
          )!,
        ]
      : [];

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const offset = (query.page - 1) * query.limit;

    const [[totalResult], rows] = await Promise.all([
      db.select({ value: count() }).from(users).where(where),
      db
        .select()
        .from(users)
        .where(where)
        .orderBy(desc(users.createdAt))
        .limit(query.limit)
        .offset(offset),
    ]);

    return {
      users: rows.map((row) => ({
        id: row.id,
        stellarAddress: row.stellarAddress,
        displayName: row.displayName,
        isAdmin: row.isAdmin,
        credits: row.credits,
        createdAt: row.createdAt,
        deletedAt: row.deletedAt,
      })),
      total: totalResult?.value ?? 0,
    };
  }
}

export const adminUsersService = new AdminUsersService();
