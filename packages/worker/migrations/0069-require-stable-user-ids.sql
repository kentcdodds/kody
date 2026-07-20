CREATE TRIGGER users_require_stable_user_id_insert
BEFORE INSERT ON users
WHEN NEW.stable_user_id IS NULL OR trim(NEW.stable_user_id) = ''
BEGIN
	SELECT RAISE(ABORT, 'users.stable_user_id is required');
END;

CREATE TRIGGER users_require_stable_user_id_update
BEFORE UPDATE OF stable_user_id ON users
WHEN NEW.stable_user_id IS NULL OR trim(NEW.stable_user_id) = ''
BEGIN
	SELECT RAISE(ABORT, 'users.stable_user_id is required');
END;
