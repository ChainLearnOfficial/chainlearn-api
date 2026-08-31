# Implementation Proposal for Issues #316, #317, #318, #319

## Overview

This document outlines the implementation strategy for four new features in the ChainLearn API:

- **#316**: Batch quiz generation endpoint
- **#317**: Course progress sync with on-chain state
- **#318**: Public user profile endpoint
- **#319**: Course completion certificate generation (PDF)

## Issue #316: Add `POST /api/v1/quizzes/generate-batch` endpoint

### What

Add an endpoint that generates quizzes for multiple modules in a single request.

### Implementation Plan

#### 1. New Route

- **File**: `src/modules/quizzes/quiz.routes.ts`
- **Endpoint**: `POST /api/v1/quizzes/generate-batch`
- **Request Body**:
  ```typescript
  {
    courseId: string;
    moduleIds: string[];
    difficulty?: string;
    numQuestions?: number;
  }
  ```

#### 2. Controller Method

- **File**: `src/modules/quizzes/quiz.controller.ts`
- **Method**: `generateBatchQuizzes`
- Validate that all moduleIds belong to the specified courseId
- Enforce rate limiting to prevent AI service abuse

#### 3. Service Method

- **File**: `src/modules/quizzes/quiz.service.ts`
- **Method**: `generateBatchQuizzes`
- Sequential generation to avoid AI service overload
- Handle partial failures gracefully (return successful generations even if some fail)
- Return structure:
  ```typescript
  {
    successful: Array<{ moduleId: string; quiz: Quiz }>;
    failed: Array<{ moduleId: string; error: string }>;
  }
  ```

#### 4. Rate Limiting

- Apply strict rate limiting (e.g., 5 requests per minute per user)
- Leverage existing `src/middleware/rate-limit.ts` patterns

---

## Issue #317: Add course progress sync with on-chain state

### What

Add a background job that periodically syncs course progress from the on-chain progress-tracker contract to the local database.

### Implementation Plan

#### 1. New Job File

- **File**: `src/jobs/sync-progress.ts`
- Run every 15 minutes using cron or setInterval
- Query the progress-tracker contract for active users

#### 2. Sync Logic

- Fetch on-chain progress for each user with active enrollments
- Compare with local database state (enrollments, quiz submissions)
- Update local records if on-chain state differs
- Log discrepancies for monitoring

#### 3. Error Handling

