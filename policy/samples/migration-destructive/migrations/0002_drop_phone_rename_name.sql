-- 옛 버전은 아직 phone 과 name 을 읽는다: 배포 중 두 버전이 공존하면 깨진다
ALTER TABLE users DROP COLUMN phone;
ALTER TABLE users RENAME COLUMN name TO full_name;
