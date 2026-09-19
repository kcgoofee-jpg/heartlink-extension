# heartlink

中文文档：[README.zh.md](README.zh.md)

A SillyTavern extension that sends your heart rate into the prompt and lets the story drive your toys.

It is the reference implementation of the [Tavern Bio-Context (TBC)](https://github.com/kcgoofee-jpg/tavern-bio-context) protocol. It only does two things: **connect reliably** and **inject reliably**. How the story is interpreted, and how intense the action gets, is up to your own model and presets.

## How it works

heartlink does three things, **without interpreting the story for you**:

1. **Feeds device data into the prompt**: the browser receives one heart-rate sample per second over the standard Bluetooth Heart Rate Service. When you press send, it packages the last round's heart-rate data by conversation phase into a `<bio_context>` block and sends it to **the model you configured**. The block only contains numbers, not conclusions like "excited" or "nervous"; how to read them is up to the automatically installed reading world book and your presets.
2. **Turns model-written actions into toy actions**: the model writes `<bio_act/>` in its reply. After the reply finishes generating, heartlink parses it, passes it through safety gates (on/off, rhythm, spacing, risky outputs must be named), and hands it to Intiface or a browser-direct connection to drive the toy.
3. **Closes the loop**: your body's reaction feeds into the next round's data, so the model can tell how the last passage landed.

![What happens during one round](docs/flow.png)

### Phases: how heart rate is sliced

![Phases](docs/phases.png)

The health-device page of the floating panel draws this round's chart in real time; the `+N%` on the capsule is relative to your resting heart rate.

**Time you are away does not count**: from the moment you press send, it tracks whether you are present — switching tabs or apps, window losing focus, scrolling up to old messages, or the heart-rate strap not being attached properly are all excluded and will not be treated as your reaction (sitting still while waiting for the model's first token does not count as away). "How long still counts as away" and "how long a reading is too long" are auto-calibrated to the rhythm of your recent rounds; the `gates` line in the block states whether the values used are learned or manually set.

The format is defined by the [Tavern Bio-Context protocol](https://github.com/kcgoofee-jpg/tavern-bio-context); any card, preset, or extension can read it.

## Installation

SillyTavern → Extensions → **Install Extension**, paste this repository URL:

```
https://github.com/kcgoofee-jpg/heartlink-extension
```

After installation a floating panel appears in the bottom-right corner (drag to move; tap "Hide floating panel" at the bottom of the panel to dismiss it, then restore it from the wand menu in the bottom-left). No SillyTavern helper script is required; if you have the old heartlink script inside the helper installed, please turn it off.

## Two device types, used separately

Tap the floating panel to open it; there are two tabs. Only the type you use is shown.

<img src="docs/panel-health.png" alt="Health device page" width="260"> <img src="docs/panel-toys.png" alt="Toy page" width="260">

### Health devices (heart rate)

1. Turn on "heart-rate broadcast" on your band / strap (WHOOP, Polar, most heart-rate straps; some watches need it enabled in their workout/health app).
2. Open SillyTavern in **Chrome / Edge** on a computer or Android phone (iPhone and Safari do not currently support Web Bluetooth).
3. Floating panel → Health device → **Connect device**, pick the device in the popup.
4. Choose a mode in "Settings & connection":

| Mode | What the character knows |
|---|---|
| **Behind the scenes** (default) | Nothing; heart rate only affects writing style |
| **In character** | Can sense your physical reactions (breathing, complexion) without mentioning numbers or devices |
| **Informed** | Knows you are wearing a device, can look at data, guide you, or explicitly say they made the toy move |

### Settings page

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

### Supported bands / watches

The device must support the **standard Bluetooth heart-rate broadcast**. The table below is based on each brand's official documentation (compiled 2026-09); WHOOP and Huawei Band 11 have been tested in Chrome, the rest have not been individually verified yet — feedback welcome.

| Device | Support | How to enable |
|---|---|---|
| WHOOP 4.0 / 5.0 | Supported (tested) | App → Device settings → Heart-rate broadcast |
| Huawei band / watch (most models) | Supported (Band 11 tested 2026-09-18) | On the band, start a workout mode such as Outdoor Walk; heart-rate broadcast turns on without the phone app. Some models: Settings → Heart-rate broadcast, which will disconnect the Health app |
| Honor band / watch | Supported | Watch settings → Heart-rate broadcast; some models require being in a workout |
| Garmin | Supported | Settings → Sensors & Accessories → Wrist Heart Rate → Broadcast Heart Rate |
| COROS | Supported | Toolbox → Heart-rate broadcast (phone connection will drop while broadcasting) |
| Polar watch / heart-rate strap | Supported | Watch: enable "Share heart rate with other devices" before training; straps broadcast by default |
| Xiaomi Band | Partial: older models (before Band 7 Pro) | Mi Fitness / Xiaomi Wear app → Device → Heart-rate broadcast |
| Amazfit / Zepp | Some models | Zepp app → Device → Health monitoring → Heart-rate push |
| Suunto | Some newer models (new firmware) | Follow official instructions |
| Fitbit Charge 6, Pixel Watch 2 and later | Some models | Quick settings → Share heart rate with exercise equipment |
| OPPO / OnePlus | Unconfirmed / unsupported | — |
| Apple Watch, Samsung Galaxy Watch | No native broadcast | Requires a third-party app, usually relayed through the phone; not recommended for now |
| Smart rings (Oura, Galaxy Ring, etc.) | Unsupported | — |

Devices without a standard heart-rate broadcast can be connected via a "local bridge" or "push" following the TBC protocol (minute-level data); see the device integration notes in the protocol repository.

Disconnections are auto-reconnected; walk away and come back and it will reconnect automatically. If it shows connected but has no data, it will resubscribe automatically.

### Toys

1. Install and open [Intiface Central](https://intiface.com/central/), tap **Start Server**, and connect your toy inside it (supported models are in the buttplug device library). To skip the software, jump to "Browser-direct connection" below.
2. Floating panel → Toys → turn on **Story联动**. The first time it will ask you to pick a rhythm: **Slow burn** (starts light), **Endurance** (medium intensity, longer pulses), **Frenzy** (high trigger chance, high power), or **Extreme** (almost always on full).
3. Tap **Connect via Intiface**. "Connected · N channels" means success.
4. At any time tap **Stop all**, or stop without opening the panel: type `/hl-stop` in the input, or press **Alt+Shift+S**. The page closing or Intiface disconnecting also stops immediately.

The top of the toy page has four buttons; pressing one changes the device immediately and records the action to tell the model:

| Button | What it does |
|---|---|
| **Weaker / Stronger** | Lower / raise the intensity of the currently running act by 20 percentage points (minimum 0, at which point this act stops); acts in the current reply that have not started yet are also adjusted by this amount |
| **Again** | Replay the last executed act (subject to on/off and spacing limits; too soon and it prompts you to wait) |
| **Skip** | Stop the currently running act; the next queued act starts as soon as spacing allows |

When no act is running only "Again" remains; after pressing, a message such as "✓ Stronger" appears for about 2 seconds, and the act list marks "Stronger +20%" or "Skipped".

The "Devices" section in the panel has one card per device; each channel (vibration, linear, rotation, heating, …) moves in real time to the level heartlink is sending and shows the current level. It displays the command being sent, not whether the device actually executed it. With more than two devices, each collapses to a row; tap to expand and see every channel.

### Browser-direct connection (no Intiface)

Tap **Browser-direct connection**, then choose a model:

| Option | Path |
|---|---|
| **Fanyi Bobo Bei** (suction · vibration · estim) | heartlink's built-in driver controls it directly over Bluetooth. Intiface does not support this model, so this is the only way |
| **Svakom SL278H** (vibration · tap · stroke · heat) | Same as above; this model can also use Intiface |
| **Other models** | buttplug's official WebAssembly build; supported models are the same as Intiface. The first use downloads a few MB of components |

Models that only support one connection method (such as Bobo Bei) will gray out the other button after first connection and show "This model only supports direct connection".

Both driver-equipped models are marked **unverified**: the commands come from community sources and we have not tested them on real hardware; start with low intensity the first time.
After choosing a model, the browser shows its own Bluetooth picker; select by the name prefix shown in the panel (Bobo Bei is `SOSEXY`). Use Chrome / Edge on a computer or Android phone; iPhone is not supported for now.

- **When the official app holds the device**: Bobo Bei only accepts one connection at a time, and you will see "This device only accepts one connection at a time". First **force-quit** the FUNF app on your phone (also swipe it away from recents), or simply turn off Bluetooth on the phone, then tap **Retry**. heartlink will not auto-retry to steal the connection, nor auto-reconnect after disconnect.
- **Device not responding**: "Only received 2/4 responses" usually means the official app is still connected, or the firmware differs. Quit the app and retry, or tap **Change model**.
- **Estim must be enabled per device**: on the device card this row defaults to "Off"; tap **Enable** on the right and confirm once to register. Even after enabling, it only moves when the model explicitly names `output="Estim"` in a reply, lasts at most 30 seconds, then stops automatically, and must rest for at least as long before it can move again. Enabling must be repeated for each device.
- **Disconnecting does not mean stopping**: neither of these two models advertises "stops on disconnect". After an unexpected disconnect the device card turns amber and reads "Disconnected · may still be running"; channels that were running show the level before disconnect. **Turn it off on the device itself, or remove the device**; when you tap **Reconnect**, the first thing heartlink does is stop all channels.
- **Unstoppable built-in modes**: if a device driver declares a mode that "starts a pattern the device itself runs to completion and software may not be able to stop", the device card gains a **Built-in mode** switch, default off, which requires per-device confirmation to turn on. While it runs, a banner and remaining seconds are shown below "Stop all" — **Built-in mode running, software may not be able to stop it; remove or use device button**; even if you press Stop all, the banner will not disappear early, it only changes to "Stop sent, device may ignore". Neither of the two drivers shipped with the extension has such a mode, so this row will not appear.

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

## Compatibility notes

- The reading world book relies on SillyTavern's "World Info scan depth" to trigger (default 2). When set to 0, the model still receives the data but not the reading instructions.
- With Claude and Gemini, SillyTavern turns mid-conversation system messages into user messages before sending. The injected block content is unchanged; it is just no longer treated as a system instruction.

## Safety

- Story联动 is off by default; it only moves after you turn it on.
- Stop all is always available; stopping does not go through the model. If the panel is covered by another plugin, use `/hl-stop` or Alt+Shift+S.
- Safewords (stop everything when the word appears in a message) are optional and off by default.

## Privacy

Your heart rate is sent as a text block to **the model provider you configured**, and nowhere else. To stop sending it, disconnect the heart-rate device (capsule → Health device → Settings & connection → Disconnect device), or disable the extension.

## Developer API

The page exposes `window.tbc` (TBC bus) and `window.heartlink`. Read-only APIs for character helpers / cards: `tbc.outputState()`, `tbc.replyActs()` (each record includes `feedback`), `tbc.feedbackLog()`, and events `bio:output-state`, `bio:reply-acts`, `bio:feedback`. Remotes, toy app bridges, etc. can report feedback via `tbc.feedback({ t, from, type, … })` (format is in protocol §5.12; malformed submissions are rejected).

## Feedback

Tested with your own device? Feedback is welcome following the TBC repository's [device testing guide](https://github.com/kcgoofee-jpg/tavern-bio-context/blob/main/docs/device-test-reports-zh.md).

## License

AGPL-3.0 (see `LICENSE`). Protocol text is in the TBC repository (CC BY 4.0).

## Acknowledgments

- BLE Heart Rate Profile (Bluetooth SIG), Web Bluetooth (W3C CG), RMSSD (ESC/NASPE 1996)
- SillyTavern and the SillyTavern helper script events / injection APIs; buttplug / Intiface Central (BSD-3-Clause)
- [HZXXXC/sillytavern-heart-rate-hrv](https://github.com/HZXXXC/sillytavern-heart-rate-hrv): the closest existing implementation; no code reused
- [Enclave0775/Intiface_Central-Sillytavern-plugin](https://github.com/Enclave0775/Intiface_Central-Sillytavern-plugin): source of the reading-speed simulation idea
