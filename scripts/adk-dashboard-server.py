#!/usr/bin/env python3
"""ADK Development Dashboard Server (naia-pj-adk Server Profile).

Single-process dashboard providing real-time visibility into:
- 10-slot resource coordination and active leases
- Host vitals (CPU load, memory, disk)
- Active agent sessions and multi-node telemetry
- GitHub issues & workflow states
- Full i18n (Korean & English) support
"""
import argparse
from datetime import datetime, timezone
import http.server
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.adk_resources import Registry, Refused, find_default_policy

CACHE_OPEN_ISSUES = []
CACHE_CLOSED_ISSUES = []
CACHE_LAST_REFRESH = 0
CACHE_LOCK = threading.Lock()
TELEMETRY_NODES = {}
TELEMETRY_LOCK = threading.Lock()


def get_git_repo_name() -> str:
    env_repo = os.environ.get('ADK_REPO')
    if env_repo:
        return env_repo
    try:
        remote = subprocess.check_output(
            ['git', 'config', '--get', 'remote.origin.url'],
            text=True, stderr=subprocess.DEVNULL
        ).strip()
        if remote.endswith('.git'):
            remote = remote[:-4]
        if 'github.com' in remote:
            parts = remote.split('github.com')[-1].lstrip('/:')
            return parts
    except Exception:
        pass
    return 'local/project'


def refresh_issues_worker(repo: str):
    """Background daemon thread to fetch open and closed issues periodically without blocking HTTP requests."""
    global CACHE_OPEN_ISSUES, CACHE_CLOSED_ISSUES, CACHE_LAST_REFRESH
    while True:
        try:
            # 1. Open issues
            cmd_open = [
                'gh', 'issue', 'list',
                '--repo', repo,
                '--state', 'open',
                '--limit', '30',
                '--json', 'number,title,state,updatedAt,assignees,labels,author'
            ]
            res_open = subprocess.run(cmd_open, capture_output=True, text=True, timeout=10)
            open_list = json.loads(res_open.stdout) if res_open.returncode == 0 else []

            # 2. Closed issues
            cmd_closed = [
                'gh', 'issue', 'list',
                '--repo', repo,
                '--state', 'closed',
                '--limit', '20',
                '--json', 'number,title,state,updatedAt,assignees,labels,author'
            ]
            res_closed = subprocess.run(cmd_closed, capture_output=True, text=True, timeout=10)
            closed_list = json.loads(res_closed.stdout) if res_closed.returncode == 0 else []

            with CACHE_LOCK:
                CACHE_OPEN_ISSUES = open_list
                CACHE_CLOSED_ISSUES = closed_list
                CACHE_LAST_REFRESH = time.time()
        except Exception:
            pass
        time.sleep(30)


