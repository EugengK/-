-- Run once per person AFTER creating the database:
--   npx wrangler d1 execute church-accounting --remote --file scripts/add-user.sql
-- Copy this file to scripts/add-user.sql and edit the emails. role: 'editor' (can write) or 'viewer' (read only).
-- Use the same email the person logs in with through Cloudflare Access.
INSERT INTO users (email, name, role) VALUES ('editor1@example.com', '기록 담당 1', 'editor');
INSERT INTO users (email, name, role) VALUES ('editor2@example.com', '기록 담당 2', 'editor');
INSERT INTO users (email, name, role) VALUES ('pastor@example.com', '담임목사', 'viewer');
