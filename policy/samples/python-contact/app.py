"""회원가입 데모 (Python, 표준 라이브러리만).

테이블 정의가 파이썬 문자열 안의 SQL 이고, 요청 값은 dict 키로 다룬다.
users.contact 는 전화번호 정규식으로 검증하고 SMS 발송에 쓴다 → 개인정보(phone), 확실.
"""
import json
import re
import sqlite3
from http.server import BaseHTTPRequestHandler

import notify

DB_PATH = "/app/data.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    contact    TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
"""

PHONE_RE = re.compile(r"^01[016789]-?\d{3,4}-?\d{4}$")


def init_db():
    with sqlite3.connect(DB_PATH) as conn:
        conn.executescript(SCHEMA)


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    def do_POST(self):
        if self.path != "/signup":
            return self.send_json(404, {"error": "not found"})
        data = self.read_json()
        name = data.get("name")
        contact = data.get("contact")
        if not name:
            return self.send_json(400, {"error": "name required"})
        if not contact or not PHONE_RE.match(contact):
            return self.send_json(400, {"error": "invalid phone"})
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute("INSERT INTO users (name, contact) VALUES (?, ?)", (name, contact))
        notify.send_sms(text="가입을 환영합니다", to=contact)
        return self.send_json(201, {"name": name, "contact": contact})
