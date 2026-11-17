"""Default-deny tool policy, in code.

Two gates. The first runs at startup: filter_menu keeps only listed tools, so
Claude is never offered anything else. The second runs at call time: check
re-validates every request, so a name the model invents is refused with a
readable reason. Nothing the model reads can change this file.

Demo 2 moves the list to a config file; this phase keeps it on one screen.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any

log = logging.getLogger(__name__)

# Tool name -> kind. "side_effect" tools get a confirmation step in Phase 5;
# "read_only" tools do not. The tag is recorded now so the trace already
# shows which calls would have needed it.
ALLOWED: dict[str, str] = {
    "search_flights": "read_only",
    "get_flight_status": "read_only",
    "search_hotels": "read_only",
    "book_trip": "side_effect",
    "cancel_booking": "side_effect",
}

NOT_LISTED = "not on the host's allow-list"

# Demo 2: POLICY_SOURCE=file reads the list from POLICY_FILE instead, one
# "tool_name kind" per line, # for comments. The code that checks stays the
# same; only where the list comes from changes.
_file_stamp: tuple[int, int] | None = None  # (mtime, size) of the last read
_file_list: dict[str, str] = {}


def allowed() -> dict[str, str]:
    """The allow-list in force right now."""
    if os.environ.get("POLICY_SOURCE", "code") != "file":
        return ALLOWED
    return _allowed_from_file(os.environ["POLICY_FILE"])


def _allowed_from_file(path: str) -> dict[str, str]:
    """Re-read the file only when it changed. A Kubernetes ConfigMap mount
    swaps the file on update, which changes its mtime."""
    global _file_stamp, _file_list
    try:
        stat = os.stat(path)
        stamp = (stat.st_mtime_ns, stat.st_size)
        if stamp != _file_stamp:
            with open(path) as f:
                _file_list = _parse(f.read())
            _file_stamp = stamp
            log.warning("policy loaded from %s: %s", path, ", ".join(sorted(_file_list)) or "(nothing)")
    except OSError as exc:
        # First read: nothing is allowed (default deny). Later: keep the
        # last list that was read correctly.
        log.error("policy file %s unreadable (%s); keeping the previous list", path, exc)
    return _file_list


def _parse(text: str) -> dict[str, str]:
    tools: dict[str, str] = {}
    for line in text.splitlines():
        words = line.split("#", 1)[0].split()
        if len(words) == 2:
            tools[words[0]] = words[1]
        elif words:
            log.error("policy line ignored (want 'tool_name kind'): %r", line)
    return tools


@dataclass(frozen=True)
class Decision:
    allowed: bool
    reason: str
    kind: str | None = None  # read_only / side_effect when allowed


def filter_menu(mcp_tools: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[tuple[str, str, str]]]:
    """Startup gate. Returns (offered tool dicts, blocked as (name, server, reason))."""
    offered, blocked = [], []
    for tool in mcp_tools:
        if tool["name"] in allowed():
            offered.append(tool)
        else:
            blocked.append((tool["name"], tool["server"], NOT_LISTED))
    return offered, blocked


def check(tool_name: str, args: dict[str, Any]) -> Decision:
    """Call-time gate.

    `args` is unused today but is part of the contract: Phase 5 will look at
    it (for example, refusing cancel_booking on an id the user never saw).
    """
    kind = allowed().get(tool_name)
    if kind is None:
        return Decision(allowed=False, reason=f"Tool '{tool_name}' is {NOT_LISTED}, so it was not run.")
    return Decision(allowed=True, reason=f"'{tool_name}' is allowed ({kind}).", kind=kind)
