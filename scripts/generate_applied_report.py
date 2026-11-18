import json, re

with open("/home/dell/posture-sec/scheduler-app/backups/live_reservations_84_full.json") as f:
    reservations = json.load(f)["reservations"]

with open("/home/dell/posture-sec/scheduler-app/backups/comments_guage.json") as f:
    guage_comments = json.load(f)

with open("/home/dell/posture-sec/scheduler-app/backups/comments_accensa.json") as f:
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
    other_comments = []
    
    for num in issues:
        cs = comments_map.get((repo, num), [])
        for c in cs:
            author = (c.get("user") or {}).get("login", "")
            body = c.get("body", "")
            url = c.get("html_url", "")
            created_at = c.get("created_at", "")
            
            author_norm = clean(author)
            is_match = (u_norm == author_norm) or (f"@{u.lower()}" in body.lower()) or (f"@{u_norm}" in clean(body))
            
            item = {
                "issue_number": num,
                "author": author,
                "created_at": created_at,
                "body_snippet": body.replace("\n", " ")[:140],
                "url": url
            }
            if is_match:
                user_comments.append(item)
            else:
                other_comments.append(item)
                
    rec = {
        "reservation_id": r["reservation_id"],
        "booked_username": u,
        "repo": repo,
        "group_id": r["group_id"],
        "group_name": r["group_name"],
        "reserved_issues": issues,
        "commented_issues": sorted(list(set(c["issue_number"] for c in user_comments))),
        "actual_author": user_comments[0]["author"] if user_comments else None,
        "comments": user_comments,
        "other_comments": other_comments
    }
    
    if len(user_comments) > 0:
        applied.append(rec)
    else:
        not_applied.append(rec)

applied.sort(key=lambda x: x["reservation_id"])
not_applied.sort(key=lambda x: x["reservation_id"])

# CSV Output
rows = [["Reservation ID", "Booked Username", "GitHub Author", "Repository", "Group Name", "Reserved Issues", "Commented Issues", "Coverage", "Comment Link"]]
for a in applied:
    done_count = len(a["commented_issues"])
    total_count = len(a["reserved_issues"])
    coverage = "FULL" if done_count == total_count else f"{done_count}/{total_count}"
    comment_link = a["comments"][0]["url"] if a["comments"] else ""
    reserved_str = "; ".join(str(x) for x in a["reserved_issues"])
    commented_str = "; ".join(str(x) for x in a["commented_issues"])
    rows.append([
        str(a["reservation_id"]),
        a["booked_username"],
        a["actual_author"] or "",
        a["repo"],
        f'"{a["group_name"]}"',
        f'"{reserved_str}"',
        f'"{commented_str}"',
        coverage,
        comment_link
    ])

with open("/home/dell/posture-sec/scheduler-app/backups/applied_contributors_full.csv", "w") as f:
    f.write("\n".join([",".join(r) for r in rows]))

with open("/home/dell/posture-sec/scheduler-app/backups/applied_contributors_full.json", "w") as f:
    json.dump({
        "total_reservations": len(reservations),
        "applied_count": len(applied),
        "not_applied_count": len(not_applied),
        "applied": applied,
        "not_applied": not_applied
    }, f, indent=2)

print(f"Generated CSV and JSON: Applied={len(applied)}, Not Applied={len(not_applied)}")
