import json, re

with open("/home/dell/posture-sec/scheduler-app/backups/live_reservations_84_full.json") as f:
    reservations = json.load(f)["reservations"]

with open("/home/dell/posture-sec/scheduler-app/backups/comments_guage_latest.json") as f:
    guage_comments = json.load(f)

with open("/home/dell/posture-sec/scheduler-app/backups/comments_accensa_latest.json") as f:
    accensa_comments = json.load(f)

comments_map = {}
for c in guage_comments:
    try:
        issue_num = int(c["issue_url"].split("/")[-1])
        comments_map.setdefault(("posture-sec/guage", issue_num), []).append(c)
    except:
        pass

for c in accensa_comments:
    try:
        issue_num = int(c["issue_url"].split("/")[-1])
        comments_map.setdefault(("accensa/x402-facilitator-stellar", issue_num), []).append(c)
    except:
        pass

def clean(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())

applied = []
not_applied = []

for r in reservations:
    u = r["username"].strip()
    u_norm = clean(u)
    repo = r["repo"].strip()
    issues = [i["number"] for i in r["issues"]]
    
    user_comments = []
    
    for num in issues:
        cs = comments_map.get((repo, num), [])
        for c in cs:
            author = (c.get("user") or {}).get("login", "")
            body = c.get("body", "")
            url = c.get("html_url", "")
            created_at = c.get("created_at", "")
            
            author_norm = clean(author)
            is_match = (u_norm == author_norm) or (f"@{u.lower()}" in body.lower()) or (f"@{u_norm}" in clean(body))
            
            if is_match:
                user_comments.append({
                    "issue_number": num,
                    "author": author,
                    "created_at": created_at,
                    "body_snippet": body.replace("\n", " ")[:140],
                    "url": url
                })
                
    rec = {
        "reservation_id": r["reservation_id"],
        "booked_username": u,
        "repo": repo,
        "group_id": r["group_id"],
        "group_name": r["group_name"],
        "reserved_issues": issues,
        "commented_issues": sorted(list(set(c["issue_number"] for c in user_comments))),
        "actual_author": user_comments[0]["author"] if user_comments else None,
        "comments": user_comments
    }
    
    if len(user_comments) > 0:
        applied.append(rec)
    else:
        not_applied.append(rec)

applied.sort(key=lambda x: x["reservation_id"])
not_applied.sort(key=lambda x: x["reservation_id"])

print(f"Total reservations: {len(reservations)}")
print(f"Applied: {len(applied)}")
print(f"Not applied: {len(not_applied)}")

with open("/home/dell/posture-sec/scheduler-app/backups/latest_applied_report.json", "w") as f:
    json.dump({
        "total": len(reservations),
        "applied_count": len(applied),
        "not_applied_count": len(not_applied),
        "applied": applied,
        "not_applied": not_applied
    }, f, indent=2)

print("\nLIST OF APPLIED CONTRIBUTORS:")
for idx, a in enumerate(applied, 1):
    u = a["booked_username"]
    auth = a["actual_author"]
    user_str = f"@{u}" if not auth or auth.lower() == u.lower() else f"@{u} (as @{auth})"
    repo_short = "guage" if "guage" in a["repo"] else "x402-facilitator"
    issues_str = ", ".join(f"#{x}" for x in a["commented_issues"])
    print(f"{idx}. {user_str} — `{repo_short}`: {issues_str}")