def get_server_stats(server_name: str) -> dict:
    load1, load5, load15 = os.getloadavg()
    cpu_count = os.cpu_count() or 1
    load_percent = round((load1 / cpu_count) * 100, 1)

    mem_total_gb = 0
    mem_used_percent = 0
    try:
        with open('/proc/meminfo', 'r') as f:
            lines = f.readlines()
        mem_info = {}
        for line in lines:
            parts = line.split(':')
            if len(parts) == 2:
                mem_info[parts[0].strip()] = int(parts[1].split()[0])
        total_kb = mem_info.get('MemTotal', 1)
        avail_kb = mem_info.get('MemAvailable', 0)
        used_kb = total_kb - avail_kb
        mem_total_gb = round(total_kb / 1024 / 1024, 1)
        mem_used_percent = round((used_kb / total_kb) * 100, 1)
    except Exception:
        pass

    disk_percent = 0
    try:
        du = shutil.disk_usage('/')
        disk_percent = round((du.used / du.total) * 100, 1)
    except Exception:
        pass

    uptime_str = ''
    try:
        with open('/proc/uptime', 'r') as f:
            up_sec = float(f.readline().split()[0])
        days = int(up_sec // 86400)
        hours = int((up_sec % 86400) // 3600)
        uptime_str = f"{days}d {hours}h"
    except Exception:
        uptime_str = 'unknown'

    return {
        'hostname': server_name,
        'uptime': uptime_str,
        'cpu_load1': round(load1, 2),
        'cpu_percent': load_percent,
        'mem_percent': mem_used_percent,
        'mem_total_gb': mem_total_gb,
        'disk_percent': disk_percent
    }


def create_handler(registry: Registry, title: str, repo: str, server_name: str):
    class DashboardHandler(http.server.BaseHTTPRequestHandler):
        server_version = 'ADK-Dashboard/1.0'

        def _send_bytes(self, status: int, mime: str, body: bytes):
            self.send_response(status)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
            self.end_headers()
            self.wfile.write(body)

        def _send_json(self, status: int, data: dict):
            body = json.dumps(data, ensure_ascii=False).encode('utf-8')
            self._send_bytes(status, 'application/json; charset=utf-8', body)

        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path

            if path == '/api/health':
                self._send_json(200, {'status': 'ok', 'server': server_name, 'timestamp': time.time()})
                return

            if path == '/api/snapshot':
                try:
                    slot_status = registry.status()
                except Exception as e:
                    slot_status = {'error': str(e), 'pools': {}, 'leases': []}

                server_stats = get_server_stats(server_name)

                # Prune stale telemetry nodes (> 180s) to prevent memory leak
                now = time.time()
                with TELEMETRY_LOCK:
                    stale = [k for k, v in TELEMETRY_NODES.items() if (now - v.get('last_seen', 0)) >= 180]
                    for k in stale:
                        del TELEMETRY_NODES[k]
                    active_nodes = dict(TELEMETRY_NODES)

                with CACHE_LOCK:
                    open_issues = list(CACHE_OPEN_ISSUES)
                    cached_closed = list(CACHE_CLOSED_ISSUES)
                    cached_at = CACHE_LAST_REFRESH

                payload = {
                    'server': server_stats,
                    'slots': slot_status,
                    'issues': {
                        'open': open_issues,
                        'closed': cached_closed,
                        'cached_at': cached_at
                    },
                    'telemetry_nodes': active_nodes,
                    'title': title,
                    'repo': repo,
                    'timestamp': datetime.now(timezone.utc).isoformat()
                }
                self._send_json(200, payload)
                return

            if path in ('/', '/index.html'):
                html = get_dashboard_html(title, repo, server_name)
                self._send_bytes(200, 'text/html; charset=utf-8', html.encode('utf-8'))
                return

            self._send_bytes(404, 'text/plain', b'Not Found')

        def do_POST(self):
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path

            if path == '/api/telemetry':
                length = int(self.headers.get('Content-Length', 0))
                if length > 65536:
                    self._send_json(400, {'error': 'payload_too_large'})
                    return
                body = self.rfile.read(length)
                try:
                    data = json.loads(body)
                    node_id = str(data.get('node_id') or data.get('hostname') or '').strip()
                    if not node_id or not re.fullmatch(r'[A-Za-z0-9._-]{1,64}', node_id):
                        self._send_json(400, {'error': 'invalid_node_id'})
                        return
                    hostname = str(data.get('hostname') or node_id).strip()
                    if not re.fullmatch(r'[A-Za-z0-9._-]{1,64}', hostname):
                        hostname = node_id
                    data['node_id'] = node_id
                    data['hostname'] = hostname
                    data['last_seen'] = time.time()
                    with TELEMETRY_LOCK:
                        if len(TELEMETRY_NODES) >= 100 and node_id not in TELEMETRY_NODES:
                            self._send_json(429, {'error': 'max_nodes_exceeded'})
                            return
                        TELEMETRY_NODES[node_id] = data
                    self._send_json(200, {'status': 'recorded', 'node_id': node_id})
                except Exception as e:
                    self._send_json(400, {'error': str(e)})
                return

            self._send_bytes(404, 'text/plain', b'Not Found')

        def log_message(self, format, *args):
            pass

    return DashboardHandler


def get_dashboard_html(title: str, repo: str, server_name: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
:root {{
  --bg: #0f172a;
  --card: #1e293b;
  --card-border: #334155;
  --text: #f8fafc;
  --text-dim: #94a3b8;
  --accent: #38bdf8;
  --green: #22c55e;
  --yellow: #eab308;
  --red: #ef4444;
}}
* {{ box-sizing: border-box; margin: 0; padding: 0; }}
body {{
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background-color: var(--bg);
  color: var(--text);
  padding: 1.5rem;
  line-height: 1.5;
}}
header {{
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--card-border);
}}
.header-title h1 {{ font-size: 1.5rem; font-weight: 700; color: var(--accent); }}
.header-title .sub {{ font-size: 0.85rem; color: var(--text-dim); }}
.header-controls {{ display: flex; gap: 0.75rem; align-items: center; }}
.btn {{
  background: var(--card);
  color: var(--text);
  border: 1px solid var(--card-border);
  padding: 0.35rem 0.75rem;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 600;
  transition: all 0.2s;
}}
.btn:hover {{ border-color: var(--accent); color: var(--accent); }}
#errorBanner {{
  display: none;
  background: var(--red);
  color: #fff;
  padding: 0.5rem 1rem;
  border-radius: 6px;
  margin-bottom: 1rem;
  font-size: 0.85rem;
  font-weight: 600;
}}
.grid {{
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 1rem;
  margin-bottom: 1.5rem;
}}
.card {{
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: 8px;
  padding: 1.25rem;
}}
.card-header {{
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.75rem;
}}
.card-title {{ font-size: 0.95rem; font-weight: 700; color: var(--text-dim); text-transform: uppercase; }}
.vitals {{ display: flex; justify-content: space-between; margin-top: 0.5rem; }}
.vital-item {{ text-align: center; }}
.vital-val {{ font-size: 1.25rem; font-weight: 700; color: var(--text); }}
.vital-lbl {{ font-size: 0.75rem; color: var(--text-dim); }}
.slot-grid {{
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 0.75rem;
  margin-top: 0.75rem;
}}
.slot-card {{
  background: #0f172a;
  border: 1px solid var(--card-border);
  border-radius: 6px;
  padding: 0.75rem;
  font-size: 0.85rem;
}}
.slot-badge {{
  display: inline-block;
  padding: 0.15rem 0.4rem;
  border-radius: 4px;
  font-size: 0.7rem;
  font-weight: 700;
  margin-bottom: 0.35rem;
}}
.badge-held {{ background: rgba(34, 197, 94, 0.2); color: var(--green); }}
.badge-draining {{ background: rgba(234, 179, 8, 0.2); color: var(--yellow); }}
.badge-frozen {{ background: rgba(239, 68, 68, 0.2); color: var(--red); }}
.badge-idle {{ background: rgba(148, 163, 184, 0.2); color: var(--text-dim); }}
table {{
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
  margin-top: 0.5rem;
}}
th, td {{ padding: 0.6rem; text-align: left; border-bottom: 1px solid var(--card-border); }}
th {{ color: var(--text-dim); font-weight: 600; }}
a {{ color: var(--accent); text-decoration: none; }}
a:hover {{ text-decoration: underline; }}
</style>
</head>
<body>
<div id="errorBanner"></div>
<header>
  <div class="header-title">
    <h1 id="txtTitle">{title}</h1>
    <div class="sub" id="txtSub">Host: {server_name} | Repo: {repo}</div>
  </div>
  <div class="header-controls">
    <button class="btn" id="langToggle">EN</button>
    <button class="btn" id="refreshBtn">Refresh</button>
  </div>
