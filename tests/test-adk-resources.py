#!/usr/bin/env python3
"""Unit tests for ADK resource coordination library and CLI (Server Profile)."""
import json
import os
from pathlib import Path
import shutil
import tempfile
import time
import unittest
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from lib.adk_resources import Registry, Refused, digest


class TestAdkResources(unittest.TestCase):
    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix='adk-res-test-'))
        self.state_dir = self.temp_dir / 'state'
        self.receipts_dir = self.temp_dir / 'receipts'
        self.receipts_dir.mkdir(parents=True, exist_ok=True)

        self.policy_path = self.temp_dir / 'resource-coordination.json'
        self.policy_data = {
            "version": 1,
            "total_slots": 10,
            "pools": {
                "gateway": 6,
                "interactive": 3,
                "dashboard": 1
            },
            "max_slots_per_tree": 2,
            "lease_seconds": 60,
            "max_lease_seconds": 120,
            "heartbeat_seconds": 10,
            "automatic_expiry_release": False,
            "resource_roots": ["host", "database", "repository", "worktree", "cloud"],
            "aliases": {
                "dev-db": "database/app-dev",
                "prod-db": "database/app-prod"
            }
        }
        self.policy_path.write_text(json.dumps(self.policy_data))
        self.clock_val = 1000.0

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def fake_clock(self):
        return self.clock_val

    def test_init_and_empty_status(self):
        registry = Registry(directory=self.state_dir, policy=self.policy_path, clock=self.fake_clock)
        registry.initialize()
        status = registry.status()
        self.assertEqual(status['pools']['gateway']['capacity'], 6)
        self.assertEqual(status['pools']['gateway']['available'], 6)
        self.assertEqual(status['pools']['interactive']['capacity'], 3)
        self.assertEqual(status['pools']['dashboard']['capacity'], 1)
        self.assertEqual(len(status['leases']), 0)

    def test_acquire_and_capacity_limit(self):
        registry = Registry(directory=self.state_dir, policy=self.policy_path, clock=self.fake_clock)
        registry.initialize()

        # Acquire 1 slot on interactive
        receipt1_path = self.receipts_dir / 'r1.json'
        r1 = registry.acquire(
            owner='worker-1',
            issue='#101',
            pool='interactive',
            slots=1,
            receipt_path=receipt1_path
        )
        self.assertIn('id', r1)
        self.assertIn('token', r1)

        # Acquire 2nd slot on interactive
        receipt2_path = self.receipts_dir / 'r2.json'
        r2 = registry.acquire(
            owner='worker-2',
            issue='#102',
            pool='interactive',
            slots=1,
            receipt_path=receipt2_path
        )
        self.assertIn('id', r2)

        # Acquire 3rd slot on interactive
        receipt3_path = self.receipts_dir / 'r3.json'
        r3 = registry.acquire(
            owner='worker-3',
            issue='#103',
            pool='interactive',
            slots=1,
            receipt_path=receipt3_path
        )
        self.assertIn('id', r3)

        status = registry.status()
        self.assertEqual(status['pools']['interactive']['available'], 0)
        self.assertEqual(status['pools']['interactive']['used'], 3)

        # 4th acquisition should be refused (capacity exhausted)
        receipt4_path = self.receipts_dir / 'r4.json'
        with self.assertRaises(Refused) as cm:
            registry.acquire(
                owner='worker-4',
                issue='#104',
                pool='interactive',
                slots=1,
                receipt_path=receipt4_path
            )
        self.assertIn('pool_capacity_unavailable:interactive', str(cm.exception))

    def test_max_slots_per_tree(self):
        registry = Registry(directory=self.state_dir, policy=self.policy_path, clock=self.fake_clock)
        registry.initialize()

        # Parent worker
        r_parent = registry.acquire(
            owner='parent-worker',
            issue='#200',
            pool='gateway',
            slots=1,
            receipt_path=self.receipts_dir / 'parent.json'
        )

        # Child worker 1 (slots = 1, total tree = 2)
        r_child1 = registry.acquire(
            owner='child-worker-1',
            issue='#200',
            pool='gateway',
            slots=1,
            parent=r_parent,
            receipt_path=self.receipts_dir / 'child1.json'
        )
        self.assertIsNotNone(r_child1)

        # Child worker 2 (attempting to exceed max_slots_per_tree=2)
        with self.assertRaises(Refused) as cm:
            registry.acquire(
                owner='child-worker-2',
                issue='#200',
                pool='gateway',
                slots=1,
                parent=r_parent,
                receipt_path=self.receipts_dir / 'child2.json'
            )
        self.assertIn('agent_tree_capacity_unavailable', str(cm.exception))

    def test_resource_conflict_detection(self):
        registry = Registry(directory=self.state_dir, policy=self.policy_path, clock=self.fake_clock)
        registry.initialize()

        # Session A claims write lock on dev-db alias
        r_a = registry.acquire(
            owner='session-a',
            issue='#301',
            pool='interactive',
            slots=1,
            writes=['dev-db'],
            receipt_path=self.receipts_dir / 'ra.json'
        )

        # Session B tries to claim read or write on dev-db -> conflict!
        with self.assertRaises(Refused) as cm:
            registry.acquire(
                owner='session-b',
                issue='#302',
                pool='interactive',
                slots=1,
                reads=['dev-db'],
                receipt_path=self.receipts_dir / 'rb.json'
            )
        self.assertIn('resource_conflict', str(cm.exception))

    def test_lease_expiry_to_frozen(self):
        registry = Registry(directory=self.state_dir, policy=self.policy_path, clock=self.fake_clock)
        registry.initialize()

        r = registry.acquire(
            owner='session-exp',
            issue='#401',
            pool='interactive',
            slots=1,
            receipt_path=self.receipts_dir / 'rexp.json'
        )

        status_before = registry.status()
        self.assertEqual(status_before['leases'][0]['phase'], 'held')

        # Advance clock past lease_seconds (60s)
        self.clock_val += 70.0

        status_after = registry.status()
        self.assertEqual(status_after['leases'][0]['phase'], 'frozen')

        # Attempt to renew expired lease should fail
        with self.assertRaises(Refused) as cm:
            registry.renew(r)
        self.assertIn('reservation_frozen_reconcile_required', str(cm.exception))

    def test_release_with_evidence(self):
        registry = Registry(directory=self.state_dir, policy=self.policy_path, clock=self.fake_clock)
        registry.initialize()

        r = registry.acquire(
            owner='session-rel',
            issue='#501',
            pool='interactive',
            slots=1,
            receipt_path=self.receipts_dir / 'rrel.json'
        )

        status1 = registry.status()
        self.assertEqual(len(status1['leases']), 1)

        evidence = digest(b'completed-successfully')
        registry.release(r, evidence, manager_finished=True)

        status2 = registry.status()
        self.assertEqual(len(status2['leases']), 0)
        self.assertEqual(status2['pools']['interactive']['available'], 3)

    def test_owner_traversal_refused(self):
        registry = Registry(directory=self.state_dir, policy=self.policy_path, clock=self.fake_clock)
        registry.initialize()
        with self.assertRaises(Refused) as cm:
            registry.acquire(
                owner='../../etc/evil',
                issue='#502',
                pool='interactive',
                slots=1
            )
        self.assertIn('invalid_owner', str(cm.exception))

    def test_missing_required_policy_field(self):
        bad_policy = dict(self.policy_data)
        del bad_policy['automatic_expiry_release']
        bad_policy_path = self.temp_dir / 'bad-policy.json'
        bad_policy_path.write_text(json.dumps(bad_policy))
        with self.assertRaises(Refused) as cm:
            Registry(directory=self.state_dir, policy=bad_policy_path, clock=self.fake_clock)
        self.assertIn('missing_policy_field:automatic_expiry_release', str(cm.exception))

    def test_automatic_expiry_reaping(self):
        auto_policy = dict(self.policy_data)
        auto_policy['automatic_expiry_release'] = True
        auto_policy_path = self.temp_dir / 'auto-policy.json'
        auto_policy_path.write_text(json.dumps(auto_policy))

        registry = Registry(directory=self.state_dir, policy=auto_policy_path, clock=self.fake_clock)
        registry.initialize()

        # Acquire 1 slot on interactive
        r = registry.acquire(
            owner='auto-reap-session',
            issue='#601',
            pool='interactive',
            slots=1,
            receipt_path=self.receipts_dir / 'rauto.json'
        )
        status1 = registry.status()
        self.assertEqual(len(status1['leases']), 1)
        self.assertEqual(status1['pools']['interactive']['available'], 2)

        # Advance clock past lease expiry
        self.clock_val += 70.0  # lease_seconds is 60

        # Next status() or acquire() must automatically reap the expired lease
        status2 = registry.status()
        self.assertEqual(len(status2['leases']), 0)
        self.assertEqual(status2['pools']['interactive']['available'], 3)

    def test_manual_reap_expired(self):
        # With automatic_expiry_release = False
        registry = Registry(directory=self.state_dir, policy=self.policy_path, clock=self.fake_clock)
        registry.initialize()

        r = registry.acquire(
            owner='manual-reap-session',
            issue='#602',
            pool='interactive',
            slots=1,
            receipt_path=self.receipts_dir / 'rmanual.json'
        )
        self.clock_val += 70.0

        # Normal status shows it as frozen, not reaped
        status1 = registry.status()
        self.assertEqual(len(status1['leases']), 1)
        self.assertEqual(status1['leases'][0]['phase'], 'frozen')

        # Calling reap_expired(force=True) reaps it
        reaped = registry.reap_expired(force=True)
        self.assertEqual(len(reaped), 1)
        self.assertEqual(reaped[0], r['id'])

        status2 = registry.status()
        self.assertEqual(len(status2['leases']), 0)
        self.assertEqual(status2['pools']['interactive']['available'], 3)


if __name__ == '__main__':
    unittest.main()
