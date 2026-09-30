# 개발용 예제(binding). 신뢰된 데모 빌드에만 쓴다. AI 수정 대상이 아니다.
FROM python:3.12-slim
WORKDIR /app
RUN useradd --uid 10001 --no-create-home appuser
COPY app.py /app/app.py
ENV PYTHONUNBUFFERED=1 PORT=8080
USER appuser
EXPOSE 8080
CMD ["python", "/app/app.py"]