</header>

<div class="grid">
  <div class="card">
    <div class="card-header"><span class="card-title" id="lblHostVitals">Host Vitals</span></div>
    <div class="vitals">
      <div class="vital-item"><div class="vital-val" id="vitalCpu">-</div><div class="vital-lbl">CPU Load</div></div>
      <div class="vital-item"><div class="vital-val" id="vitalMem">-</div><div class="vital-lbl">Memory</div></div>
      <div class="vital-item"><div class="vital-val" id="vitalDisk">-</div><div class="vital-lbl">Disk</div></div>
      <div class="vital-item"><div class="vital-val" id="vitalUptime">-</div><div class="vital-lbl">Uptime</div></div>
    </div>
  </div>
  <div class="card">
    <div class="card-header"><span class="card-title" id="lblSlotsSummary">Resource Slots (Total: 10)</span></div>
    <div class="vitals" id="poolsContainer">
      <div class="vital-item"><div class="vital-val" id="poolGateway">-</div><div class="vital-lbl">Gateway (6)</div></div>
      <div class="vital-item"><div class="vital-val" id="poolInteractive">-</div><div class="vital-lbl">Interactive (3)</div></div>
      <div class="vital-item"><div class="vital-val" id="poolDashboard">-</div><div class="vital-lbl">Dashboard (1)</div></div>
    </div>
  </div>
</div>

<div class="card" style="margin-bottom: 1.5rem;">
  <div class="card-header"><span class="card-title" id="lblActiveLeases">Active Leases & Slots</span></div>
  <div class="slot-grid" id="leasesContainer"></div>
</div>

<div class="card" style="margin-bottom: 1.5rem;" id="telemetrySection">
  <div class="card-header"><span class="card-title" id="lblRemoteNodes">Remote Developer PC Nodes</span></div>
  <div class="slot-grid" id="telemetryContainer"></div>
</div>

