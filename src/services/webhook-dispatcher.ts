import { logger } from "../utils/logger.js";

const MAX_RESPONSE_BYTES = 1 * 1024 * 1024; // 1 MB
const DEFAULT_TIMEOUT_MS = 10_000; // 10 seconds

interface WebhookPayload {
  event: string;
  data: Record<string, unknown>;
  timestamp: string;
}

interface DispatchResult {
  success: boolean;
  statusCode?: number;
  error?: string;
}

/**
 * Dispatch a webhook notification to the given URL.
 * Protects against oversized responses and slow endpoints.
 */
export async function dispatchWebhook(
  url: string,
  payload: WebhookPayload,
  options?: { timeoutMs?: number }
): Promise<DispatchResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = JSON.stringify(payload);

    const response: any = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body).toString(),
      },
      body,
      signal: controller.signal,
    });

    // Read response with size limit
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_RESPONSE_BYTES) {
      logger.warn(
        { url, bytes: arrayBuffer.byteLength },
        "Webhook response exceeded max size"
      );
      return {
        success: false,
        statusCode: response.status,
        error: `Response body too large (${arrayBuffer.byteLength} bytes, max ${MAX_RESPONSE_BYTES})`,
      };
    }

    return {
      success: response.ok,
      statusCode: response.status,
    };
  } catch (err: any) {
    if (err.name === "AbortError") {
      logger.warn({ url, timeoutMs }, "Webhook request timed out");
      return { success: false, error: `Request timed out after ${timeoutMs}ms` };
    }
    logger.error({ url, err }, "Webhook dispatch failed");
    return { success: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}