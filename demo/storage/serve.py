#!/usr/bin/env python3
"""Serve the Phase 6 demo, forwarding auth, data and storage.

`/storage/v1/` is the addition, and it is why the shared handler forwards bytes
rather than text: this demo uploads a PNG and renders one back, and a proxy that
decoded either would corrupt it for reasons no error message would explain.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from proxy import serve  # noqa: E402

if __name__ == "__main__":
    serve(("/auth/v1/", "/rest/v1/", "/storage/v1/"),
          int(sys.argv[1]) if len(sys.argv) > 1 else 8125,
          os.path.dirname(os.path.abspath(__file__)))