<div class="card">
  <div class="card-header"><span class="card-title" id="lblOpenIssues">Active GitHub Issues</span></div>
  <table>
    <thead>
      <tr>
        <th id="thNumber">#</th>
        <th id="thTitle">Title</th>
        <th id="thAssignee">Assignee</th>
        <th id="thUpdated">Updated</th>
      </tr>
    </thead>
    <tbody id="issuesTableBody">
      <tr><td colspan="4" style="text-align:center;">Loading...</td></tr>
    </tbody>
  </table>
</div>

<script>
const I18N = {{
  ko: {{
    title: "{title}",
    hostVitals: "호스트 상태 (CPU / 메모리)",
    slotsSummary: "공용 자원 슬롯 (총 10개)",
    activeLeases: "슬롯 리스 및 점유 현황",
    remoteNodes: "원격 개발 PC 노드",
    openIssues: "진행 중인 이슈 목록",
    noLeases: "현재 점유 중인 리스가 없습니다 (모든 슬롯 가용).",
    noNodes: "등록된 원격 개발 PC가 없습니다.",
    noIssues: "진행 중인 열린 이슈가 없습니다.",
    errorFetch: "대시보드 데이터를 가져오지 못했습니다. 서버 상태를 확인하세요."
  }},
  en: {{
    title: "{title}",
    hostVitals: "Host Vitals",
    slotsSummary: "Resource Slots (Total: 10)",
    activeLeases: "Active Leases & Slots",
    remoteNodes: "Remote Developer PC Nodes",
    openIssues: "Active GitHub Issues",
    noLeases: "No active leases reserved (all slots available).",
    noNodes: "No remote developer PC nodes registered.",
    noIssues: "No open issues found.",
    errorFetch: "Failed to fetch dashboard data. Check server status."
  }}
}};

function escapeHtml(str) {{
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}}

let curLang = localStorage.getItem('adk_lang') || (navigator.language.startsWith('ko') ? 'ko' : 'en');

function updateLang() {{
  const d = I18N[curLang];
  document.getElementById('lblHostVitals').innerText = d.hostVitals;
  document.getElementById('lblSlotsSummary').innerText = d.slotsSummary;
  document.getElementById('lblActiveLeases').innerText = d.activeLeases;
  document.getElementById('lblRemoteNodes').innerText = d.remoteNodes;
  document.getElementById('lblOpenIssues').innerText = d.openIssues;
  document.getElementById('langToggle').innerText = curLang === 'ko' ? 'EN' : '한';
}}

document.getElementById('langToggle').onclick = () => {{
  curLang = curLang === 'ko' ? 'en' : 'ko';
  localStorage.setItem('adk_lang', curLang);
  updateLang();
  fetchData();
}};

document.getElementById('refreshBtn').onclick = () => fetchData();

