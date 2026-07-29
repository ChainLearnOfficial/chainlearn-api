-- Add CHECK constraint to enforce that at most one of the three reward state
-- flags is true at any time. Without this, application bugs (like the one
-- fixed in retry-queue.ts that set both rewardFailed and rewardClaimed) can
-- corrupt the state machine silently.
ALTER TABLE quiz_submissions
  ADD CONSTRAINT chk_reward_mutex
  CHECK (
    (reward_claimed::int + reward_pending::int + reward_failed::int) <= 1
  );
