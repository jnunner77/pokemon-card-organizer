#!/usr/bin/env python3
"""Boards work items from the command line (the Boards API, docs/api.md in agile-development-operations).

Needs BOARDS_URL and BOARDS_TOKEN in the environment. The token is sent as a header and never printed.

  boards.py whoami                      who the token acts as, and the current sprint
  boards.py create SPEC.json            a PBI or Bug with its tasks (see SKILL.md); prints the ids
  boards.py state STATE ID [ID...]      e.g. state "In Progress" 112, state Done 100 101
  boards.py comment ID "<p>HTML</p>"
  boards.py link ID URL [COMMENT]       add a hyperlink (e.g. the pull request)
  boards.py show ID                     an item and its child tasks
"""
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import date

PO_USERNAME = "jnunner77"  # PBIs, Bugs, Features and Epics are assigned to Justin Nunner


def call(method, path, body=None):
    url, tok = os.environ.get("BOARDS_URL", "").rstrip("/"), os.environ.get("BOARDS_TOKEN", "")
    if not url or not tok:
        sys.exit("BOARDS_URL and BOARDS_TOKEN must be set (ask the user to add them to the environment).")
    req = urllib.request.Request(url + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path}: HTTP {e.code} {e.read().decode(errors='replace')[:300]}")


def context():
    db = call("GET", "/api/bootstrap")["db"]
    me = call("GET", "/api/auth/status")["user"]["memberId"]
    po = next((m["id"] for m in db["members"] if m.get("username") == PO_USERNAME), None)
    today = date.today().isoformat()
    sprint = next((s for s in db["sprints"] if s["startDate"] <= today <= s["finishDate"]), None)
    return db, me, po, sprint


def create(spec_path):
    spec = json.load(open(spec_path))
    _, me, po, sprint = context()
    kind = spec.get("type", "Product Backlog Item")
    if kind not in ("Product Backlog Item", "Bug"):
        sys.exit('type must be "Product Backlog Item" or "Bug"')
    if not spec.get("tasks"):
        sys.exit("Add the tasks: every PBI or Bug needs at least one task before work starts.")
    it = sprint["id"] if sprint else None
    fields = {k: v for k, v in spec.items() if k not in ("tasks", "type")}
    item = call("POST", "/api/workitems", {"type": kind, "assignedTo": po, "iterationId": it, "priority": 2, "position": "bottom", **fields})["result"]
    print(f"{kind} {item['id']}: {item['title']}  ({sprint['name'] if sprint else 'backlog'})")
    for t in spec["tasks"]:
        t = {"title": t} if isinstance(t, str) else t
        task = call("POST", "/api/workitems", {"type": "Task", "parentId": item["id"], "assignedTo": me, "iterationId": it,
                                               "priority": fields.get("priority", 2), "activity": "Development", **t})["result"]
        print(f"  Task {task['id']}: {task['title']}  [{task.get('activity')}]")


def show(i):
    db = call("GET", "/api/bootstrap")["db"]
    for w in db["workItems"]:
        if w["id"] == i or w.get("parentId") == i:
            print(f"{'  ' if w['id'] != i else ''}{w['type']} {w['id']} [{w['state']}] {w['title']}")


def main(a):
    if not a or a[0] in ("-h", "--help"):
        print(__doc__); return
    cmd = a[0]
    if cmd == "whoami":
        db, me, po, sprint = context()
        name = {m["id"]: m["name"] for m in db["members"]}
        print(f"token acts as: {name.get(me)}; product owner: {name.get(po)}; current sprint: {sprint['name'] if sprint else 'none (backlog)'}")
    elif cmd == "create":
        create(a[1])
    elif cmd == "state":
        state, ids = a[1], a[2:]
        for i in ids:
            r = call("PATCH", f"/api/workitems/{int(i)}", {"state": state})["result"]
            print(f"{r['id']} -> {r['state']}")
    elif cmd == "comment":
        call("POST", f"/api/workitems/{int(a[1])}/comments", {"text": a[2]}); print("commented")
    elif cmd == "link":
        call("POST", f"/api/workitems/{int(a[1])}/hyperlinks", {"url": a[2], **({"comment": a[3]} if len(a) > 3 else {})}); print("linked")
    elif cmd == "show":
        show(int(a[1]))
    else:
        sys.exit(f"unknown command {cmd}\n{__doc__}")


if __name__ == "__main__":
    main(sys.argv[1:])
