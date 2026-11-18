import json

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

applied = []
not_applied = []

for r in reservations:
    username = r["username"].strip()
    repo = r["repo"].strip()
    issues = [i["number"] for i in r["issues"]]
    
    user_comments = []
    other_comments = []
    
    for num in issues:
        cs = comments_map.get((repo, num), [])
        for c in cs:
            author = (c.get("user") or {}).get("login", "")
            body = c.get("body", "")
            created_at = c.get("created_at", "")
            url = c.get("html_url", "")
            
            is_user = (author.lower() == username.lower()) or (f"@{username.lower()}" in body.lower())
            
            info = {
                "issue_number": num,
                "author": author,
                "created_at": created_at,
                "body_snippet": body.replace("\n", " ")[:120],
                "url": url,
                "is_direct_author": author.lower() == username.lower()
            }
            
            if is_user:
                user_comments.append(info)
            else:
                other_comments.append(info)
                
    record = {
        "reservation_id": r["reservation_id"],
        "username": username,
        "repo": repo,
        "group_id": r["group_id"],
        "group_name": r["group_name"],
        "issues": issues,
        "applied": len(user_comments) > 0,
        "commented_issues": sorted(list(set(c["issue_number"] for c in user_comments))),
        "user_comments": user_comments,
        "other_comments_count": len(other_comments)
    }
    
    if len(user_comments) > 0:
        applied.append(record)
    else:
        not_applied.append(record)

applied.sort(key=lambda x: x["reservation_id"])
not_applied.sort(key=lambda x: x["reservation_id"])

print("Total reservations:", len(reservations))
print("Applied (dropped comment):", len(applied))
print("Not applied yet:", len(not_applied))

output_path = "/home/dell/posture-sec/scheduler-app/backups/applied_report.json"
with open(output_path, "w") as f:
    json.dump({
        "total": len(reservations),
        "applied_count": len(applied),
        "not_applied_count": len(not_applied),
        "applied": applied,
        "not_applied": not_applied
    }, f, indent=2)

print(f"Report saved to {output_path}")
