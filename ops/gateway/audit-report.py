#!/usr/bin/env python3
"""추적표·이슈·스레드·바인딩 네 표면 대조 보고.

넷이 따로 움직이면 조용히 어긋난다. 실제로 겪은 것만 네 가지다. 이슈는 닫혔는데
추적표가 새 항목으로 남아 계속 태우고, 스레드는 만들었는데 바인딩이 없어 받지
못하고, 사라진 스레드 식별자가 404 로 감시기를 죽이고, 같은 이슈에 스레드가 둘
생겼다.

고치지 않는다. 어긋난 곳만 말한다. 상태를 바꾸는 것은 각 표면을 맡은 도구의 몫이다.

  audit-report.py <추적표> <게이트웨이설정> <수집디렉터리> <채널식별자>

수집 디렉터리에는 active.json, archived.json, issues.tsv 가 있어야 한다.
종료코드 0=일치, 1=불일치.
"""
import json, sys

tracker_path, config_path, tmp, channel_id = sys.argv[1:5]

items = json.load(open(tracker_path))["items"]
bindings = json.load(open(config_path)).get("discord", {}).get("bindings", [])
bound = {b.get("threadId") for b in bindings if b.get("threadId")}

active = [t for t in json.load(open(f"{tmp}/active.json")).get("threads", [])
          if t.get("parent_id") == channel_id]
archived = json.load(open(f"{tmp}/archived.json")).get("threads", [])
threads = {t["id"]: t for t in active + archived}
archived_ids = {t["id"] for t in archived}

issue_state = {}
for line in open(f"{tmp}/issues.tsv"):
    k, _, v = line.rstrip("\n").partition("\t")
    issue_state[k] = v

DONE = {"completed", "closed"}
problems = []
notes = []
print(f"추적표: {tracker_path}")
print()
print("키                          추적표상태                GitHub   스레드    바인딩")
print("-" * 86)
seen = set()
for it in sorted(items, key=lambda x: x.get("key", "")):
    key = it.get("key", "")
    state = it.get("state", "")
    tid = it.get("threadId")
    ghs = issue_state.get(key, "?")
    if tid:
        seen.add(tid)
        if tid not in threads:
            tstat = "삭제됨"
        elif tid in archived_ids:
            tstat = "보관"
        else:
            tstat = "열림"
        bstat = "O" if tid in bound else "없음"
    else:
        tstat, bstat = "없음", "-"
    print(f"{key:<26} {state:<24} {ghs:<8} {tstat:<8} {bstat}")

    done = state in DONE
    if ghs in ("LOOKUP_FAILED", "UNKNOWN_REPO", "?"):
        problems.append(f"{key}: GitHub 상태를 확인하지 못했다 ({ghs})")
    if done and ghs == "OPEN" and not it.get("closedBy"):
        # closedBy 가 있으면 resolve-followup 으로 일부러 정리한 것이다. GitHub 이슈는
        # 계속 열려 있어도 Discord 쪽 후속 조치만 끝나는 경우가 실제로 있다.
        problems.append(f"{key}: 추적표는 완료인데 GitHub 은 열려 있다 (정리 근거 없음)")
    elif done and ghs == "OPEN":
        notes.append(f"{key}: GitHub 은 열려 있으나 후속 조치는 정리됨 ({it.get('closedBy')})")
    if not done and ghs == "CLOSED":
        problems.append(f"{key}: GitHub 은 닫혔는데 추적표는 {state} 다 (배분기가 계속 태운다)")
    if not done and tstat != "열림":
        problems.append(f"{key}: 진행 중인데 스레드가 {tstat} 이다")
    if not done and bstat == "없음":
        problems.append(f"{key}: 바인딩이 없어 게이트웨이가 이 스레드를 받지 못한다")
    if tstat == "삭제됨":
        problems.append(f"{key}: 삭제된 스레드 ID 를 들고 있다 (조회 404 가 감시기를 죽인다)")

orphans = [t for tid, t in threads.items() if tid not in seen]
print(f"\n추적표에 없는 스레드 {len(orphans)} 개")
for t in orphans:
    live = "보관" if t["id"] in archived_ids else "열림"
    print(f"  {t['id']}  {live}  {t.get('name')}")
    # 보관된 고아는 흔적일 뿐이다. 열려 있는 고아는 사람이 쓰고 있을 수 있다.
    if live == "열림":
        problems.append(f"열린 고아 스레드: {t.get('name')} ({t['id']}) — 추적표에 없다")

names = {}
for tid, t in threads.items():
    names.setdefault(t.get("name", ""), []).append(tid)
dups = {n: v for n, v in names.items() if len(v) > 1}
print("\n중복 이름 스레드:", dups if dups else "없음")
for n, v in dups.items():
    problems.append(f"같은 이름 스레드가 {len(v)} 개: {n}")

if notes:
    print(f"\n참고 {len(notes)} 건")
    for n in notes:
        print("  ·", n)

print("\n" + "=" * 86)
if problems:
    print(f"불일치 {len(problems)} 건")
    for p in problems:
        print("  ▸", p)
    sys.exit(1)
print("불일치 없음")