async function fetchData() {{
  const errBanner = document.getElementById('errorBanner');
  try {{
    const res = await fetch('/api/snapshot');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    errBanner.style.display = 'none';

    // 1. Host Vitals
    try {{
      document.getElementById('vitalCpu').innerText = data.server.cpu_percent + '%';
      document.getElementById('vitalMem').innerText = data.server.mem_percent + '%';
      document.getElementById('vitalDisk').innerText = data.server.disk_percent + '%';
      document.getElementById('vitalUptime').innerText = data.server.uptime;
    }} catch(e) {{}}

    // 2. Pools
    try {{
      if (data.slots && data.slots.pools) {{
        const gw = data.slots.pools.gateway;
        const it = data.slots.pools.interactive;
        const db = data.slots.pools.dashboard;
        if (gw) document.getElementById('poolGateway').innerText = (gw.capacity - gw.available) + ' / ' + gw.capacity;
        if (it) document.getElementById('poolInteractive').innerText = (it.capacity - it.available) + ' / ' + it.capacity;
        if (db) document.getElementById('poolDashboard').innerText = (db.capacity - db.available) + ' / ' + db.capacity;
      }}
    }} catch(e) {{}}

    // 3. Leases
    try {{
      const leasesBox = document.getElementById('leasesContainer');
      leasesBox.innerHTML = '';
      if (!data.slots || !data.slots.leases || data.slots.leases.length === 0) {{
        leasesBox.innerHTML = '<div style="color:var(--text-dim);">' + I18N[curLang].noLeases + '</div>';
      }} else {{
        data.slots.leases.forEach(l => {{
          const div = document.createElement('div');
          div.className = 'slot-card';
          div.innerHTML = `
            <span class="slot-badge badge-${{escapeHtml(l.phase)}}">${{escapeHtml(l.phase.toUpperCase())}}</span>
            <div style="font-weight:700;">${{escapeHtml(l.issue)}} (${{escapeHtml(l.pool)}})</div>
            <div style="color:var(--text-dim);font-size:0.75rem;">Owner: ${{escapeHtml(l.owner)}}</div>
            <div style="color:var(--text-dim);font-size:0.75rem;">Slots: ${{escapeHtml(l.slots)}}</div>
          `;
          leasesBox.appendChild(div);
        }});
      }}
    }} catch(e) {{}}

    // 4. Remote Nodes
    try {{
      const tBox = document.getElementById('telemetryContainer');
      tBox.innerHTML = '';
      const nodes = Object.values(data.telemetry_nodes || {{}});
      if (nodes.length === 0) {{
        tBox.innerHTML = '<div style="color:var(--text-dim);">' + I18N[curLang].noNodes + '</div>';
      }} else {{
        nodes.forEach(n => {{
          const div = document.createElement('div');
          div.className = 'slot-card';
          const name = escapeHtml(n.hostname || n.node_id);
          const sessionsCount = (n.active_sessions || []).length;
          const seenSec = Math.round(Date.now()/1000 - n.last_seen);
          div.innerHTML = `
            <span class="slot-badge badge-held">ONLINE</span>
            <div style="font-weight:700;">${{name}}</div>
            <div style="color:var(--text-dim);font-size:0.75rem;">Sessions: ${{sessionsCount}}</div>
            <div style="color:var(--text-dim);font-size:0.75rem;">Seen: ${{seenSec}}s ago</div>
          `;
          tBox.appendChild(div);
        }});
      }}
    }} catch(e) {{}}

    // 5. Issues
    try {{
      const tb = document.getElementById('issuesTableBody');
      tb.innerHTML = '';
      const issues = (data.issues && data.issues.open) || [];
      if (issues.length === 0) {{
        tb.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-dim);">' + I18N[curLang].noIssues + '</td></tr>';
      }} else {{
        issues.forEach(it => {{
          const tr = document.createElement('tr');
          const assignees = (it.assignees || []).map(a => escapeHtml(a.login)).join(', ') || '-';
          const num = escapeHtml(it.number);
          const title = escapeHtml(it.title);
          const repo = encodeURIComponent(data.repo || '');
          const updated = escapeHtml((it.updatedAt || '').slice(0, 10));
          tr.innerHTML = `
            <td>#${{num}}</td>
            <td><a href="https://github.com/${{repo}}/issues/${{num}}" target="_blank" rel="noopener noreferrer">${{title}}</a></td>
            <td>${{assignees}}</td>
            <td>${{updated}}</td>
          `;
          tb.appendChild(tr);
        }});
      }}
    }} catch(e) {{}}

  }} catch (err) {{
    errBanner.innerText = I18N[curLang].errorFetch + ' (' + err.message + ')';
    errBanner.style.display = 'block';
  }}
}}

updateLang();
fetchData();
setInterval(fetchData, 5000);
</script>
</body>
</html>"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=int(os.environ.get('ADK_DASHBOARD_PORT', 18050)))
    # public-safety-allow: default server bind address
    parser.add_argument('--bind', default=os.environ.get('ADK_DASHBOARD_BIND', '0.0.0.0'))
    parser.add_argument('--policy', default=None, help='Path to resource-coordination.json')
    parser.add_argument('--directory', default=None, help='State directory for lock and registry')
    parser.add_argument('--title', default=os.environ.get('ADK_DASHBOARD_TITLE', 'ADK Development Dashboard'))
    parser.add_argument('--repo', default=None, help='GitHub owner/repo')
    parser.add_argument('--server-name', default=os.environ.get('ADK_HOST_NAME', platform.node()))

    args = parser.parse_args()

    repo = args.repo or get_git_repo_name()
    registry = Registry(directory=args.directory, policy=args.policy)
    try:
        registry.initialize()
    except Exception as e:
        print(f"[ADK Dashboard] Warning initializing registry: {e}", file=sys.stderr)

    # Start background cache worker
    t = threading.Thread(target=refresh_issues_worker, args=(repo,), daemon=True)
    t.start()

    handler_cls = create_handler(registry, args.title, repo, args.server_name)
    server = http.server.ThreadingHTTPServer((args.bind, args.port), handler_cls)
    print(f"[ADK Dashboard] Serving on http://{args.bind}:{args.port} (Repo: {repo}, Host: {args.server_name})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[ADK Dashboard] Stopped.")


if __name__ == '__main__':
    main()
