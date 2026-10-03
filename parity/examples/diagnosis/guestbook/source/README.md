# sample-app

데모용 방명록 앱 (윤선). 표준 라이브러리만 사용 (`http.server` + `sqlite3`).

`parity/`가 결함을 실제로 잡아내는지 보여주기 위해, 운영 환경에서 흔한 결함 3개를 **일부러** 넣었습니다.

| 결함 | 재시작하면 |
|---|---|
| 세션을 프로세스 메모리에 저장 | 로그인이 풀림 (`/me` 401) |
| 시작할 때마다 `DROP TABLE` | 글 목록이 비워짐 (`/posts`) |
| 업로드를 볼륨이 아닌 컨테이너 내부 `/app/uploads`에 저장 | `docker restart`로는 남지만, 컨테이너를 다시 만들면 사라짐 |

```bash
docker build -t guestbook:1 .
docker run -d --name guestbook -p 8080:8080 guestbook:1
curl http://localhost:8080/healthz
```

- 엔드포인트 목록은 `app.py` 맨 위 설명에 있습니다.
- `TLS_CERT`/`TLS_KEY` 환경변수를 주면 HTTPS로 뜹니다 (`parity verify`의 https 테스트용).
- 기록·재생 데모는 `parity/`에서 `scripts/demo.ps1`(Windows) 또는 `bash scripts/demo.sh`로 실행합니다.
