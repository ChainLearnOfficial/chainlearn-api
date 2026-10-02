import net from "node:net";

/**
 * Rejects webhook URLs that could let the dispatcher be used as an SSRF
 * pivot (#487): only public http/https URLs are accepted.
 *
 * This validates at webhook create/update time, against the URL's literal
 * hostname. It does not re-resolve DNS at dispatch time, so a hostname that
 * *currently* resolves publicly but is later repointed at an internal
 * address (DNS rebinding) isn't caught here — that would need a check in
 * the dispatcher itself, immediately before each request, which is a
 * larger change than validating the URL a client submits. Flagging as a
 * deliberate limitation rather than silently scoping it in.
 */

const BLOCKED_IPV4_RANGES: ReadonlyArray<{ base: string; maskBits: number; label: string }> = [
  { base: "127.0.0.0", maskBits: 8, label: "loopback" },
  { base: "10.0.0.0", maskBits: 8, label: "private (RFC 1918)" },
  { base: "172.16.0.0", maskBits: 12, label: "private (RFC 1918)" },
  { base: "192.168.0.0", maskBits: 16, label: "private (RFC 1918)" },
  { base: "169.254.0.0", maskBits: 16, label: "link-local / cloud metadata" },
  { base: "0.0.0.0", maskBits: 8, label: "unspecified" },
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    result = (result << 8) | n;
  }
  return result >>> 0;
}

function isBlockedIPv4(ip: string): string | null {
  const value = ipv4ToInt(ip);
  if (value === null) return null;

  for (const range of BLOCKED_IPV4_RANGES) {
    const rangeValue = ipv4ToInt(range.base);
    if (rangeValue === null) continue;
    const mask = range.maskBits === 0 ? 0 : (0xffffffff << (32 - range.maskBits)) >>> 0;
    if ((value & mask) === (rangeValue & mask)) {
      return range.label;
    }
  }
  return null;
}

/** IPv6 loopback (::1), unspecified (::), and link-local (fe80::/10, which
 *  covers the IPv6 route to the same cloud metadata service). Full IPv6
 *  unique-local (fc00::/7) coverage is intentionally out of scope here —
 *  see the module doc comment on DNS-rebinding for the same "validation is
 *  necessarily a snapshot" reasoning. */
function isBlockedIPv6(ip: string): string | null {
  const normalized = ip.toLowerCase();
  if (normalized === "::1") return "loopback";
  if (normalized === "::") return "unspecified";
  if (normalized.startsWith("fe80:") || normalized.startsWith("fe80::")) return "link-local";
  return null;
}

export interface WebhookUrlValidationResult {
  valid: boolean;
  reason?: string;
}

export function validateWebhookUrl(rawUrl: string): WebhookUrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, reason: "URL could not be parsed" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { valid: false, reason: "Only http and https URLs are allowed" };
  }

  // Strip IPv6 brackets ("[::1]" -> "::1") before classifying.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");

  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { valid: false, reason: "localhost is not allowed" };
  }

  const ipVersion = net.isIP(hostname);
  if (ipVersion === 4) {
    const blockedReason = isBlockedIPv4(hostname);
    if (blockedReason) {
      return { valid: false, reason: `${hostname} is a ${blockedReason} address` };
    }
  } else if (ipVersion === 6) {
    const blockedReason = isBlockedIPv6(hostname);
    if (blockedReason) {
      return { valid: false, reason: `${hostname} is a ${blockedReason} address` };
    }
  }
  // A non-IP hostname (a real domain name) is allowed through — DNS
  // resolution is deliberately not performed here, see the module doc
  // comment above.

  return { valid: true };
}
