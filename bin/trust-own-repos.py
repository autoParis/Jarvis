#!/usr/bin/env python3
"""Tell Claude Code's auto-mode check that the owner's GitHub repos are his own.

Run by the owner, once:  python3 ~/Repos/jarvis/bin/trust-own-repos.py
Keeps a backup next to the settings file. Run it again and it changes nothing.
Production writes, merging, force-pushing and credentials stay as they are.
"""
import json, os, shutil, time

path = os.path.expanduser('~/.claude/settings.json')
backup = f'{path}.bak-{time.strftime("%Y%m%d-%H%M%S")}'
shutil.copy2(path, backup)

with open(path) as f:
    settings = json.load(f)
env = settings['autoMode']['environment']

HOME = os.path.expanduser('~')
# Your own GitHub repositories, "owner/name" separated by commas. bin/setup writes JARVIS_TRUSTED_REPOS to .env.
REPOS = [r.strip() for r in (os.environ.get('JARVIS_TRUSTED_REPOS') or 'example-org/acmeapp_nextjs,example-org/FB-marketplace-uploader').split(',') if r.strip()]
NAMES = ' and '.join(REPOS)
JARVIS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

REPLACE = {
    '**Source control**': (
        f"**Source control**: GitHub. The user's own repositories are {NAMES}, "
        f"and the local clones under {HOME}/Repos "
        f"and {HOME}/orca/workspaces. In those repositories, these are routine and approved: "
        "commenting on issues and pull requests, filing issues, editing pull request titles, bodies and labels, "
        "opening draft pull requests, and pushing non-force commits to feature branches. "
        "Merging a pull request, force-pushing, deleting a branch and changing repository settings still need the user."
    ),
    '**Trusted repo**': (
        f"**Trusted repo**: {NAMES} on GitHub, "
        f"their clones under {HOME}/Repos and their Orca worktrees under {HOME}/orca/workspaces, "
        f"plus the local-only repository {JARVIS}."
    ),
}
ADD = (
    "Allowed deploy-state reads: read-only commands that list or describe deployments, functions, "
    "releases and workflow runs (gh run list/view, gh release view, gh api for deployments, "
    "gcloud functions list/describe, firebase functions:list) for the repositories above are approved. "
    "Deploying, changing configuration or IAM, and reading secret values still need the user."
)

changed = 0
for i, line in enumerate(env):
    for key, new in REPLACE.items():
        if line.startswith(key) and line != new:
            env[i] = new
            changed += 1
if ADD not in env:
    env.append(ADD)
    changed += 1

if changed:
    with open(path, 'w') as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)
        f.write('\n')
    print(f'Updated {changed} line(s). Backup: {backup}')
else:
    os.remove(backup)
    print('Already up to date. Nothing changed.')
