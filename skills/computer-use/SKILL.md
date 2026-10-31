---
name: computer-use
# Description is the routing metadata; keep detailed procedure in references.
description: Use when controlling a desktop GUI through Pi computer/computer-use, including 多步电脑操作、桌面自动化、窗口点击、表单/设置操作, or when asked to plan GUI intentions and track progress in todos. Requires evidence-based status updates; does not replace /cua permissions.
---

# Computer-use intentions

Use the existing `computer` tool and `rpiv-todo`; do not invent another task list or bypass `/cua` permission checks.

- For multi-step GUI work, or when the user requests a checklist, turn the natural-language request into outcome-oriented subgoals and create todos **before the first action**. One-step, low-risk requests need no todo unless requested.
- Keep the user's original goal and constraints fixed. Replan only unfinished subgoals when fresh UI evidence makes the current route unsuitable. Ask before expanding scope or doing consequential external actions.
- After each mutating action, observe the current UI and perform a distinct verification pass before updating the todo. `computer` returning `ok`, a changed screen hash, or the action model saying `done` is not proof that the intent was satisfied.
- Mark a todo `completed` only with explicit UI/effect evidence that matches its success criterion. Keep uncertain work in progress; represent a blocker in `metadata.blockedReason` while status remains `pending`.
- Only update todos created for this GUI task (`metadata.kind: "computer-intent"`); leave unrelated todos alone. Store short evidence/verdict/attempt notes in todo metadata, not screenshots, credentials, or long raw transcripts.

Read [the intent, verification, and task-memory procedure](references/intent-todo-memory.md) before multi-step GUI execution. This v1 uses task/session-local experience; it does not claim cross-session or cross-task learning.