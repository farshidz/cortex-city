#!/usr/bin/env python3
"""Guarded client for the UI-visible Cortex City API."""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urljoin, urlparse
from urllib.request import Request, urlopen


DEFAULT_BASE_URL = "http://localhost:3001/"
TASK_STATUSES = frozenset({"open", "in_progress", "in_review", "merged", "closed"})
ISSUE_STATUSES = frozenset({"open", "in_progress", "done", "closed"})
PRIORITIES = frozenset({"low", "medium", "high"})
RUNTIMES = frozenset({"claude", "codex"})
EFFORTS = frozenset(
    {"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}
)
PERMISSION_MODES = frozenset(
    {"bypassPermissions", "acceptEdits", "auto", "default", "yolo"}
)
PROMPT_MODES = frozenset({"initial", "review", "cleanup"})
REVIEW_DECISIONS = frozenset({"approve", "request-changes", "comment"})


@dataclass(frozen=True)
class Operation:
    method: str
    path: str
    description: str
    needs_id: bool = False
    allowed_query: frozenset[str] = field(default_factory=frozenset)
    required_query: frozenset[str] = field(default_factory=frozenset)
    allowed_body: frozenset[str] = field(default_factory=frozenset)
    required_body: frozenset[str] = field(default_factory=frozenset)
    body_required: bool = False
    query_values: dict[str, frozenset[str]] = field(default_factory=dict)
    body_values: dict[str, frozenset[str]] = field(default_factory=dict)
    redact_env: bool = False


OPERATIONS: dict[str, Operation] = {
    "tasks.list": Operation(
        "GET", "/api/tasks", "List tasks", allowed_query=frozenset({"status"}),
        query_values={"status": TASK_STATUSES},
    ),
    "tasks.get": Operation(
        "GET", "/api/tasks/{id}", "Get a task", needs_id=True
    ),
    "tasks.create": Operation(
        "POST", "/api/tasks", "Create a task",
        allowed_body=frozenset({
            "title", "description", "plan", "agent", "branch_name", "agent_runner",
            "permission_mode", "reviewer_agent_enabled", "model", "effort", "issue_id",
        }),
        required_body=frozenset({"title", "agent"}), body_required=True,
        body_values={
            "agent_runner": RUNTIMES,
            "permission_mode": PERMISSION_MODES,
            "effort": EFFORTS,
        },
    ),
    "tasks.update": Operation(
        "PUT", "/api/tasks/{id}", "Edit task fields, status, pause state, or notes", needs_id=True,
        allowed_body=frozenset({
            "title", "description", "plan", "agent", "agent_runner", "permission_mode",
            "reviewer_agent_enabled", "model", "effort", "status", "paused", "notes",
        }),
        body_required=True,
        body_values={
            "agent_runner": RUNTIMES, "permission_mode": PERMISSION_MODES,
            "effort": EFFORTS, "status": TASK_STATUSES,
        },
    ),
    "tasks.delete": Operation("DELETE", "/api/tasks/{id}", "Delete a task", needs_id=True),
    "tasks.instruct": Operation(
        "POST", "/api/tasks/{id}/instruction", "Queue a manual task instruction", needs_id=True,
        allowed_body=frozenset({"instruction"}), required_body=frozenset({"instruction"}),
        body_required=True,
    ),
    "tasks.session": Operation(
        "GET", "/api/tasks/{id}/session", "Read a task session transcript", needs_id=True,
    ),
    "issues.list": Operation(
        "GET", "/api/issues", "List issues",
        allowed_query=frozenset({"show_resolved", "page", "page_size"}),
        query_values={"show_resolved": frozenset({"true", "false"})},
    ),
    "issues.get": Operation("GET", "/api/issues/{id}", "Get an issue", needs_id=True),
    "issues.create": Operation(
        "POST", "/api/issues", "Create an issue",
        allowed_body=frozenset({"title", "description", "plan", "priority"}),
        required_body=frozenset({"title"}), body_required=True,
        body_values={"priority": PRIORITIES},
    ),
    "issues.update": Operation(
        "PUT", "/api/issues/{id}", "Edit issue fields, status, or priority", needs_id=True,
        allowed_body=frozenset({"title", "description", "plan", "status", "priority"}),
        body_required=True,
        body_values={"status": ISSUE_STATUSES, "priority": PRIORITIES},
    ),
    "issues.comment": Operation(
        "POST", "/api/issues/{id}/comments", "Add an issue comment", needs_id=True,
        allowed_body=frozenset({"body"}), required_body=frozenset({"body"}), body_required=True,
    ),
    "issues.delete": Operation("DELETE", "/api/issues/{id}", "Delete an issue", needs_id=True),
    "sessions.list": Operation("GET", "/api/sessions", "List active sessions"),
    "sessions.kill": Operation(
        "POST", "/api/sessions", "Kill an active task or review session",
        allowed_body=frozenset({"task_id", "kind", "run_kind"}),
        required_body=frozenset({"task_id"}), body_required=True,
        body_values={
            "kind": frozenset({"task", "review"}),
            "run_kind": frozenset({"review", "review_retro"}),
        },
    ),
    "orchestrator.status": Operation("GET", "/api/orchestrator", "Get worker status"),
    "orchestrator.poll": Operation("POST", "/api/orchestrator", "Request a worker poll"),
    "reviews.list": Operation("GET", "/api/reviews", "List inbound review summaries"),
    "reviews.regenerate": Operation(
        "POST", "/api/reviews/summarize", "Regenerate a cached PR review summary",
        allowed_body=frozenset({"pr_url", "runtime", "effort", "model"}),
        required_body=frozenset({"pr_url"}), body_required=True,
        body_values={"runtime": RUNTIMES, "effort": EFFORTS},
    ),
    "reviews.followups": Operation(
        "GET", "/api/reviews/followup", "List review follow-ups",
        allowed_query=frozenset({"pr_url"}), required_query=frozenset({"pr_url"}),
    ),
    "reviews.followup": Operation(
        "POST", "/api/reviews/followup", "Ask a review follow-up question",
        allowed_body=frozenset({"pr_url", "question"}),
        required_body=frozenset({"pr_url", "question"}), body_required=True,
    ),
    "reviews.submit": Operation(
        "POST", "/api/reviews/submit", "Submit a GitHub PR review or comment",
        allowed_body=frozenset({"pr_url", "decision", "body"}),
        required_body=frozenset({"pr_url", "decision"}), body_required=True,
        body_values={"decision": REVIEW_DECISIONS},
    ),
    "config.get": Operation("GET", "/api/config", "Read global configuration"),
    "review-learnings.get": Operation(
        "GET", "/api/reviews/learnings", "Read shared reviewer learnings",
    ),
    "prompts.get": Operation("GET", "/api/prompts", "Read prompt templates"),
    "agent-prompt.get": Operation(
        "GET", "/api/agents/{id}/prompt", "Read an agent prompt", needs_id=True,
        allowed_query=frozenset({"mode"}), query_values={"mode": PROMPT_MODES},
    ),
    "agent-env.get": Operation(
        "GET", "/api/agents/{id}/env", "List an agent's environment keys with redacted values",
        needs_id=True, redact_env=True,
    ),
    "agent-status.get": Operation(
        "GET", "/api/agent-status", "Read runtime quota status"
    ),
    "cortex-git.get": Operation("GET", "/api/cortex-git", "Read Cortex City git status"),
}


def fail(message: str) -> None:
    raise ValueError(message)


def parse_query(items: list[str]) -> dict[str, str]:
    query: dict[str, str] = {}
    for item in items:
        if "=" not in item:
            fail(f"query value must use key=value syntax: {item!r}")
        key, value = item.split("=", 1)
        if not key:
            fail("query key cannot be empty")
        if key in query:
            fail(f"duplicate query key: {key}")
        query[key] = value
    return query


def load_body(data: str | None, data_file: str | None) -> dict[str, Any] | None:
    if data is None and data_file is None:
        return None
    if data_file == "-":
        raw = sys.stdin.read()
    elif data_file is not None:
        raw = Path(data_file).read_text(encoding="utf-8")
    else:
        raw = data or ""
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        fail("request JSON must be an object")
    return parsed


def validate_query(spec: Operation, query: dict[str, str]) -> None:
    unknown = set(query) - spec.allowed_query
    if unknown:
        fail(f"unsupported query fields: {', '.join(sorted(unknown))}")
    missing = spec.required_query - set(query)
    if missing:
        fail(f"missing query fields: {', '.join(sorted(missing))}")
    for key, values in spec.query_values.items():
        if key in query and query[key] not in values:
            fail(f"{key} must be one of: {', '.join(sorted(values))}")
    for key in ("page", "page_size"):
        if key not in query:
            continue
        try:
            number = int(query[key])
        except ValueError:
            fail(f"{key} must be a positive integer")
        if number < 1:
            fail(f"{key} must be a positive integer")
        if key == "page_size" and number > 100:
            fail("page_size must be between 1 and 100")


def validate_body(spec: Operation, body: dict[str, Any] | None) -> None:
    if body is None:
        if spec.body_required:
            fail("this operation requires --data or --data-file")
        return
    if not spec.allowed_body:
        fail("this operation does not accept a JSON body")
    unknown = set(body) - spec.allowed_body
    if unknown:
        fail(f"unsupported body fields: {', '.join(sorted(unknown))}")
    if spec.body_required and not body:
        fail("request JSON must contain at least one field")
    missing = spec.required_body - set(body)
    if missing:
        fail(f"missing body fields: {', '.join(sorted(missing))}")
    for key in spec.required_body:
        value = body.get(key)
        if value is None or (isinstance(value, str) and not value.strip()):
            fail(f"{key} cannot be empty")
    for key, values in spec.body_values.items():
        if key not in body or body[key] is None:
            continue
        if not isinstance(body[key], str) or body[key] not in values:
            fail(f"{key} must be one of: {', '.join(sorted(values))}")
    for key in ("reviewer_agent_enabled", "paused"):
        if key in body and not isinstance(body[key], bool):
            fail(f"{key} must be a JSON boolean")


def normalize_base_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        fail("base URL must be an absolute http:// or https:// URL")
    if parsed.username or parsed.password:
        fail("base URL must not contain credentials")
    if parsed.query or parsed.fragment:
        fail("base URL must not contain a query or fragment")
    if parsed.path not in {"", "/"}:
        fail("base URL must point to the server root")
    return value.rstrip("/") + "/"


def enforce_settings_boundary(method: str, path: str) -> None:
    if method == "GET":
        return
    if path in {"/api/config", "/api/reviews/learnings"}:
        fail(f"global settings writes are prohibited: {method} {path}")
    if path.startswith("/api/agents/") and (
        path.endswith("/prompt") or path.endswith("/env")
    ):
        fail(f"agent settings writes are prohibited: {method} {path}")


def render_payload(raw: bytes, compact: bool, redact_env: bool) -> str:
    text = raw.decode("utf-8", errors="replace")
    if not text:
        return ""
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        return text
    if redact_env and isinstance(value, dict) and isinstance(value.get("vars"), dict):
        value = {**value, "vars": {key: "<redacted>" for key in value["vars"]}}
    if compact:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)


