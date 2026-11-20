"""snaglet_sdk — Python SDK shim for the Snaglet sandbox script runner.

Made importable via PYTHONPATH when a script is executed with `snaglet run foo.py`.
Proxies tool calls to the running Snaglet server's POST /api/tools/execute endpoint
so scripts use the same tool layer (validation, auth, safety rails) agents use.

Usage:
    from snaglet_sdk import tools, call_tool

    doc = tools.create_doc(title="Day 1", parent_id="container-...")
    rows = call_tool("database_query", {"sql": "SELECT 1"})

Environment:
    SNAGLET_SERVER_URL  — override server URL (default http://localhost:4001,
                     or serverUrl from ~/.snaglet/config.json)
    SNAGLET_DRY_RUN=1   — print calls instead of executing them
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path


def _resolve_server_url() -> str:
    env = os.environ.get("SNAGLET_SERVER_URL")
    if env:
        return env.rstrip("/")
    cfg_path = Path(os.environ.get("SNAGLET_HOME", Path.home() / ".snaglet")) / "config.json"
    try:
        cfg = json.loads(cfg_path.read_text())
        if isinstance(cfg.get("serverUrl"), str):
            return cfg["serverUrl"].rstrip("/")
    except (OSError, ValueError):
        pass
    return "http://localhost:4001"


SERVER_URL = _resolve_server_url()
DRY_RUN = os.environ.get("SNAGLET_DRY_RUN") == "1"
VERBOSE = os.environ.get("SNAGLET_VERBOSE") == "1"

_call_count = 0


class SnagletToolError(RuntimeError):
    """Raised when a tool call fails (transport, envelope, or tool-level)."""


def call_tool(name: str, tool_input: dict | None = None, dry_run: bool | None = None):
    """Execute a Snaglet tool by name. Returns the tool's output payload."""
    global _call_count
    _call_count += 1
    tool_input = tool_input or {}
    dry = DRY_RUN if dry_run is None else dry_run

    if dry:
        print(f"[dry-run] #{_call_count} {name} {json.dumps(tool_input)}")
        return {"dryRun": True, "tool": name, "input": tool_input}

    if VERBOSE:
        print(f"[snaglet] #{_call_count} {name} {json.dumps(tool_input)}")

    body = json.dumps({"name": name, "input": tool_input}).encode()
    headers = {"Content-Type": "application/json"}
    token = os.environ.get("SNAGLET_SIDECAR_TOKEN")
    if token:
        headers["X-Snaglet-Sidecar-Token"] = token
    req = urllib.request.Request(
        f"{SERVER_URL}/api/tools/execute", data=body, headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            envelope = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            envelope = json.loads(e.read().decode())
            msg = envelope.get("error", f"HTTP {e.code}")
        except ValueError:
            msg = f"HTTP {e.code}"
        raise SnagletToolError(f'tool "{name}" request failed: {msg}') from None
    except urllib.error.URLError as e:
        raise SnagletToolError(
            f"cannot reach Snaglet server at {SERVER_URL} — is it running? ({e.reason})"
        ) from None

    if envelope.get("success") is False:
        raise SnagletToolError(f'tool "{name}" request failed: {envelope.get("error", "unknown")}')

    result = envelope.get("data")
    if isinstance(result, dict) and result.get("success") is False:
        raise SnagletToolError(f'tool "{name}" failed: {result.get("error", "unknown error")}')
    output = result["output"] if isinstance(result, dict) and "output" in result else result
    # Tool outputs are often JSON serialized as strings — parse for ergonomic access
    if isinstance(output, str):
        trimmed = output.strip()
        if trimmed.startswith("{") or trimmed.startswith("["):
            try:
                return json.loads(trimmed)
            except ValueError:
                pass
    return output


def list_tools():
    """List all tools registered on the server."""
    req = urllib.request.Request(f"{SERVER_URL}/api/tools")
    with urllib.request.urlopen(req, timeout=30) as resp:
        envelope = json.loads(resp.read().decode())
    if envelope.get("success") is False:
        raise SnagletToolError(f"failed to list tools: {envelope.get('error', 'unknown')}")
    return envelope.get("data")


class _ToolsProxy:
    """tools.any_tool_name(**kwargs) -> call_tool('any_tool_name', kwargs)"""

    def __init__(self, dry: bool | None = None):
        self._dry = dry

    @property
    def dry(self) -> "_ToolsProxy":
        return _ToolsProxy(dry=True)

    @property
    def real(self) -> "_ToolsProxy":
        return _ToolsProxy(dry=False)

    def __getattr__(self, name: str):
        if name.startswith("_"):
            raise AttributeError(name)

        def _invoke(_input: dict | None = None, **kwargs):
            payload = _input if _input is not None else kwargs
            return call_tool(name, payload, dry_run=self._dry)

        return _invoke


tools = _ToolsProxy()
args = sys.argv[1:]
