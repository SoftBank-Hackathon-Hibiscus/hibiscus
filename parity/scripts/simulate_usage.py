"""가상의 사용자가 방명록을 쓰는 흐름 — 요청 20개, 항상 같은 순서.

보통은 기록 프록시(:8081)를 거쳐 실행해서 이 흐름을 기록 파일로 남긴다.
  python scripts/simulate_usage.py --base http://127.0.0.1:8081
"""
import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from http.cookies import SimpleCookie

# 1x1 투명 PNG — 바이너리 본문(기록 시 base64) 경로를 검증하기 위한 것
PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)

STEPS = [
    ("GET", "/posts", None),                                                   # 1  빈 목록
    ("POST", "/login", {"name": "alice"}),                                     # 2  로그인 → 세션 쿠키
    ("GET", "/me", None),                                                      # 3
    ("POST", "/posts", {"author": "alice", "message": "첫 방문 기념!"}),        # 4
    ("POST", "/posts", {"author": "bob", "message": "hello guestbook"}),       # 5
    ("GET", "/posts", None),                                                   # 6
    ("GET", "/posts/1", None),                                                 # 7
    ("PUT", "/uploads/cat.png", PNG_BYTES),                                    # 8  파일 업로드
    ("GET", "/uploads", None),                                                 # 9
    ("GET", "/uploads/cat.png", None),                                         # 10
    ("GET", "/me", None),                                                      # 11
    ("POST", "/posts", {"author": "carol", "message": "재방문했어요"}),         # 12
    ("GET", "/posts", None),                                                   # 13
    ("GET", "/posts/2", None),                                                 # 14
    ("PUT", "/uploads/notes.txt", b"meeting notes\n"),                         # 15
    ("GET", "/uploads", None),                                                 # 16
    ("GET", "/me", None),                                                      # 17
    ("POST", "/logout", {}),                                                   # 18
    ("GET", "/me", None),                                                      # 19 로그아웃 후 401
    ("GET", "/posts", None),                                                   # 20
]

CONTENT_TYPES = {".png": "image/png", ".txt": "text/plain; charset=utf-8"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default=os.environ.get("PARITY_PROXY", "http://127.0.0.1:8081"))
    base = parser.parse_args().base.rstrip("/")

    cookies = {}
    for i, (method, path, payload) in enumerate(STEPS, 1):
        headers = {}
        if isinstance(payload, bytes):
            data = payload
            headers["Content-Type"] = CONTENT_TYPES.get(os.path.splitext(path)[1], "application/octet-stream")
        elif payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        else:
            data = None
        if cookies:
            headers["Cookie"] = "; ".join(f"{k}={v}" for k, v in cookies.items())

        req = urllib.request.Request(base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                status, set_cookies = resp.status, resp.headers.get_all("Set-Cookie") or []
        except urllib.error.HTTPError as e:           # 4xx/5xx 도 정상적인 관찰 대상
            status, set_cookies = e.code, e.headers.get_all("Set-Cookie") or []
        for raw in set_cookies:
            for key, morsel in SimpleCookie(raw).items():
                if morsel.value:
                    cookies[key] = morsel.value
                else:
                    cookies.pop(key, None)
        print(f"#{i:02d} {method:4} {path:20} → {status}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
