FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MARGIN_BIND_HOST=0.0.0.0
WORKDIR /app
COPY requirements.txt ./
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export PIP_CERT=/run/secrets/build_ca; fi; \
    pip install --no-cache-dir -r requirements.txt \
    && pip check
COPY server.py build.py index.html engine.js engine2.js official.js echarts.min.js ./
COPY licenses/ ./licenses/
RUN python build.py \
    && python build.py --check \
    && mkdir /app/.cache \
    && chown -R 10001:10001 /app
USER 10001:10001
EXPOSE 8848
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import json, urllib.request; assert json.load(urllib.request.urlopen('http://127.0.0.1:8848/api/health', timeout=3))['ok'] is True"
CMD ["python", "server.py", "8848"]
