import { describe, it, expect } from "vitest";

import {
  createCourseSchema,
  updateCourseSchema,
  createModuleSchema,
  updateModuleSchema,
  courseModuleSchema,
  importCourseSchema,
  draftCourseSchema,
} from "../../../src/modules/courses/course.types.js";
import { createAnnouncementSchema, updateAnnouncementSchema } from "../../../src/modules/announcements/announcement.types.js";
import { createBadgeSchema, updateBadgeSchema } from "../../../src/modules/badges/badge.types.js";

const XSS = '<img src=x onerror="alert(1)">Evil<script>alert(2)</script>';
const CLEAN = "Evil";

describe("HTML sanitization on write (#478)", () => {
  it("strips markup from course title/description on create", () => {
    const result = createCourseSchema.parse({ title: XSS, description: XSS });
    expect(result.title).toBe(CLEAN);
    expect(result.description).toBe(CLEAN);
  });

  it("strips markup from course title/description on update", () => {
    const result = updateCourseSchema.parse({ title: XSS, description: XSS });
    expect(result.title).toBe(CLEAN);
    expect(result.description).toBe(CLEAN);
  });

  it("leaves clean input unchanged", () => {
    const result = createCourseSchema.parse({ title: "Intro to Stellar", description: "A great course." });
    expect(result.title).toBe("Intro to Stellar");
    expect(result.description).toBe("A great course.");
  });

  it("strips markup from a course module (courseModules array entry)", () => {
    const result = courseModuleSchema.parse({ id: "m1", title: XSS, description: XSS });
    expect(result.title).toBe(CLEAN);
    expect(result.description).toBe(CLEAN);
  });

  it("strips markup from module create/update", () => {
    const created = createModuleSchema.parse({ title: XSS, description: XSS });
    expect(created.title).toBe(CLEAN);
    expect(created.description).toBe(CLEAN);

    const updated = updateModuleSchema.parse({ title: XSS });
    expect(updated.title).toBe(CLEAN);
  });

  it("strips markup from imported courses and their inline modules", () => {
    const result = importCourseSchema.parse({
      title: XSS,
      description: XSS,
      modules: [{ title: XSS, description: XSS }],
    });
    expect(result.title).toBe(CLEAN);
    expect(result.description).toBe(CLEAN);
    expect(result.modules[0].title).toBe(CLEAN);
    expect(result.modules[0].description).toBe(CLEAN);
  });

  it("strips markup from a draft course", () => {
    const result = draftCourseSchema.parse({ title: XSS });
    expect(result.title).toBe(CLEAN);
  });

  it("strips markup from announcement title/message", () => {
    const created = createAnnouncementSchema.parse({ title: XSS, message: XSS });
    expect(created.title).toBe(CLEAN);
    expect(created.message).toBe(CLEAN);

    const updated = updateAnnouncementSchema.parse({ title: XSS });
    expect(updated.title).toBe(CLEAN);
  });

  it("strips markup from badge name/description", () => {
    const created = createBadgeSchema.parse({
      name: XSS,
      description: XSS,
      iconUrl: "https://example.com/icon.svg",
      type: "enrollment",
      criteria: {},
    });
    expect(created.name).toBe(CLEAN);
    expect(created.description).toBe(CLEAN);

    const updated = updateBadgeSchema.parse({ name: XSS });
    expect(updated.name).toBe(CLEAN);
  });
});
