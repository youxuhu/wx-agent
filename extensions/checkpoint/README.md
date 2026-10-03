# checkpoint

Per-turn git snapshots plus `/rewind`: restore the code to an earlier turn, and
optionally navigate the conversation back to that turn.

- Before each turn the extension records a snapshot with `git stash create` (a
  commit object; the worktree is untouched). A clean tree records `HEAD` instead,
  so the turn is still rewindable.
- `/rewind` **always snapshots the current state first**, so a rewind can itself
  be rewound.
- Files added after the target snapshot are not deleted; the restore reports them
  as a fact rather than silently removing work.
- Snapshots live in `~/.pi/agent/checkpoints.json` (last 50); git objects persist
  until they are garbage-collected.

## Commands

```
/rewind list          # recent snapshots: time, ref, changed files
/rewind               # pick a snapshot interactively
/rewind 2             # restore snapshot #2 (as listed)
/rewind 2 --tree      # also navigate the conversation to that turn
```

Non-git directories are a no-op (the snapshot step is skipped silently; `/rewind`
says so).

Works alongside a separate git workflow: snapshots are stash objects and never
touch branch history, so commit/push flows are unaffected.
