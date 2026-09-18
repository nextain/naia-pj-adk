"""Abstract cooperative resource and concurrency lease management.

Provides a locked, fsynced registry for sessions, agent trees, and gateway workers.
Designed for the server profile in naia-pj-adk. Fully configurable with zero hardcoded identities.
"""
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import secrets
import stat
import time
import uuid


class Refused(RuntimeError):
    """Raised when a resource reservation, transition, or policy condition is refused."""
    pass


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def private_file(path: Path) -> None:
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or info.st_mode & 0o077 or info.st_nlink != 1):
        raise Refused('unsafe_file:' + str(path))


def atomic_json(path: Path, value: dict) -> None:
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.new')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, ensure_ascii=False, sort_keys=True, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temp.unlink(missing_ok=True)


def create_receipt(path: Path, value: dict) -> None:
    """Persist capability before committing its lease; never overwrite a retry."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, sort_keys=True)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def overlaps(left: str, right: str) -> bool:
    return left == right or left.startswith(right + '/') or right.startswith(left + '/')


def claim_conflict(left: dict, right: dict) -> bool:
    # Host availability is an intent claim, not a recursive read of all host services.
    if left['mode'] == 'intent':
        return right['mode'] == 'write' and (left['name'] == right['name'] or left['name'].startswith(right['name'] + '/'))
    if right['mode'] == 'intent':
        return claim_conflict(right, left)
    return overlaps(left['name'], right['name']) and (left['mode'] == 'write' or right['mode'] == 'write')


def process_identity(pid: int) -> dict | None:
    """PID reuse and host reboot must not look like the previous owner."""
    try:
        pid = int(pid)
        stat_path = Path(f'/proc/{pid}/stat')
        if stat_path.exists():
            raw = stat_path.read_text()
            boot_id_file = Path('/proc/sys/kernel/random/boot_id')
            boot_id = boot_id_file.read_text().strip() if boot_id_file.exists() else 'mock-boot'
            parts = raw.rsplit(')', 1)
            if len(parts) >= 2:
                fields = parts[1].split()
                if len(fields) > 19:
                    return {
                        'pid': pid,
                        'start': fields[19],
                        'boot': boot_id
                    }

        # Non-Linux / container fallback: parse actual process start time via ps
        res = subprocess.run(
            ['ps', '-p', str(pid), '-o', 'lstart='],
            capture_output=True, text=True, timeout=3
        )
        if res.returncode == 0 and res.stdout.strip():
            return {
                'pid': pid,
                'start': res.stdout.strip(),
                'boot': 'ps-identity'
            }

        os.kill(pid, 0)
        return {'pid': pid, 'start': f'pid-{pid}', 'boot': 'generic'}
    except (FileNotFoundError, ProcessLookupError, IndexError, ValueError, OSError, subprocess.SubprocessError):
        return None


def group_alive(pgid: int | None) -> bool:
    if not pgid:
        return False
    try:
        os.killpg(int(pgid), 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def find_default_policy() -> Path | None:
    env_policy = os.environ.get('ADK_RESOURCE_POLICY')
    if env_policy:
        p = Path(env_policy)
        if p.exists():
            return p
    candidates = [
        Path('.agents/context/resource-coordination.json'),
        Path('resource-coordination.json'),
        Path(__file__).resolve().parents[2] / '.agents/context/resource-coordination.json'
    ]
    for c in candidates:
        if c.exists():
            return c
    return None


class Registry:
    def __init__(self, directory=None, policy=None, clock=time.time):
        policy_path = Path(policy) if policy else find_default_policy()
        if not policy_path or not policy_path.exists():
            raise Refused('resource_policy_not_found')

        raw = policy_path.read_bytes()
        self.policy = json.loads(raw)
        self.policy_sha = digest(raw)

        # Resolve state directory: explicit arg > policy > env > ~/.local/state/adk-resource-coordination
        if directory:
            self.directory = Path(directory)
        elif self.policy.get('state_directory'):
            self.directory = Path(os.path.expanduser(self.policy['state_directory']))
        elif os.environ.get('ADK_STATE_DIR'):
            self.directory = Path(os.path.expanduser(os.environ['ADK_STATE_DIR']))
        else:
            self.directory = Path.home() / '.local/state/adk-resource-coordination'

        self.clock = clock
        required_fields = [
            'version', 'total_slots', 'pools', 'max_slots_per_tree',
            'lease_seconds', 'max_lease_seconds', 'heartbeat_seconds',
            'automatic_expiry_release'
        ]
        for rf in required_fields:
            if rf not in self.policy:
                raise Refused('missing_policy_field:' + rf)

        pools = self.policy['pools']
        if (self.policy.get('version') != 1 or any(type(n) is not int or n < 0 for n in pools.values())
                or sum(pools.values()) != self.policy['total_slots']):
            raise Refused('invalid_capacity_policy')

        # Host logical identity
        self.host_identity = (
            self.policy.get('host')
            or os.environ.get('ADK_HOST_NAME')
            or platform.node()
            or 'localhost'
        )

    def check_directory(self) -> None:
        info = self.directory.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077 or self.directory.resolve() != self.directory):
            raise Refused('unsafe_registry_directory')

    def initialize(self) -> None:
        try:
            self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            new = not (self.directory / 'registry.json').exists()
        except OSError as e:
            raise Refused('cannot_create_state_dir:' + str(e))
        self.check_directory()
        with self.transaction(initialize=new):
            pass

    @contextmanager
    def transaction(self, initialize=False):
        if not self.directory.exists():
            raise Refused('registry_not_initialized')
        self.check_directory()
        lock_path = self.directory / 'registry.lock'
        fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            private_file(lock_path)
            fcntl.flock(fd, fcntl.LOCK_EX)
            path = self.directory / 'registry.json'
            if path.exists() or path.is_symlink():
                private_file(path)
                try:
                    data = json.loads(path.read_bytes())
                except (ValueError, UnicodeError) as error:
                    raise Refused('registry_corrupt') from error
            elif initialize:
                data = {'version': 1, 'policy_sha256': self.policy_sha, 'leases': {}, 'history': []}
            else:
                raise Refused('registry_missing_no_automatic_reset')

            if data.get('version') != 1 or data.get('policy_sha256') != self.policy_sha:
                raise Refused('registry_policy_drift')
            if not isinstance(data.get('leases'), dict) or not isinstance(data.get('history'), list):
                raise Refused('registry_corrupt')

            maintenance = data.get('maintenance')
            if maintenance is not None and (not isinstance(maintenance, dict)
                    or not isinstance(maintenance.get('id'), str)
                    or not isinstance(maintenance.get('manager'), dict)):
                raise Refused('registry_corrupt')

            for key, row in data['leases'].items():
                if (not isinstance(row, dict) or row.get('id') != key
                        or row.get('pool') not in self.policy['pools']
                        or type(row.get('slots')) is not int or row['slots'] < 1
                        or row.get('phase') not in {'held', 'draining', 'frozen'}
                        or type(row.get('expires_at')) not in {int, float}
                        or not isinstance(row.get('resources'), list)
                        or not isinstance(row.get('token_sha256'), str)
                        or (row.get('parent') and row['parent'] not in data['leases'])):
                    raise Refused('registry_corrupt')
                if any(not isinstance(c, dict) or c.get('mode') not in {'read', 'write', 'intent'}
                       or not isinstance(c.get('name'), str) for c in row['resources']):
                    raise Refused('registry_corrupt')

            before = json.dumps(data, sort_keys=True)
            yield data
            if not path.exists() or json.dumps(data, sort_keys=True) != before:
                atomic_json(path, data)
        finally:
            os.close(fd)

    def claims(self, reads=(), writes=()):
        claims = {}
        resource_roots = set(self.policy.get('resource_roots', ['host', 'database', 'repository', 'worktree', 'cloud']))
        aliases = self.policy.get('aliases', {})

        for mode, names in [('read', reads), ('write', writes)]:
            for name in names:
                name = aliases.get(name, name)
                if (not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]*(/[a-zA-Z0-9][a-zA-Z0-9._-]*)+', name)
                        or any(part in {'.', '..'} for part in name.split('/'))
                        or name.split('/')[0] not in resource_roots):
                    raise Refused('invalid_resource:' + name)
                if claims.get(name) != 'write':
                    claims[name] = mode

        # Intent claim for host availability
        claims.setdefault('host/' + self.host_identity, 'intent')
        return [{'name': name, 'mode': mode} for name, mode in sorted(claims.items())]

    def phase(self, row: dict) -> str:
        if row['phase'] == 'frozen' or row['expires_at'] <= self.clock():
            return 'frozen'
        manager = row.get('manager')
        if manager and process_identity(manager['pid']) != manager:
            return 'frozen'
        return row['phase']

    def conflicts(self, claims: list, rows: dict, exclude=None) -> list:
        blocked = []
        for key, row in rows.items():
            if key == exclude:
                continue
            if any(claim_conflict(a, b) for a in claims for b in row['resources']):
                blocked.append(key)
        return blocked

    def authenticate(self, data: dict, receipt: dict, active=False) -> dict:
        row = data['leases'].get(receipt.get('id'))
        supplied = digest(str(receipt.get('token', '')).encode())
        if not row or not secrets.compare_digest(row['token_sha256'], supplied):
            raise Refused('reservation_owner_mismatch')
        if active and self.phase(row) == 'frozen':
            raise Refused('reservation_frozen_reconcile_required')
        return row

    def event(self, data: dict, action: str, row: dict, **extra) -> None:
        limit = self.policy.get('recent_event_limit', 50)
        data['history'].append({
            'at': self.clock(),
            'action': action,
            'id': row['id'],
            'owner': row['owner'],
            'issue': row['issue'],
            **extra
        })
        data['history'] = data['history'][-limit:]

    def acquire(self, owner: str, issue: str, pool: str, slots=1, reads=(), writes=(), parent=None,
                drain=False, manager=None, command_sha256=None, receipt_path=None) -> dict:
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}', owner):
            raise Refused('invalid_owner')
        if '..' in owner or owner.startswith('/') or owner.endswith('/'):
            raise Refused('invalid_owner_traversal')
        if not re.fullmatch(r'([a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+)?#[1-9][0-9]*', issue):
            raise Refused('issue_required')
        if pool not in self.policy['pools'] or type(slots) is not int or slots < 1:
            raise Refused('invalid_pool_or_slots')

        claims = self.claims(reads, writes)
        if drain and (pool != 'interactive' or parent or not writes):
            raise Refused('drain_requires_independent_host_executor')

        with self.transaction() as data:
            if data.get('maintenance') is not None:
                raise Refused('host_installation_fenced_reconcile_before_retry')

            # Reconcile expired leases if automatic_expiry_release is enabled
            if self.policy.get('automatic_expiry_release', False):
                to_reap = [lid for lid, row in data['leases'].items() if self.phase(row) == 'frozen']
                for lid in to_reap:
                    reaped_row = data['leases'].pop(lid)
                    self.event(data, 'reap_expired', reaped_row, reason='automatic_expiry_release')

            rows = data['leases']
            if any(row['owner'] == owner for row in rows.values()):
                raise Refused('owner_already_reserved_inspect_existing')

            parent_row = self.authenticate(data, parent, active=True) if parent else None
            if parent_row and (parent_row['pool'] != pool or parent_row['issue'] != issue
                               or parent_row['phase'] != 'held'):
                raise Refused('parent_scope_mismatch')

            if slots + sum(row['slots'] for row in rows.values() if row['pool'] == pool) > self.policy['pools'][pool]:
                raise Refused('pool_capacity_unavailable:' + pool)

            root = parent_row['root'] if parent_row else uuid.uuid4().hex
            max_slots_tree = self.policy.get('max_slots_per_tree', 2)
            if slots + sum(row['slots'] for row in rows.values() if row['root'] == root) > max_slots_tree:
                raise Refused('agent_tree_capacity_unavailable')

            blocked = self.conflicts(claims, rows)
            if blocked and (not drain or any(self.phase(rows[key]) != 'held' for key in blocked)):
                raise Refused('resource_conflict:' + ','.join(blocked))

            # public-safety-allow: dynamic random lease token generation
            token = secrets.token_hex(32)
            row = {
                'id': uuid.uuid4().hex,
                'root': root,
                'parent': parent_row['id'] if parent_row else None,
                'owner': owner,
                'issue': issue,
                'pool': pool,
                'slots': slots,
                'resources': claims,
                'phase': 'draining' if drain else 'held',
                'created_at': self.clock(),
                'expires_at': self.clock() + self.policy['lease_seconds'],
                'token_sha256': digest(token.encode()),
                'manager': manager,
                'process_group': None,
                'command_sha256': command_sha256
            }
            rows[row['id']] = row
            self.event(data, 'reserve', row)

            receipt = {
                'id': row['id'],
                'token': token,
                'owner': owner,
                'policy_sha256': self.policy_sha
            }
            if receipt_path:
                create_receipt(Path(receipt_path), receipt)
            return receipt

    def renew(self, receipt: dict) -> None:
        with self.transaction() as data:
            row = self.authenticate(data, receipt, active=True)
            if row['parent'] and self.phase(data['leases'][row['parent']]) == 'frozen':
                raise Refused('parent_frozen')
            row['expires_at'] = self.clock() + self.policy['lease_seconds']

    def activate(self, receipt: dict) -> None:
        with self.transaction() as data:
            row = self.authenticate(data, receipt, active=True)
            if row['phase'] == 'draining':
                if self.conflicts(row['resources'], data['leases'], exclude=row['id']):
                    raise Refused('drain_not_finished')
                row['phase'] = 'held'
                self.event(data, 'drain_complete', row)

    def bind_process(self, receipt: dict, pgid: int) -> None:
        with self.transaction() as data:
            row = self.authenticate(data, receipt, active=True)
            if row['phase'] != 'held' or row['process_group'] is not None:
                raise Refused('process_already_bound_or_not_ready')
            row['process_group'] = pgid

    def freeze(self, receipt: dict, reason: str) -> None:
        with self.transaction() as data:
            row = self.authenticate(data, receipt)
            row['phase'] = 'frozen'
            self.event(data, 'freeze', row, reason=reason)

    def release(self, receipt: dict, evidence: str, manager_finished=False) -> None:
        if not re.fullmatch(r'[0-9a-f]{64}', evidence):
            raise Refused('completion_evidence_sha256_required')
        with self.transaction() as data:
            row = self.authenticate(data, receipt)
            if any(other['parent'] == row['id'] for other in data['leases'].values()):
                raise Refused('children_still_reserved')
            manager = row.get('manager')
            if manager and process_identity(manager['pid']) == manager:
                if not manager_finished or manager != process_identity(os.getpid()):
                    raise Refused('manager_still_running')
            if group_alive(row.get('process_group')):
                raise Refused('process_group_still_running')
            self.event(data, 'release', row, evidence_sha256=evidence)
            del data['leases'][row['id']]

    def reap_expired(self, force=False) -> list:
        reaped = []
        with self.transaction() as data:
            for lid, row in list(data['leases'].items()):
                if self.phase(row) == 'frozen':
                    if force or self.policy.get('automatic_expiry_release', False):
                        reaped_row = data['leases'].pop(lid)
                        self.event(data, 'reap_expired', reaped_row, reason='forced_reap' if force else 'automatic_expiry_release')
                        reaped.append(lid)
        return reaped

    def status(self) -> dict:
        with self.transaction() as data:
            if self.policy.get('automatic_expiry_release', False):
                to_reap = [lid for lid, row in data['leases'].items() if self.phase(row) == 'frozen']
                for lid in to_reap:
                    reaped_row = data['leases'].pop(lid)
                    self.event(data, 'reap_expired', reaped_row, reason='automatic_expiry_release')

            rows = []
            for row in data['leases'].values():
                public = {k: v for k, v in row.items() if k != 'token_sha256'}
                public['phase'] = self.phase(row)
                rows.append(public)
            return {
                'policy_sha256': self.policy_sha,
                'host': self.host_identity,
                'pools': {
                    pool: {
                        'capacity': capacity,
                        'used': sum(r['slots'] for r in rows if r['pool'] == pool),
                        'available': capacity - sum(r['slots'] for r in rows if r['pool'] == pool)
                    }
                    for pool, capacity in self.policy['pools'].items()
                },
                'leases': rows,
                'maintenance': data.get('maintenance')
            }
