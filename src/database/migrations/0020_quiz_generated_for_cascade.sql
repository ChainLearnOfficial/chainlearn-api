-- Drop existing constraint
ALTER TABLE quizzes 
DROP CONSTRAINT IF EXISTS quizzes_generated_for_users_id_fk;

-- Recreate with CASCADE
ALTER TABLE quizzes 
ADD CONSTRAINT quizzes_generated_for_users_id_fk 
FOREIGN KEY (generated_for) 
REFERENCES users(id) 
ON DELETE CASCADE;
