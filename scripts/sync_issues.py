#!/usr/bin/env python3
"""
sync_issues.py

Interactive & CLI tool for maintainers to fetch labeled GitHub issues across
specified repositories, group them into batches (default: threes), and generate:
  1. A structured JSON seed file (groups.json) for the scheduler server.
  2. A clean Markdown reference file (ISSUES_GROUPED.md).
"""

import argparse
import json
import os
import re
import subprocess
import sys

def parse_repo_identifier(repo_str: str) -> str:
    """Extract owner/repo from URL or string."""
    repo_str = repo_str.strip().rstrip('/')
    # Match https://github.com/owner/repo or git@github.com:owner/repo
    m = re.search(r'github\.com[:/]([^/]+/[^/]+?)(?:\.git)?$', repo_str)
    if m:
        return m.group(1)
    if '/' in repo_str and len(repo_str.split('/')) == 2:
        return repo_str
    raise ValueError(f"Could not parse valid owner/repo from '{repo_str}'. Format should be 'owner/repo' or 'https://github.com/owner/repo'.")

def check_gh_cli():
    """Ensure gh CLI is available and authenticated."""
    try:
        res = subprocess.run(['gh', 'auth', 'status'], capture_output=True, text=True)
        if res.returncode != 0 and 'Logged in to' not in res.stderr and 'Logged in to' not in res.stdout:
            print("Error: GitHub CLI (gh) is not logged in. Please run 'gh auth login' first.", file=sys.stderr)
            sys.exit(1)
    except FileNotFoundError:
        print("Error: 'gh' CLI was not found. Please install the GitHub CLI: https://cli.github.com/", file=sys.stderr)
        sys.exit(1)

def fetch_labeled_issues(repo: str, label: str):
    """Fetch open issues with the specified label from GitHub."""
    print(f"-> Fetching open issues from '{repo}' with label '{label}'...")
    cmd = [
        'gh', 'issue', 'list',
        '--repo', repo,
        '--state', 'open',
        '--label', label,
        '--limit', '1000',
        '--json', 'number,title,labels,url'
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        print(f"Error fetching issues from {repo}: {res.stderr.strip()}", file=sys.stderr)
        return []
    
    issues = json.loads(res.stdout)
    # Sort ascending by issue number
    return sorted(issues, key=lambda x: x['number'])

def chunk_list(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i:i + n]

def main():
    parser = argparse.ArgumentParser(
        description="Sync labeled GitHub issues and generate groups for the scheduler."
    )
    parser.add_argument(
        '--repos',
        nargs='*',
        help="One or more GitHub repository URLs or 'owner/repo' strings (required)."
    )
    parser.add_argument(
        '--label',
        type=str,
        help="GitHub issue label to filter by (e.g. 'Stellar Wave')."
    )
    parser.add_argument(
        '--size',
        type=int,
        default=3,
        help="Number of issues per group (default: 3)."
    )
    parser.add_argument(
        '--out-json',
        type=str,
        default='groups.json',
        help="Output path for groups JSON (default: groups.json in script or current dir)."
    )
    parser.add_argument(
        '--out-md',
        type=str,
        default='ISSUES_GROUPED.md',
        help="Output path for Markdown summary (default: ISSUES_GROUPED.md)."
    )

    args = parser.parse_args()

    check_gh_cli()

    # 1. Require repository input
    repos_input = args.repos
    if not repos_input:
        print("\n=== Repository Input Required ===")
        print("Provide the target GitHub repositories (separated by commas or spaces).")
        print("Examples: https://github.com/org/repo1, org/repo2")
        raw = input("Enter repository URLs or names: ").strip()
        if not raw:
            print("Error: No repositories provided. Aborting.", file=sys.stderr)
            sys.exit(1)
        repos_input = [r.strip() for r in re.split(r'[,\s]+', raw) if r.strip()]

    parsed_repos = []
    for r in repos_input:
        try:
            parsed_repos.append(parse_repo_identifier(r))
        except ValueError as e:
            print(f"Error: {e}", file=sys.stderr)
            sys.exit(1)

    # 2. Require label input
    label = args.label
    if not label:
        raw_label = input("\nEnter issue label to filter by (e.g. 'Stellar Wave'): ").strip()
        if not raw_label:
            print("Error: Issue label is required. Aborting.", file=sys.stderr)
            sys.exit(1)
        label = raw_label

    group_size = args.size
    print(f"\nConfiguration:")
    print(f"- Repositories : {parsed_repos}")
    print(f"- Label        : '{label}'")
    print(f"- Group Size   : {group_size}\n")

    # 3. Fetch and build groups
    all_groups = []
    repo_stats = {}

    for repo in parsed_repos:
        repo_short = repo.split('/')[-1]
        issues = fetch_labeled_issues(repo, label)
        repo_stats[repo] = len(issues)
        
        chunks = list(chunk_list(issues, group_size))
        for idx, grp in enumerate(chunks, 1):
            group_name = f"{repo_short} - Group {idx}"
            slug = re.sub(r'[^a-z0-9]+', '-', group_name.lower()).strip('-')
            
            all_groups.append({
                'id': slug,
                'group_name': group_name,
                'repo': repo,
                'repo_short': repo_short,
                'issues': [{'number': i['number'], 'url': i['url']} for i in grp],
                'count': len(grp)
            })

    total_issues = sum(repo_stats.values())
    print(f"\nFetched {total_issues} labeled issues across {len(parsed_repos)} repos.")
    print(f"Created {len(all_groups)} groups of up to {group_size} issues.")

    # 4. Save JSON seed file
    base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    json_path = os.path.join(base_dir, args.out_json) if not os.path.isabs(args.out_json) else args.out_json
    with open(json_path, 'w') as f:
        json.dump(all_groups, f, indent=2)
    print(f"✓ Saved JSON seed: {json_path}")

    # 5. Save Markdown summary file
    md_path = os.path.join(base_dir, args.out_md) if not os.path.isabs(args.out_md) else args.out_md
    md_lines = [
        f"# Issue Groups Reference\n",
        f"Generated from open issues with label `{label}`.\n",
        f"### Summary",
        f"- **Total Labeled Issues:** {total_issues}",
        f"- **Total Groups:** {len(all_groups)} (group size: {group_size})"
    ]
    for r, c in repo_stats.items():
        md_lines.append(f"- **{r}:** {c} issues")
    
    md_lines.extend([
        "\n## Groups Table\n",
        "| Group Name | Issue Numbers | Count |",
        "| :--- | :--- | :--- |"
    ])

    for g in all_groups:
        nums_str = ', '.join([f"#{i['number']}" for i in g['issues']])
        md_lines.append(f"| {g['group_name']} | {nums_str} | {g['count']} |")

    with open(md_path, 'w') as f:
        f.write('\n'.join(md_lines) + '\n')
    print(f"✓ Saved Markdown table: {md_path}")
    print("\nDone! To seed these groups into the database, restart the server or run 'npm run reset-db'.")

if __name__ == '__main__':
    main()
