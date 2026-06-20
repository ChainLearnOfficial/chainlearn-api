import { beforeEach, describe, expect, it, vi } from "vitest";

type EvalCall = {
  script: string;
  numKeys: number;
  key: string;
  value: string;
  ttl?: number;
};

const state = {
  values: new Map<string, string>(),
  evalCalls: [] as EvalCall[],
};

vi.mock("../../../src/config/redis.js", () => ({
  redis: {
    set: vi.fn(async (key: string, value: string, _px: string, _ttl: number, _nx: string) => {
      if (state.values.has(key)) return null;
      state.values.set(key, value);
      return "OK";
    }),
    eval: vi.fn(async (
      script: string,
      numKeys: number,
      key: string,
      value: string,
      ttl?: number
    ) => {
      state.evalCalls.push({ script, numKeys, key, value, ttl });

      if (script.includes("pexpire")) {
        return state.values.get(key) === value ? 1 : 0;
      }

      if (state.values.get(key) === value) {
        state.values.delete(key);
        return 1;
      }

      return 0;
    }),
  },
}));

import { redis } from "../../../src/config/redis.js";
import { withLock } from "../../../src/utils/lock.js";

const mockedRedis = vi.mocked(redis);

describe("withLock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.values.clear();
    state.evalCalls = [];
  });

  it("renews a held lock while the protected operation is still running", async () => {
    const result = await withLock(
      "stellar:claim",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 90));
        return "done";
      },
      75
    );

    expect(result).toBe("done");
    expect(mockedRedis.set).toHaveBeenCalledWith(
      "lock:stellar:claim",
      expect.any(String),
      "PX",
      75,
      "NX"
    );

    const renewals = state.evalCalls.filter((call) =>
      call.script.includes("pexpire")
    );
    expect(renewals.length).toBeGreaterThan(0);
    expect(renewals.every((call) => call.ttl === 75)).toBe(true);
  });

  it("uses the lock token for renewal and release so another holder is not removed", async () => {
    const result = await withLock(
      "stellar:mint",
      async () => {
        state.values.set("lock:stellar:mint", "other-holder");
        await new Promise((resolve) => setTimeout(resolve, 40));
        return "done";
      },
      75
    );

    expect(result).toBe("done");
    expect(state.values.get("lock:stellar:mint")).toBe("other-holder");

    const renewals = state.evalCalls.filter((call) =>
      call.script.includes("pexpire")
    );
    expect(renewals.some((call) => call.value !== "other-holder")).toBe(true);

    const releases = state.evalCalls.filter((call) =>
      call.script.includes("del")
    );
    expect(releases).toHaveLength(1);
  });
});
