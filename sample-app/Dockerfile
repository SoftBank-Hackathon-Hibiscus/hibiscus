FROM python:3.12-slim

WORKDIR /app
# 볼륨(VOLUME)을 선언하지 않는다 — data.db 와 업로드 파일이 컨테이너 쓰기 계층에 남는다 (의도된 결함).
RUN mkdir -p /app/data /app/uploads
COPY app.py /app/app.py

# 바이트코드 캐시를 쓰지 않아 docker diff 결과(facts)에 __pycache__ 잡음이 끼지 않게 한다.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080

EXPOSE 8080
CMD ["python", "/app/app.py"]
