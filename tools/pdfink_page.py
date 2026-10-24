"""Talk to the pdfink page from a pen-menu command. Standard library only.

    import pdfink_page
    page = pdfink_page.connect()
    page.toast(f"{len(page.selection_ink())} strokes selected")

pdfink gives each command run a Unix socket ($PDFINK_SOCKET) that relays
newline-delimited JSON to the browser page (see server/bridge.ts). A Page holds
one connection to it; its methods mirror window.pdfink (src/pdfink-api.ts) with
snake_case names, and call(name, *args) or eval(js) reach anything else.

Errors:
  PageGone   no page to talk to: $PDFINK_SOCKET is unset, the socket is dead or
             closed, or the server answered "page gone".
  PageError  the page answered a call with an error (an unknown method, "no
             selection", a JavaScript exception, ...). Its message is the page's.
  TimeoutError  no reply within the call's timeout (the Page's default, 60 s;
             dialogs -- ask, confirm, choose -- wait for ever unless given one).

toast() and progress() do not wait for a reply and never raise PageGone.
"""
from __future__ import annotations

import base64
import json
import os
import queue
import socket
import threading
from types import EllipsisType
from typing import Any, Iterator

__all__ = ["Page", "PageError", "PageGone", "connect"]


class PageGone(Exception):
    """There is no page to talk to (or no longer one)."""


class PageError(Exception):
    """The page answered a call with an error."""


class _Waiter:
    """One pending request: the reader thread fills it in and sets `done`."""

    def __init__(self) -> None:
        self.done = threading.Event()
        self.reply: dict[str, Any] = {}


