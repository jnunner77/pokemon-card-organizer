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
import http.client
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import date

PO_USERNAME = "jnunner77"  # PBIs, Bugs, Features and Epics are assigned to Justin Nunner
TIMEOUT = 30  # seconds to wait for the Boards server before giving up


def redact(text):  # text from the server, the environment or the arguments, as it may be printed: never the token
    tok = os.environ.get("BOARDS_TOKEN", "")
    return text.replace(tok, "<token>") if tok else text


def one_line(text, limit=300):  # one line (cut to limit, unless None), never the token
    return redact(" ".join(str(text).split()))[:limit]


def need(v, fields, where):
    """v as a JSON object with the fields the script reads ({name: type}); otherwise stop with one line."""
    bad = [k for k, kind in fields.items() if not isinstance(v, dict) or k not in v or not isinstance(v[k], kind)]
    if bad:
        sys.exit(f"{where}: the reply lacks {', '.join(bad)} as Boards sends it; is BOARDS_URL the Boards server?")
    return v


def result(reply, fields, where):  # the work item a change answers with
    return need(need(reply, {"result": dict}, where)["result"], fields, where)


def bootstrap():  # the project, with every field the script reads checked once
    where = "GET /api/bootstrap"
    db = need(need(call("GET", "/api/bootstrap"), {"db": dict}, where)["db"],
              {"members": list, "sprints": list, "workItems": list}, where)
    for key, fields in (("members", {"id": str}), ("sprints", {"id": str}),
                        ("workItems", {"id": int, "type": str, "state": str, "title": str})):
        for x in db[key]:
            need(x, fields, f"{where} ({key})")
    return db


