import { and, count, desc, eq, gt, or, isNull } from "drizzle-orm";
import { db } from "../../config/database.js";
import { announcements } from "../../database/schema.js";
import { NotFoundError } from "../../utils/errors.js";
import { auditLog } from "../../audit/index.js";
import { logger } from "../../utils/logger.js";
import type {
  Announcement,
  AnnouncementsAdminPage,
  CreateAnnouncementBody,
  UpdateAnnouncementBody,
  ListAnnouncementsAdminQuery,
} from "./announcement.types.js";

export class AnnouncementService {
  private toAnnouncement(row: typeof announcements.$inferSelect): Announcement {
    return {
      id: row.id,
      title: row.title,
      message: row.message,
      priority: row.priority as Announcement["priority"],
      active: row.active,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  }

  /**
   * Active, unexpired announcements for the public feed (#353) —
   * `active = true` and either no expiry or one still in the future.
   */
  async listActive(): Promise<Announcement[]> {
    const rows = await db
      .select()
      .from(announcements)
      .where(
        and(
          eq(announcements.active, true),
          or(isNull(announcements.expiresAt), gt(announcements.expiresAt, new Date())),
        ),
      )
      .orderBy(desc(announcements.createdAt));

    return rows.map((row) => this.toAnnouncement(row));
  }

  /** Every announcement (active, inactive, and expired), paginated — for
   *  the admin console, which needs to see and manage the full set. */
  async listAll(query: ListAnnouncementsAdminQuery): Promise<AnnouncementsAdminPage> {
    const offset = (query.page - 1) * query.limit;

    const [[totalResult], rows] = await Promise.all([
      db.select({ value: count() }).from(announcements),
      db
        .select()
        .from(announcements)
        .orderBy(desc(announcements.createdAt))
        .limit(query.limit)
        .offset(offset),
    ]);

    return {
      announcements: rows.map((row) => this.toAnnouncement(row)),
      total: totalResult?.value ?? 0,
    };
  }

  async create(data: CreateAnnouncementBody): Promise<Announcement> {
    const [row] = await db
      .insert(announcements)
      .values({
        title: data.title,
        message: data.message,
        priority: data.priority,
        active: data.active,
        expiresAt: data.expiresAt,
      })
      .returning();

    await auditLog("announcement.created", {
      announcementId: row.id,
      priority: row.priority,
    });
    logger.info({ announcementId: row.id }, "Announcement created");

    return this.toAnnouncement(row);
  }

  async update(id: string, data: UpdateAnnouncementBody): Promise<Announcement> {
    const [row] = await db
      .update(announcements)
      .set(data)
      .where(eq(announcements.id, id))
      .returning();

    if (!row) {
      throw new NotFoundError("Announcement");
    }

    await auditLog("announcement.updated", { announcementId: id });
    logger.info({ announcementId: id }, "Announcement updated");

    return this.toAnnouncement(row);
  }

  async remove(id: string): Promise<void> {
    const [row] = await db
      .delete(announcements)
      .where(eq(announcements.id, id))
      .returning();

    if (!row) {
      throw new NotFoundError("Announcement");
    }

    await auditLog("announcement.deleted", { announcementId: id });
    logger.info({ announcementId: id }, "Announcement deleted");
  }
}

export const announcementService = new AnnouncementService();
