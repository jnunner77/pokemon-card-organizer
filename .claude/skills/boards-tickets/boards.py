#!/usr/bin/env python3
"""Boards work items from the command line (the Boards API, docs/api.md in agile-development-operations).

Needs BOARDS_URL and BOARDS_TOKEN in the environment. The token is sent as a header and never printed.

  boards.py whoami                      who the token acts as, and the current sprint
  boards.py create SPEC.json            a PBI or Bug with its tasks (see SKILL.md); prints the ids
  boards.py state STATE ID [ID...]      e.g. state "In Progress" 112, state Done 100 101
  boards.py comment ID "<p>HTML</p>"
  boards.py link ID URL [COMMENT]       add a hyperlink (e.g. the pull request)
  boards.py show ID                     an item and its child tasks
  boards.py brief ID                    an item's description, acceptance criteria and tasks, as text (for reviews)
"""
import html
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import date

PO_USERNAME = "jnunner77"  # PBIs, Bugs, Features and Epics are assigned to Justin Nunner
TIMEOUT = 30  # seconds to wait for the Boards server before giving up


def call(method, path, body=None):
    url, tok = os.environ.get("BOARDS_URL", "").rstrip("/"), os.environ.get("BOARDS_TOKEN", "")
    if not url or not tok:
        sys.exit("BOARDS_URL and BOARDS_TOKEN must be set (ask the user to add them to the environment).")
    req = urllib.request.Request(url + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path}: HTTP {e.code} {e.read().decode(errors='replace')[:300]}")
    except urllib.error.URLError as e:  # includes a connection that times out
        sys.exit(f"cannot reach {url}: {e.reason}")
    except TimeoutError:  # connected, but no answer in time
        sys.exit(f"{method} {path}: no answer from {url} in {TIMEOUT}s")
    try:
        return json.loads(raw or b"null")
    except ValueError:
        sys.exit(f"{method} {path}: {url} didn't answer with JSON; is BOARDS_URL the Boards server?")


def context():
    user = call("GET", "/api/auth/status").get("user")
    if not user:
        sys.exit(f"{os.environ['BOARDS_URL']} has sign-in off, so it doesn't report who the token acts as "
                 "and tasks can't be assigned to Claude. Point BOARDS_URL at the team's live Boards server "
                 "(sign-in on), or ask a person to turn sign-in on.")
    me = user["memberId"]
    db = call("GET", "/api/bootstrap")["db"]
    po = next((m["id"] for m in db["members"] if m.get("username") == PO_USERNAME), None)
    today = date.today().isoformat()
    sprint = next((s for s in db["sprints"]  # undated sprints (both dates null) are never current
                   if s.get("startDate") and s.get("finishDate") and s["startDate"] <= today <= s["finishDate"]), None)
    return db, me, po, sprint


def create(spec_path):
    try:
        with open(spec_path) as f:
            spec = json.load(f)
    except (OSError, ValueError) as e:  # missing file, or not JSON
        sys.exit(f"cannot read {spec_path}: {e}")
    if not isinstance(spec, dict):
        sys.exit(f"{spec_path} must hold a JSON object (see SKILL.md)")
    _, me, po, sprint = context()
    kind = spec.get("type", "Product Backlog Item")
    if kind not in ("Product Backlog Item", "Bug"):
        sys.exit('type must be "Product Backlog Item" or "Bug"')
    if not spec.get("tasks"):
        sys.exit("Add the tasks: every PBI or Bug needs at least one task before work starts.")
    tasks = [{"title": t} if isinstance(t, str) else t for t in spec["tasks"]] if isinstance(spec["tasks"], list) else None
    if not tasks or not all(isinstance(t, dict) and t.get("title") for t in tasks):
        sys.exit('tasks must be a list of titles or {"title": ...} objects (see SKILL.md)')
    it = sprint["id"] if sprint else None
    fields = {k: v for k, v in spec.items() if k not in ("tasks", "type")}
    item = call("POST", "/api/workitems", {"type": kind, "assignedTo": po, "iterationId": it, "priority": 2, "position": "bottom", **fields})["result"]
    print(f"{kind} {item['id']}: {item['title']}  ({sprint['name'] if sprint else 'backlog'})")
    for n, t in enumerate(tasks):
        try:
            task = call("POST", "/api/workitems", {"type": "Task", "parentId": item["id"], "assignedTo": me, "iterationId": it,
                                                   "priority": fields.get("priority", 2), "activity": "Development", **t})["result"]
        except SystemExit as e:  # call() stops at the first failed request: say what the backlog now holds
            left = ", ".join(repr(x["title"]) for x in tasks[n:])
            sys.exit(f"{e.code} -- {kind} AB#{item['id']} was created, but these tasks may not have been: {left}. "
                     f"Check with `boards.py show {item['id']}` and add the missing ones in Boards by hand "
                     f"(or delete AB#{item['id']}) before running create again.")
        print(f"  Task {task['id']}: {task['title']}  [{task.get('activity')}]")


