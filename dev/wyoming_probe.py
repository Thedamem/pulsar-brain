#!/usr/bin/env python3
"""Send a Wyoming `describe` request to a local STT/TTS service.

Used by dev/check.sh and by hand during stand debugging. Standard library only,
so it works both with dev/.venv/bin/python and the system Python.

Wyoming framing (see wyoming/event.py): a JSON header line, then optionally
`data_length` bytes of additional JSON data (large info payloads such as voice
lists are sent this way), then optionally a binary payload.

Exit code 0 when the service answered with a `describe`/`info` reply (and, when
--expect is given, advertises that service type); 1 otherwise.
"""

from __future__ import annotations

import argparse
import json
import socket
import sys


def read_info(host: str, port: int, timeout: float) -> dict:
    with socket.create_connection((host, port), timeout=timeout) as sock:
        sock.settimeout(timeout)
        sock.sendall(json.dumps({"type": "describe"}).encode() + b"\n")
        reader = sock.makefile("rb")
        header_line = reader.readline()
        if not header_line:
            raise RuntimeError("server closed the connection before replying")
        try:
            header = json.loads(header_line)
        except json.JSONDecodeError as err:
            raise RuntimeError(f"non-JSON header: {header_line[:120]!r}") from err

        data = dict(header.get("data") or {})
        data_length = header.get("data_length") or 0
        if data_length:
            data_bytes = reader.read(data_length)
            if len(data_bytes) != data_length:
                raise RuntimeError(
                    f"truncated data block: {len(data_bytes)}/{data_length} bytes"
                )
            try:
                data.update(json.loads(data_bytes))
            except json.JSONDecodeError as err:
                raise RuntimeError("non-JSON data block in describe reply") from err

    return {"type": header.get("type"), "data": data}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument(
        "--expect",
        choices=["asr", "tts"],
        help="require the reply to advertise this service type",
    )
    parser.add_argument("--timeout", type=float, default=5.0)
    args = parser.parse_args()

    try:
        reply = read_info(args.host, args.port, args.timeout)
    except (OSError, RuntimeError) as err:
        print(f"wyoming {args.host}:{args.port}: {err}", file=sys.stderr)
        return 1

    data = reply["data"]
    if args.expect and not data.get(args.expect):
        print(
            f"wyoming {args.host}:{args.port}: reply does not advertise {args.expect!r}: "
            f"{json.dumps(reply, ensure_ascii=False)[:300]}",
            file=sys.stderr,
        )
        return 1

    services = []
    for service_type in ("asr", "tts"):
        services.extend(str(item.get("name", service_type)) for item in data.get(service_type) or [])
    print(
        f"wyoming {args.host}:{args.port}: {reply['type'] or '?'} "
        f"({', '.join(services) or 'no services advertised'})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
