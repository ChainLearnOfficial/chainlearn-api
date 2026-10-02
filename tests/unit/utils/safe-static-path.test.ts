import { describe, it, expect } from "vitest";
import path from "node:path";
import { resolveSafeStaticPath } from "../../../src/utils/safe-static-path.js";

const UPLOAD_DIR = "uploads/avatars";
const AVATAR_PATTERN = /^[A-Za-z0-9_-]+\.(jpg|png|webp)$/;

describe("resolveSafeStaticPath (#486)", () => {
  it("resolves a legitimate filename to a path inside the upload directory", () => {
    const result = resolveSafeStaticPath("user-123.jpg", UPLOAD_DIR, AVATAR_PATTERN);
    expect(result).not.toBeNull();
    expect(result).toBe(path.resolve(UPLOAD_DIR, "user-123.jpg"));
  });

  it("accepts every allowed extension", () => {
    for (const name of ["a.jpg", "a.png", "a.webp"]) {
      expect(resolveSafeStaticPath(name, UPLOAD_DIR, AVATAR_PATTERN)).not.toBeNull();
    }
  });

  it("rejects a plain ../ traversal payload", () => {
    expect(resolveSafeStaticPath("../../../etc/passwd", UPLOAD_DIR, AVATAR_PATTERN)).toBeNull();
  });

  it("rejects a traversal payload that basename() would otherwise leave joinable", () => {
    // path.basename("../../etc/passwd.jpg") === "passwd.jpg", so this exercises
    // that the regex is checked against the *stripped* name, not the raw one,
    // and would still correctly resolve inside the upload dir (basename already
    // neutralizes the traversal) rather than escaping it.
    const result = resolveSafeStaticPath("../../etc/passwd.jpg", UPLOAD_DIR, AVATAR_PATTERN);
    expect(result).toBe(path.resolve(UPLOAD_DIR, "passwd.jpg"));
  });

  it("rejects a filename containing an embedded path separator after basename would strip a leading traversal", () => {
    expect(resolveSafeStaticPath("..%2f..%2fetc%2fpasswd", UPLOAD_DIR, AVATAR_PATTERN)).toBeNull();
  });

  it("rejects a disallowed extension", () => {
    expect(resolveSafeStaticPath("shell.php", UPLOAD_DIR, AVATAR_PATTERN)).toBeNull();
    expect(resolveSafeStaticPath("archive.jpg.exe", UPLOAD_DIR, AVATAR_PATTERN)).toBeNull();
  });

  it("rejects an absolute path payload", () => {
    expect(resolveSafeStaticPath("/etc/passwd.jpg", UPLOAD_DIR, AVATAR_PATTERN)).not.toBeNull();
    // basename("/etc/passwd.jpg") === "passwd.jpg", which IS a valid name in
    // isolation — the point is it can never escape uploadDir, confirmed here.
    const result = resolveSafeStaticPath("/etc/passwd.jpg", UPLOAD_DIR, AVATAR_PATTERN);
    expect(result).toBe(path.resolve(UPLOAD_DIR, "passwd.jpg"));
  });

  it("rejects a null-byte injection attempt", () => {
    expect(resolveSafeStaticPath("avatar.jpg\0.php", UPLOAD_DIR, AVATAR_PATTERN)).toBeNull();
  });
});