def show(i):
    db = call("GET", "/api/bootstrap")["db"]
    if not any(w["id"] == i for w in db["workItems"]):
        sys.exit(f"no work item {i}")
    for w in db["workItems"]:
        if w["id"] == i or w.get("parentId") == i:
            print(f"{'  ' if w['id'] != i else ''}{w['type']} {w['id']} [{w['state']}] {w['title']}")


def text(h):
    """Work item HTML as plain text: list items on their own lines, tags dropped."""
    h = re.sub(r"<li[^>]*>\s*(<p[^>]*>\s*)?", "\n- ", h or "")
    h = re.sub(r"</?(p|div|ul|ol|h\d|br)\b[^>]*>", "\n", h)
    return re.sub(r"\n\s*\n+", "\n", html.unescape(re.sub(r"<[^>]+>", "", h))).strip()


def brief(i):
    db = call("GET", "/api/bootstrap")["db"]
    w = next((w for w in db["workItems"] if w["id"] == i), None)
    if not w:
        sys.exit(f"no work item {i}")
    print(f"{w['type']} AB#{w['id']} [{w['state']}] {w['title']}")
    for key, label in (("description", "Description"), ("reproSteps", "Repro steps"), ("acceptanceCriteria", "Acceptance criteria")):
        if w.get(key):
            print(f"\n{label}:\n{text(w[key])}")
    tasks = [t for t in db["workItems"] if t.get("parentId") == i]
    if tasks:
        print("\nTasks:")
        for t in tasks:
            print(f"- AB#{t['id']} [{t['state']}] {t['title']}")


USAGE = {  # command: (arguments it needs, usage)
    "create": (1, "create SPEC.json"), "state": (2, "state STATE ID [ID...]"), "comment": (2, 'comment ID "<p>HTML</p>"'),
    "link": (2, "link ID URL [COMMENT]"), "show": (1, "show ID"), "brief": (1, "brief ID"),
}


def main(a):
    if not a or a[0] in ("-h", "--help"):
        print(__doc__); return
    cmd = a[0]
    needs, usage = USAGE.get(cmd, (0, ""))
    if len(a) - 1 < needs:
        sys.exit(f"usage: boards.py {usage}")

    def num(i):  # a work item id
        if not i.isdigit():
            sys.exit(f"usage: boards.py {usage}  (ID is a number, e.g. 110; got {i!r})")
        return int(i)

    if cmd == "whoami":
        db, me, po, sprint = context()
        name = {m["id"]: m["name"] for m in db["members"]}
        print(f"token acts as: {name.get(me)}; product owner: {name.get(po)}; current sprint: {sprint['name'] if sprint else 'none (backlog)'}")
    elif cmd == "create":
        create(a[1])
    elif cmd == "state":
        state, ids = a[1], [num(i) for i in a[2:]]
        for i in ids:
            r = call("PATCH", f"/api/workitems/{i}", {"state": state})["result"]
            print(f"{r['id']} -> {r['state']}")
    elif cmd == "comment":
        call("POST", f"/api/workitems/{num(a[1])}/comments", {"text": a[2]}); print("commented")
    elif cmd == "link":
        call("POST", f"/api/workitems/{num(a[1])}/hyperlinks", {"url": a[2], **({"comment": a[3]} if len(a) > 3 else {})}); print("linked")
    elif cmd == "show":
        show(num(a[1]))
    elif cmd == "brief":
        brief(num(a[1]))
    else:
        sys.exit(f"unknown command {cmd}\n{__doc__}")


if __name__ == "__main__":
    main(sys.argv[1:])
