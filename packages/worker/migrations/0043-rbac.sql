CREATE TABLE IF NOT EXISTS roles (
	id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	name TEXT NOT NULL UNIQUE,
	description TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS permissions (
	id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	action TEXT NOT NULL,
	entity TEXT NOT NULL,
	access TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	UNIQUE (action, entity, access)
);

CREATE TABLE IF NOT EXISTS role_permissions (
	role_id INTEGER NOT NULL,
	permission_id INTEGER NOT NULL,
	PRIMARY KEY (role_id, permission_id),
	FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
	FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_roles (
	user_id INTEGER NOT NULL,
	role_id INTEGER NOT NULL,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	PRIMARY KEY (user_id, role_id),
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
	FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id);

INSERT OR IGNORE INTO roles (name, description) VALUES ('user', 'Default role for every account');
INSERT OR IGNORE INTO roles (name, description) VALUES ('admin', 'Operator role');

INSERT OR IGNORE INTO permissions (action, entity, access) VALUES ('create', 'user', 'own');
INSERT OR IGNORE INTO permissions (action, entity, access) VALUES ('read', 'user', 'own');
INSERT OR IGNORE INTO permissions (action, entity, access) VALUES ('update', 'user', 'own');
INSERT OR IGNORE INTO permissions (action, entity, access) VALUES ('delete', 'user', 'own');
INSERT OR IGNORE INTO permissions (action, entity, access) VALUES ('create', 'role', 'own');
INSERT OR IGNORE INTO permissions (action, entity, access) VALUES ('read', 'role', 'own');
INSERT OR IGNORE INTO permissions (action, entity, access) VALUES ('update', 'role', 'own');
INSERT OR IGNORE INTO permissions (action, entity, access) VALUES ('delete', 'role', 'own');
INSERT OR IGNORE INTO permissions (action, entity, access) VALUES ('create', 'user', 'any');
INSERT OR IGNORE INTO permissions (action, entity, access) VALUES ('read', 'user', 'any');
INSERT OR IGNORE INTO permissions (action, entity, access) VALUES ('update', 'user', 'any');
INSERT OR IGNORE INTO permissions (action, entity, access) VALUES ('delete', 'user', 'any');
INSERT OR IGNORE INTO permissions (action, entity, access) VALUES ('create', 'role', 'any');
INSERT OR IGNORE INTO permissions (action, entity, access) VALUES ('read', 'role', 'any');
INSERT OR IGNORE INTO permissions (action, entity, access) VALUES ('update', 'role', 'any');
INSERT OR IGNORE INTO permissions (action, entity, access) VALUES ('delete', 'role', 'any');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.name = 'user'
	AND p.access = 'own';

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.name = 'admin';
