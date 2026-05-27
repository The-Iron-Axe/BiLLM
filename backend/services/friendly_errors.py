from __future__ import annotations


def friendly_api_error(exc: Exception, *, max_len: int = 300) -> str:
    """Map common LLM provider exceptions to short Chinese messages."""
    msg = str(exc).splitlines()[0] if str(exc) else type(exc).__name__
    lower = msg.lower()

    if "incorrect api key" in lower or "invalid api key" in lower or "authentication" in lower:
        return "密钥无效或已过期"
    if "model" in lower and ("not found" in lower or "does not exist" in lower or "unknown" in lower):
        return "模型不存在或当前账户无权使用"
    if "connection" in lower or "connect" in lower or "name or service not known" in lower:
        return "无法连接接口地址，请检查地址是否正确"
    if "timeout" in lower or "timed out" in lower:
        return "连接超时，请检查网络或接口地址"
    if "rate limit" in lower or "429" in lower:
        return "请求过于频繁，请稍后再试"
    if any("\u4e00" <= c <= "\u9fff" for c in msg):
        return msg[:max_len]
    return msg[:max_len]
