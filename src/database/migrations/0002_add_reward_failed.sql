-- Add reward_failed column to quiz_submissions to track permanently failed reward claims
ALTER TABLE quiz_submissions ADD COLUMN IF NOT EXISTS reward_failed boolean NOT NULL DEFAULT false;
