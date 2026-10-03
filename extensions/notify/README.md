# notify

Native completion notification: a desktop notification and (optionally) a sound
when pi settles and is waiting for input.

Channel selection is automatic for the environment:

| Environment | Channel |
|---|---|
| Apple Terminal / generic macOS | `osascript display notification` + `afplay` |
| Kitty | OSC 99 |
| Ghostty / iTerm2 / WezTerm | OSC 777 |
| Windows Terminal | PowerShell toast |

## Config — `~/.pi/agent/notify.json`

```json
{ "enabled": true, "sound": "Glass", "desktop": true, "events": ["settled"] }
```

- `sound`: any name from `/System/Library/Sounds` (Basso, Blow, Bottle, Frog, Funk,
  Glass, Hero, Morse, Ping, Pop, Purr, Sosumi, Submarine, Tink) or `"none"`.
- `events`: `"settled"` (a run finished) and/or `"waiting"` (a prompt is waiting
  for your answer). Default is `settled` only, to stay quiet.

## Commands

```
/notify status
/notify on | off
/notify test
/notify sound Glass        # or: none
/notify events settled,waiting
```

Notification text is factual ("pi — Ready for input"), never suggestive.
