#!/usr/bin/env python3
"""Serve the demo page, and proxy the local mail sink under the same origin.

The proxy exists for one reason: the sink sends no CORS headers, so a page on
another origin cannot read its own confirmation mail. Serving both from one
origin lets step 2 be a single click on a *genuinely delivered* message rather
than a copy-paste, without pretending the mail did not happen.

It proxies only `GET /inbox/…` to the sink's read API and nothing else. A dev
tool that forwards arbitrary methods to an arbitrary host is an open proxy, and
this one runs bound to loopback next to a credentialed API.
"""
import json
import os
import sys
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

MAILPIT = os.environ.get("SH_MAILPIT_API", "http://127.0.0.1:58025").rstrip("/")
ALLOWED = ("/api/v1/messages", "/api/v1/message/")


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 - the base class's name
        if self.path.startswith("/inbox/"):
            return self.proxy(self.path[len("/inbox"):])
        return super().do_GET()

    def proxy(self, path: str) -> None:
        # An allowlist of prefixes, not a pass-through. `..` is rejected outright
        # rather than normalised, because normalising and then checking is how a
        # path traversal gets through.
        if ".." in path or not any(path.startswith(p) for p in ALLOWED):
            self.send_error(403, "only the sink's read API is proxied")
            return
        try:
            with urllib.request.urlopen(MAILPIT + path, timeout=5) as r:
                body, ctype = r.read(), r.headers.get("content-type", "application/json")
        except urllib.error.URLError as err:
            # Named, because "the inbox is empty" and "there is no inbox" are
            # different problems and the page can only tell them apart if the
            # error says which.
            body = json.dumps({"error": f"cannot reach the mail sink at {MAILPIT}: {err}"}).encode()
            ctype = "application/json"
            self.send_response(502)
        else:
            self.send_response(200)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # Quieter than the default: a page that fetches four assets and polls the
        # inbox drowns the script's own output otherwise.
        #
        # `str()` on every argument, because `log_error` calls this with an int
        # status code — so a version of this that assumed strings raised
        # TypeError from inside the error path and answered an empty reply
        # instead of the 403 it had just decided on. A logger that crashes only
        # while reporting a failure is the worst place for one to crash.
        joined = " ".join(str(a) for a in args)
        if "/inbox/" not in joined:
            super().log_message(fmt, *args)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    root = os.path.dirname(os.path.abspath(__file__))
    handler = partial(Handler, directory=root)
    ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
