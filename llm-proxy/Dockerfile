FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir fastapi uvicorn httpx

COPY proxy.py .

EXPOSE 8090

CMD ["python", "proxy.py"]