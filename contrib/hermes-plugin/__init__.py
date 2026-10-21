from __future__ import annotations

import json
import logging
import os
import threading
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider, RecallStatus, spawn_context_thread

logger = logging.getLogger(__name__)

DEFAULT_API_URL = "http://127.0.0.1:3100"

# Tool prefix so the model can tell these came from minimem.
PREFIX = "minimem_"

# MCP tool catalog (name -> description/inputSchema), mirrored from minimem server.ts.
# Kept here so tool discovery is explicit and grep-able (single source of truth is
# the server's MCP_TOOLS list; this table is a copy for the Hermes layer).
MCP_TOOLS = [
    {"name": "memory_save", "description": "Store one durable fact. Dedupes identical text and returns the existing id.", "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}, "tags": {"type": "array", "items": {"type": "string"}}, "agent": {"type": "string"}}, "required": ["text"]}},
    {"name": "memory_search", "description": "Search memories. Default is hybrid (keyword + semantic + recency); mode='keyword' forces the pure trigram path. Results carry score, cos, age_days, trust and agent_source so you can judge freshness before trusting a memory.", "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}, "limit": {"type": "number"}, "tag": {"type": "string"}, "mode": {"type": "string", "enum": ["hybrid", "keyword"]}, "trust": {"type": "string", "enum": ["verified", "unverified", "disputed"]}}, "required": ["query"]}},
    {"name": "memory_recall", "description": "Hybrid recall with provenance: which signal found each memory, how old it is, who said it, how much to trust it, and which older near-duplicates it supersedes (shadowed). Use when a plain search feels off or too old.", "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}, "limit": {"type": "number"}, "tag": {"type": "string"}, "mode": {"type": "string", "enum": ["hybrid", "keyword"]}, "trust": {"type": "string", "enum": ["verified", "unverified", "disputed"]}}, "required": ["query"]}},
    {"name": "memory_trust", "description": "Set trust (verified|unverified|disputed) and/or agent_source on an existing memory. Never changes the text.", "inputSchema": {"type": "object", "properties": {"id": {"type": "number"}, "trust": {"type": "string"}, "agent": {"type": "string"}}, "required": ["id"]}},
    {"name": "memory_recent", "description": "Newest memories, optionally filtered by tag and paged.", "inputSchema": {"type": "object", "properties": {"limit": {"type": "number"}, "offset": {"type": "number"}, "tag": {"type": "string"}}}},
    {"name": "memory_forget", "description": "Soft-delete a memory (recoverable from /memories/deleted).", "inputSchema": {"type": "object", "properties": {"id": {"type": "number"}, "agent": {"type": "string"}}, "required": ["id"]}},
    {"name": "lesson_save", "description": "Record a durable 'do it this way' rule learned while working.", "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}, "scope": {"type": "string"}}, "required": ["text"]}},
    {"name": "lesson_list", "description": "List lessons, optionally scoped to a project or tool.", "inputSchema": {"type": "object", "properties": {"scope": {"type": "string"}, "limit": {"type": "number"}}}},
    {"name": "handoff_write", "description": "Leave a note for another agent (or your future self).", "inputSchema": {"type": "object", "properties": {"from": {"type": "string"}, "to": {"type": "string"}, "topic": {"type": "string"}, "body": {"type": "string"}, "refs": {"type": "array"}}, "required": ["from", "to", "body"]}},
    {"name": "handoff_read", "description": "Read handoffs addressed to you. unacked=false includes already-acked ones.", "inputSchema": {"type": "object", "properties": {"agent": {"type": "string"}, "unacked": {"type": "boolean"}, "limit": {"type": "number"}}, "required": ["agent"]}},
    {"name": "handoff_ack", "description": "Mark a handoff as done.", "inputSchema": {"type": "object", "properties": {"agent": {"type": "string"}, "id": {"type": "number"}}, "required": ["agent", "id"]}},
    {"name": "lease_acquire", "description": "Take a named lock so two agents do not edit the same thing. Returns held_by if someone else has it.", "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}, "holder": {"type": "string"}, "note": {"type": "string"}, "ttl_minutes": {"type": "number"}}, "required": ["name", "holder"]}},
    {"name": "lease_release", "description": "Release a lease you hold.", "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}, "holder": {"type": "string"}}, "required": ["name", "holder"]}},
    {"name": "crystal_save", "description": "Store a merged/summarised memory (the long-term view).", "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}, "sources": {"type": "array"}}, "required": ["text"]}},
    {"name": "memory_stats", "description": "Counts of memories, handoffs, leases, lessons, crystals, audit rows.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "memory_supersede", "description": "Declare that two memories state the SAME fact, so only the current one is recalled. Use this when you write a corrected, updated or final version of something you already stored — it is the only way the store learns that the older memory is stale. Without it the older one keeps being recalled as if it were current.", "inputSchema": {"type": "object", "properties": {"current": {"type": "number", "description": "id of the memory that is up to date"}, "other": {"type": "number", "description": "id of the memory it replaces"}, "reason": {"type": "string", "description": "why they are the same fact"}}, "required": ["current", "other"]}},
]
# Map MCP tool name -> fields to forward in the Hermes tool schema.
def _hermes_schema(name: str, desc: str, schema: Dict[str, Any]) -> Dict[str, Any]:
    """Wrap an MCP inputSchema into a Hermes tool schema ({\"name\", \"description\", \"parameters\"})."""
    return {
        "name": f"{PREFIX}{name}",
        "description": desc,
        "parameters": schema,
    }


def register(ctx) -> None:
    ctx.register_memory_provider(MinimemMemoryProvider())


class MinimemMemoryProvider(MemoryProvider):
    """minimem local memory store — search-backed recall over the REST API,
    with full MCP tool coverage (memory/lesson/handoff/lease/crystal)."""

    name = "minimem"

    def __init__(self) -> None:
        self._api_url = DEFAULT_API_URL
        self._token: Optional[str] = None
        self._timeout = 5.0
        self._prefetch_result = ""
        self._prefetch_count = 0
        self._prefetch_lock = threading.Lock()
        self._last_status: Optional[RecallStatus] = None

    # -- Lifecycle ----------------------------------------------------------

    def _load_config(self) -> Dict[str, Any]:
        """Profile-scoped env, then process env (single-profile layout)."""
        from agent.secret_scope import get_secret_str

        return {
            "api_url": get_secret_str("MINIMEM_URL", DEFAULT_API_URL) or DEFAULT_API_URL,
            "token": get_secret_str("MCP_MINIMEM_API_KEY", ""),
            "timeout": float(os.environ.get("MINIMEM_TIMEOUT", "5")),
        }

    def is_available(self) -> bool:
        try:
            cfg = self._load_config()
            self._api_url = cfg["api_url"]
            self._token = cfg["token"]
            self._timeout = cfg["timeout"]
            return bool(self._token)
        except Exception:
            return False

    def unavailable_reason(self) -> str:
        if not self._token:
            return "MCP_MINIMEM_API_KEY not set — set the token in ~/.hermes/.env"
        return ""

    def initialize(self, session_id: str, **kwargs) -> None:
        # Config is read defensively at every call site; nothing to keep alive here.
        pass

    # -- Recall -------------------------------------------------------------

    def system_prompt_block(self) -> str:
        return ""

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        if not query or not query.strip():
            return ""
        with self._prefetch_lock:
            return self._prefetch_result

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        if not query or not query.strip():
            return
        thread = spawn_context_thread(
            self._do_prefetch, name="minimem-prefetch", args=(query,)
        )
        thread.start()

    def _do_prefetch(self, query: str) -> None:
        try:
            results = self._rest_search(query, limit=5)
            if not results:
                with self._prefetch_lock:
                    self._prefetch_result = ""
                    self._prefetch_count = 0
                    self._last_status = None
                return
            lines = [
                f"- {r['text'].strip()[:400]}" for r in results if r.get("text")
            ]
            block = "**minimem recall**\n" + "\n".join(lines)
            with self._prefetch_lock:
                self._prefetch_result = block
                self._prefetch_count = len(results)
                self._last_status = RecallStatus(
                    provider_label="minimem", count=len(results)
                )
        except Exception as exc:
            logger.warning("minimem prefetch failed: %s", exc)
            with self._prefetch_lock:
                self._prefetch_result = ""
                self._prefetch_count = 0
                self._last_status = None

    def recall_status(self) -> Optional[RecallStatus]:
        with self._prefetch_lock:
            return self._last_status

    # -- Turn sync ----------------------------------------------------------

    def sync_turn(self, user_content: str, assistant_content: str, **kwargs) -> None:
        # Disabled: minimem stores user-declared memories; auto-retaining turns
        # would flood the store with chat noise. Writes come from tools only.
        return

    # -- Tools --------------------------------------------------------------

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [
            _hermes_schema(t["name"], t["description"], t["inputSchema"])
            for t in MCP_TOOLS
        ]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        if not tool_name.startswith(PREFIX):
            raise NotImplementedError(f"minimem does not handle tool {tool_name}")
        mcp_name = tool_name[len(PREFIX):]
        try:
            result = self._rpc("tools/call", {"name": mcp_name, "arguments": args or {}})
            # MCP returns {content:[{type:"text",text:"<json>"}], isError?:bool}
            if isinstance(result, dict) and result.get("isError"):
                return json.dumps({"success": False, "error": self._mcp_text(result)}, ensure_ascii=False)
            return self._mcp_text(result)
        except Exception as exc:
            return json.dumps({"success": False, "error": str(exc)})

    # -- HTTP client --------------------------------------------------------

    def _headers(self) -> Dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self._token:
            h["Authorization"] = f"Bearer {self._token}"
        return h

    def _request(self, method: str, path: str, body: Optional[Dict[str, Any]] = None) -> Any:
        cfg = self._load_config()
        self._api_url = cfg["api_url"]
        self._token = cfg["token"]
        self._timeout = cfg["timeout"]
        url = f"{cfg['api_url']}{path}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers=self._headers())
        with urllib.request.urlopen(req, timeout=self._timeout) as resp:
            return json.loads(resp.read().decode())

    def _rpc(self, method: str, params: Dict[str, Any], request_id: int = 1) -> Any:
        """Call the minimem MCP endpoint (/mcp JSON-RPC) and return the result."""
        body = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
        resp = self._request("POST", "/mcp", body)
        if isinstance(resp, dict) and "error" in resp:
            raise RuntimeError(f"minimem MCP {method}: {resp['error']}")
        if isinstance(resp, dict) and "result" in resp:
            return resp["result"]
        raise RuntimeError(f"minimem MCP {method}: unexpected response {resp!r}")

    @staticmethod
    def _mcp_text(result: Any) -> str:
        """Extract the JSON text payload from an MCP tool result."""
        if isinstance(result, dict):
            content = result.get("content")
            if isinstance(content, list):
                parts = []
                for c in content:
                    if isinstance(c, dict) and c.get("type") == "text":
                        parts.append(c.get("text", ""))
                if parts:
                    return "\n".join(parts)
        return json.dumps(result, ensure_ascii=False) if result is not None else ""

    # -- REST helpers (recall/prefetch use the faster REST search) ----------

    def _rest_search(self, query: str, limit: int = 5) -> List[Dict[str, Any]]:
        from urllib.parse import quote

        results = self._request(
            "GET", f"/memories/search?q={quote(query)}&limit={limit}"
        )
        if not isinstance(results, list):
            return []
        return results

    def shutdown(self) -> None:
        pass
