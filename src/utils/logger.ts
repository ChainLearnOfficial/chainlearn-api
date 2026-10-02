import pino from "pino";
import { config } from "../config/index.js";
import { getRequestId } from "./request-context.js";

export const logger = pino({
  level:
    config.NODE_ENV === "production"
      ? "info"
      : config.NODE_ENV === "test"
        ? "silent"
        : "debug",
  transport:
    config.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
  serializers: {
    req(request) {
      return { method: request.method, url: request.url };
    },
    res(reply) {
      return { statusCode: reply.statusCode };
    },
  },
  // #287: every log line written through this shared logger — which is
  // nearly all of them; `request.log` is used almost nowhere in this
  // codebase — automatically picks up the current request's ID from the
  // AsyncLocalStorage context server.ts populates on every request. This
  // covers call sites that don't explicitly pass `requestId` today without
  // having to touch each one individually. An explicit `requestId` in the
  // log call's own fields still wins (pino merges the mixin object first,
  // then the call's fields on top).
  mixin() {
    const requestId = getRequestId();
    return requestId ? { requestId } : {};
  },
});
