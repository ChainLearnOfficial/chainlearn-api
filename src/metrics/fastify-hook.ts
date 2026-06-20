import type { FastifyInstance, FastifyRequest } from "fastify";
import { httpRequestsTotal, httpRequestDurationSeconds } from "./index.js";

export function registerMetricsHook(app: FastifyInstance): void {
  app.addHook("onRequest", (request: FastifyRequest & { _metricsStart?: bigint }, _reply, done) => {
    request._metricsStart = process.hrtime.bigint();
    done();
  });

  app.addHook("onResponse", (request: FastifyRequest & { _metricsStart?: bigint }, reply, done) => {
    const route = (request.routeOptions as { url?: string } | undefined)?.url ?? request.url;
    const labels = {
      method: request.method,
      route,
      status_code: String(reply.statusCode),
    };

    httpRequestsTotal.inc(labels);

    if (request._metricsStart != null) {
      const durationSecs = Number(process.hrtime.bigint() - request._metricsStart) / 1e9;
      httpRequestDurationSeconds.observe(labels, durationSecs);
    }

    done();
  });
}