def list_operations() -> None:
    width = max(len(name) for name in OPERATIONS)
    for name, spec in OPERATIONS.items():
        marker = "write" if spec.method != "GET" else "read"
        print(f"{name:<{width}}  {marker:<5}  {spec.description}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", nargs="?", help="Named API operation")
    parser.add_argument("--id", help="Task, issue, or agent ID for operations with {id}")
    parser.add_argument("--query", action="append", default=[], metavar="KEY=VALUE")
    body_group = parser.add_mutually_exclusive_group()
    body_group.add_argument("--data", help="JSON object request body")
    body_group.add_argument("--data-file", help="JSON file path, or - for standard input")
    parser.add_argument(
        "--base-url", default=os.environ.get("CORTEX_CITY_URL", DEFAULT_BASE_URL),
        help=f"Cortex City server root (default: {DEFAULT_BASE_URL})",
    )
    parser.add_argument("--timeout", type=float, default=30.0, help="HTTP timeout in seconds")
    parser.add_argument("--confirm", action="store_true", help="Confirm a mutating operation")
    parser.add_argument(
        "--dry-run", action="store_true", help="Print the request without sending it"
    )
    parser.add_argument("--compact", action="store_true", help="Print compact JSON")
    parser.add_argument("--list-operations", action="store_true", help="List supported operations")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if args.list_operations:
        list_operations()
        return 0
    if not args.operation:
        parser.error("operation is required unless --list-operations is used")
    if args.operation not in OPERATIONS:
        parser.error(f"unknown operation: {args.operation}; use --list-operations")
    if args.timeout <= 0:
        parser.error("--timeout must be positive")

    spec = OPERATIONS[args.operation]
    try:
        query = parse_query(args.query)
        body = load_body(args.data, args.data_file)
        validate_query(spec, query)
        validate_body(spec, body)
        base_url = normalize_base_url(args.base_url)
        if spec.needs_id and not args.id:
            fail("this operation requires --id")
        if not spec.needs_id and args.id:
            fail("this operation does not accept --id")
        path = spec.path.format(id=quote(args.id or "", safe=""))
        enforce_settings_boundary(spec.method, path)
        if spec.method != "GET" and not args.confirm and not args.dry_run:
            fail("mutating operations require --confirm after confirming user intent")
    except (OSError, ValueError, json.JSONDecodeError) as error:
        parser.error(str(error))

    url = urljoin(base_url, path.lstrip("/"))
    if query:
        url = f"{url}?{urlencode(query)}"

    if args.dry_run:
        preview: dict[str, Any] = {"method": spec.method, "url": url}
        if body is not None:
            preview["body"] = body
        print(json.dumps(preview, ensure_ascii=False, indent=2, sort_keys=True))
        return 0

    encoded_body = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"Accept": "application/json"}
    if encoded_body is not None:
        headers["Content-Type"] = "application/json"
    request = Request(url, data=encoded_body, headers=headers, method=spec.method)

    try:
        with urlopen(request, timeout=args.timeout) as response:
            rendered = render_payload(response.read(), args.compact, spec.redact_env)
            if rendered:
                print(rendered)
            return 0
    except HTTPError as error:
        rendered = render_payload(error.read(), args.compact, False)
        print(f"HTTP {error.code} {error.reason}", file=sys.stderr)
        if rendered:
            print(rendered, file=sys.stderr)
        return 1
    except URLError as error:
        print(f"Connection failed: {error.reason}", file=sys.stderr)
        return 1
    except TimeoutError:
        print(f"Connection timed out after {args.timeout:g} seconds", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
