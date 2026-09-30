import { describe, it, expect } from "vitest";
import { validateWebhookUrl } from "../../../src/utils/ssrf-guard.js";

describe("validateWebhookUrl (#487)", () => {
  it("accepts a normal public https URL", () => {
    expect(validateWebhookUrl("https://example.com/webhooks/chainlearn").valid).toBe(true);
  });

  it("accepts a normal public http URL", () => {
    expect(validateWebhookUrl("http://example.com/hook").valid).toBe(true);
  });

  it("rejects non-http(s) protocols", () => {
    expect(validateWebhookUrl("file:///etc/passwd").valid).toBe(false);
    expect(validateWebhookUrl("ftp://example.com/x").valid).toBe(false);
    expect(validateWebhookUrl("gopher://example.com/x").valid).toBe(false);
  });

  it("rejects localhost and its subdomains", () => {
    expect(validateWebhookUrl("http://localhost/hook").valid).toBe(false);
    expect(validateWebhookUrl("http://sub.localhost/hook").valid).toBe(false);
  });

  it("rejects loopback IPv4 addresses", () => {
    expect(validateWebhookUrl("http://127.0.0.1/hook").valid).toBe(false);
    expect(validateWebhookUrl("http://127.255.255.255/hook").valid).toBe(false);
  });

  it("rejects RFC 1918 private IPv4 ranges", () => {
    expect(validateWebhookUrl("http://10.0.0.5/hook").valid).toBe(false);
    expect(validateWebhookUrl("http://172.16.0.1/hook").valid).toBe(false);
    expect(validateWebhookUrl("http://172.31.255.255/hook").valid).toBe(false);
    expect(validateWebhookUrl("http://192.168.1.1/hook").valid).toBe(false);
  });

  it("rejects the cloud metadata endpoint specifically", () => {
    expect(validateWebhookUrl("http://169.254.169.254/latest/meta-data/").valid).toBe(false);
  });

  it("rejects the unspecified address", () => {
    expect(validateWebhookUrl("http://0.0.0.0/hook").valid).toBe(false);
  });

  it("rejects IPv6 loopback and link-local", () => {
    expect(validateWebhookUrl("http://[::1]/hook").valid).toBe(false);
    expect(validateWebhookUrl("http://[fe80::1]/hook").valid).toBe(false);
  });

  it("accepts a public IPv4 address", () => {
    expect(validateWebhookUrl("http://8.8.8.8/hook").valid).toBe(true);
  });

  it("rejects a malformed URL", () => {
    expect(validateWebhookUrl("not a url").valid).toBe(false);
  });

  it("includes a reason when rejecting", () => {
    const result = validateWebhookUrl("http://127.0.0.1/hook");
    expect(result.valid).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});