class Page:
    """One connection to the page bridge, with a reader thread behind it."""

    def __init__(self, path: str, timeout: float = 60.0) -> None:
        self.timeout = timeout
        self._sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            self._sock.connect(path)
        except OSError as e:
            self._sock.close()
            raise PageGone(f"cannot connect to {path}: {e}") from e
        self._lock = threading.Lock()  # guards _pending, _next_id, _gone
        self._send_lock = threading.Lock()
        self._pending: dict[int, _Waiter] = {}
        self._next_id = 1
        self._gone: str | None = None  # why the connection ended, once it has
        self._closing = False
        self._events: queue.Queue[tuple[str, Any] | None] = queue.Queue()
        self._reader = threading.Thread(target=self._read, name="pdfink-page-reader", daemon=True)
        self._reader.start()

    # -- plumbing -----------------------------------------------------------

    def _read(self) -> None:
        try:
            with self._sock.makefile("rb") as f:
                for line in f:  # a line can be megabytes; readline keeps it whole
                    self._dispatch(line)
        except (OSError, ValueError):
            pass
        finally:
            self._end("page connection closed")

    def _dispatch(self, line: bytes) -> None:
        try:
            msg = json.loads(line)
        except ValueError:
            return
        if not isinstance(msg, dict):
            return
        if "event" in msg:
            self._events.put((str(msg["event"]), msg.get("data")))
            return
        with self._lock:
            waiter = self._pending.pop(msg.get("id"), None) if isinstance(msg.get("id"), int) else None
        if waiter is not None:  # replies for unknown ids (toasts, timeouts) are dropped
            waiter.reply = msg
            waiter.done.set()

    def _end(self, why: str) -> None:
        """Mark the connection dead and fail everything still waiting."""
        with self._lock:
            if self._gone is None:
                self._gone = why
            pending, self._pending = self._pending, {}
        for waiter in pending.values():
            waiter.reply = {"error": "page gone"}
            waiter.done.set()
        self._events.put(None)

    def _send(self, obj: dict[str, Any]) -> None:
        data = (json.dumps(obj) + "\n").encode()
        try:
            with self._send_lock:
                self._sock.sendall(data)
        except OSError as e:
            raise PageGone(self._gone or f"page connection closed: {e}") from e

    def _request(self, body: dict[str, Any], timeout: float | None | EllipsisType) -> Any:
        waiter = _Waiter()
        with self._lock:
            if self._gone is not None:
                raise PageGone(self._gone)
            i = self._next_id
            self._next_id += 1
            self._pending[i] = waiter
        try:
            self._send({"id": i, **body})
        except PageGone:
            with self._lock:
                self._pending.pop(i, None)
            raise
        wait = self.timeout if timeout is ... else timeout
        if not waiter.done.wait(wait):
            with self._lock:
                self._pending.pop(i, None)
            raise TimeoutError(f"no reply from the page in {wait} s")
        if "error" in waiter.reply:
            err = waiter.reply["error"]
            if err == "page gone":
                raise PageGone(self._gone or "page gone")
            raise PageError(str(err))
        return waiter.reply.get("result")

    def _fire(self, name: str, *args: Any) -> None:
        """Send a call without waiting; its reply, if any, is dropped."""
        with self._lock:
            if self._gone is not None:
                return
            i = self._next_id
            self._next_id += 1
        try:
            self._send({"id": i, "call": name, "args": list(args)})
        except PageGone:
            pass

    # -- the general interface ----------------------------------------------

    def call(self, name: str, *args: Any, timeout: float | None | EllipsisType = ...) -> Any:
        """Call window.pdfink[name](*args) and return its result."""
        return self._request({"call": name, "args": list(args)}, timeout)

    def eval(self, js: str, timeout: float | None | EllipsisType = ...) -> Any:
        """Evaluate JavaScript in the page and return its value."""
        return self._request({"eval": js}, timeout)

    def subscribe(self, *events: str) -> None:
        """Ask for these page events; they queue up for events()."""
        with self._lock:
            if self._gone is not None:
                raise PageGone(self._gone)
        self._send({"subscribe": list(events)})

    def events(self, *names: str, timeout: float | None = None) -> Iterator[tuple[str, Any]]:
        """Subscribe to `names`, then yield (event, data) as they come.

        Also yields the server's own "exit" and "gone". Ends when no event
        arrives within `timeout` seconds, or after close(); raises PageGone if
        the connection drops.
        """
        if names:
            self.subscribe(*names)
        while True:
            try:
                item = self._events.get(timeout=timeout)
            except queue.Empty:
                return
            if item is None:
                self._events.put(None)  # leave the end marker for the next reader
                if self._closing:
                    return
                raise PageGone(self._gone or "page connection closed")
            yield item

    def close(self) -> None:
        """Close the connection; anything still waiting gets PageGone."""
        self._closing = True
        try:
            self._sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self._sock.close()
        self._end("page connection closed")
        if threading.current_thread() is not self._reader:
            self._reader.join(timeout=1)

    def __enter__(self) -> Page:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -- window.pdfink ------------------------------------------------------

    def state(self) -> dict[str, Any]:
        return self.call("state")

    def notebook(self) -> dict[str, Any]:
        return self.call("notebook")

    def selection(self) -> dict[str, Any] | None:
        return self.call("selection")

    def selection_ink(self) -> list[dict[str, Any]]:
        return self.call("selectionInk")

    def selection_png(self, scale: float | None = None) -> bytes:
        """PNG bytes of the selection; PageError("no selection") without one."""
        opts = {} if scale is None else {"scale": scale}
        return base64.b64decode(self.call("selectionPng", opts))

    def page_png(self, page: int, scale: float = 1) -> bytes:
        return base64.b64decode(self.call("pagePng", page, {"scale": scale}))

    def toast(self, message: str) -> None:
        self._fire("toast", message)

    def progress(self, message: str | None) -> None:
        """Show a progress line; None clears it."""
        self._fire("progress", message)

    def ask(self, message: str, default: str = "", timeout: float | None = None) -> str | None:
        """A line of text from the user; None when cancelled."""
        return self.call("ask", message, {"default": default}, timeout=timeout)

    def confirm(self, message: str, timeout: float | None = None) -> bool:
        return self.call("confirm", message, timeout=timeout)

    def choose(self, message: str, options: list[str], timeout: float | None = None) -> str | None:
        """One of `options`; None when cancelled."""
        return self.call("choose", message, list(options), timeout=timeout)

    def add_button(self, id: str, label: str, where: str = "menu") -> None:
        """A button that sends a "button" event with data {"id": id}."""
        return self.call("addButton", id, label, {"where": where})

    def remove_button(self, id: str) -> None:
        return self.call("removeButton", id)

    def select(self, page: int, rect: dict[str, float]) -> None:
        return self.call("select", page, rect)

    def clear_selection(self) -> None:
        return self.call("clearSelection")

    def set_tool(self, tool: str) -> None:
        return self.call("setTool", tool)

    def save(self) -> bool:
        return self.call("save")

    def reload(self) -> bool:
        return self.call("reload")

    def undo(self) -> None:
        return self.call("undo")

    def redo(self) -> None:
        return self.call("redo")

    def add_page(self) -> None:
        return self.call("addPage")

    def scroll_to_page(self, page: int) -> None:
        return self.call("scrollToPage", page)

    def add_strokes(self, page: int, strokes: list[dict[str, Any]], space: str = "page") -> list[str]:
        """Add strokes as one undo step, in page space or "pdf" points; their ids."""
        return self.call("addStrokes", page, strokes, {"space": space})

    def add_image(self, page: int, png_bytes: bytes, rect: dict[str, float]) -> str:
        """Place PNG bytes on `page` at a page-space rect; its id."""
        return self.call("addImage", page, base64.b64encode(png_bytes).decode("ascii"), rect)

    def remove_items(self, ids: list[str]) -> int:
        return self.call("removeItems", list(ids))


def connect(optional: bool = False, timeout: float = 60.0) -> Page | None:
    """A Page on $PDFINK_SOCKET. Without it: None if `optional`, else PageGone."""
    path = os.environ.get("PDFINK_SOCKET")
    if not path:
        if optional:
            return None
        raise PageGone("no PDFINK_SOCKET: not run from pdfink's pen menu")
    return Page(path, timeout)
