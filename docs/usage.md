# heartlink usage details

[中文文档：usage.zh.md](usage.zh.md) · [Back to README](../README.md)

## Settings page

The third tab at the top of the floating panel is **Settings** (Health device · Toys · Settings):

| Item | Description |
|---|---|
| Thresholds | View the current values for "how long still counts as away" and "how long a reading is too long", plus their source (estimated / learned from your last N rounds / manually set); you can override them, revert to auto, or clear learned habits in one click (stored locally only) |
| Panel | Toggle "collapse panel when tapping outside" (default on); when off, tapping the input box does not collapse the panel — use the top-right × or tap the capsule again |
| Light panel | Default is dark; turn this on for a light theme. Does not follow the SillyTavern theme automatically |
| Device Lab | Appears only when the TBC Device Lab is running locally; tap "Open" to test with virtual devices in a small window |
| This version | Current version, milestone, and changelog |
| Better away detection | Chrome / Edge can optionally use system-level idle detection (screen lock counts as away, taps inside card mini-UIs do not); requires browser permission, default off |
| Rhythm fine-tuning | Minimum intensity per level, duration per pulse, gap between pulses, and max acts per reply can all be adjusted; the `haptics` line tells the model what changed |
| Trial | Enable the new data format (TBC v0.4 draft: heart-rate lag, streaming tokens, derived statistics), default off |

## Toy page controls

The top of the toy page has four buttons; pressing one changes the device immediately and records the action to tell the model:

| Button | What it does |
|---|---|
| **Weaker / Stronger** | Lower / raise the intensity of the currently running act by 20 percentage points (minimum 0, at which point this act stops); acts in the current reply that have not started yet are also adjusted by this amount |
| **Again** | Replay the last executed act (subject to on/off and spacing limits; too soon and it prompts you to wait) |
| **Skip** | Stop the currently running act; the next queued act starts as soon as spacing allows |

When no act is running only "Again" remains; after pressing, a message such as "✓ Stronger" appears for about 2 seconds, and the act list marks "Stronger +20%" or "Skipped".

The "Devices" section in the panel has one card per device; each channel (vibration, linear, rotation, heating, …) moves in real time to the level heartlink is sending and shows the current level. It displays the command being sent, not whether the device actually executed it. With more than two devices, each collapses to a row; tap to expand and see every channel.

## How the model makes devices move

The model writes in its reply:

```
<bio_act pattern="wave" intensity="0.6" ms="5000"/>
```

After the reply finishes generating, heartlink executes it according to your chosen rhythm. Patterns are `pulse`, `double`, `triple`, `long`, `heartbeat`, `wave`. When `output` is omitted, all ordinary outputs are driven; risky outputs such as heat or estim must be named explicitly. See TBC protocol §5.

Each injected `<bio_context>` contains a line `haptics(heartlink): on | cap 100% | profile frenzy`, which cards and presets can use to decide whether to write actions.

### The model receives your feedback

If any act executed in the last round, or if you pressed one of the buttons above, Stop all, or changed rhythm, the next send adds one line (TBC protocol §5.12):

```
feedback(heartlink): acts 3 sent, 1 done, 1 cut, 1 pending | stronger +20% read @41s (reply -1, act 2, 2.4s in) | skip read @55s (reply -1, act 3)
```

- `acts …`: the fate of each act in the last reply — completed / stopped or interrupted / still queued at send time / rejected.
- Each subsequent segment is one operation: who (you, safeword, device itself), what they did, at which phase (`gen` while generating, `read` while reading the reply, `write` while typing, `send` at the moment of sending) and second, and which reply/act it corresponds to. Technical reasons such as device disconnect or auto-timeout are written as `stop by device (disconnected)`.
- The reading world book tells the model: stop and skip mean "that one was wrong", stronger and again mean "right", weaker means "right direction but too much", and device reasons do not indicate preference.
- Feedback is just a record, **it does not trigger new actions by itself**; new actions only come from the model's next reply. Regenerating a reply (swipe) carries this line as usual, and it is cleared after a normal send. The chat variable `bio.feedback.turn` contains the same content.
