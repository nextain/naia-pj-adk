#!/usr/bin/env python3
"""CLI for ADK cooperative resource and concurrency lease management.

Designed for naia-pj-adk server profile. Manages 10-slot capacity, locks, and task lifecycles.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.adk_resources import (
    Registry, Refused, atomic_json, digest, private_file, process_identity
)


def load_receipt(path: Path) -> dict:
    private_file(path)
    return json.loads(path.read_bytes())


def run_command_with_lease(registry: Registry, args: argparse.Namespace, receipt_path: Path) -> None:
    command = args.command
    if command[:1] == ['--']:
        command = command[1:]
    if not command:
        raise Refused('command_required')

    parent = load_receipt(Path(args.parent)) if args.parent else None

    # Inherited receipt check
    inherited = os.environ.get('ADK_RESOURCE_RECEIPT')
    if inherited and (not args.parent or Path(args.parent).resolve() != Path(inherited).resolve()):
        raise Refused('nested_execution_requires_parent_receipt')

    command_digest = digest(json.dumps(command, separators=(',', ':')).encode())
    receipt = registry.acquire(
        owner=args.owner,
        issue=args.issue,
        pool=args.pool,
        slots=args.slots,
        reads=args.read,
        writes=args.write,
        parent=parent,
        drain=args.drain,
        manager=process_identity(os.getpid()),
        command_sha256=command_digest,
        receipt_path=receipt_path
    )

    child = None
    stopped = False

    def interrupt(_signum, _frame):
        nonlocal stopped
        stopped = True

    old_handlers = {sig: signal.signal(sig, interrupt) for sig in (signal.SIGTERM, signal.SIGINT)}

    try:
        deadline = time.monotonic() + args.wait_seconds
        while True:
            if stopped:
                raise Refused('interrupted_before_activation')
            registry.renew(receipt)
            status = registry.status()
            current = next((r for r in status['leases'] if r['id'] == receipt['id']), None)
            if not current or current['phase'] == 'frozen':
                raise Refused('lease_lost_or_frozen')
            if current['phase'] == 'held':
                break
            try:
                registry.activate(receipt)
                break
            except Refused as err:
                if 'drain' not in str(err):
                    raise
            if time.monotonic() >= deadline:
                raise Refused('drain_wait_timeout')
            time.sleep(1)

        # Prepare child execution
        child_env = dict(os.environ)
        child_env['ADK_RESOURCE_RECEIPT'] = str(receipt_path.resolve())
        child_env['ADK_RESOURCE_LEASE_ID'] = receipt['id']

        child = subprocess.Popen(command, env=child_env, start_new_session=True)
        registry.bind_process(receipt, child.pid)

        heartbeat_interval = max(5, registry.policy.get('heartbeat_seconds', 30))
        next_heartbeat = time.monotonic() + heartbeat_interval

        while True:
            code = child.poll()
            if code is not None:
                evidence = digest(f'exit:{code}:{time.time()}'.encode())
                registry.release(receipt, evidence, manager_finished=True)
                sys.exit(code)

            if stopped:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                evidence = digest(f'stopped:{time.time()}'.encode())
                registry.release(receipt, evidence, manager_finished=True)
                sys.exit(130)

            now = time.monotonic()
            if now >= next_heartbeat:
                registry.renew(receipt)
                next_heartbeat = now + heartbeat_interval

            time.sleep(0.5)

    except Exception as exc:
        if child and child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        try:
            registry.freeze(receipt, str(exc))
        except Exception:
            pass
        raise
    finally:
        for sig, handler in old_handlers.items():
            signal.signal(sig, handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--policy', default=None, help='Path to resource-coordination.json')
    parser.add_argument('--directory', default=None, help='State directory for lock and registry')

    subparsers = parser.add_subparsers(dest='action', required=True)

    # init
    subparsers.add_parser('init', help='Initialize registry directory and file')

    # status
    subparsers.add_parser('status', help='Print status JSON')

    # acquire
    acq_parser = subparsers.add_parser('acquire', help='Acquire a resource lease')
    acq_parser.add_argument('--owner', required=True, help='Owner session/worker identifier')
    acq_parser.add_argument('--issue', required=True, help='GitHub issue reference, e.g. #123 or repo#123')
    acq_parser.add_argument('--pool', required=True, help='Pool name (gateway, interactive, etc.)')
    acq_parser.add_argument('--slots', type=int, default=1, help='Number of slots requested')
    acq_parser.add_argument('--read', action='append', default=[], help='Read resource claim')
    acq_parser.add_argument('--write', action='append', default=[], help='Write resource claim')
    acq_parser.add_argument('--parent', default=None, help='Path to parent receipt')
    acq_parser.add_argument('--drain', action='store_true', help='Request draining phase for conflicting writes')
    acq_parser.add_argument('--receipt', required=True, help='Output receipt path')

    # release
    rel_parser = subparsers.add_parser('release', help='Release a resource lease')
    rel_parser.add_argument('--receipt', required=True, help='Path to receipt')
    rel_parser.add_argument('--evidence', required=True, help='SHA-256 evidence of completion')

    # renew
    ren_parser = subparsers.add_parser('renew', help='Renew an active lease')
    ren_parser.add_argument('--receipt', required=True, help='Path to receipt')

    # activate
    act_parser = subparsers.add_parser('activate', help='Activate a draining lease')
    act_parser.add_argument('--receipt', required=True, help='Path to receipt')

    # reap
    reap_parser = subparsers.add_parser('reap', help='Reap expired or frozen leases')
    reap_parser.add_argument('--force', action='store_true', help='Force reap regardless of automatic_expiry_release policy')

    # run
    run_parser = subparsers.add_parser('run', help='Execute a command within a managed lease')
    run_parser.add_argument('--owner', required=True, help='Owner session identifier')
    run_parser.add_argument('--issue', required=True, help='GitHub issue reference')
    run_parser.add_argument('--pool', required=True, help='Pool name')
    run_parser.add_argument('--slots', type=int, default=1, help='Slots requested')
    run_parser.add_argument('--read', action='append', default=[], help='Read resource claim')
    run_parser.add_argument('--write', action='append', default=[], help='Write resource claim')
    run_parser.add_argument('--parent', default=None, help='Path to parent receipt')
    run_parser.add_argument('--drain', action='store_true', help='Request draining phase')
    run_parser.add_argument('--wait-seconds', type=int, default=30, help='Max seconds to wait for activation')
    run_parser.add_argument('--receipt', required=True, help='Receipt path')
    run_parser.add_argument('command', nargs=argparse.REMAINDER, help='Command to execute')

    args = parser.parse_args()

    registry = Registry(directory=args.directory, policy=args.policy)

    if args.action == 'init':
        registry.initialize()
        print('initialized')
        return

    if args.action == 'status':
        print(json.dumps(registry.status(), indent=2))
        return

    if args.action == 'acquire':
        receipt = registry.acquire(
            owner=args.owner,
            issue=args.issue,
            pool=args.pool,
            slots=args.slots,
            reads=args.read,
            writes=args.write,
            parent=load_receipt(Path(args.parent)) if args.parent else None,
            drain=args.drain,
            receipt_path=Path(args.receipt)
        )
        print(json.dumps(receipt))
        return

    if args.action == 'release':
        receipt = load_receipt(Path(args.receipt))
        registry.release(receipt, args.evidence)
        print('released')
        return

    if args.action == 'renew':
        receipt = load_receipt(Path(args.receipt))
        registry.renew(receipt)
        print('renewed')
        return

    if args.action == 'activate':
        receipt = load_receipt(Path(args.receipt))
        registry.activate(receipt)
        print('activated')
        return

    if args.action == 'reap':
        reaped = registry.reap_expired(force=args.force)
        print(json.dumps({'reaped': reaped, 'count': len(reaped)}))
        return

    if args.action == 'run':
        run_command_with_lease(registry, args, Path(args.receipt))
        return


if __name__ == '__main__':
    main()
