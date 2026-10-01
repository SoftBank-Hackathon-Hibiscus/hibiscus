"""문의 페이지 통계 (Python). 개인정보 없음.

contact_count 는 정수 카운터, ticket_no 는 숫자 문자열이지만 전화번호가 아니다.
이름에 contact 가 들어가고 .get("...") / 정규식 검증 코드가 있어도 개인정보로 잡히면 안 된다.
"""
import random
import re
import sqlite3

DB_PATH = "/app/data.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS stats (
    id            INTEGER PRIMARY KEY,
    contact_count INTEGER NOT NULL DEFAULT 0,
    ticket_no     TEXT NOT NULL,
    updated_at    TEXT
);
"""

TICKET_RE = re.compile(r"^T-\d{6}$")


def init_db():
    with sqlite3.connect(DB_PATH) as conn:
        conn.executescript(SCHEMA)


def record_contact_page_view(payload):
    # 문의 페이지 방문 횟수를 더한다 (개인정보 아님: 정수 카운터)
    delta = int(payload.get("contact_count", 1))
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("UPDATE stats SET contact_count = contact_count + ? WHERE id = 1", (delta,))


def issue_ticket():
    ticket_no = "T-%06d" % random.randrange(10**6)
    if not TICKET_RE.match(ticket_no):
        raise ValueError("bad ticket")
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("INSERT INTO stats (ticket_no) VALUES (?)", (ticket_no,))
    return {"ticket_no": ticket_no}
