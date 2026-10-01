/**
 * #275 — controller wiring for the refresh-token flow.
 *
 * Verifies auth.controller.ts hands the pieces to the right collaborators:
 * verify() issues a refresh token beside the access token, refresh() rotates,
 * and logout() revokes the refresh family only when the client sends the
 * token. The rotation logic itself is covered in refresh-token.service.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../../src/modules/auth/auth.service.js", () => ({
  authService: { verifyChallenge: vi.fn() },
}));

vi.mock("../../../src/modules/auth/refresh-token.service.js", () => ({
  issueRefreshToken: vi.fn(),
  rotateRefreshToken: vi.fn(),
  revokeRefreshToken: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/middleware/auth.js", () => ({
  revokeToken: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { authController } from "../../../src/modules/auth/auth.controller.js";
import { authService } from "../../../src/modules/auth/auth.service.js";
import {
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
} from "../../../src/modules/auth/refresh-token.service.js";
import { revokeToken } from "../../../src/middleware/auth.js";

const USER = {
  id: "22222222-2222-4222-8222-222222222222",
  stellarAddress: "GCTRLTEST000000000000000000000000000000000000000000000",
  displayName: null,
  isNewUser: false,
};

// The controller handlers are narrowly typed (FastifyRequest<{ Body: ... }>);
// these fakes carry only what each handler touches, cast through `any` the
// same way the other service/controller unit tests in this repo do.
/* eslint-disable @typescript-eslint/no-explicit-any */
function fakeReply(): any {
  return { send: vi.fn() };
}

function fakeRequest(overrides: Record<string, unknown> = {}): any {
  return {
    server: { jwt: { sign: vi.fn().mockReturnValue("signed.jwt.token") } },
    ...overrides,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe("AuthController — refresh flow (#275)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("verify() returns an access token AND a refresh token", async () => {
    vi.mocked(authService.verifyChallenge).mockResolvedValue({
      token: "",
      user: USER,
    });
    vi.mocked(issueRefreshToken).mockResolvedValue({
      token: "refresh-token-abc",
      familyId: "fam-1",
      record: {
        userId: USER.id,
        stellarAddress: USER.stellarAddress,
        familyId: "fam-1",
        issuedAt: 0,
        expiresAt: 0,
      },
    });

    const reply = fakeReply();
    await authController.verify(
      fakeRequest({
        body: {
          stellarAddress: USER.stellarAddress,
          challengeId: "cid",
          signedChallenge: "sig",
        },
      }),
      reply,
    );

    expect(issueRefreshToken).toHaveBeenCalledWith(USER.id, USER.stellarAddress);
    const payload = reply.send.mock.calls[0][0];
    expect(payload.data.token).toBe("signed.jwt.token");
    expect(payload.data.refreshToken).toBe("refresh-token-abc");
    expect(payload.data.user).toEqual(USER);
  });

  it("refresh() rotates: new access token from the record, rotated refresh token echoed back", async () => {
    vi.mocked(rotateRefreshToken).mockResolvedValue({
      record: {
        userId: USER.id,
        stellarAddress: USER.stellarAddress,
        familyId: "fam-1",
        issuedAt: 0,
        expiresAt: 0,
      },
      next: {
        token: "refresh-token-2",
        familyId: "fam-1",
        record: {
          userId: USER.id,
          stellarAddress: USER.stellarAddress,
          familyId: "fam-1",
          issuedAt: 0,
          expiresAt: 0,
        },
      },
    });

    const request = fakeRequest({ body: { refreshToken: "refresh-token-1" } });
    const reply = fakeReply();
    await authController.refresh(request, reply);

    expect(rotateRefreshToken).toHaveBeenCalledWith("refresh-token-1");
    expect(request.server.jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: USER.id,
        stellarAddress: USER.stellarAddress,
      }),
      expect.objectContaining({ expiresIn: "24h" }),
    );
    const payload = reply.send.mock.calls[0][0];
    expect(payload.data.token).toBe("signed.jwt.token");
    expect(payload.data.refreshToken).toBe("refresh-token-2");
  });

  it("logout() revokes the refresh family when the client sends the token", async () => {
    const request = fakeRequest({
      user: { jti: "jti-1", exp: Math.floor(Date.now() / 1000) + 3600 },
      body: { refreshToken: "refresh-token-1" },
    });
    await authController.logout(request, fakeReply());

    expect(revokeToken).toHaveBeenCalledWith("jti-1", expect.any(Number));
    expect(revokeRefreshToken).toHaveBeenCalledWith("refresh-token-1");
  });

  it("logout() with no body still revokes the access token and does not touch refresh state", async () => {
    const request = fakeRequest({
      user: { jti: "jti-1", exp: Math.floor(Date.now() / 1000) + 3600 },
    });
    await authController.logout(request, fakeReply());

    expect(revokeToken).toHaveBeenCalledWith("jti-1", expect.any(Number));
    expect(revokeRefreshToken).not.toHaveBeenCalled();
  });
});
