"""개발용 예제(state-loss). 실제 팀 앱이 아니다.

SQLite 파일을 컨테이너 안(writable layer)에 저장하는 작은 메모 앱이다.
시작할 때 테이블을 지우지 않는다(CREATE TABLE IF NOT EXISTS).
그래서 restart에는 데이터가 남고, 컨테이너를 새것으로 바꾸는 replace에는 사라진다.
"""

import json
import os
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", "8000"))
DATA_DIR = os.environ.get("DATA_DIR", "/app/data")
DB_PATH = os.path.join(DATA_DIR, "notes.db")


def db():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL)")
    return conn


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self.send_json(200, {"ready": True})
        with db() as conn:
            if self.path == "/notes":
                rows = conn.execute("SELECT id, text FROM notes ORDER BY id").fetchall()
                return self.send_json(200, [{"id": r[0], "text": r[1]} for r in rows])
            if self.path.startswith("/notes/") and self.path[7:].isdigit():
                row = conn.execute("SELECT id, text FROM notes WHERE id = ?", (int(self.path[7:]),)).fetchone()
                if row is None:
                    return self.send_json(404, {"error": "not_found"})
                return self.send_json(200, {"id": row[0], "text": row[1]})
        self.send_json(404, {"error": "not_found"})

    def do_POST(self):
        if self.path != "/notes":
            return self.send_json(404, {"error": "not_found"})
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length) or b"{}")
        with db() as conn:
            cursor = conn.execute("INSERT INTO notes (text) VALUES (?)", (str(payload.get("text", "")),))
            note_id = cursor.lastrowid
        self.send_json(201, {"id": note_id, "text": payload.get("text", "")})

    def log_message(self, fmt, *args):
        print("%s %s" % (self.address_string(), fmt % args), flush=True)


if __name__ == "__main__":
    print(f"listening on {HOST}:{PORT}, db={DB_PATH}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
