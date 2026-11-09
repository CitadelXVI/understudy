# Understudy skill (for AI agents)

The source of the `understudy` Claude Code skill: how an agent drives Understudy (generate, check, fix, key, export)
through `understudy/scripts/us.py`. It is refined over time: edit it here, then install the copy agents load:

```
cp -r understudy ~/.claude/skills/        # Git Bash
Copy-Item -Recurse -Force understudy $HOME\.claude\skills\   # PowerShell
```

Lessons a session learns go in `understudy/LESSONS.md` (newest first); copy them back here if they were written in the
installed copy.
