"""One vision-model call with a hard timeout and a retry, shared by the tools.

    from llm_call import ask
    text = ask(llm.get_model(model_id), prompt, png_bytes, ".png")

Standard library here; the caller's script declares `llm` and its plugins
(keys come from `llm keys set ...`, the shared llm user directory).
"""
from __future__ import annotations

import os
import re
import sys
import tempfile
import threading

LLM_TIMEOUT = 240  # seconds per attempt


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def ask(model, prompt: str, data: bytes, suffix: str, attempts: int = 2, timeout: int = LLM_TIMEOUT) -> str:
    """Send `prompt` with `data` attached (a file ending in `suffix`, such as
    ".pdf" or ".png") and return the answer, stripped, without a markdown fence
    around it. The HTTP client underneath can sit on a half-closed connection
    for ten minutes per retry, so each attempt runs in a daemon thread we are
    free to abandon after `timeout` seconds. SystemExit when every attempt fails."""
    import llm

    # The system temp directory, never Desktop/Documents/Downloads: macOS asks
    # for consent there, and a command run from the pen menu cannot answer.
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(data)
        tmp = f.name
    try:
        text = ""
        for attempt in range(1, attempts + 1):
            box: dict[str, object] = {}

            def call() -> None:
                try:
                    box["text"] = model.prompt(prompt, attachments=[llm.Attachment(path=tmp)], stream=False).text()
                except Exception as e:  # noqa: BLE001 - reported below
                    box["error"] = e

            t = threading.Thread(target=call, daemon=True)
            t.start()
            t.join(timeout)
            if "text" in box:
                text = str(box["text"])
                break
            why = f"{box['error']}" if "error" in box else f"no answer after {timeout}s"
            if attempt < attempts:
                log(f"model call failed ({why}); trying again…")
            else:
                raise SystemExit(f"model call failed: {why}")
    finally:
        os.unlink(tmp)
    text = text.strip()
    # Some models wrap the answer in a fence.
    m = re.match(r"^```(?:markdown|md)?\s*\n(.*)\n```$", text, re.S)
    if m:
        text = m.group(1).strip()
    return text