def call(method, path, body=None):
    url, tok = os.environ.get("BOARDS_URL", "").rstrip("/"), os.environ.get("BOARDS_TOKEN", "")
    if not url or not tok:
        sys.exit("BOARDS_URL and BOARDS_TOKEN must be set (ask the user to add them to the environment).")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", tok):  # Boards issues boards_ + base64url; never print it
        sys.exit("BOARDS_TOKEN has characters a Boards token doesn't (a space or line break copied with it?); "
                 "ask the user to set it again.")
    shown = one_line(url)  # BOARDS_URL as messages print it: the token redacted if it was pasted there
    if not url.startswith(("http://", "https://")):
        sys.exit(f"BOARDS_URL must start with http:// or https:// (got {shown!r})")
    payload = None if body is None else json.dumps(body).encode()
    try:  # Request() parses BOARDS_URL, so a malformed one (http://[::1) gets the one line below too
        req = urllib.request.Request(url + path, method=method, data=payload,
                                     headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode(errors="replace")
        except Exception as cut:  # the error reply's own body cut short or timed out
            detail = f"(reply cut short: {type(cut).__name__})"
        sys.exit(f"{method} {path}: HTTP {e.code} {one_line(detail)}")
    except urllib.error.URLError as e:  # includes a connection that times out
        sys.exit(f"cannot reach {shown}: {one_line(e.reason)}")
    except TimeoutError:  # connected, but no answer in time
        sys.exit(f"{method} {path}: no answer from {shown} in {TIMEOUT}s")
    except (ConnectionError, http.client.HTTPException) as e:  # dropped mid-reply, or not an HTTP server
        sys.exit(f"{method} {path}: {shown} broke off or didn't answer as HTTP ({type(e).__name__}: {one_line(e)})")
    except Exception as e:  # anything else from urllib, http.client or the socket (bad port, TLS): one line
        sys.exit(f"{method} {path}: {shown}: {type(e).__name__}: {one_line(e)}")
    not_json = f"{method} {path}: {shown} didn't answer with a JSON object; is BOARDS_URL the Boards server?"
    if not raw:  # every endpoint used here answers with a JSON object
        sys.exit(not_json)
    try:
        data = json.loads(raw)
    except (ValueError, RecursionError):  # not JSON, or nested too deep to parse
        sys.exit(not_json)
    if not isinstance(data, dict):
        sys.exit(not_json)
    return data


def context():
    where = "GET /api/auth/status"
    user = need(call("GET", "/api/auth/status"), {"user": (dict, type(None))}, where)["user"]
    if user is None:
        sys.exit(f"{one_line(os.environ['BOARDS_URL'])} has sign-in off, so it doesn't report who the token acts as "
                 "and tasks can't be assigned to Claude. Point BOARDS_URL at the team's live Boards server "
                 "(sign-in on), or ask a person to turn sign-in on.")
    me = need(user, {"memberId": str}, where)["memberId"]
    db = bootstrap()
    po = next((m["id"] for m in db["members"] if m.get("username") == PO_USERNAME), None)
    today = date.today().isoformat()
    sprint = next((s for s in db["sprints"]  # undated sprints (dates null) are never current
                   if isinstance(s.get("startDate"), str) and isinstance(s.get("finishDate"), str)
                   and s["startDate"] <= today <= s["finishDate"]), None)
    return db, me, po, sprint


def create(spec_path):
    try:
        with open(spec_path) as f:
            spec = json.load(f)
    except (OSError, ValueError, RecursionError) as e:  # missing file, not JSON, or nested too deep
        sys.exit(one_line(f"cannot read {spec_path}: {e}"))
    if not isinstance(spec, dict):
        sys.exit(one_line(f"{spec_path} must hold a JSON object (see SKILL.md)"))
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
    try:
        item = result(call("POST", "/api/workitems", {"type": kind, "assignedTo": po, "iterationId": it, "priority": 2, "position": "bottom", **fields}),
                      {"id": int, "title": str}, "POST /api/workitems")
    except SystemExit as e:  # the server may have made the item before the reply was lost
        sys.exit(f"{e.code} -- the {kind} may have been created anyway: check Boards for one titled "
                 f"{one_line(fields.get('title'))!r} before running create again.")
    print(one_line(f"{kind} {item['id']}: {item['title']}  ({(sprint.get('name') or sprint['id']) if sprint else 'backlog'})", None))
    for n, t in enumerate(tasks):
        try:
            task = result(call("POST", "/api/workitems", {"type": "Task", "parentId": item["id"], "assignedTo": me, "iterationId": it,
                                                          "priority": fields.get("priority", 2), "activity": "Development", **t}),
                          {"id": int, "title": str}, "POST /api/workitems")
        except SystemExit as e:  # call() stops at the first failed request: say what the backlog now holds
            left = one_line(", ".join(repr(x["title"]) for x in tasks[n:]), None)
            sys.exit(f"{e.code} -- {kind} AB#{item['id']} was created, but these tasks may not have been: {left}. "
                     f"Don't run create again for this spec: check with `boards.py show {item['id']}` and add "
                     f"the missing tasks in Boards by hand, or delete AB#{item['id']} first.")
        print("  " + one_line(f"Task {task['id']}: {task['title']}  [{task.get('activity')}]", None))


def show(i):
    db = bootstrap()
    if not any(w["id"] == i for w in db["workItems"]):
        sys.exit(f"no work item {i}")
    for w in db["workItems"]:
        if w["id"] == i or w.get("parentId") == i:
            print(("  " if w["id"] != i else "") + one_line(f"{w['type']} {w['id']} [{w['state']}] {w['title']}", None))


def text(h):
    """Work item HTML as plain text: list items on their own lines, tags dropped."""
    h = re.sub(r"<li[^>]*>\s*(<p[^>]*>\s*)?", "\n- ", h or "")
    h = re.sub(r"</?(p|div|ul|ol|h\d|br)\b[^>]*>", "\n", h)
    return re.sub(r"\n\s*\n+", "\n", html.unescape(re.sub(r"<[^>]+>", "", h))).strip()


def brief(i):
    db = bootstrap()
    w = next((w for w in db["workItems"] if w["id"] == i), None)
    if not w:
        sys.exit(f"no work item {i}")
    print(one_line(f"{w['type']} AB#{w['id']} [{w['state']}] {w['title']}", None))
    for key, label in (("description", "Description"), ("reproSteps", "Repro steps"), ("acceptanceCriteria", "Acceptance criteria")):
        if isinstance(w.get(key), str) and w[key]:
            print(f"\n{label}:\n{redact(text(w[key]))}")
    tasks = [t for t in db["workItems"] if t.get("parentId") == i]
    if tasks:
        print("\nTasks:")
        for t in tasks:
            print(one_line(f"- AB#{t['id']} [{t['state']}] {t['title']}", None))


USAGE = {  # command: (arguments it needs, usage)
    "create": (1, "create SPEC.json"), "state": (2, "state STATE ID [ID...]"), "comment": (2, 'comment ID "<p>HTML</p>"'),
    "link": (2, "link ID URL [COMMENT]"), "show": (1, "show ID"), "brief": (1, "brief ID"),
}


def main(a):
    sys.stdout.reconfigure(errors="backslashreplace")  # a title Boards stored with a lone surrogate, or a non-UTF-8 terminal
    if not a or a[0] in ("-h", "--help"):
        print(__doc__); return
    cmd = a[0]
    needs, usage = USAGE.get(cmd, (0, ""))
    if len(a) - 1 < needs:
        sys.exit(f"usage: boards.py {usage}")

    def num(i):  # a work item id
        if not (i.isascii() and i.isdigit() and len(i) <= 9):
            sys.exit(f"usage: boards.py {usage}  (ID is a number, e.g. 110; got {one_line(repr(i))})")
        return int(i)

    if cmd == "whoami":
        db, me, po, sprint = context()
        name = {m["id"]: m.get("name") for m in db["members"]}
        print(one_line(f"token acts as: {name.get(me)}; product owner: {name.get(po)}; current sprint: {(sprint.get('name') or sprint['id']) if sprint else 'none (backlog)'}", None))
    elif cmd == "create":
        create(a[1])
    elif cmd == "state":
        state, ids = a[1], [num(i) for i in a[2:]]
        for i in ids:
            r = result(call("PATCH", f"/api/workitems/{i}", {"state": state}), {"id": int, "state": str}, f"PATCH /api/workitems/{i}")
            print(one_line(f"{r['id']} -> {r['state']}", None))
    elif cmd == "comment":
        call("POST", f"/api/workitems/{num(a[1])}/comments", {"text": a[2]}); print("commented")
    elif cmd == "link":
        call("POST", f"/api/workitems/{num(a[1])}/hyperlinks", {"url": a[2], **({"comment": a[3]} if len(a) > 3 else {})}); print("linked")
    elif cmd == "show":
        show(num(a[1]))
    elif cmd == "brief":
        brief(num(a[1]))
    else:
        sys.exit(f"unknown command {one_line(repr(cmd))}; run boards.py --help for the commands")


if __name__ == "__main__":
    main(sys.argv[1:])
