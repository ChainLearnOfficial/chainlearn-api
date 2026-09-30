/**
 * Opaque keyset-pagination cursors for large, newest-first collections
 * (#482). Offset pagination (`?page=3&limit=20`) makes Postgres scan and
 * discard every row before the offset, which gets slower the deeper a
 * client pages. A keyset cursor instead resumes with `WHERE (createdAt, id)
 * < (cursor.createdAt, cursor.id)`, served by the same
 * `(createdAt DESC, id)` index the query already sorts with, so it costs the
 * same regardless of how far a client has paged.
 *
 * The cursor encodes `(createdAt, id)`, not `id` alone: these tables sort by
 * `createdAt DESC`, and a v4 UUID's value has no relationship to when its
 * row was inserted, so an id-only cursor would silently resume at the wrong
 * point (or skip/repeat rows) whenever two pages' boundary rows don't share
 * a timestamp collision. `id` is only needed to break ties between rows
 * with an identical `createdAt`.
 */

export interface KeysetCursor {
  createdAt: Date;
  id: string;
}

/** Encode a row's (createdAt, id) into an opaque, URL-safe cursor string. */
export function encodeCursor(row: KeysetCursor): string {
  const payload = JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id });
  return Buffer.from(payload, "utf8").toString("base64url");
}

/** Decode a cursor produced by encodeCursor. Returns null for anything that
 *  isn't a validly-shaped cursor, rather than throwing, since this always
 *  originates from client-supplied query input. */
export function decodeCursor(cursor: string): KeysetCursor | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof decoded === "object" &&
      decoded !== null &&
      "createdAt" in decoded &&
      "id" in decoded &&
      typeof (decoded as { createdAt: unknown }).createdAt === "string" &&
      typeof (decoded as { id: unknown }).id === "string"
    ) {
      const createdAt = new Date((decoded as { createdAt: string }).createdAt);
      if (Number.isNaN(createdAt.getTime())) return null;
      return { createdAt, id: (decoded as { id: string }).id };
    }
    return null;
  } catch {
    return null;
  }
}
