#!/usr/bin/env python3
"""Integration / E2E tests for ADK Dashboard Server, Watchdog, and Reporter."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.request
import urllib.error
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import importlib
watchdog_module = importlib.import_module('adk-dashboard-watchdog')
reporter_module = importlib.import_module('adk-telemetry-reporter')


def get_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('', 0))
        return s.getsockname()[1]


class TestAdkDashboard(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_dir = Path(tempfile.mkdtemp(prefix='adk-dash-test-'))
        cls.policy_path = cls.temp_dir / 'resource-coordination.json'
        policy_data = {
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
            "automatic_expiry_release": False
        }
        cls.policy_path.write_text(json.dumps(policy_data))

        cls.port = get_free_port()
        cls.state_dir = cls.temp_dir / 'state'
        cmd = [
            sys.executable,
            str(Path(__file__).resolve().parents[1] / 'scripts/adk-dashboard-server.py'),
            '--port', str(cls.port),
            '--bind', 'localhost',
            '--policy', str(cls.policy_path),
            '--directory', str(cls.state_dir),
            '--server-name', 'test-server',
            '--title', 'Test Dashboard'
        ]
        cls.server_proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        # Wait for server to start
        deadline = time.time() + 5
        started = False
        while time.time() < deadline:
            try:
                with socket.create_connection(('localhost', cls.port), timeout=0.5):
                    started = True
                    break
            except OSError:
                time.sleep(0.1)
        if not started:
            cls.server_proc.terminate()
            raise RuntimeError("Failed to start adk-dashboard-server for tests")

    @classmethod
    def tearDownClass(cls):
        if cls.server_proc:
            cls.server_proc.terminate()
            try:
                cls.server_proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                cls.server_proc.kill()
        shutil.rmtree(cls.temp_dir, ignore_errors=True)

    def test_health_endpoint_and_headers(self):
        url = f"http://localhost:{self.port}/api/health"
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=2) as resp:
            self.assertEqual(resp.status, 200)
            content_length = resp.headers.get('Content-Length')
            self.assertIsNotNone(content_length)
            cache_control = resp.headers.get('Cache-Control')
            self.assertIn('no-cache', cache_control)

            body = resp.read()
            self.assertEqual(len(body), int(content_length))
            data = json.loads(body.decode('utf-8'))
            self.assertEqual(data.get('status'), 'ok')
            self.assertEqual(data.get('server'), 'test-server')

    def test_snapshot_endpoint(self):
        url = f"http://localhost:{self.port}/api/snapshot"
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=2) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode('utf-8'))
            self.assertEqual(data.get('title'), 'Test Dashboard')
            self.assertIn('server', data)
            self.assertIn('cpu_percent', data['server'])
            self.assertIn('slots', data)
            self.assertIn('pools', data['slots'])
            self.assertEqual(data['slots']['pools']['gateway']['capacity'], 6)

    def test_telemetry_post_and_aggregation(self):
        dashboard_url = f"http://localhost:{self.port}"
        mock_payload = {
            'node_id': 'developer-laptop-42',
            'hostname': 'dev-macbook',
            'cpu_load': 0.85,
            'active_sessions': [{'pid': 1234, 'command': 'agy interactive'}]
        }

        ok, msg = reporter_module.push_telemetry(dashboard_url, mock_payload)
        self.assertTrue(ok, f"Push failed: {msg}")

        # Now verify /api/snapshot contains the new node
        req = urllib.request.Request(dashboard_url + '/api/snapshot')
        with urllib.request.urlopen(req, timeout=2) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            nodes = data.get('telemetry_nodes', {})
            self.assertIn('developer-laptop-42', nodes)
            self.assertEqual(nodes['developer-laptop-42']['hostname'], 'dev-macbook')

    def test_watchdog_health_checker(self):
        # Health check against live server -> PASS
        ok, msg = watchdog_module.check_health(f"http://localhost:{self.port}/api/health")
        self.assertTrue(ok)
        self.assertEqual(msg, "OK")

    def test_telemetry_validation_and_rejection(self):
        url = f"http://localhost:{self.port}/api/telemetry"
        # 1. Invalid node_id with XSS payload should be rejected with 400
        xss_payload = json.dumps({'node_id': '<script>alert(1)</script>'}).encode('utf-8')
        req = urllib.request.Request(url, data=xss_payload, headers={'Content-Type': 'application/json'}, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=2) as resp:
                self.fail("Expected HTTP 400 for invalid node_id")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 400)
            err_data = json.loads(e.read().decode('utf-8'))
            self.assertEqual(err_data.get('error'), 'invalid_node_id')

    def test_html_escaping_and_content(self):
        url = f"http://localhost:{self.port}/"
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=2) as resp:
            self.assertEqual(resp.status, 200)
            html = resp.read().decode('utf-8')
            self.assertIn('function escapeHtml(str)', html)
            self.assertIn('Test Dashboard', html)


if __name__ == '__main__':
    unittest.main()
