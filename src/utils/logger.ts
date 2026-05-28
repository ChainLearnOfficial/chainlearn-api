import pino from "pino";
import { config } from "../config/index.js";

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
});
