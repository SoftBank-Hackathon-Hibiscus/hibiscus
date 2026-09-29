-- 예전 계획: DROP TABLE users (실행하지 않았다)
/* 검토 중이던 문장:
   ALTER TABLE users DROP COLUMN phone;
   TRUNCATE users;
*/
INSERT INTO notes (body) VALUES ('DROP TABLE users; RENAME TABLE users TO members -- 문자열 안의 문장');
ALTER TABLE users ADD COLUMN bio TEXT; -- RENAME COLUMN 은 하지 않는다
ALTER TABLE users ADD CONSTRAINT users_name_len CHECK (length(name) > 0);
ALTER TABLE users ALTER COLUMN name DROP DEFAULT;
