"""Guestbook 데모 앱 — parity 검증 대상.

표준 라이브러리만 사용한다 (http.server + sqlite3). 운영 환경에서 흔히 터지는
결함 3가지를 **일부러** 넣어 두었다. parity가 이를 잡아내는지 보기 위함이다.

  결함 1. 세션을 프로세스 메모리(dict)에 저장
          → 재시작하면 로그인이 풀린다 (/me 가 401).
  결함 2. 시작할 때마다 스키마를 DROP → CREATE
          → 재시작하면 글 목록이 비워진다 (/posts).
  결함 3. 업로드 파일을 볼륨이 아닌 컨테이너 내부 /app/uploads 에 저장
          → `docker restart` 로는 안 사라지지만, 컨테이너를 지우고 다시 만들면 사라진다.

엔드포인트
  GET  /healthz              200 {"status":"ok"}
  POST /login   {"name"}     200, 세션 쿠키 sid 발급
  GET  /me                   200 {"name"} | 401
  POST /logout               200
  GET  /posts                200 [글 목록]
  POST /posts   {"author","message"}  201 {글}
  GET  /posts/<id>           200 | 404
  PUT  /uploads/<name>       201 {"name","size"}   (본문 = 파일 바이트)
  GET  /uploads              200 [파일명 목록]
  GET  /uploads/<name>       200 파일 바이트 | 404
"""
import json
import mimetypes
import os
import re
import secrets
import signal
import sqlite3
import ssl
from contextlib import closing
from datetime import datetime, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA_DIR = os.environ.get("DATA_DIR", "/app/data")
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/app/uploads")
PORT = int(os.environ.get("PORT", "8080"))
DB_PATH = os.path.join(DATA_DIR, "data.db")
# 둘 다 주면 HTTPS 로 연다 (parity verify 의 https 대상 확인용). 없으면 HTTP.
TLS_CERT = os.environ.get("TLS_CERT")
TLS_KEY = os.environ.get("TLS_KEY")

# 결함 2: Flask 튜토리얼의 schema.sql 패턴(DROP TABLE IF EXISTS)을 매 시작마다 실행한다.
SCHEMA = """
DROP TABLE IF EXISTS posts;
CREATE TABLE posts (
    id         INTEGER PRIMARY KEY,
    author     TEXT NOT NULL,
    message    TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"""

# 결함 1: 세션 저장소가 프로세스 메모리다. sid -> 사용자 이름
SESSIONS = {}

FILENAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
POST_ID_RE = re.compile(r"^/posts/(\d+)$")
UPLOAD_RE = re.compile(r"^/uploads/([^/]+)$")


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    with closing(connect()) as conn:
        conn.executescript(SCHEMA)


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class Handler(BaseHTTPRequestHandler):
    server_version = "guestbook/1"
    protocol_version = "HTTP/1.1"

    # ---- 응답 헬퍼 -------------------------------------------------------
    def send_body(self, status, body, content_type, extra_headers=()):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for name, value in extra_headers:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status, obj, extra_headers=()):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_body(status, body, "application/json; charset=utf-8", extra_headers)

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length > 0 else b""

    def read_json(self):
        try:
            data = json.loads(self.read_body() or b"{}")
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    def session_id(self):
        cookie = SimpleCookie(self.headers.get("Cookie") or "")
        morsel = cookie.get("sid")
        return morsel.value if morsel else None

    def route(self):
        return self.path.split("?", 1)[0]

    # ---- GET -------------------------------------------------------------
    def do_GET(self):
        path = self.route()
        if path == "/healthz":
            return self.send_json(200, {"status": "ok"})
        if path == "/me":
            name = SESSIONS.get(self.session_id())
            if name is None:
                return self.send_json(401, {"error": "login required"})
            return self.send_json(200, {"name": name})
        if path == "/posts":
            with closing(connect()) as conn:
                rows = conn.execute(
                    "SELECT id, author, message, created_at FROM posts ORDER BY id"
                ).fetchall()
            return self.send_json(200, [dict(r) for r in rows])
        m = POST_ID_RE.match(path)
        if m:
            with closing(connect()) as conn:
                row = conn.execute(
                    "SELECT id, author, message, created_at FROM posts WHERE id = ?",
                    (int(m.group(1)),),
                ).fetchone()
            if row is None:
                return self.send_json(404, {"error": "post not found"})
            return self.send_json(200, dict(row))
        if path == "/uploads":
            return self.send_json(200, sorted(os.listdir(UPLOAD_DIR)))
        m = UPLOAD_RE.match(path)
        if m:
            name = m.group(1)
            file_path = os.path.join(UPLOAD_DIR, name)
            if not FILENAME_RE.match(name) or not os.path.isfile(file_path):
                return self.send_json(404, {"error": "file not found"})
            with open(file_path, "rb") as f:
                data = f.read()
            ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
            return self.send_body(200, data, ctype)
        return self.send_json(404, {"error": "not found"})

    # ---- POST ------------------------------------------------------------
    def do_POST(self):
        path = self.route()
        if path == "/login":
            data = self.read_json()
            name = (data or {}).get("name")
            if not isinstance(name, str) or not name:
                return self.send_json(400, {"error": "name required"})
            sid = secrets.token_hex(16)
            SESSIONS[sid] = name
            return self.send_json(
                200, {"name": name},
                [("Set-Cookie", f"sid={sid}; Path=/; HttpOnly")],
            )
        if path == "/logout":
            self.read_body()
            SESSIONS.pop(self.session_id(), None)
            return self.send_json(
                200, {"ok": True},
                [("Set-Cookie", "sid=; Path=/; Max-Age=0")],
            )
        if path == "/posts":
            data = self.read_json() or {}
            author, message = data.get("author"), data.get("message")
            if not isinstance(author, str) or not isinstance(message, str) or not author or not message:
                return self.send_json(400, {"error": "author and message required"})
            created_at = now_iso()
            with closing(connect()) as conn:
                with conn:
                    cur = conn.execute(
                        "INSERT INTO posts (author, message, created_at) VALUES (?, ?, ?)",
                        (author, message, created_at),
                    )
                post_id = cur.lastrowid
            return self.send_json(
                201, {"id": post_id, "author": author, "message": message, "created_at": created_at}
            )
        self.read_body()
        return self.send_json(404, {"error": "not found"})

    # ---- PUT -------------------------------------------------------------
    def do_PUT(self):
        m = UPLOAD_RE.match(self.route())
        body = self.read_body()
        if not m:
            return self.send_json(404, {"error": "not found"})
        name = m.group(1)
        if not FILENAME_RE.match(name):
            return self.send_json(400, {"error": "invalid file name"})
        # 결함 3: 볼륨이 아닌 컨테이너 쓰기 계층에 저장
        with open(os.path.join(UPLOAD_DIR, name), "wb") as f:
            f.write(body)
        return self.send_json(201, {"name": name, "size": len(body)})


def _graceful_exit(signum, frame):
    # PID 1 로 도는 파이썬은 SIGTERM 핸들러가 없으면 docker stop 이 10초를 기다린 뒤 SIGKILL 한다.
    raise SystemExit(0)


def main():
    init_db()
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    signal.signal(signal.SIGTERM, _graceful_exit)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    scheme = "http"
    if TLS_CERT and TLS_KEY:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(TLS_CERT, TLS_KEY)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        scheme = "https"
    print(f"guestbook listening on {scheme}://:{PORT} (db={DB_PATH}, uploads={UPLOAD_DIR})", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
