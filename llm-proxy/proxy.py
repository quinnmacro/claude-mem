"""
LLM Fallback Proxy — OpenAI-compatible endpoint with automatic provider switching.
Receives /v1/chat/completions and tries providers in order: DashScope → OpenRouter → Gemini.

Error classification:
  - 401/403 → auth_invalid (switch immediately, credentials won't self-heal)
  - 429 with quota marker → quota_exhausted (hard limit, switch immediately)
  - 429 without quota → rate_limit (retry with backoff then switch)
  - 5xx → transient (retry up to 3 times on same provider, then switch)
"""

import os
import time
import json
import logging
import asyncio
from typing import Optional, Dict, Any, List
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
import httpx
import uvicorn

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Provider configs — read from env
PROVIDERS: List[Dict[str, Any]] = []

def _load_providers():
    global PROVIDERS
    # Primary: DashScope (qwen-plus via OpenAI-compatible)
    dashscope_url = os.getenv("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
    dashscope_key = os.getenv("DASHSCOPE_API_KEY", "")
    dashscope_model = os.getenv("DASHSCOPE_MODEL", "qwen-plus")
    if dashscope_key:
        PROVIDERS.append({
            "label": "dashscope",
            "base_url": dashscope_url.rstrip("/"),
            "api_key": dashscope_key,
            "model": dashscope_model,
            "max_retries": 3,
        })

    # Fallback 1: OpenRouter
    openrouter_url = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
    openrouter_key = os.getenv("OPENROUTER_API_KEY", "")
    openrouter_model = os.getenv("OPENROUTER_MODEL", "anthropic/claude-3.5-sonnet")
    if openrouter_key:
        PROVIDERS.append({
            "label": "openrouter",
            "base_url": openrouter_url.rstrip("/"),
            "api_key": openrouter_key,
            "model": openrouter_model,
            "max_retries": 2,
        })

    # Fallback 2: Gemini (OpenAI-compatible mode)
    gemini_url = os.getenv("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai")
    gemini_key = os.getenv("GEMINI_API_KEY", "")
    gemini_model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    if gemini_key:
        PROVIDERS.append({
            "label": "gemini",
            "base_url": gemini_url.rstrip("/"),
            "api_key": gemini_key,
            "model": gemini_model,
            "max_retries": 2,
        })

    logger.info(f"Loaded {len(PROVIDERS)} LLM providers: {[p['label'] for p in PROVIDERS]}")

_load_providers()

# Error classification
def classify_error(status_code: int, body: str) -> str:
    lower = body.lower()
    if any(marker in lower for marker in ["quota exceeded", "resource_exhausted", "insufficient_quota", "insufficient credits"]):
        return "quota_exhausted"
    if status_code in (401, 403):
        return "auth_invalid"
    if status_code == 429:
        return "rate_limit"
    if 500 <= status_code < 600:
        return "transient"
    return "unrecoverable"

def should_switch_provider(kind: str) -> bool:
    return kind in ("quota_exhausted", "auth_invalid")

app = FastAPI(title="LLM Fallback Proxy", version="1.0.0")

@app.get("/health")
async def health():
    return {"status": "healthy", "providers": [p["label"] for p in PROVIDERS]}

@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    body = await request.body()
    payload = json.loads(body)

    # Use the model from the request if it's our internal model name,
    # otherwise fall back to the provider's default model
    requested_model = payload.get("model", "")

    headers_src = dict(request.headers)
    # Remove host and content-length to avoid conflicts
    headers_src.pop("host", None)
    headers_src.pop("content-length", None)
    headers_src.pop("transfer-encoding", None)

    for provider in PROVIDERS:
        # Build request for this provider
        proxy_payload = {**payload}
        if requested_model and not requested_model.startswith(("qwen", "gemini", "anthropic/", "claude")):
            proxy_payload["model"] = provider["model"]
        elif not requested_model:
            proxy_payload["model"] = provider["model"]

        proxy_headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {provider['api_key']}",
        }
        # OpenRouter-specific headers
        if provider["label"] == "openrouter":
            site_url = os.getenv("OPENROUTER_SITE_URL", "")
            app_name = os.getenv("OPENROUTER_APP_NAME", "llm-proxy")
            if site_url:
                proxy_headers["HTTP-Referer"] = site_url
            proxy_headers["X-Title"] = app_name

        url = f"{provider['base_url']}/chat/completions"
        max_retries = provider["max_retries"]

        for attempt in range(max_retries):
            try:
                async with httpx.AsyncClient(timeout=120.0) as client:
                    # Check if streaming is requested
                    is_stream = proxy_payload.get("stream", False)

                    if is_stream:
                        resp = await client.stream("POST", url, content=json.dumps(proxy_payload), headers=proxy_headers)
                        # Check status before streaming
                        if resp.status_code >= 400:
                            body_text = ""
                            chunks = []
                            async for chunk in resp.aiter_text():
                                chunks.append(chunk)
                                body_text += chunk
                            kind = classify_error(resp.status_code, body_text)
                            if should_switch_provider(kind) or (kind == "transient" and attempt == max_retries - 1):
                                logger.warning(f"Provider '{provider['label']}' failed with {kind} (status {resp.status_code}), switching")
                                break  # retry inner loop → next attempt, but should_switch means we should try next provider
                            if kind == "transient" and attempt < max_retries - 1:
                                await asyncio.sleep(2 ** attempt)
                                continue
                            # Non-switchable error on last retry
                            return JSONResponse(status_code=resp.status_code, content=json.loads(body_text) if body_text else {"error": body_text})

                        # Stream successfully — relay chunks
                        async def stream_response():
                            async for chunk in resp.aiter_bytes():
                                yield chunk

                        return StreamingResponse(stream_response(), media_type="text/event-stream")

                    else:
                        resp = await client.post(url, content=json.dumps(proxy_payload), headers=proxy_headers)
                        if resp.status_code < 400:
                            return JSONResponse(status_code=resp.status_code, content=resp.json())

                        body_text = resp.text
                        kind = classify_error(resp.status_code, body_text)

                        if should_switch_provider(kind):
                            logger.warning(f"Provider '{provider['label']}' failed with {kind} (status {resp.status_code}), switching to next provider")
                            break  # exit retry loop, will try next provider

                        if kind == "transient" and attempt < max_retries - 1:
                            logger.info(f"Provider '{provider['label']}' transient error (status {resp.status_code}), retrying (attempt {attempt + 1}/{max_retries})")
                            await asyncio.sleep(2 ** attempt)
                            continue

                        # rate_limit or unrecoverable on last retry
                        if kind == "rate_limit" and attempt < max_retries - 1:
                            retry_after = resp.headers.get("retry-after")
                            wait = float(retry_after) if retry_after else 2 ** attempt
                            logger.info(f"Provider '{provider['label']}' rate limited, waiting {wait}s before retry")
                            await asyncio.sleep(wait)
                            continue

                        # Final failure for this provider
                        logger.error(f"Provider '{provider['label']}' failed with {kind} after {attempt + 1} attempts")
                        try:
                            error_body = resp.json()
                        except:
                            error_body = {"error": body_text}
                        return JSONResponse(status_code=resp.status_code, content=error_body)

            except (httpx.ConnectError, httpx.TimeoutException) as e:
                logger.warning(f"Provider '{provider['label']}' network error: {e}")
                if attempt < max_retries - 1:
                    await asyncio.sleep(2 ** attempt)
                    continue
                # Network error on last retry — try next provider
                break

    # All providers failed
    logger.error("All LLM providers failed")
    return JSONResponse(status_code=503, content={"error": "All LLM providers exhausted"})

if __name__ == "__main__":
    port = int(os.getenv("LLM_PROXY_PORT", "8090"))
    uvicorn.run("proxy:app", host="0.0.0.0", port=port, workers=1)