/**
 * Per-route request body size limits (#484), tighter than the global
 * `REQUEST_BODY_LIMIT_BYTES` fallback (1 MB) so a route with a small
 * legitimate payload can't be handed a body sized for a much larger one.
 * Enforced by Fastify's own `config.bodyLimit` route option, which rejects
 * an oversized body before it is parsed (`error-handler.ts` already reports
 * the route's actual limit on `FST_ERR_CTP_BODY_TOO_LARGE`).
 *
 * Values are collected here, rather than inlined at each route, so the
 * answer to "what body size does this route accept?" is one file.
 */

const KB = 1024;
const MB = 1024 * KB;

export const ROUTE_BODY_LIMITS = {
  /** PUT /api/v1/users/me — displayName/background/learningGoal/pace/language. */
  profileUpdate: 10 * KB,
  /** POST /api/v1/admin/courses/import — a full course plus its modules. */
  courseImport: 5 * MB,
  /** Admin quiz authoring endpoints — up to 50 hand-authored questions. */
  quizAuthoring: 100 * KB,
  /** POST /api/v1/admin/webhooks — a webhook registration (url, secret, events). */
  webhookCreate: 10 * KB,
} as const;