- Graceful failure handling (don't crash server on sync errors)
- Log failed syncs with user/course context
- Continue syncing other users even if one fails

#### 4. Metrics

- Add Prometheus metric to track:
  - Total syncs performed
  - Successful syncs
  - Failed syncs
  - Records updated

#### 5. Integration

- Register job in `src/server.ts` startup
- Ensure job doesn't conflict with existing jobs

---

## Issue #318: Add `GET /api/v1/users/:id/public-profile` endpoint

### What

Add a public profile endpoint that returns limited user information without requiring authentication.

### Implementation Plan

#### 1. New Route

- **File**: `src/modules/users/user.routes.ts`
- **Endpoint**: `GET /api/v1/users/:id/public-profile`
- **Authentication**: None (public endpoint)

#### 2. Controller Method

- **File**: `src/modules/users/user.controller.ts`
- **Method**: `getPublicProfile`
- Return 404 if user doesn't have a displayName set

#### 3. Service Method

- **File**: `src/modules/users/user.service.ts`
- **Method**: `getPublicProfile`
- Return only:
  - `displayName`
  - `credentialsEarned` (count)
  - `completedCourses` (list of course IDs/names)
  - `totalQuizScore` (aggregate)
- Exclude sensitive fields:
  - `stellarAddress`
  - `credits`
  - `learningGoal`
  - `email`
  - `isAdmin`

#### 4. Caching

- Cache response for 5 minutes using Redis
- Cache key: `public-profile:${userId}`
- Invalidate cache when user updates their profile

#### 5. Privacy Consideration

- Only expose profiles for users who have set a displayName (opt-in)
- Add documentation about what fields are public

---

## Issue #319: Add course completion certificate generation

### What

Generate a downloadable PDF certificate when a user completes a course, in addition to the on-chain NFT credential.

### Implementation Plan

#### 1. New Service File

- **File**: `src/services/certificate.ts`
- Use `pdfkit` library for PDF generation
- Create certificate template with:
  - Course title
  - User name (displayName)
  - Completion date
  - QR code linking to public verification endpoint

#### 2. New Route

- **File**: `src/modules/credentials/credential.routes.ts`
- **Endpoint**: `GET /api/v1/credentials/:id/certificate`
- **Authentication**: Required (user must own the credential)

#### 3. Controller Method

- **File**: `src/modules/credentials/credential.controller.ts`
- **Method**: `getCertificate`
- Verify credential ownership
- Generate PDF on first request
- Cache PDF for subsequent requests
- Stream PDF as response with proper headers

#### 4. Caching Strategy

- Store generated PDFs in Redis or filesystem
- Cache key: `certificate:${credentialId}`
- Invalidate cache if credential data changes (unlikely)

#### 5. QR Code

- Use `qrcode` library
- QR links to: `https://api.chainlearn.com/api/v1/credentials/:id/verify` (public endpoint)
- Verification endpoint returns credential authenticity

#### 6. Dependencies

- Add `pdfkit` for PDF generation
- Add `qrcode` for QR code generation

---

## Testing Strategy

### Unit Tests

- Test each new service method in isolation
- Mock external dependencies (database, Stellar client, AI service)

### Integration Tests

- Test complete request/response flow for each endpoint
- Verify rate limiting behavior (#316)
- Test partial failure handling (#316)
- Verify cache invalidation (#318)
- Test PDF generation and caching (#319)

### Manual Testing

- Generate batch quizzes with various module counts
- Verify on-chain sync accuracy
- Test public profile with/without displayName
- Download and verify PDF certificate appearance

---

## Database Migrations

No new migrations required for these features. All use existing schema.

---

## Performance Considerations

1. **Batch Quiz Generation (#316)**
   - Sequential processing prevents AI service overload
   - Rate limiting prevents abuse
   - Consider background job for large batches (future enhancement)

2. **Progress Sync (#317)**
   - Run during off-peak hours if possible
   - Batch Stellar queries to reduce RPC calls
   - Add circuit breaker for Stellar client failures

3. **Public Profile (#318)**
   - 5-minute cache reduces database load
   - Consider adding pagination for completedCourses if list grows large

4. **Certificate Generation (#319)**
   - Cache generated PDFs indefinitely (credentials don't change)
   - Consider offloading to background job for async generation
   - Monitor Redis memory usage for PDF storage

---

## Security Considerations

1. **Batch Quiz Generation (#316)**
   - Strict rate limiting to prevent AI service abuse
   - Validate user enrollment before generating quizzes
   - Validate moduleIds belong to specified courseId

2. **Progress Sync (#317)**
   - Read-only operation (safe)
   - Log all sync operations for audit trail

3. **Public Profile (#318)**
   - Only expose opt-in profiles (users with displayName)
   - Never expose sensitive fields (stellarAddress, credits, etc.)
   - Rate limit to prevent scraping

4. **Certificate Generation (#319)**
   - Verify credential ownership before generating certificate
   - Ensure QR verification endpoint is public and cacheable
   - Consider adding watermark or signature to prevent forgery

---

## Rollout Plan

### Phase 1: Implementation

1. Implement #318 (Public Profile) - Low risk, no external dependencies
2. Implement #316 (Batch Quiz Generation) - Medium complexity
3. Implement #319 (Certificate Generation) - Requires new dependencies
4. Implement #317 (Progress Sync) - Most complex, requires careful testing

### Phase 2: Testing

- Deploy to staging environment
- Run integration tests
- Manual QA for each feature

### Phase 3: Production Deployment

- Deploy during off-peak hours
- Monitor error rates and performance metrics
- Enable progress sync job after verifying other features work

---

## Open Questions

1. **#316**: Should we add a maximum limit on moduleIds per request (e.g., max 10 modules)?
2. **#317**: Should the sync job update local state even if on-chain is behind (e.g., on-chain shows less progress)?
3. **#318**: Should we include course names or just course IDs in completedCourses?
4. **#319**: Should certificate design be customizable per course, or use a single template?

---

## Estimated Timeline

- **#318** (Public Profile): 4-6 hours
- **#316** (Batch Quizzes): 6-8 hours
- **#319** (Certificate): 8-10 hours
- **#317** (Progress Sync): 10-12 hours
- **Testing & QA**: 6-8 hours

**Total**: 34-44 hours (~5-6 working days)

---

## Conclusion

These four features enhance the ChainLearn API by:

- Improving user experience (batch quiz generation, public profiles, certificates)
- Ensuring data consistency (progress sync)
- Providing traditional proof of completion (PDF certificates)

All features leverage existing infrastructure and patterns, minimizing risk while delivering valuable functionality.
