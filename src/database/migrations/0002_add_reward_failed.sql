-- Add reward_failed column to quiz_submissions to track permanently failed reward claims
ALTER TABLE quiz_submissions ADD COLUMN IF NOT EXISTS reward_failed boolean NOT NULL DEFAULT false;

-- Add index on reward_failed for admin queries
CREATE INDEX IF NOT EXISTS idx_quiz_submissions_reward_failed
  ON quiz_submissions (reward_failed);
