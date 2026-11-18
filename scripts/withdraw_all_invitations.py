import json, subprocess, time

def run_cmd(cmd):
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return p.returncode, p.stdout, p.stderr

wagmi_token = subprocess.check_output("gh auth token --user wagmiiii", shell=True, text=True).strip()
bola_token = subprocess.check_output("gh auth token --user bolabeatz", shell=True, text=True).strip()

repos_config = [
    {"repo": "accensa/x402-facilitator-stellar", "token": wagmi_token},
    {"repo": "posture-sec/guage", "token": bola_token},
    {"repo": "Tollcraft/soroban-cost-linter", "token": wagmi_token}
]

withdrawn = []

for item in repos_config:
    repo = item["repo"]
    token = item["token"]
    print(f"\nChecking pending invitations for {repo}...")
    
    cmd = f'gh api repos/{repo}/invitations -H "Authorization: token {token}"'
    code, stdout, stderr = run_cmd(cmd)
    if code != 0:
        print(f"  Error fetching invitations for {repo}: {stderr.strip()}")
        continue
        
    try:
        invites = json.loads(stdout)
    except:
        invites = []
        
    print(f"  Found {len(invites)} pending invitation(s) in {repo}.")
    
    for inv in invites:
        inv_id = inv["id"]
        invitee = inv.get("invitee", {}).get("login", "unknown")
        del_cmd = f'gh api -X DELETE repos/{repo}/invitations/{inv_id} -H "Authorization: token {token}"'
        d_code, _, d_err = run_cmd(del_cmd)
        if d_code == 0:
            print(f"    [WITHDRAWN] Inv #{inv_id} for @{invitee}")
            withdrawn.append({"repo": repo, "id": inv_id, "user": invitee, "status": "withdrawn"})
        else:
            print(f"    [FAIL] Failed to withdraw Inv #{inv_id} for @{invitee}: {d_err.strip()}")
            withdrawn.append({"repo": repo, "id": inv_id, "user": invitee, "status": "failed", "error": d_err.strip()})
        time.sleep(0.2)

print("\nVerifying 0 pending invitations remain...")
for item in repos_config:
    repo = item["repo"]
    token = item["token"]
    cmd = f'gh api repos/{repo}/invitations -H "Authorization: token {token}" --jq "length"'
    _, out, _ = run_cmd(cmd)
    print(f"  {repo}: {out.strip()} pending invitations remaining.")

with open("/home/dell/posture-sec/scheduler-app/backups/withdrawn_invitations.json", "w") as f:
    json.dump(withdrawn, f, indent=2)

print("\nAll withdrawals complete!")
