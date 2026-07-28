import { describe, it, expect, vi, beforeEach } from "vitest";
import { ZodError } from "zod";

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../../src/config/index.js", () => ({
  config: { NODE_ENV: "test" },
}));

import { registerErrorHandler } from "../../../src/middleware/error-handler.js";
import { AppError, ValidationError } from "../../../src/utils/errors.js";

describe("Error Handler Middleware", () => {
  let mockApp: any;
  let errorHandler: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApp = {
      setErrorHandler: vi.fn((handler) => {
        errorHandler = handler;
      }),
    };
    registerErrorHandler(mockApp);
  });

  it("should register error handler", () => {
    expect(mockApp.setErrorHandler).toHaveBeenCalledWith(expect.any(Function));
  });

  it("should handle ZodError", async () => {
    const zodError = new ZodError([
      { code: "invalid_type", expected: "string", received: "number", path: ["name"], message: "Expected string" },
    ]);
    const mockRequest: any = {};
    const mockReply: any = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };

    errorHandler(zodError, mockRequest, mockReply);

    expect(mockReply.status).toHaveBeenCalledWith(400);
    expect(mockReply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        error: "Validation Error",
      })
    );
  });

  it("should handle AppError", async () => {
    const appError = new AppError("Resource not found", 404, "NOT_FOUND");
    const mockRequest: any = {};
    const mockReply: any = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };

    errorHandler(appError, mockRequest, mockReply);

    expect(mockReply.status).toHaveBeenCalledWith(404);
    expect(mockReply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        error: "NOT_FOUND",
        message: "Resource not found",
      })
    );
  });

  it("should handle generic Error", async () => {
    const error = new Error("Something went wrong");
    const mockRequest: any = { url: "/test", method: "GET" };
    const mockReply: any = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };

    errorHandler(error, mockRequest, mockReply);

    expect(mockReply.status).toHaveBeenCalledWith(500);
    expect(mockReply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 500,
        error: "INTERNAL_ERROR",
      })
    );
  });
});
