# heartlink

English documentation: [README.md](README.md) · [支持的设备](docs/devices.zh.md) · [用法细节](docs/usage.zh.md)

SillyTavern（酒馆）扩展：把你身上的心率送进提示词，并让剧情驱动你自己的玩具。

它是 [Tavern Bio-Context（TBC）](https://github.com/kcgoofee-jpg/tavern-bio-context) 协议的参考实现，只负责两件事：**连接稳定**和**注入稳定**。怎么理解剧情、写多强的动作，由你自己的模型和预设决定。

## 原理

heartlink 做三件事，**不替你理解剧情**：

1. **把设备数据送进提示词**：浏览器通过蓝牙标准心率服务每秒收一个心率。你按下发送时，它把上一轮的心率按对话相位整理成一段 `<bio_context>`，随提示词发给**你自己配置的模型**。块里只写数值，不写“兴奋”“紧张”这类结论；怎么理解，由自动安装的读法世界书和你的预设决定。
2. **把模型写的动作变成玩具动作**：模型在回复里写 `<bio_act/>`，回复写完后 heartlink 解析，经过安全关（开关、节奏、间隔、有风险的输出要点名），再交给 Intiface 或浏览器直连去驱动玩具。
3. **形成闭环**：你身体的反应会进入下一轮的数据里，模型就能知道上一段写得怎么样。

![一轮对话里发生了什么](docs/flow.png)

### 相位：心率被切成哪几段

![相位](docs/phases.png)

悬浮窗的健康设备页会实时画出本轮这张图；胶囊上的 +N% 是和平静心率比。**你不在的时间不算**：从按下发送开始，切到别的标签页或别的程序、窗口失焦、往上翻旧消息、心率带没贴好，这些秒都剔除。格式由 [Tavern Bio-Context 协议](https://github.com/kcgoofee-jpg/tavern-bio-context) 规定。

## 安装

酒馆 → 扩展程序 → **安装扩展程序** → 填本仓库地址：

```
https://github.com/kcgoofee-jpg/heartlink-extension
```

装好后页面右下角出现悬浮窗（按住可拖动；不想看到时点面板底部的“隐藏悬浮窗”，之后从左下角魔杖菜单恢复）。不需要酒馆助手；装着酒馆助手里的旧版 heartlink 脚本时，请把脚本关掉。

## 两类设备，各自单独用

点悬浮窗打开面板，分两个标签页；只用哪一类，悬浮窗就只显示哪一类。

<img src="docs/panel-health.png" alt="健康设备页" width="260"> <img src="docs/panel-toys.png" alt="玩具页" width="260">

### 健康设备（心率）

1. 手环 / 心率带打开“心率广播”。支持的设备与各品牌开启方法见 [docs/devices.zh.md](docs/devices.zh.md)。
2. 用电脑或安卓手机上的 **Chrome / Edge** 打开酒馆（iPhone 和 Safari 暂不支持网页蓝牙）。
3. 悬浮窗 → 健康设备 → **连接设备**，在弹窗里选设备。
4. 在“设置与连接”里选模式：

| 模式 | 角色知道什么 |
|---|---|
| **幕后**（默认） | 什么都不知道，心率只影响写法 |
| **入戏** | 能察觉你的身体表现（呼吸、脸色），不提数字和设备 |
| **知情** | 知道你戴着设备，可以看数据、指导你，也可以明说是自己让玩具动的 |

悬浮窗顶部第三个标签页是 **设置**。设置项说明见 [docs/usage.zh.md](docs/usage.zh.md)。

### 玩具

1. 安装并打开 [Intiface Central](https://intiface.com/central/)，点 **Start Server**，在里面连上玩具（支持的型号见 buttplug 设备库）。不想装软件的话用 **浏览器直接连**，详见 [docs/devices.zh.md](docs/devices.zh.md)。
2. 悬浮窗 → 玩具 → 打开 **剧情联动**，第一次会让你选节奏：**慢热**（从轻开始）、**持久**（中等强度、动得久）、**狂暴**（高触发、高功率）或 **极限**（几乎一直开满）。
3. 点 **通过 Intiface**。显示“已连接 · N 路”即成功。
4. 任何时候点 **全部停止**，或者不打开面板直接停：输入 `/hl-stop`，或按 **Alt+Shift+S**。页面关闭、Intiface 断开也会立即停。

玩具页还有 **弱一点 / 强一点**、**再来一次**、**跳过** 四个按钮，可按实时调节 / 重放 / 跳过当前动作。完整按钮与设备卡说明见 [docs/usage.zh.md](docs/usage.zh.md)。

## 安全

- 剧情联动默认关，你打开才会动。
- “全部停止”随时可用；停止不经过模型。面板被别的插件盖住时，用 `/hl-stop` 或 Alt+Shift+S。
- 安全词（消息里出现就全停）是可选功能，默认关。
- 页面关闭、连接断开或断开玩具时，输出会立即停止。
- 微电流和“自带模式”这类由设备自己跑完的模式需要**逐台确认**；自带模式运行期间软件可能无法停止。

## 隐私

心率会作为一段文字随提示词发给**你自己配置的模型服务商**，不会发到别处。不想发送时，断开心率设备，或者停用扩展。

## 兼容提示

- 读法世界书靠酒馆的“世界书扫描深度”触发（默认 2）。设成 0 时，模型收得到数据，但收不到读法说明。
- 用 Claude、Gemini 时，酒馆会把对话中间的系统消息改成用户消息发送。注入块内容不变，只是不算系统指令。

## 开发者接口

页面上有 `window.tbc`（TBC 总线）与 `window.heartlink`。给角色助手 / 卡片用的只读接口：`tbc.outputState()`、`tbc.replyActs()`（每条记录带 `feedback`）、`tbc.feedbackLog()`，事件 `bio:output-state`、`bio:reply-acts`、`bio:feedback`。遥控器、玩具 App 桥等可以用 `tbc.feedback({ t, from, type, … })` 报反馈（格式见协议 §5.12，不合规会被拒收）。

## 反馈

用你自己的设备测过？欢迎按 TBC 仓库的 [设备实测说明](https://github.com/kcgoofee-jpg/tavern-bio-context/blob/main/docs/device-test-reports-zh.md) 提交结果。

## 许可

AGPL-3.0（见 `LICENSE`）。协议文本见 TBC 仓库（CC BY 4.0）。

## 致谢

- BLE Heart Rate Profile（Bluetooth SIG）、Web Bluetooth（W3C CG）、RMSSD（ESC/NASPE 1996）
- SillyTavern 与酒馆助手的事件、注入接口；buttplug / Intiface Central（BSD-3-Clause）
- [HZXXXC/sillytavern-heart-rate-hrv](https://github.com/HZXXXC/sillytavern-heart-rate-hrv)：最接近的现有实现，未复用代码
- [Enclave0775/Intiface_Central-Sillytavern-plugin](https://github.com/Enclave0775/Intiface_Central-Sillytavern-plugin)：阅读速度模拟的思路来源
