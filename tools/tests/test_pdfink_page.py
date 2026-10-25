#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Tests for tools/pdfink_page.py, against a fake bridge on a temp Unix socket.

    uv run --script tools/tests/test_pdfink_page.py
"""
from __future__ import annotations

import base64
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pdfink_page  # noqa: E402
from pdfink_page import Page, PageError, PageGone, connect  # noqa: E402

BIG = "QUJD" * 750_000  # 3 000 000 base64 chars of "ABC"


class FakeBridge:
    """A stand-in for server/bridge.ts: answers a few calls, echoes the rest."""

    def __init__(self) -> None:
        self.dir = tempfile.mkdtemp(prefix="pdfink-page-")
        self.path = os.path.join(self.dir, "s.sock")
        self.received: list[dict[str, Any]] = []
        self.conns: list[socket.socket] = []
        self.lock = threading.Lock()
        self.stopping = threading.Event()
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(self.path)
        self.listener.listen()
        self.threads: list[threading.Thread] = []
        self._spawn(self._accept)

    def _spawn(self, fn: Any, *args: Any) -> None:
        t = threading.Thread(target=fn, args=args, daemon=True)
        self.threads.append(t)
        t.start()

    def _accept(self) -> None:
        while True:
            try:
                conn, _ = self.listener.accept()
            except OSError:
                return
            if self.stopping.is_set():  # close()'s wake-up connection
                conn.close()
                return
            conn.settimeout(10)  # a stuck test fails rather than hangs
            with self.lock:
                self.conns.append(conn)
            self._spawn(self._serve, conn)

    def _send(self, conn: socket.socket, obj: dict[str, Any]) -> None:
        with self.lock:
            try:
                conn.sendall((json.dumps(obj) + "\n").encode())
            except OSError:
                pass

    def _later(self, delay: float, conn: socket.socket, obj: dict[str, Any]) -> None:
        def fire() -> None:
            time.sleep(delay)
            self._send(conn, obj)
        self._spawn(fire)

    def _serve(self, conn: socket.socket) -> None:
        try:
            with conn.makefile("rb") as f:
                for line in f:
                    try:
                        msg = json.loads(line)
                    except ValueError:
                        continue
                    with self.lock:
                        self.received.append(msg)
                    self._answer(conn, msg)
        except OSError:
            pass  # dropped, closed or timed out: this connection is done

    def _answer(self, conn: socket.socket, msg: dict[str, Any]) -> None:
        if "subscribe" in msg:
            for _ in range(2 if "button" in msg["subscribe"] else 0):
                self._send(conn, {"event": "button", "data": {"id": "hello"}})
            return
        i, name = msg["id"], msg.get("call")
        if name == "state":
            self._send(conn, {"id": i, "result": {"tool": "pen"}})
        elif name == "pagePng":
            self._send(conn, {"id": i, "result": "QUJD"})
        elif name == "selectionPng":
            self._send(conn, {"id": i, "result": BIG})
        elif name == "ask":
            self._later(0.2, conn, {"id": i, "result": "Danny"})
        elif name == "addLink" and not msg["args"][2].startswith(("http:", "https:", "mailto:")):
            self._send(conn, {"id": i, "error": "bad url"})
        elif name == "boom":
            self._send(conn, {"id": i, "error": "no such method"})
        elif name == "gone":
            self._send(conn, {"id": i, "error": "page gone"})
        elif name in ("toast", "progress"):
            self._later(0.5, conn, {"id": i, "error": "page gone"})
        elif "eval" in msg:
            self._send(conn, {"id": i, "result": f"evaluated {msg['eval']}"})
        else:
            self._send(conn, {"id": i, "result": {"call": name, "args": msg["args"]}})

    def last(self, name: str) -> dict[str, Any]:
        with self.lock:
            return [m for m in self.received if m.get("call") == name][-1]

    def drop_clients(self, wait: bool = True) -> None:
        """Cut every client off; with `wait`, first wait for one to have been accepted."""
        deadline = time.monotonic() + 5
        while wait and time.monotonic() < deadline:
            with self.lock:
                if self.conns:
                    break
            time.sleep(0.005)
        with self.lock:
            conns, self.conns = self.conns, []
        for c in conns:
            try:
                c.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            c.close()

    def close(self) -> None:
        # Closing the listener from another thread need not wake accept()
        # (it doesn't on Linux): connect to it instead, with the flag set.
        self.stopping.set()
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as wake:
                wake.connect(self.path)
        except OSError:
            pass
        self.listener.close()
        self.drop_clients(wait=False)
        for t in self.threads:
            t.join(timeout=2)
        try:
            os.unlink(self.path)
        except FileNotFoundError:
            pass
        os.rmdir(self.dir)


class PageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.server = FakeBridge()
        self.page = Page(self.server.path, timeout=5)

    def tearDown(self) -> None:
        self.page.close()
        self.server.close()

    def test_call_and_mirror(self) -> None:
        self.assertEqual(self.page.call("state"), {"tool": "pen"})
        self.assertEqual(self.page.state(), {"tool": "pen"})
        self.assertEqual(self.page.eval("1+1"), "evaluated 1+1")
        self.assertEqual(self.page.ask("Your name?", default="Ada"), "Danny")
        self.assertEqual(self.server.last("ask")["args"], ["Your name?", {"default": "Ada"}])
        r = self.page.add_strokes(0, [{"points": []}], space="pdf")
        self.assertEqual(r, {"call": "addStrokes", "args": [0, [{"points": []}], {"space": "pdf"}]})
        rect = {"x": 1, "y": 2, "w": 3, "h": 4}
        r = self.page.add_image(1, b"ABC", rect)
        self.assertEqual(r["args"], [1, "QUJD", rect])
        self.assertEqual(self.page.add_button("hi", "Hi", where="toolbar")["args"], ["hi", "Hi", {"where": "toolbar"}])
        self.assertEqual(self.page.choose("Pick", ["a", "b"])["args"], ["Pick", ["a", "b"]])
        self.assertEqual(self.page.page_png(2, scale=2), b"ABC")
        self.assertEqual(self.server.last("pagePng")["args"], [2, {"scale": 2}])

    def test_links_and_bookmarks_mirror(self) -> None:
        rect = {"x": 300, "y": 500, "w": 100, "h": 50}
        self.assertEqual(self.page.links(), {"call": "links", "args": []})
        self.assertEqual(self.page.links(2)["args"], [2])
        self.assertEqual(self.page.add_link(0, rect, "https://x.org/")["args"], [0, rect, "https://x.org/", {"space": "page"}])
        r = self.page.add_link(1, rect, "mailto:a@b.org", label="Mail", space="pdf")
        self.assertEqual(r, {"call": "addLink", "args": [1, rect, "mailto:a@b.org", {"label": "Mail", "space": "pdf"}]})
        self.assertEqual(self.page.set_link("ln1", url="https://y.org/")["args"], ["ln1", {"url": "https://y.org/"}])
        self.assertEqual(self.page.set_link("ln1", label="")["args"], ["ln1", {"label": ""}])
        self.assertEqual(self.page.set_link("ln1", url="http://z.org/", label="Z")["args"], ["ln1", {"url": "http://z.org/", "label": "Z"}])
        self.assertEqual(self.page.bookmarks(), {"call": "bookmarks", "args": []})
        self.assertEqual(self.page.add_bookmark(3, "2026-10-23")["args"], [3, "2026-10-23", {"level": 0}])
        self.assertEqual(self.page.add_bookmark(3, "Sub", level=1)["args"], [3, "Sub", {"level": 1}])
        self.assertEqual(self.page.remove_bookmark(4), {"call": "removeBookmark", "args": [4]})
        with self.assertRaises(PageError) as e:
            self.page.add_link(0, rect, "javascript:x")
        self.assertEqual(str(e.exception), "bad url")

    def test_text_strokes_and_notebook_tag_mirror(self) -> None:
        line = {"x": 1, "y": 2, "w": 3, "h": 4, "text": "hi"}
        rect = {"x": 0, "y": 0, "w": 10, "h": 10}
        self.assertEqual(self.page.page_text(2), {"call": "pageText", "args": [2]})
        self.assertEqual(self.page.ink_text(1), {"call": "inkText", "args": [1]})
        r = self.page.set_ink_text(0, [line])
        self.assertEqual(r, {"call": "setInkText", "args": [0, [line], {"space": "page", "quiet": False}]})
        r = self.page.set_ink_text(0, [line], space="pdf", quiet=True, within=rect)
        self.assertEqual(r["args"], [0, [line], {"space": "pdf", "quiet": True, "within": rect}])
        self.assertEqual(self.page.strokes(3), {"call": "strokes", "args": [3, {"space": "page"}]})
        self.assertEqual(self.page.strokes(3, space="pdf")["args"], [3, {"space": "pdf"}])
        self.assertEqual(self.page.notebook_tag(), {"call": "notebookTag", "args": []})
        for v in (True, False, None):
            self.assertEqual(self.page.set_notebook_tag(v), {"call": "setNotebookTag", "args": [v]})

    def test_large_result_one_line(self) -> None:
        png = self.page.selection_png()
        self.assertIsInstance(png, bytes)
        self.assertEqual(len(png), 2_250_000)
        self.assertEqual(png[:6], b"ABCABC")

    def test_errors_map_to_exceptions(self) -> None:
        with self.assertRaises(PageError) as e:
            self.page.call("boom")
        self.assertIn("no such method", str(e.exception))
        with self.assertRaises(PageGone):
            self.page.call("gone")
        self.assertFalse(issubclass(PageGone, PageError))
        self.assertEqual(self.page.state(), {"tool": "pen"})  # still usable afterwards

    def test_toast_does_not_wait(self) -> None:
        t0 = time.monotonic()
        self.assertIsNone(self.page.toast("hello"))
        self.assertIsNone(self.page.progress(None))
        self.assertLess(time.monotonic() - t0, 0.2)
        time.sleep(0.7)  # the late "page gone" replies arrive and are dropped
        self.assertEqual(self.server.last("toast")["args"], ["hello"])
        self.assertEqual(self.server.last("progress")["args"], [None])
        self.assertIsInstance(self.server.last("toast")["id"], int)
        self.assertEqual(self.page.state(), {"tool": "pen"})

    def test_events_generator(self) -> None:
        got = []
        for event, data in self.page.events("button", timeout=1):
            got.append((event, data))
            if len(got) == 2:
                break
        self.assertEqual(got, [("button", {"id": "hello"})] * 2)
        self.assertIn({"subscribe": ["button"]}, self.server.received)
        self.assertEqual(list(self.page.events("button", timeout=0.3))[-1:], [("button", {"id": "hello"})])

    def test_events_end_with_timeout(self) -> None:
        self.page.subscribe("selection")
        self.assertEqual(list(self.page.events(timeout=0.3)), [])

    def test_socket_close_fails_pending_and_events(self) -> None:
        threading.Timer(0.05, self.server.drop_clients).start()
        with self.assertRaises(PageGone):
            self.page.ask("never answered?")
        with self.assertRaises(PageGone):
            self.page.state()
        with self.assertRaises(PageGone):
            list(self.page.events("button"))
        self.page.toast("swallowed")  # fire-and-forget stays quiet

    def test_close_while_pending(self) -> None:
        threading.Timer(0.05, self.page.close).start()
        with self.assertRaises(PageGone):
            self.page.ask("closing")

    def test_call_timeout(self) -> None:
        with self.assertRaises(TimeoutError):
            self.page.call("ask", "slow", timeout=0.05)
        self.assertEqual(self.page.state(), {"tool": "pen"})

    def test_bad_lines_are_skipped(self) -> None:
        self.page.state()  # a round trip, so the server has registered the connection
        with self.server.lock:
            conn = self.server.conns[0]
            conn.sendall(b"not json\n{\"id\": 999, \"result\": 1}\n[1,2]\n\n")
        self.assertEqual(self.page.state(), {"tool": "pen"})

    def test_context_manager_closes(self) -> None:
        with Page(self.server.path) as p:
            self.assertEqual(p.state(), {"tool": "pen"})
        with self.assertRaises(PageGone):
            p.state()


class ConnectTests(unittest.TestCase):
    def test_connect_without_env(self) -> None:
        saved = os.environ.pop("PDFINK_SOCKET", None)
        try:
            self.assertIsNone(connect(optional=True))
            with self.assertRaises(PageGone) as e:
                connect()
            self.assertEqual(str(e.exception), "no PDFINK_SOCKET: not run from pdfink's pen menu")
        finally:
            if saved is not None:
                os.environ["PDFINK_SOCKET"] = saved

    def test_connect_with_env(self) -> None:
        server = FakeBridge()
        os.environ["PDFINK_SOCKET"] = server.path
        try:
            with connect() as p:
                self.assertEqual(p.state(), {"tool": "pen"})
        finally:
            del os.environ["PDFINK_SOCKET"]
            server.close()

    def test_connect_nobody_listening(self) -> None:
        d = tempfile.mkdtemp(prefix="pdfink-page-")
        path = os.path.join(d, "dead.sock")
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.bind(path)
        s.close()  # the path exists, but nothing listens
        try:
            with self.assertRaises(PageGone):
                Page(path)
        finally:
            os.unlink(path)
            os.rmdir(d)


if __name__ == "__main__":
    assert pdfink_page.__doc__
    unittest.main()
