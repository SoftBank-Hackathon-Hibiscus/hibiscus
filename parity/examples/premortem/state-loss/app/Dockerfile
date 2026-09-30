# 개발용 예제(state-loss). 신뢰된 데모 빌드에만 쓴다.
FROM python:3.12-slim
WORKDIR /app
RUN useradd --uid 10001 --no-create-home appuser && mkdir -p /app/data && chown appuser /app/data
COPY app.py /app/app.py
ENV PYTHONUNBUFFERED=1 PORT=8000 DATA_DIR=/app/data
USER appuser
EXPOSE 8000
CMD ["python", "/app/app.py"]
