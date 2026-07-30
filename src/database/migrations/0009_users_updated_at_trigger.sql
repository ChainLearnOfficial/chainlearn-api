-- Auto-maintain users.updated_at on every UPDATE.
--
-- Previously updated_at was only set explicitly in user.service.ts
-- (updateProfile). Every other write path — most notably the credit increment
-- in reward.service.ts when a quiz reward is claimed — left it untouched, so
-- updated_at did not reflect the row's actual last modification and anything
-- reading it as "last user activity" saw stale data.
--
-- Enforcing this in the database rather than the application guarantees the
-- invariant holds for all writers, including migrations and manual SQL.
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_users_updated_at ON users;

CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
