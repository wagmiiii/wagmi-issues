import json, subprocess, time

def run_cmd(cmd):
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return p.returncode, p.stdout, p.stderr

wagmi_token = subprocess.check_output("gh auth token --user wagmiiii", shell=True, text=True).strip()
bola_token = subprocess.check_output("gh auth token --user bolabeatz", shell=True, text=True).strip()

with open("/home/dell/posture-sec/scheduler-app/backups/new_unassigned_applied.json") as f:
    new_unassigned = json.load(f)

accensa_new = [x for x in new_unassigned if "accensa" in x["repo"]]
guage_new = [x for x in new_unassigned if "guage" in x["repo"]]

print(f"Assigning {len(accensa_new)} Accensa contributors using wagmiiii...")
print(f"Assigning {len(guage_new)} Guage contributors using bolabeatz...")

accensa_results = []
# PHASE 1: Accensa using wagmiiii
for a in accensa_new:
    user = a["actual_author"] or a["booked_username"]
    repo = a["repo"]
    issues = a["reserved_issues"]
    print(f"\n[Accensa] Assigning @{user} to issues {issues}...")
    
    # 1. Ensure registered as collaborator
    run_cmd(f'gh api -X PUT repos/{repo}/collaborators/{user} -f permission=triage -H "Authorization: token {wagmi_token}"')
    
    # 2. Assign issues
    for num in issues:
        code, out, err = run_cmd(f'gh api -X POST repos/{repo}/issues/{num}/assignees -f "assignees[]={user}" -H "Authorization: token {wagmi_token}"')
        if code == 0:
            print(f"  [OK] #{num} assigned to @{user}")
            accensa_results.append({"repo": repo, "issue": num, "user": user, "status": "assigned"})
        else:
            print(f"  [FAIL] #{num} assignment error: {err.strip()[:80]}")
            accensa_results.append({"repo": repo, "issue": num, "user": user, "status": "failed", "error": err.strip()})
        time.sleep(0.3)

# Withdraw any invites from Accensa
inv_code, inv_out, _ = run_cmd(f'gh api repos/accensa/x402-facilitator-stellar/invitations -H "Authorization: token {wagmi_token}"')
try:
    for inv in json.loads(inv_out):
        run_cmd(f'gh api -X DELETE repos/accensa/x402-facilitator-stellar/invitations/{inv["id"]} -H "Authorization: token {wagmi_token}"')
        print(f"  [WITHDRAWN INVITE] Accensa Inv #{inv['id']} for @{inv.get('invitee', {}).get('login')}")
except:
    pass

# PHASE 2: Guage using bolabeatz
guage_results = []
for g in guage_new:
    user = g["actual_author"] or g["booked_username"]
    repo = g["repo"]
    issues = g["reserved_issues"]
    print(f"\n[Guage] Assigning @{user} to issues {issues}...")
    
    # 1. Ensure registered as collaborator
    run_cmd(f'gh api -X PUT repos/{repo}/collaborators/{user} -f permission=triage -H "Authorization: token {bola_token}"')
    
    # 2. Assign issues
    for num in issues:
        code, out, err = run_cmd(f'gh api -X POST repos/{repo}/issues/{num}/assignees -f "assignees[]={user}" -H "Authorization: token {bola_token}"')
        if code == 0:
            print(f"  [OK] #{num} assigned to @{user}")
            guage_results.append({"repo": repo, "issue": num, "user": user, "status": "assigned"})
        else:
            print(f"  [FAIL] #{num} assignment error: {err.strip()[:80]}")
            guage_results.append({"repo": repo, "issue": num, "user": user, "status": "failed", "error": err.strip()})
        time.sleep(0.3)

# Withdraw any invites from Guage
inv_code, inv_out, _ = run_cmd(f'gh api repos/posture-sec/guage/invitations -H "Authorization: token {bola_token}"')
try:
    for inv in json.loads(inv_out):
        run_cmd(f'gh api -X DELETE repos/posture-sec/guage/invitations/{inv["id"]} -H "Authorization: token {bola_token}"')
        print(f"  [WITHDRAWN INVITE] Guage Inv #{inv['id']} for @{inv.get('invitee', {}).get('login')}")
except:
    pass

print("\nVerifying 0 pending invitations...")
for r, tok in [("accensa/x402-facilitator-stellar", wagmi_token), ("posture-sec/guage", bola_token)]:
    _, out, _ = run_cmd(f'gh api repos/{r}/invitations -H "Authorization: token {tok}" --jq "length"')
    print(f"  {r}: {out.strip()} pending invitations remaining.")

with open("/home/dell/posture-sec/scheduler-app/backups/assignment_13_new_results.json", "w") as f:
    json.dump({
        "accensa": accensa_results,
        "guage": guage_results
    }, f, indent=2)

print("\nAssignments and invite withdrawals complete!")
