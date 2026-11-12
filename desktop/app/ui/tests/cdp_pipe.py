"""Headless Chrome over a DevTools pipe (no TCP port), stdlib only. Transport used by visual_capture.py."""
from __future__ import annotations

import argparse
import base64
import fcntl
import json
import os
import re
import select
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


class ToolError(Exception):
    pass


# ---------------------------------------------------------------------------------------------------------------------------------------
# DevTools protocol over a pipe (Chrome --remote-debugging-pipe: JSON messages, each ended by a NUL byte, on fds 3 (to Chrome) / 4 (from Chrome)).
# No TCP port is opened, so no other local user can attach to the browser while it holds the session cookie.
# ---------------------------------------------------------------------------------------------------------------------------------------
class PipeTransport:
    def __init__(self, rfd: int, wfd: int):
        """``rfd``: read end of Chrome's output; ``wfd``: write end of Chrome's input (both ours, closed by ``close``)."""
        self.rfd, self.wfd = rfd, wfd
        self._buf = b""

    def send_text(self, text: str) -> None:
        data = text.encode() + b"\0"
        try:
            while data:
                data = data[os.write(self.wfd, data):]
        except OSError as e:
            raise ToolError("the browser's pipe is closed: " + (e.strerror or str(e))) from None

    def recv_text(self, timeout: float | None = None) -> str | None:
        """Next complete message, or None when ``timeout`` seconds pass with nothing complete to read."""
        end = time.monotonic() + (timeout if timeout is not None else 60.0)
        while b"\0" not in self._buf:
            left = end - time.monotonic()
            if left <= 0 or not select.select([self.rfd], [], [], left)[0]:
                return None
            chunk = os.read(self.rfd, 1 << 20)
            if not chunk:
                raise ToolError("the browser closed its DevTools pipe (Chrome exited)")
            self._buf += chunk
        msg, _, self._buf = self._buf.partition(b"\0")
        return msg.decode()

    def close(self) -> None:
        for fd in (self.wfd, self.rfd):
            try:
                os.close(fd)
            except OSError:
                pass
        self.rfd = self.wfd = -1


def spawn_chrome_pipe(args: list[str]) -> tuple[subprocess.Popen, PipeTransport]:
    """Start Chrome with ``--remote-debugging-pipe``: it reads commands on fd 3 and writes replies on fd 4, so a small ``sh`` puts our pipe ends there
    (``exec`` keeps the same process) and closes the originals. Both pipes are private to this process and Chrome."""
    to_r, to_w = os.pipe()          # us -> Chrome
    from_r, from_w = os.pipe()      # Chrome -> us
    hi = [fcntl.fcntl(fd, fcntl.F_DUPFD, 10) for fd in (to_r, from_w)]   # numbers >= 10 so the redirections below cannot clash with 3 and 4
    for fd in (to_r, from_w):
        os.close(fd)
    r, w = hi
    try:
        proc = subprocess.Popen(["sh", "-c", f'exec "$0" "$@" 3<&{r} 4>&{w} {r}<&- {w}>&-', *args], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, pass_fds=(r, w))
    except BaseException:
        for fd in (to_w, from_r):
            os.close(fd)
        raise
    finally:
        for fd in (r, w):
            os.close(fd)
    return proc, PipeTransport(from_r, to_w)


# ---------------------------------------------------------------------------------------------------------------------------------------
# Chrome + DevTools protocol
# ---------------------------------------------------------------------------------------------------------------------------------------
def find_chrome(explicit: str | None) -> str:
    for c in (explicit, os.environ.get("LINUX_XTU_CHROME"), shutil.which("google-chrome"), shutil.which("google-chrome-stable"), shutil.which("chromium"),
              shutil.which("chromium-browser")):
        if c and os.access(c, os.X_OK):
            return c
    raise ToolError("no Chrome/Chromium found (use --chrome PATH or set LINUX_XTU_CHROME)")


