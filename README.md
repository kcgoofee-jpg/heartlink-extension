# heartlink

SillyTavern（酒馆）扩展：把你身上的心率送进提示词，并让剧情驱动你自己的玩具。

它是 [Tavern Bio-Context（TBC）](https://github.com/kcgoofee-jpg/tavern-bio-context) 协议的参考实现，只负责两件事：**连接稳定**和**注入稳定**。怎么理解剧情、写多强的动作，由你自己的模型和预设决定。

## 安装

酒馆 → 扩展程序 → **安装扩展程序** → 填本仓库地址：

```
https://github.com/kcgoofee-jpg/heartlink-extension
```

装好后页面右下角出现徽章（按住可拖动；不想看到时点菜单底部的“隐藏徽章”，之后从左下角魔杖菜单恢复）。不需要酒馆助手；装着酒馆助手里的旧版 heartlink 脚本时，请把脚本关掉。

## 两类设备，各自单独用

点徽章打开菜单，分两个标签页；只用哪一类，徽章就只显示哪一类。

### 健康设备（心率）

1. 手环 / 心率带打开“心率广播”（WHOOP、Polar、多数心率带；部分手表在运动健康 App 里开）。
2. 用**桌面版 Chrome 或 Edge**打开酒馆（Safari、iPhone 不支持网页蓝牙）。
3. 徽章 → 健康设备 → **连心率**，在弹窗里选设备。

断线会自动重连；走远了，设备回到附近会自动连回来；显示已连接却没有数据时，会自动重新订阅。

### 玩具

1. 安装并打开 [Intiface Central](https://intiface.com/central/)，点 **Start Server**，在里面连上玩具（支持的型号见 buttplug 设备库）。
2. 徽章 → 玩具 → **振动开**，第一次会让你选档位：**慢热**（从轻开始）或 **狂暴**（高触发、高功率）。
3. 点 **Intiface** 连接。显示“N 路”即成功。
4. 任何时候点 **停**。页面关闭、Intiface 断开也会立即停。

**直连β**：不装 Intiface、浏览器直接连玩具。实验功能，还没有经过真机测试。

## 模型怎么让设备动

模型在回复里写：

```
<bio_act pattern="wave" intensity="0.6" ms="5000"/>
```

回复生成完后，heartlink 按你的上限与档位执行。模式有 `pulse` `double` `triple` `long` `heartbeat` `wave`。不写 `output` 时驱动所有普通输出；加热、电刺激这类有风险的输出必须写明。详见 TBC 协议 §5。

每轮注入的 `<bio_context>` 里有一行 `haptics(heartlink): on | cap 60% | profile frenzy`，卡片和预设可以据此决定要不要写动作。

## 安全

- 振动默认关，你打开才会动；强度不会超过你设的上限。
- “停”随时可用；停止不经过模型。
- 安全词（消息里出现就全停）是可选功能，默认关。

## 隐私

心率会作为一段文字随提示词发给**你自己配置的模型服务商**，不会发到别处。不想发送时，在健康设备标签页里关掉“注入”。

## 开发者接口

页面上有 `window.tbc`（TBC 总线）与 `window.heartlink`。给角色助手 / 卡片用的只读接口：`tbc.outputState()`、`tbc.replyActs()`，事件 `bio:output-state`、`bio:reply-acts`。

## 反馈

用你自己的设备测过？欢迎按 TBC 仓库的 [设备实测说明](https://github.com/kcgoofee-jpg/tavern-bio-context/blob/main/docs/device-test-reports-zh.md) 提交结果。

## 许可

AGPL-3.0（见 `LICENSE`）。协议文本见 TBC 仓库（CC BY 4.0）。
