import json, subprocess, time

def run_cmd(cmd):
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return p.returncode, p.stdout, p.stderr

with open("/home/dell/posture-sec/scheduler-app/backups/applied_contributors_full.json") as f:
    data = json.load(f)["applied"]

accensa_list = [a for a in data if "accensa" in a["repo"]]
guage_list = [a for a in data if "guage" in a["repo"]]

print("Loaded applied contributors:")
print(f"  Accensa: {len(accensa_list)}")
print(f"  Guage:   {len(guage_list)}")

# PHASE 1: Accensa using wagmiiii
print("\n==========================================")
print("PHASE 1: Assigning Accensa issues using wagmiiii")
print("==========================================")
# Verify current active user is wagmiiii
code, stdout, _ = run_cmd("gh api user --jq .login")
print(f"Active GitHub user: {stdout.strip()}")
if stdout.strip() != "wagmiiii":
    print("Switching to wagmiiii...")
    run_cmd("gh auth switch --user wagmiiii")

accensa_results = []
for a in accensa_list:
    user = a["actual_author"] or a["booked_username"]
    repo = a["repo"]
    issues = a["reserved_issues"]
    print(f"\n[Accensa] Contributor: @{user}")
    
    # Ensure collaborator invite/status
    c_code, _, c_err = run_cmd(f"gh api -X PUT repos/{repo}/collaborators/{user} -f permission=triage")
    if c_code != 0:
        print(f"  Notice on collaborator PUT: {c_err.strip()[:80]}")
        
    for issue_num in issues:
        code, out, err = run_cmd(f'gh api -X POST repos/{repo}/issues/{issue_num}/assignees -f "assignees[]={user}"')
        if code == 0:
            print(f"  [OK] #{issue_num} assigned to @{user}")
            accensa_results.append({"repo": repo, "issue": issue_num, "user": user, "status": "assigned"})
        else:
            print(f"  [FAIL] #{issue_num} assignment failed: {err.strip()[:80]}")
            accensa_results.append({"repo": repo, "issue": issue_num, "user": user, "status": "failed", "error": err.strip()})
        time.sleep(0.3)

# Save Accensa results
with open("/home/dell/posture-sec/scheduler-app/backups/assignment_accensa_results.json", "w") as f:
    json.dump(accensa_results, f, indent=2)

print("\nAccensa assignments complete!")

# PHASE 2: Guage using bolabeatz
print("\n==========================================")
print("PHASE 2: Switching to bolabeatz & Assigning Guage issues")
print("==========================================")
switch_code, switch_out, switch_err = run_cmd("gh auth switch --user bolabeatz")
print(f"Switch output: {switch_out.strip()} {switch_err.strip()}")

code, stdout, _ = run_cmd("gh api user --jq .login")
print(f"Active GitHub user now: {stdout.strip()}")
if stdout.strip() != "bolabeatz":
    raise Exception(f"Failed to switch to bolabeatz: currently {stdout.strip()}")

guage_results = []
for g in guage_list:
    user = g["actual_author"] or g["booked_username"]
    repo = g["repo"]
    issues = g["reserved_issues"]
    print(f"\n[Guage] Contributor: @{user}")
    
    # Ensure collaborator invite/status
    c_code, _, c_err = run_cmd(f"gh api -X PUT repos/{repo}/collaborators/{user} -f permission=triage")
    if c_code != 0:
        print(f"  Notice on collaborator PUT: {c_err.strip()[:80]}")
        
    for issue_num in issues:
        code, out, err = run_cmd(f'gh api -X POST repos/{repo}/issues/{issue_num}/assignees -f "assignees[]={user}"')
        if code == 0:
            print(f"  [OK] #{issue_num} assigned to @{user}")
            guage_results.append({"repo": repo, "issue": issue_num, "user": user, "status": "assigned"})
        else:
            print(f"  [FAIL] #{issue_num} assignment failed: {err.strip()[:80]}")
            guage_results.append({"repo": repo, "issue": issue_num, "user": user, "status": "failed", "error": err.strip()})
        time.sleep(0.3)

# Save Guage results
with open("/home/dell/posture-sec/scheduler-app/backups/assignment_guage_results.json", "w") as f:
    json.dump(guage_results, f, indent=2)

print("\nGuage assignments complete!")
print("\nSummary:")
print(f"  Accensa total assigned: {len([r for r in accensa_results if r['status'] == 'assigned'])} / {len(accensa_results)}")
print(f"  Guage total assigned:   {len([r for r in guage_results if r['status'] == 'assigned'])} / {len(guage_results)}")
