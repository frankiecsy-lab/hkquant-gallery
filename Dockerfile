# hkquant-gallery 镜像：python:3.12-slim 单容器（FastAPI 同时服务 API 与静态页面）。
# 服务器内存有限（1.6G），刻意不引入 nginx 边车与前端构建链。
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    GALLERY_FTP_ROOT=/srv/ftp \
    GALLERY_DATA_DIR=/data

WORKDIR /srv/app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY web ./web

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
