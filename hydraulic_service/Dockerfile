FROM python:3.12.14-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SAINS_STAGING_ENV=STAGING \
    SAINS_CONTAINER_MODE=1 \
    SAINS_STAGING_PORT=8765 \
    SAINS_STAGING_DB=/tmp/sains-test-ephemeral.sqlite

WORKDIR /app
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --requirement requirements.txt
COPY service.py job_worker.py durable_jobs.py reference_model.py staging_server.py ./

USER 10001:10001
EXPOSE 8765
CMD ["python", "staging_server.py"]
