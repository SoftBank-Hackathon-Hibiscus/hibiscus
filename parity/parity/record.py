"""1단계: 기록 프록시.

클라이언트 ──▶ [기록 프록시 :8081] ──▶ 대상 서버 (http:// 또는 https://)
프록시는 요청과 응답을 **원본 그대로 전달**하고(전달용), 파일에는 **비밀값을 가린 사본**만 남긴다(저장용).
두 데이터가 섞이지 않도록 저장용은 to_stored() 한 곳에서만 만든다. 가리는 규칙은 redact.py.

기록 한 줄의 형식:
  {"index": 1,                       # 1부터 시작하는 요청 번호
   "request":  {"method": "GET", "path": "/posts", "headers": [[이름, 값], ...],
                "body": "...", "body_encoding": "utf8" | "base64"},
   "response": {"status": 200, "headers": [[이름, 값], ...],
                "body": "...", "body_encoding": "utf8" | "base64"},
   "elapsed_ms": 3.1}
본문은 UTF-8 로 읽히면 글자 그대로, 아니면(이미지 등) base64 로 저장한다.
"""
import base64
import http.client
import json
import ssl
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from .redact import redact_body, redact_headers, redact_path

# 연결 단위 헤더(hop-by-hop)와 프록시가 다시 계산하는 헤더는 전달·기록하지 않는다.
HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "proxy-connection", "te", "trailer", "trailers", "transfer-encoding", "upgrade",
    "host", "content-length",
}


def encode_body(data):
    try:
        return data.decode("utf-8"), "utf8"
    except UnicodeDecodeError:
        return base64.b64encode(data).decode("ascii"), "base64"


def decode_body(part):
    if part.get("body_encoding") == "base64":
        return base64.b64decode(part.get("body") or "")
    return (part.get("body") or "").encode("utf-8")


def load_records(path):
    with open(path, encoding="utf-8") as f:
        records = [json.loads(line) for line in f if line.strip()]
    records.sort(key=lambda r: r["index"])
    return records


def request_label(record):
    """사람이 읽는 요청 이름. 예: 'GET /posts'"""
    return f"{record['request']['method']} {record['request']['path']}"


def header_value(headers, name):
    name = name.lower()
    return next((v for k, v in headers if k.lower() == name), None)


def split_target(target):
    parts = urlsplit(target)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError(f"대상 URL 은 http(s)://호스트[:포트] 형식이어야 합니다: {target!r}")
    return parts.scheme, parts.hostname, parts.port or (443 if parts.scheme == "https" else 80), parts.netloc


def make_ssl_context(target, cafile=None):
    """https 대상이면 인증서를 검증하는 TLS 설정을 만든다. cafile 은 사설 CA 인증서(PEM)."""
    if split_target(target)[0] != "https":
        return None
    return ssl.create_default_context(cafile=cafile)


def send_request(target, method, path, headers, body, timeout=30, ssl_context=None):
    """대상 서버에 요청 1개를 보내고 (status, reason, [[헤더]], 본문bytes) 를 돌려준다.
    요청마다 새 연결을 쓴다 — 재시작 도중 끊긴 keep-alive 연결을 재사용하지 않기 위해서다."""
    scheme, host, port, netloc = split_target(target)
    if scheme == "https":
        conn = http.client.HTTPSConnection(host, port, timeout=timeout,
                                           context=ssl_context or ssl.create_default_context())
    else:
        conn = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        conn.putheader("Host", netloc)
        for name, value in headers:
            conn.putheader(name, value)
        if body or method in ("POST", "PUT", "PATCH"):
            conn.putheader("Content-Length", str(len(body)))
        conn.endheaders(body or None)
        resp = conn.getresponse()
        data = resp.read()
        return resp.status, resp.reason, [[k, v] for k, v in resp.getheaders()], data
    finally:
        conn.close()


