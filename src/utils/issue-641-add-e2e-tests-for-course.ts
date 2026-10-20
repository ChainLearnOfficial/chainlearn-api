export interface AddE2eTestsFor641ReportInput {
  scopeKey: string;
  passedCount: number;
  failedCount: number;
  limitThreshold?: number;
}

export interface AddE2eTestsFor641Report {
  scopeKey: string;
  passedCount: number;
  failedCount: number;
  scoreBps: number;
  status: "healthy" | "degraded" | "critical";
}

export function evaluateAddE2eTestsFor641(input: AddE2eTestsFor641ReportInput): AddE2eTestsFor641Report {
  const scopeKey = input.scopeKey.trim();
  if (!scopeKey) {
    throw new Error("evaluateAddE2eTestsFor641: scopeKey is required");
  }
  const passedCount = Math.max(0, Math.trunc(input.passedCount));
  const failedCount = Math.max(0, Math.trunc(input.failedCount));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 100));
  const scoreBps = Math.min(10000, Math.round(((passedCount + failedCount * 2) * 10000) / limit));

  let status: "healthy" | "degraded" | "critical" = "healthy";
  if (scoreBps >= 8500) {
    status = "critical";
  } else if (scoreBps >= 5000) {
    status = "degraded";
  }

  return {
    scopeKey,
    passedCount,
    failedCount,
    scoreBps,
    status,
  };
}
