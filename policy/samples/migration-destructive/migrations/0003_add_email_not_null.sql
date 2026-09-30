-- DEFAULT 없는 NOT NULL: 옛 버전의 INSERT 가 email 을 안 넣으므로 실패한다
ALTER TABLE users ADD COLUMN email TEXT NOT NULL;
