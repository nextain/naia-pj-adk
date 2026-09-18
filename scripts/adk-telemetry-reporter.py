#!/usr/bin/env python3
"""ADK Telemetry Reporter for Remote Developer PCs (naia-pj-adk).

Collects local AGY and workstation metrics and pushes them to the central ADK Dashboard.
Supports multi-node development environments and distributed teams.
"""
import argparse
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time
import urllib.request
import urllib.error


def collect_local_telemetry(node_id: str) -> dict:
    hostname = platform.node()
    load1 = 0.0
    try:
        load1 = round(os.getloadavg()[0], 2)
    except Exception:
        pass

    # Detect running agy / agent sessions
    active_sessions = []
    try:
        # Check active agy or python worker processes
        res = subprocess.run(
            ['pgrep', '-a', '-f', 'antigravity|agy|onmam-resource|adk-resource'],
            capture_output=True, text=True, timeout=3
        )
        if res.returncode == 0:
            for line in res.stdout.strip().split('\n'):
                line = line.strip()
                if line and not ('pgrep' in line or 'adk-telemetry-reporter' in line):
                    pid = line.split()[0]
                    active_sessions.append({'pid': int(pid), 'command': line[:80]})
    except Exception:
        pass

    return {
        'node_id': node_id,
        'hostname': hostname,
        'system': platform.system(),
        'cpu_load': load1,
        'active_sessions': active_sessions,
        'reported_at': time.time()
    }


def push_telemetry(dashboard_url: str, payload: dict, timeout: int = 5) -> tuple[bool, str]:
    endpoint = dashboard_url.rstrip('/') + '/api/telemetry'
    body = json.dumps(payload).encode('utf-8')
    try:
        req = urllib.request.Request(
            endpoint,
            data=body,
            headers={
                'Content-Type': 'application/json',
                'User-Agent': 'ADK-Telemetry-Reporter/1.0'
            }
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status == 200:
                return True, "OK"
            return False, f"HTTP {resp.status}"
    except urllib.error.HTTPError as e:
        return False, f"HTTPError {e.code}"
    except urllib.error.URLError as e:
        return False, f"URLError {e.reason}"
    except Exception as e:
        return False, str(e)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--dashboard-url',
        default=os.environ.get('ADK_DASHBOARD_URL', 'http://localhost:18050'),
        help='Central ADK Dashboard URL'
    )
    parser.add_argument(
        '--node-id',
        default=os.environ.get('ADK_NODE_ID', platform.node()),
        help='Unique logical identifier for this developer machine'
    )
    parser.add_argument('--interval', type=int, default=30, help='Reporting interval in seconds (0 for one-shot)')

    args = parser.parse_args()

    while True:
        data = collect_local_telemetry(args.node_id)
        ok, msg = push_telemetry(args.dashboard_url, data)
        if ok:
            print(f"[REPORTER] Successfully pushed telemetry to {args.dashboard_url}")
        else:
            print(f"[REPORTER WARN] Push failed: {msg}", file=sys.stderr)

        if args.interval <= 0:
            sys.exit(0 if ok else 1)
        time.sleep(args.interval)


if __name__ == '__main__':
    main()
