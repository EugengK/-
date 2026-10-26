-- Local development only: a user matching DEV_AUTH_EMAIL in .dev.vars.
-- Locally this one account can do everything (finance entry + 교적부), so every screen can be tried.
INSERT OR IGNORE INTO users (email, name, role) VALUES ('editor1@example.com', '개발용 기록 담당', 'editor');
UPDATE users SET registry_admin = 1 WHERE email = 'editor1@example.com';
