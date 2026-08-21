\set ON_ERROR_STOP on
BEGIN;

INSERT INTO teams (id, name, slug, created_at, updated_at)
VALUES (420, 'Alcantara Local', 'alcantara-local', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, updated_at = CURRENT_TIMESTAMP;

SELECT setval(pg_get_serial_sequence('teams', 'id'), GREATEST((SELECT MAX(id) FROM teams), 420));

INSERT INTO applications (
  team_id, name, slug, description, cognito_user_pool_id, cognito_client_id, created_at, updated_at
)
VALUES (
  420, 'Alcantara Local', 'alcantara-local', 'Fictional local-development authorization catalog',
  'us-east-1_local', 'local-browser-tests', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
)
ON CONFLICT (slug) DO UPDATE SET
  team_id = EXCLUDED.team_id,
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  cognito_user_pool_id = EXCLUDED.cognito_user_pool_id,
  cognito_client_id = EXCLUDED.cognito_client_id,
  updated_at = CURRENT_TIMESTAMP;

WITH app AS (SELECT id FROM applications WHERE slug = 'alcantara-local'),
keys(key) AS (VALUES
  ('alcantara:access'), ('alcantara:program:read'), ('alcantara:program:manage'), ('alcantara:program:operate'),
  ('alcantara:flight:read'), ('alcantara:flight:manage'), ('alcantara:flight:operate'),
  ('alcantara:scene:read'), ('alcantara:scene:manage'), ('alcantara:scene:operate'),
  ('alcantara:layout:read'), ('alcantara:layout:manage'),
  ('alcantara:media:read'), ('alcantara:media:manage'),
  ('alcantara:song:read'), ('alcantara:song:manage'),
  ('alcantara:instant:read'), ('alcantara:instant:manage'), ('alcantara:instant:operate'),
  ('alcantara:stinger:read'), ('alcantara:stinger:manage'),
  ('alcantara:radio:read'), ('alcantara:radio:manage'), ('alcantara:radio:operate'),
  ('alcantara:webrtc:read'), ('alcantara:webrtc:operate'), ('alcantara:upload:create')
)
INSERT INTO rbac_permissions (application_id, key, description, created_at, updated_at)
SELECT app.id, keys.key, 'Alcantara local test permission', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM app CROSS JOIN keys
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description, updated_at = CURRENT_TIMESTAMP;

WITH app AS (SELECT id FROM applications WHERE slug = 'alcantara-local'),
roles(key, name) AS (VALUES
  ('alcantara-local-viewer', 'Alcantara Local Viewer'),
  ('alcantara-local-manager', 'Alcantara Local Manager'),
  ('alcantara-local-operator', 'Alcantara Local Operator'),
  ('alcantara-local-denied', 'Alcantara Local Denied'),
  ('alcantara-local-admin', 'Alcantara Local Wildcard Administrator')
)
INSERT INTO rbac_roles (application_id, key, name, description, is_system, created_at, updated_at)
SELECT app.id, roles.key, roles.name, 'Fictional deterministic local role', FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM app CROSS JOIN roles
ON CONFLICT (application_id, key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, updated_at = CURRENT_TIMESTAMP;

WITH profiles(slug, email, first_name, last_name, subject, role_key) AS (VALUES
  ('alcantara-local-viewer', 'viewer@alcantara.local.test', 'Valerie', 'Viewer', 'test:alcantara-viewer', 'alcantara-local-viewer'),
  ('alcantara-local-manager', 'manager@alcantara.local.test', 'Morgan', 'Manager', 'test:alcantara-manager', 'alcantara-local-manager'),
  ('alcantara-local-operator', 'operator@alcantara.local.test', 'Oriana', 'Operator', 'test:alcantara-operator', 'alcantara-local-operator'),
  ('alcantara-local-denied', 'denied@alcantara.local.test', 'Dana', 'Denied', 'test:alcantara-denied', 'alcantara-local-denied'),
  ('alcantara-local-admin', 'admin@alcantara.local.test', 'Avery', 'Administrator', 'test:alcantara-admin', 'alcantara-local-admin')
)
INSERT INTO users (slug, email, name, last_name, is_active, created_at, updated_at)
SELECT slug, email, first_name, last_name, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM profiles
ON CONFLICT (email) DO UPDATE SET slug = EXCLUDED.slug, name = EXCLUDED.name, last_name = EXCLUDED.last_name, is_active = TRUE, deleted_at = NULL, updated_at = CURRENT_TIMESTAMP;

WITH profiles(email, subject) AS (VALUES
  ('viewer@alcantara.local.test', 'test:alcantara-viewer'),
  ('manager@alcantara.local.test', 'test:alcantara-manager'),
  ('operator@alcantara.local.test', 'test:alcantara-operator'),
  ('denied@alcantara.local.test', 'test:alcantara-denied'),
  ('admin@alcantara.local.test', 'test:alcantara-admin')
)
INSERT INTO logins (user_id, provider, sub, created_at)
SELECT users.id, 'alcantara-local-test', profiles.subject, CURRENT_TIMESTAMP
FROM profiles JOIN users ON users.email = profiles.email
ON CONFLICT (sub) DO UPDATE SET user_id = EXCLUDED.user_id, provider = EXCLUDED.provider;

DELETE FROM rbac_role_permissions
WHERE role_id IN (SELECT id FROM rbac_roles WHERE key LIKE 'alcantara-local-%');

WITH mappings(role_key, permission_key) AS (
  SELECT 'alcantara-local-viewer', key FROM rbac_permissions WHERE key = 'alcantara:access' OR key LIKE 'alcantara:%:read'
  UNION ALL SELECT 'alcantara-local-manager', key FROM rbac_permissions WHERE key = 'alcantara:access' OR key LIKE 'alcantara:%:read' OR key LIKE 'alcantara:%:manage' OR key = 'alcantara:upload:create'
  UNION ALL SELECT 'alcantara-local-operator', key FROM rbac_permissions WHERE key = 'alcantara:access' OR key LIKE 'alcantara:%:read' OR key LIKE 'alcantara:%:operate'
  UNION ALL SELECT 'alcantara-local-admin', key FROM rbac_permissions WHERE key LIKE 'alcantara:%'
)
INSERT INTO rbac_role_permissions (role_id, permission_id, created_at, updated_at)
SELECT roles.id, permissions.id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM mappings
JOIN rbac_roles roles ON roles.key = mappings.role_key
JOIN rbac_permissions permissions ON permissions.key = mappings.permission_key
ON CONFLICT (role_id, permission_id) DO NOTHING;

DELETE FROM rbac_role_assignments
WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@alcantara.local.test');

WITH profiles(email, role_key) AS (VALUES
  ('viewer@alcantara.local.test', 'alcantara-local-viewer'),
  ('manager@alcantara.local.test', 'alcantara-local-manager'),
  ('operator@alcantara.local.test', 'alcantara-local-operator'),
  ('denied@alcantara.local.test', 'alcantara-local-denied'),
  ('admin@alcantara.local.test', 'alcantara-local-admin')
)
INSERT INTO rbac_role_assignments (user_id, role_id, team_id, created_at, updated_at)
SELECT users.id, roles.id, 420, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM profiles
JOIN users ON users.email = profiles.email
JOIN rbac_roles roles ON roles.key = profiles.role_key;

INSERT INTO rbac_role_assignments (user_id, role_id, team_id, created_at, updated_at)
SELECT users.id, roles.id, 420, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM users CROSS JOIN rbac_roles roles
WHERE users.email = 'admin@alcantara.local.test'
  AND roles.key = 'platform-admin'
ON CONFLICT (user_id, role_id, team_id) DO NOTHING;

COMMIT;
