#!/usr/bin/env python3
"""Serve the Phase 5 demo page, and stand in for the edge in front of it.

The proxy is not a convenience. The gateway resolves a project from the `Host`
header (that is what makes a Host an identity rather than a client assertion),
and a browser is **forbidden** from setting `Host` — it is a forbidden header
name, so a page cannot address a project directly no matter how it is written.
Something in front of the gateway has to supply it. In production that is
Cloudflare and Caddy; here it is this file.

Serving the page and the API from one origin also removes CORS from the demo
entirely, which is the right trade for a page whose subject is RLS rather than
preflights — Phase 4's demo already earned the CORS lesson the hard way (D-371).

It forwards only `/auth/v1/…` and `/rest/v1/…`, to one fixed upstream, with one
fixed Host. A dev tool that forwards arbitrary methods to an arbitrary host is an
open proxy, and this one runs on loopback next to a credentialed API.
"""
import os
import sys
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = os.environ.get("CB_DEMO_API", "http://127.0.0.1:8099")
DOMAIN = os.environ.get("CB_PROJECT_DOMAIN", "localhost")
FORWARD = ("/auth/v1/", "/rest/v1/")
# Everything the demo actually sends. Named rather than passed through, because
# the point of an allowlist is that adding to it is a decision.
COPY_REQUEST = ("apikey", "authorization", "content-type", "prefer", "accept")
COPY_RESPONSE = ("content-type", "content-range", "x-request-id")


def project_ref():
    """The ref the script wrote into config.js — the one project this proxy serves."""
    try:
        with open("config.js", encoding="utf-8") as fh:
            for line in fh:
                if "ref:" in line:
                    return line.split("'")[1]
    except OSError:
        pass
    return None


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):          # noqa: N802
        self.proxy("GET") if self.forwarded() else super().do_GET()

    def do_POST(self):         # noqa: N802
        self.proxy("POST") if self.forwarded() else self.send_error(405)

    def do_PATCH(self):        # noqa: N802
        self.proxy("PATCH") if self.forwarded() else self.send_error(405)

    def do_DELETE(self):       # noqa: N802
        self.proxy("DELETE") if self.forwarded() else self.send_error(405)

    def forwarded(self):
        return self.path.startswith(FORWARD)

    def proxy(self, method):
        ref = project_ref()
        if not ref:
            self.send_error(503, "no config.js — run ./scripts/data-demo.sh")
            return
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(UPSTREAM + self.path, data=body, method=method)
        for h in COPY_REQUEST:
            v = self.headers.get(h)
            if v:
                req.add_header(h, v)
        # The one header the browser could not have sent, and the reason this
        # file exists. `/auth/v1` resolves its project from the apikey and does
        # not need it; `/rest/v1` does, and sending it on both is simpler than
        # explaining which is which to a proxy.
        req.add_header("Host", f"{ref}.{DOMAIN}")
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                payload, status, headers = res.read(), res.status, res.headers
        except urllib.error.HTTPError as err:
            # A 4xx from the API is the demo working — several steps exist to
            # produce one — so it is relayed verbatim rather than turned into a
            # proxy error that hides the code and the body.
            payload, status, headers = err.read(), err.code, err.headers
        except urllib.error.URLError as err:
            self.send_error(502, f"upstream {UPSTREAM} unreachable: {err.reason}")
            return
        self.send_response(status)
        for h in COPY_RESPONSE:
            v = headers.get(h)
            if v:
                self.send_header(h, v)
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8124
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
