#!/usr/bin/env python3
"""Serve the Phase 5 demo, forwarding the data-plane APIs with a Host header.

The handler lives in `demo/proxy.py` because the Phase 6 demo needed the same
thing and a third copy was one too many. Everything about *why* a proxy is here
at all — a browser cannot set `Host`, and the gateway identifies a project by it
— is documented there.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from proxy import serve  # noqa: E402

if __name__ == "__main__":
    serve(("/auth/v1/", "/rest/v1/"),
          int(sys.argv[1]) if len(sys.argv) > 1 else 8124,
          os.path.dirname(os.path.abspath(__file__)))
