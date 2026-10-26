-- Local development only: a user matching DEV_AUTH_EMAIL in .dev.vars.
INSERT OR IGNORE INTO users (email, name, role) VALUES ('editor1@example.com', '개발용 기록 담당', 'editor');
