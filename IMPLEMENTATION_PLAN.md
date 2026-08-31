# Implementation Plan for Issues #237, #238, #239, #240

## Overview

This document outlines the implementation approach for fixing four medium-priority bugs related to caching, error handling, database schema, and distributed locking in the ChainLearn API.

## Issues Summary

### Issue #237: Lock TTL 30s too short for Stellar transactions

**Problem**: Default lock TTL of 30 seconds in `src/utils/lock.ts` is insufficient for Stellar network transactions which can take 5-30 seconds during network congestion. With heartbeat at 15 seconds, transient Redis failures could cause lock expiration mid-transaction, risking duplicate transactions.

**Impact**: Potential duplicate Stellar transactions, race conditions, double-spending risks.

### Issue #238: bad_seq detection relies on fragile string matching

**Problem**: Error detection at `src/stellar/transactions.ts:84` uses string matching (`err.message.includes("bad_seq")`) which is fragile and could silently break if SDK error format changes.

**Impact**: Silent breakage across SDK versions, bad_seq errors thrown as unrecoverable instead of being retried.

### Issue #239: Reward history cache TTL only 30s

**Problem**: At `src/modules/rewards/reward.service.ts:485`, reward history cache TTL is only 30 seconds despite reward history only changing on rare claim events (compared to user profile cache at 300 seconds).

**Impact**: Cache almost never hits, unnecessary database queries, poor performance.

### Issue #240: quizzes.generatedFor FK missing onDelete cascade

**Problem**: At `src/database/schema.ts:181`, the `generatedFor` foreign key lacks `onDelete: "cascade"`, making it the only user-referencing FK without proper cascade behavior.

**Impact**: User deletion may fail or leave orphaned quiz records, data integrity issues.

## Proposed Changes

### 1. Fix Lock TTL (#237)

**File**: `src/utils/lock.ts`

**Changes**:

- Update default TTL from `30_000` to `60_000` milliseconds (60 seconds)
- This provides safer default for most operations while remaining configurable

**Code**:

```typescript
export async function withLock<T>(
  key: string,
  fn: () => Promise<T>,
  ttlMs: number = 60_000  // Changed from 30_000
): Promise<T> {
```

**File**: `src/modules/rewards/reward.service.ts`

**Changes**:

- Update Stellar transaction lock calls to use 90-second TTL for extra safety
- Locate all `withLock` calls that wrap Stellar operations and pass explicit `90_000` TTL

**Rationale**:

- 60s default is safe for most operations
- 90s explicit TTL for Stellar operations handles worst-case network congestion
- Heartbeat at 45s (90s / 2) provides better safety margin

### 2. Improve bad_seq Error Detection (#238)

**File**: `src/stellar/transactions.ts`

**Changes at line 84**:

- Replace fragile string matching with more robust detection
- Check for HTTP 400 status and result codes from Horizon API

**Current**:

```typescript
if (err instanceof StellarError && (err.message.includes("bad_seq") || err.message.includes("tx_bad_seq"))) {
```

**Proposed**:

```typescript
if (err instanceof StellarError && isBadSeqError(err)) {
```

**Add helper function**:

```typescript
function isBadSeqError(err: StellarError): boolean {
  // Primary detection: string matching (backwards compatible)
  if (err.message.includes("bad_seq") || err.message.includes("tx_bad_seq")) {
    return true;
  }

  // Robust detection: check Horizon response structure
  const response = (err as any)?.response;
  if (response?.status === 400) {
    const resultCodes = response?.data?.extras?.result_codes;
    if (resultCodes?.transaction === "tx_bad_seq") {
      return true;
    }
  }

  return false;
}
```

**File**: `src/modules/rewards/reward.service.ts`

**Changes at line 125**:

- Update similar bad_seq detection to use the same helper function

**Rationale**:

- Maintains backwards compatibility with current string matching
- Adds robust HTTP response checking as fallback
- Centralizes detection logic for consistency
- Works across SDK versions and error format changes

### 3. Increase Reward History Cache TTL (#239)

**File**: `src/modules/rewards/reward.service.ts`

**Changes at line 485**:

- Increase TTL from 30 to 300 seconds (5 minutes)

**Current**:

```typescript
await cacheSet(cacheKeyString, result, 30);
```

**Proposed**:

```typescript
await cacheSet(cacheKeyString, result, 300);
```

**Rationale**:

- Reward history only changes on claim events (rare)
- Cache is explicitly invalidated on claim
- Matches user profile cache duration
- Significantly improves cache hit rate and reduces DB load

### 4. Add onDelete Cascade to generatedFor FK (#240)

**File**: `src/database/schema.ts`

**Changes at line 181**:

- Add `onDelete: "cascade"` to the `generatedFor` foreign key reference

**Current**:

```typescript
generatedFor: uuid("generated_for").references(() => users.id),
```

**Proposed**:

```typescript
generatedFor: uuid("generated_for").references(() => users.id, {
  onDelete: "cascade",
}),
```

**Migration Required**: Yes

- Create migration to alter the existing foreign key constraint
- Migration file: `src/database/migrations/0020_quiz_generated_for_cascade.sql`

**Migration SQL**:

```sql
-- Drop existing constraint
ALTER TABLE quizzes
DROP CONSTRAINT IF EXISTS quizzes_generated_for_users_id_fk;

-- Recreate with CASCADE
ALTER TABLE quizzes
ADD CONSTRAINT quizzes_generated_for_users_id_fk
FOREIGN KEY (generated_for)
REFERENCES users(id)
ON DELETE CASCADE;
```

**Rationale**:

- Ensures consistency with all other user-referencing FKs
- Prevents orphaned quiz records
- Allows clean user deletion
- Maintains referential integrity

## Testing Strategy

### Manual Testing

1. **Lock TTL**: Test Stellar transactions during simulated network delays
2. **bad_seq Detection**: Verify retry behavior with sequence conflicts
3. **Cache TTL**: Monitor cache hit rates in development environment
4. **FK Cascade**: Test user deletion cascades to associated quizzes

### Existing Tests

- All existing tests should continue to pass
- No new test files required unless specifically requested

## Implementation Order

1. **Issue #239** (Reward cache TTL) - Simplest, single line change
2. **Issue #240** (FK cascade) - Requires migration, should be deployed early
3. **Issue #237** (Lock TTL) - Requires checking all withLock call sites
4. **Issue #238** (bad_seq detection) - Most complex, requires helper function

## Deployment Considerations

- All changes are backwards compatible
- Migration #240 should run before application deployment
- No API changes or breaking changes
- Can be deployed as a single release

## Success Criteria

1. ✅ All four issues resolved with proposed changes
2. ✅ Existing test suite passes
3. ✅ No performance regressions
4. ✅ Database migration runs successfully
5. ✅ Code follows existing patterns and conventions
