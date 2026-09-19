# heartlink devices

[中文文档：devices.zh.md](devices.zh.md) · [Back to README](../README.md)

## Supported bands / watches

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

Devices without a standard heart-rate broadcast can be connected via a "local bridge" or "push" following the TBC protocol (minute-level data); see the device integration notes in the [Tavern Bio-Context protocol](https://github.com/kcgoofee-jpg/tavern-bio-context) repository.

Disconnections are auto-reconnected; walk away and come back and it will reconnect automatically. If it shows connected but has no data, it will resubscribe automatically.

## Browser-direct connection (no Intiface)

Tap **Browser-direct connection**, then choose a model:

| Option | Path |
|---|---|
| **Fanyi Bobo Bei** (suction · vibration · estim) | heartlink's built-in driver controls it directly over Bluetooth. Intiface does not support this model, so this is the only way |
| **Svakom SL278H** (vibration · tap · stroke · heat) | Same as above; this model can also use Intiface |
| **Other models** | buttplug's official WebAssembly build; supported models are the same as Intiface. The first use downloads a few MB of components |

Models that only support one connection method (such as Bobo Bei) will gray out the other button after first connection and show "This model only supports direct connection".

Both driver-equipped models are marked **unverified**: the commands come from community sources and we have not tested them on real hardware; start with low intensity the first time. After choosing a model, the browser shows its own Bluetooth picker; select by the name prefix shown in the panel (Bobo Bei is `SOSEXY`). Use Chrome / Edge on a computer or Android phone; iPhone is not supported for now.

- **When the official app holds the device**: Bobo Bei only accepts one connection at a time, and you will see "This device only accepts one connection at a time". First **force-quit** the FUNF app on your phone (also swipe it away from recents), or simply turn off Bluetooth on the phone, then tap **Retry**. heartlink will not auto-retry to steal the connection, nor auto-reconnect after disconnect.
- **Device not responding**: "Only received 2/4 responses" usually means the official app is still connected, or the firmware differs. Quit the app and retry, or tap **Change model**.
- **Estim must be enabled per device**: on the device card this row defaults to "Off"; tap **Enable** on the right and confirm once to register. Even after enabling, it only moves when the model explicitly names `output="Estim"` in a reply, lasts at most 30 seconds, then stops automatically, and must rest for at least as long before it can move again. Enabling must be repeated for each device.
- **Disconnecting does not mean stopping**: neither of these two models advertises "stops on disconnect". After an unexpected disconnect the device card turns amber and reads "Disconnected · may still be running"; channels that were running show the level before disconnect. **Turn it off on the device itself, or remove the device**; when you tap **Reconnect**, the first thing heartlink does is stop all channels.
- **Unstoppable built-in modes**: if a device driver declares a mode that "starts a pattern the device itself runs to completion and software may not be able to stop", the device card gains a **Built-in mode** switch, default off, which requires per-device confirmation to turn on. While it runs, a banner and remaining seconds are shown below "Stop all" — **Built-in mode running, software may not be able to stop it; remove or use device button**; even if you press Stop all, the banner will not disappear early, it only changes to "Stop sent, device may ignore". Neither of the two drivers shipped with the extension has such a mode, so this row will not appear.
