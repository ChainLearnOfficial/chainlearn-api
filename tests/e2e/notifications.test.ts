import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/server.js";
import { db } from "../../src/config/database.js";
import { users, notifications } from "../../src/database/schema.js";

describe("Notifications API (#619)", () => {
  let app: FastifyInstance;

  const userId = "e1a2d3e4-1111-4ef8-bb6d-6bb9bd380c99";
  const userStellarAddress =
    "GNOTIFYUSER00000000000000000000000000000000000000000000";
  const otherUserId = "e1a2d3e4-2222-4ef8-bb6d-6bb9bd380c98";
  const otherUserStellarAddress =
    "GNOTIFYOTHER0000000000000000000000000000000000000000000";

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    await db
      .insert(users)
      .values({
        id: userId,
        stellarAddress: userStellarAddress,
        displayName: "Notify User",
        isAdmin: false,
      })
      .onConflictDoNothing();

    await db
      .insert(users)
      .values({
        id: otherUserId,
        stellarAddress: otherUserStellarAddress,
        displayName: "Other Notify User",
        isAdmin: false,
      })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(users).where(eq(users.id, otherUserId));
    await app.close();
  });

  // Every notification row this file creates is cleared before each test,
  // so list/count/unread-count assertions never see leftovers from a
  // previous test in this same file.
  beforeEach(async () => {
    await db.delete(notifications).where(eq(notifications.userId, userId));
    await db.delete(notifications).where(eq(notifications.userId, otherUserId));
  });

  const token = () =>
    app.jwt.sign({ sub: userId, stellarAddress: userStellarAddress });

  const otherToken = () =>
    app.jwt.sign({ sub: otherUserId, stellarAddress: otherUserStellarAddress });

  async function seedNotification(
    targetUserId: string,
    overrides: Partial<{ type: string; title: string; message: string; read: boolean }> = {},
  ): Promise<string> {
    const [row] = await db
      .insert(notifications)
      .values({
        userId: targetUserId,
        type: overrides.type ?? "badge_earned",
        title: overrides.title ?? "You earned a badge!",
        message: overrides.message ?? "Congratulations on your progress.",
        read: overrides.read ?? false,
      })
      .returning({ id: notifications.id });
    return row.id;
  }

  describe("GET /api/v1/users/me/notifications", () => {
    it("should reject unauthenticated requests", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/users/me/notifications",
      });

      expect(response.statusCode).toBe(401);
    });

    it("should return an empty page with unreadCount 0 for a user with no notifications", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/users/me/notifications",
        headers: { authorization: `Bearer ${token()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
      expect(body.data).toEqual([]);
      expect(body.pagination.total).toBe(0);
      expect(body.unreadCount).toBe(0);
    });

    it("should list the authenticated user's notifications, newest first", async () => {
      const firstId = await seedNotification(userId, { title: "First" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const secondId = await seedNotification(userId, { title: "Second" });

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/users/me/notifications",
        headers: { authorization: `Bearer ${token()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data).toHaveLength(2);
      expect(body.data[0].id).toBe(secondId);
      expect(body.data[1].id).toBe(firstId);
      expect(body.pagination.total).toBe(2);
    });

    it("should only return the authenticated user's own notifications, never another user's", async () => {
      await seedNotification(userId, { title: "Mine" });
      await seedNotification(otherUserId, { title: "Not mine" });

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/users/me/notifications",
        headers: { authorization: `Bearer ${token()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].title).toBe("Mine");
    });

    it("should report unreadCount independent of the current page", async () => {
      await seedNotification(userId, { read: true });
      await seedNotification(userId, { read: false });
      await seedNotification(userId, { read: false });

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/users/me/notifications?page=1&limit=1",
        headers: { authorization: `Bearer ${token()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data).toHaveLength(1);
      expect(body.pagination.total).toBe(3);
      expect(body.unreadCount).toBe(2);
    });

    it("should respect page and limit query params", async () => {
      for (let i = 0; i < 3; i++) {
        await seedNotification(userId, { title: `Notification ${i}` });
      }

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/users/me/notifications?page=2&limit=2",
        headers: { authorization: `Bearer ${token()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data).toHaveLength(1);
      expect(body.pagination.page).toBe(2);
      expect(body.pagination.limit).toBe(2);
    });

    it("should reject invalid limit values", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/users/me/notifications?limit=0",
        headers: { authorization: `Bearer ${token()}` },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("PUT /api/v1/users/me/notifications/:id/read", () => {
    it("should reject unauthenticated requests", async () => {
      const id = await seedNotification(userId);

      const response = await app.inject({
        method: "PUT",
        url: `/api/v1/users/me/notifications/${id}/read`,
      });

      expect(response.statusCode).toBe(401);
    });

    it("should mark a single notification as read", async () => {
      const id = await seedNotification(userId, { read: false });

      const response = await app.inject({
        method: "PUT",
        url: `/api/v1/users/me/notifications/${id}/read`,
        headers: { authorization: `Bearer ${token()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe(id);
      expect(body.data.read).toBe(true);

      const [row] = await db
        .select()
        .from(notifications)
        .where(eq(notifications.id, id));
      expect(row?.read).toBe(true);
    });

    it("should 404 when marking another user's notification as read", async () => {
      const otherNotificationId = await seedNotification(otherUserId);

      const response = await app.inject({
        method: "PUT",
        url: `/api/v1/users/me/notifications/${otherNotificationId}/read`,
        headers: { authorization: `Bearer ${token()}` },
      });

      expect(response.statusCode).toBe(404);

      // Confirm it genuinely wasn't touched, not just that the response hid it.
      const [row] = await db
        .select()
        .from(notifications)
        .where(eq(notifications.id, otherNotificationId));
      expect(row?.read).toBe(false);
    });

    it("should 404 for a non-existent notification id", async () => {
      const response = await app.inject({
        method: "PUT",
        url: "/api/v1/users/me/notifications/00000000-0000-0000-0000-000000000000/read",
        headers: { authorization: `Bearer ${token()}` },
      });

      expect(response.statusCode).toBe(404);
    });

    it("should reject a malformed notification id", async () => {
      const response = await app.inject({
        method: "PUT",
        url: "/api/v1/users/me/notifications/not-a-uuid/read",
        headers: { authorization: `Bearer ${token()}` },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("PUT /api/v1/users/me/notifications/read-all", () => {
    it("should reject unauthenticated requests", async () => {
      const response = await app.inject({
        method: "PUT",
        url: "/api/v1/users/me/notifications/read-all",
      });

      expect(response.statusCode).toBe(401);
    });

    it("should mark every unread notification as read and report the count", async () => {
      await seedNotification(userId, { read: false });
      await seedNotification(userId, { read: false });
      await seedNotification(userId, { read: true });

      const response = await app.inject({
        method: "PUT",
        url: "/api/v1/users/me/notifications/read-all",
        headers: { authorization: `Bearer ${token()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
      expect(body.data.count).toBe(2);

      const unreadResponse = await app.inject({
        method: "GET",
        url: "/api/v1/users/me/notifications",
        headers: { authorization: `Bearer ${token()}` },
      });
      expect(JSON.parse(unreadResponse.payload).unreadCount).toBe(0);
    });

    it("should only affect the authenticated user's own notifications", async () => {
      await seedNotification(userId, { read: false });
      await seedNotification(otherUserId, { read: false });

      await app.inject({
        method: "PUT",
        url: "/api/v1/users/me/notifications/read-all",
        headers: { authorization: `Bearer ${token()}` },
      });

      const otherResponse = await app.inject({
        method: "GET",
        url: "/api/v1/users/me/notifications",
        headers: { authorization: `Bearer ${otherToken()}` },
      });
      expect(JSON.parse(otherResponse.payload).unreadCount).toBe(1);
    });

    it("should return count 0 when there are no unread notifications", async () => {
      const response = await app.inject({
        method: "PUT",
        url: "/api/v1/users/me/notifications/read-all",
        headers: { authorization: `Bearer ${token()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data.count).toBe(0);
    });
  });
});
