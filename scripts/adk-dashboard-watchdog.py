#!/usr/bin/env python3
"""ADK Dashboard Watchdog Daemon (naia-pj-adk Server Profile).

Monitors the local dashboard server health endpoint every minute.
Enforces a 10-minute alert cooldown to prevent notification spamming.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
import urllib.error
import fcntl
from contextlib import contextmanager


@contextmanager
def state_lock(path: Path):
    lock_file = path.with_suffix('.lock')
    lock_file.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_file, 'a+') as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)


def load_state(path: Path) -> dict:
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            pass
    return {'last_alert_at': 0, 'consecutive_failures': 0}


def save_state(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data))
    tmp.replace(path)


def trigger_alert(args: argparse.Namespace, error_msg: str) -> None:
    msg = f"[ADK DASHBOARD ALERT] Health check failed: {error_msg}"
    print(msg, file=sys.stderr)

    if args.alert_command:
        try:
            subprocess.run(
                args.alert_command,
                shell=True,
                env=dict(os.environ, ADK_ALERT_MESSAGE=msg),
                timeout=15
            )
        except Exception as e:
            print(f"Failed to run alert command: {e}", file=sys.stderr)

    if args.webhook_url:
        try:
            payload = json.dumps({'content': msg, 'text': msg}).encode('utf-8')
            req = urllib.request.Request(
                args.webhook_url,
                data=payload,
                headers={'Content-Type': 'application/json'}
            )
            urllib.request.urlopen(req, timeout=10)
        except Exception as e:
            print(f"Failed to post to webhook: {e}", file=sys.stderr)


def check_health(url: str, timeout: int = 5) -> tuple[bool, str]:
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'ADK-Watchdog/1.0'})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status != 200:
                return False, f"HTTP status {resp.status}"
            body = resp.read().decode('utf-8')
            if '"status": "ok"' not in body and '"status":"ok"' not in body:
                return False, f"Invalid body assertion: {body[:100]}"
            return True, "OK"
    except urllib.error.HTTPError as e:
        return False, f"HTTPError {e.code}"
    except urllib.error.URLError as e:
        return False, f"URLError {e.reason}"
    except Exception as e:
        return False, str(e)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--url',
        default=os.environ.get('ADK_DASHBOARD_HEALTH_URL', 'http://localhost:18050/api/health'),
        help='Target health probe URL'
    )
    parser.add_argument('--alert-command', default=os.environ.get('ADK_ALERT_COMMAND'), help='Command to run on alert')
    parser.add_argument('--webhook-url', default=os.environ.get('ADK_ALERT_WEBHOOK_URL'), help='Webhook URL on alert')
    parser.add_argument('--cooldown-seconds', type=int, default=600, help='Alert deduplication cooldown in seconds')
    parser.add_argument(
        '--state-file',
        default=os.environ.get(
            'ADK_WATCHDOG_STATE_FILE',
            str(Path.home() / '.local/state/adk-dashboard-watchdog.json')
        ),
        help='Path to state file'
    )
    parser.add_argument('--threshold', type=int, default=2, help='Consecutive failures before alert')

    args = parser.parse_args()
    state_path = Path(args.state_file)

    ok, msg = check_health(args.url)
    now = time.time()

    with state_lock(state_path):
        state = load_state(state_path)
        if ok:
            state['consecutive_failures'] = 0
            save_state(state_path, state)
            print(f"[HEALTH OK] {args.url}: {msg}")
            sys.exit(0)
        else:
            state['consecutive_failures'] = state.get('consecutive_failures', 0) + 1
            failures = state['consecutive_failures']
            last_alert = state.get('last_alert_at', 0)

            print(f"[HEALTH FAIL #{failures}] {args.url}: {msg}", file=sys.stderr)

            if failures >= args.threshold:
                if (now - last_alert) >= args.cooldown_seconds:
                    state['last_alert_at'] = now
                    trigger_alert(args, msg)
                else:
                    remaining = int(args.cooldown_seconds - (now - last_alert))
                    print(f"[COOLDOWN] Suppressed alert (remaining cooldown: {remaining}s)", file=sys.stderr)

            save_state(state_path, state)
            sys.exit(1)


if __name__ == '__main__':
    main()
