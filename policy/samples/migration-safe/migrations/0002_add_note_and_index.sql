-- 칼럼 추가 (NULL 허용) 와 인덱스 추가는 옛 버전과 호환된다
ALTER TABLE todos ADD COLUMN note TEXT;
CREATE INDEX idx_todos_done ON todos (done);