def to_stored(method, path, req_headers, req_body, status, resp_headers, resp_body):
    """전달한 원본으로부터 파일에 남길 저장용 사본을 만든다 (비밀값 가림)."""
    req_text, req_enc = encode_body(redact_body(req_body, header_value(req_headers, "content-type")))
    res_text, res_enc = encode_body(redact_body(resp_body, header_value(resp_headers, "content-type")))
    return (
        {"method": method, "path": redact_path(path), "headers": redact_headers(req_headers),
         "body": req_text, "body_encoding": req_enc},
        {"status": status, "headers": redact_headers(resp_headers),
         "body": res_text, "body_encoding": res_enc},
    )


class Recorder:
    """기록 파일에 한 줄씩 추가한다. 여러 스레드에서 불러도 번호가 꼬이지 않게 잠근다."""

    def __init__(self, out_path):
        self._file = open(out_path, "w", encoding="utf-8")
        self._lock = threading.Lock()
        self.count = 0

    def write(self, request, response, elapsed_ms):
        with self._lock:
            self.count += 1
            line = {"index": self.count, "request": request, "response": response,
                    "elapsed_ms": round(elapsed_ms, 1)}
            self._file.write(json.dumps(line, ensure_ascii=False) + "\n")
            self._file.flush()

    def close(self):
        self._file.close()


def make_handler(target, recorder, ssl_context=None):
    class ProxyHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            pass  # 기록 파일이 곧 로그다

        def handle_any(self):
            # ---- 전달용: 받은 그대로 대상 서버에 보낸다 ----
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length > 0 else b""
            headers = [[k, v] for k, v in self.headers.items() if k.lower() not in HOP_BY_HOP]
            started = time.perf_counter()
            try:
                status, reason, resp_headers, resp_body = send_request(
                    target, self.command, self.path, headers, body, ssl_context=ssl_context)
            except (OSError, http.client.HTTPException) as e:
                print(f"[record] 대상 서버 전달 실패 {self.command} {self.path}: {e}", file=sys.stderr)
                self.send_error(502, "upstream unreachable")
                return
            elapsed_ms = (time.perf_counter() - started) * 1000

            # ---- 저장용: 가린 사본만 파일에 쓴다 ----
            recorder.write(*to_stored(self.command, self.path, headers, body,
                                      status, resp_headers, resp_body), elapsed_ms)

            # ---- 전달용: 받은 응답을 그대로 클라이언트에 돌려준다 ----
            self.send_response_only(status, reason)
            for name, value in resp_headers:
                if name.lower() not in HOP_BY_HOP:
                    self.send_header(name, value)
            self.send_header("Content-Length", str(len(resp_body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(resp_body)

        do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = handle_any

    return ProxyHandler


def start_proxy(listen_host, listen_port, target, out_path, ssl_context=None):
    """프록시를 백그라운드 스레드로 띄운다. (server, recorder) 를 돌려준다."""
    split_target(target)  # URL 형식 검사
    recorder = Recorder(out_path)
    server = ThreadingHTTPServer((listen_host, listen_port), make_handler(target, recorder, ssl_context))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, recorder


def record(target, out_path, listen_host, listen_port, command=None, ssl_context=None):
    """프록시를 띄우고 기록한다.
    command 가 있으면 그 명령을 실행하고 끝나는 즉시 기록을 마친다 (명령의 종료 코드를 돌려줌).
    없으면 Ctrl+C 를 누를 때까지 기록한다."""
    server, recorder = start_proxy(listen_host, listen_port, target, out_path, ssl_context)
    proxy_url = f"http://{listen_host}:{server.server_address[1]}"
    print(f"[record] {proxy_url} → {target} 기록 중 → {out_path} (비밀값은 가려서 저장)", file=sys.stderr)
    exit_code = 0
    try:
        if command:
            exit_code = subprocess.run(command).returncode
        else:
            while True:
                time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()
        recorder.close()
    print(f"[record] 요청 {recorder.count}개 기록 완료", file=sys.stderr)
    return exit_code
