// heartlink v0.21.2 — SillyTavern 扩展：心率注入 + 触觉输出（Tavern Bio-Context 参考实现）。构建产物。
// https://github.com/kcgoofee-jpg/heartlink-extension
// heartlink core — 纯函数层。没有 DOM、没有蓝牙、没有酒馆 API，Node 和浏览器都能跑。
// 运行时（runtime.js）和单元测试共用这一份。构建时与 runtime.js 拼成 dist/heartlink.js。
//
// 数据模型
//   sample: { t: 毫秒时间戳, bpm: 心率, rr: [相邻心跳间隔（秒）...] }   每秒一个，来自蓝牙心率协议
//   event:  { t, type, ...extra }                                     由 runtime 记录的页面事件
//     send(kind) / stream_start / reasoning_end / reply_end / swipe   生成相关
//     type(len) / activity / visible / hidden / chat_changed          用户与页面
// 输出
//   composeContext() → 注入给模型的 <bio_context> 文本块（Tavern Bio-Context，规范见 tavern-bio-context 仓库，本地目录 ../spec）
const HeartlinkCore = (() => {
  'use strict';

  const CONFIG = {
    STALE_MS: 10000,            // 最后一个样本超过 10 秒视为数据不可用
    IDLE_MS: 60000,             // 60 秒无按键且页面前台 = 安静（自动基线用）
    PAUSE_MS: 5000,             // 打字中停顿超过 5 秒算一次停顿
    AWAY_MS: 60000,             // 60 秒连活动信号都没有算无操作
    SHORT_AWAY_MS: 5000,        // 窗口失焦、翻看旧消息短于 5 秒不记（协议 v0.4 §6，经验值）
    BUCKET_MS: 10000,           // 序列粒度
    SERIES_MAX_MS: 5 * 60000,   // 序列最长回看 5 分钟
    READ_SUSPICIOUS_MS: 10 * 60000, // 读回复超过 10 分钟：标注时长异常
    QUIET_LOOKBACK_MS: 30 * 60000, // 自动基线回看 30 分钟
    QUIET_MIN_SAMPLES: 60,      // 安静段样本不足时退回全场 20 分位
    QUIET_MAX_RR_DROPOUT: 0.5,  // 安静段要求带 RR 的包不少于一半（排除手腕活动）
    MANUAL_BASELINE_WINDOW_MS: 60000,
    MANUAL_BASELINE_MIN_SAMPLES: 20,
    READ_CPS_CJK: 6,            // read-pos 默认阅读速度：中文（正文 CJK 占比 ≥ 0.3），字/秒
    READ_CPS_LATIN: 20,         // read-pos 默认阅读速度：非中文，字/秒
    CPS_CAL_MIN_TURNS: 3,       // read-pos 自校准（estimateCps）至少要这么多轮样本才用 cal，否则退回默认值 est
    // HRV（RMSSD）。WHOOP 是腕式光电，活动时 RR 很脏（漏拍成 2 倍、多拍成一半、整包不带 RR）
    HRV_WINDOW_MS: 120000,
    HRV_MIN_RAW: 15,            // 窗口内原始 RR 至少 15 个
    HRV_MIN_PAIRS: 8,           // 有效相邻差值对至少 8 个
    HRV_MIN_KEEP_RATIO: 0.5,    // 剔除后保留比例至少 50%
    RR_MIN_S: 0.3, RR_MAX_S: 2.0,
    RR_MEDIAN_TOLERANCE: 0.25,  // 相对窗口中位数的容差
    PACKET_GAP_MS: 1500,        // 相邻带 RR 的包间隔超过这个值视为中间有缺口
  };

  // ---------- 蓝牙心率协议（Heart Rate Measurement 0x2A37） ----------
  // 第 1 字节是标志位：bit0 心率是否 16 位；bit1-2 佩戴检测；bit3 有无能量消耗字段；bit4 有无 RR 间期。
  function parseHeartRate(dataView) {
    const flags = dataView.getUint8(0);
    let offset = 1;
    let bpm;
    if (flags & 0x01) { bpm = dataView.getUint16(offset, true); offset += 2; }
    else { bpm = dataView.getUint8(offset); offset += 1; }
    const sensorContact = (flags & 0x04) ? Boolean(flags & 0x02) : null; // null = 设备不报告佩戴状态
    if (flags & 0x08) offset += 2;
    const rr = [];
    if (flags & 0x10) {
      while (offset + 1 < dataView.byteLength) { rr.push(dataView.getUint16(offset, true) / 1024); offset += 2; }
    }
    return { bpm, rr, sensorContact };
  }

  // ---------- 数据卫生（审查第 2 条）：只删明显不可能的值，不平滑、不修补；删掉的值如实体现在覆盖率里 ----------
  //   范围：< 25 或 > 240 bpm 丢掉（0 常见于没读到数的包）；
  //   单点跳变：和 3 秒内上一个样本差 > 30 bpm 的先扣住，下一个样本离它 ≤ 15 bpm 才算真的变了（两个一起放行），否则丢掉它
  const HR_SANE = { MIN: 25, MAX: 240, JUMP_BPM: 30, JUMP_WITHIN_MS: 3000, CONFIRM_BPM: 15 };
  const hrPlausible = (bpm) => Number.isFinite(bpm) && bpm >= HR_SANE.MIN && bpm <= HR_SANE.MAX;
  function createHrGate() {
    let last = null; let held = null;
    const stats0 = { rejected: 0, jumps: 0 };
    const near = (a, b, lim) => b.t >= a.t && b.t - a.t <= HR_SANE.JUMP_WITHIN_MS && Math.abs(b.bpm - a.bpm) <= lim;
    function push(s) {
      if (!s || !hrPlausible(s.bpm)) { stats0.rejected++; return []; }
      const out = [];
      if (held) {
        if (near(held, s, HR_SANE.CONFIRM_BPM)) { out.push(held); last = held; }
        else stats0.jumps++;
        held = null;
      }
      if (!out.length && last && s.t >= last.t && s.t - last.t <= HR_SANE.JUMP_WITHIN_MS && Math.abs(s.bpm - last.bpm) > HR_SANE.JUMP_BPM) { held = s; return out; }
      out.push(s); last = s;
      return out;
    }
    return { push, stats: stats0, reset() { last = null; held = null; } };
  }
  // 佩戴位（parseHeartRate 的 sensorContact === false）：这些时段的心率不进统计（v0.3 §2.1 wear 行、§2.2 off-wrist 段）。
  // 样本上带 contact:false 的，按 1 秒一个包连成区间（相邻 ≤ 2 秒的并成一段）
  function contactSpans(samples) {
    const out = [];
    for (const s of samples || []) {
      if (!s || s.contact !== false) continue;
      const p = out[out.length - 1];
      if (p && s.t <= p[1] + 2000) p[1] = Math.max(p[1], s.t + 1000); else out.push([s.t, s.t + 1000]);
    }
    return out;
  }
  // 设备戴在哪（v0.4 §2 的滞后按设备类型取缺省值）：广播名认得的胸带 → chest；认得的手环手表 → wrist；
  // 都不认得时，报佩戴位又每包带心跳间隔的多半是胸带；其余按手腕。只是猜测，用户可在设置里改
  const CHEST_RE = /(?:polar\s*h\d|\bh10\b|\bh9\b|\bhrm|tickr|coospo|wahoo|magene|moofit|chest|strap)/i;
  const WRIST_RE = /(?:whoop|band|watch|huawei|honor|xiaomi|\bmi\b|amazfit|forerunner|venu|fenix|coros|fitbit|pixel|verity|ignite|vantage|pacer|grit|galaxy|oppo|suunto)/i;
  const LAG_MS_BY_CLASS = { chest: 4000, wrist: 6000 };   // v0.4 §2.1：胸带 4 秒，腕式 / 未知 6 秒（经验值）
  function guessWear({ name, rr, contact } = {}) {
    const n = String(name || '');
    if (CHEST_RE.test(n)) return 'chest';
    if (WRIST_RE.test(n)) return 'wrist';
    return rr && contact ? 'chest' : 'wrist';
  }
  // 峰值门槛的腕式绝对下限（v0.3 §1.4-3）：腕式光电日常误差约 5–7%，门槛不能只看噪声
  const WRIST_FLOOR = { MIN_BPM: 6, BASELINE_PCT: 0.07 };
  function peakFloor(wearClass, baselineBpm) {
    if (wearClass !== 'wrist') return 0;
    return Math.max(WRIST_FLOOR.MIN_BPM, Number.isFinite(baselineBpm) ? baselineBpm * WRIST_FLOOR.BASELINE_PCT : 0);
  }

  // ---------- 通用统计 ----------
  function inWin(samples, from, to) { return samples.filter((s) => s.t >= from && s.t <= to); }
  function median(arr) { const a = [...arr].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
  function percentile(values, p) { if (!values.length) return null; const a = [...values].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; }
  function stats(arr) {
    if (!arr.length) return null;
    const bpms = arr.map((s) => s.bpm);
    const max = Math.max(...bpms);
    return {
      first: bpms[0], last: bpms[bpms.length - 1], min: Math.min(...bpms), max, n: bpms.length,
      mean: Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length),
      peakAt: arr[bpms.indexOf(max)].t,
      rrDropout: 1 - arr.filter((s) => s.rr && s.rr.length).length / arr.length,
    };
  }
  function series(samples, from, to) {
    const out = [];
    for (let b = from; b < to; b += CONFIG.BUCKET_MS) {
      const w = inWin(samples, b, Math.min(b + CONFIG.BUCKET_MS, to) - 1);
      out.push(w.length ? Math.round(w.reduce((a, s) => a + s.bpm, 0) / w.length) : '·');
    }
    return out;
  }
  function isFresh(sample, now, staleMs) { return Boolean(sample) && now - sample.t <= (Number.isFinite(staleMs) ? staleMs : CONFIG.STALE_MS); }
  // ② 按设备节奏自动（设置方案 §3.6）：数据新鲜门槛。固定 10 秒对 30 秒才来一个样本的来源（回放、手机推送）几乎永远判成没数据
  function staleThresholdMs(cadenceMs) { return Math.max(CONFIG.STALE_MS, Number.isFinite(cadenceMs) ? 3 * cadenceMs : 0); }
  function fmtClock(t) { const d = new Date(t); return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':'); }
  function fmtDur(ms) { const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`; }

  // ---------- HRV ----------
  // 把窗口内的 RR 序列整理成 { raw, kept, pairs }：raw 原始个数；kept 通过过滤的个数；pairs 可用于 RMSSD 的相邻差值（毫秒）
  function collectRR(samples, fromMs, toMs) {
    const seq = [];
    let lastT = null;
    for (const s of samples) {
      if (!(s.t > fromMs && s.t <= toMs) || !Array.isArray(s.rr) || !s.rr.length) continue;
      const gap = lastT != null && (s.t - lastT) > CONFIG.PACKET_GAP_MS;
      s.rr.forEach((rr, i) => seq.push({ rr, gapBefore: i === 0 && gap }));
      lastT = s.t;
    }
    const raw = seq.length;
    if (!raw) return { raw: 0, kept: 0, pairs: [] };
    const inRange = seq.map((x) => x.rr).filter((rr) => rr >= CONFIG.RR_MIN_S && rr <= CONFIG.RR_MAX_S);
    if (!inRange.length) return { raw, kept: 0, pairs: [] };
    const med = median(inRange);
    const lo = med * (1 - CONFIG.RR_MEDIAN_TOLERANCE), hi = med * (1 + CONFIG.RR_MEDIAN_TOLERANCE);
    const pairs = [];
    let kept = 0, prevOk = false, prevRR = null;
    for (const x of seq) {
      const ok = x.rr >= lo && x.rr <= hi;
      if (ok) kept++;
      if (ok && prevOk && !x.gapBefore) pairs.push((x.rr - prevRR) * 1000);
      prevOk = ok; prevRR = x.rr;
    }
    return { raw, kept, pairs };
  }
  // RMSSD，毫秒；信号不够返回 null
  function rmssd(collected) {
    if (!collected || collected.raw < CONFIG.HRV_MIN_RAW || collected.pairs.length < CONFIG.HRV_MIN_PAIRS) return null;
    if (collected.kept / collected.raw < CONFIG.HRV_MIN_KEEP_RATIO) return null;
    return Math.round(Math.sqrt(collected.pairs.reduce((acc, d) => acc + d * d, 0) / collected.pairs.length));
  }
  function hrvInWindow(samples, fromMs, toMs) { return rmssd(collectRR(samples, fromMs, toMs)); }
  function hrvOver(samples) { if (!samples.length) return null; return hrvInWindow(samples, samples[0].t - 1, samples[samples.length - 1].t); }

  // ---------- 基线 ----------
  // 手动基线：最近 60 秒平均（用户静坐时按一下）。返回 { ok, bpm, hrv, count } 或 { ok:false, reason }
  function manualBaseline(samples, now) {
    const picked = inWin(samples, now - CONFIG.MANUAL_BASELINE_WINDOW_MS, now);
    if (picked.length < CONFIG.MANUAL_BASELINE_MIN_SAMPLES) return { ok: false, reason: `最近 60 秒只有 ${picked.length} 个样本，至少要 ${CONFIG.MANUAL_BASELINE_MIN_SAMPLES} 个` };
    return { ok: true, bpm: Math.round(picked.reduce((sum, s) => sum + s.bpm, 0) / picked.length), hrv: hrvInWindow(samples, now - CONFIG.HRV_WINDOW_MS, now), count: picked.length };
  }
  // 静坐记平静心率（v0.3 §1.5 manual 的做法：丢掉前 60 秒，再取 120 秒；Laborde 2017、Munoz 2015）
  //   startedAt：开始静坐的时刻（中途打字或切走页面时由运行层重设）。样本不足一半时不记。
  //   bpm 取中位数；HRV 走相位同一道 5% 门槛（审查第 13 条），不够就不给；noise = 稳健标准差（v0.4 §3）
  const REST = { WARM_MS: 60000, REC_MS: 120000, MIN_SAMPLES: 60 };
  function restBaseline(samples, startedAt) {
    const from = startedAt + REST.WARM_MS; const to = from + REST.REC_MS;
    const picked = inWin(samples || [], from, to).filter((s) => s.contact !== false);
    if (picked.length < REST.MIN_SAMPLES) return { ok: false, reason: 'few-samples', count: picked.length };
    const bpms = picked.map((s) => s.bpm);
    const st = stats(picked);
    let hrv = null;
    if (st.rrDropout <= 0.05) { const c = collectRR(picked, from - 1, to); if (c.raw && 1 - c.kept / c.raw <= 0.05) hrv = rmssd(c); }
    return { ok: true, bpm: Math.round(median(bpms)), hrv, n: picked.length, noise: robustSd(bpms), from, to };
  }
  // 手动基线是否还能用（v0.3 §1.5 / v0.4 §3-3：超过 24 小时或换了设备应降到下一优先级）
  //   → null 可用；'age' 超过 24 小时；'device' 在别的设备上记的；'unknown' 不知道什么时候记的（或 v0.4 要的设备名不合规）
  const MANUAL_MAX_AGE_MS = 24 * 3600 * 1000;
  function manualBaselineStale(m, now, device, opts) {
    if (!m) return null;
    if (!Number.isFinite(m.at)) return 'unknown';
    if (now - m.at > MANUAL_MAX_AGE_MS) return 'age';
    if (device && m.device && device !== m.device) return 'device';
    if (opts && opts.requireDeviceId && !isDeviceName(manualDeviceId(m))) return 'unknown';
    return null;
  }
  // 块里写的设备名：运行层另存的 deviceId（与首行 device 属性同一套写法）；没有时用 device 本身（须已合规）
  const manualDeviceId = (m) => (m && m.deviceId != null ? m.deviceId : m && m.device);
  const STALE_WHY = { age: 'manual set over 24h ago', device: 'manual set on another device', unknown: 'manual set time unknown' };
  // gen / read 区间（v0.3 §1.5 rest 排除项）：从 send → reply_end 反推 gen，reply_end → 下一次打字（或 to）反推 read；
  //   跨多轮历史反推，不止最近一轮。send/reply_end 缺失时该轮不算数，不影响其余轮次
  function genReadSpans(events, from, to) {
    const ev = (events || []).filter((e) => e && e.t <= to && (e.type === 'send' || e.type === 'reply_end' || e.type === 'type')).sort((a, b) => a.t - b.t);
    const spans = [];
    let sendAt = null, replyAt = null;
    for (const e of ev) {
      if (e.type === 'send') { sendAt = e.t; replyAt = null; }
      else if (e.type === 'reply_end') { if (sendAt != null && e.t > sendAt) spans.push([sendAt, e.t]); replyAt = e.t; sendAt = null; }
      else if (replyAt != null) { spans.push([replyAt, e.t]); replyAt = null; }
    }
    if (replyAt != null && to > replyAt) spans.push([replyAt, to]);
    return spans.filter(([a, b]) => b > from && a < to).map(([a, b]) => [Math.max(a, from), Math.min(b, to)]);
  }
  // 安静段：从事件流推出“页面前台、60 秒内无按键、且不在 gen / read 区间”的区间
  function quietWindows(events, from, to) {
    const keys = events.filter((e) => e.type === 'type' && e.t >= from - CONFIG.IDLE_MS && e.t <= to).map((e) => e.t);
    const vis = events.filter((e) => (e.type === 'visible' || e.type === 'hidden') && e.t <= to).sort((a, b) => a.t - b.t);
    let hiddenSince = null;
    const hiddenSpans = [];
    for (const e of vis) {
      if (e.type === 'hidden' && hiddenSince == null) hiddenSince = e.t;
      if (e.type === 'visible' && hiddenSince != null) { hiddenSpans.push([hiddenSince, e.t]); hiddenSince = null; }
    }
    if (hiddenSince != null) hiddenSpans.push([hiddenSince, to]);
    const busy = keys.map((t) => [t - 1000, t + CONFIG.IDLE_MS]).concat(hiddenSpans).concat(genReadSpans(events, from, to)).sort((a, b) => a[0] - b[0]);
    const wins = [];
    let cur = from;
    for (const [a, b] of busy) { if (a > cur) wins.push([cur, Math.min(a, to)]); cur = Math.max(cur, b); if (cur >= to) break; }
    if (cur < to) wins.push([cur, to]);
    return wins.filter(([a, b]) => b - a >= 30000);
  }
  // 稳健标准差 1.4826 × MAD；样本不足 3 个时 null
  function robustSd(values) {
    if (!values || values.length < 3) return null;
    const med = median(values);
    return 1.4826 * median(values.map((v) => Math.abs(v - med)));
  }
  // 会话自动基线：安静段样本中位数；不足则全场 20 分位；再不足 null。noise = 所用样本的稳健标准差（v0.3 §1.4 峰值门槛用，不写进块）
  function sessionBaseline(samples, events, now) {
    const from = now - CONFIG.QUIET_LOOKBACK_MS;
    // 安静段再按 60 秒切块，逐块看 RR 缺失率：一整段里只要有一部分手腕在动，不该把整段都扔掉
    const quiet = [];
    for (const [a, b] of quietWindows(events, from, now)) {
      for (let c = a; c < b; c += CONFIG.IDLE_MS) {
        const w = inWin(samples, c, Math.min(c + CONFIG.IDLE_MS, b));
        const st = stats(w);
        if (st && st.n >= 20 && st.rrDropout <= CONFIG.QUIET_MAX_RR_DROPOUT) quiet.push(...w);
      }
    }
    if (quiet.length >= CONFIG.QUIET_MIN_SAMPLES) return { bpm: percentile(quiet.map((s) => s.bpm), 0.5), method: 'quiet-median', n: quiet.length, hrv: hrvOver(quiet), noise: robustSd(quiet.map((s) => s.bpm)), lastT: quiet[quiet.length - 1].t };
    const all = inWin(samples, from, now);
    if (all.length >= CONFIG.QUIET_MIN_SAMPLES) return { bpm: percentile(all.map((s) => s.bpm), 0.2), method: 'p20', n: all.length, hrv: null, noise: robustSd(all.map((s) => s.bpm)), lastT: all[all.length - 1].t };
    return null;
  }

  // ---------- 相位 ----------
  // 离开区间合并：按起点排序，重叠或相接的并成一段；有一部分是 hidden 就记 hidden
  function mergeSpans(spans) {
    const s = spans.map((x) => x.slice()).sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const x of s) {
      const p = out[out.length - 1];
      if (p && x[0] <= p[1]) { p[1] = Math.max(p[1], x[1]); if (x[2] === 'hidden') p[2] = 'hidden'; }
      else out.push(x);
    }
    return out;
  }
  // 离开区间按类型优先级拆成互不重叠的几段（协议 v0.4 §6：hidden > unfocused > offscreen > idle），相邻同类并成一段
  const AWAY_RANK = { hidden: 4, unfocused: 3, offscreen: 2, idle: 1 };
  // 重新开始计“多久没动”的事件：读者的操作，以及新内容出现（首字、思维链结束、回复写完）——边看流式出字边读、不碰鼠标是正常读法
  const IDLE_BREAKERS = new Set(['type', 'visible', 'hidden', 'swipe', 'activity', 'focus', 'blur', 'stream_start', 'reasoning_end', 'reply_end']);
  function partitionAway(raw) {
    const pts = [...new Set(raw.flatMap(([a, b]) => [a, b]))].sort((x, y) => x - y);
    const out = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], mid = (a + b) / 2;
      let best = null;
      for (const [x, y, k] of raw) if (mid >= x && mid < y && (!best || AWAY_RANK[k] > AWAY_RANK[best])) best = k;
      if (!best) continue;
      const p = out[out.length - 1];
      if (p && p[2] === best && p[1] === a) p[1] = b; else out.push([a, b, best]);
    }
    return out;
  }
  // [from, to] 与离开区间重叠的总毫秒数
  function overlapMs(spans, from, to) {
    let ms = 0;
    for (const [a, b] of mergeSpans(spans || [])) ms += Math.max(0, Math.min(b, to) - Math.max(a, from));
    return ms;
  }
  // 从统计里剔除的离开类型：页面切走是确定不在读；idle（一分钟没鼠标键盘）可能只是在安静地读，只影响峰值与 read-pos
  const EXCLUDED_AWAY = new Set(['hidden', 'unfocused']);
  const excludedSpans = (away) => (away || []).filter((x) => EXCLUDED_AWAY.has(x[2]));
  const inSpans = (spans, t) => spans.some(([a, b]) => t >= a && t < b);
  // A-1：相位统计剔除切走区间。→ { st, samples, netMs, awayMs }
  //   netMs = 相位时长减去切走时长；awayMs = 与任何离开区间（含 idle）重叠的时长
  function phaseStats(samples, from, to, away) {
    const ex = excludedSpans(away);
    const picked = inWin(samples, from, to).filter((s) => !inSpans(ex, s.t));
    return { st: stats(picked), samples: picked, netMs: Math.max(0, to - from - overlapMs(ex, from, to)), awayMs: overlapMs(away, from, to) };
  }
  // 相位起点到 t 之间、扣掉切走时间后的毫秒数
  const netOffset = (away, from, t) => Math.max(0, t - from - overlapMs(excludedSpans(away), from, t));

  // away 行（协议 v0.4 §6）：v0.4 写相对发送时刻并标出相位（跨相位的区间按相位拆开）；v0.3 只认 hidden / idle，
  //   按统计处理方式映射：unfocused → hidden（都不计入）、offscreen → idle（都计入、都不判位置）
  const AWAY_V03 = { hidden: 'hidden', unfocused: 'hidden', offscreen: 'idle', idle: 'idle' };
  const fmtRel = (ms) => { const sec = Math.round(Math.max(0, ms) / 1000); return `-${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
  function awayLine(turn, samples, v04) {
    if (!turn.away.length) return 'away: none';
    const rng = (a, b) => { const st = stats(inWin(samples, a, b)); return st ? ` [${st.min}–${st.max}]` : ''; };
    if (!v04) return 'away: ' + turn.away.slice(-5).map(([a, b, k]) => `${fmtClock(a)}–${fmtClock(b)} ${AWAY_V03[k]}${rng(a, b)}`).join('; ');
    const phases = [];
    if (turn.prevSend != null && turn.replyEnd != null) phases.push([turn.prevSend, turn.replyEnd, 'gen']);
    if (turn.readStart != null && turn.readEnd != null) phases.push([turn.readStart, turn.readEnd, 'read']);
    if (turn.typingStart != null) phases.push([turn.typingStart, turn.now, 'write']);
    const parts = [];
    for (const [a, b, k] of turn.away) for (const [x, y, ph] of phases) {
      const lo = Math.max(a, x), hi = Math.min(b, y);
      if (hi - lo >= 1000) parts.push([lo, hi, k, ph]);
    }
    if (!parts.length) return 'away: none';
    return 'away: ' + parts.slice(-5).map(([a, b, k, ph]) => `${fmtRel(turn.now - a)}..${fmtRel(turn.now - b)} ${k} (${ph})${rng(a, b)}`).join('; ');
  }
  // 把事件流切成本轮相位。now = 本次发送时刻。
  // opts.trigger = 'swipe'：读的是被换掉的那条回复，read = 回复出完 → 换页（A-6）
  function buildTurn(events, now, opts) {
    const trigger = opts && opts.trigger;
    const idleMs = (opts && typeof opts.idleMs === 'number' && opts.idleMs > 0) ? opts.idleMs : CONFIG.AWAY_MS;
    const ev = events.filter((e) => e.t <= now).sort((a, b) => a.t - b.t);
    const last = (type, before = now) => { for (let i = ev.length - 1; i >= 0; i--) if (ev[i].type === type && ev[i].t <= before) return ev[i]; return null; };
    const replyEnd = last('reply_end');
    const swipe = last('swipe');
    const swipedAfterReply = Boolean(swipe && replyEnd && swipe.t > replyEnd.t);
    let readStart, fixedReadEnd = null;
    if (trigger === 'swipe' && replyEnd) { readStart = replyEnd.t; if (swipedAfterReply) fixedReadEnd = swipe.t; }
    else readStart = swipedAfterReply ? swipe.t : (replyEnd ? replyEnd.t : null);
    const prevSend = replyEnd ? last('send', replyEnd.t - 1) : null;
    // 首字 / 思维链结束 必须落在“上一次发送 → 回复出完”之间，否则是更早一轮残留的事件，作废
    let streamStart = replyEnd ? last('stream_start', replyEnd.t) : null;
    if (streamStart && prevSend && streamStart.t < prevSend.t) streamStart = null;
    let reasoningEnd = replyEnd ? last('reasoning_end', replyEnd.t) : null;
    if (reasoningEnd && ((prevSend && reasoningEnd.t < prevSend.t) || (streamStart && reasoningEnd.t < streamStart.t))) reasoningEnd = null;
    // F-097：打字按 bout（一段没被删光的打字）切分——len 回到 0 表示删光了，这段作废。
    //   write 相位从最后一段没被删空的打字开始；发送时输入框是空的（全删了）就没有 write 相位，read 一直算到发送
    const types = ev.filter((e) => e.type === 'type' && (readStart == null || e.t > readStart));
    let boutStart = -1;
    for (let i = 0; i < types.length; i++) {
      if (types[i].len === 0) boutStart = -1;
      else if (boutStart < 0) boutStart = i;
    }
    const bout = boutStart < 0 ? [] : types.slice(boutStart);
    const typingStart = bout.length ? bout[0].t : null;
    let pauses = 0, deletes = 0, lastLen = null;
    for (let i = 0; i < bout.length; i++) {
      if (i > 0 && bout[i].t - bout[i - 1].t > CONFIG.PAUSE_MS) pauses++;
      if (lastLen != null && typeof bout[i].len === 'number' && bout[i].len < lastLen) deletes++;
      if (typeof bout[i].len === 'number') lastLen = bout[i].len;
    }
    // 离开（协议 v0.4 §6，2026-09-18 第二批）：覆盖整轮，从上一次发送开始；四种类型按 hidden > unfocused > offscreen > idle 取一种、区间不重叠
    //   hidden：页面不可见；unfocused：窗口失焦（runtime 用 document.hasFocus() 排除点进卡片小界面的情况）；
    //   offscreen：最新回复整条滚出可视范围（只在流式出字与读回复时判）；idle：一段时间没有任何操作（只从有内容可读时开始判）
    //   unfocused / offscreen 短于 5 秒不记；hidden 不设下限
    const readEnd = readStart == null ? null : (fixedReadEnd != null ? fixedReadEnd : (typingStart != null ? typingStart : now));
    const spanFrom = prevSend ? prevSend.t : (readStart != null ? readStart : (typingStart != null ? typingStart : now - CONFIG.SERIES_MAX_MS));
    const raw = [];
    const pushToggle = (onType, offType, from, to, kind, minMs) => {
      if (from == null || to == null || to <= from) return;
      let at = null;
      for (const e of ev) {
        if (e.t > to) break;
        if (e.type !== onType && e.type !== offType) continue;
        if (e.t <= from) { at = e.type === onType ? from : null; continue; }
        if (e.type === onType && at == null) at = e.t;
        else if (e.type === offType && at != null) { if (e.t - at >= minMs) raw.push([at, e.t, kind]); at = null; }
      }
      if (at != null && to - at >= minMs) raw.push([at, to, kind]);
    };
    pushToggle('hidden', 'visible', spanFrom, now, 'hidden', 0);
    pushToggle('blur', 'focus', spanFrom, now, 'unfocused', CONFIG.SHORT_AWAY_MS);
    // 翻看旧消息只在“有最新回复可看”时有意义：流式出字（首字起）与读回复
    const offFrom = streamStart ? streamStart.t : (replyEnd ? replyEnd.t : null);
    pushToggle('offscreen', 'onscreen', offFrom, readEnd, 'offscreen', CONFIG.SHORT_AWAY_MS);
    // 常识：还没有正文可读（等首字）时坐着不动不算离开；流式从首字、非流式从回复写完开始判 idle
    const idleFrom = streamStart ? streamStart.t : (replyEnd ? replyEnd.t : spanFrom);
    const marks = [idleFrom, ...ev.filter((e) => e.t >= idleFrom && e.t <= now && IDLE_BREAKERS.has(e.type)).map((e) => e.t), now].sort((a, b) => a - b);
    for (let i = 1; i < marks.length; i++) if (marks[i] - marks[i - 1] > idleMs) raw.push([marks[i - 1], marks[i], 'idle']);
    const merged = partitionAway(raw);
    return { now, trigger: trigger || null, prevSend: prevSend && prevSend.t, streamStart: streamStart && streamStart.t, reasoningEnd: reasoningEnd && reasoningEnd.t, replyEnd: replyEnd && replyEnd.t, readStart, readEnd, typingStart, pauses, deletes, typeCount: bout.length, lastLen, away: merged };
  }
  const DISCARDED_TRIGGERS = new Set(['swipe', 'regenerate']);

  // ---------- v0.3 §1.4 只减少输出的规则：峰值、HRV ----------
  const PEAK = { MIN_PHASE_MS: 10000, MIN_SAMPLES: 10, REF_MS: 10000, SMOOTH_HALF_MS: 2500, MIN_BPM: 5, NOISE_K: 2, RUN_N: 3, RUN_MS: 3000, MIN_COV: 70 };
  // picked：已剔除离开区间的相位样本（按时间排序）；noise：基线窗口的稳健标准差（没有时用相位前 10 秒的）
  // opts.floorBpm：腕式设备的绝对门槛下限（v0.3 §1.4-3，peakFloor() 算好传入，非腕式为 0）
  // opts.minPhaseMs：最短相位（v0.3 固定 10 秒；v0.4 §2.4 改 max(10s, 2×lag)，由调用方按是否 v04 算好传入）
  // → { value, at } 或 null。峰值是 5 秒居中中位数平滑后的值，须高于前 10 秒中位数 max(5 bpm, 2×noise, floorBpm)，且连续 ≥ 3 个样本、跨度 ≥ 3 秒
  function detectPeak(picked, from, netMs, noise, opts) {
    const floorBpm = (opts && Number.isFinite(opts.floorBpm)) ? opts.floorBpm : 0;
    const minPhaseMs = (opts && Number.isFinite(opts.minPhaseMs)) ? opts.minPhaseMs : PEAK.MIN_PHASE_MS;
    if (!picked || picked.length < PEAK.MIN_SAMPLES || netMs < minPhaseMs) return null;
    // 参照段从第一个在场的样本起算（v0.4 §6：回复写完时读者不在，回来之后才算开始读）
    const start = Math.max(from, picked[0].t);
    const head = picked.filter((x) => x.t < start + PEAK.REF_MS).map((x) => x.bpm);
    if (!head.length) return null;
    const ref = median(head);
    const nz = Number.isFinite(noise) ? noise : robustSd(head);
    if (!Number.isFinite(nz)) return null;
    const target = ref + Math.max(PEAK.MIN_BPM, PEAK.NOISE_K * nz, floorBpm);
    const sm = picked.map((x) => median(picked.filter((y) => Math.abs(y.t - x.t) <= PEAK.SMOOTH_HALF_MS).map((y) => y.bpm)));
    let best = null;
    for (let i = 0; i < picked.length;) {
      if (sm[i] < target) { i++; continue; }
      let j = i; while (j + 1 < picked.length && sm[j + 1] >= target) j++;
      if (j - i + 1 >= PEAK.RUN_N && picked[j].t - picked[i].t >= PEAK.RUN_MS) {
        for (let k = i; k <= j; k++) if (!best || sm[k] > best.value) best = { value: sm[k], at: picked[k].t };
      }
      i = j + 1;
    }
    return best ? { value: Math.round(best.value), at: best.at } : null;
  }
  const HRV_GATE = { MAX_LOSS: 0.05, MIN_MS: 30000, MIN_MS_SLOW: 60000 };
  // HRV：rr-loss（无 RR 的包）与被剔除的 RR 都 ≤ 5%；窗口 ≥ 30 秒，心率低于 60 时 ≥ 60 秒
  function gatedHrv(st, picked, from, to, netMs) {
    if (!st || st.rrDropout > HRV_GATE.MAX_LOSS) return null;
    const slow = st.mean < 60 || st.max < 60;
    if (netMs < (slow ? HRV_GATE.MIN_MS_SLOW : HRV_GATE.MIN_MS)) return null;
    const c = collectRR(picked, from - 1, to);
    if (!c.raw || 1 - c.kept / c.raw > HRV_GATE.MAX_LOSS) return null;
    return rmssd(c);
  }
  const SPARSE_MS = 30000;

  // ---------- v0.4 §5：执行器与相位的重叠（act 段、clean 行、基线卫生） ----------
  // 台账条目：{ id, source, act, outputs, from, to|null, frames: [[相对毫秒, 强度]], gain: [[时刻, 倍数]] }
  // 口径（§5.1-1）：算的是**生产者发出的东西**（帧表 × 读者调整），不是设备确认执行的时间。
  const RISKY_ORDER = ['Temperature', 'Estim', 'Spray'];
  // v0.4 §3-1：v0.3 的两个方法名已弃用，按登记表改写（v0.3 §1.5：quiet-median → rest，p20 → rolling-low）
  const V04_METHOD = { 'quiet-median': 'rest', p20: 'rolling-low' };
  const fmtAge = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); if (s < 60) return `${s}s`; const m = Math.round(s / 60); if (m < 60) return `${m}m`; const h = Math.round(m / 60); return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`; };
  // v0.4 §3：最近 3 轮内换过方法才提；从最近一轮往回找第一个方法不同的轮次（history 按时间顺序，最后一个是上一轮）
  // 历史轮可能是在草案开关关掉时记的（旧名 quiet-median / p20）：两边都先按登记表改写再比，块里也写新名
  function baselineChanged(history, currentMethod) {
    if (!currentMethod) return null;
    const recent = (history || []).slice(-3);
    for (let i = recent.length - 1; i >= 0; i--) {
      const h = recent[i];
      if (!h || !h.baselineMethod) continue;
      const old = V04_METHOD[h.baselineMethod] || h.baselineMethod;
      if (old !== currentMethod) return { method: old, turnsAgo: recent.length - i };
    }
    return null;
  }
  // v0.4 §3：baseline 行的行尾段（age 必须有；noise 有就写；changed 由 baselineChanged 给出）
  function baselineSegs(base, now, changed) {
    if (!base) return '';
    const segs = [];
    const lastT = Number.isFinite(base.lastT) ? base.lastT : (Number.isFinite(base.at) ? base.at : null);
    if (lastT != null) segs.push(`age ${fmtAge(now - lastT)}`);
    if (Number.isFinite(base.noise)) segs.push(`noise ±${Math.round(base.noise)}`);
    if (changed) segs.push(`changed from ${changed.method} ${changed.turnsAgo} turn${changed.turnsAgo === 1 ? '' : 's'} ago`);
    return segs.length ? ` | ${segs.join(' | ')}` : '';
  }
  const LAG_MS_DEFAULT = 6000;                       // §2 还没实现，先用腕式的经验滞后算 clean 的最短长度
  const CLEAN = { MIN_SEC: 10, MIN_RATIO: 0.3 };     // §5.2-3：干净秒 < max(10s, 2×lag) 或 < 相位 30% 就整行不写
  // 某条记录在 t 时刻发出的强度（帧是阶梯函数，乘上当时的读者调整）
  function actLevelAt(rec, t) {
    const end = rec.to == null ? Infinity : rec.to;
    if (t < rec.from || t >= end) return 0;
    let lv = 0;
    for (const [at, v] of rec.frames || []) { if (rec.from + at <= t) lv = v; else break; }
    let g = 1;
    for (const [gt, gv] of rec.gain || []) { if (gt <= t) g = gv; else break; }
    return Math.max(0, Math.min(1, lv * g));
  }
  // [a, b) 里按时间加权的平均强度（在所有断点上积分，不抽样）
  function actMeanIn(rec, a, b) {
    if (b <= a) return 0;
    const pts = new Set([a]);
    const add = (t) => { if (t > a && t < b) pts.add(t); };
    add(rec.from); if (rec.to != null) add(rec.to);
    for (const [at] of rec.frames || []) add(rec.from + at);
    for (const [gt] of rec.gain || []) add(gt);
    const xs = [...pts].sort((x, y) => x - y); xs.push(b);
    let sum = 0;
    for (let i = 0; i + 1 < xs.length; i++) sum += actLevelAt(rec, xs[i]) * (xs[i + 1] - xs[i]);
    return sum / (b - a);
  }
  // §5.1-3（2026-09-18 修订）：mean = 各路最大值在实际驱动时间上的积分 ÷ 驱动毫秒数。
  // 不按整秒平均：短动作跨秒时首尾两秒只占一部分，会把强度算低（写 0.8、8 秒会变成 71%）
  function actMeanMs(recs, a, b, ex) {
    const pts = new Set([a, b]);
    const add = (t) => { if (t > a && t < b) pts.add(t); };
    for (const r of recs) {
      add(r.from); if (r.to != null) add(r.to);
      for (const [at] of r.frames || []) add(r.from + at);
      for (const [gt] of r.gain || []) add(gt);
    }
    for (const [x, y] of ex) { add(x); add(y); }
    const xs = [...pts].sort((x, y) => x - y);
    let sum = 0, ms = 0;
    for (let i = 0; i + 1 < xs.length; i++) {
      if (inSpans(ex, xs[i])) continue;
      let lv = 0;
      for (const r of recs) lv = Math.max(lv, actLevelAt(r, xs[i]));
      if (lv > 0) { const dt = xs[i + 1] - xs[i]; sum += lv * dt; ms += dt; }
    }
    return ms ? sum / ms : 0;
  }
  // §5.1：把相位切成秒，任何一路非 0 的那一秒就计入（秒数）；强度见 actMeanMs
  // → { sec, mean, n, outputs, risky, seconds:Set(秒起点), phaseSec } 或 null（没有驱动）
  function actStats(log, from, to, away, printedSec) {
    if (!Array.isArray(log) || !log.length || to <= from) return null;
    const ex = excludedSpans(away);
    const recs = log.filter((r) => r && r.from < to && (r.to == null ? to : r.to) > from);
    const seconds = new Set();
    const hit = new Set();
    let phaseSec = 0;
    for (let s = from; s < to; s += 1000) {
      if (inSpans(ex, s)) continue;                  // 离开的秒本来就不进相位统计，也不算干净秒（§5.2-2）
      phaseSec++;
      const b = Math.min(s + 1000, to);
      let lv = 0;
      for (const r of recs) { const m = actMeanIn(r, s, b); if (m > 0) { hit.add(r); lv = Math.max(lv, m); } }
      if (lv > 0) seconds.add(s);
    }
    if (printedSec != null) phaseSec = printedSec;   // 分母必须与相位行写出来的时长一致（§5.2 的 sec N/M）
    if (!seconds.size) return { sec: 0, seconds, phaseSec, none: true };
    const keys = new Set(); const outputs = [];
    for (const r of hit) { keys.add(`${r.source}#${r.act}`); for (const o of r.outputs || []) if (!outputs.includes(o)) outputs.push(o); }
    return { sec: Math.min(seconds.size, phaseSec), mean: Math.max(1, Math.min(100, Math.round(100 * actMeanMs([...hit], from, to, ex)))),
      n: keys.size, outputs, risky: RISKY_ORDER.filter((o) => outputs.includes(o)), seconds, phaseSec };
  }
  const actSeg = (a) => (!a || a.none ? '' : ` | act ${a.sec}s, mean ${a.mean}%, ${a.n} ${a.n === 1 ? 'act' : 'acts'}${a.risky.length ? ` (${a.risky.join('/')})` : ''}`);
  const secStart = (from, t) => from + Math.floor((t - from) / 1000) * 1000;
  // §5.2：只统计没有驱动的那些秒。act 为空、干净秒太少时返回 null（整行省略）
  // floorBpm：腕式峰值门槛下限（v0.3 §1.4-3，composeContext 算好传入）；cleanStats 只在 v04 时调用，峰值最短相位固定用 v0.4 §2.4 的公式
  function cleanStats({ samples, from, to, away, act, noise, cadenceMs, phaseSec, lagMs, floorBpm }) {
    if (!act || act.none || !act.sec) return null;
    const ex = excludedSpans(away);
    const total = phaseSec != null ? phaseSec : act.phaseSec;
    const cleanSec = Math.max(0, total - act.sec);
    const lag = lagMs == null ? LAG_MS_DEFAULT : lagMs;
    const minSec = Math.max(CLEAN.MIN_SEC, 2 * Math.round(lag / 1000));
    if (cleanSec < minSec || cleanSec < CLEAN.MIN_RATIO * total) return null;
    const picked = inWin(samples, from, to).filter((s) => !inSpans(ex, s.t) && !act.seconds.has(secStart(from, s.t)));
    const st = stats(picked);
    if (!st) return null;
    const minPhaseMs = Math.max(PEAK.MIN_PHASE_MS, 2 * lag);
    // §5.2-4：峰值必须落在同一段连续的干净秒里 → 取最长的那一段来判
    let best = null, run = null;
    for (let s = from; s < to; s += 1000) {
      const skip = inSpans(ex, s) || act.seconds.has(s);
      if (skip) { run = null; continue; }
      if (!run) { run = { from: s, to: s + 1000 }; if (!best || run.to - run.from > best.to - best.from) best = run; }
      else { run.to = Math.min(s + 1000, to); if (run.to - run.from > best.to - best.from) best = run; }
    }
    let peak = null;
    if (best && best.to - best.from >= minPhaseMs) {
      const pk = detectPeak(picked.filter((s) => s.t >= best.from && s.t < best.to), best.from, best.to - best.from, noise, { floorBpm, minPhaseMs });
      if (pk) peak = { value: pk.value, at: pk.at, atSec: Math.round(netOffset(away, from, pk.at) / 1000) };
    }
    return { st, sec: cleanSec, phaseSec: total, peak, cov: coverage(st.n, 0, cleanSec * 1000, cadenceMs) };
  }
  function cleanLine(phase, c) {
    if (!c) return null;
    return `clean(${phase}): ${fmtRange(c.st)}${c.peak ? ` peak ${c.peak.value} @${c.peak.atSec}s` : ''} | sec ${c.sec}/${c.phaseSec}${covTxt(c.cov)}`;
  }
  // §5.5 的变量形状
  const actVar = (a) => (!a || a.none ? null : { sec: a.sec, mean: a.mean, n: a.n, outputs: a.outputs.slice() });
  const cleanVar = (c) => (!c ? null : { sec: c.sec, phaseSec: c.phaseSec, first: c.st.first, last: c.st.last, min: c.st.min, max: c.st.max,
    peak: c.peak ? c.peak.value : null, peakAt: c.peak ? c.peak.atSec : null, cov: c.cov });
  // §5.3：基线窗口排除驱动秒。返回合并后的驱动区间，调用方据此过滤样本
  const actSpans = (log) => mergeSpans((log || []).filter((r) => r && r.from != null).map((r) => [r.from, r.to == null ? Infinity : r.to, 'act']));

  // ---------- 每轮摘要（跨轮曲线与聊天变量用） ----------
  // 在发送时刻对刚结束的“读回复 / 写消息”做一份紧凑摘要；没有读回复相位时返回 null
  // peak：composeContext 里 detectPeak 判定过的读回复峰值（{ value, at } 或 null）。readPeak 只写判定过的值，没有就是 null（审查第 4 条：面板、history、块同一口径）
  function turnSummary({ samples, turn, baseline, peak }) {
    if (turn.readStart == null) return null;
    const readEnd = turn.readEnd != null ? turn.readEnd : (turn.typingStart != null ? turn.typingStart : turn.now);
    const ph = phaseStats(samples, turn.readStart, readEnd, turn.away);
    const rd = ph.st;
    if (!rd) return null;
    const sendSt = stats(inWin(samples, turn.now - 5000, turn.now));
    const discarded = DISCARDED_TRIGGERS.has(turn.trigger);
    const wr = !discarded && turn.typingStart != null ? phaseStats(samples, turn.typingStart, turn.now, turn.away) : null;
    return {
      t: turn.now, readStart: turn.readStart, readSec: Math.round(ph.netMs / 1000),
      readPeak: peak ? peak.value : null, readPeakT: peak ? peak.at : null, readMax: rd.max, readMean: rd.mean, readFirst: rd.first, readLast: rd.last,
      peakAtSec: peak ? Math.round(netOffset(turn.away, turn.readStart, peak.at) / 1000) : null,
      awaySec: Math.round(ph.awayMs / 1000),
      hrv: gatedHrv(rd, ph.samples, turn.readStart, readEnd, ph.netMs),
      writeSec: wr ? Math.round(wr.netMs / 1000) : 0,
      sendBpm: sendSt ? sendSt.last : null,
      baseline: baseline ? baseline.bpm : null,
      baselineMethod: baseline ? baseline.method : null,   // v0.4 §3：changed from 段靠这个跨轮比较
      genSec: turn.prevSend && turn.replyEnd ? Math.round((turn.replyEnd - turn.prevSend) / 1000) : null,
      replyChars: turn.replyMeta ? turn.replyMeta.chars : null,
    };
  }
  const fmtMS = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  // 跨轮曲线一行（spec: history），最多 8 轮，按时间顺序，最右是上一轮
  //   v04：加 read-peak-rel（§4）——每轮 read 的 peak 相对该轮（自己的）基线的百分比，个数与顺序和 read-peaks 一一对应；
  //   该轮的 read-peaks 是 · 的位置这里也是 ·；有 peak 但那一轮没有基线时也写 ·
  function historyLine(history, maxTurns, v04) {
    const h = (history || []).slice(-(maxTurns || 8));
    if (!h.length) return null;
    const peaks = h.map((x) => (x.readPeak != null ? x.readPeak : '·')).join(' ');
    const durs = h.map((x) => fmtMS(x.readSec)).join(' ');
    const hrvs = h.map((x) => (x.hrv != null ? x.hrv : '·')).join(' ');
    const rel = v04 ? ` | read-peak-rel ${h.map((x) => (x.readPeak != null && Number.isFinite(x.baseline) && x.baseline ? pctVsBase(x.readPeak, x.baseline) : '·')).join(' ')}` : '';
    return `history: read-peaks ${peaks} | read-dur ${durs} | hrv ${hrvs}${rel}`;
  }

  // ---------- 阅读进度估计（read-pos，协议 0.2 字段） ----------
  // 把 read 相位峰值时刻按阅读速度换算成“大约读到回复的哪里”。replyChars 为 0（或缺失）时没有分母，返回 null。
  function readPosition({ replyChars, paragraphOffsets, peakAtSec, cps }) {
    if (!replyChars) return null;
    const chars = Math.min(replyChars, Math.round(peakAtSec * cps));
    const pct = Math.round((chars / replyChars) * 100);
    const offsets = paragraphOffsets || [];
    let para = 0;
    for (let i = 0; i < offsets.length; i++) if (offsets[i] <= chars) para = i + 1;
    return { pct, chars, para, paraCount: offsets.length };
  }
  // 从最近历史轮次自校准阅读速度：取读时长在 20–600 秒且带 replyChars 的轮次，算 replyChars/readSec 的中位数。
  // 样本不足 CPS_CAL_MIN_TURNS 时退回 defaultCps（按正文 CJK 占比选的 6 或 20），标 source: 'est'；够了标 'cal'。
  // 与离开区间重叠的轮次（awaySec > 0）不进校准（A-1）；速度取整（B-2：read-pos 语法是 @\d+ cps）
  function estimateCps({ history, defaultCps }) {
    const rates = (history || [])
      .filter((h) => h && typeof h.replyChars === 'number' && h.replyChars > 0 && typeof h.readSec === 'number' && h.readSec >= 20 && h.readSec <= 600 && !(h.awaySec > 0))
      .map((h) => h.replyChars / h.readSec);
    if (rates.length >= CONFIG.CPS_CAL_MIN_TURNS) return { cps: Math.max(1, Math.round(median(rates))), source: 'cal' };
    return { cps: defaultCps, source: 'est' };
  }

  // ---------- 总线字符串校验与清洗（TBC v0.3 §4.4、§2.6；参考实现 spec/tools/sanitize.mjs） ----------
  const IDENT_RE = /^[a-z0-9][a-z0-9._:-]{0,31}$/;
  const KIND_RE = /^[a-z][a-z0-9_-]{0,31}$/;        // kind 同时是块里的行名
  const DEVICE_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
  const CADENCE_RE = /^\d+(?:ms|s)$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const DATE_SHORT_RE = /^\d{2}-\d{2}$/;
  const TRANSPORTS = ['ble', 'bridge', 'push', 'api', 'bus'];
  const TRIGGERS = ['normal', 'swipe', 'regenerate', 'continue', 'impersonate'];
  const BUS_ONLY_KINDS = new Set(['ppg']);   // 只在总线上流转，不进块（v0.3 §4）
  const isIdent = (s) => typeof s === 'string' && IDENT_RE.test(s);
  const isKindName = (s) => isIdent(s) && KIND_RE.test(s);
  function serialProblem(value) {
    const s = String(value == null ? '' : value);
    if (/[:_]/.test(s)) return 'raw-name';
    if (/\d{6,}/.test(s)) return 'digits';
    if (s.toLowerCase().split(/[.-]/).some((seg) => seg.length >= 6 && /^[0-9a-f]+$/.test(seg) && /\d/.test(seg))) return 'hex';
    return null;
  }
  const isDeviceName = (s) => typeof s === 'string' && s.length > 0 && s.length <= 32 && DEVICE_RE.test(s) && !serialProblem(s);
  const isDateText = (s) => typeof s === 'string' && (DATE_RE.test(s) || DATE_SHORT_RE.test(s));
  // 自由文本：换行与 | 换成空格，删掉 < > 与控制字符，合并空白，按字符数截断
  function sanitizeText(s, max) {
    let t = String(s == null ? '' : s).replace(/[\r\n\u2028\u2029|]+/g, ' ').replace(/[<>]/g, '').replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim();
    const chars = Array.from(t);
    if (max && chars.length > max) t = chars.slice(0, max).join('').trimEnd();
    return t;
  }
  const attrSafe = (s) => typeof s === 'string' && !/["<>\x00-\x1f\x7f\u2028\u2029]/.test(s);

  // ---------- 注入块：Tavern Bio-Context（协议仓库 ../spec） ----------
  // 固定英文键，每行一个字段，缺失写 n/a；块内不解释。
  const SPEC_VERSION = '0.3';
  const SPEC_DRAFT = '0.4';   // 草案，默认不输出（settings 里的开关打开才用）
  const SOURCE = 'heartlink';
  const MODES = ['author', 'character', 'aware'];
  // TBC 0.3：块与变量里写新名字；内部名 author / character / aware
  const WIRE_MODE = { author: 'backstage', character: 'in-story', aware: 'device-aware' };
  // bio 变量（schema bio-variable）：0.x 期间 mode 只写旧值，新名写在 view；不得出现内部名 aware（B-5）
  const LEGACY_MODE = { author: 'author', character: 'character', aware: 'character' };
  const SCOPE_LINE = 'scope: gen, read = previous reply; write, send = this message';
  // v0.3 §1.3：scope 行按 trigger 取登记过的固定句
  const SCOPE_DISCARDED = 'scope: gen, read = discarded reply (not in context); no new message';
  const SCOPE_IMPERSONATE = 'scope: gen, read = previous reply; no reader message yet';
  const NO_NEW_MESSAGE = 'n/a (no new message)';
  const IMPERSONATE_WRITE = 'n/a (impersonate)';
  const NOTE_LINE = 'note: observable record only; phase edges are page events; hr lags seconds; wrist motion lowers confidence';
  const fmtS = (ms) => `${Math.round(ms / 1000)}s`;
  // B-1：相位里没有样本时写 n/a (no samples)（语法：hr N→N […] 或 n/a (…)）
  const fmtRange = (st) => (st ? `hr ${st.first}→${st.last} [${st.min}–${st.max}]` : 'n/a (no samples)');
  const rrLoss = (st) => (st ? ` | rr-loss ${Math.round(st.rrDropout * 100)}%` : '');

  // { samples, events, activityLog?, now, mode: 'author'|'character'|'aware', baselineOverride?: {bpm, hrv}, history?: [turnSummary...],
  //   replyMeta?: {chars, paragraphOffsets, cjkRatio}, cpsOverride?: {cps, source} }
  // → { text, turn, baseline, summary }。activityLog 是跨聊天保留的活动记录，给自动基线用；缺省用 events
  // ---------- 0.8：其它信号种类与设备状态行（协议 device-interface-zh.md §2–§4；v0.1 读者忽略不认识的行） ----------
  function fmtVal(v) { return Number.isInteger(v) ? String(v) : (Math.round(v * 10) / 10).toString(); }
  function valueStats(arr) {
    if (!arr || !arr.length) return null;
    const vals = arr.map((s) => s.value); const max = Math.max(...vals);
    return { first: vals[0], last: vals[vals.length - 1], max, peakAt: arr[vals.indexOf(max)].t, n: vals.length };
  }
  // 一种非心率信号一行：`pressure(civet, 100ms): read 7.9→12.3 kPa peak 14.1 @41s | write 8.0→8.2`
  // B-7：kind / source / unit / cadence 都来自总线，不合规的 kind 整行不写，其余不合规的换成缺省
  function kindLine(kind, meta, turn, now) {
    if (!isKindName(kind) || BUS_ONLY_KINDS.has(kind)) return null;
    // v0.4 §5.6：读数来自执行器（玩具自带的压力 / 按键）时，单位不统一，只写相对变化
    if (meta && meta.toy) return toySensorLine(kind, meta, turn, now);
    const smp = ((meta && meta.samples) || []).filter((s) => s && Number.isFinite(s.value));
    const unit0 = meta && typeof meta.unit === 'string' ? meta.unit.toLowerCase() : null;
    const unit = isIdent(unit0) && unit0 !== 'raw' ? ` ${unit0}` : '';
    const source = meta && isIdent(meta.source) ? meta.source : 'unknown';
    const cadence = meta && typeof meta.cadence === 'string' && CADENCE_RE.test(meta.cadence) ? meta.cadence : null;
    const head = `${kind}(${source}${cadence ? `, ${cadence}` : ''}):`;
    const parts = [];
    if (turn.readStart) {
      const readEnd = turn.readEnd != null ? turn.readEnd : (turn.typingStart || now);
      const rd = valueStats(inWin(smp, turn.readStart, readEnd));
      if (rd) parts.push(`read ${fmtVal(rd.first)}→${fmtVal(rd.last)}${unit}${rd.max > rd.first ? ` peak ${fmtVal(rd.max)} @${Math.round((rd.peakAt - turn.readStart) / 1000)}s` : ''}`);
    }
    if (turn.typingStart != null) {
      const wr = valueStats(inWin(smp, turn.typingStart, now));
      if (wr) parts.push(`write ${fmtVal(wr.first)}→${fmtVal(wr.last)}${unit}`);
    }
    if (!parts.length) {
      const last = smp.length ? smp[smp.length - 1] : null;
      return `${head} ${last && now - last.t <= CONFIG.STALE_MS ? `now ${fmtVal(last.value)}${unit}` : 'n/a (no data in this turn)'}`;
    }
    return `${head} ${parts.join(' | ')}`;
  }
  // v0.4 §5.6：玩具上的传感器。括号里第一项是执行器 id，只写相对本相位开始的变化，不写物理单位，
  // 也不与心率合成任何指标——这些行说的是**设备那边发生的事**，不是读者的生理量。
  const rel = (v) => `${v >= 0 ? '+' : '-'}${fmtVal(Math.abs(v))}`;
  function toySensorLine(kind, meta, turn, now) {
    const smp = ((meta && meta.samples) || []).filter((s) => s && Number.isFinite(s.value));
    if (!smp.length) return null;
    const id = meta && isIdent(meta.id) ? meta.id : null;
    if (!id) return null;
    const cadence = meta && typeof meta.cadence === 'string' && CADENCE_RE.test(meta.cadence) ? meta.cadence : null;
    const head = `${kind}(${id}, ${kind === 'button' ? 'event' : (cadence || '1s')}):`;
    const spans = [];
    if (turn.readStart) spans.push(['read', turn.readStart, turn.readEnd != null ? turn.readEnd : (turn.typingStart || now)]);
    if (turn.typingStart != null) spans.push(['write', turn.typingStart, now]);
    const parts = [];
    for (const [name, from, to] of spans) {
      const w = inWin(smp, from, to);
      if (!w.length) continue;
      if (kind === 'button') {
        // 按下记 1、弹起记 0：只数按下；次数不是测量值，照 v0.3 §2.1 写 ×N
        const press = w.filter((x, i) => x.value >= 1 && (i === 0 || w[i - 1].value < 1));
        if (press.length) parts.push(`${name} @${Math.round((press[0].t - from) / 1000)}s ×${press.length}`);
        continue;
      }
      const base = w[0].value;
      const st = valueStats(w);
      const peak = name === 'read' && st.max > base ? ` peak ${rel(st.max - base)} @${Math.round((st.peakAt - from) / 1000)}s` : '';   // 与心率以外的信号行一样，峰值只给读回复
      parts.push(`${name} ${rel(0)}→${rel(st.last - base)}${peak}`);
    }
    return parts.length ? `${head} ${parts.join(' | ')}` : null;
  }

  // v0.3 §2.1 wear 行：本轮窗口里佩戴位报“没接触”的区间，标出落在哪个相位；最后一段是现在的状态。
  //   wear(polar-h10, event): off 21:10:03–21:10:15 (read) | on
  // 括号里是设备名（首行 device 属性同一个值，不合规时写 hr-sensor）。本轮没有这样的区间时不写
  function wearLine(offSpans, turn, now, meta) {
    if (!offSpans || !offSpans.length) return null;
    const from = turn.prevSend != null ? turn.prevSend : turn.readStart != null ? turn.readStart : turn.typingStart != null ? turn.typingStart : now - CONFIG.SERIES_MAX_MS;
    const spans = offSpans.filter(([a, b]) => b > from && a < now).slice(-4);
    if (!spans.length) return null;
    const phaseOf = (t) => {
      if (turn.typingStart != null && t >= turn.typingStart) return 'write';
      if (turn.readStart != null && t >= turn.readStart && (turn.readEnd == null || t < turn.readEnd)) return 'read';
      if (turn.prevSend != null && turn.replyEnd != null && t >= turn.prevSend && t < turn.replyEnd) return 'gen';
      return null;
    };
    const segs = spans.map(([a, b]) => { const x = Math.max(a, from); const ph = phaseOf(x); return `off ${fmtClock(x)}–${fmtClock(Math.min(b, now))}${ph ? ` (${ph})` : ''}`; });
    const off = spans[spans.length - 1][1] >= now - 2000;
    const name = meta && isDeviceName(String(meta.device || '')) ? meta.device : 'hr-sensor';
    return `wear(${name}, event): ${segs.join(' | ')} | ${off ? 'off' : 'on'}`;
  }

  // 执行器登记的状态行：单行、去掉多余空白、≤120 字符、不带标签
  function deviceLine(text) {
    if (text == null) return null;
    let t = sanitizeText(String(text));
    if (!t) return null;
    const chars = Array.from(t);
    if (chars.length > 120) t = chars.slice(0, 117).join('') + '...';
    return `device: ${t}`;
  }

  // ---------- v0.2：覆盖率、头部属性、prior / env 行 ----------
  function coverage(n, from, to, cadenceMs) {
    if (!cadenceMs || to <= from) return null;
    const expected = Math.max(1, Math.round((to - from) / cadenceMs));
    return Math.min(100, Math.round(100 * n / expected));
  }
  const covTxt = (c) => (c == null ? '' : ` | cov ${c}%`);
  // ---------- 悬浮窗折线：三点移动平均 + Catmull-Rom 转贝塞尔，避免尖角 ----------
  // values：数字或 null（缺数据）；返回 SVG path 的 d（缺口处断开）
  // ref：参考值（平静心率）。给了就把它算进纵轴范围，并在 sparkPath.refY 里给出它的纵坐标，方便画参考线
  function sparkPath(values, width, height, minSpan = 6, ref = null) {
    sparkPath.refY = null;
    const nums = values.filter((v) => v != null);
    if (nums.length < 2) return '';
    const smooth = values.map((v, i) => {
      if (v == null) return null;
      const win = [values[i - 1], v, values[i + 1]].filter((x) => x != null);
      return win.reduce((a, b) => a + b, 0) / win.length;
    });
    const sn = smooth.filter((v) => v != null);
    let lo = Math.min(...sn), hi = Math.max(...sn);
    if (Number.isFinite(ref)) { lo = Math.min(lo, ref); hi = Math.max(hi, ref); }
    const span = Math.max(hi - lo, minSpan);
    if (hi - lo < minSpan) lo -= (minSpan - (hi - lo)) / 2;   // 变化很小时居中，不贴底
    const pad = 1.5;
    if (Number.isFinite(ref)) sparkPath.refY = Math.round((height - pad - (ref - lo) / span * (height - pad * 2)) * 10) / 10;
    const xy = smooth.map((v, i) => (v == null ? null : [i * width / Math.max(values.length - 1, 1), height - pad - (v - lo) / span * (height - pad * 2)]));
    const r = (n) => Math.round(n * 10) / 10;
    let d = '';
    let run = [];
    const flush = () => {
      if (run.length === 1) d += `M${r(run[0][0])},${r(run[0][1])}`;
      for (let k = 0; k < run.length - 1; k++) {
        const p0 = run[k - 1] || run[k], p1 = run[k], p2 = run[k + 1], p3 = run[k + 2] || p2;
        if (k === 0) d += `M${r(p1[0])},${r(p1[1])}`;
        const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
        const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
        d += `C${r(c1[0])},${r(c1[1])} ${r(c2[0])},${r(c2[1])} ${r(p2[0])},${r(p2[1])}`;
      }
      run = [];
    };
    for (const p of xy) { if (p) run.push(p); else flush(); }
    flush();
    return d;
  }

  // ---------- TBC 0.3 §4.2 诊断：由运行层采集事实，这里只负责组装与判断 ----------
  function buildDiagnostics(f) {
    const problems = [];
    const add = (code, severity, message, hint) => problems.push({ code, severity, message, hint });
    if (!f.bluetooth && f.transport !== 'bridge' && f.transport !== 'bus') add('NO_BLUETOOTH', 'error', '这个浏览器不支持网页蓝牙', '用电脑或安卓上的 Chrome / Edge 打开酒馆；iPhone 和 Safari 暂不支持');
    if (f.bluetooth && f.secureContext === false) add('INSECURE_CONTEXT', 'error', '页面不是安全上下文，蓝牙不可用', '用 https 或 localhost 打开酒馆');
    const hasData = f.lastSampleAgeMs != null;
    if (!f.connected && !hasData) add('NO_DEVICE', 'warn', '没有连接健康设备', '点悬浮窗 → 健康设备 → 连接设备；手环 / 心率带要先打开心率广播');
    if ((f.connected || hasData) && f.lastSampleAgeMs != null && f.lastSampleAgeMs > staleThresholdMs(f.cadenceMs)) add('DEVICE_SILENT', 'warn', `已经 ${Math.round(f.lastSampleAgeMs / 1000)} 秒没有收到心率`, '检查设备是否戴好、离电脑是否太远、是否还在广播');
    if (f.rr === false) add('NO_RR', 'info', '这台设备不提供心跳间隔，没有 HRV', '不影响使用；需要 HRV 请换胸带或 WHOOP 等支持 RR 的设备');
    if (f.cadenceMs != null && f.cadenceMs >= 30000) add('SPARSE_SOURCE', 'info', '数据很稀疏（30 秒以上一个）', '部分相位会写 n/a，属于正常');
    if (f.mode === 'author') add('MODE_BACKSTAGE', 'info', '当前是幕后模式，角色不会提起你的身体状态', '想让角色察觉，在健康设备页把模式切到入戏');
    if (f.injectEnabled === false) add('INJECTION_DISABLED', 'warn', '注入被脚本暂停了，模型收不到设备数据', '刷新页面即恢复（暂停只给测试和实验用，面板里没有这个开关）');
    if (f.guideActive === false) add('GUIDE_INACTIVE', 'warn', '没有找到启用的读法世界书，模型可能看不懂设备数据', '刷新页面让 heartlink 自动安装；或在世界信息里把“heartlink·读法”设为全局');
    if (f.multiWindow) add('MULTI_WINDOW', 'warn', '这个聊天在别的窗口也开着，会互相覆盖', '只保留一个窗口');
    if (f.hostOk === false) add('HOST_UNSUPPORTED', 'error', '酒馆缺少注入所需的接口', '升级酒馆到 1.13 以上');
    if (f.badInput) add('BAD_INPUT', 'warn', `别的脚本往 heartlink 送了 ${f.badInput} 条不合规的数据，已拒收`, '导出诊断，联系发出数据的脚本作者');
    if (f.invalidBlocks) add('BLOCK_INVALID', 'warn', `有 ${f.invalidBlocks} 次注入块自检没通过，已改发最小块`, '导出诊断并反馈给 heartlink');
    if (f.guideConflict) add('GUIDE_CONFLICT', 'warn', '有旧版 heartlink 在改写读法世界书，请更新或停用旧版', `读法世界书被 ${f.guideConflict.by || '旧版'} 改回去过；检查别的标签页、酒馆助手脚本库和扩展列表里的 heartlink，都更新到 ${f.version}`);
    const device = String(f.deviceName || '').split(' ')[0].toLowerCase().replace(/[^a-z0-9.-]/g, '');
    return {
      implementation: SOURCE, version: f.version, spec: SPEC_VERSION, at: f.now,
      environment: { bluetooth: !!f.bluetooth, secure_context: f.secureContext !== false, host: f.host || 'sillytavern' },
      device: {
        connected: !!f.connected, name: device && !/\d{6,}/.test(device) ? device : null,
        transport: f.transport || null, cadence_ms: f.cadenceMs ?? null, rr: f.rr ?? null,
        last_sample_age_ms: f.lastSampleAgeMs ?? null, battery: f.battery ?? null,
      },
      mode: { value: WIRE_MODE[f.mode] || 'backstage', source: f.modeSource || 'default' },
      card: f.card || null,
      injection: { enabled: f.injectEnabled !== false, last_at: f.lastInjectAt ?? null, last_trigger: f.lastTrigger ?? null, background_skipped: f.backgroundSkipped ?? 0, invalid_blocks: f.invalidBlocks ?? 0 },
      interpretation: { guide_active: f.guideActive ?? null },
      problems,
    };
  }

  // TBC v0.3 §1.2 卡片声明：data.extensions.tbc = { mode_hint, perceiver }
  function normalizeMode(v) {
    const m = String(v == null ? '' : v).trim().toLowerCase();
    if (m === 'author' || m === 'backstage') return 'author';
    if (m === 'character' || m === 'in-story') return 'character';
    if (m === 'aware' || m === 'device-aware') return 'aware';
    return null;
  }
  function readCardHints(card) {
    const t = card && card.data && card.data.extensions && card.data.extensions.tbc;
    if (!t || typeof t !== 'object') return null;
    const raw = Array.isArray(t.perceiver) ? t.perceiver : (t.perceiver != null ? [t.perceiver] : []);
    const perceivers = raw.map((x) => String(x).replace(/["<>]/g, '').trim().slice(0, 24)).filter(Boolean).slice(0, 3);
    const mode = normalizeMode(t.mode_hint);
    if (!mode && !perceivers.length) return null;
    return { mode, perceivers };
  }
  // 首行属性：不合规的值整个属性不写（v0.3 §4.4 末行、§2.6）
  function headerAttrs(meta) {
    const a = [];
    if (!meta) return '';
    if (meta.device && isDeviceName(String(meta.device))) a.push(`device="${meta.device}"`);
    if (TRANSPORTS.includes(meta.transport)) a.push(`transport="${meta.transport}"`);
    if (typeof meta.cadence === 'string' && CADENCE_RE.test(meta.cadence)) a.push(`cadence="${meta.cadence}"`);
    if (typeof meta.rr === 'boolean') a.push(`rr="${meta.rr ? 'yes' : 'no'}"`);
    if (TRIGGERS.includes(meta.trigger)) a.push(`trigger="${meta.trigger}"`);
    if (meta.perceiver && meta.perceiver.length) {
      const names = meta.perceiver.map((x) => sanitizeText(String(x).replace(/["、]/g, ''), 24)).filter(Boolean).slice(0, 3);
      if (names.length) a.push(`perceiver="${names.join('、')}"`);
    }
    return a.length ? ' ' + a.join(' ') : '';
  }
  // 首行某个属性改值（没有就加在末尾）；值必须已经是合规的
  function setHeaderAttr(head, name, value) {
    const re = new RegExp(` ${name}="[^"]*"`);
    if (re.test(head)) return head.replace(re, ` ${name}="${value}"`);
    return head.replace(/>$/, ` ${name}="${value}">`);
  }
  // v0.3 §1.3：重放块。continue：首行改 trigger="continue" 并加 replay="continue"，scope 行换成重放句，其余原样；
  // group：只加 replay="group"；其余（工具调用递归）原样返回
  function replayBlock(text, { replay, composedAt } = {}) {
    const lines = String(text || '').split('\n');
    if (!/^<bio_context /.test(lines[0] || '')) return String(text || '');
    if (replay === 'continue') {
      lines[0] = setHeaderAttr(lines[0], 'trigger', 'continue');
      const sentIdx = lines.findIndex((l) => l.startsWith('sent: '));
      const clock = composedAt != null ? fmtClock(composedAt) : (sentIdx >= 0 ? lines[sentIdx].slice(6) : fmtClock(Date.now()));
      const scope = `scope: replay of block composed at ${clock}; continuing previous reply`;
      const scopeIdx = lines.findIndex((l) => l.startsWith('scope: '));
      if (scopeIdx >= 0) lines[scopeIdx] = scope; else lines.splice(sentIdx >= 0 ? sentIdx + 1 : 1, 0, scope);
    }
    if (replay === 'continue' || replay === 'group') lines[0] = setHeaderAttr(lines[0], 'replay', replay);
    return lines.join('\n');
  }
  // prior：非实时来源（官方 API / 健康桥）的日级先验，只写事实和日期
  function priorLine(prior) {
    if (!prior || typeof prior !== 'object') return null;
    const f = prior.fields || {};
    const parts = [];
    if (f.recovery != null) parts.push(`recovery ${f.recovery}`);
    if (f.hrv != null) parts.push(`hrv ${fmtVal(f.hrv)} ms`);
    if (f.rhr != null) parts.push(`rhr ${f.rhr} bpm`);
    if (f.sleepHours != null) parts.push(`sleep ${fmtVal(f.sleepHours)} h`);
    if (f.spo2 != null) parts.push(`spo2 ${fmtVal(f.spo2)}%`);
    if (f.skinTemp != null) parts.push(`skin ${fmtVal(f.skinTemp)}°C`);
    if (!parts.length) return null;
    // B-7：来源须是标识，日期须是 YYYY-MM-DD（或旧写法 MM-DD），否则整行不写
    const source = prior.source == null ? 'api' : prior.source;
    if (!isIdent(source)) return null;
    if (prior.date != null && !isDateText(prior.date)) return null;
    return `prior(${source}, ${prior.date || 'n/a'}): ${parts.join(' | ')}`;
  }
  // env：房间温湿度，只写最近值，不进相位统计
  function envLine(kinds, now) {
    if (!kinds) return null;
    const t = kinds.room_temperature, h = kinds.humidity;
    const last = (k) => (k && k.samples && k.samples.length ? k.samples[k.samples.length - 1] : null);
    const lt = last(t), lh = last(h);
    const fresh = (x) => x && now - x.t <= 10 * 60 * 1000;
    if (!fresh(lt) && !fresh(lh)) return null;
    const src0 = (t && t.source) || (h && h.source);
    const src = isIdent(src0) ? src0 : 'unknown';
    const cad0 = (t && t.cadence) || (h && h.cadence);
    const cad = typeof cad0 === 'string' && CADENCE_RE.test(cad0) ? cad0 : null;
    const parts = [];
    if (fresh(lt) && Number.isFinite(lt.value)) parts.push(`${fmtVal(lt.value)}°C`);
    if (fresh(lh) && Number.isFinite(lh.value)) parts.push(`${fmtVal(lh.value)}% rh`);
    if (!parts.length) return null;
    return `env(${src}${cad ? `, ${cad}` : ''}): ${parts.join(' ')}`;
  }
  const ENV_KINDS = new Set(['room_temperature', 'humidity']);

  // baseline：调用方同一时刻已算好的 sessionBaseline 结果（可为 null）；undefined 时这里自己算
  // meta.trigger 决定 scope 行与相位规则（v0.3 §1.3）：swipe / regenerate 没有新消息；impersonate 读者还没写；continue 转成重放块
  // offContact：佩戴位报“没接触”的区间 [[from, to], …]（运行层记的）；样本上带 contact:false 的也会并进来，并从统计里去掉
  // deviceNow：现在连着的设备（原始名），手动基线换了设备时降级；lagMs：按设备类型的滞后（v0.4 §2.1），目前只给 clean 行的最短长度用
  // ---------- 门槛自动学（设置方案 §3；协议 v0.4 §12 gates 行） ----------
  //   只学“行为时长”，不用心率推门槛。三个门槛：idle（多久没动算离开）、too-long（读多久算太久，按预计阅读时长的倍数）、pause（打字停顿，暂不进界面）。
  //   范围与来源写法照校验器：idle 60–300s、too-long 180–1800s、pause 3–20s；来源 est（缺省未学）/ cal n=N（学到）/ user（手动）。
  const GATE_MS = { idle: [60000, 300000], tooLong: [180000, 1800000], pause: [3000, 20000] };
  const TOOLONG_MULT = { def: 3, min: 2, max: 6 };
  const GATES_MIN_TURNS = 5;   // 不足这么多“干净轮”一律用缺省值（est），避免刚开始乱跳
  const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // 从最近若干“干净轮”学门槛。turns: [{ gapP90, readSec, chars, cps, pauseMed }]（干净 = 普通发送、读回复没切走没失焦没标 too-long）
  function learnGates(turns) {
    const t = (turns || []).filter(Boolean);
    const n = t.length;
    const idle = { source: 'est', ms: CONFIG.AWAY_MS };
    const tooLong = { source: 'est', mult: TOOLONG_MULT.def };
    const pause = { source: 'est', ms: CONFIG.PAUSE_MS };
    if (n >= GATES_MIN_TURNS) {
      const gaps = t.map((x) => x.gapP90).filter((x) => x > 0);
      if (gaps.length) { idle.ms = clampN(Math.round(1.5 * percentile(gaps, 0.9)), GATE_MS.idle[0], GATE_MS.idle[1]); idle.source = 'cal'; idle.n = n; }
      const ratios = t.map((x) => (x.readSec && x.chars && x.cps) ? x.readSec / (x.chars / x.cps) : 0).filter((x) => x > 0);
      if (ratios.length) { tooLong.mult = clampN(1.5 * percentile(ratios, 0.9), TOOLONG_MULT.min, TOOLONG_MULT.max); tooLong.source = 'cal'; tooLong.n = n; }
      const pms = t.map((x) => x.pauseMed).filter((x) => x > 0);
      if (pms.length) { pause.ms = clampN(Math.round(3 * median(pms)), GATE_MS.pause[0], GATE_MS.pause[1]); pause.source = 'cal'; pause.n = n; }
    }
    return { idle, tooLong, pause };
  }
  // 解析出“这条回复实际用的”门槛值（§3.2：idle 与预计阅读×0.25 取大；too-long = 预计阅读×倍数）。gates: { learned, manual, frozen }
  function resolveGates(gates, { replyChars, cps }) {
    const learned = (gates && gates.learned) || {};
    const manual = (gates && gates.manual) || {};
    const predictMs = (replyChars && cps) ? (replyChars / cps) * 1000 : null;
    let idleMs, idleSrc, idleN;
    if (manual.idleMs != null) { idleMs = clampN(manual.idleMs, GATE_MS.idle[0], GATE_MS.idle[1]); idleSrc = 'user'; }
    else if (learned.idle && learned.idle.source === 'cal') { idleMs = learned.idle.ms; idleSrc = 'cal'; idleN = learned.idle.n; }
    else { idleMs = CONFIG.AWAY_MS; idleSrc = 'est'; }
    const idleUsed = predictMs != null ? clampN(Math.max(idleMs, predictMs * 0.25), GATE_MS.idle[0], GATE_MS.idle[1]) : idleMs;
    let mult, tlSrc, tlN;
    if (manual.tooLongMult != null) { mult = clampN(manual.tooLongMult, TOOLONG_MULT.min, TOOLONG_MULT.max); tlSrc = 'user'; }
    else if (learned.tooLong && learned.tooLong.source === 'cal') { mult = learned.tooLong.mult; tlSrc = 'cal'; tlN = learned.tooLong.n; }
    else { mult = TOOLONG_MULT.def; tlSrc = 'est'; }
    const tooLongMs = predictMs != null ? clampN(predictMs * mult, GATE_MS.tooLong[0], GATE_MS.tooLong[1]) : CONFIG.READ_SUSPICIOUS_MS;
    return { idleMs: Math.round(idleUsed), idleSrc, idleN, tooLongMs: Math.round(tooLongMs), tlSrc, tlN, frozen: !!(gates && gates.frozen) };
  }
  const gateSrcTxt = (src, n) => (src === 'cal' ? `cal n=${n}` : src);
  // gates 行：只写学到（cal）或手动（user）的门槛，缺省 est 不写；都没有就不出这行（§3.8）
  function gatesLine(r) {
    if (!r) return null;
    const segs = [];
    if (r.idleSrc === 'cal' || r.idleSrc === 'user') segs.push(`idle ${Math.round(r.idleMs / 1000)}s (${gateSrcTxt(r.idleSrc, r.idleN)})`);
    if (r.tlSrc === 'cal' || r.tlSrc === 'user') segs.push(`too-long ${fmtMS(Math.round(r.tooLongMs / 1000))} (${gateSrcTxt(r.tlSrc, r.tlN)})`);
    return segs.length ? `gates: ${segs.join(' | ')}` : null;
  }

  // 从一轮里抽“干净轮”的学习记录（§3.10：只存几个数，不存事件原文、不存心率）。
  //   干净 = 读回复期间没有 hidden / unfocused / offscreen（idle 允许），也没被标 too-long（由调用处补判）。
  //   gapP90：读回复期间相邻两次操作的间隔的第 90 百分位；pauseMed：打字停顿的中位数。
  function rhythmRecord(turn, events, { replyChars, cps }) {
    if (!turn || turn.readStart == null || turn.readEnd == null) return { clean: false };
    const dirty = (turn.away || []).some((a) => (a[2] === 'hidden' || a[2] === 'unfocused' || a[2] === 'offscreen') && a[1] > turn.readStart && a[0] < turn.readEnd);
    if (dirty) return { clean: false };
    const ev = (events || []).filter((e) => e && e.t >= turn.readStart && e.t <= turn.readEnd && (e.type === 'activity' || e.type === 'type' || e.type === 'scroll' || IDLE_BREAKERS.has(e.type))).map((e) => e.t).sort((a, b) => a - b);
    const marks = [turn.readStart, ...ev, turn.readEnd];
    const gaps = []; for (let i = 1; i < marks.length; i++) gaps.push(marks[i] - marks[i - 1]);
    const types = (events || []).filter((e) => e && e.type === 'type' && turn.typingStart != null && e.t >= turn.typingStart).map((e) => e.t).sort((a, b) => a - b);
    const pgaps = []; for (let i = 1; i < types.length; i++) pgaps.push(types[i] - types[i - 1]);
    return {
      clean: true,
      gapP90: gaps.length ? percentile(gaps, 0.9) : 0,
      readSec: Math.round((turn.readEnd - turn.readStart) / 1000),
      chars: replyChars || 0, cps: cps || 0,
      pauseMed: pgaps.length ? median(pgaps) : 0,
    };
  }

  // ---------- v0.4 §2：心率滞后 lag、carryover、tail-max ----------
  // 首行 lag 的有效值（整数秒，1–30）：显式传入优先，否则按设备类型的经验缺省（§2.1：胸带 4s，腕式/未知 6s）
  function lagSecFor(lagMs, wearClass) {
    const ms = Number.isFinite(lagMs) ? lagMs : (LAG_MS_BY_CLASS[wearClass] || LAG_MS_DEFAULT);
    return Math.max(1, Math.min(30, Math.round(ms / 1000)));
  }
  // peak 段文本：@Ns < lag 时必须带 carryover，≥ lag 时不得带（§2.2）。lagSec 为 null（非 v0.4）时不判 carryover
  function peakSegTxt(pk, atSec, lagSec) {
    if (!pk) return '';
    const carry = lagSec != null && atSec < lagSec ? ' carryover' : '';
    return ` peak ${pk.value} @${atSec}s${carry}`;
  }
  // tail-max（§2.3）：相位结束后 lag 秒（在场秒）内，用与 peak 相同的 5 秒居中中位数平滑算出的最大值；
  //   不要求 peak 的“连续 ≥3 个样本”条件（窗口太短，经验值）；只在高于本相位 peak 时写；只用于 gen / read（write 不传 peakValue 或调用方跳过）
  function tailMaxSeg(samples, to, lagMs, away, peakValue) {
    if (!peakValue || !(lagMs > 0)) return '';
    const ex = excludedSpans(away);
    const cand = (samples || []).filter((s) => s.t >= to && !inSpans(ex, s.t) && netOffset(away, to, s.t) <= lagMs);
    if (!cand.length) return '';
    let best = null;
    for (const x of cand) {
      const win = cand.filter((y) => Math.abs(y.t - x.t) <= PEAK.SMOOTH_HALF_MS).map((y) => y.bpm);
      const sm = median(win);
      if (!best || sm > best.value) best = { value: sm, at: x.t };
    }
    const val = Math.round(best.value);
    if (val <= peakValue) return '';
    const lagSec = Math.round(lagMs / 1000);
    const atSec = Math.max(1, Math.min(lagSec, Math.round(netOffset(away, to, best.at) / 1000)));
    return ` | tail-max ${val} @+${atSec}s`;
  }

  // ---------- v0.4 §4：带定义的派生事实（mean / above / away 段） ----------
  const ABOVE_THRESHOLD_PCT = 20;   // above 段缺省阈值（经验值，spec §4.1）
  // 相对基线的百分比文本：round(|x-base|/base*100) 带符号，0 写 +0%（与 send 行同一写法，§4 规则 2）
  function pctVsBase(value, baseBpm) {
    const diff = value - baseBpm;
    return `${diff < 0 ? '-' : '+'}${Math.round(Math.abs(diff) / baseBpm * 100)}%`;
  }
  function meanSeg(st, baseBpm) {
    if (!st || !Number.isFinite(baseBpm) || !baseBpm) return '';
    return ` | mean ${st.mean} (${pctVsBase(st.mean, baseBpm)})`;
  }
  // above：picked = 该行统计用的同一批样本（未平滑）；累计 0 秒时整段省略（§4 规则 3）
  function aboveSeg(picked, baseBpm, cadenceMs, thresholdPct) {
    if (!picked || !picked.length || !Number.isFinite(baseBpm) || !baseBpm) return '';
    const thr = baseBpm * (1 + thresholdPct / 100);
    const n = picked.filter((s) => s.bpm > thr).length;
    if (!n) return '';
    const sec = Math.round(n * (Number.isFinite(cadenceMs) ? cadenceMs : 1000) / 1000);
    return sec ? ` | above +${thresholdPct}% ${sec}s` : '';
  }
  // away 段（§4 规则 5）：相位主体是在场秒，wallMs − netMs 就是被剔除（hidden / unfocused）的时长
  function awaySeg(wallMs, netMs) {
    const sec = Math.round(Math.max(0, wallMs - netMs) / 1000);
    return sec ? ` | away ${sec}s` : '';
  }

  // ---------- v0.4 §1.2：stream(...) 行 ----------
  //   streamMarks：runtime 在每个流式片段到达时记的 [{t, chars}]（累计正文字数，按到达时刻升序）；
  //   只在 turn.streamStart 存在（首行 stream="yes"）时调用；replyMeta.chars 缺失时返回 null（body 没有分母）。
  //   已知缺口（报告里注明）：stream 行本可以带 rr-loss / hrv / act / flag 段（spec §1.2“其余段”），这里只实现 pos / cov，
  //   理由：act 已经在相位行里给出、hrv 在流式短窗口里几乎不可能通过质量门槛，为控制范围先不做，读者仍能按 §1.2 兼容规则忽略。
  function streamLine({ turn, samples, base, lagMs, floorBpm, minPhaseMs, cadenceMs, sparse, replyMeta, streamMarks, discarded }) {
    const bodyStart = turn.reasoningEnd || turn.streamStart;
    if (!bodyStart || !turn.replyEnd || !replyMeta || !replyMeta.chars) return null;
    const waitMs = bodyStart - turn.prevSend;
    const bodyMs = turn.replyEnd - bodyStart;
    const bph = phaseStats(samples, bodyStart, turn.replyEnd, turn.away);
    const st = bph.st;
    const cov = st ? coverage(st.n, 0, bph.netMs, cadenceMs) : null;
    const pk = st && !sparse && !(cov != null && cov < PEAK.MIN_COV) ? detectPeak(bph.samples, bodyStart, bph.netMs, base && base.noise, { floorBpm, minPhaseMs }) : null;
    const lagSec = Math.round(lagMs / 1000);
    const peakAtSec = pk ? Math.round(netOffset(turn.away, bodyStart, pk.at) / 1000) : null;
    let posTxt = '';
    // pos：peakAt − lag 落在 wait 里（即 carryover）时不得输出；换页/重新生成时也不得输出（§1.2 规则 2、6）
    if (pk && !discarded && peakAtSec >= lagSec && Array.isArray(streamMarks) && streamMarks.length) {
      const target = pk.at - lagMs;
      let chosen = null;
      for (const mk of streamMarks) { if (mk.t <= target) chosen = mk; else break; }
      if (chosen) {
        const chars = Math.max(0, Math.min(replyMeta.chars, Math.round(chosen.chars)));
        const offsets = replyMeta.paragraphOffsets || [];
        let para = 0;
        for (let i = 0; i < offsets.length; i++) if (offsets[i] <= chars) para = i + 1;
        posTxt = ` | pos ~${chars}/${replyMeta.chars} chars, para ${para}/${offsets.length}`;
      }
    }
    const parts = [];
    if (turn.streamStart) parts.push(`ttft ${fmtS(turn.streamStart - turn.prevSend)}`);
    if (turn.reasoningEnd && turn.streamStart) parts.push(`reasoning ${fmtS(turn.reasoningEnd - turn.streamStart)}`);
    const waitTxt = `wait ${fmtS(waitMs)}${parts.length ? ` (${parts.join(', ')})` : ''}`;
    return `stream(lag ${lagSec}s): ${waitTxt} | body ${fmtS(bodyMs)}, ${replyMeta.chars} chars | ${fmtRange(st)}${peakSegTxt(pk, peakAtSec, lagSec)}${posTxt}${covTxt(cov)}`;
  }

  function composeContext({ samples: allSamples, events, activityLog, now, mode, baselineOverride, history, replyMeta, cpsOverride, kinds, deviceLines, extraLines, meta, prior, baseline, actLog, v04, offContact, deviceNow, lagMs, gates, wearClass, streamMarks }) {
    let readTooLong = false;
    let readPos = null;
    const flagged = (allSamples || []).some((s) => s && s.contact === false);
    const samples = flagged ? allSamples.filter((s) => s.contact !== false) : (allSamples || []);
    const offSpans = mergeSpans([...(offContact || []).filter((x) => Array.isArray(x) && x[1] > x[0]).map((x) => [x[0], x[1]]), ...(flagged ? contactSpans(allSamples) : [])]);
    const offSeg = (from, to) => { const ms = overlapMs(offSpans, from, to); return ms >= 1000 ? ` | off-wrist ${fmtMS(Math.round(ms / 1000))}` : ''; };
    // v0.4 §5：开关打开且拿到驱动台账时才输出 act / clean / 基线卫生（草案期间缺省关）
    const acts = v04 && Array.isArray(actLog) && actLog.length ? actLog : null;
    const phaseVars = {};
    const cleanLines = [];   // §5.2：clean 是扩展区（L1）的行，统一放到 send 之后，不跟在相位行后面
    const cadenceMs = meta && meta.cadenceMs ? meta.cadenceMs : null;
    const trigger = meta && TRIGGERS.includes(meta.trigger) ? meta.trigger : 'normal';
    const discarded = DISCARDED_TRIGGERS.has(trigger);
    const sparse = cadenceMs != null && cadenceMs >= SPARSE_MS;   // v0.3 §2.8：稀疏来源不输出 peak / hrv / series / read-pos
    // 门槛（§3.2）：先按回复字数与阅读速度解析出这条回复实际用的 idle / too-long；idle 送进 buildTurn 判离开
    const cjkEarly = replyMeta && typeof replyMeta.cjkRatio === 'number' && replyMeta.cjkRatio >= 0.3;
    const cpsForGates = (cpsOverride && typeof cpsOverride.cps === 'number' && cpsOverride.cps > 0) ? cpsOverride.cps : (cjkEarly ? CONFIG.READ_CPS_CJK : CONFIG.READ_CPS_LATIN);
    const rGates = resolveGates(gates, { replyChars: replyMeta && replyMeta.chars, cps: cpsForGates });
    const turn = buildTurn(events, now, { trigger, idleMs: rGates.idleMs });
    if (replyMeta) turn.replyMeta = replyMeta;
    let readPeak = null;
    // 手动基线（含静坐记下的）超过 24 小时、换了设备或不知道何时记的：降到会话自动基线，并写 warn（v0.3 §1.5）
    const stale = baselineOverride ? manualBaselineStale(baselineOverride, now, deviceNow, { requireDeviceId: !!v04 }) : null;
    const useManual = baselineOverride && !stale;
    let base = useManual ? { bpm: baselineOverride.bpm, hrv: baselineOverride.hrv || null, method: 'manual', n: baselineOverride.n || 0, at: baselineOverride.at, device: baselineOverride.device, deviceId: manualDeviceId(baselineOverride), noise: baselineOverride.noise }
      : (baseline !== undefined && !baselineOverride) ? baseline : sessionBaseline(samples, activityLog || events, now);
    // v0.4 §5.3 基线卫生：会话内算出的基线，窗口里不得含有执行器在动的秒；样本不够就降级并写明
    let baseWarn = null;
    if (stale) baseWarn = base ? `warn: baseline degraded to ${v04 ? (V04_METHOD[base.method] || base.method) : base.method} (${STALE_WHY[stale]})` : `warn: manual baseline not used (${STALE_WHY[stale]})`;
    if (acts && !useManual) {
      const spans = actSpans(acts);
      const nb = sessionBaseline(samples.filter((s) => !inSpans(spans, s.t)), activityLog || events, now);
      if (!nb) { baseWarn = 'warn: baseline n/a (actuated seconds excluded)'; base = null; }
      else { if (base && nb.method !== base.method) baseWarn = `warn: baseline degraded to ${nb.method} (actuated seconds excluded)`; base = nb; }
    }
    // v0.3 §1.5：会话内算不出基线时退到日级 prior-rhr；只在日期是完整 YYYY-MM-DD 时用（age 必须能算，MM-DD legacy 写法没有年份）
    if (!base && prior && prior.fields && Number.isFinite(prior.fields.rhr) && typeof prior.date === 'string' && DATE_RE.test(prior.date)) {
      base = { bpm: Math.round(prior.fields.rhr), method: 'prior-rhr', n: null, hrv: null, noise: null, lastT: Date.parse(`${prior.date}T12:00:00Z`) };
      if (baseWarn === 'warn: baseline n/a (actuated seconds excluded)') baseWarn = 'warn: baseline degraded to prior-rhr (actuated seconds excluded)';
    }
    // v0.4 §3-4：age 超过 60 分钟就该提醒——不覆盖已有的 warn（降级本身已经说明问题）
    if (v04 && base && !baseWarn) {
      const lastT = Number.isFinite(base.lastT) ? base.lastT : base.at;
      if (Number.isFinite(lastT) && now - lastT > 3600000) baseWarn = 'warn: baseline may be outdated';
    }
    // 峰值门槛（v0.3 §1.4-3 腕式下限）与最短相位（v0.4 §2.4 max(10s, 2×lag)）：同一把尺子给 read 峰值和 clean 峰值用
    const floorBpm = peakFloor(wearClass, base && base.bpm);
    // v0.4 §2.1：首行 lag（整数秒，1–30）；lagMsEff 给 minPhaseMs / carryover / tail-max / clean / stream 用
    const lagMsEff = v04 ? (Number.isFinite(lagMs) ? lagMs : (LAG_MS_BY_CLASS[wearClass] || LAG_MS_DEFAULT)) : null;
    const lagSec = v04 ? lagSecFor(lagMs, wearClass) : null;
    const minPhaseMs = v04 ? Math.max(PEAK.MIN_PHASE_MS, 2 * lagMsEff) : PEAK.MIN_PHASE_MS;
    const m = MODES.includes(mode) ? mode : 'author';
    // v0.4 §1.1：本轮有被读的回复时应该写 stream="yes|no"；§2.1：v0.4 块应该总是写 lag
    const hasReplyForStream = Boolean(turn.prevSend && turn.replyEnd);
    const streamAttr = v04 && hasReplyForStream ? ` stream="${turn.streamStart ? 'yes' : 'no'}"` : '';
    const lagAttr = v04 && lagSec != null ? ` lag="${lagSec}s"` : '';
    // v0.3 §1.1：0.x 期间 mode 只写旧值（author / character），视角写在 view
    const header = `<bio_context v="${v04 ? SPEC_DRAFT : SPEC_VERSION}" mode="${LEGACY_MODE[m]}" view="${WIRE_MODE[m]}" source="${SOURCE}"${headerAttrs(meta)}${streamAttr}${lagAttr}>`;
    const L = [header];
    L.push(`sent: ${fmtClock(now)}`);
    // TBC 0.3 §1.3：相位归属，防止模型把上一轮读回复的反应安到新消息上
    L.push(discarded ? SCOPE_DISCARDED : trigger === 'impersonate' ? SCOPE_IMPERSONATE : SCOPE_LINE);
    // §3-1：弃用的方法名改写（manual 缺设定日期与设备的情形已在上面的 stale 里降级）
    if (v04 && base) base = Object.assign({}, base, { method: V04_METHOD[base.method] || base.method });
    // history 此时还是"这轮之前"的历史（本轮摘要要到 composeContext 返回之后才会被调用方 push 进去），比较不会把自己算进去
    const baselineChange = v04 && base ? baselineChanged(history, base.method) : null;
    const manualInfo = v04 && base && base.method === 'manual' ? `, set ${new Date(base.at).toISOString().slice(0, 10)}, ${base.deviceId}` : '';
    L.push(base ? `baseline: ${base.bpm} bpm (${base.method}${base.n ? `, n=${base.n}` : ''}${manualInfo}${base.hrv ? `; hrv ${base.hrv} ms` : ''})${v04 ? baselineSegs(base, now, baselineChange) : ''}` : `baseline: n/a (${baseWarn && baseWarn.includes('actuated') ? 'actuated seconds excluded' : 'session too short'})`);
    // warn 行只能在 note 之后（v0.3 §2），先记下，最后再写
    const pl = priorLine(prior); if (pl) L.push(pl);
    L.push(historyLine(history, 8, v04) || 'history: n/a');

    if (turn.prevSend && turn.replyEnd) {
      // v0.4 §6（2026-09-18 定，口径不随块版本变）：gen 主体的时长改为在场秒，与 read / write 统一；
      //   括号里的 ttft / reasoning / body 仍是页面事件之间的墙钟分项，不扣离开
      const genWallMs = turn.replyEnd - turn.prevSend;
      const genPh = phaseStats(samples, turn.prevSend, turn.replyEnd, turn.away);
      const gen = genPh.st;
      const parts = [];
      if (turn.streamStart) parts.push(`ttft ${fmtS(turn.streamStart - turn.prevSend)}`);
      if (turn.reasoningEnd && turn.streamStart) parts.push(`reasoning ${fmtS(turn.reasoningEnd - turn.streamStart)}`);
      // body：有思维链结束时是它到出完；没有思维链但确实在流式出字时，body = 首字到出完（按 v04 实现方案“无思维链时补 body”）
      if (turn.reasoningEnd) parts.push(`body ${fmtS(turn.replyEnd - turn.reasoningEnd)}`);
      else if (turn.streamStart) parts.push(`body ${fmtS(turn.replyEnd - turn.streamStart)}`);
      // cov 分母改用在场秒（与 read / write 一致），呼应主体时长也是在场秒（§6）
      const genCov = gen ? coverage(gen.n, 0, genPh.netMs, cadenceMs) : null;
      const genPk = v04 && gen && !sparse && !(genCov != null && genCov < PEAK.MIN_COV) ? detectPeak(genPh.samples, turn.prevSend, genPh.netMs, base && base.noise, { floorBpm, minPhaseMs }) : null;
      const genPeakAtSec = genPk ? Math.round(netOffset(turn.away, turn.prevSend, genPk.at) / 1000) : null;
      const genAct = acts ? actStats(acts, turn.prevSend, turn.replyEnd, turn.away, Math.round(genPh.netMs / 1000)) : null;
      const genMeanTxt = v04 ? meanSeg(gen, base && base.bpm) : '';
      const genAboveTxt = v04 ? aboveSeg(genPh.samples, base && base.bpm, cadenceMs, ABOVE_THRESHOLD_PCT) : '';
      const genAwayTxt = v04 ? awaySeg(genWallMs, genPh.netMs) : '';
      const genTailTxt = v04 && genPk ? tailMaxSeg(samples, turn.replyEnd, lagMsEff, turn.away, genPk.value) : '';
      L.push(`gen: ${fmtS(genPh.netMs)}${parts.length ? ` (${parts.join(', ')})` : ''} | ${fmtRange(gen)}${genPk ? peakSegTxt(genPk, genPeakAtSec, lagSec) : ''}${covTxt(genCov)}${offSeg(turn.prevSend, turn.replyEnd)}${genMeanTxt}${genAboveTxt}${genAwayTxt}${genTailTxt}${actSeg(genAct)}`);
      if (genAct && !genAct.none) {
        const c = cleanStats({ samples, from: turn.prevSend, to: turn.replyEnd, away: turn.away, act: genAct, noise: base && base.noise, cadenceMs, phaseSec: Math.round(genPh.netMs / 1000), lagMs: lagMsEff, floorBpm });
        const cl = cleanLine('gen', c); if (cl) cleanLines.push(cl);
        phaseVars.gen = { act: actVar(genAct), clean: cleanVar(c) };
      }
    } else L.push('gen: n/a');

    if (turn.readStart != null) {
      const readEnd = turn.readEnd;
      // A-1：切走（hidden / unfocused）的秒不进统计、不算时长；v0.4 §6“不在就不算”：峰值、cov、最短时长只按在场的秒算，离开得久也照常判
      const ph = phaseStats(samples, turn.readStart, readEnd, turn.away);
      const rd = ph.st;
      const readSec = Math.round(ph.netMs / 1000);
      const cov = rd ? coverage(rd.n, 0, ph.netMs, cadenceMs) : null;
      const pk = rd && !sparse && !(cov != null && cov < PEAK.MIN_COV) ? detectPeak(ph.samples, turn.readStart, ph.netMs, base && base.noise, { floorBpm, minPhaseMs }) : null;
      const hasPeak = Boolean(pk);
      const peakAtSec = hasPeak ? Math.round(netOffset(turn.away, turn.readStart, pk.at) / 1000) : null;
      const peak = hasPeak ? peakSegTxt(pk, peakAtSec, lagSec) : '';
      const hrv = sparse ? null : gatedHrv(rd, ph.samples, turn.readStart, readEnd, ph.netMs);
      const tooLong = ph.netMs > rGates.tooLongMs;
      readTooLong = tooLong;
      const flag = tooLong ? ' | flag: too-long (likely away)' : '';
      const readAct = acts ? actStats(acts, turn.readStart, readEnd, turn.away, readSec) : null;
      const readMeanTxt = v04 ? meanSeg(rd, base && base.bpm) : '';
      const readAboveTxt = v04 ? aboveSeg(ph.samples, base && base.bpm, cadenceMs, ABOVE_THRESHOLD_PCT) : '';
      const readAwayTxt = v04 ? awaySeg(readEnd - turn.readStart, ph.netMs) : '';
      const readTailTxt = v04 && hasPeak ? tailMaxSeg(samples, readEnd, lagMsEff, turn.away, pk.value) : '';
      L.push(`read: ${fmtMS(readSec)} | ${fmtRange(rd)}${peak}${covTxt(cov)}${rrLoss(rd)}${hrv != null ? ` | hrv ${hrv} ms` : ''}${offSeg(turn.readStart, readEnd)}${readMeanTxt}${readAboveTxt}${readAwayTxt}${readTailTxt}${actSeg(readAct)}${flag}`);
      readPeak = pk;
      if (readAct && !readAct.none) {
        const c = cleanStats({ samples, from: turn.readStart, to: readEnd, away: turn.away, act: readAct, noise: base && base.noise, cadenceMs, phaseSec: readSec, lagMs: lagMsEff, floorBpm });
        const cl = cleanLine('read', c); if (cl) cleanLines.push(cl);
        phaseVars.read = { act: actVar(readAct), clean: cleanVar(c) };
      }
      // 可选字段 read-pos：峰值不明显、read 带 too-long、与 idle / offscreen 重叠（v0.4 §6：在场但不一定在读最新回复）、换页/重新生成（回复已不在上下文里）、没有 replyMeta/字数为 0 时不输出
      //   hidden / unfocused 的秒已从读回复的时间里扣掉，阅读时间从读者回来那一刻起算，不挡 read-pos
      //   v0.4 §1.2 规则 3：stream="yes" 时位置看 stream 行的 pos，不得输出 read-pos（STREAM_WITHOUT_ATTR / READPOS_FORBIDDEN）
      const softAwayMs = overlapMs(turn.away.filter((x) => x[2] === 'idle' || x[2] === 'offscreen'), turn.readStart, readEnd);
      if (hasPeak && !tooLong && !discarded && softAwayMs === 0 && replyMeta && replyMeta.chars && !(v04 && turn.streamStart)) {
        const cjk = typeof replyMeta.cjkRatio === 'number' && replyMeta.cjkRatio >= 0.3;
        const defaultCps = cjk ? CONFIG.READ_CPS_CJK : CONFIG.READ_CPS_LATIN;
        const cpsIn = cpsOverride && typeof cpsOverride.cps === 'number' && cpsOverride.cps > 0 ? cpsOverride : { cps: defaultCps, source: 'est' };
        const cpsInfo = { cps: Math.max(1, Math.round(cpsIn.cps)), source: cpsIn.source === 'cal' ? 'cal' : 'est' };   // B-2：整数
        const partial = readSec * cpsInfo.cps < 0.8 * replyMeta.chars;   // v0.2 P-4：读时长 × 速度远小于回复字数 → 位置不可信
        const pos = partial ? null : readPosition({ replyChars: replyMeta.chars, paragraphOffsets: replyMeta.paragraphOffsets, peakAtSec, cps: cpsInfo.cps });
        if (partial) {
          const readPct = Math.min(99, Math.round(100 * readSec * cpsInfo.cps / replyMeta.chars));
          const peakPct = Math.round(100 * peakAtSec / Math.max(1, readSec));
          L.push(`read-pos: partial (read time covers ~${readPct}% of ${replyMeta.chars} chars @${cpsInfo.cps} cps ${cpsInfo.source}), peak at ${peakPct}% of read time`);
          readPos = { partial: true, readPct, peakPct, replyChars: replyMeta.chars, cps: cpsInfo.cps, source: cpsInfo.source };
        }
        if (pos) {
          L.push(`read-pos: peak ~${pos.pct}% (~${pos.chars}/${replyMeta.chars} chars, para ${pos.para}/${pos.paraCount}) @${cpsInfo.cps} cps ${cpsInfo.source}`);
          readPos = { pct: pos.pct, chars: pos.chars, replyChars: replyMeta.chars, para: pos.para, paraCount: pos.paraCount, cps: cpsInfo.cps, source: cpsInfo.source };
        }
      }
    } else L.push('read: n/a (no previous reply)');

    if (discarded) L.push(`write: ${NO_NEW_MESSAGE}`);
    else if (trigger === 'impersonate') L.push(`write: ${IMPERSONATE_WRITE}`);
    else if (turn.typingStart != null) {
      const ph = phaseStats(samples, turn.typingStart, now, turn.away);
      const wr = ph.st;
      const wrSec = Math.round(ph.netMs / 1000);
      const wrCov = wr ? coverage(wr.n, 0, ph.netMs, cadenceMs) : null;
      // v0.4 §2.2：peak 的适用范围含 write 行（v0.3 write 不带 peak，与既有行为一致）
      const wrPk = v04 && wr && !sparse && !(wrCov != null && wrCov < PEAK.MIN_COV) ? detectPeak(ph.samples, turn.typingStart, ph.netMs, base && base.noise, { floorBpm, minPhaseMs }) : null;
      const wrPeakAtSec = wrPk ? Math.round(netOffset(turn.away, turn.typingStart, wrPk.at) / 1000) : null;
      const wrAct = acts ? actStats(acts, turn.typingStart, now, turn.away, wrSec) : null;
      const wrMeanTxt = v04 ? meanSeg(wr, base && base.bpm) : '';
      const wrAboveTxt = v04 ? aboveSeg(ph.samples, base && base.bpm, cadenceMs, ABOVE_THRESHOLD_PCT) : '';
      const wrAwayTxt = v04 ? awaySeg(now - turn.typingStart, ph.netMs) : '';
      L.push(`write: ${fmtS(ph.netMs)}, ${turn.lastLen != null ? turn.lastLen : 'n/a'} chars, pauses ${turn.pauses}, edits ${turn.deletes} | ${fmtRange(wr)}${wrPk ? peakSegTxt(wrPk, wrPeakAtSec, lagSec) : ''}${covTxt(wrCov)}${rrLoss(wr)}${offSeg(turn.typingStart, now)}${wrMeanTxt}${wrAboveTxt}${wrAwayTxt}${actSeg(wrAct)}`);
      if (wrAct && !wrAct.none) {
        const c = cleanStats({ samples, from: turn.typingStart, to: now, away: turn.away, act: wrAct, noise: base && base.noise, cadenceMs, phaseSec: wrSec, lagMs: lagMsEff, floorBpm });
        const cl = cleanLine('write', c); if (cl) cleanLines.push(cl);
        phaseVars.write = { act: actVar(wrAct), clean: cleanVar(c) };
      }
    } else L.push('write: n/a (no typing detected)');

    L.push(awayLine(turn, samples, v04));

    const sendSt = stats(inWin(samples, now - 5000, now));
    if (discarded) L.push(`send: ${NO_NEW_MESSAGE}`);
    else L.push(sendSt ? `send: ${sendSt.last} bpm${base ? ` (${sendSt.last >= base.bpm ? '+' : '-'}${Math.round(Math.abs(sendSt.last - base.bpm) / base.bpm * 100)}%)` : ''}` : 'send: n/a (no data in last 5s)');
    for (const cl of cleanLines) L.push(cl);
    const wl = wearLine(offSpans, turn, now, meta); if (wl) L.push(wl);
    // 0.8：其它信号种类各一行，随后是执行器状态行（都是可选的增量行）
    if (kinds && typeof kinds === 'object') {
      for (const kind of Object.keys(kinds)) { if (kind === 'hr' || kind === 'rr' || ENV_KINDS.has(kind)) continue; const kl = kindLine(kind, kinds[kind], turn, now); if (kl) L.push(kl); }
      const el = envLine(kinds, now); if (el) L.push(el);
    }
    if (Array.isArray(deviceLines)) { for (const d of deviceLines) { const line = deviceLine(d); if (line) L.push(line); } }
    // 已按协议格式写好的扩展行（如 v0.3 §5.8 的 haptics 行）
    if (Array.isArray(extraLines)) { for (const x of extraLines) { if (x && !/[<>\x00-\x1f\x7f\u2028\u2029]/.test(x)) L.push(String(x)); } }
    const gl = gatesLine(rGates); if (gl) L.push(gl);   // §12 gates 行：学到 / 手动的门槛，放扩展区、series 之前
    // v0.4 §1.2：stream 行——只在首行 stream="yes"（即本轮确实收到过流式片段）时输出
    if (v04 && turn.streamStart) {
      const sl = streamLine({ turn, samples, base, lagMs: lagMsEff, floorBpm, minPhaseMs, cadenceMs, sparse, replyMeta, streamMarks, discarded });
      if (sl) L.push(sl);
    }
    const seqFrom = Math.max(turn.prevSend || 0, turn.readStart || 0, now - CONFIG.SERIES_MAX_MS);
    const seqStart = Math.floor(seqFrom / CONFIG.BUCKET_MS) * CONFIG.BUCKET_MS;
    const seq = series(samples, seqStart, now);
    if (!sparse && seq.some((v) => v !== '·')) L.push(`series(10s from ${fmtClock(seqStart)}): ${seq.join(' ')}`);   // 没有任何数据时不写（series 是可选行）
    L.push(NOTE_LINE);
    if (baseWarn) L.push(baseWarn);
    L.push('</bio_context>');
    const summary = turnSummary({ samples, turn, baseline: base, peak: readPeak });
    if (summary && Object.keys(phaseVars).length) summary.phases = phaseVars;   // v0.4 §5.5
    if (summary) summary.readPos = readPos;   // 0.7.1：read-pos 同步进摘要 → 聊天变量 bio.turns / 消息 extra.bio
    // v0.4 §3-5：bio.baselineInfo，字段与块里的 baseline 行同一份数据（schema 只在 v="0.4" 时检查）
    if (summary && v04) {
      summary.baselineInfo = base ? {
        method: base.method, n: Number.isFinite(base.n) ? base.n : null,
        ageSec: Math.max(0, Math.round((now - (Number.isFinite(base.lastT) ? base.lastT : base.at)) / 1000)) || 0,
        noise: Number.isFinite(base.noise) ? Math.round(base.noise) : null,
        setAt: base.method === 'manual' && Number.isFinite(base.at) ? new Date(base.at).toISOString().slice(0, 10) : null,
        device: base.method === 'manual' ? (base.deviceId || null) : null,
        changedFrom: baselineChange ? baselineChange.method : null,
        changedTurnsAgo: baselineChange ? baselineChange.turnsAgo : null,
      } : null;
    }
    if (summary) summary.gates = {   // bio.gates：给卡片脚本读；只放学到 / 手动的门槛
      idle: (rGates.idleSrc !== 'est') ? { sec: Math.round(rGates.idleMs / 1000), source: rGates.idleSrc, n: rGates.idleN } : null,
      tooLong: (rGates.tlSrc !== 'est') ? { sec: Math.round(rGates.tooLongMs / 1000), source: rGates.tlSrc, n: rGates.tlN } : null,
    };
    if (summary) {   // 门槛自动学的原料（§3.10）：干净轮才记，too-long 的轮不算干净
      const rec = rhythmRecord(turn, events, { replyChars: replyMeta && replyMeta.chars, cps: cpsForGates });
      if (rec.clean && readTooLong) rec.clean = false;
      summary.rhythm = rec;
    }
    // v0.3 §2.5 单块保证：首行合规、中间行不含尖括号与控制字符，否则改发最小块
    const guarded = blockGuard(L, { header, now });
    let text = guarded.text;
    if (trigger === 'continue' && !guarded.invalid) text = replayBlock(text, { replay: 'continue', composedAt: now });
    return { text, turn, baseline: base, summary, invalid: guarded.invalid };
  }
  const HEADER_OK = /^<bio_context(?: [a-z][a-z0-9_-]*="[^"<>\x00-\x1f\x7f]*")+>$/;
  function blockGuard(L, { header, now }) {
    const body = L.slice(1, -1);
    const bad = !HEADER_OK.test(header) || body.some((l) => /[<>\x00-\x1f\x7f\u2028\u2029]/.test(l)) || L[L.length - 1] !== '</bio_context>';
    if (!bad) return { text: L.join('\n'), invalid: false };
    const safeHeader = HEADER_OK.test(header) ? header : `<bio_context v="${SPEC_VERSION}" mode="author" view="backstage" source="${SOURCE}">`;
    return { text: [safeHeader, `sent: ${fmtClock(now)}`, NOTE_LINE, 'warn: block-invalid', '</bio_context>'].join('\n'), invalid: true };
  }


  // ---------- 消息级数据写入（0.7.2）：不主动保存，交给宿主下一次保存；同步镜像进 swipe_info，防止 swipe 来回时被旧 extra 覆盖 ----------
  function attachBio(message, patch) {
    if (!message || typeof message !== 'object') return null;
    message.extra = message.extra || {};
    const merged = Object.assign({}, message.extra.bio || {}, patch || {});
    message.extra.bio = merged;
    if (Array.isArray(message.swipe_info) && typeof message.swipe_id === 'number' && message.swipe_info[message.swipe_id]) {
      const sw = message.swipe_info[message.swipe_id];
      sw.extra = sw.extra || {};
      sw.extra.bio = Object.assign({}, merged);
    }
    return merged;
  }

  // 读法世界书（ST 原生格式）是否已是最新：条数相同，且每条期望条目都能在现有条目里找到逐字段相同的一条
  function guideEntriesUpToDate(current, wanted) {
    if (!Array.isArray(current) || !Array.isArray(wanted) || current.length !== wanted.length) return false;
    const same = (x, e) => x.comment === e.comment && x.content === e.content && !x.disable && !!x.constant === !!e.constant
      && x.position === e.position && (x.depth ?? null) === (e.depth ?? null) && JSON.stringify(x.key || []) === JSON.stringify(e.key || []);
    return wanted.every((e) => current.some((x) => same(x, e)));
  }

  // 版本号按 . 切分逐段按整数比较：compareVersions('0.10', '0.3') === 1
  function compareVersions(a, b) {
    const pa = String(a == null ? '0' : a).split('.'), pb = String(b == null ? '0' : b).split('.');
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = parseInt(pa[i] ?? '0', 10) || 0, y = parseInt(pb[i] ?? '0', 10) || 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }
  // 读法世界书是哪个 heartlink 版本写的：条目上的 heartlink 字段（原生格式）或 extra.heartlink（酒馆助手格式）取最高；都没有 = null（旧版写的）
  function guideVersionOf(entries) {
    let v = null;
    for (const e of entries || []) {
      const x = e && (typeof e.heartlink === 'string' ? e.heartlink : (e.extra && typeof e.extra.heartlink === 'string' ? e.extra.heartlink : null));
      if (x && (v == null || compareVersions(x, v) > 0)) v = x;
    }
    return v;
  }
  // 读法世界书写入决策：
  //   'newer'：书是更新的 heartlink 写的，不覆盖；'ok'：已是本版；'write'：缺失或是旧版写的，要写
  //   conflict：本浏览器里本版（或更新的版本）写过，现在书却是更旧的版本写的 → 有旧版在改写
  function guideDecision({ current, upToDate, version, lastWrote }) {
    const by = guideVersionOf(current);
    if (by && compareVersions(by, version) > 0) return { action: 'newer', by };
    if (upToDate) return { action: 'ok', by };
    const conflict = Boolean(current && current.length && lastWrote && compareVersions(lastWrote, by || '0') > 0);
    return { action: 'write', by, conflict };
  }

  // 把多次“要重画”合成每帧一次；页面隐藏时不画，回到前台（onVisible）补一次
  //   schedule(fn)：下一帧调用 fn（浏览器里是 requestAnimationFrame）；isHidden()：页面是否在后台；run()：真正的绘制
  function frameCoalescer({ schedule, isHidden, run }) {
    const st = { queued: false, dirtyWhileHidden: false, runs: 0 };
    function request() {
      if (isHidden()) { st.dirtyWhileHidden = true; return; }
      if (st.queued) return;
      st.queued = true;
      schedule(() => {
        st.queued = false;
        if (isHidden()) { st.dirtyWhileHidden = true; return; }
        st.runs++;
        run();
      });
    }
    function onVisible() {
      if (!isHidden() && st.dirtyWhileHidden) { st.dirtyWhileHidden = false; request(); }
    }
    return { request, onVisible, stats: st };
  }

  // ---------- v0.3 §5.12 设备反馈 ----------
  // 事件发生时读者在哪个相位、相位开始后几秒（与块的相位边界一致：gen = 发送 → 回复出完；read = 回复出完 / 换页 → 开始打字；write = 开始打字 → 现在）
  function phaseAt(events, t) {
    let send = null, reply = null, chat = null;
    for (const e of events || []) {
      if (!e || e.t > t) continue;
      if (e.type === 'send' && (send == null || e.t > send)) send = e.t;
      else if ((e.type === 'reply_end') && (reply == null || e.t > reply)) reply = e.t;
      else if ((e.type === 'chat_changed') && (chat == null || e.t > chat)) chat = e.t;
    }
    if (send != null && (reply == null || reply < send)) return { phase: 'gen', since: send, atSec: Math.max(0, Math.round((t - send) / 1000)) };
    let readFrom = reply;
    let typeFrom = null;
    for (const e of events || []) {
      if (!e || e.t > t) continue;
      if (e.type === 'swipe' && readFrom != null && e.t > readFrom) readFrom = e.t;
    }
    const after = readFrom != null ? readFrom : (send != null ? send : -Infinity);
    for (const e of events || []) if (e && e.type === 'type' && e.t > after && e.t <= t && (typeFrom == null || e.t < typeFrom)) typeFrom = e.t;
    const at = (from) => Math.max(0, Math.round((t - from) / 1000));
    if (typeFrom != null) return { phase: 'write', since: typeFrom, atSec: at(typeFrom) };
    if (readFrom != null) return { phase: 'read', since: readFrom, atSec: at(readFrom) };
    const from = chat != null ? chat : t;
    return { phase: 'read', since: from, atSec: at(from) };
  }
  const FEEDBACK_FROM = ['reader', 'safeword', 'device'];
  const FEEDBACK_TYPES = ['stop', 'stronger', 'weaker', 'pace', 'replay', 'skip'];
  const FEEDBACK_REASONS = ['disconnected', 'deadline', 'heat-limit', 'rate-limit', 'other'];
  const FEEDBACK_PACES = ['slow-burn', 'steady', 'frenzy', 'max'];
  const FEEDBACK_KEYS = new Set(['t', 'from', 'type', 'value', 'target', 'act', 'reason']);
  const FEEDBACK_MAX_EVENTS = 8;
  // 按 spec/schema/feedback.schema.json 校验 tbc.feedback() 的参数：合规返回规整后的对象，否则 { error: 字段名 }
  function validateFeedback(ev) {
    const bad = (f) => ({ error: f });
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return bad('event');
    for (const k of Object.keys(ev)) if (!FEEDBACK_KEYS.has(k)) return bad(k);
    if (!Number.isInteger(ev.t) || ev.t < 0) return bad('t');
    if (!FEEDBACK_FROM.includes(ev.from)) return bad('from');
    if (!FEEDBACK_TYPES.includes(ev.type)) return bad('type');
    const out = { t: ev.t, from: ev.from, type: ev.type };
    const v = ev.value;
    if (v !== undefined && v !== null && typeof v !== 'string' && !Number.isInteger(v)) return bad('value');
    if (ev.type === 'stronger' || ev.type === 'weaker') { if (!Number.isInteger(v) || v < 1 || v > 100) return bad('value'); }
    if (ev.type === 'pace' && !FEEDBACK_PACES.includes(v)) return bad('value');
    if (v !== undefined) out.value = v;
    if (ev.target !== undefined) {
      if (ev.target !== null && (typeof ev.target !== 'string' || ev.target.length > 64)) return bad('target');
      out.target = ev.target;
    }
    if (ev.act !== undefined) {
      const a = ev.act;
      if (a !== null) {
        if (typeof a !== 'object' || Array.isArray(a)) return bad('act');
        for (const k of Object.keys(a)) if (!['key', 'i', 'afterMs'].includes(k)) return bad('act.' + k);
        if (typeof a.key !== 'string' || a.key.length > 64) return bad('act.key');
        if (a.i !== undefined && (!Number.isInteger(a.i) || a.i < 0)) return bad('act.i');
        if (a.afterMs !== undefined && (!Number.isInteger(a.afterMs) || a.afterMs < 0)) return bad('act.afterMs');
        out.act = Object.assign({ key: a.key }, a.i !== undefined ? { i: a.i } : {}, a.afterMs !== undefined ? { afterMs: a.afterMs } : {});
      } else out.act = null;
    }
    if (ev.reason !== undefined && ev.reason !== null && !FEEDBACK_REASONS.includes(ev.reason)) return bad('reason');
    if (ev.from === 'device' && (typeof ev.reason !== 'string')) return bad('reason');
    if (ev.reason !== undefined) out.reason = ev.reason;
    return out;
  }
  // 一个事件 → feedback 行的一段；写不出合规的段时返回 null
  //   e：validateFeedback 的结果，另带 phase / atSec（记录时算好）与 reply（reply -N 的 N，查不到为 null）
  function feedbackSegment(e) {
    let action;
    if (e.type === 'stop') action = `stop by ${e.from}`;
    else if (e.type === 'stronger') action = `stronger +${e.value}%`;
    else if (e.type === 'weaker') action = `weaker -${e.value}%`;
    else if (e.type === 'pace') action = `pace ${e.value}`;
    else if (e.type === 'replay') { if (typeof e.value !== 'string' || !/^[a-z]+$/.test(e.value)) return null; action = `replay ${e.value}`; }
    else if (e.type === 'skip') action = 'skip';
    else return null;
    const phase = ['gen', 'read', 'write', 'send'].includes(e.phase) ? e.phase : 'read';
    const at = phase === 'send' ? 0 : Math.max(0, Math.round(Number(e.atSec) || 0));
    const note = [];
    if (e.type === 'stop' && e.from === 'device' && FEEDBACK_REASONS.includes(e.reason)) note.push(e.reason);
    if (Number.isInteger(e.reply) && e.reply >= 1) {
      let ref = `reply -${e.reply}`;
      if (e.act && Number.isInteger(e.act.i)) {
        ref += `, act ${e.act.i + 1}`;
        if (Number.isInteger(e.act.afterMs)) {
          const full = `${ref}, ${(Math.round(e.act.afterMs / 100) / 10).toFixed(1).replace(/\.0$/, '')}s in`;
          if ([...note, full].join(', ').length <= 40) ref = full;
        }
      }
      if ([...note, ref].join(', ').length <= 40) note.push(ref);
    }
    return `${action} ${phase} @${at}s${note.length ? ` (${note.join(', ')})` : ''}`;
  }
  // feedback 行（§5.12.2）：acts = { sent, done, cut, pending, refused } 或 null；events 按时间顺序；dropped = 缓冲区外已丢的事件数
  // 既没有动作也没有事件时返回 null（不出现这一行）
  function feedbackLine({ acts, events, dropped, source }) {
    const segs = [];
    if (acts && acts.sent > 0) {
      const n = (k) => Math.max(0, Math.round(acts[k] || 0));
      const sent = n('done') + n('cut') + n('pending') + n('refused');
      let s = `acts ${sent} sent, ${n('done')} done`;
      if (n('cut')) s += `, ${n('cut')} cut`;
      if (n('pending')) s += `, ${n('pending')} pending`;
      if (n('refused')) s += `, ${n('refused')} refused`;
      segs.push(s);
    }
    const evSegs = (events || []).slice().sort((a, b) => a.t - b.t).map(feedbackSegment).filter(Boolean);
    const more = Math.max(0, evSegs.length - FEEDBACK_MAX_EVENTS) + Math.max(0, Math.round(dropped || 0));
    segs.push(...evSegs.slice(-FEEDBACK_MAX_EVENTS));
    if (!segs.length) return null;
    if (more) segs.push(`+${more} more`);
    return `feedback(${isIdent(source) ? source : SOURCE}): ${segs.join(' | ')}`;
  }

  // 拖动悬浮窗：移动超过阈值才算拖动；每帧最多改一次位移（transform），松手时才提交位置
  //   schedule(fn) / cancel(id)：requestAnimationFrame；apply(dx, dy)：写 transform；start()：开始拖动（收起面板、关模糊）；commit(dx, dy)：松手提交
  function dragController({ schedule, cancel, apply, start, commit, threshold }) {
    const th = threshold == null ? 5 : threshold;
    let s = null;
    const clampD = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    function down(x, y, bounds) { s = { x, y, dx: 0, dy: 0, moving: false, raf: null, b: bounds || null, frames: 0 }; }
    function flush() { if (!s) return; s.raf = null; s.frames++; apply(s.dx, s.dy); }
    function move(x, y) {
      if (!s) return false;
      let dx = x - s.x; let dy = y - s.y;
      if (!s.moving) { if (Math.hypot(dx, dy) < th) return false; s.moving = true; if (start) start(); }
      if (s.b) { dx = clampD(dx, s.b.minX, s.b.maxX); dy = clampD(dy, s.b.minY, s.b.maxY); }
      s.dx = dx; s.dy = dy;
      if (s.raf == null) s.raf = schedule(flush);
      return true;
    }
    function up() {
      if (!s) return false;
      const cur = s; s = null;
      if (cur.raf != null && cancel) cancel(cur.raf);
      if (!cur.moving) return false;
      commit(cur.dx, cur.dy);
      return true;
    }
    return { down, move, up, active: () => !!s, moving: () => !!(s && s.moving), frames: () => (s ? s.frames : 0) };
  }

  return {
    guideEntriesUpToDate, frameCoalescer, phaseAt, validateFeedback, feedbackSegment, feedbackLine, dragController, FEEDBACK_MAX_EVENTS,
    CONFIG, SPEC_VERSION, SOURCE, MODES,
    parseHeartRate, inWin, stats, series, isFresh, staleThresholdMs, fmtClock, fmtDur,
    collectRR, rmssd, hrvInWindow,
    manualBaseline, quietWindows, genReadSpans, sessionBaseline, restBaseline, REST, manualBaselineStale, MANUAL_MAX_AGE_MS, baselineChanged, baselineSegs, V04_METHOD,
    HR_SANE, hrPlausible, createHrGate, contactSpans, guessWear, LAG_MS_BY_CLASS, wearLine, peakFloor, WRIST_FLOOR,
    detectPeak, gatedHrv, robustSd, compareVersions, guideVersionOf, guideDecision, replayBlock, sanitizeText, isIdent, isKindName, isDeviceName, isDateText, serialProblem, mergeSpans, overlapMs, phaseStats, LEGACY_MODE, TRIGGERS, BUS_ONLY_KINDS,
    SPEC_DRAFT, actStats, actSeg, cleanStats, cleanLine, actSpans,
    buildTurn, turnSummary, historyLine, readPosition, estimateCps, composeContext, attachBio, kindLine, deviceLine, coverage, priorLine, envLine, headerAttrs, normalizeMode, readCardHints, sparkPath, buildDiagnostics, WIRE_MODE, SCOPE_LINE, learnGates, resolveGates, gatesLine, rhythmRecord,
    lagSecFor, peakSegTxt, tailMaxSeg, ABOVE_THRESHOLD_PCT, pctVsBase, meanSeg, aboveSeg, awaySeg, streamLine, LAG_MS_DEFAULT,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = HeartlinkCore;

// heartlink haptics — TBC v0.3 §5 输出接口：<bio_act/> 解析、强度帧、安全闸门、执行器登记表、Intiface（buttplug v4，回退 v3）客户端。
// 纯逻辑，时间与网络都由调用方注入，Node 测试可直接跑。解析与帧的结果须与协议参考实现 ../spec/tools/bio-act.mjs 一致。
const HeartlinkHaptics = (() => {
  'use strict';

  const OUTPUTS = ['*', 'Vibrate', 'Rotate', 'Oscillate', 'Constrict', 'Spray', 'Temperature', 'Led', 'Position', 'HwPositionWithDuration', 'Estim'];
  const PATTERNS = ['pulse', 'double', 'triple', 'long', 'heartbeat', 'wave'];
  // §5.9：output="*" 不驱动这些输出，必须点名
  const RISKY_OUTPUTS = ['Temperature', 'Estim', 'Spray'];
  const TOY_SENSORS = ['Pressure', 'Button'];   // v0.4 §5.6：玩具上的传感器输入
  const ACT_LOG_MAX = 200;   // v0.4 §5.1：驱动区间台账的上限（一轮统计只看本相位，留够几分钟即可）
  const onlyRisky = (caps) => caps.outputs.every((o) => RISKY_OUTPUTS.includes(o));
  const MAX_PER_REPLY = 3;
  const DEFAULT_INTENSITY = 0.5;
  const DEFAULT_MS = { pulse: 200, double: 500, triple: 800, long: 1500, heartbeat: 2700, wave: 3000 };
  const DEFAULT_MIN_INTERVAL_MS = 10000;
  // v0.3 §5.8 档位与自定义参数（与 ../spec/tools/bio-act.mjs 一致）
  const PROFILES = {
    'slow-burn': { floor: 0, defaultMs: { long: 1500, heartbeat: 2700, wave: 3000 }, minIntervalMs: 1500, maxPerReply: 3 },
    steady: { floor: 0.25, defaultMs: { long: 8000, heartbeat: 8100, wave: 9000 }, minIntervalMs: 1200, maxPerReply: 3 },
    frenzy: { floor: 0.4, defaultMs: { long: 5000, heartbeat: 5400, wave: 6000 }, minIntervalMs: 800, maxPerReply: 5 },
    max: { floor: 0.8, defaultMs: { long: 10000, heartbeat: 9000, wave: 10000 }, minIntervalMs: 500, maxPerReply: 5 },
  };
  const DEFAULT_PROFILE = 'slow-burn';
  const MAX_PER_REPLY_LIMIT = 5;
  function resolveSettings(profile, overrides) {
    const base = PROFILES[profile] || PROFILES[DEFAULT_PROFILE];
    const o = overrides || {};
    const clamp01 = (v, d) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);
    return {
      profile: PROFILES[profile] ? profile : DEFAULT_PROFILE,
      floor: clamp01(o.floor, base.floor),
      defaultMs: Object.assign({}, base.defaultMs, o.defaultMs || {}),
      minIntervalMs: Number.isFinite(o.minIntervalMs) && o.minIntervalMs >= 0 ? o.minIntervalMs : base.minIntervalMs,
      maxPerReply: Number.isInteger(o.maxPerReply) ? Math.min(MAX_PER_REPLY_LIMIT, Math.max(0, o.maxPerReply)) : base.maxPerReply,
    };
  }
  function liftIntensity(intensity, floor) {
    const I = Math.min(1, Math.max(0, Number(intensity) || 0));
    if (I === 0) return 0;
    const f = Math.min(1, Math.max(0, floor || 0));
    return Math.round((f + (1 - f) * I) * 1000) / 1000;
  }
  // 两次触发的间隔：设了档位时取“执行器声明”与“档位”中的较大者，否则用执行器声明（缺省 10 秒）
  function intervalFor(caps, p) {
    if (p && Number.isFinite(p.minIntervalMs)) return Math.max(caps.minIntervalMs || 0, p.minIntervalMs);
    return caps.minIntervalMs == null ? DEFAULT_MIN_INTERVAL_MS : caps.minIntervalMs;
  }

  const num = (v) => (v == null || v === '' ? null : Number(v));

  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const BIO_ACT_TAG_RE = /<bio_act\b[^>]*?\/?>/g;
  // v0.3 §5.3：不算动作的部分（与 ../spec/tools/bio-act.mjs 的 stripNonActionText 同一套规则、同一顺序）：
  //   代码块（``` / ~~~）、行内代码、HTML 注释、宿主推理模板前后缀（opts.reasoningMarkers）、
  //   正文里的 <think>/<thinking>（含带前缀的变体）、只有结束标签的前缀、没有闭合的结尾思维链。
  // opts.mask = true 时用等长空格替换，字符位置不变（去重按位置算）；否则与参考实现一样替换成一个空格
  function stripNonActionText(text, opts) {
    const o = opts || {};
    const rep = o.mask ? (m) => ' '.repeat(m.length) : () => ' ';
    let t = String(text || '');
    t = t.replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, rep);
    t = t.replace(/`[^`\n]*`/g, rep);
    t = t.replace(/<!-{2}[\s\S]*?(?:-{2}>|$)/g, rep);   // HTML 注释（写成 -{2}：产物里不能出现字面的注释开头，宿主会截断脚本）
    for (const mk of o.reasoningMarkers || []) {
      if (!mk || !mk.prefix || !mk.suffix) continue;
      t = t.replace(new RegExp(`${escapeRe(mk.prefix)}[\\s\\S]*?(?:${escapeRe(mk.suffix)}|$)`, 'g'), rep);
    }
    t = t.replace(/<([a-z_]*think(?:ing)?)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, rep);
    t = t.replace(/^[\s\S]*?<\/[a-z_]*think(?:ing)?\s*>/i, rep);
    t = t.replace(/<[a-z_]*think(?:ing)?\b[^>]*>[\s\S]*$/i, rep);
    return t;
  }
  // 只作用于显示：去掉全部 <bio_act/> 标签（不管执行没执行）；不改消息原文
  function hideBioActs(text) { return String(text || '').replace(BIO_ACT_TAG_RE, ''); }

  // opts.withOffsets：另外返回每个动作 / 错误在原文里的 [起, 止] 位置（acts 与 errors 本身与参考实现逐项相同）
  // v0.4 §8：自带模式直通（与 spec/tools/bio-act.mjs 的 resolveNative 一致）
  const NATIVE_PATTERN = 'native';
  const modesOf = (x) => {
    const list = Array.isArray(x && x.native) ? x.native : Array.isArray(x && x.nativePatterns) ? x.nativePatterns : null;
    return list && list.map((m, i) => m && Object.assign({}, m, { n: Number.isInteger(m.n) ? m.n : i + 1 })).filter(Boolean);
  };
  function resolveNative(target, output, mode, actuators) {
    if (!Array.isArray(actuators)) return { error: 'NATIVE_NO_CAPS' };
    if (mode == null || mode === '') return { error: 'NATIVE_NO_MODE' };
    const byIndex = /^\d{1,2}$/.test(mode);
    const pool = actuators.map((x) => ({ x, modes: modesOf(x) })).filter((q) => q.modes && (target === '*' || q.x.id === target));
    if (!pool.length) return { error: 'NATIVE_UNAVAILABLE' };
    if (byIndex && target === '*' && pool.filter((q) => q.modes.some((m) => m.enabled !== false)).length > 1) return { error: 'NATIVE_TARGET_AMBIGUOUS' };
    const native = [];
    let off = false;
    for (const q of pool) {
      const m = q.modes.find((k) => (byIndex ? k.n === Number(mode) : k.name === mode));
      if (!m) continue;
      if (m.enabled === false) { off = true; continue; }
      const outs = Array.isArray(m.outputs) && m.outputs.length ? m.outputs : (q.x.outputs || []);
      const ok = output === '*' ? outs.some((o) => !RISKY_OUTPUTS.includes(o)) : outs.includes(output);
      if (!ok) continue;
      native.push({ id: q.x.id, n: m.n, name: m.name, stoppable: m.stoppable !== false });
    }
    if (!native.length) return { error: off ? 'NATIVE_OFF' : 'NATIVE_UNAVAILABLE' };
    return { native };
  }

  function parseBioActs(text, opts) {
    const limit = opts && Number.isInteger(opts.maxPerReply) ? Math.min(MAX_PER_REPLY_LIMIT, Math.max(0, opts.maxPerReply)) : MAX_PER_REPLY;
    const acts = [];
    const errors = [];
    const actOffsets = [];
    const errorOffsets = [];
    const re = /<bio_act\b([^>]*?)\/?>/g;
    const body = stripNonActionText(text, Object.assign({}, opts, { mask: true }));
    let m;
    while ((m = re.exec(body))) {
      const span = [m.index, m.index + m[0].length];
      const nErr = errors.length;
      const a = {};
      const ar = /([a-zA-Z_]+)\s*=\s*"([^"]*)"/g;
      let x;
      while ((x = ar.exec(m[1]))) a[x[1]] = x[2];
      const act = { target: a.target || '*', output: a.output || '*', pattern: a.pattern || 'pulse', intensity: num(a.intensity) ?? DEFAULT_INTENSITY, durationMs: num(a.ms) };
      if (!OUTPUTS.includes(act.output)) { errors.push({ code: 'BAD_OUTPUT', value: act.output }); errorOffsets.push(span); continue; }
      if (act.pattern === NATIVE_PATTERN) {
        const r = resolveNative(act.target, act.output, a.mode, opts && opts.actuators);
        if (r.error) { errors.push({ code: r.error, value: a.mode != null ? a.mode : null }); errorOffsets.push(span); continue; }
        act.mode = a.mode;
        act.native = r.native;
      } else if (a.mode != null) {
        errors.push({ code: 'MODE_IGNORED', value: a.mode });
      }
      if (act.pattern !== NATIVE_PATTERN && !PATTERNS.includes(act.pattern)) { errors.push({ code: 'BAD_PATTERN', value: act.pattern, fallback: 'pulse' }); act.pattern = 'pulse'; }
      if (!Number.isFinite(act.intensity) || act.intensity < 0 || act.intensity > 1) { errors.push({ code: 'BAD_INTENSITY', value: a.intensity }); act.intensity = Math.min(1, Math.max(0, Number.isFinite(act.intensity) ? act.intensity : DEFAULT_INTENSITY)); }
      if (act.durationMs != null && (!Number.isFinite(act.durationMs) || act.durationMs <= 0)) { errors.push({ code: 'BAD_MS', value: a.ms }); act.durationMs = null; }
      if (acts.length >= limit) { errors.push({ code: 'TOO_MANY', value: acts.length + 1 }); for (let k = nErr; k < errors.length; k++) errorOffsets.push(span); continue; }
      acts.push(act); actOffsets.push(span);
      for (let k = nErr; k < errors.length; k++) errorOffsets.push(span);
    }
    return opts && opts.withOffsets ? { acts, errors, actOffsets, errorOffsets } : { acts, errors };
  }

  function patternFrames(pattern, intensity, durationMs, opts) {
    const o = opts || {};
    const I = liftIntensity(intensity, o.floor || 0);
    const D = Object.assign({}, DEFAULT_MS, o.defaultMs || {});
    const r = (v) => Math.round(v * 1000) / 1000;
    switch (pattern) {
      case 'native': { const ms = durationMs || D.long; return [[0, I], [ms, 0]]; }
      case 'double': return [[0, I], [180, 0], [320, I], [500, 0]];
      case 'triple': return [[0, I], [160, 0], [320, I], [480, 0], [640, I], [800, 0]];
      case 'long': { const ms = durationMs || D.long; return [[0, I], [ms, 0]]; }
      case 'heartbeat': {
        const ms = durationMs || D.heartbeat;
        const beats = Math.max(1, Math.round(ms / 900));
        const out = [];
        for (let b = 0; b < beats; b++) { const t = b * 900; out.push([t, I], [t + 120, 0], [t + 250, r(I * 0.7)], [t + 380, 0]); }
        return out;
      }
      case 'wave': {
        const ms = durationMs || D.wave;
        const out = [];
        for (let i = 0; i <= 10; i++) out.push([Math.round((ms * i) / 10), r(I * Math.sin((Math.PI * i) / 10))]);
        out[out.length - 1][1] = 0;
        return out;
      }
      case 'pulse':
      default: return [[0, I], [DEFAULT_MS.pulse, 0]];
    }
  }

  // 安全闸门（§5.4）：返回 { refused } 或 { intensity, durationMs, pattern, clipped, fallback }
  function gate({ now, policy, caps, lastAt, action }) {
    const p = policy || {};
    if (!p.enabled) return { refused: 'disabled' };
    if (action.output !== '*' && !caps.outputs.includes(action.output)) return { refused: 'unsupported' };
    if (action.output === '*' && onlyRisky(caps)) return { refused: 'unsupported' };
    if (p.quiet) return { refused: 'quiet-hours' };
    if (p.sleeping) return { refused: 'sleeping' };
    if (caps.wearable && p.worn === false) return { refused: 'not-worn' };
    const gap = intervalFor(caps, p);
    if (lastAt != null && now - lastAt < gap) return { refused: 'rate-limit', retryInMs: gap - (now - lastAt) };
    const clipped = {};
    let pattern = PATTERNS.includes(action.pattern) ? action.pattern : 'pulse';
    let fallback = null;
    if (caps.patterns && !caps.patterns.includes(pattern)) { fallback = 'pulse'; pattern = 'pulse'; }
    // 先按档位下限抬高，再裁到上限（§5.8）
    let intensity = liftIntensity(action.intensity == null ? DEFAULT_INTENSITY : action.intensity, p.floor || 0);
    const cap = Math.min(caps.maxIntensity == null ? 1 : caps.maxIntensity, p.maxIntensity == null ? 1 : p.maxIntensity);
    if (intensity > cap) { clipped.intensity = cap; intensity = cap; }
    let durationMs = action.durationMs == null ? null : action.durationMs;
    if (durationMs != null && caps.maxDurationMs != null && durationMs > caps.maxDurationMs) { clipped.durationMs = caps.maxDurationMs; durationMs = caps.maxDurationMs; }
    return { intensity, durationMs, pattern, clipped: Object.keys(clipped).length ? clipped : null, fallback };
  }

  // 帧播放：按偏移依次 setLevel；返回 { done: Promise, cancel() }
  function playFrames(frames, setLevel, timers) {
    const T = timers;
    const ids = [];
    let cancelled = false;
    const done = new Promise((resolve) => {
      if (!frames.length) return resolve();
      frames.forEach(([at, level], i) => {
        ids.push(T.setTimeout(() => {
          if (cancelled) return;
          try { setLevel(level); } catch (_) {}
          if (i === frames.length - 1) resolve();
        }, at));
      });
    });
    return { done, cancel() { cancelled = true; ids.forEach((id) => T.clearTimeout(id)); } };
  }

  // 执行器登记表：register / unregister / list / actuate / stop / runReplyActs
  // 0.18：每个动作的结局经 onAct 报出（§5.12 acts 段）；adjust 改正在动的强度、skip 跳到下一个、running 列出正在动的
  //   onAct({ type: 'start' | 'end' | 'refused', source, act, t, how: 'done' | 'cut', reason, ids, heatLimit })
  //   reason（cut 时）：stop 读者全部停止 | skip | weaker（调到 0）| superseded（被新动作打断）| deadline（看门狗）| disconnected | other
  function createRegistry({ timers, now, emit, policy, log, onAct }) {
    const T = timers;
    const items = new Map();   // id → { caps, handler, lastAt, run }
    const queue = [];          // 回复里排队、还没开始的动作：{ tid, at, act, idx, source }；全部停止时一并取消
    const deltas = new Map();  // source → 读者对这条回复的强度调整（加在安全闸门之后，§5.12）
    let last = null;
    let lastOk = null;   // 块里的 device 行用最近一次成功的触发
    let groupSeq = 0;
    const report = (ev) => { if (typeof onAct === 'function') { try { onAct(ev); } catch (err) { log('onAct failed', err && err.message); } } };
    const clamp01 = (v) => Math.min(1, Math.max(0, v));
    // v0.4 §5.1：驱动区间台账。记的是**发出去的东西**（帧表 × 读者增益），不是设备确认执行的时间——
    // 多数设备不回报执行状态（v0.3 §5.9-8），所以协议就是按这个口径定义的。
    const actLog = [];

    function register(id, caps, handler) {
      if (!id || !caps || !Array.isArray(caps.outputs) || !caps.outputs.length) throw new Error('tbc.registerActuator: need (id, { outputs: [...] }, handler)');
      if (typeof handler !== 'function') throw new Error('tbc.registerActuator: handler must be a function');
      const prev = items.get(id);
      if (prev && prev.run) prev.run.cancel('other');
      items.set(String(id), { caps: Object.assign({ patterns: PATTERNS.slice(), levels: true, minIntervalMs: DEFAULT_MIN_INTERVAL_MS }, caps), handler, lastAt: prev ? prev.lastAt : null, run: null });
      emit('bio:actuators', list());
    }
    function unregister(id) {
      const it = items.get(String(id));
      if (!it) return;
      stopOne(String(id), it, 'disconnected');
      items.delete(String(id));
      if (!items.size) for (const q of queue.slice()) dropQueued(q, 'disconnected');   // 设备都没了：排队的也作废
      emit('bio:actuators', list());
    }
    function list() {
      return [...items.entries()].map(([id, it]) => Object.assign({ id }, it.caps, { busy: !!it.run }));
    }
    // 正在动的：{ id, source, act, intensity, base, startedAt, spanMs, output }
    function running() {
      const out = [];
      for (const [id, it] of items) {
        const r = it.run; if (!r) continue;
        out.push({ id, source: r.source, act: r.act, intensity: r.cur, base: r.base, startedAt: r.startedAt, spanMs: r.span, output: r.output });
      }
      return out;
    }
    // 用户关掉的执行器（policy().off）不参与匹配
    function matches(target, output) {
      const off = new Set((policy() || {}).off || []);
      if (target && target !== '*') { const it = items.get(target); return it && !off.has(target) ? [[target, it]] : []; }
      return [...items.entries()].filter(([id, it]) => !off.has(id) && ((output === '*' || !output) ? !onlyRisky(it.caps) : it.caps.outputs.includes(output)));
    }
    // 返回 handler 的停止结果（Promise）或 null：驱动直连的停止帧要等回执，失败重试后报 refused: 'stop-failed'（§5.9-9）
    function stopOne(id, it, reason) {
      if (it.run) { it.run.cancel(reason || 'stop'); it.run = null; }
      try {
        const r = it.handler({ stop: true });
        if (r && typeof r.then === 'function') return r.then((v) => v || null, (err) => ({ ok: false, refused: 'stop-failed', error: err }));
      } catch (err) { return Promise.resolve({ ok: false, refused: 'stop-failed', error: err }); }
      return null;
    }
    function dropQueued(q, reason) {
      T.clearTimeout(q.tid);
      const k = queue.indexOf(q); if (k >= 0) queue.splice(k, 1);
      report({ type: 'end', source: q.source, act: q.idx, t: now(), how: 'cut', reason, queued: true });
    }
    // reason 缺省 stop（读者全部停止）；设备侧停止由调用方写 disconnected 等
    // 停止是同步发出的；要回执的执行器（驱动直连）晚一点才知道成没成，失败的再发一条 bio:actuate（refused: 'stop-failed'，§5.9-9）
    function stop(id, reason) {
      const waits = [];
      const one = (k, it) => { const p = stopOne(k, it, reason); if (p) waits.push(p.then((r) => (r && r.ok === false && r.refused ? { id: k, ok: false, refused: r.refused } : null))); };
      if (id) { const it = items.get(String(id)); if (it) one(String(id), it); }
      else {
        for (const q of queue.slice()) dropQueued(q, reason || 'stop');
        for (const [k, it] of items) one(k, it);
      }
      emit('bio:actuate', { t: now(), target: id || '*', action: { stop: true }, results: [], source: 'stop' });
      if (waits.length) {
        Promise.all(waits).then((rs) => {
          const failed = rs.filter(Boolean);
          if (failed.length) emit('bio:actuate', { t: now(), target: id || '*', action: { stop: true }, results: failed, source: 'stop' });
        }).catch(() => {});
      }
    }

    async function actuate(target, action, opts) {
      const a = Object.assign({ output: '*', pattern: 'pulse' }, action || {});
      const o = opts || {};
      const source = o.source || 'api';
      const actIdx = Number.isInteger(o.act) ? o.act : null;
      const delta = Number.isFinite(o.delta) ? o.delta : (deltas.get(source) || 0);
      const hits = matches(target || '*', a.output);
      if (!hits.length) {
        if (actIdx != null) report({ type: 'refused', source, act: actIdx, t: now(), reason: 'unknown-target' });
        return { ok: false, refused: 'unknown-target' };
      }
      const t = now();
      const pol = policy() || {};
      const results = [];
      const group = { id: ++groupSeq, source, act: actIdx, live: 0, how: 'done', reason: null, heatLimit: false, ids: [] };
      const endRun = (how, reason, heat) => {
        group.live--;
        if (how === 'cut' && group.how !== 'cut') { group.how = 'cut'; group.reason = reason || 'other'; }
        if (heat) group.heatLimit = true;
        if (group.live === 0 && actIdx != null) report({ type: 'end', source, act: actIdx, t: now(), how: group.how, reason: group.reason, ids: group.ids, heatLimit: group.heatLimit });
      };
      for (const [id, it] of hits) {
        const g = gate({ now: t, policy: pol, caps: it.caps, lastAt: it.lastAt, action: a });
        if (g.refused) { results.push({ id, ok: false, refused: g.refused, retryInMs: g.retryInMs }); continue; }
        const cap = Math.min(it.caps.maxIntensity == null ? 1 : it.caps.maxIntensity, pol.maxIntensity == null ? 1 : pol.maxIntensity);
        const eff = delta ? Math.round(Math.min(cap, clamp01(g.intensity + delta)) * 1000) / 1000 : g.intensity;
        const frames = patternFrames(g.pattern, eff, g.durationMs, { defaultMs: pol.defaultMs });
        const span = frames[frames.length - 1][0];
        const deadline = t + span + 1000;
        if (it.run) it.run.cancel('superseded');
        it.lastAt = t;
        const heat = it.caps.outputs.includes('Temperature') && !!(g.clipped && g.clipped.durationMs);
        const gainFns = [];
        const job = { action: Object.assign({}, a, { pattern: g.pattern, intensity: eff, durationMs: g.durationMs }), frames, deadline,
          gain: () => (run.base > 0 ? run.cur / run.base : 1), onGain: (fn) => { if (typeof fn === 'function') gainFns.push(fn); } };
        let finished = false;
        const cancelInner = { cancel() {} };
        const finish = (how, reason) => {
          if (finished) return;
          finished = true; T.clearTimeout(watchdog);
          rec.to = now();
          if (items.get(id) === it && it.run === run) it.run = null;
          endRun(how, reason, how === 'done' && heat);
        };
        // v0.4 §5.1：这一路的驱动区间（未结束时 to 为 null）；outputs 取执行器登记的输出（output='*' 时就是它全部的）
        const rec = { id, source, act: actIdx, outputs: a.output === '*' ? it.caps.outputs.slice() : [a.output], from: t, to: null, frames, gain: [] };
        actLog.push(rec);
        if (actLog.length > ACT_LOG_MAX) actLog.splice(0, actLog.length - ACT_LOG_MAX);
        const run = {
          rec, source, act: actIdx, base: eff, cur: eff, cap, startedAt: t, span, output: a.output,
          cancel(reason) { if (finished) return; cancelInner.cancel(); finish('cut', reason); },
          applyGain() { for (const fn of gainFns) { try { fn(job.gain()); } catch (_) {} } },
        };
        const watchdog = T.setTimeout(() => { if (!finished) { log('watchdog stop', id); stopOne(id, it, 'deadline'); } }, span + 1000);
        it.run = run;
        group.live++; group.ids.push(id);
        Promise.resolve()
          .then(() => it.handler(Object.assign(job, { bindCancel: (fn) => { cancelInner.cancel = fn; } })))
          .then(() => finish('done'), (err) => { log('actuator failed', id, err && err.message); finish('cut', 'other'); });
        const res = { id, ok: true };
        if (g.clipped) res.clipped = g.clipped;
        if (g.fallback) res.fallback = g.fallback;
        if (delta) res.adjusted = eff;
        results.push(res);
      }
      const ok = results.some((r) => r.ok);
      last = { t, target: target || '*', action: a, results, source };
      if (actIdx != null) last.act = actIdx;
      if (ok) lastOk = last;
      emit('bio:actuate', last);
      if (actIdx != null) {
        if (ok) report({ type: 'start', source, act: actIdx, t, ids: group.ids.slice(), actObj: { pattern: a.pattern, intensity: a.intensity, durationMs: a.durationMs || null, output: a.output } });
        else report({ type: 'refused', source, act: actIdx, t, reason: results[0].refused });
      }
      if (ok) return { ok: true, results };
      return { ok: false, refused: results[0].refused, results };
    }

    // 某个动作最早什么时候能开始（各执行器的最小间隔）
    function readyAt(act) {
      const pol = policy() || {};
      const hits = matches(act.target, act.output);
      if (!hits.length) return now();
      const gap = Math.max(...hits.map(([, it]) => intervalFor(it.caps, pol)));
      return Math.max(now(), ...hits.map(([, it]) => (it.lastAt == null ? 0 : it.lastAt + gap + 50)));
    }
    function fire(q) {
      // 读者插进来的重放等占用了执行器：顺延到最小间隔允许时（最多顺延 10 秒，再不行就照常执行、由闸门拒绝）
      const ready = readyAt(q.act);
      if (ready > now() + 20 && now() - (q.firstAt || now()) < 10000) { if (!q.firstAt) q.firstAt = now(); schedule(q, ready); return; }
      const k = queue.indexOf(q); if (k >= 0) queue.splice(k, 1);
      const d = deltas.get(q.source) || 0;
      if (d < 0 && liftIntensity(q.act.intensity, (policy() || {}).floor || 0) + d <= 0) { report({ type: 'end', source: q.source, act: q.idx, t: now(), how: 'cut', reason: 'weaker', queued: true }); return; }
      actuate(q.act.target, q.act, { source: q.source, act: q.idx });
    }
    function schedule(q, at) {
      if (q.tid != null) T.clearTimeout(q.tid);
      q.at = at;
      q.tid = T.setTimeout(() => fire(q), Math.max(0, at - now()));
    }

    // 回复里的 <bio_act/>：按顺序排队，同一执行器之间等够最小间隔（一条回复最多 3 个，档位或用户可改到 5）
    function runReplyActs(acts, source) {
      const ids = [];
      let prevAt = 0;
      let prevSpan = 0;
      let first = true;
      const pol = policy() || {};
      const limit = Number.isInteger(pol.maxPerReply) ? Math.min(MAX_PER_REPLY_LIMIT, pol.maxPerReply) : MAX_PER_REPLY;
      const t0 = now();
      acts.slice(0, limit).forEach((act, idx) => {
        const hits = matches(act.target, act.output);
        if (!hits.length) { report({ type: 'refused', source, act: idx, t: t0, reason: 'unknown-target' }); return; }
        const gap = Math.max(...hits.map(([, it]) => intervalFor(it.caps, pol)));
        const ready = Math.max(0, ...hits.map(([, it]) => (it.lastAt == null ? 0 : it.lastAt + gap - now() + 50)));
        const at = first ? ready : Math.max(ready, prevAt + Math.max(gap, prevSpan + 300) + 50);
        const frames = patternFrames(act.pattern, act.intensity, act.durationMs, { defaultMs: pol.defaultMs });
        const q = { tid: null, at: 0, act, idx, source };
        queue.push(q);
        schedule(q, t0 + at);
        ids.push(q);
        prevAt = at; prevSpan = frames[frames.length - 1][0]; first = false;
      });
      return { scheduled: ids.length, cancel() { ids.forEach((q) => { if (queue.includes(q)) dropQueued(q, 'stop'); }); } };
    }

    // 读者调强 / 调弱（百分点，−1…1）：正在动的立即改；同一回复里还没开始的动作也按这个量执行；调到 0 等于停下这一个
    function adjust(delta, source) {
      const d = Number(delta) || 0;
      let n = 0; let level = null; const cut = [];
      for (const [id, it] of items) {
        const r = it.run;
        if (!r || (source && r.source !== source)) continue;
        n++;
        r.cur = Math.round(Math.min(r.cap, clamp01(r.cur + d)) * 1000) / 1000;
        level = r.cur;
        if (r.rec) r.rec.gain.push([now(), r.base > 0 ? r.cur / r.base : 0]);   // v0.4 §5.1：发出去的强度要算上读者的调整
        if (r.cur <= 0) { cut.push(r.act); stopOne(id, it, 'weaker'); } else r.applyGain();
      }
      if (source) deltas.set(source, Math.max(-1, Math.min(1, (deltas.get(source) || 0) + d)));
      return { running: n, queued: queue.filter((q) => !source || q.source === source).length, level, cut };
    }
    // 跳过：停掉正在动的（没有在动时跳过下一个排队的），后面排队的提前到最小间隔允许的时刻
    function skip(source) {
      const skipped = [];
      for (const [id, it] of items) {
        const r = it.run;
        if (!r || (source && r.source !== source)) continue;
        if (!skipped.some((x) => x.source === r.source && x.act === r.act)) skipped.push({ source: r.source, act: r.act });
        stopOne(id, it, 'skip');
      }
      const rest = queue.filter((q) => !source || q.source === source).sort((a, b) => a.at - b.at);
      if (!skipped.length && rest.length) { const q = rest.shift(); skipped.push({ source: q.source, act: q.idx }); dropQueued(q, 'skip'); }
      if (rest.length) {
        const shift = rest[0].at - readyAt(rest[0].act);
        if (shift > 0) for (const q of rest) schedule(q, q.at - shift);
      }
      return { skipped, next: rest.length ? rest[0].idx : null };
    }

    return { register, unregister, list, actuate, stop, runReplyActs, adjust, skip, running,
      pending: () => queue.length, queued: () => queue.map((q) => ({ source: q.source, act: q.idx, at: q.at })),
      delta: (source) => deltas.get(source) || 0, last: () => last, lastOk: () => lastOk,
      // v0.4 §5.1：从 sinceT 之后有重叠的驱动区间（未结束的 to 为 null），给相位统计用
      actuations: (sinceT) => actLog.filter((r) => sinceT == null || r.to == null || r.to >= sinceT)
        .map((r) => ({ id: r.id, source: r.source, act: r.act, outputs: r.outputs.slice(), from: r.from, to: r.to, frames: r.frames.map((f) => f.slice()), gain: r.gain.map((g) => g.slice()) })) };
  }

  // ---------- Intiface / buttplug ----------
  // 设备特性 → 执行器描述：[{ key, deviceIndex, featureIndex, output, min, max, name, gapMs }]
  function featuresFromDeviceList(devices, version) {
    const out = [];
    if (version >= 4) {
      for (const d of Object.values(devices || {})) {
        for (const f of Object.values(d.DeviceFeatures || {})) {
          // v4 §InputCmd：能读电量的特性单独记下（不是输出，不登记执行器）
          if (f.Input && f.Input.Battery && (f.Input.Battery.Command || []).includes('Read')) {
            out.push({ key: `intiface:${d.DeviceIndex}:${f.FeatureIndex}:Battery`, deviceIndex: d.DeviceIndex, featureIndex: f.FeatureIndex, input: 'Battery', name: d.DeviceDisplayName || d.DeviceName });
          }
          // v0.4 §5.6：玩具自带的压力 / 按键（能订阅的才要；单位不标准，只当相对变化用）
          for (const kind of TOY_SENSORS) {
            const inf = f.Input && f.Input[kind];
            if (!inf || !(inf.Command || []).includes('Subscribe')) continue;
            out.push({ key: `intiface:${d.DeviceIndex}:${f.FeatureIndex}:${kind}`, deviceIndex: d.DeviceIndex, featureIndex: f.FeatureIndex, input: kind, name: d.DeviceDisplayName || d.DeviceName, feature: f.FeatureDescription || '' });
          }
          const outs = Object.entries(f.Output || {}).filter(([o]) => OUTPUTS.includes(o) && o !== '*');
          const hasHw = outs.some(([o]) => o === 'HwPositionWithDuration');
          for (const [output, info] of outs) {
            if (output === 'Position' && hasHw) continue;   // 同一特性优先用带时长的位置命令
            const range = (info && info.Value) || [0, 1];
            const position = output === 'HwPositionWithDuration' || output === 'Position';
            out.push({ key: `intiface:${d.DeviceIndex}:${f.FeatureIndex}:${output}`, deviceIndex: d.DeviceIndex, featureIndex: f.FeatureIndex, output, min: range[0], max: range[1], duration: (info && info.Duration) || null, mode: position ? 'position' : 'level', name: d.DeviceDisplayName || d.DeviceName, feature: f.FeatureDescription || '', gapMs: d.DeviceMessageTimingGap || 0 });
          }
        }
      }
    } else {
      for (const d of devices || []) {
        (((d.DeviceMessages || {}).ScalarCmd) || []).forEach((s, idx) => {
          if (!OUTPUTS.includes(s.ActuatorType)) return;
          out.push({ key: `intiface:${d.DeviceIndex}:${idx}:${s.ActuatorType}`, deviceIndex: d.DeviceIndex, featureIndex: idx, output: s.ActuatorType, min: 0, max: s.StepCount || 1, mode: 'level', name: d.DeviceDisplayName || d.DeviceName, feature: s.FeatureDescriptor || '', gapMs: d.DeviceMessageTimingGap || 0 });
        });
      }
    }
    return out;
  }

  function levelMessage(version, id, f, level) {
    const L = Math.max(0, Math.min(1, level));
    if (version >= 4) {
      const value = Math.floor(L * f.max + 1e-9);   // 向下取整：档位少的设备也不会超过用户上限；双向（Rotate）只用正方向
      return { OutputCmd: { Id: id, DeviceIndex: f.deviceIndex, FeatureIndex: f.featureIndex, Command: { [f.output]: { Value: value } } } };
    }
    return { ScalarCmd: { Id: id, DeviceIndex: f.deviceIndex, Scalars: [{ Index: f.featureIndex, Scalar: Math.round(L * 1000) / 1000, ActuatorType: f.output }] } };
  }
  // 按位置控制（抽动类）：v4 才有；位置 0–1 换算到值域
  function positionMessage(version, id, f, pos, durationMs) {
    if (version < 4) return null;
    const value = Math.round(f.min + Math.max(0, Math.min(1, pos)) * (f.max - f.min));
    if (f.output === 'Position') return { OutputCmd: { Id: id, DeviceIndex: f.deviceIndex, FeatureIndex: f.featureIndex, Command: { Position: { Value: value } } } };
    const dr = f.duration || [0, 100000];
    const d = Math.max(dr[0], Math.min(dr[1], Math.round(durationMs)));
    return { OutputCmd: { Id: id, DeviceIndex: f.deviceIndex, FeatureIndex: f.featureIndex, Command: { HwPositionWithDuration: { Value: value, Duration: d } } } };
  }
  // 抽动器：把强度（0–1）换算成往返速度。强度 1 ≈ 0.4 秒一个来回，接近 0 ≈ 1.5 秒；0 = 回到起点并停
  function strokePeriod(level) { return Math.round(1500 - 1100 * Math.max(0, Math.min(1, level))); }
  function createStroker({ move, timers }) {
    const T = timers;
    let level = 0; let timer = null; let up = false;
    function tick() {
      timer = null;
      if (level <= 0) return;
      const half = Math.round(strokePeriod(level) / 2);
      up = !up;
      move(up ? 0.95 : 0.05, half);
      timer = T.setTimeout(tick, half);
    }
    return {
      setLevel(l) {
        const prev = level;
        level = Math.max(0, Math.min(1, l));
        if (level <= 0) { if (timer) { T.clearTimeout(timer); timer = null; } if (prev > 0) move(0, 400); return; }
        if (!timer) tick();
      },
      stop() { level = 0; if (timer) { T.clearTimeout(timer); timer = null; } move(0, 400); },
      level: () => level,
    };
  }

  function stopMessage(version, id, f) {
    if (version >= 4) return f ? { StopCmd: { Id: id, DeviceIndex: f.deviceIndex, FeatureIndex: f.featureIndex, Inputs: false, Outputs: true } } : { StopCmd: { Id: id, Inputs: false, Outputs: true } };
    return f ? { StopDeviceCmd: { Id: id, DeviceIndex: f.deviceIndex } } : { StopAllDevices: { Id: id } };
  }

  // 客户端：connect() / close() / setLevel(feature, level) / stop(feature?) / status()
  function createIntifaceClient({ WebSocket, url, clientName, timers, onFeatures, onStatus, onInput, log }) {
    const T = timers;
    let ws = null;
    let version = 4;
    let id = 0;
    let ping = null;
    let features = [];
    let status = 'idle';
    let closedByUser = false;
    let retry = 0;
    const pending = new Map();
    const setStatus = (s, detail) => { status = s; onStatus && onStatus(s, detail); };
    const send = (msg) => { if (ws && ws.readyState === 1) { ws.send(JSON.stringify([msg])); return true; } return false; };
    const request = (build) => new Promise((resolve, reject) => {
      const mid = ++id;
      const to = T.setTimeout(() => { pending.delete(mid); reject(new Error('timeout')); }, 4000);
      pending.set(mid, { resolve: (v) => { T.clearTimeout(to); resolve(v); }, reject: (e) => { T.clearTimeout(to); reject(e); } });
      if (!send(build(mid))) { pending.delete(mid); T.clearTimeout(to); reject(new Error('not connected')); }
    });
    function applyDeviceList(devices) {
      features = featuresFromDeviceList(devices, version);
      onFeatures && onFeatures(features.slice());
    }
    function onMessage(ev) {
      let arr;
      try { arr = JSON.parse(ev.data); } catch (_) { return; }
      for (const msg of Array.isArray(arr) ? arr : [arr]) {
        const [type, body] = Object.entries(msg)[0] || [];
        if (!type) continue;
        const p = body && body.Id ? pending.get(body.Id) : null;
        if (type === 'Error') { if (p) { pending.delete(body.Id); p.reject(new Error(body.ErrorMessage || 'error')); } else log('intiface error', body && body.ErrorMessage); continue; }
        if (type === 'DeviceList') { applyDeviceList(body.Devices); if (p) { pending.delete(body.Id); p.resolve(body); } continue; }
        if (type === 'DeviceAdded' || type === 'DeviceRemoved') { request((mid) => ({ RequestDeviceList: { Id: mid } })).catch(() => {}); continue; }
        // v4 服务器主动推送的传感器读数（Id 为 0）：Read 的回复照常走 pending
        if (type === 'InputReading' && !p && typeof onInput === 'function') {
          const kind = Object.keys(body.Reading || {})[0];
          const value = body.Reading && body.Reading[kind] && body.Reading[kind].Value;
          if (TOY_SENSORS.includes(kind) && Number.isFinite(value)) {
            try { onInput({ deviceIndex: body.DeviceIndex, featureIndex: body.FeatureIndex, input: kind, value, t: Date.now() }); } catch (err) { log('onInput failed', err && err.message); }
          }
          continue;
        }
        if (p) { pending.delete(body.Id); p.resolve(body); }
      }
    }
    function open(v) {
      version = v;
      setStatus('connecting');
      let sock;
      try { sock = new WebSocket(url); } catch (err) { setStatus('error', String(err && err.message || err)); return; }
      ws = sock;
      sock.onmessage = onMessage;
      sock.onopen = async () => {
        try {
          const info = await request((mid) => ({ RequestServerInfo: v >= 4
            ? { Id: mid, ClientName: clientName, ProtocolVersionMajor: 4, ProtocolVersionMinor: 0 }
            : { Id: mid, ClientName: clientName, MessageVersion: 3 } }));
          retry = 0;
          const maxPing = info.MaxPingTime || 0;
          if (maxPing > 0) ping = T.setInterval(() => request((mid) => ({ Ping: { Id: mid } })).catch(() => {}), Math.max(200, Math.floor(maxPing / 2)));
          setStatus('connected', { server: info.ServerName || '', version: v });
          await request((mid) => ({ RequestDeviceList: { Id: mid } }));
          request((mid) => ({ StartScanning: { Id: mid } })).catch(() => {});
        } catch (err) {
          if (v >= 4) { log('intiface v4 handshake failed, trying v3', err && err.message); try { sock.onclose = null; sock.close(); } catch (_) {} ws = null; open(3); return; }
          setStatus('error', String(err && err.message || err));
          try { sock.close(); } catch (_) {}
        }
      };
      sock.onclose = () => {
        if (ping) { T.clearInterval(ping); ping = null; }
        for (const [, p] of pending) p.reject(new Error('closed'));
        pending.clear();
        const had = features.length;
        features = [];
        if (had) onFeatures && onFeatures([]);
        if (ws === sock) ws = null;
        if (closedByUser) { setStatus('idle'); return; }
        setStatus('disconnected');
        const delay = [2000, 5000, 15000, 30000][Math.min(retry++, 3)];
        T.setTimeout(() => { if (!closedByUser && !ws) open(4); }, delay);
      };
      sock.onerror = () => {};
    }
    return {
      connect() { closedByUser = false; if (!ws) open(4); },
      close() { closedByUser = true; try { if (ws) { send(stopMessage(version, ++id, null)); ws.close(); } } catch (_) {} ws = null; },
      setLevel(f, level) { return send(levelMessage(version, ++id, f, level)); },
      setPosition(f, pos, durationMs) { const m = positionMessage(version, ++id, f, pos, durationMs); return m ? send(m) : false; },
      stop(f) { return send(stopMessage(version, ++id, f || null)); },
      // v4：读电量（InputCmd Read → InputReading）；v3 没有这条消息
      async readBattery(f) {
        if (version < 4 || !f || f.input !== 'Battery') return null;
        const r = await request((mid) => ({ InputCmd: { Id: mid, DeviceIndex: f.deviceIndex, FeatureIndex: f.featureIndex, Type: 'Battery', Command: 'Read' } }));
        const v = r && r.Reading && r.Reading.Battery && r.Reading.Battery.Value;
        return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null;
      },
      // v0.4 §5.6：订阅 / 退订玩具上的传感器（v4 的 InputCmd；v3 没有这条消息）
      subscribeInput(f, on) {
        if (version < 4 || !f || !TOY_SENSORS.includes(f.input)) return Promise.resolve(false);
        return request((mid) => ({ InputCmd: { Id: mid, DeviceIndex: f.deviceIndex, FeatureIndex: f.featureIndex, Type: f.input, Command: on === false ? 'Unsubscribe' : 'Subscribe' } }))
          .then(() => true, () => false);
      },
      status: () => ({ status, version, features: features.length, url }),
    };
  }

  return { OUTPUTS, PATTERNS, NATIVE_PATTERN, resolveNative, RISKY_OUTPUTS, MAX_PER_REPLY, MAX_PER_REPLY_LIMIT, DEFAULT_MS, PROFILES, DEFAULT_PROFILE, resolveSettings, liftIntensity, BIO_ACT_TAG_RE, stripNonActionText, hideBioActs, parseBioActs, patternFrames, gate, playFrames, createRegistry, featuresFromDeviceList, levelMessage, positionMessage, stopMessage, strokePeriod, createStroker, createIntifaceClient };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = HeartlinkHaptics;

// heartlink：按 TBC 驱动直连浏览器蓝牙设备（不经 buttplug wasm）。
// 生成文件，不要手改：改 ../device-lab 之后跑 `node scripts/sync-drivers.mjs`。
// 源（device-lab，本地仓库）：
//   engine/driver.mjs  sha256:c645a10fe4a8b2e7b1baa57f1e7a0ebb4db94239db0a564f271c84286c35d118
//   transports/web-bluetooth/driver-link.mjs  sha256:981d8eea232457da09b22a3fa67f451e882ecc55f2f26178527ed30a67bd406f
//   transports/tbc-direct/register.mjs  sha256:d6f81bbac52321fd53e4033f52b53244395b9b99ae6fffb497d8b6d1958f77ba
//   drivers/*.json → DRIVERS（精简成运行时字段；funf-bobobei、svakom-sl278h）
const HeartlinkDrivers = (() => {
  'use strict';

  // ===== device-lab/engine/driver.mjs =====
  // 驱动描述（drivers/*.json）的读取、校验、编码与解码。纯函数，Node 与浏览器都能用。
  // 帧模板是空格分隔的十六进制字节，占位符：{level} 档位、{mode} 模式、{temp} 温度（℃）、{seq} 序号（每帧递增，设备不校验时解码忽略）、
  // {cmd} 指令号（只在通知模板里）。
  // TBC v0.3 §5.9：强度 0 一律发停止帧；档位按强度 × 最大档位向下取整。

  const FORMAT = 'tbc-device-lab/driver@1';
  const OUTPUTS = ['Vibrate', 'Rotate', 'Oscillate', 'Constrict', 'Spray', 'Temperature', 'Led', 'Position', 'HwPositionWithDuration', 'Estim'];
  // 缺省视为有风险的输出：`output="*"` 不会驱动它们，必须点名（§5.9-6）
  const RISKY_OUTPUTS = ['Temperature', 'Estim', 'Spray'];
  const PATTERNS = ['pulse', 'double', 'triple', 'long', 'heartbeat', 'wave'];
  const PLACEHOLDERS = ['level', 'mode', 'temp', 'cmd', 'seq'];
  // 设备外形（没有产品图时画对应线稿，见 assets/shapes/）
  const SHAPES = ['egg', 'wand', 'rabbit', 'suction', 'plug', 'band', 'stroker', 'prostate'];
  // 经 Intiface 的状态：official = buttplug 官方配置里有这台；unverified = 模拟器暴露了，但官方配置里没有或字节不同；none = 不支持
  const INTIFACE_STATUS = ['official', 'unverified', 'none'];

  // 缺省外形：写了 shape 用它；否则按输出猜（往复 + 振动 → 兔耳，只有收缩/吮吸 → 吮吸，男用 → 飞机杯），猜不出用按摩棒
  function guessShape(d) {
    if (d && SHAPES.includes(d.shape)) return d.shape;
    const outs = new Set(((d && d.parts) || []).map((p) => p.output));
    if (d && d.group === '男用') return 'stroker';
    if (outs.has('Oscillate') && outs.has('Vibrate')) return 'rabbit';
    if (outs.size && [...outs].every((o) => o === 'Constrict')) return 'suction';
    return 'wand';
  }

  function normUuid(u) {
    const s = String(u || '').toLowerCase();
    return /^[0-9a-f]{4}$/.test(s) ? `0000${s}-0000-1000-8000-00805f9b34fb` : s;
  }

  function parseTemplate(t) {
    return String(t).trim().split(/\s+/).map((tok) => {
      const m = /^\{(\w+)\}$/.exec(tok);
      if (m) {
        if (!PLACEHOLDERS.includes(m[1])) throw new Error(`未知占位符 ${tok}`);
        return { ph: m[1] };
      }
      if (!/^[0-9a-fA-F]{2}$/.test(tok)) throw new Error(`不是十六进制字节：${tok}`);
      return { lit: parseInt(tok, 16) };
    });
  }

  function toHex(bytes) {
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  }
  function fromHex(s) {
    return Uint8Array.from(String(s).trim().split(/\s+/).map((x) => parseInt(x, 16)));
  }

  // 握手：旧格式是帧数组（只预留）；新格式 { frames, delayMs, expectNotify, timeoutMs }
  function handshakeOf(d) {
    const h = d && d.handshake;
    if (!h || Array.isArray(h)) return { frames: (h || []).slice(), delayMs: 0, expectNotify: 0, timeoutMs: 0, replyEveryMs: 0, required: false };
    return {
      frames: (h.frames || []).slice(),
      delayMs: h.delayMs || 0,
      expectNotify: h.expectNotify || 0,
      timeoutMs: h.timeoutMs || 0,
      replyEveryMs: h.replyEveryMs ?? 100,
      required: h.required !== false && (h.frames || []).length > 0,
    };
  }
  // 连接特性（§5.9-7、-8）与写入节奏
  function connectionOf(d) {
    const c = (d && d.connection) || {};
    return { exclusive: !!c.exclusive, stopsOnDisconnect: !!c.stopsOnDisconnect, writeGapMs: c.writeGapMs || 0, ackTimeoutMs: c.ackTimeoutMs || 3000, officialApp: c.officialApp || '官方 App' };
  }
  function intifaceStatus(d) {
    const t = d && d.transports && d.transports.intiface;
    return (t && t.status) || 'unverified';
  }
  // {seq} 计数器：从 start 起，到 max 后回到 start
  function createSeq(d) {
    const s = (d && d.seq) || {};
    const start = s.start ?? 1;
    const max = s.max ?? 255;
    let cur = start;
    return {
      next() { const v = cur; cur = cur >= max ? start : cur + 1; return v; },
      peek: () => cur,
      reset() { cur = start; },
    };
  }

  function fill(tokens, vals) {
    return Uint8Array.from(tokens.map((x) => (x.lit != null ? x.lit : (vals[x.ph] ?? 0) & 0xff)));
  }
  const seqDefault = (d) => (d.seq && d.seq.start != null ? d.seq.start : 1);

  // 只含字面值与 {seq} 的帧（握手、停止帧）
  function literalFrame(d, template, seq) {
    return fill(parseTemplate(template), { seq: seq ?? seqDefault(d) });
  }
  function handshakeFrames(d, seq) {
    return handshakeOf(d).frames.map((f, i) => literalFrame(d, f, typeof seq === 'function' ? seq() : (seq ?? seqDefault(d)) + i));
  }
  // 按模板比对：占位符不比（记下取值）；skip 里的字面字节也不比（严格字节另判）
  function matchTokens(tokens, b, skip) {
    if (tokens.length !== b.length) return null;
    const got = {};
    for (let i = 0; i < tokens.length; i++) {
      const x = tokens[i];
      if (x.lit == null) { got[x.ph] = b[i]; continue; }
      if (skip && skip.has(i)) continue;
      if (x.lit !== b[i]) return null;
    }
    return got;
  }
  function isHandshake(d, bytes) {
    const b = [...bytes];
    return handshakeOf(d).frames.some((f) => matchTokens(parseTemplate(f), b) != null);
  }

  function checkNative(where, n, output, need) {
    if (!n || typeof n !== 'object') { need(false, `${where}: 应为对象`); return; }
    if (n.mode != null) need(Number.isInteger(n.mode) || typeof n.mode === 'string', `${where}: mode 应为整数或字符串`);
    if (n.stoppable === false) {
      need(Number.isInteger(n.maxDurationMs) && n.maxDurationMs > 0, `${where}: 停不下来的自带模式必须写 maxDurationMs（设备自身的最长运行时间，§5.9-5）`);
      need(!RISKY_OUTPUTS.includes(output), `${where}: ${output} 是有风险的输出，它的自带模式必须能被 0 停下（§5.9-5）`);
    }
  }

  // 返回错误数组；空数组 = 合格
  function validateDriver(d) {
    const errors = [];
    const need = (cond, msg) => { if (!cond) errors.push(msg); };
    need(d && d.format === FORMAT, `format 应为 ${FORMAT}`);
    if (!d) return errors;
    need(typeof d.id === 'string' && /^[a-z0-9-]+$/.test(d.id), 'id 只能用小写字母、数字、连字符');
    need(d.ble && d.ble.service && d.ble.write, 'ble.service 与 ble.write 必填');
    need(Array.isArray(d.parts) && d.parts.length > 0, 'parts 至少一个');
    if (d.shape != null) need(SHAPES.includes(d.shape), `shape 只能是 ${SHAPES.join(' / ')}`);
    const sourceIds = new Set((d.sources || []).map((s) => s.id));
    const srcOk = (where, list) => { for (const s of list || []) need(sourceIds.has(s), `${where}: 来源 ${s} 没有在 sources 里登记`); };
    let usesSeq = false;
    const tpl = (where, t, allowed) => {
      try {
        const toks = parseTemplate(t);
        if (toks.some((x) => x.ph === 'seq')) usesSeq = true;
        need(toks.every((x) => x.lit != null || allowed.includes(x.ph)), /停止帧$/.test(where) ? `${where}不能有占位符（{seq} 除外）` : `${where}: 占位符只能用 ${allowed.map((a) => `{${a}}`).join(' ')}`);
        return toks;
      } catch (e) { errors.push(`${where}: ${e.message}`); return null; }
    };
    // 握手
    if (d.handshake != null && !Array.isArray(d.handshake)) {
      const h = d.handshake;
      need(Array.isArray(h.frames) && h.frames.length > 0, 'handshake.frames 至少一帧');
      (h.frames || []).forEach((f, i) => tpl(`handshake.frames[${i}]`, f, ['seq']));
      if (h.expectNotify != null) need(Number.isInteger(h.expectNotify) && h.expectNotify >= 0, 'handshake.expectNotify 应为非负整数');
      if (h.expectNotify) need(Number.isInteger(h.timeoutMs) && h.timeoutMs > 0, 'handshake.timeoutMs 必填（等通知要有超时）');
      if (h.delayMs != null) need(Number.isInteger(h.delayMs) && h.delayMs >= 0, 'handshake.delayMs 应为非负整数');
      srcOk('handshake', h.sources);
    } else (d.handshake || []).forEach((f, i) => tpl(`handshake[${i}]`, f, ['seq']));
    if (d.connection != null) {
      const c = d.connection;
      for (const k of ['exclusive', 'stopsOnDisconnect']) if (c[k] != null) need(typeof c[k] === 'boolean', `connection.${k} 应为 true / false`);
      for (const k of ['writeGapMs', 'ackTimeoutMs']) if (c[k] != null) need(Number.isInteger(c[k]) && c[k] >= 0, `connection.${k} 应为非负整数`);
      srcOk('connection', c.sources);
    }
    if (d.transports && d.transports.intiface) {
      need(INTIFACE_STATUS.includes(d.transports.intiface.status), `transports.intiface.status 只能是 ${INTIFACE_STATUS.join(' / ')}`);
      srcOk('transports.intiface', d.transports.intiface.sources);
    }
    const ids = new Set();
    for (const p of d.parts || []) {
      const where = `parts.${p.id}`;
      need(p.id && !ids.has(p.id), `${where}: id 缺失或重复`);
      ids.add(p.id);
      need(OUTPUTS.includes(p.output), `${where}: output 不是 TBC 输出类型`);
      need(Number.isInteger(p.steps) && p.steps >= 1, `${where}: steps 应为正整数`);
      const t = tpl(where, p.template, ['level', 'mode', 'temp', 'seq']);
      const s = tpl(`${where}: 停止帧`, p.stop, ['seq']);
      if (t) need(t.some((x) => x.ph === 'level' || x.ph === 'temp'), `${where}: 模板里要有 {level} 或 {temp}`);
      if (t && s) need(s.length === t.length, `${where}: 停止帧与模板长度不同`);
      if (p.mode) need(Array.isArray(p.mode.range) && p.mode.range.length === 2, `${where}: mode.range 应为 [最小, 最大]`);
      if (RISKY_OUTPUTS.includes(p.output)) need(Number.isInteger(p.maxDurationMs) && p.maxDurationMs > 0, `${where}: ${p.output} 必须写 maxDurationMs（§5.9）`);
      if (p.risky) need(RISKY_OUTPUTS.includes(p.output), `${where}: 标了 risky，但 ${p.output} 不在 ${RISKY_OUTPUTS.join(' / ')} 里——只有这三类会被要求点名（§5.9-6）`);
      if (p.keepaliveMs != null) need(Number.isInteger(p.keepaliveMs) && p.keepaliveMs > 0, `${where}: keepaliveMs 应为正整数`);
      if (p.nativePatterns != null) {
        for (const [k, n] of Object.entries(p.nativePatterns)) {
          need(PATTERNS.includes(k), `${where}.nativePatterns: ${k} 不是抽象模式（${PATTERNS.join(' / ')}）`);
          checkNative(`${where}.nativePatterns.${k}`, n, p.output, need);
          srcOk(`${where}.nativePatterns.${k}`, n && n.sources);
        }
      }
      for (const [i, n] of (p.nativeModes || []).entries()) {
        checkNative(`${where}.nativeModes[${i}]`, n, p.output, need);
        srcOk(`${where}.nativeModes[${i}]`, n && n.sources);
      }
      for (const q of p.stopClears || []) need((d.parts || []).some((x) => x.id === q), `${where}: stopClears 里的 ${q} 不是部件`);
      srcOk(where, p.sources);
    }
    if (usesSeq) need(d.seq && Number.isInteger(d.seq.start) && Number.isInteger(d.seq.max) && d.seq.max >= d.seq.start, '模板用了 {seq}，要写 seq: { start, max }');
    return errors;
  }

  function part(d, id) {
    const p = d.parts.find((x) => x.id === id);
    if (!p) throw new Error(`驱动 ${d.id} 没有部件 ${id}`);
    return p;
  }

  // 强度 0–1 → 字节帧；opts：{ mode, seq }
  function encode(d, partId, level, opts) {
    const p = part(d, partId);
    const o = opts || {};
    const L = Math.max(0, Math.min(1, Number(level) || 0));
    const value = Math.floor(L * p.steps + 1e-9);
    const seq = o.seq ?? seqDefault(d);
    if (value === 0) return literalFrame(d, p.stop, seq);
    const mode = o.mode ?? (p.mode ? p.mode.default : 0);
    return fill(parseTemplate(p.template), { level: value, mode, temp: (p.temp && p.temp.celsius) || 0, seq });
  }

  // 字节帧 → { part, value, level, mode, stop, seq? } 或 { error }
  function decode(d, bytes) {
    const b = [...bytes];
    for (const p of d.parts) {
      const stop = parseTemplate(p.stop);
      const got = matchTokens(stop, b);   // 占位符（{seq}）不比
      if (got) return Object.assign({ part: p.id, value: 0, level: 0, mode: 0, stop: true }, got.seq != null ? { seq: got.seq } : {});
    }
    for (const p of d.parts) {
      const t = parseTemplate(p.template);
      if (t.length !== b.length) continue;
      const strictIdx = new Set((p.strict || []).map((s) => s.index));
      // 严格字节单独判断：其它字节都对上、只有它不对时，报 strict（设备会整帧忽略）
      const got = matchTokens(t, b, strictIdx);
      if (!got) continue;
      for (const s of p.strict || []) if (b[s.index] !== s.equals) return { error: 'strict', part: p.id, reason: s.reason };
      const seqExtra = got.seq != null ? { seq: got.seq } : {};
      if (p.mode && got.mode != null && got.level) {
        const [lo, hi] = p.mode.range;
        if (got.mode < lo || got.mode > hi) return { error: 'mode-range', part: p.id, reason: `模式 ${got.mode} 超出 ${lo}–${hi}` };
      }
      if (got.temp != null) return Object.assign({ part: p.id, value: got.temp ? 1 : 0, level: got.temp ? 1 : 0, temp: got.temp, stop: !got.temp }, seqExtra);
      const value = got.level ?? 0;
      if (value > p.steps) return { error: 'level-range', part: p.id, reason: `档位 ${value} 超出 0–${p.steps}` };
      return Object.assign({ part: p.id, value, level: value / p.steps, mode: got.mode ?? 0, stop: value === 0 }, seqExtra);
    }
    return { error: 'unknown-frame' };
  }

  // 设备状态通知帧（没有通知模板时返回 null）
  function notifyFrame(d, partId, mode, value) {
    if (!d.notify) return null;
    const cmd = parseTemplate(part(d, partId).template)[1];
    return fill(parseTemplate(d.notify.template), { cmd: cmd && cmd.lit != null ? cmd.lit : 0, mode: mode || 0, level: value || 0 });
  }

  // 模板里占位符所在的字节位置（页面加粗显示）
  function placeholderIndexes(template) {
    return parseTemplate(template).flatMap((x, i) => (x.ph ? [i] : []));
  }

  // 状态通知帧 → { part, mode, value } 或 null（对不上模板）
  function decodeNotify(d, bytes) {
    if (!d.notify) return null;
    const got = matchTokens(parseTemplate(d.notify.template), [...bytes]);
    if (!got) return null;
    const p = d.parts.find((x) => { const c = parseTemplate(x.template)[1]; return c && c.lit === got.cmd; });
    return { part: p ? p.id : null, mode: got.mode ?? 0, value: got.level ?? 0 };
  }

  // 给 TBC 执行器能力用的自带模式表（§5.9-5）：只收能被 0 停下的；allowUnstoppable 为 true 时也收停不下来的（用户逐台开启后）
  function nativePatternCaps(p, allowUnstoppable) {
    const out = {};
    for (const [k, n] of Object.entries(p.nativePatterns || {})) {
      if (n.stoppable === false && !allowUnstoppable) continue;
      out[k] = n.mode ?? k;
    }
    return out;
  }

  // ===== device-lab/transports/web-bluetooth/driver-link.mjs =====
  // 按驱动描述连一台网页蓝牙设备（真 navigator.bluetooth 或 transports/web-bluetooth-mock 的假货都行）。
  // 这是 heartlink 以后“按驱动直连”要做的事的参考实现：
  //   1. requestOptions(driver)：按名字前缀过滤；optionalServices 只放控制服务与标准服务，永远不放 forbidden（固件升级口）
  //   2. connectDriver(driver, device, { onHandshake })：连接 → 订阅通知 → 等 delayMs → 发握手帧 → 等 expectNotify 条通知（超时就断开并报 HANDSHAKE_TIMEOUT）
  //      onHandshake 可选，进度回调：({ phase: 'sent'|'notify'|'ready'|'timeout', got, need }) => void，不抛也不影响握手；
  //      超时错误上也带 err.got / err.need，UI 可以说“只收到 2/4”
  //   3. link.write(bytes)：按驱动的写法（带 / 不带回执）逐帧串行发，帧间隔 writeGapMs，回执超时 ackTimeoutMs
  //      bytes 也可以是函数：轮到它发时才调用取字节（调用方用它合并同一部件还没发出的帧）
  //   4. 独占设备连不上时报 EXCLUSIVE_BUSY（“先断开官方 App”），不自动重试抢占（§5.9-7）
  // 错误一律是 LinkError { code, message }：EXCLUSIVE_BUSY / OUT_OF_RANGE / CONNECT_FAILED / HANDSHAKE_TIMEOUT / ACK_TIMEOUT / WRITE_FAILED / NOT_CONNECTED

  class LinkError extends Error {
    constructor(code, message, cause) { super(message); this.name = 'LinkError'; this.code = code; if (cause) this.cause = cause; }
  }

  function requestOptions(driver) {
    const b = driver.ble;
    const forbidden = new Set((b.forbidden || []).map(normUuid));
    const services = [b.service, ...(b.extraServices || []).map((s) => s.service)].map(normUuid).filter((u) => !forbidden.has(u));
    const filter = driver.namePrefix ? { namePrefix: driver.namePrefix } : { services: [normUuid(b.service)] };
    return { filters: [filter], optionalServices: services };
  }

  function timersOf(o) {
    return o.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id) };
  }

  async function connectDriver(driver, device, opts) {
    const o = opts || {};
    const T = timersOf(o);
    const hs = handshakeOf(driver);
    const conn = connectionOf(driver);
    const seq = o.seq || createSeq(driver);
    const gapMs = o.writeGapMs ?? conn.writeGapMs;
    const ackTimeoutMs = o.ackTimeoutMs ?? conn.ackTimeoutMs;
    const sleep = (ms) => (ms > 0 ? new Promise((r) => T.setTimeout(r, ms)) : Promise.resolve());
    const emitHandshake = (info) => { if (o.onHandshake) { try { o.onHandshake(info); } catch (_) {} } };
    const onNotify = new Set();
    const onDown = new Set();
    const b = driver.ble;
    const withResponse = b.writeWithoutResponse === false;
    let server;
    try {
      server = await device.gatt.connect();
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/no longer in range/i.test(msg)) throw new LinkError('OUT_OF_RANGE', `连不上 ${driver.model}：设备不在范围内或没开机。`, e);
      if (conn.exclusive || (e && e.lab && e.lab.code === 'busy')) {
        throw new LinkError('EXCLUSIVE_BUSY', `连不上 ${driver.model}：这台设备同时只接受一个连接。先断开${conn.officialApp}（在手机上彻底退出，或关掉手机蓝牙），再点连接；不会自动重试抢占。`, e);
      }
      throw new LinkError('CONNECT_FAILED', `连不上 ${driver.model}：${msg}`, e);
    }
    let alive = true;
    const handleDown = () => {
      if (!alive) return;
      alive = false;
      for (const fn of [...onDown]) { try { fn(); } catch (_) {} }
    };
    device.addEventListener('gattserverdisconnected', handleDown);
    let tx;
    let rx = null;
    try {
      const svc = await server.getPrimaryService(normUuid(b.service));
      tx = await svc.getCharacteristic(normUuid(b.write));
      if (b.notify) {
        rx = await svc.getCharacteristic(normUuid(b.notify));
        rx.addEventListener('characteristicvaluechanged', (ev) => {
          const v = ev.target.value;
          const bytes = new Uint8Array(v.buffer, v.byteOffset || 0, v.byteLength);
          for (const fn of [...onNotify]) fn(bytes);
        });
        await rx.startNotifications();   // 不要手动写 0x2902
      }
    } catch (e) {
      try { device.gatt.disconnect(); } catch (_) {}
      throw new LinkError('CONNECT_FAILED', `${driver.model} 的服务或特征拿不到：${(e && e.message) || e}`, e);
    }

    // ---------- 串行写入 ----------
    let chain = Promise.resolve();
    let lastAt = 0;
    const now = o.now || (() => Date.now());
    function rawWrite(bytes) {
      const p = withResponse ? tx.writeValueWithResponse(bytes) : tx.writeValueWithoutResponse(bytes);
      if (!withResponse) return p;
      return new Promise((resolve, reject) => {
        const id = T.setTimeout(() => reject(new LinkError('ACK_TIMEOUT', `${ackTimeoutMs / 1000} 秒没收到回执，放弃这一帧：${toHex(bytes)}`)), ackTimeoutMs);
        p.then((v) => { T.clearTimeout(id); resolve(v); }, (e) => { T.clearTimeout(id); reject(e); });
      });
    }
    function write(bytesOrFn) {
      const job = chain.then(async () => {
        if (!alive) throw new LinkError('NOT_CONNECTED', `${driver.model} 已断开`);
        const wait = lastAt ? gapMs - (now() - lastAt) : 0;
        if (wait > 0) await sleep(wait);
        const bytes = typeof bytesOrFn === 'function' ? bytesOrFn() : bytesOrFn;
        try { await rawWrite(bytes); } catch (e) {
          if (e instanceof LinkError) throw e;
          throw new LinkError(/disconnected/i.test(String(e && e.message)) ? 'NOT_CONNECTED' : 'WRITE_FAILED', `写入失败（${toHex(bytes)}）：${(e && e.message) || e}`, e);
        } finally { lastAt = now(); }
      });
      chain = job.catch(() => {});
      return job;
    }

    // ---------- 握手 ----------
    if (hs.frames.length) {
      await sleep(hs.delayMs);
      let got = 0;
      let done;
      const ready = new Promise((r) => { done = r; });
      const count = () => { got++; emitHandshake({ phase: 'notify', got, need: hs.expectNotify }); if (got >= hs.expectNotify) done(true); };
      onNotify.add(count);
      try {
        for (const f of hs.frames) await write(literalFrame(driver, f, seq.next()));
      } catch (e) {
        onNotify.delete(count);
        try { device.gatt.disconnect(); } catch (_) {}
        throw e;
      }
      emitHandshake({ phase: 'sent', got, need: hs.expectNotify });
      if (hs.expectNotify) {
        const timer = T.setTimeout(() => done(false), hs.timeoutMs);
        const ok = await ready;
        T.clearTimeout(timer);
        onNotify.delete(count);
        if (!ok) {
          try { device.gatt.disconnect(); } catch (_) {}
          emitHandshake({ phase: 'timeout', got, need: hs.expectNotify });
          const err = new LinkError('HANDSHAKE_TIMEOUT', `握手超时：已发初始化帧，${hs.timeoutMs / 1000} 秒内只收到 ${got}/${hs.expectNotify} 条设备通知。可能是${conn.officialApp}还连着、固件不同，或设备没开机。已断开，不会自动重试。`);
          err.got = got;
          err.need = hs.expectNotify;
          throw err;
        }
        emitHandshake({ phase: 'ready', got, need: hs.expectNotify });
      } else onNotify.delete(count);
    }

    async function readBattery() {
      try {
        const s = await server.getPrimaryService(normUuid('180f'));
        const c = await s.getCharacteristic(normUuid('2a19'));
        const v = await c.readValue();
        return v.getUint8(0);
      } catch (_) { return null; }
    }

    const encodeP = (partId, level, eo) => encode(driver, partId, level, Object.assign({}, eo, { seq: seq.next() }));
    const writePart = (partId, level, eo) => write(encodeP(partId, level, eo));
    return {
      driver,
      device,
      seq,
      get connected() { return alive; },
      withResponse,
      encode: encodeP,
      write,
      writePart,
      // 每个部件发一次停止帧（驱动的 stopAll.order；没写就按部件顺序）
      async stopAll() {
        const order = (driver.stopAll && driver.stopAll.order) || driver.parts.map((p) => p.id);
        const failed = [];
        for (const id of order) { try { await writePart(id, 0); } catch (e) { failed.push({ part: id, error: e }); } }
        return { ok: !failed.length, failed };
      },
      readBattery,
      onNotify(fn) { onNotify.add(fn); return () => onNotify.delete(fn); },
      onDisconnect(fn) { onDown.add(fn); return () => onDown.delete(fn); },
      disconnect() { try { device.gatt.disconnect(); } catch (_) {} handleDown(); },
    };
  }

  // ===== device-lab/transports/tbc-direct/register.mjs =====
  // 把一份驱动的部件直接登记成 TBC 执行器（不经 Intiface）。这是 TBC v0.3 §5.9 的参考做法：
  //   - 强度 0 发停止帧；帧结束或取消时一定发停止
  //   - keepaliveMs：动着的时候按间隔重发最后一帧
  //   - group：同组同时只驱动一个，动之前先停同组其它部件
  //   - maxDurationMs：到点强制停止（加热 / 电刺激类必须有）
  //   - nativePatterns（§5.9-5）：抽象模式有对应的设备自带模式时直接发自带模式；停不下来的（stoppable:false）只有用户逐台开启才用
  //   - 写入逐帧排队：同一部件还没发出的帧只留最新的；停止越过排队（§5.9-9），需要回执的设备等回执，失败重试，最后报 refused
  //   - 断线（§5.9-8）：stopsOnDisconnect 不为 true 时，断线前在动的部件记为“可能仍在动”；重连后第一件事是全部停止
  // write(bytes, info) 由调用方提供：可以是虚拟设备、网页蓝牙链接（transports/web-bluetooth/driver-link.mjs 的 link.write）或别的传输。
  //   同步返回 undefined / { ok: true } 算成功，返回 false 或 { ack: false } 算失败；返回 Promise 时等它（拒绝算失败）。

  function driverActuators(driver, write, opts) {
    const o = opts || {};
    // 包一层：浏览器里把 setTimeout 当成别的对象的方法调用会报 Illegal invocation
    const T = o.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id), setInterval: (f, ms) => setInterval(f, ms), clearInterval: (id) => clearInterval(id) };
    const conn = connectionOf(driver);
    const include = o.include || null;   // 部件 id 列表；缺省 = expose 不为 false 的部件
    const retries = o.stopRetries ?? 2;  // 停止失败后再试几次
    const allowUnstoppable = new Set(o.allowUnstoppable || []);   // 用户逐台开启“停不下来的自带模式”的部件（§5.9-5）
    const seq = o.seq || createSeq(driver);
    const enc = o.encode || ((id, level, eo) => encode(driver, id, level, Object.assign({}, eo, { seq: seq.next() })));
    const onStopFailed = o.onStopFailed || (() => {});
    const onState = o.onState || (() => {});
    const byId = Object.fromEntries(driver.parts.map((p) => [p.id, p]));
    const running = {};                  // partId → { cancel }
    const state = Object.fromEntries(driver.parts.map((p) => [p.id, { level: 0, maybeRunning: false, native: null }]));
    const queue = [];                    // { part, level, mode, kind: 'frame' | 'stop', tries, resolve }
    let inflight = null;
    let online = true;
    const out = [];
    const parts = driver.parts.filter((p) => (include ? include.includes(p.id) : p.expose !== false));

    // ---------- 写入队列 ----------
    function finish(it, err, sync) {
      if (inflight === it) inflight = null;
      if (err && it.kind === 'stop' && online && it.tries < retries) {
        it.tries++;
        const k = queue.findIndex((x) => x.kind !== 'stop');
        queue.splice(k < 0 ? queue.length : k, 0, it);
      } else if (err) {
        if (it.kind === 'stop') { onStopFailed({ part: it.part.id, tries: it.tries + 1, error: err }); it.resolve({ ok: false, refused: 'stop-failed', error: err }); }
        else it.resolve({ ok: false, error: err });
      } else {
        if (it.kind === 'stop') { state[it.part.id].maybeRunning = false; state[it.part.id].native = null; }
        it.resolve({ ok: true });
      }
      if (!sync) pump();
    }
    function pump() {
      while (!inflight && online && queue.length) {
        const it = queue.shift();
        const bytes = enc(it.part.id, it.level, Number.isInteger(it.mode) ? { mode: it.mode } : undefined);
        let r;
        try { r = write(bytes, { part: it.part.id, kind: it.kind }); } catch (e) { r = Promise.reject(e); }
        if (r && typeof r.then === 'function') {
          inflight = it;
          r.then((v) => finish(it, v === false || (v && v.ack === false) ? new Error('no-ack') : null, false), (e) => finish(it, e || new Error('write failed'), false));
          return;
        }
        finish(it, r === false || (r && r.ack === false) ? new Error((r && r.error) || 'no-ack') : null, true);
      }
    }
    function drop(partId, framesOnly) {
      for (let i = queue.length - 1; i >= 0; i--) {
        const x = queue[i];
        if (x.part.id === partId && (!framesOnly || x.kind !== 'stop')) { queue.splice(i, 1); x.resolve({ ok: false, superseded: true }); }
      }
    }
    function enqueue(p, level, kind, mode) {
      return new Promise((resolve) => {
        const it = { part: p, level, kind, mode, tries: 0, resolve };
        if (kind === 'stop') {
          drop(p.id, false);
          const k = queue.findIndex((x) => x.kind !== 'stop');   // 停止排在所有待发帧前面（别的停止之后）
          queue.splice(k < 0 ? queue.length : k, 0, it);
        } else {
          drop(p.id, true);                                       // 同一部件只留最新的一帧
          queue.push(it);
        }
        pump();
      });
    }

    function stopPart(p) {
      const r = running[p.id];
      if (r) { r.cancel(); delete running[p.id]; }
      state[p.id].level = 0;
      return enqueue(p, 0, 'stop');
    }
    function send(p, level, mode) {
      if (level > 0 && p.group) for (const q of driver.parts) if (q !== p && q.group === p.group && running[q.id]) stopPart(q);
      state[p.id].level = level;
      return enqueue(p, level, level > 0 ? 'frame' : 'stop', mode);
    }
    function nativeFor(p, job) {
      const pat = job.action && job.action.pattern;
      const n = pat && p.nativePatterns && p.nativePatterns[pat];
      if (!n) return null;
      if (n.stoppable === false && !allowUnstoppable.has(p.id)) return null;
      return Object.assign({ pattern: pat }, n);
    }

    for (const p of parts) {
      const caps = {
        outputs: [p.output],
        levels: p.steps > 1,
        maxIntensity: 1,
        minIntervalMs: 0,
        device: `${driver.brand} ${driver.model} ${p.name}`.slice(0, 64),
        via: o.via || 'other',
        exclusive: conn.exclusive,
        stopsOnDisconnect: conn.stopsOnDisconnect,
      };
      if (p.maxDurationMs) caps.maxDurationMs = p.maxDurationMs;
      if (p.keepaliveMs) caps.keepaliveMs = p.keepaliveMs;
      if (p.group) caps.group = p.group;
      const np = nativePatternCaps(p, allowUnstoppable.has(p.id));
      if (Object.keys(np).length) caps.nativePatterns = np;
      const handler = (job) => {
        if (job.stop) return stopPart(p);
        if (running[p.id]) running[p.id].cancel();
        const ids = [];
        let lastLevel = 0;
        let lastMode;
        let ka = null;
        let finishJob;
        const done = new Promise((r) => { finishJob = r; });
        const cancel = () => { ids.forEach((x) => T.clearTimeout(x)); if (ka) T.clearInterval(ka); ka = null; finishJob(); };
        running[p.id] = { cancel };
        const sendL = (level, mode) => { lastLevel = level; lastMode = mode; send(p, level, mode); };
        const end = job.frames[job.frames.length - 1][0];
        const nat = nativeFor(p, job);
        if (nat) {
          const peak = Math.max(...job.frames.map((f) => f[1]));
          state[p.id].native = { pattern: nat.pattern, mode: nat.mode, stoppable: nat.stoppable !== false, until: nat.stoppable === false ? Date.now() + nat.maxDurationMs : null };
          ids.push(T.setTimeout(() => sendL(peak, Number.isInteger(nat.mode) ? nat.mode : undefined), 0));
        } else for (const [at, level] of job.frames) ids.push(T.setTimeout(() => sendL(level), at));
        if (p.keepaliveMs) ka = T.setInterval(() => { if (lastLevel > 0 && online) enqueue(p, lastLevel, 'frame', lastMode); }, p.keepaliveMs);
        const limit = p.maxDurationMs ? Math.min(end, p.maxDurationMs) : end;
        ids.push(T.setTimeout(() => {
          if (running[p.id] && running[p.id].cancel === cancel) delete running[p.id];
          cancel();
          state[p.id].level = 0;
          enqueue(p, 0, 'stop');
        }, limit + 1));
        if (typeof job.bindCancel === 'function') job.bindCancel(() => { if (running[p.id] && running[p.id].cancel === cancel) delete running[p.id]; cancel(); stopPart(p); });
        return done;
      };
      out.push({ id: `${o.idPrefix || 'lab'}:${driver.id}:${p.id}`, caps, handler, part: p.id, native: p.nativePatterns || null });
    }

    function status() {
      return {
        online,
        queued: queue.length,
        parts: Object.fromEntries(driver.parts.map((p) => [p.id, { level: state[p.id].level, running: !!running[p.id], maybeRunning: state[p.id].maybeRunning, native: state[p.id].native }])),
        maybeRunning: driver.parts.filter((p) => state[p.id].maybeRunning).map((p) => p.id),
      };
    }
    // 全部停止：越过排队，按驱动的 stopAll.order（没写就按部件顺序）每个部件发一次停止帧
    function stopAll() {
      for (const id of Object.keys(running)) { running[id].cancel(); delete running[id]; }
      for (const x of queue.splice(0)) x.resolve({ ok: false, superseded: true });
      const order = ((driver.stopAll && driver.stopAll.order) || driver.parts.map((p) => p.id)).map((id) => byId[id]).filter(Boolean);
      return Promise.all(order.map((p) => { state[p.id].level = 0; return enqueue(p, 0, 'stop').then((r) => Object.assign({ part: p.id }, r)); }))
        .then((rs) => { const failed = rs.filter((r) => !r.ok); onState(status()); return { ok: !failed.length, failed }; });
    }
    return {
      actuators: out,
      register(tbc) { for (const a of out) tbc.registerActuator(a.id, a.caps, a.handler); return out.map((a) => a.id); },
      stopAll,
      status,
      // 传输层断开了：不再写；断线前在动的部件记为“可能仍在动”（除非驱动确定断线即停）
      disconnected() {
        online = false;
        for (const p of driver.parts) {
          const st = state[p.id];
          if (st.level > 0 || running[p.id]) { if (conn.stopsOnDisconnect) st.level = 0; else st.maybeRunning = true; }
        }
        for (const id of Object.keys(running)) { running[id].cancel(); delete running[id]; }
        for (const x of queue.splice(0)) x.resolve({ ok: false, error: new Error('offline') });
        inflight = null;   // 在途的写入由传输层拒绝；结果到了也不会再重试
        onState(status());
      },
      // 重连成功：先全部停止，再恢复排队
      reconnected() {
        online = true;
        return stopAll();
      },
    };
  }

  // ===== device-lab/drivers/*.json（精简） =====
  const DRIVERS = [
    {
      "format": "tbc-device-lab/driver@1",
      "id": "funf-bobobei",
      "brand": "繁野 FUNF",
      "model": "啵啵贝（SOSEXY）",
      "shape": "egg",
      "namePrefix": "SOSEXY",
      "match": "name",
      "chips": 1,
      "ble": {
        "service": "ee01",
        "write": "ee03",
        "notify": "ee02",
        "writeWithoutResponse": false,
        "forbidden": [
          "ae00",
          "ae01",
          "ae02"
        ],
        "extraServices": [
          {
            "service": "180f",
            "read": [
              "2a19"
            ]
          }
        ]
      },
      "seq": {
        "start": 1,
        "max": 255
      },
      "handshake": {
        "frames": [
          "{seq} 01 00 01 00 c8 11 01"
        ],
        "delayMs": 500,
        "expectNotify": 4,
        "timeoutMs": 2000,
        "replyEveryMs": 100
      },
      "connection": {
        "exclusive": true,
        "stopsOnDisconnect": false,
        "writeGapMs": 60,
        "ackTimeoutMs": 3000,
        "officialApp": "FUNF App"
      },
      "parts": [
        {
          "id": "suction",
          "name": "吮吸",
          "output": "Constrict",
          "steps": 100,
          "template": "{seq} 01 00 02 00 07 11 {level} 00 08 11 {mode}",
          "stop": "{seq} 01 00 02 00 07 11 00 00 08 11 01",
          "mode": {
            "default": 1,
            "range": [
              1,
              4
            ]
          }
        },
        {
          "id": "vibrate",
          "name": "振动",
          "output": "Vibrate",
          "steps": 100,
          "template": "{seq} 01 00 02 00 01 11 {level} 00 02 11 {mode}",
          "stop": "{seq} 01 00 02 00 01 11 00 00 02 11 01",
          "mode": {
            "default": 1,
            "range": [
              1,
              4
            ]
          }
        },
        {
          "id": "estim",
          "name": "微电流",
          "output": "Estim",
          "steps": 100,
          "template": "{seq} 01 00 02 00 03 11 {level} 00 04 11 {mode}",
          "stop": "{seq} 01 00 02 00 03 11 00 00 04 11 01",
          "mode": {
            "default": 1,
            "range": [
              1,
              4
            ]
          },
          "maxDurationMs": 30000
        }
      ],
      "stopAll": {
        "order": [
          "suction",
          "vibrate",
          "estim"
        ]
      },
      "transports": {
        "intiface": {
          "status": "none"
        }
      },
      "sources": [
        {
          "id": "sosexy-ble-control",
          "url": "https://github.com/51enuxu/sosexy-ble-control",
          "license": "MIT"
        },
        {
          "id": "funf-pro-relay",
          "url": "https://github.com/zaoan0/funf-pro-relay",
          "license": "MIT"
        },
        {
          "id": "funf-sosexy-mcp",
          "url": "https://github.com/ktktktkt1234/funf-sosexy-mcp",
          "license": "MIT"
        },
        {
          "id": "toy-relay-sosexy",
          "url": "https://github.com/tutu-kitty/Toy-Relay-AI-mcp-SOSEXY",
          "license": "MIT"
        },
        {
          "id": "buttplug-config",
          "url": "https://github.com/buttplugio/buttplug/blob/master/crates/buttplug_server_device_config/build-config/buttplug-device-config-v5.json",
          "license": "BSD-3-Clause"
        },
        {
          "id": "funf-app",
          "url": "https://itunes.apple.com/lookup?id=6744308742&country=cn",
          "license": "公开元数据"
        },
        {
          "id": "smzdm-review",
          "url": "https://post.smzdm.com/talk/p/ak850z88/",
          "license": "只引用事实"
        },
        {
          "id": "sina-review",
          "url": "https://www.sina.cn/news/detail/5315084823039226.html",
          "license": "只引用事实（单一测评）"
        }
      ],
      "status": "community"
    },
    {
      "format": "tbc-device-lab/driver@1",
      "id": "svakom-sl278h",
      "brand": "司沃康 SVAKOM",
      "model": "SL278H",
      "shape": "rabbit",
      "namePrefix": "SL278",
      "match": "name",
      "chips": 1,
      "ble": {
        "service": "ffe0",
        "write": "ffe1",
        "notify": "ffe2",
        "writeWithoutResponse": true,
        "forbidden": [
          "ae00",
          "ae01"
        ]
      },
      "handshake": [],
      "connection": {
        "exclusive": false,
        "stopsOnDisconnect": false,
        "writeGapMs": 60,
        "ackTimeoutMs": 3000,
        "officialApp": "SVAKOM App"
      },
      "parts": [
        {
          "id": "vibrate",
          "name": "振动",
          "output": "Vibrate",
          "expose": true,
          "steps": 10,
          "template": "55 03 00 00 {mode} {level} 00",
          "stop": "55 03 00 00 00 00 00",
          "mode": {
            "default": 1,
            "range": [
              1,
              10
            ]
          },
          "group": "motor",
          "nativePatterns": {
            "long": {
              "mode": 1,
              "stoppable": true
            }
          }
        },
        {
          "id": "auto",
          "name": "自动模式",
          "output": "Vibrate",
          "expose": false,
          "steps": 255,
          "template": "55 04 00 00 01 {level} aa",
          "stop": "55 04 00 00 00 00 aa",
          "group": "motor",
          "keepaliveMs": 1500,
          "selfStopMs": 2000,
          "stopClears": [
            "vibrate"
          ],
          "nativePatterns": {
            "long": {
              "mode": "auto",
              "stoppable": true
            }
          }
        },
        {
          "id": "tap",
          "name": "拍打",
          "output": "Oscillate",
          "expose": true,
          "steps": 7,
          "template": "55 07 00 00 {level} 00 00",
          "stop": "55 07 00 00 00 00 00"
        },
        {
          "id": "thrust",
          "name": "伸缩",
          "output": "Oscillate",
          "expose": true,
          "steps": 7,
          "template": "55 08 00 00 {level} 00 00",
          "stop": "55 08 00 00 00 00 00",
          "strict": [
            {
              "index": 5,
              "equals": 0,
              "reason": "第 6 字节非 0 时整帧无效"
            }
          ]
        },
        {
          "id": "heat",
          "name": "加热",
          "output": "Temperature",
          "expose": true,
          "steps": 1,
          "template": "55 05 01 {temp} 00 00 00",
          "stop": "55 05 00 00 00 00 00",
          "maxDurationMs": 60000,
          "temp": {
            "celsius": 55
          }
        }
      ],
      "stopAll": {
        "order": [
          "vibrate",
          "auto",
          "tap",
          "thrust",
          "heat"
        ]
      },
      "notify": {
        "template": "55 fe {cmd} {mode} {level} 00 00"
      },
      "transports": {
        "intiface": {
          "status": "unverified"
        }
      },
      "sources": [
        {
          "id": "sl278h-doc",
          "url": "https://github.com/wozibile5555-max/SL278H--wodefakeya.md/blob/main/SL278H--wodefakeya.md",
          "license": "文末声明 MIT，无 LICENSE 文件；只引用事实"
        },
        {
          "id": "svakom-ble-ai",
          "url": "https://github.com/vickyldr/svakom-ble-ai",
          "license": "无许可证；只引用事实"
        },
        {
          "id": "buttplug-config",
          "url": "https://github.com/buttplugio/buttplug/blob/master/crates/buttplug_server_device_config/build-config/buttplug-device-config-v5.json",
          "license": "BSD-3-Clause"
        }
      ],
      "status": "community"
    }
  ];

  return { validateDriver, encode, decode, normUuid, toHex, connectionOf, handshakeOf, requestOptions, connectDriver, driverActuators, LinkError, RISKY_OUTPUTS, nativePatternCaps, DRIVERS };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = HeartlinkDrivers;

// heartlink runtime — 酒馆助手（JS-Slash-Runner）全局脚本的接线层。依赖前面拼接进来的 HeartlinkCore。
// 遵循 Tavern Bio-Context 0.3（协议仓库 ../spec）：<bio_context> 块、聊天变量 bio、页面事件 bio:*。
//
// 职责
//   1. 蓝牙连接 WHOOP（或任何标准心率广播设备），每秒收样本
//   2. 记录读者相位事件：发送 / 首字 / 思维链结束 / 回复出完 / 打字 / 活动 / 页面切走 / 换页
//   3. 每次用户可见的生成前注入 <bio_context>（system，聊天内深度 0，参与世界书扫描）
//   4. 每轮摘要写进聊天变量 bio 与对应 AI 消息的 extra.bio；回复到达后抽出思维链里的 Reader Signal
//   5. 右下角悬浮窗（Shadow DOM，底色跟随酒馆主题）
//
// 公开接口（挂在酒馆主窗口）：window.heartlink
//   version / spec                       字符串
//   getState()                           { connected, bpm, fresh, baseline, mode, chatId, events, samples, device, battery, lastSignal }
//   preview()                            当前时刻会注入的 <bio_context> 文本（不注入）
//   getMode() / setMode(m) / toggleMode()  'author' | 'character' | 'aware'，按聊天记忆；没选过时用角色卡 data.extensions.tbc.mode_hint（TBC v0.3 §1.2）
//   connect() / disconnect()             connect 必须由真人点击触发（浏览器规定）
//   setManualBaseline() / clearManualBaseline()   startRestBaseline() / cancelRestBaseline()（静坐 3 分钟，前 1 分钟不算）
//   setWear('wrist'|'chest'|null) / getWear()     设备戴在哪（决定按几秒算心率滞后；null = 自动猜）
//   getHistory()                         本聊天最近 20 轮摘要（也在聊天变量 bio.turns）
//   exportCsv()                          本聊天每轮摘要的 CSV 文本
//   exportEvents()                       { events, samples } 的 JSON 字符串
//   haltAll() / quickFeedback('weaker'|'stronger'|'replay'|'skip') / feedbackLine()   0.18：玩具页按钮同一路径；也可用 /hl-stop、Alt+Shift+S
//   destroy()
// 页面事件（主窗口 dispatchEvent）：bio:sample { t, bpm, rr }；bio:inject { text, mode, summary }；bio:state getState()；bio:feedback（TBC v0.3 §5.12）
(function heartlinkRuntime() {
  'use strict';

  const VERSION = '0.21.2';
  const CONFIG = {
    RUNTIME_KEY: '__HEARTLINK_RUNTIME__',
    PUBLIC_KEY: 'heartlink',
    INJECT_ID: 'bio-context',
    INJECT: { position: 'in_chat', depth: 0, role: 'system', should_scan: true },
    STORAGE_KEY: 'heartlink.settings.v4',
    RHYTHM_KEY: 'heartlink.rhythm.v1',   // 门槛自动学的原料（另存，不进 settings，可一键清）
    RHYTHM_MAX: 20,                       // 最近 20 个干净轮滚动学
    HOST_ID: 'heartlink-badge-host',
    MAX_SAMPLES: 3600,
    MAX_EVENTS: 4000,
    TYPE_COALESCE_MS: 400,
    ACTIVITY_THROTTLE_MS: 10000,
    RECONNECT_DELAYS_MS: [1000, 2000, 4000, 8000, 15000],   // 用完后改为慢速重试（下一行），浏览器支持时同时等设备的广播
    SLOW_RETRY_MS: 45000,   // 页面还拿着设备时，每 45 秒悄悄试一次，不设上限；用户点“断开设备”才停（审查第 3 条）
    CONTACT_FRESH_MS: 5000, // 最近一个“没接触”的包在这么久以内：显示“没戴好”
    STALE_MS: 15000,        // 显示已连接但这么久没数据：重新订阅；再过 STALE_MS 仍没有：断开重连
    RENDER_MS: 2000,
    META_FALLBACK_MS: 10000,       // 聊天变量写入后，宿主这么久还没保存（且不在生成中）才自己存一次元数据
    GUIDE_CHECK_MS: 10 * 60 * 1000, // 读法世界书兜底复查间隔；平时靠 CHAT_CHANGED / WORLDINFO_* 事件触发
    BRIDGE_URL: 'ws://127.0.0.1:27130/tbc/v0.2',   // 0.9：本机桥客户端（协议 v0.3 §6；目前没有维护中的桥程序）；页面自己连着蓝牙时忽略桥送来的 hr
    BRIDGE_RETRY_MS: [3000, 10000, 30000, 60000],
    HISTORY_MAX: 20,
    USER_GEN_KINDS: ['normal', 'regenerate', 'swipe', 'continue', 'impersonate', ''],
    // 正文里的思维链标签：<think> / <thinking>（含带前缀的变体，如 <my_thinking>）
    REASONING_END_RE: /<\/[a-z_]*think(?:ing)?\s*>/i,
    STREAM_MARKS_MAX: 600,   // v0.4 §1.2：stream 行 pos 段的“时刻 → 已显示字数”记录上限，换轮清空
    SIGNAL_RE: /(?:0_)?Reader Signal[^\n]*/,
    THINKING_BLOCK_RE: /<([a-z_]*think(?:ing)?)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    THINKING_PREFIX_RE: /^[\s\S]*?<\/[a-z_]*think(?:ing)?\s*>/i,   // 只有结束标签（预设用 prefill 开头）
    THINKING_TAIL_RE: /<[a-z_]*think(?:ing)?\b[^>]*>[\s\S]*$/i,     // 没有闭合的结尾思维链
    ACT_DELAY_MS: 400,          // 生成结束后等这么久再执行动作（等“停止”事件先到）
    TOOL_RECURSION_MS: 10 * 60 * 1000,   // 工具调用后的 normal 生成算递归，不开新一轮：本轮结束（ENDED / STOPPED / 收到回复）就失效，这里只是兜底上限（C-05）
    GROUP_STALE_MS: 30000,      // 群聊成员之间的间隔不会这么久：上一成员结束这么久后还没等到 GROUP_WRAPPER_FINISHED，就当群聊状态残留（L-09）
    PENDING_GEN_MS: 5000,       // GENERATION_STARTED 之后这么久内的同类型 AFTER_COMMANDS 才算同一轮
    ROUND_WINDOW_MS: 60000,     // 用户轮开始后这么久内、提示词还没拼好，算“注入窗口开着”；超过就当这轮已死（宿主 ping 失败等不发 ENDED 的路径）
    STYLE_BLOCK_RE: /<style[^>]*>[\s\S]*?<\/style>/gi,
    HTML_TAG_RE: /<[^>]+>/g,
    CJK_RE: /[一-鿿぀-ヿ가-힯]/g,
    CJK_RATIO_THRESHOLD: 0.3,
    // 0.10：触觉输出（TBC v0.3 §5）。默认关；玩具经 Intiface Central
    // profile：null = 用户还没选（按慢热执行，开振动时请用户选）；custom：用户对档位参数的覆盖（TBC v0.3 §5.8）
    // safeWords：可选，缺省关（兴奋时的“受不了”也会被拦，2026-09-17 实测）；词表可自定义
    HAPTICS: { enabled: false, maxIntensity: 1, fromReplies: true, off: [], profile: null, custom: {}, safeWords: { enabled: false, words: ['停下', '停一下', '先停', '停止', '快停', '别动了', '不要动'] }, intiface: { enabled: false, url: 'ws://127.0.0.1:12345' },
      // 按驱动直连：remember 记住连过的型号与名字（不存地址）；estimOn / allowUnstoppable 按设备逐项开启，缺省关
      direct: { remember: [], estimOn: [], allowUnstoppable: [] } },
    // 玩具本身没有间隔要求，间隔交给档位（§5.8）
    TOY_CAPS: { levels: true, maxIntensity: 1, maxDurationMs: 30000, minIntervalMs: 0, via: 'intiface' },
    ACTUATION_LINE_MS: 10 * 60 * 1000,
    LAB_URL: 'http://127.0.0.1:12346/lab/',   // 设备实验室（device-lab 仓库，npm run sim）
  };
  const LOG = '[heartlink]';
  const GUIDE_BOOK = [{"name":"00 bio_context 读法","enabled":true,"content":"<bio_context_guide>\n对话中可能出现一个 <bio_context> 块（Tavern Bio-Context v0.3）。首行的 view 是视角（backstage 幕后 / in-story 入戏 / device-aware 知情），以它为准；mode 只是兼容旧读者的旧名。块首行还可能带 device / transport / cadence（采样间隔）/ rr（是否有心跳间期）/ trigger（本轮是新消息、重roll、continue 还是 impersonate）；cadence 越粗（30 秒以上）数据越稀疏，trigger 不是 normal 时 read 相位描述的是上一条被重roll或被续写的回复。它记录屏幕前那位真实读者在上一轮到这一轮之间的心率，按页面事件切成相位；数据来自读者佩戴的心率设备，是真实测量，不是剧情设定。\n相位归属（scope 行）：gen、read、read-pos 是读者等待和阅读**上一条回复**时的身体；write、send 是写**这一条消息**时和发送那一刻的身体。不要把 read 的峰值安到本轮新消息里发生的事情上。字段：\n- baseline：本场基线心率（quiet-median = 安静段中位数；p20 = 全场 20 分位；manual = 手动）与安静时 HRV。\n- prior：非实时来源（官方 API / 健康桥）的日级数据，带日期：昨夜恢复分、HRV、静息心率、睡眠时长、皮温。它说明读者今天的底子，不是此刻的反应；日期不是今天时不要当作今天。\n- history：最近几轮“读回复”的峰值、读时长、HRV，按时间顺序，最右是上一轮。看的是趋势：峰值一轮比一轮高说明越来越投入，越来越低说明在冷却。\n- gen：读者看上一条回复生成期间（ttft 等首字、reasoning 思维链、body 正文）的心率。\n- read：读上一条回复的时长、心率走向 [区间]、峰值出现在回复出完后多少秒、rr-loss（心跳间隔缺失率，越高说明手腕在动、数值可信度越低）、hrv。**这是最能反映读者对上一段内容反应的相位**；峰值时刻大致对应读到的位置。带 flag: too-long 的读回复不可当作阅读反应。\n- read-pos：把 read 的峰值时刻按阅读速度换算成大约读到回复的百分比与段落；est 是估计、cal 是按本场历史校准。它只回答“峰值大约对应哪一段”。写 partial 时表示读者读的时间远不够读完这条回复（在跳读或没读完），只给出峰值在读时长里的相对位置，不要当成段落位置。\n- cov：该相位的样本覆盖率，低于 70% 的相位数据不可靠。\n- write：写消息的时长、字数、停顿、删改与心率。手腕在动，只看大趋势。\n- away：页面切走或长时间无操作的区间，其中的心率与对话无关，忽略。\n- send：按下发送时的心率与相对基线的百分比。\n- env：读者所在房间的温湿度最近值，与身体反应无关，只是环境背景。\n- 其它信号行（如 pressure(civet, 100ms): read 7.9→12.3 kPa …）：读者身上别的传感器在同一相位里的走向，单位随行；只看相对变化，不与心率合成结论。\n- device：读者当前连接的设备正在做什么（强度、模式、持续时间），来自设备控制器的登记；它是作者视角的幕后事实，backstage 模式下角色不知道，in-story 模式下只允许角色察觉由它引起的可观察反应、不点名设备，device-aware 模式下角色知道这台设备、可以明说。\n- series：每 10 秒一个点的原始序列。\n判断尺度：baseline 为 n/a 时不做“比刚才 / 比平时快慢”的比较；与 away 重叠、带 flag 或 cov 低于 70% 的相位不据此判断。相对基线 10% 以内是噪声；持续高 20% 以上且出现在 read 相位，才是明确反应。HRV 明显低于安静值说明绷着或亢奋，明显高说明放松。块内没有结论，解释由你完成；块不出现时忽略本说明。\n</bio_context_guide>","strategy":{"type":"selective","keys":["<bio_context"]},"position":{"type":"after_character_definition","order":100},"recursion":{"prevent_incoming":true,"prevent_outgoing":true},"extra":{"heartlink":"0.21.2"}},{"name":"10 view=backstage 幕后（旧 mode=author）","enabled":true,"content":"<bio_context> 处于幕后模式（backstage，旧名 author）：它是给你这位作者/裁决者的幕后读者反馈，剧情里任何角色都不知道它，{{user}} 角色的身体状态与它无关。只做三件事：\n1. 从 read 与 history 判断读者对上一段的反应走向（被抓住了 / 平淡 / 正在冷却 / 数据不足），据此决定本段的详略、张力与结尾钩子；预设若有推进 / 节奏模式，结构（跳时、转场、新事件）仍按预设，读者反应只调写法。\n2. 反应上升时顺势推进、加深、留悬念；平淡时换手法（换视角、加冲突、加感官细节、缩短铺垫），不要重复上一段的写法；冷却时给一个新钩子。\n3. 不在正文里提及心率、设备、读者或任何数据；不让角色“察觉”读者；不因数据改变既定事实与规则裁决。","strategy":{"type":"selective","keys":["view=\"backstage\"","mode=\"author\""]},"position":{"type":"at_depth","role":"system","depth":0,"order":90},"recursion":{"prevent_incoming":true,"prevent_outgoing":true},"extra":{"heartlink":"0.21.2"}},{"name":"11 view=in-story 入戏（旧 mode=character）","enabled":true,"content":"<bio_context> 处于入戏模式（in-story，旧名 character）：读者代入 {{user}}。send 是 {{user}} 此刻的身体状态；read 是 {{user}} 经历上一段情节时的反应（只能对应上一段里发生的事，不能安到本轮新动作上）。让在场角色通过可观察的线索察觉（呼吸、面色、手、声音、姿态），并按各自性格与关系回应。仍然不说数字、不提设备；gen、write、away 的数据不用于角色感知。首行若有 perceiver 属性（卡片指定的感知者），只让这些角色表达察觉，其他在场角色照常行动、不评论 {{user}} 的身体。","strategy":{"type":"selective","keys":["view=\"in-story\""]},"position":{"type":"at_depth","role":"system","depth":0,"order":90},"recursion":{"prevent_incoming":true,"prevent_outgoing":true},"extra":{"heartlink":"0.21.2"}},{"name":"12 view=device-aware 知情","enabled":true,"content":"<bio_context> 处于知情模式（device-aware）：{{user}} 知道自己戴着设备，在场角色也知道，并能看到这份数据。角色可以引用数字（心率、比平静高多少、昨晚睡了多久），可以像教练或伴侣一样指导 {{user}}：提醒放松或屏住呼吸、问现在的感觉、说明接下来要让设备怎么动；haptics 行为 on 时可以用 <bio_act/>，并可以在正文里明说是自己让设备动的。仍然只描述数据、不替 {{user}} 下结论（不说“你一定很兴奋”），不臆断原因；read 只对应上一段发生的事；gen、write、away 的数据只作参考，不当作 {{user}} 对剧情的反应。首行若有 perceiver 属性，只让这些角色看数据、给指导。","strategy":{"type":"selective","keys":["view=\"device-aware\""]},"position":{"type":"at_depth","role":"system","depth":0,"order":90},"recursion":{"prevent_incoming":true,"prevent_outgoing":true},"extra":{"heartlink":"0.21.2"}},{"name":"20 feedback 读法","enabled":true,"content":"<bio_context_guide>\n块里的 feedback(…) 行是读者对玩具的操作，以及上一条回复里动作的执行结局，只记录不解释：\n- acts N sent 后面的 done / cut / pending / refused 是走完 / 被停或被打断 / 发送时还在排队 / 被拒，只是执行结局，不代表喜好。\n- stop by reader、skip：这一下不对。下一条不要加码，也不要重复同一模式，除非读者要求。\n- stronger、replay：这一下对了，可以顺着来。weaker：方向对，力度过了。pace 后面是读者换到的节奏档位。\n- stop by device（disconnected 断开、deadline 到时、heat-limit 限温、rate-limit 太频繁）是技术原因，不代表喜好。\n- stop by safeword：按用户的设定处理，下一条不写 <bio_act/>。\n- reply -1 是上一条回复，reply -2 是再早一条；act N 是其中第几个动作，Ns in 是动作开始后多久。\n呈现按视角：backstage 只影响写法；in-story 写成角色察觉到的反应，不提按钮；device-aware 角色可以直接说出读者刚才的操作，例如“你刚才按停了”。\n</bio_context_guide>","strategy":{"type":"selective","keys":["feedback("]},"position":{"type":"after_character_definition","order":101},"recursion":{"prevent_incoming":true,"prevent_outgoing":true},"extra":{"heartlink":"0.21.2"}},{"name":"30 bio_act 写法","enabled":true,"content":"<bio_act_guide>\n块里有 haptics(heartlink): on 时，读者连着玩具并允许剧情驱动。想让设备动，就在回复正文里写动作标签，回复写完后按出现顺序执行：\n<bio_act target=\"*\" output=\"Vibrate\" pattern=\"wave\" intensity=\"0.4\" ms=\"3000\"/>\n- 属性都可省略。target：设备，缺省 * 全部。output：Vibrate / Rotate / Oscillate / Constrict / Position 等，缺省 * 任意输出；Temperature、Estim、Spray 只有点名才会动。pattern：pulse / double / triple / long / heartbeat / wave，缺省 pulse。intensity：0–1，缺省 0.5，0 是停下。ms：毫秒，只对 long / heartbeat / wave 有效。\n- 每条回复最多 3 个（haptics 行的 profile 是 frenzy 或 max 时最多 5 个），多出的不执行。\n- 写在思维链（<think> 等）、代码、HTML 注释里的标签不算动作；标签在显示时会被隐藏。\n- 读者可以随时直接停下，不经过你；停下、跳过、调强调弱会在下一轮的 feedback 行里出现。\n- 什么时候动、动多强，跟着剧情和读者的反馈来。\n</bio_act_guide>","strategy":{"type":"selective","keys":["haptics(heartlink): on"]},"position":{"type":"after_character_definition","order":102},"recursion":{"prevent_incoming":true,"prevent_outgoing":true},"extra":{"heartlink":"0.21.2"}}];
  const GUIDE_BOOK_NATIVE = [{"uid":0,"key":["<bio_context"],"keysecondary":[],"comment":"00 bio_context 读法","content":"<bio_context_guide>\n对话中可能出现一个 <bio_context> 块（Tavern Bio-Context v0.3）。首行的 view 是视角（backstage 幕后 / in-story 入戏 / device-aware 知情），以它为准；mode 只是兼容旧读者的旧名。块首行还可能带 device / transport / cadence（采样间隔）/ rr（是否有心跳间期）/ trigger（本轮是新消息、重roll、continue 还是 impersonate）；cadence 越粗（30 秒以上）数据越稀疏，trigger 不是 normal 时 read 相位描述的是上一条被重roll或被续写的回复。它记录屏幕前那位真实读者在上一轮到这一轮之间的心率，按页面事件切成相位；数据来自读者佩戴的心率设备，是真实测量，不是剧情设定。\n相位归属（scope 行）：gen、read、read-pos 是读者等待和阅读**上一条回复**时的身体；write、send 是写**这一条消息**时和发送那一刻的身体。不要把 read 的峰值安到本轮新消息里发生的事情上。字段：\n- baseline：本场基线心率（quiet-median = 安静段中位数；p20 = 全场 20 分位；manual = 手动）与安静时 HRV。\n- prior：非实时来源（官方 API / 健康桥）的日级数据，带日期：昨夜恢复分、HRV、静息心率、睡眠时长、皮温。它说明读者今天的底子，不是此刻的反应；日期不是今天时不要当作今天。\n- history：最近几轮“读回复”的峰值、读时长、HRV，按时间顺序，最右是上一轮。看的是趋势：峰值一轮比一轮高说明越来越投入，越来越低说明在冷却。\n- gen：读者看上一条回复生成期间（ttft 等首字、reasoning 思维链、body 正文）的心率。\n- read：读上一条回复的时长、心率走向 [区间]、峰值出现在回复出完后多少秒、rr-loss（心跳间隔缺失率，越高说明手腕在动、数值可信度越低）、hrv。**这是最能反映读者对上一段内容反应的相位**；峰值时刻大致对应读到的位置。带 flag: too-long 的读回复不可当作阅读反应。\n- read-pos：把 read 的峰值时刻按阅读速度换算成大约读到回复的百分比与段落；est 是估计、cal 是按本场历史校准。它只回答“峰值大约对应哪一段”。写 partial 时表示读者读的时间远不够读完这条回复（在跳读或没读完），只给出峰值在读时长里的相对位置，不要当成段落位置。\n- cov：该相位的样本覆盖率，低于 70% 的相位数据不可靠。\n- write：写消息的时长、字数、停顿、删改与心率。手腕在动，只看大趋势。\n- away：页面切走或长时间无操作的区间，其中的心率与对话无关，忽略。\n- send：按下发送时的心率与相对基线的百分比。\n- env：读者所在房间的温湿度最近值，与身体反应无关，只是环境背景。\n- 其它信号行（如 pressure(civet, 100ms): read 7.9→12.3 kPa …）：读者身上别的传感器在同一相位里的走向，单位随行；只看相对变化，不与心率合成结论。\n- device：读者当前连接的设备正在做什么（强度、模式、持续时间），来自设备控制器的登记；它是作者视角的幕后事实，backstage 模式下角色不知道，in-story 模式下只允许角色察觉由它引起的可观察反应、不点名设备，device-aware 模式下角色知道这台设备、可以明说。\n- series：每 10 秒一个点的原始序列。\n判断尺度：baseline 为 n/a 时不做“比刚才 / 比平时快慢”的比较；与 away 重叠、带 flag 或 cov 低于 70% 的相位不据此判断。相对基线 10% 以内是噪声；持续高 20% 以上且出现在 read 相位，才是明确反应。HRV 明显低于安静值说明绷着或亢奋，明显高说明放松。块内没有结论，解释由你完成；块不出现时忽略本说明。\n</bio_context_guide>","constant":false,"vectorized":false,"selective":true,"selectiveLogic":0,"addMemo":true,"order":100,"position":1,"disable":false,"excludeRecursion":true,"preventRecursion":true,"delayUntilRecursion":false,"probability":100,"useProbability":true,"depth":4,"group":"","groupOverride":false,"groupWeight":100,"scanDepth":null,"caseSensitive":false,"matchWholeWords":false,"useGroupScoring":null,"automationId":"","role":0,"sticky":0,"cooldown":0,"delay":0,"displayIndex":0,"heartlink":"0.21.2"},{"uid":1,"key":["view=\"backstage\"","mode=\"author\""],"keysecondary":[],"comment":"10 view=backstage 幕后（旧 mode=author）","content":"<bio_context> 处于幕后模式（backstage，旧名 author）：它是给你这位作者/裁决者的幕后读者反馈，剧情里任何角色都不知道它，{{user}} 角色的身体状态与它无关。只做三件事：\n1. 从 read 与 history 判断读者对上一段的反应走向（被抓住了 / 平淡 / 正在冷却 / 数据不足），据此决定本段的详略、张力与结尾钩子；预设若有推进 / 节奏模式，结构（跳时、转场、新事件）仍按预设，读者反应只调写法。\n2. 反应上升时顺势推进、加深、留悬念；平淡时换手法（换视角、加冲突、加感官细节、缩短铺垫），不要重复上一段的写法；冷却时给一个新钩子。\n3. 不在正文里提及心率、设备、读者或任何数据；不让角色“察觉”读者；不因数据改变既定事实与规则裁决。","constant":false,"vectorized":false,"selective":true,"selectiveLogic":0,"addMemo":true,"order":90,"position":4,"disable":false,"excludeRecursion":true,"preventRecursion":true,"delayUntilRecursion":false,"probability":100,"useProbability":true,"depth":0,"group":"","groupOverride":false,"groupWeight":100,"scanDepth":null,"caseSensitive":false,"matchWholeWords":false,"useGroupScoring":null,"automationId":"","role":0,"sticky":0,"cooldown":0,"delay":0,"displayIndex":1,"heartlink":"0.21.2"},{"uid":2,"key":["view=\"in-story\""],"keysecondary":[],"comment":"11 view=in-story 入戏（旧 mode=character）","content":"<bio_context> 处于入戏模式（in-story，旧名 character）：读者代入 {{user}}。send 是 {{user}} 此刻的身体状态；read 是 {{user}} 经历上一段情节时的反应（只能对应上一段里发生的事，不能安到本轮新动作上）。让在场角色通过可观察的线索察觉（呼吸、面色、手、声音、姿态），并按各自性格与关系回应。仍然不说数字、不提设备；gen、write、away 的数据不用于角色感知。首行若有 perceiver 属性（卡片指定的感知者），只让这些角色表达察觉，其他在场角色照常行动、不评论 {{user}} 的身体。","constant":false,"vectorized":false,"selective":true,"selectiveLogic":0,"addMemo":true,"order":90,"position":4,"disable":false,"excludeRecursion":true,"preventRecursion":true,"delayUntilRecursion":false,"probability":100,"useProbability":true,"depth":0,"group":"","groupOverride":false,"groupWeight":100,"scanDepth":null,"caseSensitive":false,"matchWholeWords":false,"useGroupScoring":null,"automationId":"","role":0,"sticky":0,"cooldown":0,"delay":0,"displayIndex":2,"heartlink":"0.21.2"},{"uid":3,"key":["view=\"device-aware\""],"keysecondary":[],"comment":"12 view=device-aware 知情","content":"<bio_context> 处于知情模式（device-aware）：{{user}} 知道自己戴着设备，在场角色也知道，并能看到这份数据。角色可以引用数字（心率、比平静高多少、昨晚睡了多久），可以像教练或伴侣一样指导 {{user}}：提醒放松或屏住呼吸、问现在的感觉、说明接下来要让设备怎么动；haptics 行为 on 时可以用 <bio_act/>，并可以在正文里明说是自己让设备动的。仍然只描述数据、不替 {{user}} 下结论（不说“你一定很兴奋”），不臆断原因；read 只对应上一段发生的事；gen、write、away 的数据只作参考，不当作 {{user}} 对剧情的反应。首行若有 perceiver 属性，只让这些角色看数据、给指导。","constant":false,"vectorized":false,"selective":true,"selectiveLogic":0,"addMemo":true,"order":90,"position":4,"disable":false,"excludeRecursion":true,"preventRecursion":true,"delayUntilRecursion":false,"probability":100,"useProbability":true,"depth":0,"group":"","groupOverride":false,"groupWeight":100,"scanDepth":null,"caseSensitive":false,"matchWholeWords":false,"useGroupScoring":null,"automationId":"","role":0,"sticky":0,"cooldown":0,"delay":0,"displayIndex":3,"heartlink":"0.21.2"},{"uid":4,"key":["feedback("],"keysecondary":[],"comment":"20 feedback 读法","content":"<bio_context_guide>\n块里的 feedback(…) 行是读者对玩具的操作，以及上一条回复里动作的执行结局，只记录不解释：\n- acts N sent 后面的 done / cut / pending / refused 是走完 / 被停或被打断 / 发送时还在排队 / 被拒，只是执行结局，不代表喜好。\n- stop by reader、skip：这一下不对。下一条不要加码，也不要重复同一模式，除非读者要求。\n- stronger、replay：这一下对了，可以顺着来。weaker：方向对，力度过了。pace 后面是读者换到的节奏档位。\n- stop by device（disconnected 断开、deadline 到时、heat-limit 限温、rate-limit 太频繁）是技术原因，不代表喜好。\n- stop by safeword：按用户的设定处理，下一条不写 <bio_act/>。\n- reply -1 是上一条回复，reply -2 是再早一条；act N 是其中第几个动作，Ns in 是动作开始后多久。\n呈现按视角：backstage 只影响写法；in-story 写成角色察觉到的反应，不提按钮；device-aware 角色可以直接说出读者刚才的操作，例如“你刚才按停了”。\n</bio_context_guide>","constant":false,"vectorized":false,"selective":true,"selectiveLogic":0,"addMemo":true,"order":101,"position":1,"disable":false,"excludeRecursion":true,"preventRecursion":true,"delayUntilRecursion":false,"probability":100,"useProbability":true,"depth":4,"group":"","groupOverride":false,"groupWeight":100,"scanDepth":null,"caseSensitive":false,"matchWholeWords":false,"useGroupScoring":null,"automationId":"","role":0,"sticky":0,"cooldown":0,"delay":0,"displayIndex":4,"heartlink":"0.21.2"},{"uid":5,"key":["haptics(heartlink): on"],"keysecondary":[],"comment":"30 bio_act 写法","content":"<bio_act_guide>\n块里有 haptics(heartlink): on 时，读者连着玩具并允许剧情驱动。想让设备动，就在回复正文里写动作标签，回复写完后按出现顺序执行：\n<bio_act target=\"*\" output=\"Vibrate\" pattern=\"wave\" intensity=\"0.4\" ms=\"3000\"/>\n- 属性都可省略。target：设备，缺省 * 全部。output：Vibrate / Rotate / Oscillate / Constrict / Position 等，缺省 * 任意输出；Temperature、Estim、Spray 只有点名才会动。pattern：pulse / double / triple / long / heartbeat / wave，缺省 pulse。intensity：0–1，缺省 0.5，0 是停下。ms：毫秒，只对 long / heartbeat / wave 有效。\n- 每条回复最多 3 个（haptics 行的 profile 是 frenzy 或 max 时最多 5 个），多出的不执行。\n- 写在思维链（<think> 等）、代码、HTML 注释里的标签不算动作；标签在显示时会被隐藏。\n- 读者可以随时直接停下，不经过你；停下、跳过、调强调弱会在下一轮的 feedback 行里出现。\n- 什么时候动、动多强，跟着剧情和读者的反馈来。\n</bio_act_guide>","constant":false,"vectorized":false,"selective":true,"selectiveLogic":0,"addMemo":true,"order":102,"position":1,"disable":false,"excludeRecursion":true,"preventRecursion":true,"delayUntilRecursion":false,"probability":100,"useProbability":true,"depth":4,"group":"","groupOverride":false,"groupWeight":100,"scanDepth":null,"caseSensitive":false,"matchWholeWords":false,"useGroupScoring":null,"automationId":"","role":0,"sticky":0,"cooldown":0,"delay":0,"displayIndex":5,"heartlink":"0.21.2"}];
  // 1.0：同一份源码构建两种形态——'script' 酒馆助手全局脚本（旧），'extension' 酒馆扩展
  const FORM = 'extension';
  // 开发者工具（设备模拟器按钮等）：发布版关闭
  const DEV_TOOLS = false;
  const GUIDE_BOOK_NAME = 'heartlink·读法';

  function hostWindow() {
    try { if (window.parent && window.parent !== window && window.parent.document) return window.parent; } catch (_) {}
    return window;
  }
  const host = hostWindow();
  const doc = host.document;

  const previous = host[CONFIG.RUNTIME_KEY];
  if (FORM === 'script' && previous && previous.form === 'extension') {
    // 已装扩展版：旧脚本不再接管（两份同时跑会重复注入）
    try { (host.toastr || toastr).warning('已安装 heartlink 扩展，酒馆助手里的 heartlink 脚本不再运行，请在酒馆助手里关掉它。', 'heartlink'); } catch (_) {}
    console.warn('[heartlink] extension form already running; script form skipped');
    return;
  }
  const state = (previous && previous.state) || {};
  Object.assign(state, {
    device: state.device || null, characteristic: state.characteristic || null,
    connected: !!state.connected, reconnecting: false,
    samples: state.samples || [], lastSample: state.lastSample || null, events: state.events || [], activityLog: state.activityLog || [],
    manualBaseline: state.manualBaseline || null, modes: state.modes || {}, history: state.history || {}, signals: state.signals || {},
    replyMeta: state.replyMeta || null,
    // v0.4 §1.2：stream(...) 行的 pos 段需要“时刻 → 已显示字数”的阶梯记录；只在草案开关打开时记（每轮清空）
    streamMarks: state.streamMarks || null,
    injectEnabled: state.injectEnabled !== false, privacyAck: !!state.privacyAck, injectedFor: null, lastInjectAt: state.lastInjectAt || null, backgroundSkipped: state.backgroundSkipped || 0,
    guideActive: state.guideActive ?? null, multiWindow: false, lastProblemKey: '',
    lastSummarizedSend: state.lastSummarizedSend || null,
    deviceName: state.deviceName || null, deviceInfo: state.deviceInfo || null, battery: state.battery ?? null,
    generating: false, backgroundGen: false, streamStarted: false, reasoningEnded: false,
    subscribing: null, advWatch: null, waitingForDevice: false, staleStep: 0, menuWait: false, badgeTab: null,
    lastSendT: state.lastSendT || null, lastTypeT: 0, lastLen: 0, lastActivityT: 0, chatIdSeen: state.chatIdSeen || null,
    onSample: null, onConnection: null, notifyHandler: state.notifyHandler || null, disconnectHandler: state.disconnectHandler || null,
    haptics: state.haptics || JSON.parse(JSON.stringify(CONFIG.HAPTICS)), intifaceStatus: 'idle', genStoppedAt: 0, lastActedReply: state.lastActedReply || null,
    // 一次用户发送只生成一个块（v0.3 §1.3-2）；生成类型与重放
    pendingGen: null, genKind: null, genStartT: 0, turnBlock: state.turnBlock || null, impersonateBlock: null, impersonating: false,
    groupTurn: null, toolCallsAt: 0, round: null, bgGens: [],
    // 后台生成的事件按先来先认领：bgAwaitCombine / bgAwaitPrompt = 已 STARTED、还没看到它的 BEFORE_COMBINE / PROMPT_READY 的后台生成数；
    // ownEndedPending = 本轮已由 MESSAGE_RECEIVED 结束，本轮自己的 GENERATION_ENDED 还在路上（不能当成后台的）
    bgAwaitCombine: 0, bgAwaitPrompt: 0, ownEndedPending: false,
    badInput: state.badInput || 0, invalidBlocks: state.invalidBlocks || 0, guideConflict: state.guideConflict || null, guideWrote: state.guideWrote || null,
    // 佩戴位（parseHeartRate().sensorContact）：没接触的包不进样本，只记成区间；contactOff = { since, lastT }
    offContact: state.offContact || [], contactOff: state.contactOff || null, contactSupported: !!state.contactSupported, lastPacketT: state.lastPacketT || 0,
    wearClass: state.wearClass || null, rest: null, slowRetry: null,
    // 门槛自动学（设置方案 §3）：rhythm = 最近若干干净轮的行为时长（另存一个 key，不进 settings）；gates = 用户手动改的门槛
    rhythm: state.rhythm || [], gates: state.gates || null,
    tone: state.tone || 'auto',   // 配色：'auto' 跟随酒馆 / 'dark' / 'light'（§3.7）
    idleDetect: state.idleDetect || false, idleCtl: state.idleCtl || null,   // 更准的离开判断（§3.5）
    panelAutoClose: state.panelAutoClose !== false,   // 点面板外面时收起（F-099，缺省开）
  });
  if (previous && typeof previous.destroy === 'function') {
    try { previous.destroy(); } catch (err) { console.warn(LOG, 'destroy previous runtime failed', err); }
  }

  const disposers = [];
  let destroyed = false;
  const wait = (ms) => new Promise((r) => host.setTimeout(r, ms));

  // ---------- 设置 ----------
  function loadSettings() {
    try {
      const s = JSON.parse(host.localStorage.getItem(CONFIG.STORAGE_KEY) || '{}');
      if (s.manualBaseline && Number.isFinite(s.manualBaseline.bpm)) state.manualBaseline = s.manualBaseline;
      if (s.modes && typeof s.modes === 'object') state.modes = s.modes;
      if (typeof s.deviceName === 'string') state.deviceName = s.deviceName;
      if (s.prior && typeof s.prior === 'object' && !state.prior) state.prior = s.prior;
      // 2026-09-18 用户定：面板不再有“发给模型”开关，扩展总是注入（setExposure 只给测试与 ON/SHAM 实验用，不存盘）。
      // 以前关过的人没有界面能打开，所以读到 false 就改回 true 并重写设置
      if (s.injectEnabled === false) { state.injectEnabled = true; state.migrateInject = true; }
      if (s.privacyAck) state.privacyAck = true;
      if (s.badgePos && Number.isFinite(s.badgePos.right) && Number.isFinite(s.badgePos.top)) state.badgePos = s.badgePos;
      if (typeof s.badgeHidden === 'boolean') state.badgeHidden = s.badgeHidden;
      if (typeof s.settingsFolded === 'boolean') state.settingsFolded = s.settingsFolded;
      if (s.playSeen) state.playSeen = true;
      if (s.haptics && typeof s.haptics === 'object') state.haptics = normalizeHaptics(s.haptics);
      if (typeof s.guideWrote === 'string') state.guideWrote = s.guideWrote;
      if (typeof s.v04 === 'boolean') state.v04 = s.v04;   // v0.4 草案开关（缺省关，界面里没有）
      if (s.wearClass === 'wrist' || s.wearClass === 'chest') state.wearClass = s.wearClass;
      if (s.gates && typeof s.gates === 'object') state.gates = normalizeGates(s.gates);   // 手动改的门槛
      if (s.tone === 'dark' || s.tone === 'light') state.tone = s.tone;   // 配色（缺省 auto 跟随酒馆）
      if (s.idleDetect === true) state.idleDetect = true;   // 更准的离开判断；实际是否重新启动看权限（reArmIdle）
      if (typeof s.panelAutoClose === 'boolean') state.panelAutoClose = s.panelAutoClose;
    } catch (err) { console.warn(LOG, 'loadSettings failed', err); }
    loadRhythm();
  }
  // 手动门槛只留合法字段：idleMs（60–300s）、tooLongMult（2–6）；空对象归 null
  function normalizeGates(g) {
    const out = {};
    if (Number.isFinite(g.idleMs)) out.idleMs = Math.max(60000, Math.min(300000, g.idleMs));
    if (Number.isFinite(g.tooLongMult)) out.tooLongMult = Math.max(2, Math.min(6, g.tooLongMult));
    return Object.keys(out).length ? out : null;
  }
  // 门槛自动学的原料另存一个 key（§3.10：只存几个数，不进 settings，一键可清）
  function loadRhythm() {
    try {
      const a = JSON.parse(host.localStorage.getItem(CONFIG.RHYTHM_KEY) || '[]');
      state.rhythm = Array.isArray(a) ? a.filter((r) => r && typeof r === 'object').slice(-CONFIG.RHYTHM_MAX) : [];
    } catch (err) { state.rhythm = []; }
  }
  function saveRhythm() {
    try { host.localStorage.setItem(CONFIG.RHYTHM_KEY, JSON.stringify((state.rhythm || []).slice(-CONFIG.RHYTHM_MAX))); } catch (err) { /* 隐私盘满等忽略 */ }
  }
  // 记一条干净轮：只留 gapP90 / readSec / chars / cps / pauseMed（core.rhythmRecord 已算好，挂在 summary.rhythm 上）
  function pushRhythm(rec) {
    if (!rec || !rec.clean) return;
    const r = { gapP90: rec.gapP90 || 0, readSec: rec.readSec || 0, chars: rec.chars || 0, cps: rec.cps || 0, pauseMed: rec.pauseMed || 0 };
    state.rhythm.push(r);
    if (state.rhythm.length > CONFIG.RHYTHM_MAX) state.rhythm.splice(0, state.rhythm.length - CONFIG.RHYTHM_MAX);
    saveRhythm();
  }
  function learnedGates() { return HeartlinkCore.learnGates(state.rhythm || []); }
  function gatesArg() { return { learned: learnedGates(), manual: state.gates || null }; }
  // 清除学到的习惯（设置页里的按钮，§3.9 隐私）
  function clearRhythm() { state.rhythm = []; saveRhythm(); toast('info', '已清除学到的阅读习惯，下次从常见值重新学'); render(); }
  // 手动设 / 改回自动一个门槛
  function setGate(key, value) {
    const g = Object.assign({}, state.gates || {});
    if (value == null) delete g[key]; else g[key] = value;
    state.gates = Object.keys(g).length ? normalizeGates(g) : null;
    saveSettings(); render(); emit('bio:state', getState());
  }
  // 旧设置缺的字段补缺省；安全词开关与词表分开合并
  function normalizeHaptics(h) {
    const d = JSON.parse(JSON.stringify(CONFIG.HAPTICS));
    const x = Object.assign(d, h || {});
    x.intiface = Object.assign({}, CONFIG.HAPTICS.intiface, (h && h.intiface) || {});
    x.safeWords = Object.assign({}, CONFIG.HAPTICS.safeWords, (h && h.safeWords) || {});
    x.direct = Object.assign({ remember: [], estimOn: [], allowUnstoppable: [] }, (h && h.direct) || {});
    x.direct.remember = (Array.isArray(x.direct.remember) ? x.direct.remember : []).filter((r) => r && typeof r.driver === 'string' && typeof r.name === 'string').map((r) => ({ driver: r.driver.slice(0, 64), name: r.name.slice(0, 64) })).slice(-8);
    for (const k of ['estimOn', 'allowUnstoppable']) x.direct[k] = (Array.isArray(x.direct[k]) ? x.direct[k] : []).map((v) => String(v).slice(0, 160)).slice(0, 50);
    if (!Array.isArray(x.safeWords.words)) x.safeWords.words = CONFIG.HAPTICS.safeWords.words.slice();
    x.safeWords.words = x.safeWords.words.map((w) => String(w).trim()).filter(Boolean).slice(0, 50);
    x.custom = x.custom && typeof x.custom === 'object' ? x.custom : {};
    if (!HeartlinkHaptics.PROFILES[x.profile]) x.profile = null;
    x.maxIntensity = 1;   // 0.16 起不再提供强度上限设置（用户定），协议上视为 1
    return x;
  }
  function safeWordHit(text) {
    const sw = state.haptics.safeWords;
    if (!sw || !sw.enabled) return false;
    const t = String(text || '');
    return sw.words.some((w) => w && t.includes(w));
  }
  function saveSettings() {
    try { host.localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify({ manualBaseline: state.manualBaseline, modes: state.modes, deviceName: state.deviceName, prior: state.prior || null, privacyAck: !!state.privacyAck, haptics: state.haptics, badgePos: state.badgePos || null, badgeHidden: !!state.badgeHidden, settingsFolded: !!state.settingsFolded, playSeen: !!state.playSeen, guideWrote: state.guideWrote || null, v04: !!state.v04, wearClass: state.wearClass || null, gates: state.gates || null, tone: state.tone || 'auto', idleDetect: !!state.idleDetect, panelAutoClose: state.panelAutoClose !== false })); }
    catch (err) { console.warn(LOG, 'saveSettings failed', err); }
  }
  // 提示合并（0.18，手机上一串提示会盖住面板）：4 秒内的新提示替换上一条，两条合成一条；同样的话不重复弹
  const TOAST_MERGE_MS = 4000;
  const TOAST_RANK = { success: 0, info: 1, warning: 2, error: 3 };
  let lastToast = null;
  function toast(kind, text) {
    const msg = String(text == null ? '' : text);
    const now = Date.now();
    try {
      if (typeof toastr !== 'undefined' && toastr[kind]) {
        let show = msg; let k = kind;
        const prev = lastToast && now - lastToast.at < TOAST_MERGE_MS ? lastToast : null;
        if (prev) {
          if (prev.text === msg || prev.shown.includes(msg)) { prev.at = now; return; }
          try { if (prev.el && typeof toastr.clear === 'function') toastr.clear(prev.el, { force: true }); } catch (_) {}
          const merged = `${prev.text}；${msg}`;
          if (merged.length <= 90) show = merged;
          if ((TOAST_RANK[prev.kind] || 0) > (TOAST_RANK[k] || 0) && show === merged) k = prev.kind;
        }
        const el = toastr[k](show, 'heartlink', { preventDuplicates: true, timeOut: show.length > 40 ? 6000 : 3500 });
        lastToast = { el, kind: k, text: msg, shown: show, at: now };
        return;
      }
    } catch (_) {}
    console.log(LOG, kind, msg);
  }
  function ctx() { try { return host.SillyTavern.getContext(); } catch (_) { return null; } }
  function chatId() { const c = ctx(); return (c && c.chatId) || 'default'; }
  function emit(name, detail) { try { host.dispatchEvent(new host.CustomEvent(name, { detail })); } catch (_) {} }

  // ---------- 事件记录 ----------
  // send / reply_end 进 activityLog：自动基线要靠它们反推 gen / read 区间并排除（v0.3 §1.5 rest 排除项）
  const ACTIVITY_TYPES = new Set(['type', 'activity', 'visible', 'hidden', 'send', 'reply_end']);
  function pushEvent(type, extra, t) {
    const e = Object.assign({ t: t == null ? Date.now() : t, type }, extra || {});
    state.events.push(e);
    if (state.events.length > CONFIG.MAX_EVENTS) state.events.splice(0, state.events.length - CONFIG.MAX_EVENTS);
    if (ACTIVITY_TYPES.has(type)) {
      state.activityLog.push(e);
      if (state.activityLog.length > CONFIG.MAX_EVENTS) state.activityLog.splice(0, state.activityLog.length - CONFIG.MAX_EVENTS);
    }
    if (state.rest) restOnEvent(e);
    return e;
  }

  // ---------- 蓝牙 ----------
  function bluetooth() { try { return host.navigator.bluetooth || null; } catch (_) { return null; } }
  // t：样本产生时刻（总线 / 桥送来的迟到样本按时间插入，B-14）；缺省为现在
  function pushSample(bpm, rr, t) {
    const sample = { t: t == null ? Date.now() : t, bpm, rr: rr || [] };
    const arr = state.samples;
    if (!arr.length || arr[arr.length - 1].t <= sample.t) arr.push(sample);
    else { let i = arr.length - 1; while (i >= 0 && arr[i].t > sample.t) i--; arr.splice(i + 1, 0, sample); }
    if (arr.length > CONFIG.MAX_SAMPLES) arr.splice(0, arr.length - CONFIG.MAX_SAMPLES);
    if (!state.lastSample || sample.t >= state.lastSample.t) state.lastSample = sample;
    if (typeof state.onSample === 'function') { try { state.onSample(sample); } catch (_) {} }
    emit('bio:sample', sample);
  }
  // 数据卫生（审查第 2 条）：蓝牙与总线各一道闸，不可能的值与单点跳变不进样本（覆盖率里如实少掉）
  const hrGates = { ble: HeartlinkCore.createHrGate(), bus: HeartlinkCore.createHrGate() };
  function acceptHr(gate, bpm, rr, t) {
    const accepted = hrGates[gate].push({ t: t == null ? Date.now() : t, bpm, rr: rr || [] });
    for (const x of accepted) pushSample(x.bpm, x.rr, x.t);
    return accepted.length > 0;
  }
  // 蓝牙心率包：佩戴位报“没接触”（sensorContact === false）时，这一秒不进样本，只记进 offContact 区间（v0.3 §2.1 wear、§2.2 off-wrist）
  function onHrPacket(parsed, t) {
    const now = t == null ? Date.now() : t;
    state.lastPacketT = now;
    if (parsed.sensorContact !== null && parsed.sensorContact !== undefined) state.contactSupported = true;
    if (parsed.sensorContact === false) {
      const spans = state.offContact;
      const p = spans[spans.length - 1];
      if (p && now <= p[1] + 2000) p[1] = Math.max(p[1], now + 1000); else spans.push([now, now + 1000]);
      if (spans.length > 50) spans.splice(0, spans.length - 50);
      if (!state.contactOff) { state.contactOff = { since: now, lastT: now }; render(); } else state.contactOff.lastT = now;
      return false;
    }
    if (state.contactOff) { state.contactOff = null; render(); }
    return acceptHr('ble', parsed.bpm, parsed.rr, now);
  }
  function contactOffNow(now) { return !!(state.contactOff && (now || Date.now()) - state.contactOff.lastT <= CONFIG.CONTACT_FRESH_MS); }
  // 设备戴在哪：用户选过就用用户的；没选时按名字 / 佩戴位 / 心跳间隔猜（v0.4 §2.1 的滞后按它取）
  function wearGuess() { const m = sourceMeta(); return HeartlinkCore.guessWear({ name: state.deviceName, rr: !!m.rr, contact: !!state.contactSupported }); }
  function effectiveWear() { return state.wearClass || wearGuess(); }
  function setWear(v) {
    if (v !== null && v !== 'wrist' && v !== 'chest') throw new Error("wear must be 'wrist' | 'chest' | null");
    state.wearClass = v; saveSettings(); render(); emit('bio:state', getState());
    return effectiveWear();
  }
  // ---------- v0.2 头部属性：设备、传输、采样间隔（最近 60 个样本的中位间隔）、是否带 RR、本轮触发类型 ----------
  function sourceMeta() {
    const s = state.samples; const n = s.length;
    let cadenceMs = null;
    if (n >= 10) {
      const tail = s.slice(-60); const gaps = [];
      for (let i = 1; i < tail.length; i++) gaps.push(tail[i].t - tail[i - 1].t);
      gaps.sort((a, b) => a - b); cadenceMs = gaps[gaps.length >> 1];
    }
    // 900–1100 ms 都算 1s（WHOOP 广播实测中位 960 ms）；更细的用 ms
    const cadence = cadenceMs == null ? null : cadenceMs >= 900 ? `${Math.max(1, Math.round(cadenceMs / 1000))}s` : `${Math.round(cadenceMs)}ms`;
    const recent = s.slice(-30); const rr = recent.length ? recent.some((x) => x.rr && x.rr.length) : null;
    const model = state.deviceInfo && state.deviceInfo.model;
    const device = state.deviceName ? `${state.deviceName.split(' ')[0].toLowerCase()}${model ? '-' + String(model).toLowerCase() : ''}` : null;
    const hints = cardHints();
    const perceiver = hints && hints.perceivers.length && getMode() !== 'author' ? hints.perceivers : null;
    return { device, transport: state.connected ? 'ble' : (state.bridgeUp ? 'bridge' : (n ? 'bus' : null)), cadence, cadenceMs, rr: rr == null ? undefined : rr, trigger: state.lastTrigger || 'normal', perceiver };
  }
  const PRIOR_FIELDS = ['recovery', 'hrv', 'rhr', 'sleepHours', 'spo2', 'skinTemp'];
  // 总线送来的不合规数据：拒收并计数（诊断 BAD_INPUT，v0.3 §4.4）
  function rejectInput(where, field) {
    state.badInput = (state.badInput || 0) + 1;
    state.lastBadInput = { where, field, at: Date.now() };
    console.warn(LOG, `${where} rejected: bad ${field}`);
    return false;
  }
  function setPrior(prior) {   // 非实时来源（whoop-api / 健康桥）的日级先验：{ source, date, fields:{recovery,hrv,rhr,sleepHours,spo2,skinTemp} }
    if (prior && typeof prior === 'object') {
      const source = prior.source == null ? 'api' : prior.source;
      if (!HeartlinkCore.isIdent(source)) return rejectInput('setPrior', 'source');
      if (prior.date != null && !HeartlinkCore.isDateText(prior.date)) return rejectInput('setPrior', 'date');
      const fields = {};
      for (const k of PRIOR_FIELDS) { const v = prior.fields && prior.fields[k]; if (typeof v === 'number' && Number.isFinite(v)) fields[k] = v; }
      state.prior = { source, date: prior.date || null, fields };
    } else state.prior = null;
    saveSettings(); render(); emit('bio:state', getState());
    return state.prior;
  }

  // ---------- 0.8：TBC 总线（协议 device-interface-zh.md §1–§3）——别的脚本/扩展往这里 push 样本、登记设备状态行、订阅事件 ----------
  // 只给测试与 ON/SHAM 实验用（面板里没有开关）；不存盘，刷新页面即恢复注入
  function setExposure(x) {
    if (x && typeof x.inject === 'boolean') { state.injectEnabled = x.inject; if (!x.inject) clearInject(); render(); }
    return { inject: state.injectEnabled !== false };
  }
  function diagnostics() {
    const now = Date.now();
    const meta = sourceMeta();
    const c = ctx();
    const hints = cardHints();
    const card = hints ? Object.assign({}, hints.mode ? { mode_hint: HeartlinkCore.WIRE_MODE[hints.mode] } : {}, hints.perceivers.length ? { perceiver: hints.perceivers } : {}) : null;
    let secure = true; try { secure = host.isSecureContext !== false; } catch (_) {}
    const d = HeartlinkCore.buildDiagnostics({
      version: VERSION, now, bluetooth: !!bluetooth(), secureContext: secure,
      host: c && c.getCurrentChatId ? 'sillytavern' : 'unknown',
      connected: state.connected, deviceName: state.deviceName, transport: meta.transport, cadenceMs: meta.cadenceMs ?? null,
      rr: meta.rr === undefined ? null : meta.rr, lastSampleAgeMs: state.lastSample ? now - state.lastSample.t : null, battery: state.battery ?? null,
      mode: getMode(), modeSource: modeSource(), card: card && Object.keys(card).length ? card : null,
      injectEnabled: state.injectEnabled !== false, lastInjectAt: state.lastInjectAt, lastTrigger: state.lastTrigger || null, backgroundSkipped: state.backgroundSkipped || 0,
      guideActive: state.guideActive, multiWindow: state.multiWindow, hostOk: !!(typeof injectPrompts === 'function' || (c && typeof c.setExtensionPrompt === 'function')),
      badInput: state.badInput || 0, invalidBlocks: state.invalidBlocks || 0, guideConflict: state.guideConflict || null,
    });
    try {
      d.haptics = { enabled: !!state.haptics.enabled, maxIntensity: state.haptics.maxIntensity, actuators: actuators.list().length, intiface: state.intifaceStatus };
      // 诊断里不写设备型号名（用户会把诊断发出来）：只有驱动 id 与状态
      const direct = directState().map((l) => ({ driver: l.driver, phase: l.phase, status: l.status, error: l.error, exclusive: l.exclusive, stopsOnDisconnect: l.stopsOnDisconnect, actuators: l.actuators.length, maybeRunning: l.maybeRunning, stopFailed: l.stopFailed, native: l.native.length, ackTimeouts: l.ackTimeouts, battery: l.battery }));
      if (direct.length) d.haptics.direct = direct;
      const dp = directProblems();
      if (dp.length) d.haptics.problems = dp;   // TOY_* 代码登记进协议 §4.4 之前不进 problems（那里是封闭枚举）
    } catch (_) {}
    return d;
  }
  function exportDiagnostics() { return JSON.stringify(diagnostics(), null, 2); }
  // 没有酒馆助手时，世界书走酒馆核心接口（/world 开关全局）。
  // 读：优先 getContext().loadWorldInfo（带宿主的 worldInfoCache，ST 1.18 world-info.js:2036-2058，st-context.js:276），没有才直接 REST。
  // 写：优先 getContext().saveWorldInfo(name, data, true)（先更新缓存再写盘并发 WORLDINFO_UPDATED，world-info.js:4097-4108、4071-4081）；
  //    它不检查 HTTP 结果，所以写完用 REST 读回核对一次，不对就退回 REST 写。直接 REST 写不会更新宿主缓存（本地实测缓存会留旧副本）。
  const nativeWb = {
    ok() { const c = ctx(); return !!(c && typeof c.getRequestHeaders === 'function' && typeof c.executeSlashCommandsWithOptions === 'function'); },
    suspect: new Set(),   // 宿主缓存可能和磁盘不一致的书：直接读 REST
    entriesOf(j) { return j && j.entries && Object.keys(j.entries).length ? Object.values(j.entries) : null; },
    async restGet(name) {
      const r = await host.fetch('/api/worldinfo/get', { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ name }), cache: 'no-cache' });
      if (!r.ok) return null;
      return this.entriesOf(await r.json());
    },
    async get(name) {
      const c = ctx();
      if (c && typeof c.loadWorldInfo === 'function' && !this.suspect.has(name)) return this.entriesOf(await c.loadWorldInfo(name));
      return this.restGet(name);
    },
    async restPut(name, data) {
      const r = await host.fetch('/api/worldinfo/edit', { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ name, data }) });
      if (!r.ok) throw new Error('写世界书失败 ' + r.status);
    },
    async put(name, list) {
      const c = ctx(); const data = { entries: {} };
      list.forEach((e, i) => { data.entries[i] = e; });
      if (typeof c.saveWorldInfo === 'function') {
        this.suspect.add(name);   // 核对通过前不信缓存
        await c.saveWorldInfo(name, JSON.parse(JSON.stringify(data)), true);   // 宿主缓存直接存这个对象（cloneOnSet:false），给它一份独立副本
        if (!HeartlinkCore.guideEntriesUpToDate(await this.restGet(name), list)) await this.restPut(name, data);   // 宿主写失败：自己写（缓存里已是新内容）
        this.suspect.delete(name);
      } else await this.restPut(name, data);
      try { await c.updateWorldInfoList?.(); } catch (_) {}
    },
    globals() { return [...doc.querySelectorAll('#world_info option')].filter((o) => o.selected).map((o) => o.textContent); },
    async setGlobal(name, on) { await ctx().executeSlashCommandsWithOptions(`/world state=${on ? 'on' : 'off'} silent=true ${name}`); },
    active() {
      const c = ctx() || {}; const names = new Set(this.globals());
      try { const w = c.characters && c.characters[c.characterId] && c.characters[c.characterId].data && c.characters[c.characterId].data.extensions && c.characters[c.characterId].data.extensions.world; if (w) names.add(w); } catch (_) {}
      try { if (c.chatMetadata && c.chatMetadata.world_info) names.add(c.chatMetadata.world_info); } catch (_) {}
      return names;
    },
  };
  // 读法世界书是否启用（找含 <bio_context_guide> 的已启用条目）；换聊天 / 世界书改动时查，另有低频兜底（GUIDE_CHECK_MS）
  let guideCheckTimer = null;
  function scheduleGuideCheck() {   // 事件常成串出现（保存 + 设置），合成一次
    if (guideCheckTimer || destroyed) return;
    guideCheckTimer = host.setTimeout(() => { guideCheckTimer = null; if (!destroyed) refreshGuideActive(); }, 500);
  }
  async function refreshGuideActive() {
    try {
      const TH = host.TavernHelper;
      if (!TH || typeof TH.getWorldbook !== 'function') {
        if (!nativeWb.ok()) return;
        let found = false;
        for (const n of nativeWb.active()) {
          const es = await nativeWb.get(n);
          if (es && es.some((e) => !e.disable && String(e.content || '').includes('<bio_context_guide>'))) { found = true; break; }
        }
        state.guideActive = found;
        return;
      }
      const names = new Set([...(TH.getGlobalWorldbookNames ? TH.getGlobalWorldbookNames() : [])]);
      try { const cw = TH.getCharWorldbookNames ? TH.getCharWorldbookNames('current') : null; if (cw) { if (cw.primary) names.add(cw.primary); (cw.additional || []).forEach((n) => names.add(n)); } } catch (_) {}
      try { const chw = TH.getChatWorldbookName ? TH.getChatWorldbookName('current') : null; if (chw) names.add(chw); } catch (_) {}
      let found = false;
      for (const n of names) {
        const entries = await TH.getWorldbook(n);
        if (entries.some((e) => e.enabled !== false && String(e.content || '').includes('<bio_context_guide>'))) { found = true; break; }
      }
      state.guideActive = found;
    } catch (err) { console.log(LOG, 'guide check skipped:', err && err.message); }
  }
  // 读法世界书版本保护：书上记着写入它的 heartlink 版本；更新的版本写的不覆盖；本浏览器里写过新版、现在却被旧版改回去 → 记冲突
  function markGuideWrote() {
    if (state.guideWrote && HeartlinkCore.compareVersions(state.guideWrote, VERSION) >= 0) return;
    state.guideWrote = VERSION; saveSettings();
  }
  function guideNewer(by, via) {
    state.guideSync = { at: Date.now(), skipped: 'newer', by, via };
    console.warn(LOG, `guide worldbook was written by newer heartlink ${by}; not overwriting (this page runs ${VERSION})`);
    if (!state.guideNewerNotified) { state.guideNewerNotified = true; toast('warning', `读法世界书是更新的 heartlink ${by} 写的，本页还是 ${VERSION}，没有覆盖。请刷新页面或更新 heartlink。`); }
  }
  function noteGuideConflict(by) {
    const prev = state.guideConflict;
    state.guideConflict = { at: Date.now(), by: by || null, count: ((prev && prev.count) || 0) + 1 };
    console.warn(LOG, `guide worldbook was rewritten by an older heartlink (${by || 'unknown version'}); restoring ${VERSION}`);
    if (!prev) toast('warning', '有旧版 heartlink 在改写读法世界书，请更新或停用旧版');
  }
  // 兜底复查时看书有没有被旧版改回去（直接读盘，不信宿主缓存：别的标签页写的不会更新本页缓存）
  async function checkGuideConflict() {
    if (!state.guideWrote || state.guideRepairing) return;
    try {
      const TH = host.TavernHelper;
      let es = null; let upToDate = false;
      if (FORM !== 'extension' && TH && typeof TH.getWorldbook === 'function' && GUIDE_BOOK) {
        try { es = await TH.getWorldbook(GUIDE_BOOK_NAME); } catch (_) { return; }
        upToDate = Boolean(es && es.length === GUIDE_BOOK.length && es.every((e) => e.extra && e.extra.heartlink === VERSION));
      } else if (GUIDE_BOOK_NATIVE && nativeWb.ok()) {
        es = await nativeWb.restGet(GUIDE_BOOK_NAME);
        upToDate = HeartlinkCore.guideEntriesUpToDate(es, GUIDE_BOOK_NATIVE);
      } else return;
      const dec = HeartlinkCore.guideDecision({ current: es, upToDate, version: VERSION, lastWrote: state.guideWrote });
      if (dec.action !== 'write' || !dec.conflict) return;
      state.guideRepairing = true;
      try { nativeWb.suspect.add(GUIDE_BOOK_NAME); await ensureGuideWorldbook(); } finally { state.guideRepairing = false; }
    } catch (err) { console.log(LOG, 'guide conflict check skipped:', err && err.message); }
  }
  // 0.9.5：读法世界书由脚本自己维护——缺了就建、版本旧了就换、没绑全局就绑；旧的手动导入版（条目名相同）解绑，避免两份读法
  async function ensureGuideWorldbookNative() {
    if (!GUIDE_BOOK_NATIVE || !nativeWb.ok()) { state.guideSync = { at: Date.now(), skipped: 'no-api' }; return; }
    try {
      const current = await nativeWb.get(GUIDE_BOOK_NAME);
      const upToDate = HeartlinkCore.guideEntriesUpToDate(current, GUIDE_BOOK_NATIVE);
      const dec = HeartlinkCore.guideDecision({ current, upToDate, version: VERSION, lastWrote: state.guideWrote });
      if (dec.action === 'newer') { guideNewer(dec.by, 'st-core'); await refreshGuideActive(); return; }
      if (dec.conflict) noteGuideConflict(dec.by);
      if (!upToDate) { await nativeWb.put(GUIDE_BOOK_NAME, GUIDE_BOOK_NATIVE); markGuideWrote(); }
      const ours = new Set(GUIDE_BOOK_NATIVE.map((e) => e.comment));
      const globals = nativeWb.globals();
      const legacy = [];
      for (const n of globals) {
        if (n === GUIDE_BOOK_NAME) continue;
        try { const es = await nativeWb.get(n); if (es && es.every((e) => ours.has(e.comment) || /bio_context/.test(String(e.content || '')))) legacy.push(n); } catch (_) {}
      }
      for (const n of legacy) await nativeWb.setGlobal(n, false);
      if (!nativeWb.globals().includes(GUIDE_BOOK_NAME)) await nativeWb.setGlobal(GUIDE_BOOK_NAME, true);
      state.guideSync = { at: Date.now(), wrote: !upToDate, legacy, bound: nativeWb.globals(), via: 'st-core' };
      if (!upToDate || legacy.length) toast('info', `${upToDate ? '' : `读法世界书已${current ? '更新' : '安装'}（${GUIDE_BOOK_NAME}）`}${legacy.length ? `${upToDate ? '' : '；'}已停用旧的手动导入版读法世界书：${legacy.join('、')}` : ''}`);
      await refreshGuideActive();
    } catch (err) { state.guideSync = { at: Date.now(), error: String(err && err.message || err) }; console.warn(LOG, 'ensureGuideWorldbook (st-core) failed', err); }
  }
  async function ensureGuideWorldbook() {
    const TH = host.TavernHelper;
    if (FORM === 'extension' || !TH || typeof TH.createOrReplaceWorldbook !== 'function') return ensureGuideWorldbookNative();
    if (!GUIDE_BOOK || !TH || typeof TH.createOrReplaceWorldbook !== 'function' || typeof TH.rebindGlobalWorldbooks !== 'function') { state.guideSync = { at: Date.now(), skipped: 'no-api' }; return; }
    try {
      const names = TH.getWorldbookNames ? TH.getWorldbookNames() : [];
      let current = null;
      if (names.includes(GUIDE_BOOK_NAME)) { try { current = await TH.getWorldbook(GUIDE_BOOK_NAME); } catch (_) {} }
      const upToDate = Boolean(current && current.length === GUIDE_BOOK.length && current.every((e) => e.extra && e.extra.heartlink === VERSION));
      const dec = HeartlinkCore.guideDecision({ current, upToDate, version: VERSION, lastWrote: state.guideWrote });
      if (dec.action === 'newer') { guideNewer(dec.by, 'tavern-helper'); await refreshGuideActive(); return; }
      if (dec.conflict) noteGuideConflict(dec.by);
      if (!upToDate) { await TH.createOrReplaceWorldbook(GUIDE_BOOK_NAME, GUIDE_BOOK, { render: 'none' }); markGuideWrote(); }
      const ours = new Set(GUIDE_BOOK.map((e) => e.name));
      const globals = TH.getGlobalWorldbookNames();
      const legacy = [];
      for (const n of globals) {
        if (n === GUIDE_BOOK_NAME) continue;
        try { const es = await TH.getWorldbook(n); if (es.length && es.every((e) => ours.has(e.name) || /bio_context/.test(String(e.content || '')))) legacy.push(n); } catch (_) {}   // 旧的手动导入版：每条都在讲 bio_context
      }
      const next = globals.filter((n) => !legacy.includes(n));
      if (!next.includes(GUIDE_BOOK_NAME)) next.push(GUIDE_BOOK_NAME);
      if (next.length !== globals.length || legacy.length) await TH.rebindGlobalWorldbooks(next);
      state.guideSync = { at: Date.now(), wrote: !upToDate, legacy, bound: next };
      if (!upToDate || legacy.length) toast('info', `${upToDate ? '' : `读法世界书已${current ? '更新' : '安装'}（${GUIDE_BOOK_NAME}）`}${legacy.length ? `${upToDate ? '' : '；'}已停用旧的手动导入版读法世界书：${legacy.join('、')}` : ''}`);
      await refreshGuideActive();
    } catch (err) { state.guideSync = { at: Date.now(), error: String(err && err.message || err) }; console.warn(LOG, 'ensureGuideWorldbook failed', err); }
  }
  // 同一聊天多窗口：用 BroadcastChannel 互相打招呼
  function watchWindows() {
    if (typeof host.BroadcastChannel !== 'function') return;
    const me = Math.random().toString(36).slice(2);
    const ch = new host.BroadcastChannel('heartlink');
    let lastSeen = 0;
    ch.onmessage = (e) => {
      const m = e.data || {};
      if (m.id === me || m.chat !== chatId()) return;
      lastSeen = Date.now();
      if (m.type === 'hello') ch.postMessage({ type: 'here', id: me, chat: chatId() });
    };
    // 0.9.5：别的页面装了更新的版本 → 提示本页刷新（更新只对执行更新的那个页面生效）
    const vc = new host.BroadcastChannel('heartlink-version');
    vc.onmessage = (e) => {
      const v = e.data && e.data.version;
      if (typeof v === 'string' && newerThan(v, VERSION) && !state.staleNotified) {
        state.staleNotified = true; state.newerVersion = v; render();
        toast('warning', `heartlink ${v} 已在别的页面装好，这个页面还是 ${VERSION}，请刷新本页。`);
      }
    };
    vc.postMessage({ version: VERSION });
    disposers.push(() => { try { vc.close(); } catch (_) {} });
    const tick = () => { ch.postMessage({ type: 'hello', id: me, chat: chatId() }); state.multiWindow = Date.now() - lastSeen < 15000; };
    const t = host.setInterval(tick, 5000); tick();
    disposers.push(() => { host.clearInterval(t); try { ch.close(); } catch (_) {} });
  }
  function newerThan(a, b) {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0; }
    return false;
  }
  function emitDiagnosticsIfChanged() {
    const d = diagnostics();
    const key = d.problems.map((p) => p.code).join(',');
    if (key !== state.lastProblemKey) { state.lastProblemKey = key; emit('bio:diagnostics', d); }
  }
  const TBC_VERSION = '0.3';
  function kinds() { if (!state.kinds) state.kinds = {}; return state.kinds; }
  function contextSources() { if (!state.contextSources) state.contextSources = {}; return state.contextSources; }
  // 总线样本入口（v0.3 §4.4–4.5）：标识类字段不合规就拒收（返回 false）；t 超出 [现在 − 24 小时, 现在 + 5 秒] 拒收，
  // 其余按 sample.t 归入相位（不晚于现在）；页面自己连着蓝牙心率时，外来的 hr 不入账（主信号唯一）
  const DAY_MS = 24 * 3600 * 1000;
  function tbcPush(sample) {
    const now = Date.now();
    if (!sample || typeof sample !== 'object') return rejectInput('tbc.push', 'sample');
    const kind = sample.kind;
    if (!HeartlinkCore.isKindName(kind)) return rejectInput('tbc.push', 'kind');
    const source = sample.source == null ? 'external' : sample.source;
    if (!HeartlinkCore.isIdent(source)) return rejectInput('tbc.push', 'source');
    if (sample.unit != null && !HeartlinkCore.isIdent(sample.unit)) return rejectInput('tbc.push', 'unit');
    if (sample.device != null && !HeartlinkCore.isDeviceName(sample.device)) return rejectInput('tbc.push', 'device');
    if (sample.cadence != null && !(typeof sample.cadence === 'string' && /^\d+(?:ms|s)$/.test(sample.cadence))) return rejectInput('tbc.push', 'cadence');
    if (typeof sample.value !== 'number' || !Number.isFinite(sample.value)) return rejectInput('tbc.push', 'value');
    let t = now;
    if (sample.t != null) {
      if (typeof sample.t !== 'number' || !Number.isFinite(sample.t) || sample.t < now - DAY_MS || sample.t > now + 5000) return rejectInput('tbc.push', 't');
      t = Math.min(sample.t, now);
    }
    if (kind === 'hr') {
      if (state.connected) return false;   // 页面蓝牙是主来源
      const rr = Array.isArray(sample.rr) ? sample.rr.filter((x) => typeof x === 'number' && Number.isFinite(x) && x > 0 && x < 3) : [];
      if (!HeartlinkCore.hrPlausible(Math.round(sample.value))) return false;   // 0、300 之类：不入账，也不算别的脚本出错（桥没读到数时常送 0）
      acceptHr('bus', Math.round(sample.value), rr, t);
      return true;
    }
    const k = kinds();
    if (!k[kind]) k[kind] = { source, unit: sample.unit || 'raw', cadence: sample.cadence || null, device: sample.device || null, samples: [] };
    const bucket = k[kind];
    bucket.source = source; if (sample.unit) bucket.unit = sample.unit; if (sample.cadence) bucket.cadence = sample.cadence;
    const arr = bucket.samples; const item = { t, value: sample.value, quality: sample.quality };
    if (!arr.length || arr[arr.length - 1].t <= t) arr.push(item);
    else { let i = arr.length - 1; while (i >= 0 && arr[i].t > t) i--; arr.splice(i + 1, 0, item); }
    if (arr.length > CONFIG.MAX_SAMPLES) arr.splice(0, arr.length - CONFIG.MAX_SAMPLES);
    emit('bio:sample', Object.assign({}, sample, { t, source, kind, value: sample.value }));
    return true;
  }
  function tbcRegisterContext(source, fn) {
    if (!source || typeof fn !== 'function') throw new Error('tbc.registerContext: need (source, fn)');
    contextSources()[String(source)] = fn; emit('bio:state', getState()); render();
  }
  function tbcUnregisterContext(source) { delete contextSources()[String(source)]; emit('bio:state', getState()); render(); }
  function deviceLines() {
    const out = [];
    try { const a = actuationLine(); if (a) out.push(a); } catch (_) {}
    for (const [source, fn] of Object.entries(contextSources())) {
      try { const v = fn(); if (v != null && String(v).trim()) out.push(String(v)); }
      catch (err) { console.warn(LOG, 'context source failed:', source, err); }
    }
    return out;
  }
  function tbcSources() {
    return { signals: Object.assign({ hr: state.samples.length ? { source: 'heartlink', n: state.samples.length } : null }, Object.fromEntries(Object.entries(kinds()).map(([k, v]) => [k, { source: v.source, unit: v.unit, cadence: v.cadence, n: v.samples.length }]))), contexts: Object.keys(contextSources()) };
  }
  // ---------- 0.9：本机桥客户端（协议 spec-v0.2 §6）----------
  // 本机桥（协议 v0.3 §6；原先的 macOS 桥程序已停用，目前没有维护中的实现）：桥连蓝牙、推 bio:sample；页面把状态回传（cmd:state / prior），
  // 这样 Safari / iPhone / 局域网 http 的酒馆也能拿到心率。ws://127.0.0.1 从 https 页面连在 Chrome/Firefox 允许（回环例外），Safari 不允许。
  function bridgeSend(obj) { try { if (state.bridge && state.bridge.readyState === 1) state.bridge.send(JSON.stringify(obj)); } catch (_) {} }
  function bridgeConnect(attempt) {
    if (destroyed || typeof host.WebSocket !== 'function') return;
    if (state.bridge && (state.bridge.readyState === 0 || state.bridge.readyState === 1)) return;
    let ws;
    try { ws = new host.WebSocket(CONFIG.BRIDGE_URL); } catch (_) { return; }
    state.bridge = ws; state.bridgeAttempt = attempt || 0;
    ws.onopen = () => { state.bridgeAttempt = 0; state.bridgeUp = true; state.bridgeEverUp = true; bridgeSend({ cmd: 'hello', client: 'sillytavern-heartlink', version: VERSION }); bridgeState(); console.log(LOG, 'bridge connected', CONFIG.BRIDGE_URL); render(); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (!m || !m.event) return;
      if (m.event === 'bio:sample' && m.detail) {
        const d = m.detail;
        if (d.kind === 'hr' && state.connected) return;            // 页面自己连着蓝牙，桥的 hr 不重复入账
        try { tbcPush(Object.assign({ source: 'bridge' }, d, { t: typeof d.t === 'number' ? d.t : Date.now() })); } catch (_) {}
      } else if (m.event === 'bio:state' && m.detail) { state.bridgeInfo = m.detail; render(); }
      else if (m.event === 'bio:prior' && m.detail) { setPrior(m.detail); console.log(LOG, 'prior from bridge', m.detail.source, m.detail.date); }
    };
    ws.onclose = () => { state.bridgeUp = false; state.bridgeInfo = null; render(); const n = state.bridgeAttempt || 0; if (!state.bridgeEverUp && n >= 2) { console.log(LOG, 'bridge not running; stop retrying (reload the page after starting it)'); return; } const delay = CONFIG.BRIDGE_RETRY_MS[Math.min(n, CONFIG.BRIDGE_RETRY_MS.length - 1)]; host.setTimeout(() => bridgeConnect(n + 1), delay); };
    ws.onerror = () => {};
  }
  function currentPhase() {
    const ev = state.events; const last = [...ev].reverse();
    const at = (t) => last.find((e) => e.type === t);
    const send = at('send'), reply = at('reply_end'), typ = at('type');
    if (state.generating && send) return { name: 'gen', since: send.t };
    if (reply && (!typ || typ.t < reply.t)) return { name: 'read', since: reply.t };
    if (typ && reply && typ.t > reply.t) return { name: 'write', since: typ.t };
    return null;
  }
  function bridgeState() {
    const b = baselineInfo(); const h = history();
    bridgeSend({ cmd: 'state', detail: { baseline: b ? { bpm: b.bpm, hrv: b.hrv || null } : null, phase: currentPhase(), summary: h.length ? h[h.length - 1] : null, mode: getMode(), chatId: chatId() } });
    if (state.prior) bridgeSend({ cmd: 'prior', prior: state.prior });
  }

  // ---------- 0.10：触觉输出（TBC v0.3 §5） ----------
  // 触觉帧的计时放进 Worker：酒馆页切到后台（例如去看模拟器）时，浏览器会把页面计时器压到约每秒一次，
  // 强度帧就会走样；Worker 里的计时不受这条限制。建不了 Worker 时退回页面计时器。
  function createWorkerTimers() {
    try {
      const src = "const t=new Map();onmessage=(e)=>{const d=e.data;if(d.op==='set'){const f=()=>postMessage(d.id);t.set(d.id,d.every?setInterval(f,d.ms):setTimeout(()=>{t.delete(d.id);f();},d.ms));}else{const h=t.get(d.id);if(h!=null){clearTimeout(h);clearInterval(h);t.delete(d.id);}}};";
      const url = host.URL.createObjectURL(new host.Blob([src], { type: 'text/javascript' }));
      const w = new host.Worker(url);
      const cbs = new Map();
      let seq = 0;
      w.onmessage = (e) => {
        const c = cbs.get(e.data);
        if (!c) return;
        if (!c.every) cbs.delete(e.data);
        try { c.fn(); } catch (err) { console.warn(LOG, 'timer callback failed', err); }
      };
      const set = (fn, ms, every) => { const id = ++seq; cbs.set(id, { fn, every }); w.postMessage({ op: 'set', id, ms: Math.max(0, Number(ms) || 0), every: !!every }); return id; };
      const clear = (id) => { if (cbs.delete(id)) w.postMessage({ op: 'clear', id }); };
      disposers.push(() => { try { w.terminate(); host.URL.revokeObjectURL(url); } catch (_) {} });
      return { setTimeout: (f, ms) => set(f, ms, false), clearTimeout: clear, setInterval: (f, ms) => set(f, ms, true), clearInterval: clear, kind: 'worker' };
    } catch (err) {
      console.warn(LOG, 'worker timers unavailable, using page timers:', err && err.message);
      return null;
    }
  }
  const hTimers = createWorkerTimers() || { setTimeout: (f, ms) => host.setTimeout(f, ms), clearTimeout: (id) => host.clearTimeout(id), setInterval: (f, ms) => host.setInterval(f, ms), clearInterval: (id) => host.clearInterval(id), kind: 'page' };
  // 节奏细调按档存：custom = { 'slow-burn': {...}, steady: {...} }（§7-6，用户 2026-09-18 定要做）
  const paceProfile = () => state.haptics.profile || HeartlinkHaptics.DEFAULT_PROFILE;
  const customFor = (p) => (state.haptics.custom && typeof state.haptics.custom === 'object' ? state.haptics.custom[p] : null) || {};
  function hapticsPolicy() {
    const wear = kinds().wear;
    const lastWear = wear && wear.samples.length ? wear.samples[wear.samples.length - 1].value : null;
    const set = HeartlinkHaptics.resolveSettings(state.haptics.profile, customFor(paceProfile()));
    return Object.assign(set, { enabled: !!state.haptics.enabled, maxIntensity: state.haptics.maxIntensity, worn: lastWear === 0 ? false : null, off: state.haptics.off || [] });
  }
  // 只列改过的参数（协议 v0.4 §13 tuned 段，范围照校验器：floor≤95%、时长 1–60s、gap 0.2–10s、per-reply 1–5）
  function tunedSegment(set) {
    const def = HeartlinkHaptics.PROFILES[set.profile]; if (!def) return '';
    const out = [];
    if (Math.abs(set.floor - def.floor) > 1e-9) out.push(`floor ${Math.round(set.floor * 100)}%`);
    for (const k of ['long', 'heartbeat', 'wave']) if (set.defaultMs[k] !== def.defaultMs[k]) out.push(`${k} ${(set.defaultMs[k] / 1000).toFixed(1)}s`);
    if (set.minIntervalMs !== def.minIntervalMs) out.push(`gap ${(set.minIntervalMs / 1000).toFixed(1)}s`);
    if (set.maxPerReply !== def.maxPerReply) out.push(`per-reply ${set.maxPerReply}`);
    return out.length ? `tuned ${out.join(', ')}` : '';
  }
  // 细调一个参数：dir = ±1；一次动多久把三种时长一起设成同一个值
  function setPace(param, dir) {
    const p = paceProfile();
    const cur = HeartlinkHaptics.resolveSettings(p, customFor(p));
    const patch = {};
    if (param === 'floor') patch.floor = Math.max(0, Math.min(0.95, Math.round((cur.floor + dir * 0.05) * 100) / 100));
    else if (param === 'dur') { const v = Math.max(1000, Math.min(60000, cur.defaultMs.long + dir * 500)); patch.defaultMs = { long: v, heartbeat: v, wave: v }; }
    else if (param === 'gap') patch.minIntervalMs = Math.max(200, Math.min(10000, cur.minIntervalMs + dir * 200));
    else if (param === 'perReply') patch.maxPerReply = Math.max(1, Math.min(5, cur.maxPerReply + dir));
    setHaptics({ custom: { [p]: Object.assign({}, customFor(p), patch) } });
  }
  function resetPace() { const p = paceProfile(); if (state.haptics.custom && state.haptics.custom[p]) { delete state.haptics.custom[p]; saveSettings(); render(); emit('bio:state', getState()); } }
  const actuators = HeartlinkHaptics.createRegistry({
    timers: hTimers, now: () => Date.now(), policy: hapticsPolicy,
    emit: (name, detail) => {
      emit(name, detail);
      if (name === 'bio:actuators') { try { emit('bio:output-state', outputState()); } catch (_) {} }
      if (name !== 'bio:actuate') return;
      bridgeSend({ event: 'bio:actuate', detail });
      if (detail.source === 'stop') {
        const failed = (detail.results || []).filter((r) => r && r.refused === 'stop-failed');
        if (failed.length) noteStopFailed(failed);
      }
      const src = String(detail.source || '');
      if (src.startsWith('reply:')) {
        const e = entryBySource(src);
        if (e) {
          const rec = { t: detail.t, pattern: detail.action.pattern, results: detail.results };
          // 按动作序号放（§5.11 results 与 acts 一一对应；没排上的动作留空）
          if (Number.isInteger(detail.act)) { while (e.results.length < detail.act) e.results.push(null); e.results[detail.act] = rec; }
          else e.results.push(rec);
          emit('bio:reply-acts', e);
        }
      }
      render();
    },
    onAct: (ev) => onActEvent(ev),
    log: (...a) => console.warn(LOG, ...a),
  });
  const toyFeatures = new Map();   // key → feature（带 driver：intiface 或 wasm）
  const toyBattery = new Map();    // `${source}:${deviceIndex}` → 电量 0–100（v4 InputCmd 读到才有）
  const toyInputs = new Map();     // key → 能读电量的特性（不是输出，不登记执行器）
  const toySensors = new Map();    // key → 玩具自带的压力 / 按键特性（v0.4 §5.6；订阅后只当相对变化用）
  const toyLevels = new Map();     // key → 最近一次发出的档位（0–1，设备卡的实时动效只画这个，不代表设备真的执行了）
  let intiface = null;
  // 每个来源（intiface / wasm）各自同步自己的特性，互不影响
  function syncToys(source, driver, features) {
    const keep = new Set(features.map((f) => f.key));
    for (const [key, f] of [...toyInputs.entries()]) if (f.source === source && !keep.has(key)) { toyInputs.delete(key); toyBattery.delete(`${f.source}:${f.deviceIndex}`); }
    for (const [key, f] of [...toySensors.entries()]) if (f.source === source && !keep.has(key)) { toySensors.delete(key); delete kinds()[sensorKind(f)]; }
    for (const [key, f] of [...toyFeatures.entries()]) if (f.source === source && !keep.has(key)) { toyFeatures.delete(key); toyLevels.delete(key); actuators.unregister(key); }
    for (const f0 of features) {
      if (f0.input === 'Battery') { toyInputs.set(f0.key, Object.assign({ source }, f0)); continue; }
      // v0.4 §5.6：玩具上的压力 / 按键。订阅后读数进块里的 pressure / button 行（只写相对变化）
      if (f0.input === 'Pressure' || f0.input === 'Button') {
        if (!toySensors.has(f0.key)) { const f = Object.assign({ source }, f0); toySensors.set(f0.key, f); subscribeToySensor(f); }
        continue;
      }
      if (toyFeatures.has(f0.key)) continue;
      const f = Object.assign({ source }, f0);
      toyFeatures.set(f.key, f);
      // 按位置控制的抽动类用抽动器把强度换成往返速度；其余直接按强度设值
      const stroker = f.mode === 'position' ? HeartlinkHaptics.createStroker({ move: (pos, ms) => driver.alive() && driver.setPosition(f, pos, ms), timers: hTimers }) : null;
      const setLevel = (lv) => {
        if (!driver.alive()) return;
        const L = Math.max(0, Math.min(1, Number(lv) || 0));
        toyLevels.set(f.key, L); devKick();
        if (stroker) stroker.setLevel(L); else driver.setLevel(f, L);
      };
      actuators.register(f.key, Object.assign({ outputs: [f.output], device: `${f.name}${f.feature ? ' ' + f.feature : ''}`.slice(0, 64) }, CONFIG.TOY_CAPS, { via: source === 'wasm' ? 'page' : 'intiface' }), (job) => {
        if (!driver.alive()) return;
        if (job.stop) { toyLevels.set(f.key, 0); devKick(); if (stroker) stroker.stop(); driver.stop(f); return; }
        // 读者调强调弱（§5.12）：帧按比例缩放，改动立即作用到当前档位
        let cur = 0;
        const gain = () => (typeof job.gain === 'function' ? job.gain() : 1);
        const run = HeartlinkHaptics.playFrames(job.frames, (lv) => { cur = lv; setLevel(lv * gain()); }, hTimers);
        if (typeof job.onGain === 'function') job.onGain((g) => { if (cur > 0) setLevel(cur * g); });
        job.bindCancel(() => { run.cancel(); setLevel(0); });
        return run.done;
      });
    }
    render();
  }
  const sensorKind = (f) => (f.input === 'Button' ? 'button' : 'pressure');
  // 括号里写设备 id（协议 §5.6-1，2026-09-18 修订）：buttplug 的传感器是设备上独立的特性，不属于某一路输出；
  // 设备 id 是这台设备所有执行器 id 的公共前缀
  const sensorId = (f) => `intiface:${f.deviceIndex}`;
  function subscribeToySensor(f) {
    if (!intiface || typeof intiface.subscribeInput !== 'function') return;
    Promise.resolve(intiface.subscribeInput(f, true)).then((ok) => {
      if (!ok) console.warn(LOG, 'toy sensor subscribe failed', f.key);
    }).catch(() => {});
  }
  // 服务器推来的传感器读数 → 总线（kind 为 pressure / button，单位 raw）
  function onToySensor(ev) {
    const f = [...toySensors.values()].find((x) => x.deviceIndex === ev.deviceIndex && x.featureIndex === ev.featureIndex && x.input === ev.input);
    if (!f) return;
    const kind = sensorKind(f);
    const k = kinds();
    if (!k[kind] || !k[kind].toy) k[kind] = { source: 'heartlink', unit: 'raw', toy: true, id: sensorId(f), cadence: kind === 'button' ? null : '200ms', samples: [] };
    const arr = k[kind].samples;
    arr.push({ t: ev.t || Date.now(), value: ev.value });
    if (arr.length > HeartlinkCore.CONFIG.MAX_SAMPLES) arr.splice(0, arr.length - HeartlinkCore.CONFIG.MAX_SAMPLES);
    emit('bio:sample', { t: ev.t, kind, value: ev.value, source: 'heartlink', unit: 'raw', device: sensorId(f) });
  }
  const intifaceDriver = { alive: () => !!intiface, setLevel: (f, lv) => intiface.setLevel(f, lv), setPosition: (f, p, ms) => intiface.setPosition(f, p, ms), stop: (f) => intiface.stop(f) };
  // 玩具电量（v4 InputCmd Read）：连上时读一次，之后每 5 分钟一次；读不到就不显示
  const BATTERY_EVERY_MS = 300000;
  let batteryTimer = null;
  async function readToyBattery() {
    if (!intiface || typeof intiface.readBattery !== 'function' || !toyInputs.size) return;
    let changed = false;
    for (const f of [...toyInputs.values()]) {
      if (f.source !== 'intiface') continue;
      try {
        const v = await intiface.readBattery(f);
        const k = `${f.source}:${f.deviceIndex}`;
        if (v == null) continue;
        if (toyBattery.get(k) !== v) { toyBattery.set(k, v); changed = true; }
      } catch (_) {}
    }
    if (changed) render();
  }

  function startIntiface() {
    if (intiface || typeof host.WebSocket !== 'function') return;
    intiface = HeartlinkHaptics.createIntifaceClient({
      WebSocket: host.WebSocket, url: state.haptics.intiface.url, clientName: `heartlink ${VERSION}`, timers: hTimers,
      onFeatures: (fs) => { syncToys('intiface', intifaceDriver, fs); readToyBattery(); },
      onInput: onToySensor,
      onStatus: (st, detail) => {
        const was = state.intifaceStatus; state.intifaceStatus = st; state.intifaceDetail = detail || null;
        if (st === 'connected' && was !== 'connected') toast('success', `已连上 Intiface（协议 v${detail && detail.version}）`);
        if (st === 'disconnected' && was === 'connected') { actuators.stop(undefined, 'disconnected'); toast('warning', 'Intiface 断开了，设备已停，正在重连'); }
        render();
      },
      log: (...a) => console.warn(LOG, ...a),
    });
    intiface.connect();
    if (!batteryTimer) { batteryTimer = hTimers.setInterval(() => { readToyBattery(); }, BATTERY_EVERY_MS); disposers.push(() => { if (batteryTimer) { hTimers.clearInterval(batteryTimer); batteryTimer = null; } }); }
  }
  function stopIntiface() {
    if (!intiface) return;
    actuators.stop();
    intiface.close(); intiface = null;
    syncToys('intiface', intifaceDriver, []);
    state.intifaceStatus = 'idle';
  }

  // ---------- 实验：浏览器内直连（buttplug-wasm，不用装 Intiface） ----------
  // 未经真实设备测试。设备库与 Intiface 相同；需要电脑或安卓上的 Chrome / Edge；必须由用户点击触发。
  const WASM = { client: null, lib: null, devices: new Map(), status: 'idle' };
  const OUT_TYPES = ['Vibrate', 'Rotate', 'Oscillate', 'Constrict', 'HwPositionWithDuration', 'Position'];
  const wasmDriver = {
    alive: () => !!(WASM.client && WASM.client.connected),
    setLevel(f, lv) {
      const feat = f.handle; const L = Math.max(0, Math.min(1, lv));
      feat.runOutput(WASM.lib.DeviceOutput[f.output].percent(L)).catch((e) => console.warn(LOG, 'wasm output failed', e && e.message));
    },
    setPosition(f, pos, ms) {
      f.handle.runOutput(WASM.lib.DeviceOutput.HwPositionWithDuration.percent(Math.max(0, Math.min(1, pos)), Math.round(ms))).catch((e) => console.warn(LOG, 'wasm position failed', e && e.message));
    },
    stop(f) { try { const d = WASM.devices.get(f.deviceIndex); if (d) d.stop().catch(() => {}); } catch (_) {} },
  };
  function wasmFeatures() {
    const out = [];
    for (const d of WASM.devices.values()) {
      for (const [fi, feat] of (d.features || new Map())) {
        const outputs = Object.keys((feat._feature && feat._feature.Output) || {}).filter((o) => OUT_TYPES.includes(o));
        const hasHw = outputs.includes('HwPositionWithDuration');
        for (const o of outputs) {
          if (o === 'Position' && hasHw) continue;
          out.push({ key: `wasm:${d.index}:${fi}:${o}`, deviceIndex: d.index, featureIndex: fi, output: o, mode: o === 'HwPositionWithDuration' || o === 'Position' ? 'position' : 'level', name: d.displayName || d.name, feature: '', handle: feat });
        }
      }
    }
    return out;
  }
  async function startWasm() {
    if (!host.navigator || !host.navigator.bluetooth) { toast('error', NO_BT_TEXT); return; }
    try {
      WASM.status = 'loading'; render();
      if (!WASM.lib) {
        const [bp, bw] = await Promise.all([import('https://cdn.jsdelivr.net/npm/buttplug@4/+esm'), import('https://cdn.jsdelivr.net/npm/buttplug-wasm@3/+esm')]);
        WASM.lib = Object.assign({}, bp, { WasmConnector: bw.ButtplugWasmClientConnector });
      }
      if (!WASM.client) {
        const client = new WASM.lib.ButtplugClient(`heartlink ${VERSION}`);
        client.addListener('deviceadded', (d) => { WASM.devices.set(d.index, d); syncToys('wasm', wasmDriver, wasmFeatures()); toast('success', `已直连：${d.displayName || d.name}`); });
        client.addListener('deviceremoved', (d) => { WASM.devices.delete(d.index); actuators.stop(undefined, 'disconnected'); syncToys('wasm', wasmDriver, wasmFeatures()); });
        client.addListener('disconnect', () => { WASM.devices.clear(); actuators.stop(undefined, 'disconnected'); syncToys('wasm', wasmDriver, []); WASM.status = 'idle'; render(); });
        await client.connect(new WASM.lib.WasmConnector());
        WASM.client = client;
      }
      WASM.status = 'connected'; render();
      await WASM.client.startScanning();   // 浏览器弹出选设备窗口
    } catch (err) {
      WASM.status = 'error'; render();
      toast('error', `直连失败：${err && err.message || err}。可改用 Intiface`);
    }
  }
  async function stopWasm() {
    try { if (WASM.client) { await WASM.client.stopAllDevices().catch(() => {}); await WASM.client.disconnect(); } } catch (_) {}
    WASM.client = null; WASM.devices.clear(); syncToys('wasm', wasmDriver, []); WASM.status = 'idle'; render();
  }

  // ---------- 按 TBC 驱动直连（不经 buttplug wasm；引擎与驱动是 ../device-lab 的副本，见 src/drivers.js） ----------
  // “浏览器直接连”只有一个入口：先选型号（directModels），有 TBC 驱动的型号走 startDirect，其它型号走 startWasm。
  // 这一段只有连接管理、指令路径、停止、断线与状态；界面（选型号面板、设备卡、自带模式开关）另做。
  const DRV = typeof HeartlinkDrivers === 'undefined' ? null : HeartlinkDrivers;
  const DIRECT = { links: new Map(), seq: 0, stopFailed: [] };
  const ACK_WINDOW_MS = 60000;      // 最近一分钟内的回执超时次数
  const ACK_PROBLEM_N = 3;
  const RECONNECT_TRIES = 6;
  const RECONNECT_GAP_MS = 5000;
  const DIRECT_ERROR_TEXT = {
    EXCLUSIVE_BUSY: (l) => `连不上 ${l.driver.model}：这台设备同时只接受一个连接。先在手机上彻底退出 ${DRV.connectionOf(l.driver).officialApp}，或关掉手机蓝牙。`,
    OUT_OF_RANGE: (l) => `找不到 ${l.driver.model}：确认已开机、离电脑近一些。`,
    HANDSHAKE_TIMEOUT: (l) => `${l.driver.model} 没回应：可能官方 App 还连着，或者固件不同。`,
    CONNECT_FAILED: (l) => `这台设备的服务和 ${l.driver.model} 的驱动对不上，可能不是这个型号。`,
  };
  // 型号列表：有驱动的型号 + “其它型号”（走 wasm）。只有界面用，这里先把选择逻辑定下来
  function directModels() {
    const list = (DRV ? DRV.DRIVERS : []).filter((d) => d.status !== 'lab-only').map((d) => ({
      kind: 'driver', id: d.id, name: modelName(d), shape: d.shape || null, namePrefix: d.namePrefix || null,
      outputs: d.parts.filter((p) => p.expose !== false).map((p) => p.name || PART_OUT_ZH[p.output] || p.output),
      unverified: d.status !== 'verified',
      intiface: (d.transports && d.transports.intiface && d.transports.intiface.status) || 'unverified',
      exclusive: DRV.connectionOf(d).exclusive,
    }));
    list.push({ kind: 'wasm', id: 'other', name: '其它型号', outputs: [], unverified: true, intiface: 'official', exclusive: false });
    return list;
  }
  // 0.21 单连接方式：型号只支持一种连接方式时，另一个按钮灰掉，不用配一段说明（效果图 ../docs/single-connection-mockup）
  // 已知型号＝正连着的驱动直连，没有就用最近一次记住的型号（directList().remember）；没有已知型号时不动按钮
  function knownDirectDriver() {
    if (!DRV) return null;
    const active = [...DIRECT.links.values()].find((l) => l.driver);
    if (active) return active.driver;
    const rem = directList().remember || [];
    const last = rem[rem.length - 1];
    return (last && DRV.DRIVERS.find((d) => d.id === last.driver)) || null;
  }
  // 情形 C“只支持 Intiface”：驱动描述里现在没有字段能判断某型号连不了浏览器直连（没写专属驱动的型号都兜底走 buttplug wasm），
  // 等驱动有 direct 不可用的字段再加，这里先固定不禁用。
  function connMethodState() {
    const d = knownDirectDriver();
    const intifaceNone = !!(d && ((d.transports && d.transports.intiface && d.transports.intiface.status) || 'unverified') === 'none');
    return {
      intiface: intifaceNone ? { disabled: true, reason: '这款只能直连' } : { disabled: false, reason: null },
      direct: { disabled: false, reason: null },
    };
  }
  // 用户在选型号面板上点了某一项：有驱动走驱动直连，没有就是原来的 wasm 直连
  function pickDirect(modelId, opts) {
    const d = DRV && DRV.DRIVERS.find((x) => x.id === modelId);
    if (!d && !(opts && opts.driver)) return startWasm();
    return startDirect(modelId, opts);
  }
  const directKey = (link) => `${link.driver.id}:${link.name || ''}`;
  const directList = () => (state.haptics.direct || {});
  function directHas(list, key) { return (directList()[list] || []).includes(key); }
  function directSet(list, key, on) {
    const cur = (directList()[list] || []).filter((x) => x !== key);
    if (on) cur.push(key);
    setHaptics({ direct: Object.assign({}, directList(), { [list]: cur }) });
  }
  // 微电流缺省不登记（按设备开启一次，§6）
  const directEstimOn = (link) => directHas('estimOn', directKey(link));
  // 停不下来的自带模式：按设备 + 部件逐台开启（§5.9-5），默认关，换设备不继承
  const directAllows = (link) => link.driver.parts.filter((p) => directHas('allowUnstoppable', `${directKey(link)}:${p.id}`)).map((p) => p.id);
  function setDirectEstim(linkId, on) { const l = DIRECT.links.get(linkId); if (!l) return false; directSet('estimOn', directKey(l), !!on); rebuildLink(l); return true; }
  function setDirectUnstoppable(linkId, partId, on) {
    const l = DIRECT.links.get(linkId);
    if (!l) return false;
    const p = l.driver.parts.find((x) => x.id === partId);
    const n = p && p.nativePatterns && Object.values(p.nativePatterns).find((x) => x.stoppable === false);
    if (on && !(n && n.maxDurationMs > 0)) return false;                       // 没写最长运行时间的不给开（§5.9-5）
    if (on && DRV.RISKY_OUTPUTS.includes(p.output)) return false;              // 有风险的输出不许停不下来
    directSet('allowUnstoppable', `${directKey(l)}:${partId}`, !!on);
    rebuildLink(l);
    return true;
  }

  function noteLinkError(link, err) {
    const code = err && err.code;
    if (code === 'ACK_TIMEOUT' || code === 'WRITE_FAILED') {
      link.acks = (link.acks || []).filter((t) => Date.now() - t < ACK_WINDOW_MS);
      link.acks.push(Date.now());
    }
  }
  function directEncode(link, partId, level, eo) {
    const raw = Math.max(0, Math.min(1, Number(level) || 0));
    link.raw[partId] = raw;
    // 读者调强调弱（§5.12）：把比例乘在编码这一层，保活重发的帧也跟着变
    const lv = raw > 0 ? Math.max(0, Math.min(1, raw * (link.gain[partId] == null ? 1 : link.gain[partId]))) : 0;
    const id = link.idOf[partId];
    if (id) { toyLevels.set(id, lv); devKick(); }
    return DRV.encode(link.driver, partId, lv, Object.assign({}, eo, link.conn ? { seq: link.conn.seq.next() } : null));
  }
  // 登记这台设备的执行器：握手完成之后才登记，模型在此之前的动作只会得到 unknown-target
  function buildLink(link) {
    const driver = link.driver;
    const estim = directEstimOn(link);
    const include = driver.parts.filter((p) => p.expose !== false && (p.output !== 'Estim' || estim)).map((p) => p.id);
    link.lab = DRV.driverActuators(driver, (bytes) => {
      if (!link.conn) return Promise.reject(new DRV.LinkError('NOT_CONNECTED', `${driver.model} 已断开`));
      return link.conn.write(bytes).catch((err) => { noteLinkError(link, err); throw err; });
    }, {
      timers: hTimers, include, allowUnstoppable: directAllows(link), seq: link.conn.seq, via: 'page', idPrefix: 'direct',
      encode: (partId, level, eo) => directEncode(link, partId, level, eo),
      onStopFailed: (info) => { link.stopFailed = [...new Set([...(link.stopFailed || []), info.part])]; render(); },
      onState: () => { syncLinkState(link); render(); },
    });
    registerLink(link);
  }
  // 换了“微电流 / 自带模式”开关：重建这台设备的执行器（能力要跟着变）
  function rebuildLink(link) {
    if (!link.lab || !link.conn) return;
    unregisterLink(link);
    try { link.lab.stopAll(); } catch (_) {}
    buildLink(link);
  }
  function registerLink(link) {
    const n = [...DIRECT.links.values()].filter((l) => l !== link && l.driver.id === link.driver.id).length;
    const tag = n ? `${link.driver.id}-${n + 1}` : link.driver.id;   // 同一型号连两台：第二台加序号；id 里不含地址与序列号（§2.6）
    link.ids = []; link.idOf = {};
    for (const a of link.lab.actuators) {
      const id = `direct:${tag}:${a.part}`;
      const caps = Object.assign({}, a.caps);
      // 有风险的输出每跑一次至少歇同样长（§5.4-3 允许实现更严）：挡住模型连写好几个 30 秒
      if (caps.outputs.every((o) => DRV.RISKY_OUTPUTS.includes(o)) && caps.maxDurationMs) caps.minIntervalMs = Math.max(caps.minIntervalMs || 0, caps.maxDurationMs);
      link.idOf[a.part] = id;
      link.ids.push(id);
      actuators.register(id, caps, wrapDirect(link, a));
    }
    render();
  }
  function unregisterLink(link) {
    for (const id of link.ids || []) { actuators.unregister(id); toyLevels.delete(id); }
    link.idWas = Object.assign({}, link.idWas, link.idOf);   // 断线后动作列表还要靠它认出是哪一路
    link.ids = []; link.idOf = {};
  }
  function wrapDirect(link, a) {
    return (job) => {
      link.gain[a.part] = 1;
      if (job.stop) return a.handler(job);
      if (typeof job.onGain === 'function') job.onGain((g) => {
        link.gain[a.part] = g;
        const raw = link.raw[a.part] || 0;
        if (raw > 0 && link.conn) link.conn.write(directEncode(link, a.part, raw)).catch((err) => noteLinkError(link, err));
      });
      return a.handler(job);
    };
  }
  function syncLinkState(link) {
    const st = link.lab ? link.lab.status() : null;
    link.maybeRunning = st ? st.maybeRunning.slice() : [];
    // 参考实现一发停止帧就把 native 清掉，但停不下来的自带模式并不因此停下：
    // 横幅要留到设备自己的计时结束（§5.9-5），所以这里自己记住 until
    const now = Date.now();
    const seen = new Map((link.native || []).filter((n) => n.until > now).map((n) => [n.part, n]));
    if (st) for (const [pid, p] of Object.entries(st.parts)) {
      if (p.native && p.native.stoppable === false && p.native.until > now) seen.set(pid, { part: pid, id: link.idOf[pid] || (seen.get(pid) || {}).id || null, until: p.native.until });
    }
    link.native = [...seen.values()];
    if (!link.native.length) link.natStopped = false;
  }

  async function startDirect(driverId, opts) {
    const o = opts || {};
    if (!DRV) { toast('error', '这个版本没有带设备驱动'); return null; }
    const driver = o.driver || DRV.DRIVERS.find((d) => d.id === driverId);
    if (!driver) { toast('error', `没有这个型号的驱动：${driverId}`); return null; }
    const bt = o.bluetooth || bluetooth();
    if (!bt) { toast('error', NO_BT_TEXT); return null; }
    const link = { id: `drv-${++DIRECT.seq}`, driver, name: null, device: null, conn: null, lab: null, ids: [], idOf: {},
      phase: 'picking', error: null, hs: { got: 0, need: (driver.handshake && driver.handshake.expectNotify) || 0 },
      battery: null, maybeRunning: [], native: [], stopFailed: [], gain: {}, raw: {}, acks: [], tries: 0, bt };
    DIRECT.links.set(link.id, link);
    render();
    let device;
    try {
      device = await bt.requestDevice(DRV.requestOptions(driver));   // 必须在用户点击的那个处理函数里同步调用，别先 await 别的东西
    } catch (err) {
      DIRECT.links.delete(link.id);
      render();
      if (err && err.name === 'NotFoundError') { toast('info', `没有选择设备：在浏览器弹出的列表里选名字以 ${driver.namePrefix} 开头的设备；先退出官方 App、离近一点、用电脑或安卓上的 Chrome / Edge。`); return null; }
      toast('error', `选择设备失败：${(err && err.message) || err}`);
      return null;
    }
    link.device = device;
    link.name = device.name || driver.model;
    // 记住型号与名字给重连用（不存地址）
    const remember = (directList().remember || []).filter((x) => !(x.driver === driver.id && x.name === link.name));
    remember.push({ driver: driver.id, name: link.name });
    setHaptics({ direct: Object.assign({}, directList(), { remember: remember.slice(-8) }) });
    if (driver.status !== 'verified') toast('info', `${driver.brand} ${driver.model} 的指令来自社区资料，我们没有实测过：先用低强度试。`);
    return connectLink(link);
  }
  async function connectLink(link) {
    link.phase = link.hs.need ? 'handshake' : 'connecting';
    link.hs.got = 0;
    link.error = null;
    render();
    try {
      // onHandshake：设备每回一条通知就更新进度，界面显示“正在准备设备 2/4”
      link.conn = await DRV.connectDriver(link.driver, link.device, {
        timers: hTimers,
        onHandshake: (info) => { link.hs.got = info.got || 0; link.hs.need = info.need || link.hs.need; render(); },
      });
    } catch (err) {
      link.conn = null;
      link.phase = 'error';
      if (Number.isInteger(err && err.got)) { link.hs.got = err.got; link.hs.need = err.need; }
      link.error = { code: (err && err.code) || 'CONNECT_FAILED', message: String((err && err.message) || err) };
      const text = DIRECT_ERROR_TEXT[link.error.code];
      toast('error', text ? text(link) : link.error.message);   // 独占设备不自动重试抢占（§5.9-7）
      render();
      return null;
    }
    link.phase = 'ready';
    link.tries = 0;
    link.hs.got = link.hs.need;
    link.conn.onDisconnect(() => onLinkDown(link));
    link.conn.readBattery().then((v) => { if (v != null) { link.battery = v; render(); } }).catch(() => {});
    if (!link.lab) buildLink(link);
    else {
      const r = await link.lab.reconnected();   // 重连后第一件事：全部停止，成功了才清掉“可能仍在动”（§5.9-8）
      syncLinkState(link);
      if (!r.ok) reportStopFailed(link, r.failed);
      else link.stopFailed = [];
      registerLink(link);
    }
    toast('success', `已连接 ${link.name}`);
    render();
    return link;
  }
  function onLinkDown(link) {
    if (!link.conn) return;
    link.conn = null;
    link.phase = 'lost';
    try { link.lab.disconnected(); } catch (_) {}   // 先记下“断线前在动的部件”，再撤登记（顺序反了就记不到）
    unregisterLink(link);                       // 断线期间不接动作（模型会得到 unknown-target），重连后先停再重新登记
    syncLinkState(link);
    if (link.maybeRunning.length) toast('warning', `${link.name} 已断开，可能仍在动：按设备按钮关掉，或取下设备。重新连接后会先全部停止。`);
    else toast('warning', `${link.name} 已断开`);
    render();
    if (!DRV.connectionOf(link.driver).exclusive) scheduleReconnect(link);   // 独占设备不自动重连：断开多半是官方 App 抢走了
  }
  function scheduleReconnect(link) {
    if (link.phase !== 'lost' || link.tries >= RECONNECT_TRIES) return;
    link.tries++;
    link.phase = 'reconnecting';
    render();
    hTimers.setTimeout(() => {
      if (!DIRECT.links.has(link.id) || link.conn) return;
      link.phase = 'lost';
      connectLink(link).then((l) => { if (!l && DIRECT.links.has(link.id)) { link.phase = 'lost'; scheduleReconnect(link); } });
    }, RECONNECT_GAP_MS);
  }
  // 用户断开：先全部停止（最多等 2 秒），再断开
  async function stopDirect(linkId) {
    const link = DIRECT.links.get(linkId);
    if (!link) return false;
    if (link.lab && link.conn) {
      const done = link.lab.stopAll();
      const r = await Promise.race([done, new Promise((res) => hTimers.setTimeout(() => res(null), 2000))]);
      syncLinkState(link);
      if (r && !r.ok) reportStopFailed(link, r.failed);
    }
    unregisterLink(link);
    try { if (link.conn) link.conn.disconnect(); } catch (_) {}
    link.conn = null;
    DIRECT.links.delete(link.id);
    render();
    return true;
  }
  // 全部停止的设备层（§5.9-9）：执行器层停完之后，每台设备按驱动的 stopAll.order 把所有部件都发一遍停止帧，
  // 包括没登记成执行器的部件（例如 SL278H 的自动模式、没开启的微电流）
  function directHaltAll() {
    for (const link of DIRECT.links.values()) {
      if (!link.lab || !link.conn) continue;
      link.lab.stopAll().then((r) => {
        syncLinkState(link);
        if (!r.ok) reportStopFailed(link, r.failed);
        else link.stopFailed = [];
        render();
      }).catch(() => {});
    }
  }
  function reportStopFailed(link, failed) {
    const parts = (failed || []).map((f) => f.part);
    link.stopFailed = [...new Set([...(link.stopFailed || []), ...parts])];
    const results = parts.map((p) => ({ id: link.idOf[p] || `direct:${link.driver.id}:${p}`, ok: false, refused: 'stop-failed' }));
    if (results.length) emit('bio:actuate', { t: Date.now(), target: '*', action: { stop: true }, results, source: 'stop' });
    render();
  }
  // 停止失败（执行器层的 stop 也会走到这里）：记一条设备侧反馈 + 诊断，提示只弹一次
  function noteStopFailed(results) {
    DIRECT.stopFailed = [...new Set([...DIRECT.stopFailed, ...results.map((r) => r.id)])];
    recordDeviceStop('other');
    toast('error', '停止没有成功：按设备按钮关掉，或取下设备。');
    render();
  }
  // 页面卸载：来不及等回执，同步对每台设备的每个部件发一次停止帧（能发出多少算多少）
  function directPanicStop() {
    for (const link of DIRECT.links.values()) {
      if (!link.conn) continue;
      const order = (link.driver.stopAll && link.driver.stopAll.order) || link.driver.parts.map((p) => p.id);
      for (const pid of order) { try { link.conn.write(DRV.encode(link.driver, pid, 0, { seq: link.conn.seq.next() })).catch(() => {}); } catch (_) {} }
    }
  }
  function directState() {
    return [...DIRECT.links.values()].map((l) => (syncLinkState(l), {
      id: l.id, driver: l.driver.id, model: `${l.driver.brand} ${l.driver.model}`, status: l.driver.status,
      phase: l.phase, error: l.error ? l.error.code : null, battery: l.battery,
      exclusive: DRV ? DRV.connectionOf(l.driver).exclusive : false,
      stopsOnDisconnect: DRV ? DRV.connectionOf(l.driver).stopsOnDisconnect : false,
      actuators: (l.ids || []).slice(), maybeRunning: (l.maybeRunning || []).slice(),
      stopFailed: (l.stopFailed || []).slice(),
      native: (l.native || []).map((n) => ({ id: n.id, until: n.until, stoppable: false })),
      ackTimeouts: (l.acks || []).filter((t) => Date.now() - t < ACK_WINDOW_MS).length,
    }));
  }
  // 诊断代码（第 9 节）：协议的 problems 取值是封闭枚举，新代码登记进 §4.4 之前先放在 haptics 下面
  function directProblems() {
    const out = [];
    const add = (code, severity, message, hint) => out.push({ code, severity, message, hint });
    for (const l of DIRECT.links.values()) {
      syncLinkState(l);
      const name = `${l.driver.brand} ${l.driver.model}`;
      if (l.error && l.error.code === 'EXCLUSIVE_BUSY') add('TOY_EXCLUSIVE_BUSY', 'error', `${name} 同时只接受一个连接`, `先在手机上彻底退出 ${DRV.connectionOf(l.driver).officialApp}，或关掉手机蓝牙`);
      if (l.error && l.error.code === 'HANDSHAKE_TIMEOUT') add('TOY_HANDSHAKE_TIMEOUT', 'error', `${name} 没有回应初始化帧`, '退出官方 App 后重试；仍不行可能是不同固件');
      if (l.error && l.error.code === 'OUT_OF_RANGE') add('TOY_OUT_OF_RANGE', 'warn', `${name} 不在范围内`, '确认已开机、离电脑近一些');
      if ((l.acks || []).filter((t) => Date.now() - t < ACK_WINDOW_MS).length >= ACK_PROBLEM_N) add('TOY_ACK_TIMEOUT', 'warn', `${name} 最近有多帧没收到回执`, '靠近一些；设备可能快没电了');
      if ((l.maybeRunning || []).length) add('TOY_MAYBE_RUNNING', 'warn', `${name} 断开了，可能还在动`, '按设备按钮关掉或取下；重新连接后会先全部停止');
      if ((l.stopFailed || []).length) add('TOY_STOP_FAILED', 'error', `${name} 的停止帧重试后仍失败`, '按设备按钮关掉，或取下设备');
      for (const n of l.native || []) add('TOY_NATIVE_UNSTOPPABLE', 'warn', `${name} 的自带模式正在运行，软件可能停不住`, `可拔出或按设备按钮；还剩 ${Math.max(0, Math.round((n.until - Date.now()) / 1000))} 秒`);
      if (l.conn && l.driver.status !== 'verified') add('TOY_DRIVER_UNVERIFIED', 'info', `${name} 的驱动只有社区资料，没有实测`, '先用低强度试');
    }
    if (DIRECT.links.size && doc.visibilityState === 'hidden') add('TOY_PAGE_HIDDEN', 'warn', '直连设备时酒馆页在后台', '让酒馆页保持在前台，安卓上页面切走会断开');
    return out;
  }
  function setHaptics(patch) {
    const pt = patch || {};
    const next = normalizeHaptics(Object.assign({}, state.haptics, pt, {
      intiface: Object.assign({}, state.haptics.intiface, pt.intiface || {}),
      safeWords: Object.assign({}, state.haptics.safeWords, pt.safeWords || {}),
      direct: Object.assign({}, state.haptics.direct, pt.direct || {}),
      custom: pt.custom === null ? {} : Object.assign({}, state.haptics.custom, pt.custom || {}),
    }));
    const urlChanged = next.intiface.url !== state.haptics.intiface.url;
    state.haptics = next;
    if (!next.enabled) actuators.stop();
    if (next.intiface.enabled && (urlChanged || !intiface)) { stopIntiface(); startIntiface(); }
    if (!next.intiface.enabled) stopIntiface();
    saveSettings(); render();
    emit('bio:output-state', outputState());
    return getHaptics();
  }
  // TBC v0.3 §5.11：给助手 / 卡片的只读状态
  function outputState() {
    const set = hapticsPolicy();
    const off = new Set(state.haptics.off || []);
    const out = {
      enabled: !!state.haptics.enabled, maxIntensity: state.haptics.maxIntensity,
      profile: set.profile, profileChosen: !!state.haptics.profile,
      settings: { floor: set.floor, defaultMs: set.defaultMs, minIntervalMs: set.minIntervalMs, maxPerReply: set.maxPerReply },
      fromReplies: state.haptics.fromReplies !== false,
      actuators: actuators.list().filter((a) => !off.has(a.id)).length,
    };
    // 直连设备的额外状态（§5.11）：停不下来的自带模式还剩多久、断线后哪几路可能仍在动
    const native = [];
    const maybeRunning = [];
    for (const l of DIRECT.links.values()) {
      syncLinkState(l);
      for (const n of l.native || []) if (n.id) native.push({ id: n.id, until: n.until, stoppable: false });
      for (const p of l.maybeRunning || []) maybeRunning.push(l.idOf[p] || `direct:${l.driver.id}:${p}`);
    }
    if (native.length) out.native = native;
    if (maybeRunning.length) out.maybeRunning = maybeRunning;
    return out;
  }
  function getHaptics() {
    return Object.assign(JSON.parse(JSON.stringify(state.haptics)), { settings: hapticsPolicy(), timers: hTimers.kind, intifaceStatus: state.intifaceStatus, wasmStatus: WASM.status, direct: directState(), actuators: actuators.list(), last: actuators.last(), replyLog: (state.replyLog || []).filter((x) => x.chatId === chatId()) });
  }
  // 块里的 haptics 行（§5.8）：开着时写上限与档位；关着但有设备时写 off
  function hapticsLine() {
    const n = actuators.list().filter((a) => !(state.haptics.off || []).includes(a.id)).length;
    if (!state.haptics.enabled) return n ? 'haptics(heartlink): off' : null;
    const set = hapticsPolicy();
    let line = `haptics(heartlink): on | cap ${Math.round(state.haptics.maxIntensity * 100)}% | profile ${set.profile} | actuators ${n}`;
    const t = tunedSegment(set); if (t) line += ` | ${t}`;   // 节奏细调过 → 告诉模型改了哪些参数（§13）
    return line;
  }
  // 开振动时还没选档位：请用户选（慢热 / 狂暴），之后可在玩具页切换
  async function askProfile() {
    if (state.haptics.profile) return;
    let pick = 'slow-burn';
    try {
      const c = ctx();
      if (c && typeof c.callGenericPopup === 'function') {
        const html = '<h3>选一个节奏</h3><p><b>慢热</b>：从轻开始，逐步升温。<br><b>持久</b>：中等强度，每次动得久。<br><b>狂暴</b>：高触发、高功率。<br><b>极限</b>：几乎一直开满。</p><p>之后可在玩具页随时切换。</p>';
        // 自定义按钮排在确定按钮前面（ST popup.js insertBefore okButton），所以四档都用自定义按钮、隐藏确定，顺序才是 慢热 持久 狂暴 极限
        const r = await c.callGenericPopup(html, (c.POPUP_TYPE && c.POPUP_TYPE.TEXT) || 1, '', { okButton: false, customButtons: PACE_BUTTONS });
        pick = { 11: 'steady', 12: 'frenzy', 13: 'max' }[r] || 'slow-burn';
      }
    } catch (_) {}
    setHaptics({ profile: pick });
    toast('info', `节奏：${PROFILE_ZH[pick]}，可在玩具页切换`);
  }
  const PROFILE_ZH = { 'slow-burn': '慢热', steady: '持久', frenzy: '狂暴', max: '极限' };
  const PACE_BUTTONS = [{ text: '慢热', result: 10 }, { text: '持久', result: 11 }, { text: '狂暴', result: 12 }, { text: '极限', result: 13 }];
  // 块里的 device 行：最近一次触发（§5.1）
  function actuationLine() {
    const last = actuators.lastOk();
    if (!last || Date.now() - last.t > CONFIG.ACTUATION_LINE_MS) return null;
    const hit = (last.results || []).find((r) => r.ok);
    if (!hit) return null;
    const cap = actuators.list().find((a) => a.id === hit.id);
    const name = (cap && cap.device) || hit.id;
    const ph = currentPhase();
    const pct = Math.round(((hit.clipped && hit.clipped.intensity) ?? last.action.intensity ?? 0.5) * 100);
    return `${name} ${String(last.action.output || 'Vibrate').toLowerCase()} ${hit.fallback || last.action.pattern || 'pulse'} ${pct}%${ph ? ' @' + ph.name : ''} ${Math.round((Date.now() - last.t) / 1000)}s ago (${last.source})`;
  }
  // 用户可见生成结束后：执行最新回复里的 <bio_act/>
  // replyLog：每条回复里的 <bio_act/> 与执行结果，给美化层显示（“在哪里看”）
  // key：r<消息序号>s<滑动页>[c<续写起点>]n<流水号>（§5.12 act.key 最长 64；同一条记录不变）
  // 不可枚举的字段只给界面和 feedback 行用，不进 replyActs()：base（同一条消息同一滑动页）、outcome（每个动作的结局）、adj / tagT / skipIdx（读者调整）
  function replyEntry(key, index, acts, errors, skipped, base) {
    const log = state.replyLog || (state.replyLog = []);
    const e = { key, chatId: chatId(), index, t: Date.now(), acts, errors: errors.map((x) => x.code), skipped: skipped || null, results: [], feedback: [] };
    const hidden = { base, src: `reply:${key}`, outcome: acts.map(() => (skipped ? null : 'pending')), adj: acts.map(() => 0), tagT: acts.map(() => 0), skipIdx: new Set() };
    for (const [k, v] of Object.entries(hidden)) Object.defineProperty(e, k, { value: v, enumerable: false, writable: true });
    log.push(e);
    if (log.length > 60) log.splice(0, log.length - 60);
    emit('bio:reply-acts', e);
    return e;
  }
  function chatEntries() { return (state.replyLog || []).filter((x) => x.chatId === chatId()); }
  // 'reply:<key>' / 'replay:<key>#<序号>' → 记录
  function entryBySource(src) {
    const m = /^(?:reply|replay):([^#]+)/.exec(String(src || ''));
    return m ? (state.replyLog || []).find((x) => x.key === m[1]) || null : null;
  }
  function actIndexOfSource(src, fallback) {
    const m = /#(\d+)$/.exec(String(src || ''));
    return m ? Number(m[1]) : fallback;
  }

  // ---------- 0.18：设备反馈（TBC v0.3 §5.12）：读者的操作与动作结局，下一次发送时写成 feedback 行 ----------
  // 只记录，不解释；反馈本身不会触发新的动作
  const FEEDBACK_LOG_MAX = 20;
  const REF_REASONS = { deadline: 1, disconnected: 1, other: 1 };
  function fbState() {
    const id = chatId();
    if (!state.fb || state.fb.chatId !== id) state.fb = { chatId: id, log: [], dropped: 0, since: state.lastSendT || 0, clearedFor: null, lastDevice: {} };
    if (!state.fbTurn) state.fbTurn = {};
    return state.fb;
  }
  const publicFeedback = (r) => JSON.parse(JSON.stringify(r));
  // opts.phase：直接指定相位（安全词在发送那一刻：send @0s）
  function recordFeedback(raw, opts) {
    const v = HeartlinkCore.validateFeedback(raw);
    if (v.error) return rejectInput('tbc.feedback', v.error);
    const o = opts || {};
    const ph = o.phase ? { phase: o.phase, atSec: 0 } : HeartlinkCore.phaseAt(state.events, Math.min(v.t, Date.now()));
    const rec = Object.assign({}, v);
    Object.defineProperty(rec, 'ph', { value: { phase: ph.phase, atSec: ph.atSec }, enumerable: false });
    const fb = fbState();
    fb.log.push(rec);
    if (fb.log.length > FEEDBACK_LOG_MAX) { fb.log.splice(0, fb.log.length - FEEDBACK_LOG_MAX); fb.dropped++; }
    if (v.act && v.act.key) {
      const e = (state.replyLog || []).find((x) => x.key === v.act.key);
      if (e) { e.feedback.push(publicFeedback(v)); if (e.feedback.length > FEEDBACK_LOG_MAX) e.feedback.shift(); emit('bio:reply-acts', e); }
    }
    emit('bio:feedback', publicFeedback(v));
    render();
    return true;
  }
  // 正在动的那个动作（最近开始的）：{ run, entry, i, ref }
  function activeAct() {
    const runs = actuators.running().sort((a, b) => b.startedAt - a.startedAt);
    const run = runs.find((r) => entryBySource(r.source)) || runs[0] || null;
    if (!run) return null;
    const entry = entryBySource(run.source);
    const i = actIndexOfSource(run.source, run.act);
    const ref = entry && Number.isInteger(i) ? { key: entry.key, i, afterMs: Math.max(0, Math.round(Date.now() - run.startedAt)) } : null;
    return { run, entry, i, ref };
  }
  function recordDeviceStop(reason, ev) {
    const fb = fbState(); const t = Date.now();
    if (fb.lastDevice[reason] && t - fb.lastDevice[reason] < 1500) return;   // 一次断开会停掉好几个动作，只记一条
    fb.lastDevice[reason] = t;
    const e = ev && entryBySource(ev.source);
    const i = ev ? actIndexOfSource(ev.source, ev.act) : null;
    const act = e && Number.isInteger(i) ? { key: e.key, i } : undefined;
    recordFeedback(Object.assign({ t, from: 'device', type: 'stop', reason }, act ? { act } : {}));
  }
  // 登记表报来的动作结局 → 回复记录的 outcome；设备侧的停止记成反馈
  // 开发模式：动作开始时给本机设备实验室发一条注解，时间线就不用按帧时序猜（tbc-device-lab/annotate@1）
  // 只在 DEV_TOOLS 构建里存在；失败静默（实验室没开就当没有）；不带任何身份信息
  function labAnnotate(ev) {
    if (!DEV_TOOLS || typeof host.fetch !== 'function') return;
    const act = ev && ev.actObj;
    if (!act) return;
    const body = {
      format: 'tbc-device-lab/annotate@1', client: 'heartlink', source: String(ev.source || '').slice(0, 64),
      pattern: act.pattern, intensity: act.intensity, durationMs: act.durationMs || null, output: act.output || '*',
    };
    try {
      host.fetch(new URL('api/annotate', CONFIG.LAB_URL).href, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true,
      }).catch(() => {});
    } catch (_) {}
  }

  function onActEvent(ev) {
    if (ev.type === 'start') labAnnotate(ev);
    const e = entryBySource(ev.source);
    const own = e && String(ev.source).startsWith('reply:') && Number.isInteger(ev.act) && e.outcome && ev.act < e.outcome.length;
    if (own) {
      if (ev.type === 'start') e.outcome[ev.act] = 'running';
      else if (ev.type === 'refused') e.outcome[ev.act] = 'refused';
      else if (ev.type === 'end') e.outcome[ev.act] = ev.how === 'done' ? 'done' : 'cut';
    }
    if (ev.type === 'end' && ev.how === 'cut' && REF_REASONS[ev.reason]) recordDeviceStop(ev.reason, ev);
    else if (ev.type === 'end' && ev.how === 'done' && ev.heatLimit) recordDeviceStop('heat-limit', ev);
    else if (ev.type === 'refused' && ev.reason === 'rate-limit' && own) recordDeviceStop('rate-limit', ev);
    render();
  }
  // reply -1 的动作结局（§5.12.2 acts 段）：发送时最新一条 AI 消息上、上次发送之后执行的那批
  function feedbackActs() {
    const chat = ((ctx() || {}).chat) || [];
    let li = -1;
    for (let k = chat.length - 1; k >= 0; k--) if (chat[k] && !chat[k].is_user && !chat[k].is_system) { li = k; break; }
    if (li < 0) return null;
    const since = fbState().since || 0;
    const mine = chatEntries().filter((x) => x.index === li && x.t >= since && !x.skipped && x.acts.length);
    if (!mine.length) return null;
    const base = mine[mine.length - 1].base;
    const c = { sent: 0, done: 0, cut: 0, pending: 0, refused: 0 };
    for (const x of mine.filter((y) => y.base === base)) {
      x.outcome.forEach((o) => { c.sent++; if (o === 'done' || o === 'cut' || o === 'refused') c[o]++; else c.pending++; });
    }
    return c;
  }
  function feedbackLineNow() {
    const fb = fbState();
    const chat = ((ctx() || {}).chat) || [];
    const ai = [];
    chat.forEach((m, k) => { if (m && !m.is_user && !m.is_system) ai.push(k); });
    const replyN = (key) => {
      const e = (state.replyLog || []).find((x) => x.key === key);
      if (!e || e.chatId !== chatId() || !chat[e.index] || chat[e.index].is_user) return null;
      return ai.filter((k) => k > e.index).length + 1;
    };
    const events = fb.log.map((r) => Object.assign({}, r, r.ph || {}, { reply: r.act && r.act.key ? replyN(r.act.key) : null }));
    return HeartlinkCore.feedbackLine({ acts: feedbackActs(), events, dropped: fb.dropped, source: 'heartlink' });
  }
  // 普通发送时（块已写好）：本轮反馈进聊天变量 bio.feedback，缓冲区清空（swipe / regenerate 不清空）
  function endFeedbackTurn(sendT) {
    const fb = fbState();
    if (fb.clearedFor === sendT) return false;
    fb.clearedFor = sendT;
    const id = chatId();
    const prev = state.fbTurn[id];
    const turn = fb.log.map(publicFeedback);
    state.fbTurn[id] = { turn };
    fb.log = []; fb.dropped = 0; fb.since = sendT; fb.lastDevice = {};
    return Boolean(turn.length || (prev && prev.turn && prev.turn.length));
  }
  // 宿主推理模板的前后缀（没开自动解析时，思维链留在正文里，用它包着）
  function reasoningMarkers() {
    try {
      const r = (ctx() || {}).powerUserSettings && ctx().powerUserSettings.reasoning;
      const prefix = r && String(r.prefix || '').trim(), suffix = r && String(r.suffix || '').trim();
      return prefix && suffix ? [{ prefix, suffix }] : [];
    } catch (_) { return []; }
  }
  // B-13：去重按“这条消息里已经处理到的位置”算（continue 只多出后面的标签，前面的不再执行）；
  // 思维链、代码、注释里的标签不算，上限按剩下的算（v0.3 §5.3）
  function actOnReply(messageId) {
    const c = ctx(); const chat = (c && c.chat) || [];
    const i = typeof messageId === 'number' && chat[messageId] ? messageId : chat.length - 1;
    const msg = chat[i];
    if (!msg || msg.is_user || msg.is_system) return;
    const key = `${chatId()}|${i}|${msg.swipe_id || 0}`;
    const last = state.lastActedReply && typeof state.lastActedReply === 'object' ? state.lastActedReply : null;
    const upTo = last && last.key === key ? last.upTo : -1;
    const parsed = HeartlinkHaptics.parseBioActs(msg.mes, { maxPerReply: hapticsPolicy().maxPerReply, withOffsets: true, reasoningMarkers: reasoningMarkers() });
    const acts = parsed.acts.filter((_, k) => parsed.actOffsets[k][0] >= upTo);
    const errors = parsed.errors.filter((_, k) => parsed.errorOffsets[k][0] >= upTo);
    if (errors.length) console.warn(LOG, 'bio_act errors', errors);
    if (!acts.length && !errors.length) return;
    const end = Math.max(upTo, ...parsed.actOffsets.map((x) => x[1]), ...parsed.errorOffsets.map((x) => x[1]));
    state.lastActedReply = { key, upTo: end };
    state.replySeq = (state.replySeq || 0) + 1;
    const base = `r${i}s${msg.swipe_id || 0}`;
    const entryKey = `${base}${upTo >= 0 ? `c${upTo}` : ''}n${state.replySeq}`;
    let prevUser = null;
    for (let k = i - 1; k >= 0; k--) if (chat[k].is_user) { prevUser = chat[k]; break; }
    const safe = prevUser && safeWordHit(prevUser.mes);
    const skipped = safe ? 'safeword' : !state.haptics.enabled ? 'disabled' : !state.haptics.fromReplies ? 'replies-off' : !actuators.list().length ? 'no-device' : null;
    replyEntry(entryKey, i, acts, errors, skipped, base);
    if (skipped || !acts.length) { render(); return; }
    actuators.runReplyActs(acts, `reply:${entryKey}`);
  }
  // 本轮用户生成的回复渲染后执行动作：先确认这条消息是本轮新生成的；ACT_DELAY_MS 后再确认本轮没被停止
  // （停止时宿主先发 ENDED 后发 STOPPED，顺序不定，B-13）
  function scheduleActs(messageId) {
    const round = state.round;
    if (!round || !round.acts) return;
    const roundT = round.t;
    host.setTimeout(() => {
      if (destroyed) return;
      if (state.genStoppedAt && state.genStoppedAt >= roundT) { console.log(LOG, 'generation was stopped; <bio_act/> not executed'); return; }
      const c = ctx(); const chat = (c && c.chat) || [];
      const id = typeof messageId === 'number' ? messageId : chat.length - 1;
      if (!isRoundReply(chat[id], round)) return;
      actOnReply(id);
    }, CONFIG.ACT_DELAY_MS);
  }
  // ---------- 显示时隐藏 <bio_act/>（v0.3 §5.3：不改消息原文，不依赖宿主的 HTML 清理） ----------
  // 元素形态（宿主没清理掉时）拆掉标签留内容；文本形态（宿主开了“显示标签”时）从文本节点里删掉。
  // 不碰 textarea / 可编辑区域（编辑框里删了标签，保存时会改掉原文）
  function hideActsIn(el) {
    if (!el || typeof el.querySelectorAll !== 'function') return 0;
    let n = 0;
    const editable = (node) => { for (let p = node; p && p !== el.parentNode; p = p.parentNode) { const tag = String(p.nodeName || '').toUpperCase(); if (tag === 'TEXTAREA' || tag === 'INPUT' || (p.isContentEditable)) return true; } return false; };
    for (const node of Array.from(el.querySelectorAll('bio_act'))) {
      if (editable(node)) continue;
      const parent = node.parentNode; if (!parent) continue;
      while (node.firstChild) parent.insertBefore(node.firstChild, node);
      parent.removeChild(node); n++;
    }
    const ownerDoc = el.ownerDocument || doc;
    if (typeof ownerDoc.createTreeWalker !== 'function') return n;
    const walker = ownerDoc.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
    const hits = [];
    for (let t = walker.nextNode(); t; t = walker.nextNode()) if (t.nodeValue && t.nodeValue.indexOf('<bio_act') >= 0 && !editable(t.parentNode)) hits.push(t);
    for (const t of hits) { t.nodeValue = HeartlinkHaptics.hideBioActs(t.nodeValue); n++; }
    return n;
  }
  function hideActsInChat(messageId) {
    try {
      const chatEl = doc.getElementById('chat'); if (!chatEl) return;
      const list = messageId == null ? Array.from(chatEl.querySelectorAll('.mes')) : [chatEl.querySelector(`.mes[mesid="${Number(messageId)}"]`)];
      for (const m of list) if (m && String(m.getAttribute && m.getAttribute('is_user')) !== 'true') hideActsIn(m);
    } catch (err) { console.log(LOG, 'hide bio_act skipped:', err && err.message); }
  }
  const hideQ = { ids: new Set(), all: false, timer: null };
  function scheduleHide(messageId) {
    if (messageId == null || !Number.isFinite(Number(messageId))) hideQ.all = true; else hideQ.ids.add(Number(messageId));
    if (hideQ.timer || destroyed) return;
    hideQ.timer = host.setTimeout(() => {
      hideQ.timer = null;
      const all = hideQ.all; const ids = [...hideQ.ids]; hideQ.all = false; hideQ.ids.clear();
      if (all) hideActsInChat(); else ids.forEach((id) => hideActsInChat(id));
    }, 0);
  }
  // 流式和各种重绘都走 DOM：看着 #chat，有变化就只处理变了的那几条消息
  // 翻看旧消息（协议 v0.4 §6 offscreen）：盯着最新一条 AI 回复，它整条滚出聊天区可视范围时记 offscreen，回到视野记 onscreen。
  //   只在“流式出字 / 读回复”里算（core 里裁剪）；新回复出现就改盯新的那条
  function watchLatestReplyVisibility() {
    const chatEl = doc.getElementById('chat');
    if (!chatEl || typeof host.IntersectionObserver !== 'function' || typeof host.MutationObserver !== 'function') return;
    let target = null; let off = false;
    const io = new host.IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.target !== target) continue;
        const nowOff = !e.isIntersecting;
        if (nowOff !== off) { off = nowOff; pushEvent(off ? 'offscreen' : 'onscreen'); }
      }
    }, { root: chatEl, threshold: 0 });
    const retarget = () => {
      const list = chatEl.querySelectorAll('.mes');
      let t = null;
      for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (String(m.getAttribute('is_user')) === 'true' || String(m.getAttribute('is_system')) === 'true') continue;
        t = m; break;
      }
      if (t === target) return;
      if (target) io.unobserve(target);
      if (off) { off = false; pushEvent('onscreen'); }
      target = t;
      if (t) io.observe(t);
    };
    const mo = new host.MutationObserver(retarget);
    mo.observe(chatEl, { childList: true });
    retarget();
    disposers.push(() => { mo.disconnect(); io.disconnect(); });
  }
  function watchChatForActs() {
    const chatEl = doc.getElementById('chat');
    if (!chatEl || typeof host.MutationObserver !== 'function') return;
    const mo = new host.MutationObserver((records) => {
      for (const r of records) {
        let node = r.target && r.target.nodeType === 3 ? r.target.parentNode : r.target;
        const mes = node && typeof node.closest === 'function' ? node.closest('.mes') : null;
        if (mes) { const id = mes.getAttribute('mesid'); if (id != null) scheduleHide(id); }
        else if (r.addedNodes && r.addedNodes.length) scheduleHide();
      }
    });
    mo.observe(chatEl, { childList: true, subtree: true, characterData: true });
    disposers.push(() => mo.disconnect());
  }
  const tsOf = (v) => { if (v == null) return null; const n = new Date(v).getTime(); return Number.isFinite(n) ? n : null; };
  function lastReply() {
    const chat = ((ctx() || {}).chat) || [];
    for (let i = chat.length - 1; i >= 0; i--) {
      const m = chat[i];
      if (m.is_user) return null;          // 最后一条是用户消息：还没有回复
      if (m.is_system) continue;           // 工具调用记录等
      return { i, m };
    }
    return null;
  }
  const replySig = (r) => (r ? { i: r.i, swipe: r.m.swipe_id || 0, mes: String(r.m.mes || ''), fin: tsOf(r.m.gen_finished) } : null);
  // 这条消息是不是本轮生成的回复（A-7：API 报错、后台生成结束、第一条问候都不算）
  function isRoundReply(m, round) {
    if (!m || m.is_user || m.is_system || !round) return false;
    if (!stripToVisible(m.mes).trim()) return false;
    const fin = tsOf(m.gen_finished);
    if (fin != null) return fin >= round.t - 1000;
    const snap = round.snapshot;
    return !snap || snap.mes !== String(m.mes || '') || snap.swipe !== (m.swipe_id || 0);
  }
  function roundReplyUpdated(round) {
    const r = lastReply();
    return Boolean(r && isRoundReply(r.m, round));
  }

  function installTbc() {
    const existing = host.tbc;
    if (existing && existing._owner !== 'heartlink' && typeof existing.version === 'string' && HeartlinkCore.compareVersions(existing.version, TBC_VERSION) >= 0) {
      console.log(LOG, 'window.tbc already provided by', existing._owner || 'another implementation', existing.version, '— not overriding'); return;
    }
    const tbc = {
      version: TBC_VERSION, _owner: 'heartlink',
      push: tbcPush, registerContext: tbcRegisterContext, unregisterContext: tbcUnregisterContext,
      on: (name, fn) => host.addEventListener(name, fn), off: (name, fn) => host.removeEventListener(name, fn),
      sources: tbcSources,
      setPrior, getPrior: () => state.prior || null,
      diagnostics, getExposure: () => ({ inject: state.injectEnabled !== false }), setExposure,
      registerActuator: actuators.register, unregisterActuator: actuators.unregister,
      actuate: (target, action, opts) => actuators.actuate(target, action, opts),
      // 不点名的停止也要走设备层（§5.9-9：所有输出逐个发停止，包括没登记成执行器的部件）
      stop: (id) => { const r = actuators.stop(id); if (!id) directHaltAll(); return r; }, actuators: actuators.list,
      outputState, replyActs: () => JSON.parse(JSON.stringify(chatEntries())),
      // §5.12：第三方（遥控器、玩具 App 桥）也可以报反馈；不合规返回 false
      feedback: (ev) => recordFeedback(ev),
      feedbackLog: () => fbState().log.map(publicFeedback),
    };
    host.tbc = tbc;
    disposers.push(() => { try { if (host.tbc === tbc) delete host.tbc; } catch (_) {} });
  }

  function detachDeviceListeners() {
    try { if (state.characteristic && state.notifyHandler) state.characteristic.removeEventListener('characteristicvaluechanged', state.notifyHandler); } catch (_) {}
    try { if (state.device && state.disconnectHandler) state.device.removeEventListener('gattserverdisconnected', state.disconnectHandler); } catch (_) {}
    state.notifyHandler = null; state.disconnectHandler = null;
  }
  // 同一时间只跑一个订阅：自动重连、广播唤醒、看门狗可能同时触发
  function subscribe(device) {
    if (state.subscribing && state.subscribing.device === device) return state.subscribing.promise;
    const promise = subscribeOnce(device).finally(() => { if (state.subscribing && state.subscribing.promise === promise) state.subscribing = null; });
    state.subscribing = { device, promise };
    return promise;
  }
  async function subscribeOnce(device) {
    const prev = state.device;
    if (prev && prev !== device) { try { if (prev.gatt && prev.gatt.connected) prev.gatt.disconnect(); } catch (_) {} }   // 换设备时释放旧的
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService('heart_rate');
    const characteristic = await service.getCharacteristic('heart_rate_measurement');
    await characteristic.startNotifications();
    detachDeviceListeners();
    state.notifyHandler = (event) => {
      try { onHrPacket(HeartlinkCore.parseHeartRate(event.target.value)); }
      catch (err) { console.warn(LOG, 'parse failed', err); }
    };
    characteristic.addEventListener('characteristicvaluechanged', state.notifyHandler);
    state.disconnectHandler = () => onDisconnected(device);
    device.addEventListener('gattserverdisconnected', state.disconnectHandler);
    state.device = device; state.characteristic = characteristic;
    state.deviceName = device.name || state.deviceName;
    state.connected = true; state.reconnecting = false; state.connectedAt = Date.now(); state.staleStep = 0;
    stopAdvertisementWatch(); stopSlowRetry();
    hrGates.ble.reset();
    saveSettings(); notifyConnection();
    console.log(LOG, 'subscribed to', device.name);
    readDeviceExtras(server).catch((err) => console.log(LOG, 'device extras unavailable:', err && err.message));
  }
  async function readDeviceExtras(server) {
    const textOf = async (service, uuid) => { try { const c = await service.getCharacteristic(uuid); return new TextDecoder().decode(await c.readValue()).replace(/\0+$/, ''); } catch (_) { return null; } };
    try { const info = await server.getPrimaryService('device_information'); state.deviceInfo = { model: await textOf(info, 'model_number_string'), firmware: await textOf(info, 'firmware_revision_string') }; } catch (_) { state.deviceInfo = null; }
    try {
      const batt = await server.getPrimaryService('battery_service'); const level = await batt.getCharacteristic('battery_level');
      state.battery = (await level.readValue()).getUint8(0);
      try { await level.startNotifications(); level.addEventListener('characteristicvaluechanged', (e) => { state.battery = e.target.value.getUint8(0); render(); }); } catch (_) {}
    } catch (_) { state.battery = null; }
    render();
  }
  function notifyConnection() { if (typeof state.onConnection === 'function') { try { state.onConnection(); } catch (_) {} } emit('bio:state', getState()); }
  async function onDisconnected(device) {
    state.connected = false; notifyConnection(); console.warn(LOG, 'disconnected');
    if (state.reconnecting || state.device !== device) return;
    state.reconnecting = true;
    for (const delay of CONFIG.RECONNECT_DELAYS_MS) {
      await wait(delay);
      if (state.device !== device) { state.reconnecting = false; return; }
      try { await subscribe(device); toast('success', '心率设备已重连'); return; } catch (err) { console.warn(LOG, 'reconnect failed', err); }
    }
    state.reconnecting = false;
    if (state.device !== device) return;
    // 不再 30 秒后就放弃（审查第 3 条）：页面还拿着这台设备，就每 45 秒悄悄试一次，浏览器支持时同时等它的广播；点“断开设备”才停
    await waitForAdvertisement(device);
    scheduleSlowRetry(device);
    notifyConnection();
    toast('info', '心率设备暂时连不上，设备回来会自动接上。');
  }
  function scheduleSlowRetry(device) {
    stopSlowRetry();
    if (destroyed || state.device !== device || state.connected) return;
    state.waitingForDevice = true;
    state.slowRetry = hTimers.setTimeout(async () => {
      state.slowRetry = null;
      if (destroyed || state.device !== device || state.connected) return;
      state.slowRetries = (state.slowRetries || 0) + 1;
      try {
        await subscribe(device);
        pushEvent('ble_resumed', { via: 'retry' });
        toast('success', `已自动重连 ${device.name || '心率设备'}`);
      } catch (err) {
        console.log(LOG, 'slow retry failed, will try again:', err && err.message);
        if (state.device === device && !state.connected) scheduleSlowRetry(device);
      }
    }, CONFIG.SLOW_RETRY_MS);
  }
  function stopSlowRetry() {
    if (state.slowRetry != null) { try { hTimers.clearTimeout(state.slowRetry); } catch (_) {} }
    state.slowRetry = null;
    if (!state.advWatch) state.waitingForDevice = false;
  }
  // 重试用完后：浏览器支持时等设备的广播，收到就重连（设备走远又回来的情形）
  async function waitForAdvertisement(device) {
    if (!device || typeof device.watchAdvertisements !== 'function') return false;
    stopAdvertisementWatch();
    const onAdv = async () => {
      if (state.device !== device || state.connected) { stopAdvertisementWatch(); return; }
      try { await subscribe(device); stopAdvertisementWatch(); pushEvent('ble_resumed', { via: 'advertisement' }); toast('success', `已自动重连 ${device.name || '心率设备'}`); }
      catch (err) { console.log(LOG, 'advertisement reconnect failed, still watching:', err && err.message); }
    };
    const ac = typeof host.AbortController === 'function' ? new host.AbortController() : null;
    try {
      device.addEventListener('advertisementreceived', onAdv);
      await device.watchAdvertisements(ac ? { signal: ac.signal } : undefined);
      state.advWatch = { device, onAdv, ac };
      state.waitingForDevice = true;
      return true;
    } catch (err) {
      try { device.removeEventListener('advertisementreceived', onAdv); } catch (_) {}
      console.log(LOG, 'watchAdvertisements unavailable:', err && err.message);
      return false;
    }
  }
  function stopAdvertisementWatch() {
    const w = state.advWatch;
    state.advWatch = null; if (state.slowRetry == null) state.waitingForDevice = false;
    if (!w) return;
    try { w.device.removeEventListener('advertisementreceived', w.onAdv); } catch (_) {}
    try { if (w.ac) w.ac.abort(); } catch (_) {}   // Chrome：用 signal 结束扫描
    try { if (typeof w.device.unwatchAdvertisements === 'function') w.device.unwatchAdvertisements(); } catch (_) {}
  }
  // 看门狗：显示已连接却长时间没数据（常见的“假连接”）→ 先重新订阅，仍没有就断开，交给重连流程
  async function checkStale() {
    if (!state.connected || !state.device || state.subscribing) return;
    // 没接触、被数据卫生丢掉的包也算“有数据在来”：设备没假死，不用重新订阅
    const lastData = Math.max(state.lastSample ? state.lastSample.t : 0, state.lastPacketT || 0);
    const last = Math.max(lastData, state.connectedAt || 0);
    const idle = Date.now() - last;
    if (idle < CONFIG.STALE_MS) { if (idle < 3000) { state.staleStep = 0; if (lastData && Date.now() - lastData < 3000) { state.staleFixes = 0; state.staleGaveUp = false; } } return; }
    if (!state.staleStep) {
      if ((state.staleFixes || 0) >= 3) {   // 连得上却一直不发数据：试过 3 轮就不再折腾，提示一次
        if (!state.staleGaveUp) { state.staleGaveUp = true; toast('warning', '心率设备连着但一直没有数据：请检查设备是否打开了“心率广播”，或断开后重新连接。'); }
        return;
      }
      state.staleStep = 1; state.staleFixes = (state.staleFixes || 0) + 1;
      pushEvent('ble_stale', { idleMs: idle, action: 'resubscribe' });
      console.warn(LOG, `no heart-rate data for ${Math.round(idle / 1000)}s, re-subscribing`);
      try { await state.characteristic.stopNotifications(); } catch (_) {}
      try { await state.characteristic.startNotifications(); } catch (err) { console.warn(LOG, 'resubscribe failed', err && err.message); }
      return;
    }
    if (idle >= CONFIG.STALE_MS * 2 && state.staleStep === 1) {
      state.staleStep = 2;
      pushEvent('ble_stale', { idleMs: idle, action: 'reconnect' });
      console.warn(LOG, 'still no data, dropping the connection to reconnect');
      toast('info', '心率设备没有数据，正在重新连接…');
      try { state.device.gatt.disconnect(); } catch (_) {}
    }
  }
  const CONNECT_HELP = '没有选择设备。列表里找不到时请检查：① 设备打开了“心率广播”（华为/小米/荣耀在运动健康 App 里开，WHOOP 在 App 的心率广播里开）；② 手环没被其他电脑或网页占着；③ 离电脑近一些；④ 用电脑或安卓上的 Chrome / Edge，iPhone 暂不支持。';
  const NO_BT_TEXT = '这个浏览器不支持网页蓝牙：请用电脑或安卓上的 Chrome / Edge，iPhone 暂不支持';
  // opts.name：刷新后“重新连接 上次的设备”——列表里只放这个名字（点击本身就是用户手势：requestDevice 必须在点击处理里同步走到，前面不能 await）
  async function connect(opts) {
    const bt = bluetooth();
    if (!bt) { toast('error', NO_BT_TEXT); return false; }
    const byName = opts && typeof opts.name === 'string' && opts.name ? opts.name : null;
    try {
      const device = await bt.requestDevice(byName
        ? { filters: [{ name: byName }], optionalServices: ['heart_rate', 'battery_service', 'device_information'] }
        : { filters: [{ services: ['heart_rate'] }], optionalServices: ['battery_service', 'device_information'] });
      await subscribe(device);
      toast('success', `已连接 ${device.name || '心率设备'}`);
      if (!state.privacyAck) {
        state.privacyAck = true; saveSettings();
        toast('info', '提示：心率会作为一段文字随提示词发给你配置的模型服务商，不会发到别处。');
      }
      return true;
    } catch (err) {
      if (err && err.name === 'NotFoundError') { toast('info', byName ? `没找到 ${byName}：确认它开着心率广播、离电脑近一些；或点“连别的设备”。` : CONNECT_HELP); return false; }
      console.warn(LOG, 'connect failed', err); toast('error', `连接失败：${err && err.message ? err.message : err}`);
      return false;
    }
  }
  function disconnect() {
    stopAdvertisementWatch(); stopSlowRetry(); state.waitingForDevice = false;
    state.contactOff = null;
    const device = state.device;
    state.device = null; state.characteristic = null; state.connected = false;
    detachDeviceListeners();
    try { if (device && device.gatt && device.gatt.connected) device.gatt.disconnect(); } catch (_) {}
    notifyConnection();
  }
  async function adoptExistingConnection() {
    const dev = state.device;
    if (!dev || !dev.gatt || !dev.gatt.connected) { if (state.connected) { state.connected = false; notifyConnection(); } return; }
    try { await subscribe(dev); console.log(LOG, 'adopted existing connection and re-subscribed'); }
    catch (err) { console.warn(LOG, 'adopt failed', err); state.connected = false; notifyConnection(); }
  }
  async function tryResume() {
    const bt = bluetooth();
    if (!bt || typeof bt.getDevices !== 'function' || state.connected) return;
    try {
      const devices = await bt.getDevices();
      const target = devices.find((d) => d.name === state.deviceName) || devices[0];
      if (!target) { console.log(LOG, 'resume: no remembered device'); return; }
      state.device = state.device || target;   // 让“断开设备”能停掉这次等待
      if (await waitForAdvertisement(target)) console.log(LOG, 'resume: watching advertisements from', target.name);
    } catch (err) { console.log(LOG, 'resume unavailable:', err && err.message); }
  }

  // ---------- 基线与用法 ----------
  // 手动基线在面板与胶囊里照常用（面板标出“几天前记的，建议重记”）；注入块里过期的按协议降级（composeContext）
  function baselineInfo(now) {
    const m = state.manualBaseline;
    if (m) return { bpm: m.bpm, hrv: m.hrv || null, method: 'manual', n: m.n || 0, at: m.at, device: m.device, how: m.how || 'quick', noise: m.noise,
      stale: HeartlinkCore.manualBaselineStale(m, now || Date.now(), state.deviceName) };
    return HeartlinkCore.sessionBaseline(state.samples, state.activityLog, now || Date.now());
  }
  function saveManual(r, how) {
    // v0.4 §3：手动基线要记下设定时刻与设备（原始名用来比较是否换了设备，deviceId 是块里写的设备名）
    state.manualBaseline = { bpm: r.bpm, hrv: r.hrv || null, at: Date.now(), device: state.deviceName || null, deviceId: sourceMeta().device || null, how, n: r.n || 0, noise: Number.isFinite(r.noise) ? Math.round(r.noise * 10) / 10 : null };
    saveSettings(); render(); emit('bio:state', getState());
    return state.manualBaseline;
  }
  // 旧接口：最近 60 秒平均（面板里已换成静坐 3 分钟；保留给脚本调用）
  function setManualBaseline() {
    const r = HeartlinkCore.manualBaseline(state.samples, Date.now());
    if (!r.ok) { toast('warning', `还不能记基线：${r.reason}`); return null; }
    saveManual({ bpm: r.bpm, hrv: r.hrv }, 'quick');
    toast('success', `手动基线：${r.bpm} bpm${r.hrv ? `，HRV ${r.hrv} ms` : ''}（覆盖自动基线）`);
    return state.manualBaseline;
  }
  // ---------- 静坐记平静心率（v0.3 §1.5 manual 的做法：前 60 秒不算，再记 120 秒） ----------
  // 期间打字或切走页面：提示一行并从头再来（切走的，回到页面时才重新开始）
  const REST_HINT = '别说话、别打字，前 1 分钟不算';
  function startRestBaseline() {
    if (!state.connected && !(state.bridgeUp && HeartlinkCore.isFresh(state.lastSample, Date.now()))) { toast('warning', '先连上心率设备，再静坐记平静心率'); return null; }
    cancelRestBaseline(true);
    const now = Date.now();
    state.rest = { startedAt: now, hiddenAt: doc.visibilityState === 'hidden' ? now : null, hint: null, hintUntil: 0, restarts: 0 };
    state.restTimer = host.setInterval(restTick, 1000);
    render();
    return restState();
  }
  function cancelRestBaseline(silent) {
    if (state.restTimer != null) { try { host.clearInterval(state.restTimer); } catch (_) {} }
    state.restTimer = null;
    const had = !!state.rest;
    state.rest = null;
    if (had && !silent) render();
    return had;
  }
  function restRestart(why) {
    const r = state.rest; if (!r) return;
    r.startedAt = Date.now(); r.restarts++;
    r.hint = why === 'type' ? '打字了，已重新开始' : '切走了页面，已重新开始'; r.hintUntil = r.startedAt + 6000;
    render();
  }
  function restOnEvent(e) {
    const r = state.rest; if (!r) return;
    if (e.type === 'type') restRestart('type');
    else if (e.type === 'hidden') r.hiddenAt = e.t;
    else if (e.type === 'visible' && r.hiddenAt != null) { r.hiddenAt = null; restRestart('hidden'); }
  }
  function restState(now) {
    const r = state.rest; if (!r) return null;
    const t = now || Date.now();
    const W = HeartlinkCore.REST.WARM_MS; const R = HeartlinkCore.REST.REC_MS;
    const elapsed = r.hiddenAt != null ? 0 : Math.max(0, t - r.startedAt);
    return { startedAt: r.startedAt, elapsedMs: Math.min(elapsed, W + R), leftMs: Math.max(0, W + R - elapsed), warm: Math.min(1, elapsed / W), rec: Math.max(0, Math.min(1, (elapsed - W) / R)), hint: r.hint && t < r.hintUntil ? r.hint : null, restarts: r.restarts };
  }
  function restTick() {
    const r = state.rest; if (!r) return;
    const now = Date.now();
    if (r.hiddenAt == null && now - r.startedAt >= HeartlinkCore.REST.WARM_MS + HeartlinkCore.REST.REC_MS) {
      const res = HeartlinkCore.restBaseline(state.samples, r.startedAt);
      cancelRestBaseline(true);
      if (!res.ok) { toast('warning', `这 2 分钟只收到 ${res.count} 个心率，没有记下；检查设备是否戴好再试一次`); render(); return; }
      saveManual(res, 'rest');
      toast('success', `已记下平静心率 ${res.bpm}`);
      return;
    }
    render();
  }
  function clearManualBaseline() { state.manualBaseline = null; saveSettings(); toast('info', '已改回会话自动基线'); render(); }
  // 卡片声明（TBC v0.3 §1.2）：群聊不读；只作默认值，用户在本聊天选过的模式优先
  function cardHints() {
    const c = ctx();
    if (!c || c.groupId || c.characterId == null || !c.characters) return null;
    return HeartlinkCore.readCardHints(c.characters[c.characterId]);
  }
  function modeSource() { return state.modes[chatId()] ? 'user' : ((cardHints() || {}).mode ? 'card' : 'default'); }
  function getMode() {
    const own = state.modes[chatId()];
    if (own) return HeartlinkCore.MODES.includes(own) ? own : 'author';
    const h = cardHints();
    return h && h.mode ? h.mode : 'author';
  }
  function setMode(mode) {
    mode = HeartlinkCore.normalizeMode(mode) || mode;
    if (!HeartlinkCore.MODES.includes(mode)) throw new Error('mode must be backstage | in-story | device-aware (or author | character | aware)');
    state.modes[chatId()] = mode; saveSettings(); render(); emit('bio:state', getState());
    toast('info', `模式：${MODE_ZH[mode]}。${MODE_HINT[mode]}`);
    return mode;
  }
  function toggleMode() { const m = getMode(); return setMode(m === 'author' ? 'character' : m === 'character' ? 'aware' : 'author'); }
  const MODE_ZH = { author: '幕后', character: '入戏', aware: '知情' };
  const MODE_HINT = { author: '角色不知道，只影响写法', character: '角色能察觉你的身体表现', aware: '角色知道你戴着设备，可以看数据、指导你' };

  // ---------- 跨轮历史：内存 + 聊天变量 bio + 消息 extra.bio ----------
  function history() { const id = chatId(); if (!state.history[id]) state.history[id] = []; return state.history[id]; }
  function lastSignal() { return state.signals[chatId()] || null; }
  function loadHistoryFromChat() {
    try {
      let v = {};
      if (typeof getVariables === 'function') v = getVariables({ type: 'chat' }) || {};
      else { const c = ctx(); v = (c && c.chatMetadata && c.chatMetadata.variables) || {}; }
      const b = v.bio || v.heartlink; // heartlink 键是 v0.5 的旧名
      if (b && Array.isArray(b.turns)) state.history[chatId()] = b.turns.slice(-CONFIG.HISTORY_MAX);
      if (b && b.lastSignal) state.signals[chatId()] = b.lastSignal;
    } catch (err) { console.warn(LOG, 'loadHistoryFromChat failed', err); }
  }
  // B-5 / v0.3 §1.1：对外只写旧名 mode（author / character）与新名 view，不暴露内部名 aware
  function modeFields() { const m = getMode(); return { mode: HeartlinkCore.LEGACY_MODE[m], view: HeartlinkCore.WIRE_MODE[m] }; }
  function saveChatVariable(extra) {
    // v0.4 §3-5：bio.baselineInfo，取自上一次成块（composeContext）时算好的那份，和块里的 baseline 行同一份数据
    const value = Object.assign({ v: HeartlinkCore.SPEC_VERSION, source: HeartlinkCore.SOURCE, updatedAt: Date.now() }, modeFields(), { baseline: (baselineInfo() || {}).bpm || null, turns: history(), lastSignal: lastSignal(), feedback: (state.fbTurn && state.fbTurn[chatId()]) || { turn: [] } }, state.v04 ? { baselineInfo: state.lastBaselineInfo || null } : {}, extra || {});
    try {
      if (typeof insertOrAssignVariables === 'function') { insertOrAssignVariables({ bio: value }, { type: 'chat' }); return; }
      const c = ctx(); if (!c || !c.chatMetadata) return;               // 核心回退：只改元数据，保存交给宿主紧接着的那次保存
      c.chatMetadata.variables = c.chatMetadata.variables || {};
      c.chatMetadata.variables.bio = value;
      markMetaDirty();
    } catch (err) { console.warn(LOG, 'saveChatVariable failed', err); }
  }
  // ST 的 saveMetadata() 就是 saveChatConditional()，会上传整份聊天（ST 1.18 script.js:9348、extensions.js:88-112）。
  // 两个写入时刻宿主本来就紧接着整份保存：发送时 GENERATION_AFTER_COMMANDS（script.js:4262）之后 sendMessageAsUser 保存（script.js:5856），
  // 回复时 CHARACTER_MESSAGE_RENDERED（script.js:3741）之后流式在 onFinishStreaming 保存（script.js:3756）、非流式在 Generate 末尾保存（script.js:5514）。所以这里不再每次都排一次保存；
  // 宿主保存成功后会发 ITEMIZED_PROMPTS_SAVED（script.js:9373 → itemized-prompts.js:53），看到它就算已落盘。
  // 兜底：生成结束后 META_FALLBACK_MS 仍没看到，才调一次 saveMetadataDebounced（例如 1.5 秒后才抓到 Reader Signal、或宿主没保存）。
  const metaSave = { pending: null, timer: null };
  function markMetaDirty() {
    metaSave.pending = { chatId: chatId(), at: Date.now() };
    scheduleMetaFallback();
  }
  function scheduleMetaFallback() {
    if (metaSave.timer) host.clearTimeout(metaSave.timer);
    metaSave.timer = host.setTimeout(flushMetaFallback, CONFIG.META_FALLBACK_MS);
  }
  function saveMetaNow() {
    const p = metaSave.pending; metaSave.pending = null;
    if (metaSave.timer) { host.clearTimeout(metaSave.timer); metaSave.timer = null; }
    if (!p || p.chatId !== chatId()) return;   // 已换了聊天：宿主的 chatMetadata 已是别的聊天，不能替它保存
    const c = ctx(); if (!c) return;
    try {
      if (typeof c.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
      else if (typeof c.saveMetadata === 'function') c.saveMetadata();
    } catch (err) { console.warn(LOG, 'metadata save failed', err); }
  }
  function flushMetaFallback() {
    metaSave.timer = null;
    if (!metaSave.pending || destroyed) return;
    if (state.generating || state.userGenActive) { scheduleMetaFallback(); return; }   // 回复结束时宿主会保存，等它
    saveMetaNow();
  }
  function onHostChatSaved(arg) {
    const p = metaSave.pending; if (!p) return;
    if (arg && arg.chatId && arg.chatId !== p.chatId) return;
    metaSave.pending = null;
    if (metaSave.timer) { host.clearTimeout(metaSave.timer); metaSave.timer = null; }
  }
  // 把刚结束的读回复摘要写到那条 AI 消息上：导出 JSONL 时每条消息自带数据
  function attachSummaryToMessage(summary) {
    try {
      const c = ctx(); if (!c || !c.chat) return;
      for (let i = c.chat.length - 1; i >= 0; i--) {
        const m = c.chat[i];
        if (m.is_user) continue;
        // 0.7.2：不再主动调 saveChat（完整性检查 + 保存锁风险，见 spec 仓库 docs/st-compat-audit-2026-09-zh.md §4）；
        // 此刻用户消息已由酒馆落盘，这里写的数据会随本轮回复结束时酒馆自己的保存一起落盘
        HeartlinkCore.attachBio(m, Object.assign({}, summary, { v: HeartlinkCore.SPEC_VERSION, source: HeartlinkCore.SOURCE }, modeFields()));
        return;
      }
    } catch (err) { console.warn(LOG, 'attachSummaryToMessage failed', err); }
  }
  // 回复到达后从思维链里抽出 Reader Signal 那一行，存到消息 extra.bio.signal 与聊天变量
  // 0.7.2：在 CHARACTER_MESSAGE_RENDERED 里同步调用——酒馆在这个事件之后才 saveChatConditional，
  // 所以这里写进 extra.bio.signal 的内容会随酒馆自己的保存落盘，不需要（也不该）自己调 saveChat
  function captureReaderSignal(messageId) {
    try {
      const c = ctx(); if (!c || !c.chat || !c.chat.length) return false;
      const idx = typeof messageId === 'number' && c.chat[messageId] ? messageId : c.chat.length - 1;
      const m = c.chat[idx];
      if (!m || m.is_user) return false;
      const reasoning = (m.extra && m.extra.reasoning) || ((m.mes || '').match(/<([a-z_]*think(?:ing)?)\b[^>]*>([\s\S]*?)<\/\1\s*>/i) || [])[2] || '';
      const hit = reasoning.match(CONFIG.SIGNAL_RE);
      if (!hit) return false;
      const signal = hit[0].replace(/^(?:- )?(?:0_)?Reader Signal:\s*/, '').trim().slice(0, 400);
      state.signals[chatId()] = { t: Date.now(), text: signal };
      HeartlinkCore.attachBio(m, { signal });
      saveChatVariable();
      render();
      console.log(LOG, 'reader signal:', signal);
      return true;
    } catch (err) { console.warn(LOG, 'captureReaderSignal failed', err); return false; }
  }
  // ---------- read-pos：回复正文可见字符数、CJK 占比、段落偏移 ----------
  // 去掉思维链块、<style> 块与所有 HTML 标签后剩下的可见文本，供 read-pos 用
  function stripToVisible(mes) {
    let text = String(mes || '');
    text = text.replace(CONFIG.THINKING_BLOCK_RE, '');
    if (CONFIG.THINKING_PREFIX_RE.test(text) && !/^\s*<[a-z_]*think/i.test(text)) text = text.replace(CONFIG.THINKING_PREFIX_RE, '');
    text = text.replace(CONFIG.THINKING_TAIL_RE, '');
    text = text.replace(CONFIG.STYLE_BLOCK_RE, '');
    text = text.replace(CONFIG.HTML_TAG_RE, '');
    return text;
  }
  function cjkRatioOf(text) {
    if (!text.length) return 0;
    const hits = text.match(CONFIG.CJK_RE);
    return hits ? hits.length / text.length : 0;
  }
  // 按空行切分段落，记录每段第一行在去标签文本里的起始字符偏移（升序）
  function paragraphOffsetsOf(text) {
    const offsets = [];
    const lines = text.split('\n');
    let offset = 0, inPara = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const blank = line.trim() === '';
      if (!blank && !inPara) { offsets.push(offset); inPara = true; }
      else if (blank) inPara = false;
      offset += line.length + (i < lines.length - 1 ? 1 : 0);
    }
    return offsets;
  }
  // reply_end 时取最后一条 AI 消息，算 read-pos 需要的三样，存 state.replyMeta（含 messageIndex）
  function computeReplyMeta() {
    try {
      const c = ctx(); if (!c || !c.chat || !c.chat.length) return;
      for (let i = c.chat.length - 1; i >= 0; i--) {
        const m = c.chat[i];
        if (m.is_user) continue;
        const text = stripToVisible(m.mes);
        state.replyMeta = { chars: text.length, paragraphOffsets: paragraphOffsetsOf(text), cjkRatio: cjkRatioOf(text), messageIndex: i };
        return;
      }
    } catch (err) { console.warn(LOG, 'computeReplyMeta failed', err); }
  }
  function exportCsv() {
    const cols = ['t', 'readSec', 'readPeak', 'readMean', 'readFirst', 'readLast', 'peakAtSec', 'hrv', 'writeSec', 'sendBpm', 'baseline', 'genSec'];
    const esc = (v) => (v == null ? '' : String(v).includes(',') ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    return [cols.join(','), ...history().map((h) => cols.map((k) => esc(h[k])).join(','))].join('\n');
  }

  // ---------- 注入 ----------
  // baseline：调用方已算好的基线（render 里同一时刻已算过一次）；不传就由 composeContext 自己算
  // trigger：这次生成的类型；缺省 normal（预览显示的是“下一次普通发送”会带的块）
  function compose(now, baseline, trigger) {
    const replyMeta = state.replyMeta || null;
    const cjk = Boolean(replyMeta && typeof replyMeta.cjkRatio === 'number' && replyMeta.cjkRatio >= CONFIG.CJK_RATIO_THRESHOLD);
    const defaultCps = cjk ? HeartlinkCore.CONFIG.READ_CPS_CJK : HeartlinkCore.CONFIG.READ_CPS_LATIN;
    const cpsOverride = HeartlinkCore.estimateCps({ history: history(), defaultCps });
    const meta = Object.assign(sourceMeta(), { trigger: trigger || 'normal' });
    // v0.4 §5：开关打开时把驱动台账一起给核心（相位的 act 段、clean 行、基线排除驱动秒）
    const t0 = Math.min(now || Date.now(), Date.now()) - HeartlinkCore.CONFIG.SERIES_MAX_MS;
    const actLog = state.v04 ? safeActuations(t0) : null;
    return HeartlinkCore.composeContext({ samples: state.samples, events: state.events, activityLog: state.activityLog, now: now || Date.now(), mode: getMode(), baselineOverride: state.manualBaseline, history: history(), replyMeta, cpsOverride, kinds: kinds(), deviceLines: deviceLines(), extraLines: [hapticsLine(), safeFeedbackLine()].filter(Boolean), meta, prior: state.prior || null, baseline, actLog, v04: !!state.v04,
      offContact: state.offContact, deviceNow: state.deviceName || null, lagMs: HeartlinkCore.LAG_MS_BY_CLASS[effectiveWear()], gates: gatesArg(), wearClass: effectiveWear(),
      streamMarks: state.v04 ? (state.streamMarks || null) : null });
  }
  function safeActuations(sinceT) {
    try { return typeof actuators.actuations === 'function' ? actuators.actuations(sinceT) : null; } catch (err) { console.warn(LOG, 'actuations failed', err); return null; }
  }
  function safeFeedbackLine() { try { return feedbackLineNow(); } catch (err) { console.warn(LOG, 'feedback line failed', err); return null; } }
  // 酒馆助手的 injectPrompts 优先；不可用时退回酒馆核心的 setExtensionPrompt（同一条 in_chat 注入）
  function doInject(text) {
    if (typeof injectPrompts === 'function') {
      if (typeof uninjectPrompts === 'function') { try { uninjectPrompts([CONFIG.INJECT_ID]); } catch (_) {} }
      injectPrompts([Object.assign({ id: CONFIG.INJECT_ID, content: text }, CONFIG.INJECT)], { once: true });
      return 'tavern-helper';
    }
    const c = ctx();
    if (c && typeof c.setExtensionPrompt === 'function') {
      const pos = (c.extensionPromptTypes && c.extensionPromptTypes.IN_CHAT) ?? 1;
      const role = (c.extensionPromptRoles && c.extensionPromptRoles.SYSTEM) ?? 0;
      // 0.7.2：第 7 个参数 filter（ST 1.13.2+）——让酒馆自己在后台生成时跳过这条注入；老版本会忽略多出来的参数
      c.setExtensionPrompt(CONFIG.INJECT_ID, text, pos, CONFIG.INJECT.depth, CONFIG.INJECT.should_scan, role, () => !!state.userGenActive);
      return 'st-core';
    }
    return null;
  }
  function clearInject() {
    try { if (typeof uninjectPrompts === 'function') uninjectPrompts([CONFIG.INJECT_ID]); } catch (_) {}
    try { const c = ctx(); if (c && typeof c.setExtensionPrompt === 'function') c.setExtensionPrompt(CONFIG.INJECT_ID, '', (c.extensionPromptTypes && c.extensionPromptTypes.IN_CHAT) ?? 1, 0, false, (c.extensionPromptRoles && c.extensionPromptRoles.SYSTEM) ?? 0); } catch (_) {}
  }
  // 一次用户发送只 compose 一次（A-12）：两个注入入口、群聊后面的成员、工具调用递归拿到的都是同一份（v0.3 §1.3-2）
  function composeTurnBlock(now, trigger) {
    const composed = compose(now, undefined, trigger);
    let text = composed.text;
    if (composed.invalid) state.invalidBlocks = (state.invalidBlocks || 0) + 1;
    else {
      // ② 按设备节奏自动：30 秒一个样本的来源不该被判成"没数据"（设置方案 §3.6）
      const staleMs = HeartlinkCore.staleThresholdMs(sourceMeta().cadenceMs);
      if (!HeartlinkCore.isFresh(state.lastSample, now, staleMs) && state.samples.length && !contactOffNow(now)) {
        text = text.replace('\n</bio_context>', `\nwarn: device silent over ${Math.round(staleMs / 1000)}s at send; recent phases may be incomplete\n</bio_context>`);
      }
    }
    return { sendT: now, trigger, text, summary: composed.summary };
  }
  function recordSummary(block) {
    const summary = block.summary;
    const h = history();
    const dup = summary && h.length && h[h.length - 1].readStart === summary.readStart; // 同一段“读回复”只记一次（重复发送 / 重roll）
    if (summary && state.lastSummarizedSend !== block.sendT && !dup) {
      state.lastSummarizedSend = block.sendT;
      h.push(summary); if (h.length > CONFIG.HISTORY_MAX) h.splice(0, h.length - CONFIG.HISTORY_MAX);
      if (summary.rhythm) pushRhythm(summary.rhythm);   // 干净轮进门槛自动学
      if (summary.baselineInfo !== undefined) state.lastBaselineInfo = summary.baselineInfo;   // v0.4 §3-5
      saveChatVariable({ last: summary });
      attachSummaryToMessage(summary);
      return true;
    }
    return false;
  }
  // 不注入时也按普通发送结束本轮反馈（§5.12：只有 normal 发送才清空）
  function closeFeedbackWithoutBlock(kind, sendT) {
    if (kind !== 'normal' || !sendT) return;
    if (endFeedbackTurn(sendT)) saveChatVariable();
  }
  function injectContext(sendT) {
    const kind = state.genKind || 'normal';
    // 注入关着（测试 / ON-SHAM）：不发块，也不清反馈——没写进过任何块的反馈要留到第一次有块时送达（policy §6-A-5，L-01）
    if (state.injectEnabled === false) { clearInject(); return; }
    // 没有生理数据时，只有触觉状态与设备反馈值得告诉模型（TBC v0.3 §5.8、§5.12）：开着触觉或连着设备就照常注入，其余行为 n/a
    if (!state.samples.length && !hapticsLine() && !safeFeedbackLine()) { console.log(LOG, 'no heart-rate data; nothing injected'); closeFeedbackWithoutBlock(kind, sendT); return; }
    let text; let fresh = false;
    if (kind === 'continue' || kind === 'group' || kind === 'tool') {
      const b = state.turnBlock;
      if (!b || b.chatId !== chatId()) { console.log(LOG, `${kind}: no block of this chat to replay; nothing injected`); return; }
      text = kind === 'tool' ? b.text : HeartlinkCore.replayBlock(b.text, { replay: kind, composedAt: b.sendT });
    } else if (kind === 'impersonate') {
      // 冒名：新块、读者还没写消息，不记摘要（v0.3 §1.3）
      const now = state.genStartT || Date.now();
      if (!state.impersonateBlock || state.impersonateBlock.sendT !== now) state.impersonateBlock = composeTurnBlock(now, 'impersonate');
      text = state.impersonateBlock.text;
    } else {
      const now = sendT || Date.now();
      if (!state.turnBlock || state.turnBlock.sendT !== now || state.turnBlock.chatId !== chatId()) {
        const block = composeTurnBlock(now, kind);
        block.chatId = chatId();
        state.turnBlock = block;
      }
      text = state.turnBlock.text;
    }
    let via = null;
    try { via = doInject(text); } catch (err) { console.warn(LOG, 'inject failed', err); }
    if (!via) { console.warn(LOG, 'no injection API available; block not delivered'); return; }
    state.injectedFor = sendT || Date.now(); state.lastInjectAt = Date.now(); state.injectSeq = (state.injectSeq || 0) + 1;
    state.lastInjectText = text;
    // 新一轮的块第一次真的发出去了，才算送达：反馈缓冲清空、摘要进 history（L-07：注入失败时这些都不能按“已送达”处理）
    const b = state.turnBlock;
    if (NEW_TURN_KINDS.has(kind) && b && !b.delivered) {
      b.delivered = true;
      const fbChanged = kind === 'normal' ? endFeedbackTurn(b.sendT) : false;   // 块里已写上本轮反馈，缓冲区清空
      const saved = recordSummary(b);   // 摘要在 compose 之后才进 history，本轮块里的 history 不含本轮（A-12）
      if (fbChanged && !saved) saveChatVariable();
      fresh = true;
    }
    if (fresh) {
      bridgeState();
      emit('bio:inject', Object.assign({ text }, modeFields(), { summary: state.turnBlock.summary }));   // 一次发送只广播一次
      console.log(LOG, `injected bio_context via ${via}:\n` + text);
    }
  }

  // ---------- 注入窗口（0.18）----------
  // ST 1.18 的 setExtensionPrompt 过滤器实际不起作用（getExtensionPrompt 把 async 函数交给 Array.filter，
  // Promise 永远为真，script.js:3243-3257），后台请求能不能躲开块，只能靠我们自己及时撤掉。
  // 所以本轮用户可见生成的提示词一拼好（聊天补全 CHAT_COMPLETION_PROMPT_READY、文本补全 GENERATE_AFTER_DATA）就撤掉注入；
  // 只认自己的这一轮、且不是试算（dryRun）。continue / 群聊后面的成员 / 工具递归每次生成前都会从缓存的块重新注入（injectContext）。
  // 后台生成的 BEFORE_COMBINE / PROMPT_READY 没有类型，只能按先来先认领：它 STARTED 时登记一次，之后第一个同名事件算它的
  function claimBackground(counter) {
    if (state[counter] > 0) { state[counter]--; return true; }
    return false;
  }
  // 用户轮的注入窗口开着：本轮已开始、提示词还没拼好、且没超时（超时 = 宿主没发 ENDED 就放弃了这轮，例如 ping 失败）
  function userWindowOpen() {
    const r = state.round;
    return Boolean(state.userGenActive && r && r.windowClosed !== state.injectSeq && Date.now() - r.t < CONFIG.ROUND_WINDOW_MS);
  }
  function closeInjectionWindow(dryRun, via) {
    if (dryRun) return false;
    if (claimBackground('bgAwaitPrompt')) return false;   // 后台生成的提示词拼好了，不是本轮的
    const r = state.round;
    if (!state.generating || !state.userGenActive || !r) return false;
    if (!state.injectSeq || r.windowClosed === state.injectSeq) return false;
    r.windowClosed = state.injectSeq;
    clearInject();
    state.injectWindow = { closedAt: Date.now(), via };
    return true;
  }

  // 一轮生成开始（v0.3 附录 A）：普通发送 / swipe / regenerate 开新一轮；continue、群聊后面的成员、工具调用递归不开；
  // impersonate 开，但读者还没写；自动模式（automatic_trigger）不注入、不执行动作
  const NEW_TURN_KINDS = new Set(['normal', 'swipe', 'regenerate']);
  const REPLY_KINDS = new Set(['normal', 'swipe', 'regenerate', 'group', 'tool', 'auto']);
  const ACT_KINDS = new Set(['normal', 'swipe', 'regenerate', 'group', 'tool', 'continue']);
  function beginRound(p) {
    const now = Date.now();
    state.bgGens = state.bgGens.filter((t) => now - t < 5 * 60000);
    let kind = p.kind === '' ? 'normal' : p.kind;
    if (kind === 'normal') {
      let g = state.groupTurn;
      // 群聊状态残留（宿主没发 FINISHED）：上一成员结束很久了还没等到下一成员，这次发送就是普通新一轮（L-09）
      if (g && g.started && !state.generating && state.round && state.round.endedAt && now - state.round.endedAt > CONFIG.GROUP_STALE_MS) { g = state.groupTurn = null; console.log(LOG, 'stale group turn dropped'); }
      if (state.toolCallsAt && now - state.toolCallsAt < CONFIG.TOOL_RECURSION_MS) kind = 'tool';
      else if (g && g.started) kind = g.auto ? 'auto' : 'group';
      else if (p.auto) kind = 'auto';
      if (g && !g.started) { g.started = true; g.auto = p.auto; }
    }
    state.toolCallsAt = 0;
    try {
      const ch = (ctx() || {}).chat || []; const lu = [...ch].reverse().find((m) => m.is_user);
      if (lu && safeWordHit(lu.mes) && (actuators.list().some((a) => a.busy) || actuators.pending())) {
        const cur = activeAct();
        actuators.stop(undefined, 'safeword');   // 先停再记录（§5.12）
        if (NEW_TURN_KINDS.has(kind)) recordFeedback(Object.assign({ t: p.t, from: 'safeword', type: 'stop' }, cur && cur.ref ? { act: cur.ref } : {}), { phase: 'send' });
        toast('info', '听到了停止的话，设备已停');
      }
    } catch (_) {}
    state.generating = true; state.streamStarted = false; state.reasoningEnded = false; state.ownEndedPending = false; state.streamMarks = [];
    state.genKind = kind; state.genStartT = p.t;
    state.userGenActive = kind !== 'auto';
    state.continueGen = kind === 'continue' || kind === 'impersonate';
    state.impersonating = kind === 'impersonate';
    if (kind === 'tool') {   // 递归前那条空回复记下的 reply_end 作废
      for (let i = state.events.length - 1; i >= 0 && state.events[i].t > (state.lastSendT || 0); i--) if (state.events[i].type === 'reply_end') state.events.splice(i, 1);
    }
    if (NEW_TURN_KINDS.has(kind)) {
      state.lastSendT = p.t; state.lastTrigger = kind;
      pushEvent('send', { kind }, p.t);
    } else if (kind === 'continue' || kind === 'impersonate') state.lastTrigger = kind;
    // minId：本轮回复可能出现的最早消息下标。swipe 复用最后一条消息；regenerate 时旧消息在 GENERATION_AFTER_COMMANDS 之前已被移除，也用 ch.length（F-096）
    const ch0 = (ctx() || {}).chat || [];
    state.round = { t: p.t, kind, acts: ACT_KINDS.has(kind), snapshot: replySig(lastReply()), minId: kind === 'swipe' ? ch0.length - 1 : ch0.length };
  }
  function bindTavernEvents() {
    const c = ctx();
    const events = window.tavern_events || host.tavern_events || (c && c.eventTypes) || {};
    // 酒馆助手的 eventOn 优先；不可用时退回酒馆核心的 eventSource
    const coreOn = c && c.eventSource ? (name, fn) => { c.eventSource.on(name, fn); return { stop: () => c.eventSource.removeListener(name, fn) }; } : null;
    const on = typeof eventOn === 'function' ? eventOn : coreOn;
    const onFirst = typeof eventMakeFirst === 'function' ? eventMakeFirst : (c && c.eventSource && c.eventSource.makeFirst ? (name, fn) => { c.eventSource.makeFirst(name, fn); return { stop: () => c.eventSource.removeListener(name, fn) }; } : on);
    if (!on) { console.warn(LOG, 'no event API; injection disabled'); return; }
    const bind = (name, fn, first) => { if (!name) return; try { const d = (first ? onFirst : on)(name, fn); if (d && typeof d.stop === 'function') disposers.push(() => d.stop()); } catch (err) { console.warn(LOG, 'bind failed', name, err); } };
    const userKinds = new Set(CONFIG.USER_GEN_KINDS);

    // A-7：GENERATION_STARTED 只记“待开始”；同一轮随后的 GENERATION_AFTER_COMMANDS 才算真的开始
    //（斜杠命令只有 STARTED；酒馆助手 generate/generateRaw 只有 AFTER_COMMANDS，两者都不算发送）
    bind(events.GENERATION_STARTED, (type, option, dryRun) => {
      if (dryRun) return;
      const kind = String(type == null ? '' : type);
      if (!userKinds.has(kind)) {
        // 后台生成：撤掉块（它的提示词不该带）；用户轮若还没拼好提示词，会在自己的 BEFORE_COMBINE 重新注入（L-03）
        state.backgroundGen = true; clearInject(); state.backgroundSkipped = (state.backgroundSkipped || 0) + 1;
        state.bgGens.push(Date.now()); state.bgAwaitCombine++; state.bgAwaitPrompt++;
        pushEvent('background_gen', { kind }); return;
      }
      state.backgroundGen = false;
      state.pendingGen = { kind: kind || 'normal', type: kind, t: Date.now(), auto: !!(option && option.automatic_trigger) };
    });
    const onAfterCommands = (type, option, dryRun) => {
      if (dryRun) return;
      const p = state.pendingGen;
      // 没有配对的 STARTED（酒馆助手 generate() 之类）：不算发送；用户轮的窗口也没开着就顺手撤掉残留的块（C-02）
      if (!p) { if (!userWindowOpen()) clearInject(); return; }
      if (String(type == null ? '' : type) !== p.type) return;   // 别的生成的 AFTER_COMMANDS 先到：不吃掉用户那次 STARTED（L-03）
      state.pendingGen = null;
      if (Date.now() - p.t > CONFIG.PENDING_GEN_MS) return;
      beginRound(p);
      if (state.userGenActive) injectContext(state.lastSendT);   // 这是用户轮自己的事件，后台生成在不在跑都要注入（L-03）
    };
    bind(events.GENERATION_AFTER_COMMANDS, onAfterCommands, true);
    // 0.9.4：只在拼提示词之前注入；CHAT_COMPLETION_PROMPT_READY 时提示词已拼好，此时再注入只会残留到下一次（后台）请求里
    bind(events.GENERATE_BEFORE_COMBINE_PROMPTS, () => {
      if (claimBackground('bgAwaitCombine')) return;   // 后台生成的，不注入
      if (!events.GENERATION_AFTER_COMMANDS && state.pendingGen) onAfterCommands(state.pendingGen.type, null, false);   // 宿主没有 AFTER_COMMANDS 时在这里开始
      if (userWindowOpen()) injectContext(state.lastSendT);   // 后台生成插在中间撤过块的话，这里补回来
    }, true);
    bind(events.CHAT_COMPLETION_PROMPT_READY, (data) => closeInjectionWindow(!!(data && data.dryRun), 'chat-completion'));
    bind(events.GENERATE_AFTER_DATA, (_data, dryRun) => closeInjectionWindow(!!dryRun, 'text-completion'));
    bind(events.GROUP_WRAPPER_STARTED, () => { state.groupTurn = { started: false, auto: false }; });
    bind(events.GROUP_WRAPPER_FINISHED, () => { state.groupTurn = null; });
    bind(events.TOOL_CALLS_PERFORMED, () => { state.toolCallsAt = Date.now(); });
    bind(events.IMPERSONATE_READY, () => { state.impersonating = false; });
    bind(events.STREAM_TOKEN_RECEIVED, (text) => {
      if (!state.generating) return;
      if (!state.streamStarted) { state.streamStarted = true; pushEvent('stream_start'); }
      if (!state.reasoningEnded && typeof text === 'string' && CONFIG.REASONING_END_RE.test(text)) { state.reasoningEnded = true; pushEvent('reasoning_end', { via: 'thinking-tag' }); }
      // v0.4 §1.2：stream 行的 pos 需要“时刻 → 已显示字数”（累计正文字数，思维链不计）；只在开关打开时记，
      //   避免每个 token 都做正则去标签；STREAM_TOKEN_RECEIVED 传的是累计全文，不是增量（酒馆核心行为）
      if (state.v04 && typeof text === 'string') {
        const chars = stripToVisible(text).length;
        const marks = state.streamMarks || (state.streamMarks = []);
        if (marks.length < CONFIG.STREAM_MARKS_MAX) marks.push({ t: Date.now(), chars });
        else marks[marks.length - 1] = { t: Date.now(), chars };
      }
    });
    bind(events.STREAM_REASONING_DONE, () => { if (state.generating && !state.reasoningEnded) { state.reasoningEnded = true; pushEvent('reasoning_end', { via: 'api' }); } });
    // 结束一轮：只有本轮回复真的更新了才记 reply_end（API 报错、并发的后台生成结束都不算，A-7）
    // 一个后台生成结束了：登记表出队；它没来得及发的 BEFORE_COMBINE / PROMPT_READY 也不再等（自愈）
    const backgroundEnded = () => {
      state.bgGens.shift();
      state.bgAwaitCombine = Math.min(state.bgAwaitCombine, state.bgGens.length);
      state.bgAwaitPrompt = Math.min(state.bgAwaitPrompt, state.bgGens.length);
      state.backgroundGen = state.bgGens.length > 0;
    };
    const endRound = (via, messageId) => {
      // 迟到 / 旁路事件（变量框架写回旧消息、后台生成插入的消息）不能结束本轮（F-096）
      if (state.generating && state.round) {
        if (via === 'received' || via === 'rendered') {
          const id = Number(messageId);
          if (Number.isInteger(id)) {
            const ch = (ctx() || {}).chat || [];
            const m = ch[id];
            const tooOld = typeof state.round.minId === 'number' && id < state.round.minId;
            if (tooOld || (m && !isRoundReply(m, state.round))) {
              console.log(LOG, `${via} for message ${id} is not this round's reply; round continues`);
              return;
            }
          }
        }
        // 流式出字中途来的 ENDED 不是本轮的（本轮真正的结束以 MESSAGE_RECEIVED 为准，宿主先发 RECEIVED 再发 ENDED）
        if (via === 'ended' && state.streamStarted && REPLY_KINDS.has(state.genKind)) {
          const r = lastReply();
          const fin = r && tsOf(r.m.gen_finished);
          if (!(fin != null && fin >= state.round.t - 1000)) {
            console.log(LOG, 'GENERATION_ENDED while the reply is still streaming; round continues');
            return;
          }
        }
      }
      if (state.generating) {
        const round = state.round;
        const updated = roundReplyUpdated(round);
        if (!updated && via === 'ended' && state.bgGens.length) {
          backgroundEnded();   // 非流式时并发的后台生成先结束，发的 ENDED 不是本轮的
          console.log(LOG, 'GENERATION_ENDED from a background generation; round continues');
          return;
        }
        state.generating = false;
        const kind = state.genKind;
        if (round) { round.endedAt = Date.now(); if (updated) round.replyId = lastReply().i; }
        if (updated && REPLY_KINDS.has(kind)) { pushEvent('reply_end', { via }); computeReplyMeta(); bridgeState(); }
        state.continueGen = false;
        state.ownEndedPending = via === 'received' || via === 'rendered';   // 宿主随后还会发本轮自己的 ENDED（script.js:3477），别把它记到后台生成头上（C-01）
        state.toolCallsAt = 0;   // 轮真的结束了：工具递归只发生在同一轮里（C-05）
        const got = (via === 'rendered' || via === 'received') ? captureReaderSignal(typeof messageId === 'number' ? messageId : undefined) : false;
        if (!got) host.setTimeout(() => captureReaderSignal(), 1500);   // 兜底：非流式/思维链晚到时再试一次（这次只能等下一次宿主保存）
      } else if (via === 'ended' && state.ownEndedPending) state.ownEndedPending = false;
      else if (via === 'ended' && state.bgGens.length) backgroundEnded();
      if (state.userGenActive) clearInject();   // 0.9.4：用户可见生成结束就撤掉，后台请求不会带上
      state.impersonating = false;
      state.backgroundGen = state.bgGens.length > 0; state.userGenActive = false;
    };
    // 回复结束以“消息收到”为准：宿主先发 MESSAGE_RECEIVED 再发 CHARACTER_MESSAGE_RENDERED（script.js:3740-3741、6632-6634），
    // 渲染前可能还夹着别的扩展的 await（前端卡、变量框架），用收到的时刻记 reply_end 更接近读者真正开始读的时刻
    bind(events.MESSAGE_RECEIVED, (messageId, type) => {
      if (type === 'first_message' || type === 'command' || type === 'impersonate') return;
      endRound('received', messageId);
    });
    bind(events.CHARACTER_MESSAGE_RENDERED, (messageId, type) => {
      if (type === 'first_message' || type === 'command') return;   // 问候语、斜杠命令插入的消息不是本轮回复
      endRound('rendered', messageId);
      scheduleHide(messageId);
      // 动作按消息执行（B-13）：流式时 ENDED 先到，这里仍会执行；非流式时这里是唯一入口。
      // 只认本轮生成的那条回复、且在本轮结束后不久渲染的（副路 / 后台生成插进来的消息不执行）
      const r = state.round;
      const id = messageId == null ? null : Number(messageId);
      if (r && r.acts && !r.actsScheduled && r.replyId != null && (id == null || id === r.replyId) && Date.now() - (r.endedAt || 0) < 10000) {
        r.actsScheduled = true;
        scheduleActs(r.replyId);
      }
    });
    bind(events.GENERATION_ENDED, () => endRound('ended'));
    bind(events.GENERATION_STOPPED, () => { state.genStoppedAt = Date.now(); endRound('stopped'); });
    bind(events.MESSAGE_SWIPED, (id) => { pushEvent('swipe'); scheduleHide(id); });
    bind(events.MESSAGE_UPDATED, (id) => scheduleHide(id));
    bind(events.MORE_MESSAGES_LOADED, () => scheduleHide());
    bind(events.ITEMIZED_PROMPTS_SAVED, onHostChatSaved);   // 宿主整份保存完成（带上了刚写的聊天变量）
    bind(events.WORLDINFO_UPDATED, scheduleGuideCheck);        // 条目改动（world-info.js:4080）
    bind(events.WORLDINFO_SETTINGS_UPDATED, scheduleGuideCheck);   // 全局世界书选择改动（world-info.js:5723、6109）
    bind(events.CHAT_CHANGED, () => {
      const id = chatId();
      if (state.chatIdSeen !== id) {
        clearInject();   // 生成中换聊天：旧聊天的块不能留给新聊天的请求（C-02）
        state.events.length = 0; state.generating = false; state.userGenActive = false; state.pendingGen = null; state.round = null; state.turnBlock = null; state.impersonateBlock = null; state.lastInjectText = null; state.replyMeta = null; state.streamMarks = null;
        state.groupTurn = null; state.toolCallsAt = 0; state.bgGens = []; state.bgAwaitCombine = 0; state.bgAwaitPrompt = 0; state.backgroundGen = false; state.ownEndedPending = false;   // 群聊 / 工具 / 后台生成的状态都属于旧聊天（L-09）
        state.chatIdSeen = id; pushEvent('chat_changed', { id }); loadHistoryFromChat();
      }
      else pushEvent('chat_reloaded');
      host.setTimeout(render, 300);
      scheduleHide();
      scheduleGuideCheck();
    });
    console.log(LOG, 'bound tavern events via', typeof eventOn === 'function' ? 'tavern-helper' : 'st-core');
  }

  function bindHostEvents() {
    const ta = doc.getElementById('send_textarea');
    if (ta) {
      const onInput = () => {
        const now = Date.now();
        const len = (ta.value || '').length;
        if (state.impersonating) { state.lastLen = len; return; }   // 冒名生成往输入框写的字不是读者写的（A-7）
        if (now - state.lastTypeT < CONFIG.TYPE_COALESCE_MS && len >= state.lastLen) { state.lastLen = len; const last = state.events[state.events.length - 1]; if (last && last.type === 'type') last.len = len; return; }
        state.lastTypeT = now; state.lastLen = len;
        pushEvent('type', { len });
      };
      ta.addEventListener('input', onInput);
      disposers.push(() => ta.removeEventListener('input', onInput));
    } else console.warn(LOG, '#send_textarea not found; typing phase disabled');
    const onActivity = () => { const now = Date.now(); if (now - state.lastActivityT < CONFIG.ACTIVITY_THROTTLE_MS) return; state.lastActivityT = now; pushEvent('activity'); };
    ['mousemove', 'wheel', 'scroll', 'keydown', 'pointerdown', 'touchstart'].forEach((n) => {
      doc.addEventListener(n, onActivity, { passive: true, capture: true });
      disposers.push(() => doc.removeEventListener(n, onActivity, { capture: true }));
    });
    const onVis = () => pushEvent(doc.visibilityState === 'hidden' ? 'hidden' : 'visible');
    doc.addEventListener('visibilitychange', onVis);
    disposers.push(() => doc.removeEventListener('visibilitychange', onVis));
    if (doc.visibilityState === 'hidden') pushEvent('hidden');
    // 窗口失焦（协议 v0.4 §6 unfocused）：切到别的程序、另一块屏幕。点进卡片里的小界面（iframe）时父页面也会收到 blur，
    //   但 document.hasFocus() 仍为 true，所以等一拍再查，只有整个页面都没焦点才记
    let focused = true;
    try { focused = doc.hasFocus(); } catch (_) {}
    if (!focused) pushEvent('blur');
    const onBlur = () => host.setTimeout(() => { let f = true; try { f = doc.hasFocus(); } catch (_) {} if (!f && focused) { focused = false; pushEvent('blur'); } }, 0);
    const onFocus = () => { if (!focused) { focused = true; pushEvent('focus'); } };
    host.addEventListener('blur', onBlur);
    host.addEventListener('focus', onFocus);
    disposers.push(() => { host.removeEventListener('blur', onBlur); host.removeEventListener('focus', onFocus); });
    // 没有 Worker 计时时，后台页的计时会被浏览器压慢，玩具可能停不下来：页面一藏起来就全停
    // 页面藏起来：没有 Worker 计时时后台计时会被压慢，玩具可能停不下来；直连设备在安卓上还会直接断线，所以一律先停
    const onHideStop = () => {
      if (doc.visibilityState !== 'hidden') return;
      if (hTimers.kind === 'page') { try { actuators.stop(undefined, 'other'); } catch (_) {} }
      if (DIRECT.links.size) { try { directHaltAll(); } catch (_) {} }
    };
    doc.addEventListener('visibilitychange', onHideStop);
    disposers.push(() => doc.removeEventListener('visibilitychange', onHideStop));
  }

  // ---------- 悬浮窗（Shadow DOM，底色取酒馆主题变量；强调色固定，避免主题色是灰色时看不出状态） ----------
  // ST 1.18 的 style.css 给 html 加了 transform:translateZ(0) 且 html 高度为 0，fixed 元素改以 html 为包含块，
  // 用 bottom 定位会跑到屏幕上方外面；所以用视口单位算 top（2026-09-17 本地实测 top:-118px）。
  // 配色：底色 / 正文取酒馆主题变量，其它按正文颜色的明暗切深浅两套（:host(.light)，见 syncTone）；青绿 --on 固定，不跟随主题强调色
  // 0.18：第二轮打磨（docs/design-review/ui-round2.md 14 条）、反馈按钮（方案 A）、设备卡（docs/toy-device-card-mockup）。
  //   z-index 用最大值，手机风格的插件盖不住“全部停止”；动画只动 transform / opacity，面板收起或页面隐藏时不跑
  const CSS = `
:host{all:initial;position:fixed;right:14px;top:calc(100vh - 122px);top:calc(100dvh - 122px);z-index:2147483647;
  --font:var(--mainFontFamily,-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif);
  --mono:var(--monoFontFamily,ui-monospace,"SF Mono",Menlo,monospace);
  --bg:var(--SmartThemeBlurTintColor,#141517);--ink:var(--SmartThemeBodyColor,#E9E7E3);
  --raise:#1C1D20;--hair:#2A2B2F;--line2:#3A3B40;--ink2:#B3B0AB;--muted:#8E8C88;--faint:#6A6965;
  --track:#222326;--well:#18191C;--hover:rgba(233,231,227,.06);--off:#626368;
  --heart:#E0564E;--on:#2E9E91;--on-fill:#1E8378;--on-ink:#3DB2A4;--stop:#C4453D;--warn:#D39A3C;--warn-ink:#E3B062;--toy:#D0668C;--toy2:#E58BAB;--heat:#E0784E;
  --gen:#6E8BA8;--read:#C98A4B;--write:#B87A95;--tint:.10;--tint-live:.18;
  --shadow:0 12px 32px rgba(0,0,0,.32),0 0 0 .5px rgba(0,0,0,.4);
  font-family:var(--font);color:var(--ink);font-variant-numeric:tabular-nums}
:host(.light){--raise:#FFFFFF;--hair:#E4E1DB;--line2:#D6D2CA;--ink2:#54514C;--muted:#6F6C66;--faint:#8A867F;
  --track:#E9E7E3;--well:#EDEBE7;--hover:rgba(28,27,25,.05);--off:#8A867F;
  --heart:#C8423A;--on:#1E8378;--on-fill:#1E8378;--on-ink:#1B7A6F;--stop:#C0392F;--warn:#96590F;--warn-ink:#7A4E0B;--toy:#B34D73;--toy2:#C9658B;--heat:#C4582C;
  --gen:#56718E;--read:#9A5F24;--write:#985A76;--tint:.09;--tint-live:.16;
  --shadow:0 8px 24px rgba(0,0,0,.10),0 0 0 .5px rgba(0,0,0,.06)}
:host(.dragging){will-change:transform}
*{box-sizing:border-box}
button{font:inherit;color:inherit;-webkit-tap-highlight-color:transparent}
button:focus-visible{outline:2px solid var(--on-ink);outline-offset:2px}
[hidden]{display:none!important}
@keyframes br{0%,100%{opacity:1}50%{opacity:.4}}
@keyframes beat{0%{transform:scale(1);opacity:.3}100%{transform:scale(1.35);opacity:0}}
@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes fade{from{opacity:0}to{opacity:1}}
@keyframes breathe{0%,100%{opacity:1}50%{opacity:.55}}
/* 胶囊 */
.pill{position:relative;isolation:isolate;display:inline-flex;align-items:center;height:44px;padding:0 14px 0 6px;border-radius:999px;background:var(--bg);border:1px solid var(--hair);
  box-shadow:var(--shadow);backdrop-filter:blur(16px) saturate(1.2);-webkit-backdrop-filter:blur(16px) saturate(1.2);cursor:pointer;white-space:nowrap;user-select:none;-webkit-user-select:none;touch-action:none;transition:border-color .15s,transform .15s}
.pill:hover{border-color:var(--line2)}
.pill:active{transform:scale(.985)}
:host(.dragging) .pill{cursor:grabbing;backdrop-filter:none;-webkit-backdrop-filter:none;transform:none;transition:none}
.seg{display:inline-flex;align-items:center}
.psep{width:1px;height:16px;background:var(--line2);margin:0 12px;flex:none}
.disc{position:relative;width:32px;height:32px;border-radius:50%;display:grid;place-items:center;flex:none}
.disc.hr{background:var(--heart)}
.disc.hr svg{width:15px;height:14px;fill:#fff;transform:translateY(.5px)}
/* 心跳波纹：伪元素只动 transform / opacity；z-index:-1 在圆点背后、胶囊背景之上（胶囊 isolation:isolate） */
.disc.hr::after{content:"";position:absolute;inset:0;z-index:-1;border-radius:50%;background:var(--heart);opacity:0;pointer-events:none}
.disc.hr.on::after{animation:beat var(--beat,1s) ease-out infinite}
.disc.hr.stale{background:var(--warn)}
:host(:not(.light)) .disc.hr.stale svg{fill:#141517}
.disc.hr.off{background:var(--track)}
.disc.hr.off svg{fill:var(--muted)}
.disc.toy{background:color-mix(in srgb,var(--toy) 18%,transparent);color:var(--toy)}
.disc.toy svg{width:16px;height:10px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round}
.num{font:600 16px/20px var(--font);letter-spacing:-.01em;margin-left:8px;color:var(--ink);min-width:20px}
.num.dim{color:var(--muted)}
.unit{font:500 12px/16px var(--font);color:var(--muted);margin-left:2px}
.spark{width:36px;height:14px;margin-left:6px;flex:none;overflow:visible}
.spark path{fill:none;stroke:var(--heart);stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round}
.spark line{stroke:var(--faint);stroke-width:1;stroke-dasharray:2 2}
.delta{font:600 12px/16px var(--font);color:var(--on-ink);margin-left:6px}
.delta.up{color:var(--read)}
.delta:empty{display:none}
.mode{font:12px/16px var(--font);color:var(--muted);margin-left:8px}
.mode.ch{color:var(--toy)}
.mode.warn{color:var(--warn-ink)}
.act{font:600 13px/20px var(--font);color:var(--on-ink);margin-left:8px}
.live{display:none;width:6px;height:6px;border-radius:50%;background:var(--toy);margin-left:8px;box-shadow:0 0 0 2px color-mix(in srgb,var(--toy) 22%,transparent)}
.live.on{display:inline-block;animation:br 1.6s ease-in-out infinite}
/* 面板：固定头部 + 中间滚动 + 固定页脚 */
.card{display:none;position:absolute;right:0;bottom:52px;width:320px;max-height:560px;flex-direction:column;overscroll-behavior:contain;
  background:var(--bg);border:1px solid var(--hair);border-radius:14px;padding:0 12px;box-shadow:var(--shadow);backdrop-filter:blur(20px) saturate(1.2);-webkit-backdrop-filter:blur(20px) saturate(1.2);
  font:13px/20px var(--font);color:var(--ink);text-align:left}
:host(.open) .card{display:flex;animation:rise .16s ease-out}
:host(.below) .card{bottom:auto;top:52px}
:host(.hidden){display:none!important}
.head{flex:none}
.head.pad{padding-bottom:12px}
.tabs{display:flex;align-items:center;height:40px;gap:20px;border-bottom:1px solid var(--hair)}
.tabs button[role="tab"]{height:40px;display:flex;align-items:center;gap:6px;border:0;background:none;padding:0;cursor:pointer;font:600 13px/20px var(--font);color:var(--muted)}
.tabs .lb{position:relative;height:40px;display:flex;align-items:center}
.tabs button[aria-selected="true"]{color:var(--ink)}
.tabs button[aria-selected="true"] .lb::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px 2px 0 0;background:var(--ink)}
.d6{width:6px;height:6px;border-radius:50%;display:inline-block;flex:none;background:var(--on)}
.d6.warn{background:var(--warn)}
.d6.toy{background:var(--toy)}
.d6.off{background:var(--faint)}
.x{margin-left:auto;margin-right:-6px;width:28px;height:28px;border-radius:6px;display:grid;place-items:center;border:0;background:none;padding:0;cursor:pointer;color:var(--muted)}
.x:hover{background:var(--hover);color:var(--ink)}
.x svg{width:10px;height:10px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round}
.sh .x{width:24px;height:24px;margin-right:-7px}
.stop{display:block;width:100%;height:30px;margin:10px 0 0;border:0;border-radius:8px;background:var(--stop);color:#fff;font:600 12px/16px var(--font);letter-spacing:.06em;cursor:pointer;transition:filter .15s,box-shadow .15s}
:host(.busy) .stop{box-shadow:0 0 0 3px color-mix(in srgb,var(--stop) 22%,transparent)}
.stop:hover{filter:brightness(1.07)}
.stop:active{transform:translateY(.5px)}
/* 反馈按钮（方案 A）：比全部停止矮一级，细边无底色；没在动时只剩“再来一次” */
.fb{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-top:8px}
.fb.solo{display:flex}
.fb.solo .fbtn:not(.rp){display:none}
.fbtn{height:30px;min-width:0;padding:0 4px;border:1px solid var(--line2);border-radius:8px;background:none;color:var(--ink);font:500 12px/16px var(--font);display:flex;align-items:center;justify-content:center;gap:3px;white-space:nowrap;cursor:pointer;transition:background-color .15s,border-color .15s,color .15s}
.fb.solo .fbtn{padding:0 14px}
.fbtn:hover{background:var(--hover)}
.fbtn:active{transform:translateY(.5px)}
.fbtn.done{color:var(--on-ink);border-color:color-mix(in srgb,var(--on) 50%,transparent);background:color-mix(in srgb,var(--on) 10%,transparent)}
.fbtn svg{width:10px;height:10px;flex:none;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.body{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;margin:0 -12px;padding:0 12px}
.body.more{-webkit-mask-image:linear-gradient(#000 calc(100% - 16px),transparent);mask-image:linear-gradient(#000 calc(100% - 16px),transparent)}
.sec{padding:12px 0;border-top:1px solid var(--hair)}
.sec.first{border-top:0}
.sec.tight{padding:8px 0}
.sh{display:flex;align-items:center;height:16px;margin:0 0 4px;font:500 11px/16px var(--font);letter-spacing:.02em;color:var(--muted)}
.sh .r{margin-left:auto;display:flex;align-items:center;gap:6px;color:var(--toy)}
.status{display:flex;align-items:center;gap:8px;height:20px}
.status b{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.status .st{color:var(--muted);display:inline-flex;align-items:center;font-size:12px;white-space:nowrap}
.status .st.warn{color:var(--warn-ink)}
.status .st:empty{display:none}
/* 健康页改版（效果图 ../docs/hr-panel-mockup，2026-09-18 批准）：戴在哪、三格信号、低电量、没戴好、平静心率的来历、静坐记录 */
.kind{flex:none;font:500 11px/16px var(--font);color:var(--ink2);padding:0 6px;border:1px solid var(--line2);border-radius:999px;white-space:nowrap}
.sig{display:inline-flex;align-items:flex-end;gap:2px;height:11px;margin-left:auto;flex:none}
.sig:not([hidden]) + .batt{margin-left:8px}
.sig i{display:block;width:3px;border-radius:1px;background:var(--line2)}
.sig i:nth-child(1){height:5px}.sig i:nth-child(2){height:8px}.sig i:nth-child(3){height:11px}
.sig i.on{background:var(--on)}
.status .st.warn ~ .sig i.on{background:var(--warn)}
.sdot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--faint)}
.sdot.ok{background:var(--on)}
.sdot.warn{background:var(--warn)}
.batt{margin-left:auto;font:12px/16px var(--font);color:var(--muted);white-space:nowrap}
.batt em{font-style:normal;font-weight:500;color:var(--ink)}
.batt.low em{color:var(--warn-ink)}
.empty{color:var(--muted);margin:0}
.link{margin-left:auto;margin-right:-2px;border:0;background:none;padding:0 2px;border-radius:4px;cursor:pointer;color:var(--on-ink);font:500 12px/16px var(--font)}
.link:hover{text-decoration:underline;text-underline-offset:2px}
/* 时间线：每个节点自己画到下一个节点的竖线，最后一个不画 */
.tl{position:relative;padding-left:20px}
.node{position:relative;padding:4px 0;--c:var(--faint)}
.node::before{content:"";position:absolute;left:-20px;top:10.5px;width:7px;height:7px;border-radius:50%;background:var(--c)}
.node::after{content:"";position:absolute;left:-17px;top:19px;bottom:-9px;width:1px;background:var(--hair)}
.node:last-child::after{display:none}
.node.hol::before{background:var(--bg);box-shadow:inset 0 0 0 1.5px var(--c)}
.node.bare::before{display:none}
.node.bare::after{top:0}
.node.pulse::before{animation:br 1.6s ease-in-out infinite}
.node.pulse.toy::before{box-shadow:0 0 0 3px color-mix(in srgb,var(--toy) 24%,transparent)}
.th{display:flex;align-items:baseline;gap:8px;min-height:20px;min-width:0}
.th b{font-weight:600;white-space:nowrap}
.th .d{white-space:nowrap}
.th .m{color:var(--muted);font-size:12px;white-space:nowrap}
.th .m.w{color:var(--write)}
.th .m.t{color:var(--toy)}
.th .m.no{color:var(--warn-ink);white-space:normal}
.th .m.nw{color:var(--warn-ink);white-space:nowrap}
.th .r{margin-left:auto;display:flex;align-items:baseline;gap:4px}
.big{font:600 20px/20px var(--font);letter-spacing:-.01em}
.tsub{font:12px/16px var(--font);color:var(--muted);margin-top:4px;display:flex;align-items:center;flex-wrap:wrap}
.chart{display:block;margin-top:6px;width:100%;overflow:visible}
.ghost{margin-top:6px;height:28px;border:1px dashed var(--line2);border-radius:4px;display:grid;place-items:center;font:12px/16px var(--font);color:var(--muted)}
.hatch{display:inline-block;width:10px;height:8px;margin-right:4px;background:repeating-linear-gradient(135deg,var(--muted) 0 1px,transparent 1px 3px);opacity:.6}
.hatch.warn{background:repeating-linear-gradient(135deg,var(--warn) 0 1px,transparent 1px 3px);opacity:.9}
.node p{margin:2px 0 0}
.quote{max-height:6em;overflow:auto}
.sees b{font-weight:600}
.sees i{font-style:normal;color:var(--warn)}
.sees.mut{color:var(--muted);font-size:12px;line-height:16px}
.ptext{margin:6px 0 0;max-height:12em;overflow:auto;white-space:pre-wrap;word-break:break-all;font:10px/1.5 var(--mono);color:var(--muted);background:var(--raise);border:1px solid var(--hair);border-radius:8px;padding:6px 8px}
.base{display:flex;align-items:center;gap:8px;font:12px/16px var(--font);padding-top:10px;margin-top:2px;border-top:1px solid var(--hair)}
.base b{font-weight:600}
.base svg{width:14px;height:2px;flex:none}
.small{font:11px/16px var(--font);color:var(--muted);margin-top:2px}
.small em{font-style:normal;font-weight:500;color:var(--ink)}
.basemenu{display:flex;gap:8px;margin-top:8px}
.basemenu button{flex:1;height:28px;border:1px solid var(--line2);background:none;border-radius:8px;font:500 12px/16px var(--font);cursor:pointer;transition:background-color .15s}
.basemenu button:hover{background:var(--hover)}
.base .old{color:var(--warn-ink)}
.rest{display:flex;align-items:center;gap:10px;padding-top:10px;margin-top:2px;border-top:1px solid var(--hair)}
.ring3{width:44px;height:44px;flex:none;transform:rotate(-90deg)}
.ring3 circle{fill:none;stroke-width:4;stroke-linecap:round}
.ring3 .bg{stroke:var(--track)}
.ring3 .warm{stroke:var(--faint)}
.ring3 .rec{stroke:var(--on);animation:breathe 2.4s ease-in-out infinite}
.rt{display:flex;flex-direction:column;min-width:0}
.rt b{font:600 13px/18px var(--font)}
.rt span{font:12px/16px var(--font);color:var(--muted)}
.rt span.w{color:var(--warn-ink)}
.rleft{margin-left:auto;font:600 20px/20px var(--font);letter-spacing:-.01em}
.last{margin:0;color:var(--ink2)}
.last b{color:var(--ink);font-weight:600}
.other{margin-top:6px}
.small2{font-size:12px;line-height:18px}
.ntag{display:inline-flex;align-items:center;align-self:center;height:18px;padding:0 5px;border-radius:4px;font:500 11px/1 var(--font);white-space:nowrap}
.ntag.up{color:var(--toy);background:color-mix(in srgb,var(--toy) 14%,transparent)}
.ntag.skip{color:var(--muted);background:color-mix(in srgb,var(--muted) 16%,transparent)}
.ntag.pop{animation:fade .2s ease-out}
.node.skipped .th b{color:var(--muted)}
.node.skipped .th .d{color:var(--muted);text-decoration:line-through;text-decoration-color:var(--faint)}
.fbnote{margin:4px 0 0 20px;font:11px/16px var(--font);color:var(--muted)}
.play{margin:0}
.play q,.steps q{quotes:"「" "」";color:var(--toy)}
.steps{margin:0;padding-left:18px}
.steps li{margin:2px 0}
.steps b{font-weight:600}
/* 效果图里叫 .more；这里改名 .pmore：.body.more 已是“还能往下滚”的遮罩 */
.pmore{display:inline-block;margin-top:6px;color:var(--on-ink);font:500 12px/16px var(--font);text-decoration:none;border-radius:4px}
.pmore:hover{text-decoration:underline;text-underline-offset:2px}
.pmore:focus-visible{outline:2px solid var(--on-ink);outline-offset:2px}
/* 设置与连接 */
.fold{display:flex;align-items:center;gap:8px;width:calc(100% + 16px);height:36px;margin:0 -8px;padding:0 8px;border:0;border-radius:8px;background:none;cursor:pointer;font:600 13px/20px var(--font);color:var(--ink);text-align:left;transition:background-color .15s}
.fold:hover{background:var(--hover)}
.cv{margin-left:auto;width:12px;height:12px;flex:none;color:var(--muted);fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;transition:transform .2s ease}
.fold[aria-expanded="false"] .cv{transform:rotate(-90deg)}
.foldbody{margin-top:4px}
.set{display:flex;align-items:center;min-height:40px;gap:8px}
.set>:last-child{margin-left:auto}
.meaning{font:12px/16px var(--font);color:var(--muted);margin:-6px 0 6px}
.segctl{display:inline-flex;height:28px;padding:2px;border-radius:8px;background:var(--track)}
.segctl button{min-width:44px;height:24px;padding:0 8px;border:0;border-radius:6px;background:none;font:500 12px/24px var(--font);color:var(--ink2);cursor:pointer;transition:background-color .15s,color .15s}
.segctl button:hover{color:var(--ink)}
.segctl button[aria-pressed="true"]{background:var(--on-fill);color:#fff;font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.18)}
.switch{width:36px;height:20px;border-radius:999px;border:0;padding:0;background:var(--off);position:relative;cursor:pointer;flex:none;transition:background-color .15s}
.switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s ease}
.switch[aria-checked="true"]{background:var(--on)}
.switch[aria-checked="true"]::after{transform:translateX(16px)}
.textbtn{display:inline-flex;align-items:center;height:28px;border:0;background:none;padding:0;cursor:pointer;font:500 12px/16px var(--font);color:var(--muted)}
.textbtn:hover{color:var(--stop)}
.textbtn.other:hover{color:var(--ink)}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:4px 0 0}
.btn{min-height:48px;border:1px solid var(--line2);background:none;border-radius:8px;padding:6px 8px;font:600 13px/20px var(--font);color:var(--ink);cursor:pointer;text-align:center;transition:border-color .15s,background-color .15s}
.btn:hover{background:var(--hover)}
.btn small{display:block;font:400 11px/16px var(--font);color:var(--muted)}
.btn small.rec{color:var(--on-ink)}
.btn.on{border-color:color-mix(in srgb,var(--on) 55%,transparent)}
.btn.on small{color:var(--on-ink)}
.btn.primary{min-height:36px;width:100%;margin-top:12px;background:var(--on-fill);border-color:var(--on-fill);color:#fff}
.btn.primary:hover{background:var(--on-fill);filter:brightness(1.07)}
.btn.full{grid-column:1/-1;width:100%;min-height:36px}
.btn:disabled{border-style:dashed;color:var(--faint);cursor:not-allowed;background:none}
.btn:disabled:hover{background:none}
.btn:disabled small{color:var(--warn-ink)}
.conn{display:flex;align-items:center;width:100%;min-height:40px;gap:8px;border:0;background:none;padding:0;cursor:pointer;font:13px/20px var(--font);color:var(--ink);text-align:left}
.conn .r{margin-left:auto;display:flex;align-items:center;gap:6px;color:var(--muted);font-size:12px}
.conn .cv{margin-left:2px;transform:rotate(-90deg)}
:host(.devs) .conn .cv{transform:none}
.devs{display:none;max-height:15em;overflow:auto;padding:0 0 4px}
:host(.devs) .devs{display:block}
.devs b{display:flex;align-items:center;gap:8px;margin:6px 0 2px;font:600 12px/16px var(--font)}
.devs label{display:flex;gap:8px;align-items:center;cursor:pointer;min-height:24px;font-size:12px}
.devs label i{font-style:normal;color:var(--muted);font-size:11px}
.devs input{accent-color:var(--on);margin:0;width:14px;height:14px}
.help{display:none;margin:12px 0 0;padding:8px 12px 8px 24px;border-radius:10px;background:var(--raise);border:1px solid var(--hair);font:12px/16px var(--font);max-height:14em;overflow:auto}
:host(.help) .help{display:block}
.help li{margin:4px 0}
.help li.error b{color:var(--stop)}
.help li.warn b{color:var(--warn)}
.foot{flex:none;display:flex;align-items:center;gap:16px;height:36px;border-top:1px solid var(--hair);font:500 11px/16px var(--font);color:var(--muted);white-space:nowrap}
.foot button{border:0;background:none;padding:0;cursor:pointer;color:var(--muted);font:500 11px/16px var(--font);display:inline-flex;align-items:center;gap:5px;border-radius:4px}
.foot button:hover{color:var(--ink)}
.foot .ver{margin-left:auto}
/* 设备卡：每台设备一张，每一路跟着 heartlink 发出的帧动（只画发出的档位，不代表设备真的执行了） */
.dcards{display:flex;flex-direction:column;gap:8px}
.dc{position:relative;isolation:isolate;border-radius:12px;background:var(--raise);border:1px solid var(--hair)}
.dc::before{content:"";position:absolute;inset:-1px;z-index:-1;border-radius:12px;pointer-events:none;opacity:0;transition:opacity .3s ease;
  box-shadow:0 0 0 1px color-mix(in srgb,var(--toy) 32%,transparent),0 6px 20px -8px color-mix(in srgb,var(--toy) 45%,transparent)}
.dc.moving::before{opacity:1}
.dc.moving.hot::before{box-shadow:0 0 0 1px color-mix(in srgb,var(--heat) 36%,transparent),0 6px 20px -8px color-mix(in srgb,var(--heat) 50%,transparent)}
.dh{display:flex;align-items:center;gap:10px;height:48px;padding:0 10px 0 8px;width:100%;border:0;background:none;text-align:left;border-radius:12px;color:var(--ink)}
button.dh{cursor:pointer;transition:background-color .15s}
button.dh:hover{background:var(--hover)}
.art{position:relative;width:34px;height:34px;flex:none;border-radius:9px;background:var(--well);display:grid;place-items:center;color:var(--ink2)}
.art .fig{display:grid;place-items:center;will-change:transform}
.art svg{width:18px;height:12px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round}
.art .warm{position:absolute;inset:0;border-radius:9px;opacity:0;background:radial-gradient(circle at 50% 70%,color-mix(in srgb,var(--heat) 40%,transparent),transparent 70%);will-change:opacity}
.art .cd{position:absolute;right:-2px;bottom:-2px;width:10px;height:10px;border-radius:50%;background:var(--on);box-shadow:0 0 0 2px var(--raise)}
.dname{flex:1;min-width:0;font:600 13px/18px var(--font);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbat{flex:none;font:500 11px/16px var(--font);color:var(--dim);font-variant-numeric:tabular-nums}
.dbat.low{color:var(--warn)}
.minis{display:flex;align-items:flex-end;gap:2px;height:12px;flex:none}
.minis i{width:3px;height:12px;border-radius:1.5px;background:var(--faint);transform-origin:50% 100%;transform:scaleY(.35);will-change:transform;transition:background-color .25s}
.minis i.on{background:var(--toy)}
.dh .cv{margin-left:0}
.dh[aria-expanded="false"] .cv{transform:rotate(-90deg)}
.rows{padding:0 10px 6px}
.fr{position:relative;display:grid;grid-template-columns:52px minmax(0,1fr) 48px;gap:8px;align-items:center;height:32px;border-top:1px solid var(--hair)}
.fr::before{content:"";position:absolute;inset:2px -6px;border-radius:7px;z-index:-1;opacity:0;transition:opacity .25s ease;
  background:linear-gradient(90deg,color-mix(in srgb,var(--toy) 12%,transparent),color-mix(in srgb,var(--toy) 3%,transparent))}
.fr.on::before{opacity:1;animation:breathe 2.8s ease-in-out infinite}
.fr.heat.on::before{background:linear-gradient(90deg,color-mix(in srgb,var(--heat) 14%,transparent),color-mix(in srgb,var(--heat) 3%,transparent))}
.fn{display:flex;align-items:center;gap:4px;font:500 12px/16px var(--font);color:var(--muted);white-space:nowrap;overflow:hidden;transition:color .25s}
.fr.on .fn{color:var(--ink)}
.fn svg{width:9px;height:11px;flex:none;fill:none;stroke:var(--heat);stroke-width:1.4;stroke-linejoin:round;opacity:.8}
.lv{text-align:right;font:500 11px/16px var(--font);color:var(--faint);white-space:nowrap;transition:color .25s}
.lv b{font:600 13px/16px var(--font);color:var(--muted);transition:color .25s}
.fr.on .lv{color:var(--muted)}
.fr.on .lv b{color:var(--ink)}
.viz{position:relative;height:22px;border-radius:6px;background:var(--well);overflow:hidden}
.viz canvas{display:block;width:100%;height:100%}
.viz .say{position:absolute;inset:0;display:flex;align-items:center;gap:5px;padding:0 8px;font:11px/16px var(--font);color:var(--muted);white-space:nowrap;opacity:1;transition:opacity .25s}
.viz .say svg{width:11px;height:11px;flex:none;fill:none;stroke:currentColor;stroke-width:1.3;stroke-linecap:round}
.fr.on .viz .say.idle{opacity:0}
.osc .rail{position:absolute;left:12px;right:12px;top:50%;height:2px;margin-top:-1px;border-radius:1px;background:var(--line2)}
.osc .range{position:absolute;left:12px;right:12px;top:50%;height:10px;margin-top:-5px;border-radius:5px;background:color-mix(in srgb,var(--toy) 14%,transparent);opacity:0;transition:opacity .3s}
.fr.on .osc .range{opacity:1}
.osc .kn{position:absolute;top:50%;left:12px;width:16px;height:10px;margin:-5px 0 0 -8px;border-radius:5px;background:var(--faint);will-change:transform;transition:background-color .25s}
.fr.on .osc .kn{background:var(--toy)}
.osc .kn.tr{opacity:0;background:var(--toy)!important}
.spin .wheel{position:absolute;left:6px;top:3px;width:16px;height:16px;will-change:transform}
.spin .wheel circle{fill:none;stroke-width:1.6}
.spin .track{position:absolute;left:28px;right:6px;top:50%;height:2px;margin-top:-1px;overflow:hidden}
.spin .track i{position:absolute;top:0;bottom:0;left:0;right:-12px;background:radial-gradient(circle,var(--faint) 1px,transparent 1.3px) 0 50%/8px 2px repeat-x;will-change:transform}
.fr.on .spin .track i{background-image:radial-gradient(circle,var(--toy) 1px,transparent 1.3px)}
.heatv .fill{position:absolute;left:0;top:0;bottom:0;width:100%;transform-origin:0 50%;transform:scaleX(0);will-change:transform;
  background:linear-gradient(90deg,color-mix(in srgb,var(--heat) 8%,transparent),color-mix(in srgb,var(--heat) 42%,transparent))}
.heatv .shim{position:absolute;inset:0;overflow:hidden;opacity:0;transition:opacity .3s}
.heatv .shim i{position:absolute;top:0;bottom:0;left:0;width:28px;will-change:transform;background:linear-gradient(90deg,transparent,rgba(255,255,255,.22),transparent)}
:host(.light) .heatv .shim i{background:linear-gradient(90deg,transparent,rgba(255,255,255,.6),transparent)}
.fr.on .heatv .shim{opacity:1}
.heatv .end{position:absolute;right:0;top:4px;bottom:4px;width:2px;border-radius:1px;background:var(--heat);opacity:0;transition:opacity .25s}
.fr.on .heatv .end{opacity:.55}
.heatv .say.run{justify-content:flex-end;color:var(--ink2);opacity:0;padding-right:10px}
.heatv .say.run span{text-shadow:0 0 4px var(--well),0 0 2px var(--well)}
.fr.on .heatv .say.run{opacity:1}
.heatv .say.run b{font-weight:600;color:var(--ink);margin-right:2px}
/* 0.19 浏览器直接连（按 TBC 驱动）：选型号、等浏览器的蓝牙窗口、握手、连不上、断线后可能仍在动、停不下来的自带模式 */
.pick{margin:4px 0 2px;border:1px solid var(--hair);border-radius:12px;background:var(--raise);overflow:hidden}
.pick .ph{display:flex;align-items:center;gap:6px;min-height:36px;padding:0 10px;border-bottom:1px solid var(--hair);font:600 12px/16px var(--font)}
.pick .back{width:24px;height:24px;margin-left:-6px;border:0;border-radius:6px;background:none;display:grid;place-items:center;color:var(--muted);cursor:pointer}
.pick .back .cv{width:12px;height:12px;margin:0;transform:rotate(90deg)}
.model{display:flex;align-items:center;gap:10px;width:100%;min-height:52px;padding:6px 10px;border:0;border-top:1px solid var(--hair);background:none;text-align:left;color:var(--ink);cursor:pointer;transition:background-color .15s}
.model:first-of-type{border-top:0}
.model:hover{background:var(--hover)}
.model .mt{flex:1;min-width:0}
.model b{display:flex;align-items:baseline;gap:0;min-width:0;font:600 13px/18px var(--font)}
.model b span.n{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.model .s{display:block;font:11px/15px var(--font);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.model .cv{margin-left:0;transform:rotate(-90deg)}
.tag{display:inline-block;margin-left:6px;padding:0 5px;border-radius:4px;font:500 10px/15px var(--font);vertical-align:1px;color:var(--warn-ink);background:color-mix(in srgb,var(--warn) 16%,transparent)}
.pick .ft{padding:8px 10px;border-top:1px solid var(--hair);font:11px/16px var(--font);color:var(--muted)}
.gen{width:34px;height:34px;flex:none;border-radius:9px;background:var(--well);display:grid;place-items:center;color:var(--ink2)}
.gen svg{width:18px;height:12px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round}
.wait{border:1px dashed var(--line2);border-radius:12px;padding:10px 12px;margin:4px 0 2px}
.wait .wt{display:flex;align-items:center;gap:8px;font:600 12.5px/18px var(--font)}
.spin2{width:14px;height:14px;flex:none;border-radius:50%;border:2px solid color-mix(in srgb,var(--on-ink) 25%,transparent);border-top-color:var(--on-ink);animation:rot .9s linear infinite}
@keyframes rot{to{transform:rotate(360deg)}}
.wait .nm{font-family:var(--mono);font-size:11.5px;padding:0 4px;border-radius:4px;background:var(--track)}
.wait ul{margin:6px 0 0;padding-left:16px;font:11.5px/17px var(--font);color:var(--ink2)}
.wait li{margin:1px 0}
/* 设备卡：连接状态、断线、错误 */
.dc.lost{border-color:color-mix(in srgb,var(--warn) 60%,transparent)}
.dc.lost::before,.dc.lost.moving::before{opacity:1;box-shadow:0 0 0 1px color-mix(in srgb,var(--warn) 30%,transparent),0 6px 20px -10px color-mix(in srgb,var(--warn) 55%,transparent)}
.dc.err{border-color:color-mix(in srgb,var(--stop) 45%,transparent)}
.dh{min-height:48px;height:auto;padding:6px 10px 6px 8px}
.dname small{display:block;font:400 11px/15px var(--font);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dname small.w{color:var(--warn-ink);font-weight:500}
.dname small.e{color:var(--stop);font-weight:500}
.art svg.shape{width:22px;height:28px;stroke-width:1.6;stroke-linejoin:round}
.art .cd.warn{background:var(--warn)}
.art .cd.err{background:var(--stop)}
.art .cd.pending{background:var(--faint);animation:br 1.2s ease-in-out infinite}
.lv .mini{border:0;background:none;padding:0;cursor:pointer;color:var(--on-ink);font:500 11px/16px var(--font)}
.lv .mini:hover{text-decoration:underline;text-underline-offset:2px}
/* 断线后：斜线底纹 + 断开前的档位 */
.fr.maybe .viz{background:repeating-linear-gradient(135deg,color-mix(in srgb,var(--warn) 16%,var(--well)) 0 5px,var(--well) 5px 10px)}
.fr.maybe .viz .say{color:var(--warn-ink);font-weight:500;opacity:1}
.fr.maybe .viz .chip{padding:0 6px;border-radius:5px;background:var(--well);line-height:16px}
.fr.maybe .fn{color:var(--ink)}
.fr.maybe .lv b{color:var(--warn-ink)}
.fr.maybe .suck .cup,.fr.maybe .suck .core,.fr.maybe .suck .flow{display:none}
/* 吮吸：左边一个吸口，点阵向它流入 */
.suck .cup{position:absolute;left:6px;top:3px;width:16px;height:16px;border-radius:50%;border:1.5px solid var(--faint);transition:border-color .25s}
.suck .core{position:absolute;left:10px;top:7px;width:8px;height:8px;border-radius:50%;background:var(--faint);will-change:transform;transition:background-color .25s}
.fr.on .suck .cup{border-color:var(--toy)}
.fr.on .suck .core{background:var(--toy2)}
.suck .flow{position:absolute;left:28px;right:6px;top:50%;height:4px;margin-top:-2px;overflow:hidden;opacity:.35;transition:opacity .25s;
  -webkit-mask:linear-gradient(90deg,#000 60%,transparent);mask:linear-gradient(90deg,#000 60%,transparent)}
.suck .flow i{position:absolute;inset:0 -10px 0 0;background:radial-gradient(circle,var(--faint) 1.2px,transparent 1.5px) 0 50%/10px 4px repeat-x;will-change:transform}
.fr.on .suck .flow{opacity:1}
.fr.on .suck .flow i{background-image:radial-gradient(circle,var(--toy) 1.2px,transparent 1.5px)}
/* 握手进度 */
.hs{padding:2px 10px 10px 52px}
.hs .dots{display:flex;gap:4px}
.hs .dots i{flex:1;height:4px;border-radius:2px;background:var(--track)}
.hs .dots i.got{background:var(--on)}
.hs .dots i.now{background:color-mix(in srgb,var(--on) 45%,var(--track));animation:br 1s ease-in-out infinite}
.hs p{margin:6px 0 0;font:11px/16px var(--font);color:var(--muted)}
/* 卡内提示（连不上 / 断线 / 停止失败） */
.cnote{margin:0 10px 10px;padding:8px 10px;border-radius:8px;font:12px/18px var(--font);color:var(--ink)}
.cnote.e{background:color-mix(in srgb,var(--stop) 10%,transparent)}
.cnote.w{background:color-mix(in srgb,var(--warn) 12%,transparent)}
.cnote b{font-weight:600}
.cnote .acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.cnote .acts:first-child{margin-top:0}
.sbtn{height:28px;padding:0 12px;border-radius:7px;border:1px solid var(--line2);background:var(--raise);font:500 12px/16px var(--font);color:var(--ink);cursor:pointer;transition:filter .15s}
.sbtn.pri{background:var(--on-fill);border-color:var(--on-fill);color:#fff;font-weight:600}
.sbtn.danger{border-color:color-mix(in srgb,var(--stop) 70%,transparent);color:var(--stop);font-weight:600}
.sbtn:hover{filter:brightness(1.05)}
.sbtn[disabled]{opacity:.6;cursor:default}
/* 自带模式一行（只有驱动声明了停不下来的自带模式才出现） */
.nat{display:flex;align-items:center;gap:8px;min-height:36px;border-top:1px solid var(--hair);font:12px/16px var(--font);color:var(--ink)}
.nat .ns{display:block;font:11px/15px var(--font);color:var(--muted)}
.nat .switch{margin-left:auto}
/* 常驻横幅：停不下来的自带模式正在运行 */
.banner{position:relative;margin-top:8px;border-radius:9px;padding:8px 10px 10px;background:color-mix(in srgb,var(--warn) 14%,var(--bg));border:1px solid color-mix(in srgb,var(--warn) 45%,transparent);overflow:hidden}
.banner .bt{display:flex;gap:8px;align-items:flex-start}
.banner .bt>svg{width:14px;height:14px;flex:none;margin-top:3px;fill:none;stroke:var(--warn-ink);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.banner p{margin:0;font:600 12px/18px var(--font);color:var(--ink)}
.banner .rm{margin-left:auto;flex:none;text-align:right;font:500 11px/14px var(--font);color:var(--warn-ink);white-space:nowrap;padding-top:2px}
.banner .rm b{display:block;font:650 18px/20px var(--font);letter-spacing:-.01em;white-space:nowrap}
.banner .rm small{font:500 11px/14px var(--font);margin-left:1px}
.banner .sub{margin:4px 0 0 22px;font:11.5px/16px var(--font);color:var(--ink2)}
.banner .prog{margin:8px 0 0 22px;height:3px;border-radius:2px;background:color-mix(in srgb,var(--warn) 22%,transparent);overflow:hidden}
.banner .prog i{display:block;height:100%;width:100%;background:var(--warn);transform-origin:0 50%;will-change:transform}
/* 面板里的确认面板（逐台开启微电流 / 自带模式） */
.scrim{position:absolute;inset:0;z-index:2;background:rgba(8,8,10,.55)}
:host(.light) .scrim{background:rgba(28,27,25,.28)}
.sheet{position:absolute;left:0;right:0;bottom:0;z-index:3;background:var(--bg);border-top:1px solid var(--hair);border-radius:14px 14px 13px 13px;padding:6px 14px 14px;box-shadow:0 -10px 30px rgba(0,0,0,.25)}
:host(.sheet) .card{overflow:hidden}
.sheet .grab{width:32px;height:4px;border-radius:2px;background:var(--line2);margin:0 auto 10px}
.sheet h3{margin:0;font:650 14px/20px var(--font)}
.sheet .who{margin:2px 0 10px;font:12px/16px var(--font);color:var(--muted)}
.warnbox{display:flex;gap:8px;padding:10px;border-radius:9px;background:color-mix(in srgb,var(--warn) 14%,var(--bg));border:1px solid color-mix(in srgb,var(--warn) 45%,transparent)}
.warnbox svg{width:16px;height:16px;flex:none;margin-top:1px;fill:none;stroke:var(--warn-ink);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.warnbox p{margin:0;font:600 12.5px/19px var(--font)}
.facts{margin:10px 0 0;padding:0;list-style:none;font:12px/18px var(--font);color:var(--ink2)}
.facts li{position:relative;padding-left:12px;margin:3px 0}
.facts li::before{content:"";position:absolute;left:2px;top:8px;width:4px;height:4px;border-radius:50%;background:var(--faint)}
.facts b{color:var(--ink);font-weight:600}
.sheet .acts{display:flex;gap:8px;margin-top:14px}
.sheet .acts .sbtn{flex:1;height:34px}
/* 设置页（设置方案 §4，F-098 起从弹层改为顶部第三个标签页） */
.mgroup{margin-top:12px;padding-top:10px;border-top:1px solid var(--hair)}
.mgroup:first-of-type{border-top:0}
.mgh{font:600 12px/1 var(--font);color:var(--muted);letter-spacing:.02em;margin-bottom:6px}
.mnote{margin:0 0 8px;font:12px/16px var(--font);color:var(--muted)}
.mrow{display:flex;align-items:center;gap:8px;padding:7px 0}
.mrow .ml{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.mrow .mk{font:13px/17px var(--font);color:var(--ink)}
.mrow .msub{font:11px/14px var(--font);color:var(--muted)}
.mrow .mc{display:flex;align-items:center;gap:6px;flex-shrink:0}
.mrow .mv{font:600 13px/1 var(--font);color:var(--on-ink);white-space:nowrap;font-variant-numeric:tabular-nums}
.mstep{width:26px;height:26px;border:1px solid var(--line2);border-radius:7px;background:var(--bg);color:var(--ink);font:600 15px/1 var(--font);cursor:pointer}
.mstep:hover{background:var(--hover)}
.mauto{height:26px;padding:0 8px;border:0;border-radius:7px;background:transparent;color:var(--on-ink);font:12px/1 var(--font);cursor:pointer}
.mauto:hover{text-decoration:underline}
.tune{margin-left:8px;padding:0;border:0;background:none;color:var(--on-ink);font:12px/1 var(--font);cursor:pointer}
.tune:hover{text-decoration:underline}
.mrow .mseg{flex-shrink:0}
.mrow .mseg button{padding:0 9px;height:28px;font:12px/1 var(--font)}
@media (max-width:360px){.mrow:has(.mseg){flex-wrap:wrap}.mrow .mseg{width:100%}}
/* 胶囊：断线后可能仍在动的琥珀点、自带模式的倒计时环 */
.live.warn{background:var(--warn);box-shadow:0 0 0 2px color-mix(in srgb,var(--warn) 25%,transparent)}
.ring{display:inline-flex;margin-left:8px;flex:none}
.ring svg{width:16px;height:16px;transform:rotate(-90deg)}
.ring circle{fill:none;stroke-width:2.2}
.ring .bg{stroke:color-mix(in srgb,var(--warn) 25%,transparent)}
.ring .fg{stroke:var(--warn);stroke-linecap:round}
@media (prefers-reduced-motion:reduce){
  .disc.hr.on::after,.live.on,.node.pulse::before,.ntag.pop,:host(.open) .card,.fr.on::before,.spin2,.hs .dots i.now,.art .cd.pending,.ring3 .rec{animation:none!important}
  .disc.hr.on::after{opacity:0}
  .cv,.switch,.switch::after,.fbtn,.segctl button,.stop,.pill,.btn,.fold,.basemenu button,button.dh,.dc::before,.fr::before,.fn,.lv,.lv b,.viz .say,.osc .range,.osc .kn,.heatv .shim,.heatv .end,.minis i,.model,.sbtn,.suck .cup,.suck .core,.suck .flow{transition:none!important}
  .heatv .shim{display:none}
}
/* 窄屏（手机）：面板占满宽度、左右各留 8，放在酒馆顶栏下面（top 由 fitPanel 算），避开刘海 */
@media (max-width:479px){
  .card{position:fixed;left:max(8px,env(safe-area-inset-left));right:max(8px,env(safe-area-inset-right));width:auto;bottom:auto;top:56px}
  :host(.below) .card{top:56px}
  .fbtn{height:34px}
}`;
  const HEART_SVG = '<svg viewBox="0 0 24 22" aria-hidden="true"><path d="M12 21s-9-5.6-9-12.2A5 5 0 0 1 12 6a5 5 0 0 1 9 2.8C21 15.4 12 21 12 21z"/></svg>';
  const WAVE_SVG = '<svg viewBox="0 0 16 10" aria-hidden="true"><path d="M1.2 5c1.9-3.6 3-3.6 4.9 0s3 3.6 4.9 0 2.6-3.6 3.8 0"/></svg>';
  const X_SVG = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1l8 8M9 1L1 9"/></svg>';
  const CV_SVG = '<svg class="cv" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3"/></svg>';
  const CK_SVG = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 5.2l2.3 2.3 4.7-5"/></svg>';
  const DASH_SVG = '<svg viewBox="0 0 14 2" aria-hidden="true"><line x1="0" x2="14" y1="1" y2="1" style="stroke:var(--faint);stroke-width:1;stroke-dasharray:2 3"/></svg>';
  const RISK_SVG = '<svg viewBox="0 0 9 11" aria-hidden="true"><path d="M4.5 1C5 3 7.8 4.4 7.8 7a3.3 3.3 0 0 1-6.6 0c0-1.3.7-2.1 1.3-2.6.1 1 .6 1.6 1.2 1.8C3.4 4.6 3.9 2.6 4.5 1z"/></svg>';
  const CLOCK_SVG = '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.5"/><path d="M6 3.6V6l1.6 1"/></svg>';
  const WARN_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8 15 14H1z"/><path d="M8 6.2v3.6M8 11.9v.2"/></svg>';
  // 设备线稿（没有产品图时按驱动的 shape 画）：驱动里现有 egg / rabbit，其它一律按摩棒
  const SHAPE_SVG = {
    egg: '<path d="M24 6c9 0 15 13 15 25 0 11-7 17-15 17S9 42 9 31C9 19 15 6 24 6z"/><path d="M24 48c0 5 2 8 6 10"/><circle cx="30" cy="58" r="1.5"/>',
    rabbit: '<path d="M16 60V30c0-12 3-24 8-24s8 12 8 24v30z"/><path d="M32 40c5-2 8-8 9-14 1-4-1-6-3-4-3 3-5 9-6 12"/><path d="M20 48h8"/>',
    wand: '<path d="M24 6c6 0 10 5 10 11s-4 10-10 10-10-4-10-10S18 6 24 6z"/><path d="M19 27v27a5 5 0 0 0 10 0V27"/>',
  };
  const shapeArt = (s) => `<svg class="shape" viewBox="0 0 48 64" aria-hidden="true">${SHAPE_SVG[s] || SHAPE_SVG.wand}</svg>`;
  // 型号名按读者认得的写法：品牌只留中文那段，型号去掉括号里的英文名（繁野 FUNF 啵啵贝（SOSEXY）→ 繁野 啵啵贝）
  const modelName = (d) => `${String(d.brand || '').split(' ')[0]} ${String(d.model || '').replace(/[（(][^）)]*[）)]/g, '').trim()}`.trim();
  // 反馈按钮：[类型, 按钮字, 按下后约 2 秒的确认字]
  const FB_BTNS = [['weaker', '弱一点', '已调弱'], ['stronger', '强一点', '已调强'], ['replay', '再来一次', '已重放'], ['skip', '跳过', '已跳过']];
  const FB_BY = Object.fromEntries(FB_BTNS.map((b) => [b[0], b]));
  const FB_STEP = 20;   // 调强 / 调弱一次的百分点
  const PLAY_URL = 'https://github.com/kcgoofee-jpg/heartlink-extension#模型怎么让设备动';
  const REFUSE_ZH = { disabled: '剧情联动没开', 'unknown-target': '设备不在了', unsupported: '设备不支持', 'not-worn': '没戴着', sleeping: '睡眠中', 'quiet-hours': '勿扰时段', 'rate-limit': '太快了，稍等再按' };

  let hostEl = null, root = null, el = {};
  let dragged = false;
  let dragStart = null;
  function mountBadge() {
    const old = doc.getElementById(CONFIG.HOST_ID); if (old) old.remove();
    hostEl = doc.createElement('div'); hostEl.id = CONFIG.HOST_ID;
    root = hostEl.attachShadow({ mode: 'open' });
    const fbBtns = FB_BTNS.map(([k, label]) => `<button class="fbtn${k === 'replay' ? ' rp' : ''}" data-fb="${k}">${label}</button>`).join('');
    root.innerHTML = `<style>${CSS}</style>
<div class="card" part="card" role="dialog" aria-label="heartlink 悬浮窗">
  <div class="head" data-f="head">
    <div class="tabs" role="tablist">
      <button role="tab" data-tab="hr"><span class="lb">健康设备</span><i class="d6" data-f="hrBadge"></i></button>
      <button role="tab" data-tab="toy"><span class="lb">玩具</span><i class="d6" data-f="toyBadge"></i></button>
      <button role="tab" data-tab="settings"><span class="lb">设置</span></button>
      <button class="x" data-close title="收起" aria-label="收起">${X_SVG}</button>
    </div>
    <div data-pane="toy">
      <button class="stop" data-act="halt" title="立即停止所有玩具（也可用 /hl-stop 或 Alt+Shift+S）">全部停止</button>
      <div class="banner" data-f="natBanner" role="status" hidden>
        <div class="bt">${WARN_SVG}<p>自带模式运行中，软件可能停不住，可拔出或按设备按钮</p><span class="rm">还剩<b><span data-f="natLeft">0</span><small>秒</small></b></span></div>
        <div class="sub" data-f="natSub"></div>
        <div class="prog"><i data-f="natProg"></i></div>
      </div>
      <div class="fb" data-f="fb" role="group" aria-label="调整正在动的动作">${fbBtns}</div>
    </div>
  </div>
  <div class="body" data-f="body">
  <ul class="help" data-f="help"></ul>

  <section data-pane="hr">
    <div data-f="hrEmpty">
      <div class="sec first" data-f="hrFirst">
        <p class="empty">还没连接设备。手环 / 心率带要先打开“心率广播”；用电脑或安卓上的 Chrome / Edge，iPhone 暂不支持。</p>
        <button class="btn primary" data-act="hr">连接设备</button>
      </div>
      <div data-f="hrAgain" hidden>
        <div class="sec first">
          <p class="last">上次连的是 <b data-f="lastName"></b></p>
          <button class="btn primary" data-act="hrLast" data-f="lastBtn">重新连接</button>
          <button class="textbtn other" data-act="hr">连别的设备</button>
        </div>
        <div class="sec"><p class="empty small2">手环 / 心率带要先打开“心率广播”；用电脑或安卓上的 Chrome / Edge，iPhone 暂不支持。</p></div>
      </div>
    </div>
    <div data-f="hrLive">
      <div class="sec first">
        <div class="status"><span class="sdot" data-f="hrDot"></span><b data-f="dev">--</b><span class="kind" data-f="kind" hidden></span><span class="st" data-f="hrState"></span><span class="sig" data-f="sigBars"><i></i><i></i><i></i></span><span class="batt" data-f="batt"></span></div>
      </div>
      <div class="sec">
        <div class="tl">
          <div data-f="plist"></div>
          <div class="node hol" data-f="pnote" hidden><div class="ghost">发出第一条消息后，这里按相位分段显示</div></div>
          <div class="node bare">
            <div class="base" data-f="baseRow">${DASH_SVG}<span data-f="base">平静心率</span><button class="link" data-act="basemenu" title="虚线是平静心率，胶囊上的百分比也是和它比">调整</button></div>
            <div class="basemenu" data-f="baseMenu" hidden><button data-act="rest">静坐 3 分钟记下</button><button data-act="clear">改回自动计算</button></div>
            <div class="rest" data-f="rest" role="timer" hidden><svg class="ring3" viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="19" class="bg"/><circle cx="22" cy="22" r="19" class="warm" data-f="ringWarm"/><circle cx="22" cy="22" r="19" class="rec" data-f="ringRec"/></svg>
              <div class="rt"><b>静坐记平静心率</b><span data-f="restHint">别说话、别打字，前 1 分钟不算</span></div><span class="rleft" data-f="restLeft">3:00</span></div>
            <div class="basemenu" data-f="restMenu" hidden><button data-act="restCancel">取消</button></div>
            <div class="small" data-f="hrvLine"><span data-f="hrv"></span><span data-f="last"></span></div>
          </div>
          <div class="node hol" style="--c:var(--gen)">
            <div class="th"><span class="m">下次发送时，模型会收到 ↗</span><button class="link" data-act="preview">看原文</button></div>
            <p class="sees" data-f="sees">--</p>
            <pre class="ptext" data-f="ptext" hidden></pre>
          </div>
          <div class="node" style="--c:var(--read)" data-f="sigBox">
            <div class="th"><span class="m">模型上一轮的判断 ↘</span></div>
            <p class="quote" data-f="sig">--</p>
          </div>
        </div>
      </div>
    </div>
    <div class="sec" data-f="hrFoldSec">
      <button class="fold" data-act="fold" aria-expanded="true">设置与连接${CV_SVG}</button>
      <div class="foldbody" data-f="hrFold">
        <div class="set"><span>模式</span><div class="segctl" role="group" aria-label="模式"><button data-set="mode:author">幕后</button><button data-set="mode:character">入戏</button><button data-set="mode:aware">知情</button></div></div>
        <div class="meaning" data-f="modeHint"></div>
        <div class="set" data-f="wearRow"><span>设备戴在</span><div class="segctl" role="group" aria-label="设备戴在"><button data-set="wear:wrist">手腕</button><button data-set="wear:chest">胸前</button></div></div>
        <div><button class="textbtn" data-act="disconnect" data-f="hrTools">断开设备</button></div>
      </div>
    </div>
  </section>

  <section data-pane="toy">
    <div class="sec" data-f="toyEmpty"><p class="empty">还没连玩具：打开“剧情联动”，再选一种连接方式。</p></div>
    <div class="sec" data-f="toyTiles">
      <div class="sh">上一条回复的动作<span class="r" data-f="now"></span></div>
      <div class="tl" data-f="lastact"></div>
      <p class="fbnote" data-f="fbnote" hidden></p>
    </div>
    <div class="sec" data-f="devSec" hidden>
      <div class="sh">设备</div>
      <div class="dcards" data-f="dcards"></div>
    </div>
    <div class="sec" data-f="play">
      <div class="sh">在对话里这样玩<button class="x" data-act="playClose" title="收起玩法说明" aria-label="收起玩法说明">${X_SVG}</button></div>
      <ol class="steps"><li>打开下面的<b>剧情联动</b>，选个节奏</li><li>照常聊天，角色会在回复里让设备动，回复写完就动</li><li>想改就直接对角色说<q>轻一点</q><q>像心跳那样</q><q>慢慢来</q>，或按上面的按钮</li></ol>
      <a class="pmore" href="${PLAY_URL}" target="_blank" rel="noopener">完整玩法 ↗</a>
    </div>
    <div class="sec" data-f="toyFoldSec">
      <button class="fold" data-act="fold" aria-expanded="true">设置与连接${CV_SVG}</button>
      <div class="foldbody" data-f="toyFold">
        <div class="set"><span>剧情联动</span><button class="switch" role="switch" data-act="vib" aria-label="剧情联动"></button></div>
        <div class="set"><span>节奏<button class="tune" data-act="pace">细调 ›</button></span><div class="segctl" role="group" aria-label="节奏"><button data-set="profile:slow-burn">慢热</button><button data-set="profile:steady">持久</button><button data-set="profile:frenzy">狂暴</button><button data-set="profile:max">极限</button></div></div>
        <button class="conn" data-act="devs" data-f="connRow"><span>连接设备</span><span class="r"><i class="d6"></i><span data-f="connTxt">已连接</span>${CV_SVG}</span></button>
        <div class="row2" data-f="connBtns">
          <button class="btn" data-act="toy" title="先装好 Intiface Central、点 Start Server 并在里面连上玩具">通过 Intiface<small class="rec" data-f="out">推荐</small></button>
          <button class="btn" data-act="direct" title="不装 Intiface：Chrome 用蓝牙直接连玩具。点开先选型号">浏览器直接连<small data-f="wasmState">不装软件</small></button>
          ${DEV_TOOLS ? '<button class="btn full" data-act="lab" title="打开设备模拟器小窗口（本机 device-lab，先运行 npm run sim）">设备模拟器</button>' : ''}
        </div>
        <div class="pick" data-f="pick" hidden></div>
        <div class="wait" data-f="wait" hidden></div>
        <div class="devs" data-f="devs"></div>
      </div>
    </div>
  </section>

  <section data-pane="settings" hidden></section>
  </div>

  <div class="foot">
    <button data-act="help" data-f="helpBtn">排查问题</button>
    <button data-act="play" data-f="playBtn" hidden>玩法</button>
    <button data-act="hide">隐藏悬浮窗</button>
    <span class="ver">v${VERSION}<span data-f="foot"></span></span>
  </div>
  <div class="scrim" data-f="scrim" hidden></div>
  <div class="sheet" data-f="sheet" role="dialog" aria-modal="true" hidden></div>
</div>
<div class="pill" part="pill" title="heartlink">
  <span class="seg" data-seg="hr">
    <span class="disc hr off">${HEART_SVG}</span>
    <span class="num" data-f="bpm">--</span>
    <svg class="spark" viewBox="0 0 36 14" aria-hidden="true"><line class="ref" x1="0" y1="8" x2="36" y2="8"/><path d=""/></svg>
    <span class="delta"></span>
    <span class="mode">未连接</span>
  </span>
  <span class="psep"></span>
  <span class="seg" data-seg="toy"><span class="disc toy">${WAVE_SVG}</span><span class="num" data-f="tn">--</span><span class="unit">路</span><span class="live" data-f="live" title="正在动"></span><span class="ring" data-f="ring" title="自带模式还在跑" hidden><svg viewBox="0 0 16 16" aria-hidden="true"><circle class="bg" cx="8" cy="8" r="6"/><circle class="fg" data-f="ringFg" cx="8" cy="8" r="6" stroke-dasharray="37.7" stroke-dashoffset="0"/></svg></span></span>
  <span class="seg" data-seg="none"><span class="disc hr off">${HEART_SVG}</span><span class="act" data-f="noneAct">连接设备</span></span>
</div>`;
    const q = (s) => root.querySelector(s);
    el = { heart: q('[data-seg="hr"] .disc'), poly: q('.spark path'), sparkRef: q('.spark .ref'), delta: q('.delta'), tag: q('[data-seg="hr"] .mode'), pill: q('.pill'), spark: q('.spark') };
    ['hrFirst', 'hrAgain', 'lastName', 'lastBtn', 'kind', 'sigBars', 'baseRow', 'rest', 'ringWarm', 'ringRec', 'restHint', 'restLeft', 'restMenu', 'wearRow', 'noneAct',
      'bpm', 'tn', 'head', 'fb', 'base', 'hrv', 'last', 'hrvLine', 'dev', 'out', 'sig', 'sigBox', 'foot', 'hrBadge', 'toyBadge', 'hrEmpty', 'hrLive', 'hrDot', 'hrState', 'batt', 'plist', 'pnote', 'baseMenu', 'modeHint', 'hrTools', 'hrFold', 'toyFold', 'hrFoldSec', 'toyFoldSec', 'toyEmpty', 'toyTiles', 'now', 'lastact', 'fbnote', 'devSec', 'dcards', 'wasmState', 'help', 'devs', 'helpBtn', 'sees', 'ptext', 'body', 'play', 'playBtn', 'connRow', 'connTxt', 'connBtns',
      'pick', 'wait', 'scrim', 'sheet', 'natBanner', 'natLeft', 'natSub', 'natProg', 'live', 'ring', 'ringFg']
      .forEach((f) => { el[f] = q(`[data-f="${f}"]`); });
    el.folds = [...root.querySelectorAll('[data-act="fold"]')];
    el.fbBtns = [...root.querySelectorAll('[data-fb]')];
    el.connDot = q('[data-f="connRow"] .d6');
    el.body.addEventListener('scroll', () => syncMore(), { passive: true });
    el.seg = { hr: q('[data-seg="hr"]'), toy: q('[data-seg="toy"]'), none: q('[data-seg="none"]') };
    el.segsep = q('.psep');
    el.tabs = [...root.querySelectorAll('[data-tab]')];
    el.panes = [...root.querySelectorAll('[data-pane]')];
    el.settingsPane = q('[data-pane="settings"]');
    el.sets = [...root.querySelectorAll('[data-set]')];
    el.vibSw = q('[data-act="vib"]');
    el.toyBtn = q('[data-act="toy"]'); el.wasmBtn = q('[data-act="direct"]');
    el.devs.addEventListener('change', (e) => {
      const id = e.target && e.target.getAttribute('data-id');
      if (!id) return;
      const off = new Set(state.haptics.off || []);
      if (e.target.checked) off.delete(id); else { off.add(id); actuators.stop(id); }
      setHaptics({ off: [...off] });
    });
    root.addEventListener('click', (event) => {
      const t = event.target;
      const tabBtn = t.closest && t.closest('[data-tab]');
      if (tabBtn) { state.badgeTab = tabBtn.getAttribute('data-tab'); return render(); }
      if (t.closest && t.closest('[data-close]')) { closePanel(); return; }
      if (sheet && t.closest && t.closest('[data-f="scrim"]')) { closeSheet(); return; }
      const fbBtn = t.closest && t.closest('[data-fb]');
      if (fbBtn) { quickFeedback(fbBtn.getAttribute('data-fb')); return; }
      const devBtn = t.closest && t.closest('[data-devtoggle]');
      if (devBtn) { const k = devBtn.getAttribute('data-devtoggle'); if (devOpen.has(k)) devOpen.delete(k); else devOpen.add(k); return render(); }
      const setBtn = t.closest && t.closest('[data-set]');
      if (setBtn) {
        const [key, val] = setBtn.getAttribute('data-set').split(':');
        if (key === 'mode') { if (getMode() !== val) setMode(val); return; }
        if (key === 'profile') {
          if (hapticsPolicy().profile !== val) {
            setHaptics({ profile: val });
            recordFeedback({ t: Date.now(), from: 'reader', type: 'pace', value: val });
            toast('info', `节奏：${PROFILE_ZH[val] || val}`);
          }
          return;
        }
        if (key === 'cap') { setHaptics({ maxIntensity: Number(val) }); return; }
        if (key === 'wear') { if (effectiveWear() !== val || !state.wearClass) setWear(val); return; }
        return;
      }
      const btn = t.closest && t.closest('[data-act]');
      if (btn) {
        const act = btn.getAttribute('data-act');
        if (act === 'help') { if (hostEl.classList.toggle('help')) scheduleGuideCheck(); return render(); }
        if (act === 'devs') { hostEl.classList.toggle('devs'); return render(); }
        if (act === 'lab') {
          const win = host.open(CONFIG.LAB_URL, 'tbc-device-lab', 'popup=yes,width=1180,height=820');
          if (!win) toast('warning', '浏览器拦下了弹窗：请允许本站弹窗，或直接打开 ' + CONFIG.LAB_URL);
          else toast('info', hTimers.kind === 'worker' ? '模拟器已在小窗口打开' : '模拟器已打开；这个浏览器切走酒馆页时强度帧会变慢');
          return;
        }
        // 浏览器直接连：先选型号。点型号的这一次点击就是用户手势，所以 pickDirect 里的 requestDevice 必须同步走到（中间不 await 别的）
        if (act === 'direct') { if (btn.disabled) return; pickOpen = !pickOpen; return render(); }
        if (act === 'pickBack') { pickOpen = false; return render(); }
        if (act === 'pick') {
          pickOpen = false;
          const id = btn.getAttribute('data-model');
          if (id === 'other') { toast('info', '正在加载直连组件，稍后弹出蓝牙设备选择'); startWasm(); } else pickDirect(id);
          return render();
        }
        if (act === 'retry' || act === 'reconnect') { const l = DIRECT.links.get(btn.getAttribute('data-link')); if (l) { l.tries = 0; connectLink(l); } return render(); }
        if (act === 'swap') { const l = DIRECT.links.get(btn.getAttribute('data-link')); if (l) DIRECT.links.delete(l.id); pickOpen = true; return render(); }
        if (act === 'restop') { const l = DIRECT.links.get(btn.getAttribute('data-link')); if (l && l.lab) { l.stopFailed = []; l.lab.stopAll().then((r) => { syncLinkState(l); if (r && !r.ok) reportStopFailed(l, r.failed); render(); }).catch(() => {}); } return render(); }
        if (act === 'dcut') { stopDirect(btn.getAttribute('data-link')); return; }
        // 微电流 / 停不下来的自带模式：逐台开启，开之前确认一次；关掉不用确认
        if (act === 'estim') { const l = DIRECT.links.get(btn.getAttribute('data-link')); if (l) { sheet = { kind: 'estim', link: l }; } return render(); }
        if (act === 'nat') {
          const l = DIRECT.links.get(btn.getAttribute('data-link'));
          const part = btn.getAttribute('data-part');
          if (!l) return;
          if (btn.getAttribute('aria-checked') === 'true') { setDirectUnstoppable(l.id, part, false); toast('info', '已关掉自带模式'); return render(); }
          if (!state.haptics.enabled) { toast('warning', '先打开“剧情联动”，再开启自带模式'); return render(); }
          sheet = { kind: 'nat', link: l, part };
          return render();
        }
        if (act === 'sheetNo') { closeSheet(); return; }
        if (act === 'sheetYes') {
          const s = sheet;
          if (s && s.kind === 'estim') { setDirectEstim(s.link.id, true); toast('warning', '微电流已开启：只有回复里点名才会动'); }
          else if (s && setDirectUnstoppable(s.link.id, s.part, true)) toast('warning', '已开启自带模式：运行中软件可能停不住');
          closeSheet();
          return;
        }
        if (act === 'vib') { const on = !state.haptics.enabled; setHaptics({ enabled: on }); if (on) askProfile(); toast(on ? 'warning' : 'info', on ? '剧情联动已打开' : '剧情联动已关闭，玩具已停'); return; }
        if (act === 'toy') { if (btn.disabled) return; const on = !state.haptics.intiface.enabled; setHaptics({ intiface: { enabled: on } }); toast('info', on ? '正在连接 Intiface（先在 Intiface Central 里点 Start Server）' : '已断开 Intiface'); return; }
        if (act === 'hide') { setBadgeHidden(true); toast('info', '悬浮窗已隐藏，可在魔杖菜单里恢复'); return; }
        if (act === 'halt') { haltAll('button'); return; }
        if (act === 'fold') { state.settingsFolded = !state.settingsFolded; saveSettings(); return render(); }
        if (act === 'togglePanelClose') { state.panelAutoClose = state.panelAutoClose === false; saveSettings(); return render(); }
        if (act === 'gateAdj') {
          const gate = btn.getAttribute('data-gate'); const dir = btn.getAttribute('data-dir') === '-1' ? -1 : 1;
          const g = gatesView();
          if (gate === 'idle') setGate('idleMs', Math.max(60000, Math.min(300000, g.idleMs + dir * 10000)));
          else setGate('tooLongMult', Math.max(2, Math.min(6, Math.round((g.mult + dir * 0.5) * 10) / 10)));
          return;
        }
        if (act === 'gateAuto') { setGate(btn.getAttribute('data-gate') === 'idle' ? 'idleMs' : 'tooLongMult', null); return; }
        if (act === 'clearRhythm') { clearRhythm(); return; }
        if (act === 'setTone') { setTone(btn.getAttribute('data-tone')); return; }
        if (act === 'toggleDraft') { state.v04 = !state.v04; saveSettings(); toast('info', state.v04 ? '已开新版数据格式（草案），下次发送起生效' : '已关新版数据格式'); return render(); }
        if (act === 'toggleIdle') { setIdleDetect(!state.idleDetect); return; }
        if (act === 'pace') { sheet = { kind: 'pace' }; return render(); }
        if (act === 'paceAdj') { setPace(btn.getAttribute('data-p'), btn.getAttribute('data-dir') === '-1' ? -1 : 1); return; }
        if (act === 'paceReset') { resetPace(); return; }
        if (act === 'playClose') { state.playSeen = true; state.playOpen = false; saveSettings(); return render(); }
        if (act === 'play') { state.playOpen = true; state.badgeTab = 'toy'; return render(); }
        if (act === 'preview') { el.ptext.hidden = !el.ptext.hidden; btn.textContent = el.ptext.hidden ? '看原文' : '收起'; if (!el.ptext.hidden) { el.ptext.textContent = compose().text; console.log(LOG, 'preview:\n' + el.ptext.textContent); } return; }
        if (act === 'basemenu') { el.baseMenu.hidden = !el.baseMenu.hidden; return; }
        if (act === 'baseline') { el.baseMenu.hidden = true; return setManualBaseline(); }
        if (act === 'rest') { el.baseMenu.hidden = true; startRestBaseline(); return; }
        if (act === 'restCancel') { cancelRestBaseline(); return; }
        if (act === 'hrLast') return connect({ name: state.deviceName });
        if (act === 'clear') { el.baseMenu.hidden = true; return clearManualBaseline(); }
        if (act === 'disconnect') { disconnect(); return render(); }
        if (act === 'hr') return connect();
        return;
      }
      if (!t.closest || !t.closest('.pill')) return;
      if (dragged) { dragged = false; return; }   // 刚拖完，不算点击
      // 点哪段开哪个标签页；什么都没连时打开健康设备页
      const seg = t.closest('[data-seg]');
      const which = seg && seg.getAttribute('data-seg');
      if (which === 'hr' || which === 'toy') {
        if (hostEl.classList.contains('open') && (state.badgeTab || 'hr') === which) closePanel();
        else { state.badgeTab = which; hostEl.classList.add('open'); }
      } else if (hostEl.classList.contains('open')) closePanel();
      else { state.badgeTab = 'hr'; hostEl.classList.add('open'); }
      render();
    });
    root.addEventListener('keydown', (e) => { if (sheet && e && e.key === 'Escape') { e.stopPropagation(); closeSheet(); } });
    doc.body.appendChild(hostEl);
    placeBadge();
    hostEl.classList.toggle('hidden', !!state.badgeHidden);
    syncMenuItem();
    // 拖动（0.18，手机上跟手）：按住移动超过 5 像素才算拖动；拖动中只改 transform、每帧最多一次、关掉毛玻璃；
    // 指针捕获在胶囊上（手指移出胶囊也跟着走）；松手时才换算成位置写进设置（离右边、离上边的像素）
    const pill = q('.pill');
    const drag = HeartlinkCore.dragController({
      schedule: (fn) => (typeof host.requestAnimationFrame === 'function' ? host.requestAnimationFrame(fn) : host.setTimeout(fn, 16)),
      cancel: (id) => { try { if (typeof host.cancelAnimationFrame === 'function') host.cancelAnimationFrame(id); else host.clearTimeout(id); } catch (_) {} },
      apply: (dx, dy) => { hostEl.style.transform = `translate3d(${Math.round(dx)}px,${Math.round(dy)}px,0)`; },
      start: () => { hostEl.classList.add('dragging'); if (hostEl.classList.contains('open')) closePanel(); },
      commit: (dx, dy) => {
        const s0 = dragStart || { right: 14, top: 0 };
        state.badgePos = { right: s0.right - dx, top: s0.top + dy };
        hostEl.style.removeProperty('transform');
        hostEl.classList.remove('dragging');
        placeBadge(); saveSettings();
        dragged = true; host.setTimeout(() => { dragged = false; }, 400);
      },
    });
    pill.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const r = hostEl.getBoundingClientRect();
      const W = host.innerWidth; const H = host.innerHeight;
      dragStart = { right: W - r.right, top: r.top };
      drag.down(e.clientX, e.clientY, { minX: -r.left, maxX: W - r.right, minY: -r.top, maxY: H - r.bottom });
      try { pill.setPointerCapture(e.pointerId); } catch (_) {}
    });
    pill.addEventListener('pointermove', (e) => { if (drag.move(e.clientX, e.clientY) && e.cancelable) e.preventDefault(); });
    const endDrag = (e) => {
      if (!drag.active()) return;
      if (!drag.up()) hostEl.classList.remove('dragging');
      try { if (e && e.pointerId != null && pill.hasPointerCapture && pill.hasPointerCapture(e.pointerId)) pill.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    pill.addEventListener('pointerup', endDrag);
    pill.addEventListener('pointercancel', endDrag);
    pill.addEventListener('lostpointercapture', endDrag);
    const onResize = () => { placeBadge(); render(); };
    host.addEventListener('resize', onResize);
    disposers.push(() => host.removeEventListener('resize', onResize));
    const closeMenu = (event) => { if (state.panelAutoClose === false) return; if (hostEl && !hostEl.contains(event.target)) closePanel(); };
    doc.addEventListener('click', closeMenu, true);
    disposers.push(() => doc.removeEventListener('click', closeMenu, true));
  }

  // ---------- 0.18：停止与快速反馈 ----------
  // 全部停止的唯一入口：按钮、斜杠命令 /hl-stop、快捷键 Alt+Shift+S 都走这里。先停再记录（§5.12）
  function haltAll(via) {
    const had = actuators.list().some((a) => a.busy) || actuators.pending() > 0;
    const cur = had ? activeAct() : null;
    // 正在跑停不下来的自带模式：停止帧照常发，但横幅不撤，改成“已发送停止”（§5.9-5）
    for (const l of DIRECT.links.values()) if ((l.native || []).length) l.natStopped = true;
    actuators.stop();
    directHaltAll();   // 设备层：每台直连设备把所有部件（包括没登记的）都停一遍
    if (had) recordFeedback(Object.assign({ t: Date.now(), from: 'reader', type: 'stop' }, cur && cur.ref ? { act: cur.ref } : {}));
    if (via === 'button') closePanel();
    toast('info', '已停止所有设备');
    return had;
  }
  function flashDone(kind) {
    state.fbDone = { kind, until: Date.now() + 2000 };
    host.setTimeout(() => render(), 2050);
    render();
  }
  // 弱一点 / 强一点：正在动的动作 ±20 个百分点（0–1 之间，调到 0 就停下这一个），同一回复里还没开始的也按这个量执行；
  // 跳过：停掉正在动的，排队的下一个在最小间隔允许时马上开始；再来一次：重放最后执行的动作（照常过安全闸门）
  function quickFeedback(kind) {
    if (!FB_BY[kind]) return false;
    if (kind === 'replay') { replayLast(); return true; }
    const now = Date.now();
    const cur = activeAct();
    const queued = actuators.queued();
    const src = cur ? cur.run.source : (queued[0] ? queued[0].source : null);
    if (!src) { render(); return false; }
    const entry = cur && cur.entry ? cur.entry : entryBySource(src);
    const replySrc = entry ? entry.src : src;   // 正在动的是重放时，排队的仍是原回复的
    if (kind === 'weaker' || kind === 'stronger') {
      const sign = kind === 'stronger' ? 1 : -1;
      actuators.adjust(sign * FB_STEP / 100, src);
      if (replySrc !== src) actuators.adjust(sign * FB_STEP / 100, replySrc);
      if (entry) {
        const idx = new Set(queued.filter((x) => x.source === replySrc).map((x) => x.act));
        if (cur && Number.isInteger(cur.i)) idx.add(cur.i);
        for (const i of idx) if (Number.isInteger(i) && i < entry.adj.length) { entry.adj[i] += sign * FB_STEP; entry.tagT[i] = now; }
      }
      recordFeedback(Object.assign({ t: now, from: 'reader', type: kind, value: FB_STEP }, cur && cur.ref ? { act: cur.ref } : {}));
    } else if (kind === 'skip') {
      const r = actuators.skip(src);
      if (replySrc !== src && !r.skipped.length) r.skipped.push(...actuators.skip(replySrc).skipped);
      let ref;
      for (const s of r.skipped) {
        const e = entryBySource(s.source); const i = actIndexOfSource(s.source, s.act);
        if (!e || !Number.isInteger(i)) continue;
        if (i < e.tagT.length) { e.skipIdx.add(i); e.tagT[i] = now; }
        if (!ref) ref = cur && cur.ref && cur.ref.key === e.key && cur.i === i ? cur.ref : { key: e.key, i };
      }
      recordFeedback(Object.assign({ t: now, from: 'reader', type: 'skip' }, ref ? { act: ref } : {}));
    }
    flashDone(kind);
    return true;
  }
  async function replayLast() {
    const last = actuators.lastOk();
    if (!last || !last.action || last.action.stop) return false;
    const e = entryBySource(last.source);
    const i = actIndexOfSource(last.source, last.act);
    const own = e && Number.isInteger(i);
    const t = Date.now();
    const r = await actuators.actuate(last.target, last.action, { source: own ? `replay:${e.key}#${i}` : 'replay', delta: actuators.delta(own ? e.src : last.source) });
    if (!r.ok) { toast('info', r.refused === 'rate-limit' ? REFUSE_ZH['rate-limit'] : `没法重放：${REFUSE_ZH[r.refused] || r.refused}`); render(); return false; }
    const pat = String(last.action.pattern || 'pulse');
    recordFeedback(Object.assign({ t, from: 'reader', type: 'replay', value: /^[a-z]+$/.test(pat) ? pat : 'pulse' }, own ? { act: { key: e.key, i } } : {}));
    flashDone('replay');
    return true;
  }
  // 不经过界面的停止（面板被别的插件盖住时也能停）：斜杠命令 /hl-stop（酒馆有 SlashCommandParser 时）与快捷键 Alt+Shift+S
  function registerStopControls() {
    const c = ctx();
    const run = () => { haltAll('slash'); return ''; };
    try {
      if (c && c.SlashCommandParser && typeof c.SlashCommandParser.addCommandObject === 'function' && c.SlashCommand && typeof c.SlashCommand.fromProps === 'function') {
        c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({ name: 'hl-stop', callback: run, returns: 'nothing', helpString: '立即停止 heartlink 连接的所有玩具（不经过模型）。快捷键 Alt+Shift+S。' }));
        state.stopCommand = 'parser';
      } else if (c && typeof c.registerSlashCommand === 'function') {
        c.registerSlashCommand('hl-stop', run, [], '立即停止 heartlink 连接的所有玩具', true, true);
        state.stopCommand = 'legacy';
      }
    } catch (err) { console.warn(LOG, '/hl-stop not registered:', err && err.message); }
    const onKey = (e) => {
      if (!e || !e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
      if (e.code !== 'KeyS' && String(e.key || '').toLowerCase() !== 's') return;
      try { if (e.preventDefault) e.preventDefault(); } catch (_) {}
      haltAll('shortcut');
    };
    // 挂在 window 的捕获阶段：比 document 捕获更早，输入框里有别的插件的快捷键（如玉子手机）也吞不掉它
    host.addEventListener('keydown', onKey, true);
    disposers.push(() => host.removeEventListener('keydown', onKey, true));
  }

  function closePanel() {
    if (!hostEl) return;
    const was = hostEl.classList.contains('open');
    hostEl.classList.remove('open', 'help', 'devs', 'sheet');
    sheet = null; pickOpen = false;
    state.badgeTab = null;
    if (was) render();
  }
  // 隐藏 / 显示悬浮窗；隐藏后在酒馆的魔杖菜单（#extensionsMenu）里放一个恢复入口
  function setBadgeHidden(on) {
    state.badgeHidden = !!on;
    if (hostEl) { hostEl.classList.toggle('hidden', state.badgeHidden); if (on) closePanel(); }
    saveSettings();
    syncMenuItem();
  }
  function syncMenuItem() {
    const menu = doc.getElementById('extensionsMenu');
    if (!menu) {
      // 魔杖菜单在酒馆启动时才建：等 APP_READY（晚到的监听者也会收到）
      const c = ctx();
      if (!state.menuWait && c && c.eventTypes && c.eventTypes.APP_READY) {
        state.menuWait = true;
        const fn = () => { if (!destroyed) syncMenuItem(); };
        c.eventSource.on(c.eventTypes.APP_READY, fn);
        disposers.push(() => { try { c.eventSource.removeListener(c.eventTypes.APP_READY, fn); } catch (_) {} });
      }
      return;
    }
    let item = doc.getElementById('heartlink-menu-item');
    if (!item) {
      item = doc.createElement('div');
      item.id = 'heartlink-menu-item';
      item.className = 'list-group-item flex-container flexGap5 interactable';
      item.tabIndex = 0;
      item.innerHTML = '<div class="fa-solid fa-heart-pulse extensionsMenuExtensionButton"></div><span></span>';
      item.addEventListener('click', () => setBadgeHidden(!state.badgeHidden));
      menu.appendChild(item);
      disposers.push(() => { try { item.remove(); } catch (_) {} });
    }
    item.querySelector('span').textContent = state.badgeHidden ? '显示 heartlink 悬浮窗' : '隐藏 heartlink 悬浮窗';
  }
  // 按记住的位置摆放悬浮窗，限制在视口内；靠近顶部时面板向下展开
  function placeBadge() {
    if (!hostEl) return;
    const p = state.badgePos;
    if (!p || !Number.isFinite(p.right) || !Number.isFinite(p.top)) { hostEl.style.removeProperty('top'); hostEl.style.removeProperty('right'); hostEl.classList.remove('below'); return; }
    const w = hostEl.offsetWidth || 120; const h = hostEl.offsetHeight || 36;
    const right = Math.min(Math.max(0, p.right), Math.max(0, host.innerWidth - w));
    const top = Math.min(Math.max(0, p.top), Math.max(0, host.innerHeight - h));
    hostEl.style.setProperty('right', `${Math.round(right)}px`);
    hostEl.style.setProperty('top', `${Math.round(top)}px`);
  }
  // 面板高度按可用空间算：上方放不下而下方更宽时向下展开，内容多了在面板里滚动
  // 窄屏（< 480）：面板占满宽度，放在酒馆顶栏下面；胶囊在下半屏时面板停在胶囊上方，在上半屏时放在胶囊下方
  function isNarrow() { return (Number(host.innerWidth) || 1024) < 480; }
  function topBarBottom() {
    for (const id of ['top-settings-holder', 'top-bar']) {
      try { const n = doc.getElementById(id); const b = n && n.getBoundingClientRect ? n.getBoundingClientRect().bottom : null; if (Number.isFinite(b) && b > 0) return b; } catch (_) {}
    }
    return 0;
  }
  function fitPanel() {
    const card = root && root.querySelector('.card');
    if (!card) return;
    const r = hostEl.getBoundingClientRect();
    const H = host.innerHeight;
    if (isNarrow()) {
      const bar = topBarBottom();
      const pillLow = r.top > H / 2;
      const top = Math.round((pillLow ? bar : Math.max(bar, r.bottom)) + 8);
      const bottom = pillLow ? r.top - 8 : H - 8;
      hostEl.classList.remove('below');
      card.style.top = `max(${top}px, calc(env(safe-area-inset-top, 0px) + 8px))`;
      card.style.maxHeight = `${Math.max(160, Math.floor(bottom - top))}px`;
      return;
    }
    card.style.removeProperty('top');
    const above = r.top - 16; const below = H - r.bottom - 16;
    const down = below > above;
    hostEl.classList.toggle('below', down);
    card.style.maxHeight = `${Math.max(180, Math.floor(down ? below : above) - 8)}px`;
  }
  // 中间区域还能往下滚时，底边淡出提示
  function syncMore() {
    const b = el.body; if (!b) return;
    b.classList.toggle('more', b.scrollHeight - b.scrollTop - b.clientHeight > 2);
  }
  // 深浅配色跟着酒馆正文颜色走：正文偏暗 = 浅色主题
  let toneKey = '';
  // WCAG 相对亮度（先线性化每个通道再加权），比简单加权更贴合人眼对深浅的判断
  const relLum = (r, g, b) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  // 颜色字符串 → [r, g, b, a]；认 #rgb / #rgba / #rrggbb / #rrggbbaa 与 rgb()/rgba()（酒馆主题变量两种写法都有）。认不出返回 null
  function parseColor(str) {
    const t = String(str || '').trim();
    const hx = t.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
    if (hx) {
      let h = hx[1];
      if (h.length <= 4) h = h.split('').map((x) => x + x).join('');
      const n = (i) => parseInt(h.slice(i, i + 2), 16);
      return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
    }
    const m = t.match(/^rgba?\(([^)]+)\)$/i);
    if (!m) return null;
    const v = m[1].split(/[\s,/]+/).filter(Boolean).map((x) => (x.endsWith('%') ? parseFloat(x) / 100 : parseFloat(x)));
    if (v.length < 3 || v.slice(0, 3).some((x) => !Number.isFinite(x))) return null;
    return [v[0], v[1], v[2], Number.isFinite(v[3]) ? v[3] : 1];
  }
  // 文字色 + 底色 → 该用浅面板吗：不透明底比较底和字谁亮；半透明或认不出的底只看文字够不够深
  function toneIsLight(textColor, bgColor) {
    const t = parseColor(textColor); const b = parseColor(bgColor);
    const textLum = t ? relLum(t[0], t[1], t[2]) : 1;
    if (b && b[3] >= 0.8) return relLum(b[0], b[1], b[2]) > textLum;
    return textLum < 0.18;
  }
  const TONE_FIXED = { dark: { bg: '#141517', ink: '#E9E7E3' }, light: { bg: '#F5F4F1', ink: '#1C1B19' } };
  // 配色自动判断（§3.7）：底色不透明时比底色和文字谁更亮；底色半透明（读不到背景图）时只看文字，阈值相对亮度 0.18。
  // 手动“深色 / 浅色”时改用 heartlink 自己的不透明配色，面板不再受主题影响。只在结果变化时才切，不每帧算。
  function syncTone() {
    try {
      if (state.tone === 'dark' || state.tone === 'light') {
        const k = 'fixed:' + state.tone;
        if (k === toneKey) return;
        toneKey = k;
        const f = TONE_FIXED[state.tone];
        hostEl.style.setProperty('--bg', f.bg); hostEl.style.setProperty('--ink', f.ink);
        hostEl.classList.toggle('light', state.tone === 'light');
        devAnim.colors = null; return;
      }
      hostEl.style.removeProperty('--bg'); hostEl.style.removeProperty('--ink');   // 跟随酒馆：交还主题变量
      const cs = host.getComputedStyle(hostEl);
      const c = cs.color;
      const bg = (cs.getPropertyValue('--bg') || '').trim() || cs.backgroundColor;
      const key = 'auto:' + c + '|' + bg;
      if (key === toneKey) return;
      toneKey = key;
      hostEl.classList.toggle('light', toneIsLight(c, bg));   // 十六进制底色以前被当成 rgb(5,4,1) 判成深色（0.21.1 修）
      devAnim.colors = null;   // 设备卡的画布颜色重新取
    } catch (_) {}
  }
  function setTone(v) {
    state.tone = (v === 'dark' || v === 'light') ? v : 'auto';
    toneKey = ''; saveSettings(); syncTone(); render(); emit('bio:state', getState());
  }

  // ---------- 更准的离开判断（Idle Detection，§3.5，可选、缺省关、只在支持的浏览器） ----------
  // 只在顶层安全上下文且浏览器有 IdleDetector 时才提供（Firefox / Safari 没有，整行不显示）。
  //   系统报活跃 → 补一个 activity（父页面收不到卡片小界面里的操作时，靠它避免误判离开）；
  //   系统报锁屏 → 记 hidden；系统报空闲不额外记，交给核心按“多久没操作”判 idle（阈值取 max(60s, 学到的 idle)）。
  const HAS_IDLE = (() => {
    try { return 'IdleDetector' in host && host.isSecureContext !== false && host.top === host.self; } catch (_) { return false; }
  })();
  let idleScreen = 'unlocked';
  function stopIdleDetector() {
    try { if (state.idleCtl) state.idleCtl.abort(); } catch (_) {}
    state.idleCtl = null;
  }
  // 已经拿到权限后真正启动探测器（不再弹授权）
  async function armIdle() {
    try {
      stopIdleDetector();
      const ctl = new AbortController(); state.idleCtl = ctl;
      const det = new host.IdleDetector();
      idleScreen = 'unlocked';
      det.addEventListener('change', () => {
        try {
          if (det.screenState !== idleScreen) { idleScreen = det.screenState; pushEvent(idleScreen === 'locked' ? 'hidden' : 'visible'); }
          if (det.userState === 'active') pushEvent('activity');
        } catch (_) {}
      });
      const threshold = Math.max(60000, (() => { const g = learnedGates().idle; return g.source === 'cal' ? g.ms : 60000; })());
      await det.start({ threshold, signal: ctl.signal });
      return true;
    } catch (err) { console.warn(LOG, 'idle detector arm failed', err); stopIdleDetector(); return false; }
  }
  async function startIdleDetector() {
    if (!HAS_IDLE) return false;
    try {
      const perm = await host.IdleDetector.requestPermission();   // 必须在用户手势里调（开关的那次点击）
      if (perm !== 'granted') return false;
      return armIdle();
    } catch (err) { console.warn(LOG, 'idle permission failed', err); return false; }
  }
  // 加载时若之前开过：权限还在就直接启动（不弹），权限没了就把开关关掉
  async function reArmIdle() {
    if (!HAS_IDLE || !state.idleDetect) return;
    try {
      const p = host.navigator && host.navigator.permissions ? await host.navigator.permissions.query({ name: 'idle-detection' }) : null;
      if (p && p.state === 'granted') { if (!(await armIdle())) state.idleDetect = false; }
      else state.idleDetect = false;
    } catch (_) { state.idleDetect = false; }
  }
  async function setIdleDetect(on) {
    if (on) {
      const ok = await startIdleDetector();
      state.idleDetect = ok;
      if (!ok) toast('info', '浏览器没有允许，可以在地址栏左边的网站设置里改');
      else toast('success', '已开更准的离开判断');
    } else { stopIdleDetector(); state.idleDetect = false; toast('info', '已关更准的离开判断'); }
    saveSettings(); render(); emit('bio:state', getState());
  }
  // 胶囊与面板里的走势线：虚线是平静心率，曲线相对它上下浮动（百分比也是和它比）
  function sparkPath(ref) {
    const now = Date.now();
    const pts = HeartlinkCore.series(state.samples, now - 60000, now).map((v) => (v === '·' ? null : v));
    const d = HeartlinkCore.sparkPath(pts, 36, 14, 6, ref);
    return { d, refY: HeartlinkCore.sparkPath.refY };
  }
  // 本轮相位（与注入块同一套边界，HeartlinkCore.buildTurn）：
  //   生成中 = 等首字 → 思维链 → 正文（非流式时只有一段）；读回复；打字；离开（页面切走 / 长时间没操作）不计
  //   界面上的相位名（2026-09-18 改）：生成中 / 读回复 / 打字；协议里的字段名仍是 gen / read / write
  //   颜色是 CSS 变量；生成中的三小段只用顶部线条的透明度区分
  const PH = {
    wait: { name: '等首字', c: 'gen', o: 0.55 }, think: { name: '思考', c: 'gen', o: 0.75 }, body: { name: '正文', c: 'gen', o: 1 }, gen: { name: '生成中', c: 'gen', o: 1 },
    read: { name: '读回复', c: 'read', o: 1 }, write: { name: '打字', c: 'write', o: 1 },
  };
  function phaseModel(now) {
    const t = HeartlinkCore.buildTurn(state.events, now);
    const groups = [];
    const genSubs = (send, s1, r1, end, live) => {
      const subs = [];
      if (s1 == null) return [{ k: 'gen', a: send, b: end, live }];
      subs.push({ k: 'wait', a: send, b: s1, live: false });
      if (r1 != null && r1 > s1) { subs.push({ k: 'think', a: s1, b: r1, live: false }); subs.push({ k: 'body', a: r1, b: end, live }); }
      else subs.push({ k: 'body', a: s1, b: end, live });
      return subs;
    };
    if (state.generating && state.lastSendT) {
      const after = state.events.filter((e) => e.t >= state.lastSendT);
      const s1 = (after.find((e) => e.type === 'stream_start') || {}).t;
      const r1 = (after.find((e) => e.type === 'reasoning_end') || {}).t;
      if (s1 == null) groups.push({ k: 'gen', a: state.lastSendT, b: now, live: true, subs: [{ k: 'wait', a: state.lastSendT, b: now, live: true }] });
      else groups.push({ k: 'gen', a: state.lastSendT, b: now, live: true, subs: genSubs(state.lastSendT, s1, r1, now, true) });
    } else {
      if (t.prevSend && t.replyEnd) groups.push({ k: 'gen', a: t.prevSend, b: t.replyEnd, live: false, subs: genSubs(t.prevSend, t.streamStart, t.reasoningEnd, t.replyEnd, false) });
      if (t.readStart != null) { const e = t.typingStart != null ? t.typingStart : now; groups.push({ k: 'read', a: t.readStart, b: e, live: t.typingStart == null, subs: [{ k: 'read', a: t.readStart, b: e, live: t.typingStart == null }] }); }
      if (t.typingStart != null) groups.push({ k: 'write', a: t.typingStart, b: now, live: true, subs: [{ k: 'write', a: t.typingStart, b: now, live: true }] });
    }
    return { groups: groups.filter((g) => g.b > g.a), away: t.away || [] };
  }
  // 时间线：每个相位一个节点；生成中、读回复各带一张小走势图，所有小图纵向比例相同、以底边为准对齐，平静心率虚线在同一高度
  // 第二轮：4px 圆角、相位底色变淡（--tint / --tint-live）、子段顶线之间留 2px 缝、上方留 6px 给峰值点、离开的斜线变淡
  // 健康页改版：没戴好的时段打琥珀斜线、曲线断开；峰值点只画块里判定过的那个（composed.summary.readPeak，审查 U7）
  const CHART_W = 276;
  function renderPhases(base, now, composed) {
    const { groups, away } = phaseModel(now);
    const offs = (state.offContact || []).filter(([a, b]) => b > a);
    const offIn = (g) => HeartlinkCore.overlapMs(offs, g.a, g.b);
    const t0 = groups.length ? groups[0].a : now;
    const pts = state.samples.filter((x) => x.t >= t0 && x.t <= now);
    const fmt = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : `${sec}s`);
    const secs = (a, b) => Math.round((b - a) / 1000);
    const awayIn = (g) => away.reduce((m, [a, b]) => m + Math.max(0, Math.min(b, g.b) - Math.max(a, g.a)), 0);
    // 每张图先分桶取均值
    const charts = groups.map((g) => {
      const h = g.k === 'gen' ? 28 : g.k === 'read' ? 40 : 0;
      if (!h) return null;
      const span = Math.max(1000, g.b - g.a); const N = Math.max(8, Math.min(Math.round(CHART_W / 4), Math.floor(span / 1000)));   // 约每秒一桶，最细 4px
      const buckets = Array.from({ length: N }, () => []);
      for (const x of pts) if (x.t >= g.a && x.t <= g.b) buckets[Math.min(N - 1, Math.floor((x.t - g.a) / span * N))].push(x.bpm);
      const vals = buckets.map((b) => (b.length ? b.reduce((m, v) => m + v, 0) / b.length : null));
      return { g, h, N, span, vals };
    });
    const all = charts.flatMap((c) => (c ? c.vals.filter((v) => v != null) : [])).concat(base ? [base.bpm] : []);
    const lo = all.length ? Math.min(...all) - 1 : 60;
    let k = 3;   // 每 bpm 多少像素：取能让每张图都放得下的最大值（上 6、下 4）
    for (const c of charts) {
      if (!c) continue;
      const hi = Math.max(lo + 6, ...c.vals.filter((v) => v != null), base ? base.bpm : lo);
      k = Math.min(k, (c.h - 10) / (hi - lo));
    }
    k = Math.max(0.3, k);
    const sm = composed && composed.summary;
    const rd = groups.find((g) => g.k === 'read');
    const peak = rd && sm && sm.readPeak != null && sm.readPeakT != null && sm.readStart === rd.a ? { t: sm.readPeakT, bpm: sm.readPeak } : null;
    const chartSvg = (c, idx) => {
      const { g, h, N, span, vals } = c;
      const W = CHART_W;
      const X = (tt) => Math.max(0, Math.min(W, (tt - g.a) / span * W));
      const Y = (v) => h - 4 - (v - lo) * k;
      let s = `<svg class="chart" viewBox="0 0 ${W} ${h}" height="${h}" preserveAspectRatio="none" aria-hidden="true"><defs>`
        + `<clipPath id="hlclip${idx}"><rect width="${W}" height="${h}" rx="4"/></clipPath>`
        + `<pattern id="hlaway${idx}" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" style="stroke:var(--muted);stroke-width:1;stroke-opacity:.35"/></pattern>`
        + `<pattern id="hlwear${idx}" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" style="stroke:var(--warn);stroke-width:1;stroke-opacity:.55"/></pattern></defs><g clip-path="url(#hlclip${idx})">`;
      g.subs.forEach((sb, i) => {
        const x = X(sb.a); const w = Math.max(1, X(sb.b) - x);
        const gl = i > 0 ? 1 : 0; const gr = i < g.subs.length - 1 ? 1 : 0;
        s += `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${h}" style="fill:var(--${PH[sb.k].c});fill-opacity:var(${sb.live ? '--tint-live' : '--tint'})"/>`;
        s += `<rect x="${(x + gl).toFixed(1)}" y="0" width="${Math.max(0, w - gl - gr).toFixed(1)}" height="2" style="fill:var(--${PH[sb.k].c});opacity:${PH[sb.k].o}"/>`;
      });
      for (const [a, b] of away) if (b > g.a && a < g.b) s += `<rect x="${X(a).toFixed(1)}" y="2" width="${Math.max(1, X(b) - X(a)).toFixed(1)}" height="${h - 2}" fill="url(#hlaway${idx})"><title>离开，不计入</title></rect>`;
      for (const [a, b] of offs) if (b > g.a && a < g.b) s += `<rect x="${X(a).toFixed(1)}" y="2" width="${Math.max(1, X(b) - X(a)).toFixed(1)}" height="${h - 2}" fill="url(#hlwear${idx})"><title>没戴好，不计入</title></rect>`;
      if (base) { const yb = Y(base.bpm).toFixed(1); s += `<line x1="0" x2="${W}" y1="${yb}" y2="${yb}" style="stroke:var(--faint);stroke-width:1;stroke-dasharray:2 3"/>`; }
      // 断开超过 3 桶才断线（偶尔漏一两个样本不算中断）
      // 没戴好的桶一律断开（哪怕只有一两秒）
      let d = ''; let gap = Infinity;
      vals.forEach((v, i) => {
        const b0 = g.a + i * span / N; const b1 = b0 + span / N;
        if (offs.some(([a, b]) => a < b1 && b > b0)) { gap = Infinity; return; }
        if (v == null) { gap++; return; }
        d += `${gap > 3 ? 'M' : 'L'}${((i + 0.5) * W / N).toFixed(1)},${Y(v).toFixed(1)}`; gap = 0;
      });
      if (d) s += `<path d="${d}" style="fill:none;stroke:var(--heart);stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke"/>`;
      if (g.k === 'read' && peak && d) s += `<circle cx="${X(peak.t).toFixed(1)}" cy="${Y(peak.bpm).toFixed(1)}" r="3" style="fill:var(--heart);stroke:var(--bg);stroke-width:2"/>`;
      return s + '</g></svg>';
    };
    const SHORT = { wait: '首字', think: '思考', body: '正文' };
    setHtml(el.plist, groups.map((g, i) => {
      const c = charts[i];
      const dur = fmt(secs(g.a, g.b));
      let arrow = ''; let right = ''; let sub = '';
      if (g.k === 'gen') {
        if (g.subs.length > 1) sub = g.subs.map((sb) => `${SHORT[sb.k]} ${fmt(secs(sb.a, sb.b))}`).join(' · ');
        else if (g.live && g.subs[0] && g.subs[0].k === 'wait') sub = '等首字';
      }
      if (g.k === 'read') {
        const fl = pts.filter((x) => x.t >= g.a && x.t <= g.b);
        const up = fl.length ? fl[fl.length - 1].bpm - fl[0].bpm : 0;
        arrow = up >= 3 ? ' ↑' : up <= -3 ? ' ↓' : '';
        if (peak) right = `<span class="r"><span class="m">峰值</span><span class="big">${peak.bpm}</span></span>`;
      }
      const aw = awayIn(g);
      if (aw >= 1000) sub += `${sub ? '&nbsp;·&nbsp;' : ''}<i class="hatch" title="离开的时段不计入"></i>离开 ${fmt(Math.round(aw / 1000))}`;
      const ow = offIn(g);
      if (ow >= 1000) sub += `${sub ? '&nbsp;·&nbsp;' : ''}<i class="hatch warn" title="没戴好的时段不计入"></i>没戴好 ${fmt(Math.round(ow / 1000))}，不计`;
      const liveTag = g.live ? `<span class="m${g.k === 'write' ? ' w' : ''}">进行中</span>` : '';
      return `<div class="node${g.live ? ' pulse' : ''}" style="--c:var(--${PH[g.k].c})"><div class="th"><b>${PH[g.k].name}</b><span class="d">${dur}${arrow}</span>${liveTag}${right}</div>`
        + (c ? chartSvg(c, i) : '') + (sub ? `<div class="tsub">${sub}</div>` : '') + '</div>';
    }).join(''));
    el.pnote.hidden = groups.length > 0;
    setHtml(el.base, baseText(base, now));
  }
  // 平静心率的来历与年龄（审查 U5）：自动 / 手动记下 · 2 小时前 / 静坐记下 · 刚刚；超过 24 小时或换了设备 → 琥珀色“建议重记”
  const agoZh = (ms) => { const m = Math.floor(Math.max(0, ms) / 60000); if (m < 1) return '刚刚'; if (m < 60) return `${m} 分钟前`; const h = Math.floor(m / 60); return h < 24 ? `${h} 小时前` : `${Math.floor(h / 24)} 天前`; };
  function baseText(base, now) {
    if (!base) return '平静心率稍后自动算出';
    const v = `平静心率 <b>${esc(base.bpm)}</b>`;
    if (base.method !== 'manual') return `${v} · 自动`;
    const how = base.how === 'rest' ? '静坐记下' : '手动记下';
    if (base.stale === 'age') return `${v} · <span class="old">${agoZh(now - base.at)}记的，建议重记</span>`;
    if (base.stale === 'device') return `${v} · <span class="old">在别的设备上记的，建议重记</span>`;
    if (base.stale === 'unknown') return `${v} · <span class="old">${how}，时间不明，建议重记</span>`;
    return `${v} · ${how} · ${agoZh(now - base.at)}`;
  }
  const fmtSec = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)} 分 ${sec % 60} 秒` : `${sec} 秒`);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  // 只有内容变了才写 innerHTML（整块重建会让里面的节点全部重排重绘）
  const htmlCache = new WeakMap();
  function setHtml(node, html) {
    if (htmlCache.get(node) === html) return;
    htmlCache.set(node, html);
    node.innerHTML = html;
  }
  // ---------- 0.19：浏览器直接连的界面（效果图 ../docs/driver-direct/mockup.html 十张图，2026-09-18 批准） ----------
  // 一个“浏览器直接连”按钮 → 选型号（有 TBC 驱动的走 startDirect，其它型号走 buttplug wasm）→ 浏览器自己的蓝牙窗口 →
  // 握手进度 → 设备卡（吮吸动效、微电流逐台开启、断线“可能仍在动”、停不下来的自带模式逐台开启与常驻横幅）。
  let pickOpen = false;        // 选型号面板开着
  let sheet = null;            // 确认面板：{ kind:'estim'|'nat', link, part }
  let natTimer = 0;            // 自带模式运行中：每秒重画一次（面板收起时胶囊的倒计时环也要走）
  const PART_OUT_ZH = { Vibrate: '振动', Oscillate: '往复', Rotate: '旋转', Constrict: '吮吸', HwPositionWithDuration: '抽动', Position: '位置', Estim: '微电流', Temperature: '加热', Spray: '喷', Led: '灯' };
  // 停不下来的自带模式：这一路的 { mode, maxDurationMs }，没有就是 null（现有两份正式驱动都没有，界面自然不出现）
  function unstoppableOf(p) {
    const all = Object.values((p && p.nativePatterns) || {}).concat((p && p.nativeModes) || []);
    return all.find((n) => n && n.stoppable === false && n.maxDurationMs > 0) || null;
  }
  function natRunning() {
    const out = [];
    for (const l of DIRECT.links.values()) {
      for (const n of l.native || []) {
        if (n.until <= Date.now()) continue;
        const p = l.driver.parts.find((x) => x.id === n.part);
        const u = unstoppableOf(p);
        out.push({ link: l, part: n.part, name: (p && p.name) || n.part, device: modelName(l.driver), until: n.until, max: (u && u.maxDurationMs) || 0, stopped: !!l.natStopped });
      }
    }
    return out;
  }
  // 横幅与胶囊倒计时环：renderNow 每秒画一次，面板开着时 devFrame 再按帧补平滑
  function paintNat(n, rm) {
    const left = Math.max(0, n.until - Date.now());
    const secs = String(Math.ceil(left / 1000));
    if (el.natLeft.textContent !== secs) el.natLeft.textContent = secs;
    const frac = n.max > 0 ? Math.max(0, Math.min(1, left / n.max)) : 0;
    const step = n.max > 0 ? Math.ceil(left / 1000) / Math.max(1, Math.round(n.max / 1000)) : 0;
    el.natProg.style.transform = `scaleX(${(rm ? step : frac).toFixed(4)})`;
    el.ringFg.setAttribute('stroke-dashoffset', (37.7 * (1 - frac)).toFixed(2));
    const sub = n.stopped ? '已发送停止，设备可能不理会，会一直运行到计时结束。' : `${n.device} · ${n.name}`;
    if (el.natSub.textContent !== sub) el.natSub.textContent = sub;
  }
  function syncNatTimer() {
    const on = natRunning().length > 0;
    if (on && !natTimer) natTimer = host.setInterval(() => render(), 1000);
    else if (!on && natTimer) { host.clearInterval(natTimer); natTimer = 0; }
  }
  // 选型号：驱动型号在前（旁边标“未核实”），最后一项“其它型号”走 buttplug wasm
  function pickerHtml() {
    const rows = directModels().map((m) => {
      const art = m.kind === 'driver' ? `<span class="art"><span class="fig">${shapeArt(m.shape)}</span></span>` : `<span class="gen">${WAVE_SVG}</span>`;
      const tag = m.kind === 'driver' && m.unverified ? '<span class="tag">未核实</span>' : '';
      const sub = m.kind === 'driver'
        ? (m.outputs || []).join(' · ') + (m.intiface === 'none' ? ' · 只能直接连' : m.intiface === 'official' ? ' · 也可以用 Intiface' : '')
        : '和 Intiface 支持的型号一样';
      return `<button class="model" data-act="pick" data-model="${esc(m.id)}">${art}<span class="mt"><b><span class="n">${esc(m.name)}</span>${tag}</b><span class="s">${esc(sub)}</span></span>${CV_SVG}</button>`;
    }).join('');
    return `<div class="ph"><button class="back" data-act="pickBack" aria-label="返回">${CV_SVG}</button>浏览器直接连 · 选型号</div>${rows}`
      + '<div class="ft">“未核实”：指令来自社区资料，还没有实测。第一次先用低强度试。</div>';
  }
  // 等浏览器自己的蓝牙窗口：告诉读者该选哪个名字、连不上先查什么
  function waitHtml(link) {
    const conn = DRV.connectionOf(link.driver);
    const li = [conn.exclusive ? `先在手机上彻底退出 ${esc(conn.officialApp)}` : null, '设备开机，离电脑近一些', '电脑或安卓上的 Chrome / Edge；iPhone 暂不支持'].filter(Boolean);
    return `<div class="wt"><span class="spin2" aria-hidden="true"></span>在浏览器的列表里选 <span class="nm">${esc(link.driver.namePrefix || link.driver.model)}</span></div>`
      + `<ul>${li.map((x) => `<li>${x}</li>`).join('')}</ul>`;
  }
  // 连不上：说清原因和下一步，由读者点重试（独占设备不自动抢占，§5.9-7）
  function linkErrorNote(link) {
    const conn = DRV.connectionOf(link.driver);
    const e = link.error || {};
    const again = `<button class="sbtn pri" data-act="retry" data-link="${esc(link.id)}">重试</button>`;
    const swap = `<button class="sbtn" data-act="swap" data-link="${esc(link.id)}">换型号</button>`;
    if (e.code === 'EXCLUSIVE_BUSY') return { text: `<b>这台设备同时只接受一个连接。</b>先在手机上彻底退出 ${esc(conn.officialApp)}，或关掉手机蓝牙，再点重试。`, acts: again + swap };
    if (e.code === 'HANDSHAKE_TIMEOUT') return { text: `<b>设备没回应：只收到 ${link.hs.got}/${link.hs.need} 条回应。</b>可能 ${esc(conn.officialApp)} 还连着，或者固件不同。`, acts: again + swap };
    if (e.code === 'OUT_OF_RANGE') return { text: '<b>找不到设备。</b>确认已开机、离电脑近一些。', acts: again + swap };
    return { text: `<b>这台设备的服务和 ${esc(link.driver.model)} 的驱动对不上。</b>可能不是这个型号。`, acts: swap };
  }
  // 一台直连设备 → 一张设备卡的数据；握手完成前也有卡片（显示进度），所以不从执行器列表算
  function directCardModel(link) {
    const unver = link.driver.status !== 'verified';
    const lost = link.phase === 'lost' || link.phase === 'reconnecting';
    const maybe = new Set(link.maybeRunning || []);
    const failed = new Set(link.stopFailed || []);
    const estimOn = directEstimOn(link);
    const now = Date.now();
    const natOn = new Set((link.native || []).filter((n) => n.until > now).map((n) => n.part));
    const feats = [];
    // 连接 / 握手 / 连不上的时候不列部件：那几步读者要看的是进度和下一步，不是档位
    const showParts = link.phase === 'ready' || lost;
    for (const p of showParts ? link.driver.parts : []) {
      if (p.expose === false) continue;
      const off = p.output === 'Estim' && !estimOn;
      const stopBad = failed.has(p.id) || (link.natStopped && natOn.has(p.id));
      const wasOn = !stopBad && maybe.has(p.id);
      feats.push({
        id: link.idOf[p.id] || `${link.id}:${p.id}`, link: link.id, part: p.id, label: p.name || p.id,
        output: p.output, risky: DRV.RISKY_OUTPUTS.includes(p.output), steps: p.steps, frames: true, off,
        kind: off ? 'none' : p.output === 'Constrict' ? 'suck' : vizKind(p.output),
        maybeTxt: stopBad ? '已发停止 · 可能仍在动' : null,
        maybe: wasOn ? Math.round((link.raw[p.id] || 0) * p.steps) : null,
        maybePct: Math.round((link.raw[p.id] || 0) * 100),
      });
    }
    // 自带模式一行：只有驱动声明了“停不下来”才出现；名字只在有多路时才带上部件
    const natParts = showParts ? link.driver.parts.filter((p) => p.expose !== false && !DRV.RISKY_OUTPUTS.includes(p.output) && unstoppableOf(p)) : [];
    const nat = natParts.map((p) => {
      const u = unstoppableOf(p);
      const on = directHas('allowUnstoppable', `${directKey(link)}:${p.id}`);
      const label = natParts.length > 1 ? `${p.name || p.id}的自带模式` : '自带模式';
      return `<div class="nat"><span>${esc(label)}<span class="ns">启动后最长运行 ${Math.round(u.maxDurationMs / 1000)} 秒</span></span>`
        + `<button class="switch" role="switch" aria-checked="${on}" aria-label="${esc(label)}" data-act="nat" data-link="${esc(link.id)}" data-part="${esc(p.id)}"></button></div>`;
    }).join('');
    let sub = `浏览器直接连${unver ? ' · 未核实' : ''}`;
    let subCls = ''; let cd = '';
    if (link.phase === 'picking') { sub = '正在选择设备'; cd = 'pending'; }
    else if (link.phase === 'connecting') { sub = '正在连接'; cd = 'pending'; }
    else if (link.phase === 'handshake') { sub = `正在准备设备 ${link.hs.got}/${link.hs.need}`; cd = 'pending'; }
    else if (link.phase === 'reconnecting') { sub = '重连中'; subCls = 'w'; cd = 'warn'; }
    else if (link.phase === 'lost') { sub = maybe.size ? '已断开 · 可能仍在动' : '已断开'; subCls = 'w'; cd = 'warn'; }
    else if (link.phase === 'error') { sub = '连不上'; subCls = 'e'; cd = 'err'; }
    let note = '';
    if (link.phase === 'error') { const n = linkErrorNote(link); note = `<div class="cnote e">${n.text}<div class="acts">${n.acts}</div></div>`; }
    else if (failed.size) note = `<div class="cnote e"><b>停止没有成功。</b>按设备按钮关掉，或取下设备。<div class="acts"><button class="sbtn pri" data-act="restop" data-link="${esc(link.id)}">再停一次</button></div></div>`;
    else if (lost) {
      const busy = link.phase === 'reconnecting';
      const txt = maybe.size ? '按设备按钮关掉，或取下设备。重连后会先全部停止。' : '';
      note = `<div class="cnote w">${txt}<div class="acts"><button class="sbtn pri" data-act="reconnect" data-link="${esc(link.id)}"${busy ? ' disabled' : ''}>${busy ? '重连中…' : '重新连接'}</button></div></div>`;
    }
    return {
      key: `dl:${link.id}`, name: modelName(link.driver), battery: link.battery,
      shape: link.driver.shape, sub, subCls, cd, note, nat, feats,
      lost, err: link.phase === 'error',
      hs: link.phase === 'handshake' && link.hs.need ? { got: link.hs.got, need: link.hs.need, text: `已发送初始化指令，等设备回应（最多 ${Math.round((DRV.handshakeOf(link.driver).timeoutMs || 2000) / 1000)} 秒）` } : null,
      sig: JSON.stringify([link.id, link.name, link.battery, sub, subCls, cd, note, nat, link.phase,
        feats.map((f) => [f.id, f.label, f.kind, f.steps, f.risky, f.off, f.maybe, f.maybeTxt, f.maybePct])]),
    };
  }
  // 确认面板：逐台开启微电流 / 停不下来的自带模式（警告原文照用，§5.9-5）
  // 门槛现状（设置页用）
  function gatesView() {
    const learned = learnedGates();
    const manual = state.gates || {};
    const manualKeys = Object.keys(manual);
    const turns = (state.rhythm || []).length;
    const idleMs = manual.idleMs != null ? manual.idleMs : (learned.idle.source === 'cal' ? learned.idle.ms : 60000);
    const idleSrc = manual.idleMs != null ? 'user' : learned.idle.source;
    const mult = manual.tooLongMult != null ? manual.tooLongMult : (learned.tooLong.source === 'cal' ? learned.tooLong.mult : 3);
    const tlSrc = manual.tooLongMult != null ? 'user' : learned.tooLong.source;
    const cps = HeartlinkCore.estimateCps({ history: history(), defaultCps: HeartlinkCore.CONFIG.READ_CPS_CJK });
    const status = manualKeys.length ? `${manualKeys.length} 项手动` : (turns < 5 ? '还在学' : '自动');
    return { learned, manual, manualKeys, turns, idleMs, idleSrc, mult, tlSrc, cps, status };
  }
  const gateSrcZh = (src, learned, which) => {
    if (src === 'user') return '手动';
    if (src === 'cal') { const n = which === 'idle' ? learned.idle.n : learned.tooLong.n; return `自动 · 学了 ${n} 轮`; }
    return '自动 · 先按常见值';
  };
  function toneBtns() {
    const cur = state.tone || 'auto';
    return [['auto', '跟随酒馆'], ['dark', '深色'], ['light', '浅色']]
      .map((o) => '<button data-act="setTone" data-tone="' + o[0] + '"' + (cur === o[0] ? ' aria-pressed="true"' : '') + '>' + o[1] + '</button>').join('');
  }
  function settingsPaneHtml() {
    const g = gatesView();
    const note = g.turns < 5
      ? `还在学你的习惯（${g.turns}/5 轮），先按常见值`
      : '按你最近的习惯；很长的回复会自动放宽';
    const row = (label, val, sub, gate, canAuto) => `<div class="mrow"><div class="ml"><span class="mk">${label}</span><span class="msub">${sub}</span></div>`
      + `<div class="mc"><span class="mv">${val}</span>`
      + `<button class="mstep" data-act="gateAdj" data-gate="${gate}" data-dir="-1" aria-label="调低">−</button>`
      + `<button class="mstep" data-act="gateAdj" data-gate="${gate}" data-dir="1" aria-label="调高">+</button>`
      + (canAuto ? `<button class="mauto" data-act="gateAuto" data-gate="${gate}">改回自动</button>` : '') + '</div></div>';
    return '<div class="mgroup"><div class="mgh">离开与阅读</div>'
      + `<p class="mnote">${note}</p>`
      + row('多久没动算离开', `${Math.round(g.idleMs / 1000)}s`, gateSrcZh(g.idleSrc, g.learned, 'idle'), 'idle', g.idleSrc === 'user')
      + row('读回复多久算太久', `预计阅读的 ${g.mult.toFixed(1)} 倍`, gateSrcZh(g.tlSrc, g.learned, 'toolong'), 'toolong', g.tlSrc === 'user')
      + `<div class="mrow"><div class="ml"><span class="mk">阅读速度</span><span class="msub">${g.cps.source === 'cal' ? '自动 · 按你的历史' : '自动 · 先按常见值'}</span></div><div class="mc"><span class="mv">${Math.round(g.cps.cps)} 字/秒</span></div></div>`
      + (HAS_IDLE ? ('<div class="mrow"><div class="ml"><span class="mk">更准的离开判断</span><span class="msub">'
        + (state.idleDetect ? '锁屏算离开；在卡片的小界面里点按不算离开' : '会弹授权；只看有没有人用、是否锁屏') + '</span></div>'
        + `<div class="mc"><button class="switch" role="switch" data-act="toggleIdle" aria-checked="${state.idleDetect ? 'true' : 'false'}" aria-label="更准的离开判断"></button></div></div>`) : '')
      + '</div>'
      + '<div class="mgroup"><div class="mgh">面板</div>'
      + `<div class="mrow"><div class="ml"><span class="mk">点面板外面时收起</span><span class="msub">关着时，用右上 × 或再点一下胶囊收起</span></div><div class="mc"><button class="switch" role="switch" data-act="togglePanelClose" aria-checked="${state.panelAutoClose !== false ? 'true' : 'false'}" aria-label="点面板外面时收起"></button></div></div>`
      + '</div>'
      + '<div class="mgroup"><div class="mgh">外观</div>'
      + '<div class="mrow"><div class="ml"><span class="mk">配色</span><span class="msub">半透明主题或花背景看不清时，手动选深 / 浅</span></div>'
      + '<div class="segctl mseg" role="group" aria-label="配色">' + toneBtns() + '</div></div>'
      + '</div>'
      + '<div class="mgroup"><div class="mgh">试用</div>'
      + '<div class="mrow"><div class="ml"><span class="mk">新版数据格式</span><span class="msub">多写玩具在动时的心率等；还是草案</span></div>'
      + `<button class="switch" role="switch" data-act="toggleDraft" aria-checked="${state.v04 ? 'true' : 'false'}" aria-label="新版数据格式"></button></div>`
      + '</div>'
      + '<div class="mgroup"><button class="textbtn" data-act="clearRhythm">清除学到的习惯</button>'
      + '<p class="mnote">学到的习惯只存在本机；模型只收到用到的数值。</p></div>';
  }
  function paceSheetHtml() {
    const p = paceProfile();
    const set = HeartlinkHaptics.resolveSettings(p, customFor(p));
    const def = HeartlinkHaptics.PROFILES[p];
    const changed = tunedSegment(set) !== '';
    const row = (label, val, param, sub) => '<div class="mrow"><div class="ml"><span class="mk">' + label + '</span>'
      + (sub ? '<span class="msub">' + sub + '</span>' : '') + '</div>'
      + '<div class="mc"><span class="mv">' + val + '</span>'
      + '<button class="mstep" data-act="paceAdj" data-p="' + param + '" data-dir="-1" aria-label="调低">−</button>'
      + '<button class="mstep" data-act="paceAdj" data-p="' + param + '" data-dir="1" aria-label="调高">+</button></div></div>';
    return '<div class="grab" aria-hidden="true"></div><h3>节奏细调 · ' + PROFILE_ZH[p] + '</h3>'
      + '<p class="who">只改“' + PROFILE_ZH[p] + '”这一档；不设强度上限（那是另一回事）</p>'
      + '<div class="mgroup">'
      + row('最低强度', Math.round(set.floor * 100) + '%', 'floor', '再弱的动作也不会低于这个强度')
      + row('一次动多久', (set.defaultMs.long / 1000).toFixed(1) + 's', 'dur')
      + row('两次之间最少隔', (set.minIntervalMs / 1000).toFixed(1) + 's', 'gap')
      + row('每条回复最多', set.maxPerReply + ' 个', 'perReply')
      + '</div>'
      + (changed ? '<div class="mgroup"><button class="textbtn" data-act="paceReset">改回默认</button></div>' : '');
  }
  function sheetHtml(s) {
    if (s.kind === 'pace') return paceSheetHtml();
    const link = s.link;
    const who = `${esc(modelName(link.driver))} · 只对这一台`;
    const cancel = '<button class="sbtn" data-act="sheetNo" data-autofocus>取消</button>';
    const ok = '<button class="sbtn danger" data-act="sheetYes">只对这台开启</button>';
    if (s.kind === 'nat') {
      const p = link.driver.parts.find((x) => x.id === s.part);
      const u = unstoppableOf(p);
      return '<div class="grab" aria-hidden="true"></div>'
        + `<h3>允许${esc(p.name || s.part)}的自带模式</h3><p class="who">${who}</p>`
        + `<div class="warnbox">${WARN_SVG}<p>自带模式运行中，软件可能停不住，可拔出或按设备按钮</p></div>`
        + `<ul class="facts"><li>自带模式启动后最长运行 <b>${Math.round(u.maxDurationMs / 1000)} 秒</b>。</li>`
        + '<li>期间“全部停止”照常发送，但设备可能不理会。</li><li>只对这台设备开启，换设备要重新开启。</li></ul>'
        + `<div class="acts">${cancel}${ok}</div>`;
    }
    const p = link.driver.parts.find((x) => x.output === 'Estim');
    return '<div class="grab" aria-hidden="true"></div>'
      + `<h3>开启${esc((p && p.name) || '微电流')}</h3><p class="who">${who}</p>`
      + `<div class="warnbox">${WARN_SVG}<p>这一路的指令来自社区资料，我们没有实测过</p></div>`
      + `<ul class="facts"><li>只有回复里点名${esc((p && p.name) || '微电流')}才会动。</li>`
      + `<li>每次最多 <b>${Math.round(((p && p.maxDurationMs) || 30000) / 1000)} 秒</b>，之后自动停，并至少歇同样长。</li>`
      + '<li>从最低强度开始试；只对这台设备开启。</li></ul>'
      + `<div class="acts">${cancel}${ok}</div>`;
  }
  function closeSheet() { sheet = null; hostEl.classList.remove('sheet'); render(); }
  function renderSheet() {
    const open = !!sheet && (sheet.kind === 'pace' || (sheet.link && DIRECT.links.has(sheet.link.id)));
    if (!open && sheet) sheet = null;
    hostEl.classList.toggle('sheet', open);
    el.scrim.hidden = !open; el.sheet.hidden = !open;
    if (!open) { htmlCache.delete(el.sheet); return; }
    el.sheet.setAttribute('aria-label', sheet.kind === 'pace' ? '节奏细调' : sheet.kind === 'nat' ? '允许自带模式' : '开启微电流');
    const html = sheetHtml(sheet);
    if (htmlCache.get(el.sheet) !== html) {
      setHtml(el.sheet, html);
      const f = el.sheet.querySelector('[data-autofocus]');
      if (f) try { f.focus(); } catch (_) {}
    }
  }
  // ---------- 0.18：玩具页“设备”卡（效果图 docs/toy-device-card-mockup，2026-09-18 批准） ----------
  // 每台设备一张，每一路一行：名字、跟着 heartlink 发出的帧动的小图、当前档位 N/总档。超过两台时每台收成一行。
  // 只放扩展确实知道的：设备名、每一路的输出类型与档数、发出的档位、正在动 / 安静、要点名的输出、加热倒计时（动作时长或全局上限）。
  // 电量与中文特性名 0.19 起有；浏览器直接连的设备另有连接状态（握手、断线、可能仍在动）。共用马达、保活、每一路的时限只在自有驱动里有，经 Intiface 拿不到，不显示。
  // 动画：整页一个 requestAnimationFrame 循环；只在面板打开、在玩具页、页面可见、这一节在可视范围内时跑；
  // DOM 只改 transform / opacity，波形画在 canvas 上；系统开了“减少动态效果”时画静止的档位条。
  const DEV_OUT_ZH = { Vibrate: '振动', Oscillate: '往复', Rotate: '旋转', Constrict: '收缩', HwPositionWithDuration: '抽动', Position: '位置', Estim: '电刺激', Temperature: '加热', Spray: '喷', Led: '灯' };
  const DEV_HN = 72;   // 波形历史点数（每 60ms 一个，约 4.3 秒）
  const devOpen = new Set();   // 收起模式下点开的设备
  const devAnim = { sig: '', feats: [], cards: [], running: false, raf: 0, last: 0, visible: true, io: null, ioTarget: null, colors: null, heatEnd: new Map() };
  const vizKind = (o) => (o === 'Temperature' ? 'heat' : o === 'Oscillate' || o === 'Position' || o === 'HwPositionWithDuration' ? 'osc' : o === 'Rotate' ? 'spin' : 'wave');
  function featureSteps(f) {
    if (!f || f.mode === 'position') return null;
    if (f.source === 'intiface') return Number.isFinite(f.max) && f.max >= 1 ? Math.round(f.max) : null;
    try {
      const o = f.handle && f.handle._feature && f.handle._feature.Output && f.handle._feature.Output[f.output];
      const r = o && (o.Value || o.StepRange || o.StepCount);
      const m = Array.isArray(r) ? r[1] : r;
      return Number.isFinite(m) && m >= 1 ? Math.round(m) : null;
    } catch (_) { return null; }
  }
  // buttplug 的 FeatureDescription 是厂家写的英文（常见几种），能对上就用中文，对不上按输出类型编号
  const FEAT_ZH = [
    [/clitoral|clit/i, '阴蒂'], [/insert|internal|shaft/i, '内部'], [/external/i, '外部'], [/suction|suck|air/i, '吮吸'],
    [/thrust|stroke|piston/i, '伸缩'], [/rotat|spin|bead/i, '转珠'], [/tap|pat|knock/i, '拍打'], [/heat|warm|temp/i, '加热'],
    [/main|primary/i, '主'], [/second|aux/i, '副'], [/left/i, '左'], [/right/i, '右'], [/tip|head/i, '头部'], [/base|handle/i, '底部'],
  ];
  const featZh = (text) => { const t = String(text || ''); for (const [re, zh] of FEAT_ZH) if (re.test(t)) return zh; return null; };

  function deviceModel(acts, offSet) {
    const devs = new Map();
    for (const a of acts) {
      if (offSet.has(a.id)) continue;
      const f = toyFeatures.get(a.id);
      const key = f ? `${f.source}:${f.deviceIndex}` : `x:${a.device || a.id}`;
      if (!devs.has(key)) devs.set(key, { key, name: String((f && f.name) || a.device || a.id), battery: f ? (toyBattery.get(`${f.source}:${f.deviceIndex}`) ?? null) : null, feats: [] });
      const output = f ? f.output : ((a.outputs || []).find((o) => o !== '*') || 'Vibrate');
      devs.get(key).feats.push({ id: a.id, output, kind: vizKind(output), steps: featureSteps(f), risky: HeartlinkHaptics.RISKY_OUTPUTS.includes(output), frames: !!f, zh: featZh(f && f.feature) });
    }
    for (const d of devs.values()) {
      const total = {}; const seen = {};
      d.feats.forEach((x) => { total[x.output] = (total[x.output] || 0) + 1; });
      const zhUsed = {};
      d.feats.forEach((x) => { if (x.zh) zhUsed[x.zh] = (zhUsed[x.zh] || 0) + 1; });
      d.feats.forEach((x) => {
        seen[x.output] = (seen[x.output] || 0) + 1;
        const zh = DEV_OUT_ZH[x.output] || x.output;
        // 厂家部件名唯一时直接用（例：吮吸、转珠）；重名或没有就按输出类型编号
        x.label = x.zh && zhUsed[x.zh] === 1 ? x.zh : total[x.output] > 1 ? `${zh} ${seen[x.output]}` : zh;
      });
    }
    return [...devs.values()];
  }
  function devRowHtml(f) {
    let idle = f.risky ? '<span class="say idle">点名才会动</span>' : '';
    if (f.maybeTxt) idle = `<span class="say"><span class="chip">${esc(f.maybeTxt)}</span></span>`;
    else if (f.maybe != null) idle = `<span class="say"><span class="chip">断开前 ${f.maybePct}%</span></span>`;
    else if (f.off) idle = '<span class="say idle">未开启</span>';
    let viz;
    if (f.kind === 'none') viz = `<div class="viz">${idle}</div>`;
    else if (f.kind === 'suck') viz = `<div class="viz suck"><span class="cup"></span><span class="core"></span><span class="flow"><i></i></span>${idle}</div>`;
    else if (f.kind === 'osc') viz = `<div class="viz osc"><span class="range"></span><span class="rail"></span><span class="kn tr"></span><span class="kn tr"></span><span class="kn"></span>${idle}</div>`;
    else if (f.kind === 'spin') viz = `<div class="viz spin"><svg class="wheel" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" style="stroke:var(--line2)"/><circle class="arc" cx="8" cy="8" r="6" stroke-dasharray="12 26" stroke-linecap="round" style="stroke:var(--faint)"/></svg><span class="track"><i></i></span>${idle}</div>`;
    else if (f.kind === 'heat') viz = `<div class="viz heatv"><span class="fill"></span><span class="shim"><i></i></span><span class="end"></span>${idle}<span class="say run">${CLOCK_SVG}<span data-cd></span></span></div>`;
    else viz = `<div class="viz"><canvas aria-hidden="true"></canvas>${idle}</div>`;
    const lv = f.off ? `<button class="mini" data-act="estim" data-link="${esc(f.link)}">开启</button>`
      : f.maybeTxt ? `<b>?</b>/${f.steps}`
        : f.maybe != null ? `<b>${f.maybe}</b>/${f.steps}`
          : f.steps === 1 ? '<b>关</b>' : f.steps ? `<b>0</b>/${f.steps}` : '<b>0</b>%';
    const cls = `fr${f.kind === 'heat' ? ' heat' : ''}${f.maybe != null || f.maybeTxt ? ' maybe' : ''}`;
    return `<div class="${cls}" data-id="${esc(f.id)}"><span class="fn" title="${esc(f.label)}">${f.risky ? RISK_SVG : ''}${esc(f.label)}</span>${viz}<span class="lv">${lv}</span></div>`;
  }
  function devCardHtml(d, collapsible, open) {
    const art = `<span class="art"><span class="warm"></span><span class="fig">${d.shape ? shapeArt(d.shape) : WAVE_SVG}</span><span class="cd${d.cd ? ' ' + d.cd : ''}"></span></span>`;
    const sub = d.sub ? `<small class="${d.subCls || ''}">${esc(d.sub)}</small>` : '';
    const name = `<span class="dname" title="${esc(d.name)}">${esc(d.name)}${sub}</span>`;
    const bat = Number.isFinite(d.battery) ? `<span class="dbat${d.battery <= 15 ? ' low' : ''}">${d.battery}%</span>` : '';
    const hd = collapsible
      ? `<button class="dh" data-devtoggle="${esc(d.key)}" aria-expanded="${open}">${art}${name}${bat}<span class="minis" aria-hidden="true">${d.feats.map(() => '<i></i>').join('')}</span>${CV_SVG}</button>`
      : `<div class="dh">${art}${name}${bat}</div>`;
    const hs = d.hs ? `<div class="hs"><div class="dots">${Array.from({ length: d.hs.need }, (_, i) => `<i class="${i < d.hs.got ? 'got' : i === d.hs.got ? 'now' : ''}"></i>`).join('')}</div><p>${esc(d.hs.text)}</p></div>` : '';
    const rows = d.feats.length || d.nat ? `<div class="rows"${open ? '' : ' hidden'}>${d.feats.map(devRowHtml).join('')}${d.nat || ''}</div>` : '';
    return `<div class="dc${d.lost ? ' lost' : ''}${d.err ? ' err' : ''}" data-dev="${esc(d.key)}">${hd}${hs}${rows}${d.note || ''}</div>`;
  }
  function renderDevices(acts, offSet) {
    // 直连设备排在前面，并且不再走下面按执行器分组的那一套（握手没完成时还没有执行器）
    const links = [...DIRECT.links.values()];
    const linked = new Set(links.flatMap((l) => l.ids || []));
    // 还停在浏览器的蓝牙窗口上（picking）时不出卡片：那一步上面已经有“在浏览器的列表里选 …”
    const list = links.filter((l) => l.phase !== 'picking').map(directCardModel).concat(deviceModel(acts.filter((a) => !linked.has(a.id)), offSet));
    el.devSec.hidden = !list.length;
    const many = list.length > 2;
    for (const k of [...devOpen]) if (!list.some((d) => d.key === k)) devOpen.delete(k);
    const sig = JSON.stringify([many, list.map((d) => [d.sig || [d.key, d.name, d.battery, d.feats.map((f) => [f.id, f.label, f.kind, f.steps, f.risky])], many && devOpen.has(d.key)])]);
    if (sig !== devAnim.sig) {
      devAnim.sig = sig;
      el.dcards.innerHTML = list.map((d) => devCardHtml(d, many, !many || devOpen.has(d.key))).join('');
      const old = new Map(devAnim.feats.map((st) => [st.f.id, st]));
      devAnim.cards = []; devAnim.feats = [];
      list.forEach((d) => {
        const card = el.dcards.querySelector(`[data-dev="${cssEsc(d.key)}"]`);
        if (!card) return;
        const cv = { el: card, d, fig: card.querySelector('.fig'), warm: card.querySelector('.warm'), minis: [...card.querySelectorAll('.minis i')], feats: [], seed: Math.random() * 10, moving: null, hot: null };
        d.feats.forEach((f) => {
          const row = card.querySelector(`.fr[data-id="${cssEsc(f.id)}"]`);
          const prev = old.get(f.id);
          const st = {
            f, el: row, card: cv, on: false, step: -1, disp: prev ? prev.disp : 0, amp: prev ? prev.amp : 0, phase: Math.random() * 6, acc: 0, shimP: 0,
            hist: prev ? prev.hist : new Float32Array(DEV_HN), hi: prev ? prev.hi : 0, trail: [],
            lvB: row && row.querySelector('.lv b'), canvas: row && row.querySelector('canvas'), say: row && row.querySelector('.say.idle'),
            kn: row ? [...row.querySelectorAll('.kn')] : [], rail: row && row.querySelector('.rail'), wheel: row && row.querySelector('.wheel'), arc: row && row.querySelector('.arc'),
            dots: row && row.querySelector('.track i'), fill: row && row.querySelector('.fill'), shim: row && row.querySelector('.shim i'), cd: row && row.querySelector('[data-cd]'), viz: row && row.querySelector('.viz'),
            core: row && row.querySelector('.core'), flowEl: row && row.querySelector('.flow i'),
            w: 0, h: 0, railW: 0, vizW: 0, sayText: null, cdText: null,
          };
          st.ctx = st.canvas && typeof st.canvas.getContext === 'function' ? st.canvas.getContext('2d') : null;
          cv.feats.push(st); devAnim.feats.push(st);
        });
        devAnim.cards.push(cv);
      });
      devMeasure();
    }
    devObserve();
    devKick();
  }
  const cssEsc = (v) => String(v).replace(/["\\]/g, '\\$&');
  // 尺寸只在重建、打开面板、窗口变化时量一次，动画循环里不读布局
  function devMeasure() {
    const dpr = Math.min(2, Number(host.devicePixelRatio) || 1);
    for (const st of devAnim.feats) {
      if (st.canvas) {
        const w = st.canvas.clientWidth; const h = st.canvas.clientHeight;
        if (w > 0 && h > 0) {
          st.w = w; st.h = h; st.dpr = dpr;
          if (st.canvas.width !== Math.round(w * dpr) || st.canvas.height !== Math.round(h * dpr)) { st.canvas.width = Math.round(w * dpr); st.canvas.height = Math.round(h * dpr); }
        }
      }
      if (st.rail) st.railW = st.rail.clientWidth || 0;
      if (st.viz) st.vizW = st.viz.clientWidth || 0;
    }
  }
  function devObserve() {
    if (typeof host.IntersectionObserver !== 'function' || !el.devSec || !el.body) { devAnim.visible = true; return; }
    if (devAnim.ioTarget === el.devSec) return;
    try {
      if (devAnim.io) devAnim.io.disconnect();
      devAnim.io = new host.IntersectionObserver((es) => { for (const e of es) devAnim.visible = e.isIntersecting; if (devAnim.visible) devKick(); }, { root: el.body });
      devAnim.io.observe(el.devSec);
      devAnim.ioTarget = el.devSec;
      disposers.push(() => { try { devAnim.io && devAnim.io.disconnect(); } catch (_) {} });
    } catch (_) { devAnim.visible = true; }
  }
  const reducedMotion = () => { try { return !!(host.matchMedia && host.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) { return false; } };
  function devShouldRun() {
    if (destroyed || !hostEl || !hostEl.classList.contains('open') || state.badgeTab !== 'toy' || doc.hidden) return false;
    if (natRunning().length) return true;   // 自带模式的横幅与倒计时环也靠这个循环走
    return devAnim.visible && devAnim.feats.length > 0 && !el.devSec.hidden;
  }
  function devKick() {
    if (devAnim.running || !devShouldRun() || typeof host.requestAnimationFrame !== 'function') return;
    devAnim.running = true;
    devAnim.last = 0;
    devMeasure();
    devAnim.raf = host.requestAnimationFrame(devFrame);
  }
  function devColors() {
    if (devAnim.colors) return devAnim.colors;
    try {
      const cs = host.getComputedStyle(hostEl);
      const v = (n, d) => String(cs.getPropertyValue(n) || '').trim() || d;
      devAnim.colors = { toy: v('--toy', '#D0668C'), toy2: v('--toy2', '#E58BAB'), line: v('--line2', '#3A3B40'), faint: v('--faint', '#6A6965') };
    } catch (_) { devAnim.colors = { toy: '#D0668C', toy2: '#E58BAB', line: '#3A3B40', faint: '#6A6965' }; }
    return devAnim.colors;
  }
  function devSetOn(st, on) {
    if (st.on === on) return;
    st.on = on;
    if (st.el) st.el.classList.toggle('on', on);
  }
  function devSay(st, text) {
    if (!st.say || st.sayText === text) return;
    st.sayText = text;
    st.say.innerHTML = text;
  }
  function devDrawWave(st, dt, rm, C) {
    const g = st.ctx; if (!g || !st.w) return;
    const w = st.w; const h = st.h; const mid = h / 2;
    g.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const xNow = w * 0.64; const amp = h / 2 - 3;
    if (rm) {   // 减少动态效果：静止的档位条
      if (st.say && !st.on) return;
      g.fillStyle = C.line; g.fillRect(6, mid - 1, w - 12, 2);
      if (st.disp > 0.01) { g.fillStyle = C.toy; g.beginPath(); if (g.roundRect) g.roundRect(6, mid - 3, (w - 12) * st.disp, 6, 3); else g.rect(6, mid - 3, (w - 12) * st.disp, 6); g.fill(); }
      return;
    }
    if (!st.say || st.on) { g.strokeStyle = C.line; g.lineWidth = 1; g.beginPath(); g.moveTo(0, mid); g.lineTo(w, mid); g.stroke(); }
    const n = DEV_HN;
    const val = (k) => (k === n - 1 ? st.disp : st.hist[(st.hi + k) % n]);
    let any = st.disp > 0.005;
    for (let k = 0; k < n && !any; k++) if (st.hist[k] > 0.005) any = true;
    if (any) {
      // 历史包络：左淡右浓
      const grad = g.createLinearGradient(0, 0, xNow, 0);
      grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(1, C.toy);
      g.globalAlpha = 0.26; g.fillStyle = grad; g.beginPath();
      for (let k = 0; k < n; k++) { const x = k / (n - 1) * xNow; const y = mid - val(k) * amp; if (k) g.lineTo(x, y); else g.moveTo(x, y); }
      for (let k = n - 1; k >= 0; k--) g.lineTo(k / (n - 1) * xNow, mid + val(k) * amp);
      g.closePath(); g.fill();
      g.globalAlpha = 0.7; g.strokeStyle = grad; g.lineWidth = 1; g.beginPath();
      for (let k = 0; k < n; k++) { const x = k / (n - 1) * xNow; const y = mid - val(k) * amp; if (k) g.lineTo(x, y); else g.moveTo(x, y); }
      g.stroke(); g.globalAlpha = 1;
    }
    if (st.disp < 0.01) return;
    // 载波：振幅跟档位走，频率随档位升高
    const lv = st.disp;
    st.phase += dt * (5 + 16 * lv);
    const cyc = (2.2 + 4.5 * lv) / Math.max(1, w - xNow);
    const path = () => {
      g.beginPath();
      for (let x = xNow; x <= w - 2; x += 1) {
        const e = Math.min(1, (x - xNow) / 10) * Math.max(0, Math.min(1, (w - 2 - x) / 14));
        const y = mid + Math.sin((x - xNow) * cyc * 2 * Math.PI - st.phase) * lv * amp * e;
        if (x === xNow) g.moveTo(x, y); else g.lineTo(x, y);
      }
    };
    g.lineJoin = 'round'; g.lineCap = 'round';
    path(); g.strokeStyle = C.toy; g.globalAlpha = 0.18; g.lineWidth = 4; g.stroke();
    path(); g.globalAlpha = 1; g.lineWidth = 1.5; g.strokeStyle = C.toy2; g.stroke();
    g.fillStyle = C.toy2; g.beginPath(); g.arc(xNow, mid, 1.8, 0, Math.PI * 2); g.fill();
  }
  function devFrame(ts) {
    devAnim.raf = 0;
    if (!devShouldRun()) { devAnim.running = false; return; }
    const dt = devAnim.last ? Math.min(0.05, Math.max(0, (ts - devAnim.last) / 1000)) : 0.016;
    devAnim.last = ts;
    const rm = reducedMotion();
    const t = ts / 1000;
    const C = devColors();
    const nowMs = Date.now();
    const runs = new Map(actuators.running().map((r) => [r.id, r]));
    let active = false;
    for (const st of devAnim.feats) {
      const f = st.f; const run = runs.get(f.id);
      let target;
      if (f.kind === 'heat') target = run ? 1 : 0;
      else target = f.frames ? (toyLevels.get(f.id) || 0) : (run ? run.intensity : 0);
      let step; let q;
      if (f.steps) { step = Math.round(target * f.steps); if (target > 0 && step === 0) step = 1; q = step / f.steps; }
      else { step = Math.round(target * 100); q = target; }
      // 断开后“可能仍在动”和没开启的那几路：画面停在断开前的样子，不跟着新的帧走
      if (f.maybe != null || f.maybeTxt || f.off) continue;
      st.disp += (q - st.disp) * (1 - Math.exp(-dt / (rm ? 0.001 : 0.12)));
      if (Math.abs(q - st.disp) < 0.002) st.disp = q;
      devSetOn(st, step > 0);
      if (step !== st.step) { st.step = step; if (st.lvB) st.lvB.textContent = f.steps === 1 ? (step ? '开' : '关') : String(step); }
      st.acc += dt;
      while (st.acc >= 0.06) { st.acc -= 0.06; st.hist[st.hi] = st.disp; st.hi = (st.hi + 1) % DEV_HN; }
      if (f.kind === 'wave') {
        devDrawWave(st, dt, rm, C);
        for (let k = 0; k < DEV_HN && !active; k++) if (st.hist[k] > 0.005) active = true;
      } else if (f.kind === 'suck' && st.core) {
        // 吮吸：吸口里的芯按档位收紧，点阵朝吸口流入；减少动态效果时只留收紧的静止比例
        const pull = rm ? st.disp : st.disp * (0.75 + 0.25 * Math.sin(t * (4 + 8 * st.disp)));
        st.core.style.transform = `scale(${(1 - 0.55 * pull).toFixed(3)})`;
        if (!rm && st.flowEl) {
          st.phase += dt * (8 + 60 * st.disp);
          st.flowEl.style.transform = `translate3d(${(-(st.phase % 10)).toFixed(2)}px,0,0)`;
          if (st.disp > 0.002) active = true;
        }
      } else if (f.kind === 'osc' && st.kn.length === 3) {
        const span = st.railW; let x;
        if (rm) x = span * st.disp;
        else {
          st.phase += dt * 2 * Math.PI * (0.35 + 1.9 * st.disp);
          st.amp += ((st.on ? 1 : 0) - st.amp) * (1 - Math.exp(-dt / 0.25));
          if (st.amp < 0.002) st.amp = 0;
          x = span * ((1 - Math.cos(st.phase)) / 2) * st.amp;   // 两端减速、中间最快
          if (st.amp > 0) active = true;
        }
        st.trail.unshift(x); if (st.trail.length > 8) st.trail.length = 8;
        const tr1 = st.trail[3] == null ? x : st.trail[3]; const tr2 = st.trail[7] == null ? x : st.trail[7];
        st.kn[2].style.transform = `translate3d(${x.toFixed(2)}px,0,0)`;
        st.kn[1].style.transform = `translate3d(${tr1.toFixed(2)}px,0,0)`;
        st.kn[0].style.transform = `translate3d(${tr2.toFixed(2)}px,0,0)`;
        st.kn[1].style.opacity = rm || !span ? '0' : (Math.min(0.35, Math.abs(x - tr1) / span * 3) * st.disp * 1.5).toFixed(3);
        st.kn[0].style.opacity = rm || !span ? '0' : (Math.min(0.2, Math.abs(x - tr2) / span * 2) * st.disp * 1.5).toFixed(3);
      } else if (f.kind === 'spin' && st.wheel) {
        if (!rm) {
          st.phase += dt * (40 + 620 * st.disp);
          st.wheel.style.transform = `rotate(${(st.phase % 360).toFixed(1)}deg)`;
          if (st.dots) st.dots.style.transform = `translate3d(${(-(st.phase / 10) % 8).toFixed(2)}px,0,0)`;
        }
        const col = st.on ? C.toy : C.faint;
        if (st.arc && st.arcCol !== col) { st.arcCol = col; st.arc.style.stroke = col; }
      } else if (f.kind === 'heat') {
        const remainMs = run ? Math.max(0, run.startedAt + run.spanMs - nowMs) : 0;
        const p = run && run.spanMs > 0 ? 1 - remainMs / run.spanMs : 0;
        if (st.fill) st.fill.style.transform = `scaleX(${p.toFixed(4)})`;
        if (run) st.heatRun = true;
        else if (st.heatRun) { st.heatRun = false; devAnim.heatEnd.set(f.id, nowMs); }
        if (!rm && st.on && st.shim) {
          st.shimP = (st.shimP + dt / 2.2) % 1;
          const vw = st.vizW * p;
          st.shim.style.transform = `translate3d(${(st.shimP * vw - 28).toFixed(1)}px,0,0)`;
          st.shim.style.opacity = Math.min(1, vw / 40).toFixed(2);
        }
        if (st.cd) {
          const txt = run ? `<b>${Math.ceil(remainMs / 1000)}</b>秒后自动停` : '';
          if (st.cdText !== txt) { st.cdText = txt; st.cd.innerHTML = txt; }
        }
        const ended = devAnim.heatEnd.get(f.id);
        if (ended && nowMs - ended < 4000) { devSay(st, `${CLOCK_SVG}到时已自动停`); active = true; }
        else devSay(st, '点名才会动');
      }
      if (st.on || st.disp > 0.002) active = true;
    }
    for (const cv of devAnim.cards) {
      let vib = 0; let osc = 0; let hot = 0; let anyOn = false;
      cv.feats.forEach((st, i) => {
        if (st.on) anyOn = true;
        if (st.f.kind === 'wave' || st.f.kind === 'suck') vib = Math.max(vib, st.disp);
        else if (st.f.kind === 'heat') hot = Math.max(hot, st.disp);
        else osc = Math.max(osc, st.disp);
        const m = cv.minis[i];
        if (m) {
          const jit = rm ? 0 : 0.12 * Math.sin(t * 9 + i * 2);
          m.style.transform = `scaleY(${(st.on ? Math.min(1, 0.3 + st.disp * 0.8 + jit) : 0.35).toFixed(3)})`;
          if (m.classList.contains('on') !== st.on) m.classList.toggle('on', st.on);
        }
      });
      if (cv.moving !== anyOn) { cv.moving = anyOn; if (!cv.el.classList.contains('lost')) cv.el.classList.toggle('moving', anyOn); }
      const isHot = hot > 0.01;
      if (cv.hot !== isHot) { cv.hot = isHot; cv.el.classList.toggle('hot', isHot); }
      if (cv.fig) {
        if (rm || (vib < 0.002 && osc < 0.002)) { if (cv.figMoved) { cv.fig.style.transform = ''; cv.figMoved = false; } }
        else {
          const tt = t + cv.seed;
          const jx = vib * (Math.sin(tt * 53) * 0.6 + Math.sin(tt * 31) * 0.4) * 1.1;
          const jy = vib * (Math.sin(tt * 47 + 1) * 0.5) * 0.8 + osc * Math.sin(tt * (3 + 5 * osc)) * 1.6;
          const rot = vib * Math.sin(tt * 41) * 2.2 + osc * Math.sin(tt * (3 + 5 * osc) + 0.6) * 3;
          cv.fig.style.transform = `translate3d(${jx.toFixed(2)}px,${jy.toFixed(2)}px,0) rotate(${rot.toFixed(2)}deg)`;
          cv.figMoved = true;
        }
      }
      if (cv.warm) {
        const o = hot ? (rm ? 0.7 : (0.55 + 0.25 * Math.sin(t * 1.6)) * hot).toFixed(3) : '0';
        if (cv.warmO !== o) { cv.warmO = o; cv.warm.style.opacity = o; }
      }
    }
    const nats = natRunning();
    if (nats.length) { paintNat(nats[0], rm); active = true; }
    // 都安静下来（波形历史也走完）就停，下一次发帧或打开面板时再启动
    if (active) devAnim.raf = host.requestAnimationFrame(devFrame);
    else devAnim.running = false;
  }
  // render() 只登记“要重画”：同一帧里的多次请求（样本、计时器、事件）合成一次；页面在后台时不画，回到前台补一次
  let beatBpm = null;
  const renderQ = HeartlinkCore.frameCoalescer({
    schedule: (fn) => (typeof host.requestAnimationFrame === 'function' ? host.requestAnimationFrame(fn) : host.setTimeout(fn, 16)),
    isHidden: () => !!doc.hidden,
    run: () => renderNow(),
  });
  function render() {
    if (!root || destroyed) return;
    renderQ.request();
  }
  // 三格信号：最近 60 秒收到的心率占应收的百分比（刚连上不满 60 秒时按连上以来算；没戴好、被丢掉的都不算收到）
  function signalCoverage(now) {
    const from = Math.max(now - 60000, state.connected && state.connectedAt ? state.connectedAt : 0);
    if (now - from < 3000) return null;
    const n = state.samples.filter((x) => x.t > from && x.t <= now).length;
    return HeartlinkCore.coverage(n, from, now, sourceMeta().cadenceMs || 1000);
  }
  // “下次发送时，模型会收到”：按块里真有的行说（读回复的时长 / 峰值、写了多久、和平静心率比）
  function seesParts(text) {
    const line = (name) => String(text || '').split('\n').find((l) => l.startsWith(name + ': ')) || '';
    const out = [];
    const rd = line('read');
    if (rd && !/^read: n\/a/.test(rd)) out.push(/ peak \d+/.test(rd) ? '读回复的时长和峰值' : '读回复的时长');
    const wr = line('write');
    if (wr && !/^write: n\/a/.test(wr)) out.push('这条写了多久');
    if (/^send: \d+ bpm \([+-]\d+%\)/.test(line('send'))) out.push('和平静心率比');
    return out;
  }
  // 静坐记平静心率：倒计时环（前 1 分钟灰，后 2 分钟青绿）、剩余时间、打字 / 切走后的一行提示
  const RING_C = 2 * Math.PI * 19;
  function renderRest(now) {
    const r = restState(now);
    const on = !!r;
    el.rest.hidden = !on; el.restMenu.hidden = !on; el.baseRow.hidden = on;
    if (on) el.baseMenu.hidden = true;
    if (!on) return;
    const third = RING_C / 3;
    el.ringWarm.setAttribute('stroke-dasharray', `${(third * r.warm).toFixed(1)} ${RING_C.toFixed(1)}`);
    el.ringRec.setAttribute('stroke-dasharray', `${(2 * third * r.rec).toFixed(1)} ${RING_C.toFixed(1)}`);
    el.ringRec.setAttribute('stroke-dashoffset', (-third).toFixed(1));
    el.ringRec.style.display = r.rec > 0 ? '' : 'none';
    el.ringWarm.style.display = r.warm > 0 ? '' : 'none';
    const left = Math.ceil(r.leftMs / 1000);
    el.restLeft.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    el.restHint.textContent = r.hint || REST_HINT;
    el.restHint.className = r.hint ? 'w' : '';
  }
  const onRenderVisibility = () => renderQ.onVisible();
  function renderNow() {
    if (!root || destroyed) return;
    const now = Date.now();
    const fresh = HeartlinkCore.isFresh(state.lastSample, now);
    const on = state.connected && fresh;
    const mode = getMode();
    const base = state.connected || state.waitingForDevice ? baselineInfo(now) : null;
    // 胶囊百分比用最近 5 秒的中位数（审查 U12），不跟着单个样本跳；变色门槛和峰值门槛用同一把尺子：
    //   max(5 bpm, 2 × noise)，没有 noise 时 10%；腕式设备另有绝对下限 max(6 bpm, 基线 × 7%)（v0.3 §1.4-3）
    const offWrist = state.connected && contactOffNow(now);
    const waiting = !state.connected && !!state.waitingForDevice;
    const live = on && !offWrist;
    const recent = live ? state.samples.filter((x) => x.t > now - 5000).map((x) => x.bpm).sort((a, b) => a - b) : [];
    const med = recent.length ? (recent.length % 2 ? recent[recent.length >> 1] : (recent[recent.length / 2 - 1] + recent[recent.length / 2]) / 2) : null;
    const d = live && base && med != null ? Math.round((med - base.bpm) / base.bpm * 100) : null;
    const upThr = base ? Math.max(Number.isFinite(base.noise) ? Math.max(5, 2 * base.noise) : Math.max(5, base.bpm * 0.1), HeartlinkCore.peakFloor(effectiveWear(), base.bpm)) : null;
    syncTone();
    // 胶囊：心率段
    el.heart.className = 'disc hr ' + (live ? 'on' : state.connected || waiting ? 'stale' : 'off');
    if (live) {   // 心率变化不到 5 bpm 不改动画时长：改 --beat 会让动画重新计时、样式重算
      const bpm = Math.max(state.lastSample.bpm, 30);
      if (beatBpm == null || Math.abs(bpm - beatBpm) >= 5) { beatBpm = bpm; hostEl.style.setProperty('--beat', (60 / bpm) + 's'); }
    }
    el.bpm.textContent = live ? String(state.lastSample.bpm) : '--';
    el.bpm.className = 'num' + (live ? '' : ' dim');
    el.bpm.style.display = (state.connected || waiting || (state.bridgeUp && fresh)) ? '' : 'none';   // 0.9：桥送来的心率也显示
    el.spark.style.display = live ? '' : 'none';
    if (live) {
      const sp = sparkPath(base ? base.bpm : null);
      el.poly.setAttribute('d', sp.d);
      el.sparkRef.style.display = sp.refY == null ? 'none' : '';
      if (sp.refY != null) { el.sparkRef.setAttribute('y1', sp.refY); el.sparkRef.setAttribute('y2', sp.refY); }
    }
    el.delta.textContent = d != null ? `${d >= 0 ? '+' : ''}${d}%` : '';
    el.delta.title = base ? `现在比平静心率 ${base.bpm} ${d >= 0 ? '高' : '低'} ${Math.abs(d || 0)}%` : '';
    el.delta.className = 'delta' + (d != null && upThr != null && med - base.bpm >= upThr ? ' up' : '');
    let tag; let tagWarn = false;
    if (state.newerVersion) tag = '请刷新';   // 别的页面已装更新版本，优先提示
    else if (waiting) { tag = '等设备回来'; tagWarn = true; }
    else if (offWrist) { tag = '没戴好'; tagWarn = true; }
    else if (state.reconnecting) tag = '重连中';
    else if (!state.connected) tag = state.bridgeUp && fresh ? '经本机桥' : '未连接';
    else if (!fresh) {
      tagWarn = true;
      // 连上后还没收到过数据（或只有连上之前的旧数据）：不显示“0 秒无数据”
      const lastT = state.lastSample ? state.lastSample.t : null;
      tag = lastT == null || (state.connectedAt && lastT < state.connectedAt) ? '等待数据' : `${Math.max(1, Math.round((now - lastT) / 1000))} 秒无数据`;
    } else tag = (MODE_ZH[mode] || '幕后') + (state.injectEnabled === false ? ' · 未发送' : modeSource() === 'card' ? ' · 卡片设定' : '');
    el.tag.textContent = tag;
    el.tag.className = 'mode' + (tagWarn ? ' warn' : state.connected && fresh && mode !== 'author' ? ' ch' : '');
    // 胶囊：玩具段；只显示正在用的
    const acts = actuators.list();
    const busy = acts.filter((a) => a.busy);
    const offSet = new Set(state.haptics.off || []);
    const nToy = acts.filter((a) => !offSet.has(a.id)).length;
    // 玩具段的小点：正在动是粉的；断线 / 停止失败后“可能仍在动”换成琥珀色；停不下来的自带模式换成倒计时环
    const nats = natRunning();
    // 断线 / 停止失败后仍可能在动的路数：设备已经撤了登记，但读者要知道还有几路没停下
    const maybeCount = [...DIRECT.links.values()].reduce((n, l) => n + new Set([...(l.maybeRunning || []), ...(l.stopFailed || [])]).size, 0);
    const maybeAny = maybeCount > 0;
    const hrActive = state.connected || state.reconnecting || !!state.waitingForDevice || (state.bridgeUp && fresh);
    const toyActive = nToy > 0 || busy.length > 0 || maybeAny;   // 只在真的连上玩具时显示（开了联动但没设备不算）
    el.seg.hr.hidden = !hrActive;
    el.seg.toy.hidden = !toyActive;
    el.seg.none.hidden = hrActive || toyActive;
    // 刷新后（页面丢了蓝牙连接）：胶囊写“重新连接”，面板里一键连回上次的设备（审查 U10）
    const again = !!(state.deviceName && bluetooth() && !hrActive);
    el.noneAct.textContent = again ? '重新连接' : '连接设备';
    el.segsep.hidden = !(hrActive && toyActive);
    el.tn.textContent = String(nToy || maybeCount);
    el.live.className = 'live' + (nats.length ? '' : maybeAny ? ' warn on' : busy.length ? ' on' : '');
    el.live.title = maybeAny ? '可能仍在动' : '正在动';
    el.ring.hidden = !nats.length;
    if (nats.length) paintNat(nats[0], reducedMotion());
    syncNatTimer();
    hostEl.classList.toggle('busy', busy.length > 0);
    const info = state.deviceInfo || {};
    el.pill.title = `heartlink ${VERSION}${state.connected ? ` · ${state.deviceName || ''}${info.firmware ? ' · fw ' + info.firmware : ''}` : ''} · 点一下打开，按住可拖动`;
    if (!hostEl.classList.contains('open')) return;   // 面板收起时不用算后面的
    fitPanel();
    // 面板：标签页（小圆点只表示状态，数字只在胶囊上）
    const tab = state.badgeTab === 'toy' ? 'toy' : state.badgeTab === 'settings' ? 'settings' : 'hr';   // 默认健康设备
    el.tabs.forEach((b) => b.setAttribute('aria-selected', String(b.getAttribute('data-tab') === tab)));
    el.panes.forEach((pn) => { pn.hidden = pn.getAttribute('data-pane') !== tab; });
    if (tab === 'settings') {   // 设置页内容由 JS 渲染（与 sheet 同一套 htmlCache diff）
      const html = settingsPaneHtml();
      if (htmlCache.get(el.settingsPane) !== html) setHtml(el.settingsPane, html);
    }
    el.head.className = 'head' + (tab === 'toy' ? ' pad' : '');
    el.hrBadge.hidden = !(state.connected || state.reconnecting || state.waitingForDevice);
    el.hrBadge.className = 'd6' + (state.connected ? '' : ' warn');
    el.hrBadge.title = state.connected ? '已连接' : state.reconnecting ? '重连中' : '等设备回来';
    el.toyBadge.hidden = !toyActive;
    el.toyBadge.className = 'd6' + (nats.length || maybeAny ? ' warn' : busy.length ? ' toy' : '');
    el.toyBadge.title = nats.length ? '自带模式运行中' : maybeAny ? '可能仍在动' : busy.length ? '正在动' : '已连接';
    el.natBanner.hidden = !nats.length;
    // 设置与连接：折叠状态记在设置里
    const folded = !!state.settingsFolded;
    el.folds.forEach((b) => b.setAttribute('aria-expanded', String(!folded)));
    el.hrFold.hidden = folded; el.toyFold.hidden = folded;
    el.hrFoldSec.className = 'sec' + (folded ? ' tight' : '');
    el.toyFoldSec.className = 'sec' + (folded ? ' tight' : '');
    // 健康设备页
    el.hrEmpty.hidden = hrActive;
    el.hrLive.hidden = !hrActive;
    el.hrFirst.hidden = again; el.hrAgain.hidden = !again;
    if (again) {
      const nm = state.deviceName.split(' ')[0];
      el.lastName.textContent = nm; el.lastBtn.textContent = `重新连接 ${nm}`;
    }
    el.hrTools.hidden = !state.connected && !state.reconnecting && !state.waitingForDevice;
    el.wearRow.hidden = !state.deviceName;
    if (hrActive) {
      el.dev.textContent = `${(state.deviceName || '心率设备').split(' ')[0]}${info.model ? ' ' + info.model : ''}`;
      el.hrDot.className = 'sdot ' + (live ? 'ok' : 'warn');
      // 设备行：戴在哪（U4）· 状态（没戴好 / 等设备回来 / 无数据）· 三格信号（U2）· 电量（≤15% 琥珀，U3）
      el.kind.hidden = !state.deviceName;
      el.kind.textContent = effectiveWear() === 'chest' ? '胸前' : '手腕';
      htmlCache.delete(el.hrState);
      el.hrState.textContent = live ? '' : tag; el.hrState.className = 'st' + (!live && tagWarn ? ' warn' : '');
      const cov = signalCoverage(now);
      const bars = cov == null ? 0 : cov >= 85 ? 3 : cov >= 50 ? 2 : cov > 0 ? 1 : 0;
      [...el.sigBars.children].forEach((b, i) => { b.className = i < bars ? 'on' : ''; });
      el.sigBars.title = `信号：最近一分钟收到 ${cov == null ? 0 : cov}% 的心率`;
      setHtml(el.batt, state.battery != null ? `电量 <em>${esc(state.battery)}%</em>` : '');
      el.batt.className = 'batt' + (state.battery != null && state.battery <= 15 ? ' low' : '');
      const c2 = compose(now, state.connected ? base : undefined);
      renderPhases(base, now, c2);
      renderRest(now);
      const hist = history(); const lastTurn = hist[hist.length - 1];
      const hrv = lastTurn ? lastTurn.hrv : base && base.hrv;
      const hrvHtml = hrv != null ? `心率变异 <em>${esc(hrv)}ms</em>` : lastTurn ? '心率变异信号不足' : '';
      // 前几轮峰值：块里判定过的峰值；没判出峰值的轮写“·”（审查 U9）
      const peaks = hist.slice(-5).map((x) => (x.readPeak != null ? x.readPeak : '·'));
      const lastHtml = peaks.length ? `${hrvHtml ? ' · ' : ''}前几轮峰值 ${peaks.map((v) => `<em>${esc(v)}</em>`).join(' · ')}` : '';
      setHtml(el.hrv, hrvHtml); setHtml(el.last, lastHtml);
      el.hrvLine.hidden = (!hrvHtml && !lastHtml) || !!state.rest;
      // 下次发送时模型会收到什么（审查 U8）：只说块里真有的东西，不重复上面的数字；后半句是模式的含义
      // F-100：这句是教读者“模型会看到什么”，聊过 3 轮后就不用再提示（整句收起，标题行的“看原文”与块本身保留）
      let seesMut = false;
      if (state.injectEnabled === false) { el.sees.hidden = false; setHtml(el.sees, '<i>注入已被脚本暂停，模型收不到这些数据；刷新页面即恢复。</i>'); }
      else {
        const said = seesParts(c2.text);
        if (said.length) { el.sees.hidden = hist.length >= 3; setHtml(el.sees, `${said.join('、')}；${MODE_HINT[mode] || MODE_HINT.author}。`); }
        else { seesMut = true; el.sees.hidden = false; setHtml(el.sees, '还没有数据，角色回复后开始记。'); }
        if (!el.ptext.hidden) el.ptext.textContent = c2.text;
      }
      el.sees.className = 'sees' + (seesMut ? ' mut' : '');
      const sig = lastSignal();
      el.sigBox.hidden = !sig;
      el.sig.textContent = sig ? `“${sig.text}”` : '';
    }
    el.modeHint.textContent = MODE_HINT[mode] || MODE_HINT.author;
    const wearNow = effectiveWear();
    // 玩具页
    const pol = hapticsPolicy();
    el.vibSw.setAttribute('aria-checked', String(!!state.haptics.enabled));
    el.sets.forEach((b) => {
      const [key, val] = b.getAttribute('data-set').split(':');
      const cur = key === 'mode' ? mode : key === 'profile' ? pol.profile : key === 'wear' ? wearNow : String(state.haptics.maxIntensity);
      b.setAttribute('aria-pressed', String(cur === val));
    });
    const intiOn = state.intifaceStatus === 'connected'; const wasmOn = WASM.status === 'connected';
    // 单连接方式：已知型号只支持直连时灰掉“通过 Intiface”，用户没打开过这个开关才灰（已经在用就别拦）
    const connGate = connMethodState();
    const intifaceGated = connGate.intiface.disabled && !state.haptics.intiface.enabled;
    el.out.textContent = intifaceGated ? connGate.intiface.reason : { idle: '推荐', connecting: '连接中…', connected: '已连接', disconnected: '重连中…', error: '连不上，Intiface 开了吗' }[state.intifaceStatus] || '推荐';
    el.out.className = intifaceGated ? '' : (state.intifaceStatus === 'idle' ? 'rec' : '');
    el.toyBtn.disabled = intifaceGated;
    el.toyBtn.setAttribute('aria-disabled', String(intifaceGated));
    el.toyBtn.className = 'btn' + (state.haptics.intiface.enabled ? ' on' : '');
    const directOn = [...DIRECT.links.values()].some((l) => l.phase === 'ready');
    el.wasmState.textContent = WASM.status === 'loading' ? '加载中…' : WASM.status === 'error' ? '连接失败' : wasmOn || directOn ? '已连接' : '不装软件';
    el.wasmBtn.disabled = connGate.direct.disabled;
    el.wasmBtn.setAttribute('aria-disabled', String(connGate.direct.disabled));
    el.wasmBtn.className = 'btn' + (WASM.client || DIRECT.links.size ? ' on' : '');
    // 选型号面板 / 等浏览器的蓝牙窗口；开着时占掉两个连接方式按钮的位置
    const picking = [...DIRECT.links.values()].find((l) => l.phase === 'picking');
    el.pick.hidden = !pickOpen || !!picking;
    if (!el.pick.hidden) setHtml(el.pick, pickerHtml()); else htmlCache.delete(el.pick);
    el.wait.hidden = !picking;
    if (picking) setHtml(el.wait, waitHtml(picking)); else htmlCache.delete(el.wait);
    renderSheet();
    // 连上以后，连接方式收成一行；点开看连接按钮与选择设备
    const anyDev = acts.length > 0 || DIRECT.links.size > 0;
    el.connRow.hidden = !anyDev;
    el.connBtns.hidden = !el.pick.hidden || !el.wait.hidden || (anyDev && !hostEl.classList.contains('devs'));
    const via = [intiOn && 'Intiface', (wasmOn || directOn) && '浏览器直接连'].filter(Boolean).join('、');
    const linking = [...DIRECT.links.values()].some((l) => l.phase === 'connecting' || l.phase === 'handshake');
    el.connTxt.textContent = picking ? '选择设备…' : linking ? '正在连接…' : via ? `${via} · 已连接` : acts.length ? '已连接' : '未连接';
    el.connDot.className = 'd6' + (picking || linking || !(via || acts.length) ? ' off' : maybeAny ? ' warn' : busy.length ? ' toy' : '');
    const hasToy = nToy > 0 || [...DIRECT.links.values()].some((l) => l.phase === 'ready' || l.phase === 'lost' || l.phase === 'reconnecting');
    el.toyEmpty.hidden = hasToy;
    el.toyTiles.hidden = !hasToy;
    // 反馈按钮：没有设备不显示；有动作在动或排队时四个都在，否则只剩“再来一次”（没有可重放的也不显示）
    const pendingN = actuators.pending();
    const moving = busy.length > 0 || pendingN > 0;
    const lastOk = actuators.lastOk();
    const canReplay = !!(lastOk && lastOk.action && !lastOk.action.stop && acts.length);
    el.fb.hidden = nToy === 0 || (!moving && !canReplay);
    el.fb.className = 'fb' + (moving ? '' : ' solo');
    el.fb.setAttribute('aria-label', moving ? '调整正在动的动作' : '重放最后一个动作');
    const doneKind = state.fbDone && state.fbDone.until > now ? state.fbDone.kind : null;
    el.fbBtns.forEach((b) => {
      const spec = FB_BY[b.getAttribute('data-fb')]; if (!spec) return;
      const done = doneKind === spec[0];
      setHtml(b, done ? `${CK_SVG}${spec[2]}` : spec[1]);
      b.className = 'fbtn' + (spec[0] === 'replay' ? ' rp' : '') + (done ? ' done' : '');
    });
    const entries = chatEntries();
    const lastEntry = entries[entries.length - 1];
    const SKIP_ZH = { disabled: '联动没开', 'replies-off': '回复联动关了', 'no-device': '没有设备', safeword: '安全词拦下' };
    const PAT_ZH = { pulse: '轻点', double: '两下', triple: '三下', long: '持续', heartbeat: '心跳', wave: '波浪' };
    // 玩法说明只在刚开始时显示：看到第一条带动作的回复（或点 ×）后收起，底部留“玩法”可再打开
    if (!state.playSeen && (state.replyLog || []).some((x) => x.acts && x.acts.length)) { state.playSeen = true; saveSettings(); }
    el.play.hidden = !!state.playSeen && !state.playOpen;
    el.playBtn.hidden = tab !== 'toy' || !el.play.hidden;
    let movingShown = false;
    let skipNums = [];
    const natIds = new Set(nats.map((n) => (n.link.idOf || {})[n.part] || (n.link.idWas || {})[n.part]).filter(Boolean));
    const maybeIds = new Set([...DIRECT.links.values()].flatMap((l) => [...(l.maybeRunning || [])].map((x) => (l.idOf || {})[x] || (l.idWas || {})[x])).filter(Boolean));
    const natStopped = nats.some((n) => n.stopped);
    if (!lastEntry) setHtml(el.lastact, '<div class="node hol"><div class="th"><span class="m">角色写出动作后会列在这里</span></div></div>');
    else {
      const out = lastEntry.outcome || [];
      const rows = lastEntry.acts.map((a, i) => {
        const r = lastEntry.results[i];
        const okN = r ? r.results.filter((x) => x.ok).length : 0;
        const st = out[i];
        const adj = (lastEntry.adj && lastEntry.adj[i]) || 0;
        const pct = Math.max(0, Math.min(100, Math.round((a.intensity ?? 0.5) * 100) + adj));
        const val = `${pct}%${a.durationMs ? ` · ${(a.durationMs / 1000).toFixed(a.durationMs % 1000 ? 1 : 0)}s` : ''}`;
        const pop = lastEntry.tagT && now - lastEntry.tagT[i] < 400 ? ' pop' : '';
        const skippedByReader = lastEntry.skipIdx && lastEntry.skipIdx.has(i);
        let cls = 'node'; let c = 'on'; let mid = ''; let right = '';
        if (lastEntry.skipped) { c = 'warn'; right = `<span class="r m no">${esc(SKIP_ZH[lastEntry.skipped] || lastEntry.skipped)}</span>`; }
        else if (skippedByReader) { cls += ' skipped hol'; c = 'faint'; mid = `<span class="ntag skip${pop}">已跳过</span>`; right = okN ? `<span class="r m">${okN} 路</span>` : ''; }
        else if (natIds.size && r && r.results.some((x) => natIds.has(x.id))) {
          // 停不下来的自带模式：写清楚它停不住，别让读者以为“全部停止”按下去就完了（§5.9-5）
          cls += ' pulse'; c = 'warn'; mid = `<span class="m nw">${natStopped ? '已发停止' : '停不住'}</span>`; right = `<span class="r m">${okN} 路</span>`; movingShown = true;
        } else if (maybeIds.size && r && r.results.some((x) => maybeIds.has(x.id))) {
          // 断线时被打断的动作：设备没说会自己停，所以不写“已停”
          c = 'warn'; right = '<span class="r m no">断开时中断</span>';
        } else if (st === 'running') { cls += ' pulse toy'; c = 'toy'; mid = '<span class="m t">正在动</span>'; right = `<span class="r m">${okN} 路</span>`; movingShown = true; }
        else if (st === 'refused' || (r && !okN)) { c = 'warn'; right = '<span class="r m no">没执行</span>'; }
        else if (st === 'cut') { if (!r) cls += ' hol'; c = 'faint'; right = '<span class="r m">已停</span>'; }
        else if (!r) { cls += ' hol'; c = 'faint'; right = '<span class="r m">排队中</span>'; }
        else right = `<span class="r m">${okN} 路</span>`;
        if (adj && !skippedByReader && !lastEntry.skipped) mid += `<span class="ntag up${pop}">${adj > 0 ? '强 +' : '弱 −'}${Math.abs(adj)}%</span>`;
        return `<div class="${cls}" style="--c:var(--${c})"><div class="th"><b>${esc(PAT_ZH[a.pattern] || a.pattern)}</b><span class="d">${val}</span>${mid}${right}</div></div>`;
      });
      setHtml(el.lastact, '<div class="node hol"><div class="th"><span class="m">回复写完</span></div></div>'
        + (rows.join('') || '<div class="node hol"><div class="th"><span class="m">这条回复没有动作</span></div></div>'));
      skipNums = [...new Set(fbState().log.filter((x) => x.type === 'skip' && x.act && x.act.key === lastEntry.key && Number.isInteger(x.act.i)).map((x) => x.act.i + 1))].sort((a, b) => a - b);
    }
    el.fbnote.hidden = !skipNums.length;
    el.fbnote.textContent = skipNums.length ? `下一轮会告诉模型：跳过了第 ${skipNums.join('、')} 个` : '';
    el.now.textContent = busy.length && !movingShown ? '正在动' : '';
    renderDevices(acts, offSet);
    if (hostEl.classList.contains('devs')) {
      const OUT_ZH = { Vibrate: '振动', Oscillate: '往复', Rotate: '旋转', Constrict: '收缩', HwPositionWithDuration: '抽动', Position: '位置', Estim: '电刺激', Temperature: '加热' };
      const groups = {};
      for (const a of acts) { const k = (toyFeatures.get(a.id) || {}).name || a.device || a.id; (groups[k] = groups[k] || []).push(a); }
      const cut = [...DIRECT.links.values()].map((l) => `<b>${esc(l.name || l.driver.model)}<button class="link" data-act="dcut" data-link="${esc(l.id)}">断开</button></b>`).join('');
      const html = (Object.keys(groups).length || cut
        ? cut + Object.entries(groups).map(([name, list]) => `<b>${esc(name)}</b>` + list.map((a) => `<label><input type="checkbox" data-id="${esc(a.id)}"${offSet.has(a.id) ? '' : ' checked'}>${esc(a.outputs.map((o) => OUT_ZH[o] || o).join('/'))} <i>${esc(a.id.split(':').slice(1, 3).join('-'))}</i></label>`).join('')).join('')
        : '还没有设备。先连接 Intiface 或蓝牙直连。');
      if (el.devs.getAttribute('data-h') !== html) { el.devs.innerHTML = html; el.devs.setAttribute('data-h', html); }
    }
    // 底部
    const probs = diagnostics().problems;
    setHtml(el.help, probs.length ? probs.map((p) => `<li class="${p.severity}"><b>${esc(p.message)}</b>${p.hint ? `<br>${esc(p.hint)}` : ''}</li>`).join('') : '<li>一切正常。</li>');
    const warn = probs.some((p) => p.severity !== 'info');
    setHtml(el.helpBtn, warn ? '排查问题<i class="d6 warn"></i>' : '排查问题');
    const nctx = Object.keys(contextSources()).length; const nk = Object.keys(kinds()).length;
    el.foot.textContent = '';
    el.foot.title = `${state.samples.length} 个样本${nk ? ` · 另有 ${nk} 类信号` : ''}${nctx ? ` · ${nctx} 条设备状态` : ''}`;
    syncMore();
  }

  // ---------- 公开接口与生命周期 ----------
  function getState() {
    const now = Date.now();
    return {
      version: VERSION, spec: HeartlinkCore.SPEC_VERSION, connected: state.connected, reconnecting: state.reconnecting,
      bpm: state.lastSample ? state.lastSample.bpm : null, fresh: HeartlinkCore.isFresh(state.lastSample, now),
      baseline: baselineInfo(), mode: getMode(), modeSource: modeSource(), cardHints: cardHints(), chatId: chatId(),
      events: state.events.length, samples: state.samples.length,
      device: state.deviceName, deviceInfo: state.deviceInfo, battery: state.battery, lastSignal: lastSignal(),
      wear: effectiveWear(), wearSource: state.wearClass ? 'user' : 'guess', contact: contactOffNow(now) ? false : (state.contactSupported ? true : null), waitingForDevice: !!state.waitingForDevice, rest: restState(now), compat: state.compat || null, tbc: tbcSources(), prior: state.prior || null, meta: sourceMeta(), bridge: { up: !!state.bridgeUp, info: state.bridgeInfo || null }, guideSync: state.guideSync || null,
    };
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    state.onSample = null; state.onConnection = null;
    try { actuators.stop(); } catch (_) {}
    try { stopIntiface(); } catch (_) {}
    try { stopIdleDetector(); } catch (_) {}
    try { stopWasm(); } catch (_) {}
    try { stopAdvertisementWatch(); } catch (_) {}
    try { if (natTimer) host.clearInterval(natTimer); } catch (_) {}
    try { cancelRestBaseline(true); stopSlowRetry(); } catch (_) {}
    while (disposers.length) { try { disposers.pop()(); } catch (_) {} }
    try { if (metaSave.pending) saveMetaNow(); } catch (_) {}   // 重新初始化前没等到宿主保存的聊天变量，交给宿主的防抖保存
    try { hostEl && hostEl.remove(); } catch (_) {}
    clearInject();
    try { if (host[CONFIG.RUNTIME_KEY] === api) delete host[CONFIG.RUNTIME_KEY]; } catch (_) {}
    try { if (host[CONFIG.PUBLIC_KEY] === api) delete host[CONFIG.PUBLIC_KEY]; } catch (_) {}
    if (FORM === 'extension') {
      // 被酒馆助手里的旧版脚本接管（旧脚本不认识扩展形态）：提示用户关掉它
      host.setTimeout(() => {
        const next = host[CONFIG.RUNTIME_KEY];
        if (next && next.form !== 'extension') toast('warning', '酒馆助手里还开着旧的 heartlink 脚本，它接管了心率与触觉。已安装 heartlink 扩展，请在酒馆助手的脚本库里关掉或删除 heartlink 脚本，然后刷新页面。');
      }, 0);
    }
  }
  const api = {
    version: VERSION, spec: HeartlinkCore.SPEC_VERSION, form: FORM, state, CONFIG,
    getState, preview: () => compose().text, getHistory: () => history().slice(), getLastSignal: lastSignal,
    // v0.4 草案开关：打开后块首行写 v="0.4"，相位行带 act 段、必要时带 clean 行，平静心率排除驱动秒
    setDraft: (on) => { state.v04 = !!on; saveSettings(); render(); return !!state.v04; },
    getDraft: () => !!state.v04,
    // 门槛自动学（设置方案 §3）：看现在学到 / 手动的门槛、手动改、改回自动、清除学到的习惯
    getGates: () => ({ learned: learnedGates(), manual: state.gates || null, turns: (state.rhythm || []).length }),
    setGate: (key, value) => setGate(key, value), clearRhythm,
    getTone: () => state.tone || 'auto', setTone: (v) => setTone(v),
    // 更准的离开判断（§3.5）：hasIdleDetection 说浏览器支不支持；setIdleDetect 要在用户手势里调
    hasIdleDetection: () => HAS_IDLE, getIdleDetect: () => !!state.idleDetect, setIdleDetect: (on) => setIdleDetect(on),
    getMode, setMode, toggleMode,
    connect, disconnect, setManualBaseline, clearManualBaseline,
    // 静坐 3 分钟记平静心率（前 1 分钟不算）；设备戴在哪（'wrist' | 'chest' | null = 自动猜）
    startRestBaseline, cancelRestBaseline: () => cancelRestBaseline(), getRest: () => restState(), setWear, getWear: effectiveWear,
    injectContext, exportCsv, setPrior, diagnostics, exportDiagnostics, setExposure, getExposure: () => ({ inject: state.injectEnabled !== false }), ensureGuideWorldbook,
    getHaptics, setHaptics, actuate: (target, action, opts) => actuators.actuate(target, action, opts), stopHaptics: () => { const r = actuators.stop(); directHaltAll(); return r; }, actOnReply,
    // 按驱动直连（界面另做）：选型号 → 连接 → 断开；微电流与停不下来的自带模式按设备开启
    directModels, directDevices: directState, connMethodState, toneIsLight,
    startDirect: (modelId, opts) => pickDirect(modelId, opts), stopDirect, setDirectEstim, setDirectUnstoppable,
    // 0.18：与玩具页按钮同一条路径（全部停止 / 弱一点 / 强一点 / 再来一次 / 跳过）；feedbackLine() 是下一次发送会写的 feedback 行
    haltAll: () => haltAll('api'), quickFeedback: (kind) => quickFeedback(kind), feedbackLine: () => safeFeedbackLine(),
    exportEvents: () => JSON.stringify({ version: VERSION, exportedAt: Date.now(), events: state.events, samples: state.samples }),
    destroy,
  };
  host[CONFIG.RUNTIME_KEY] = api;
  host[CONFIG.PUBLIC_KEY] = api;
  try { if (typeof initializeGlobal === 'function') initializeGlobal('heartlink', api); } catch (_) {}

  loadSettings();
  reArmIdle();   // 之前开过“更准的离开判断”且权限还在 → 直接启动（不弹）
  if (state.migrateInject) { state.migrateInject = false; saveSettings(); console.log(LOG, 'injectEnabled=false in saved settings migrated to true (no UI toggle any more)'); }
  if (!state.chatIdSeen) state.chatIdSeen = chatId();
  if (!history().length) loadHistoryFromChat();
  mountBadge();
  registerStopControls();
  state.onSample = () => render();
  state.onConnection = () => render();
  doc.addEventListener('visibilitychange', onRenderVisibility);
  disposers.push(() => doc.removeEventListener('visibilitychange', onRenderVisibility));
  const ticker = host.setInterval(() => { render(); emitDiagnosticsIfChanged(); checkStale(); }, CONFIG.RENDER_MS);
  disposers.push(() => host.clearInterval(ticker));
  bindTavernEvents();
  bindHostEvents();
  watchChatForActs();
  watchLatestReplyVisibility();
  scheduleHide();
  // 0.7.2：能力探测代替版本号（ST 无稳定的版本接口）；缺哪项就降级哪项，见 spec 仓库 docs/st-compat-audit-2026-09-zh.md §3
  state.compat = (() => {
    const c = ctx() || {}; const ev = c.eventTypes || {};
    return {
      streamEvent: !!ev.STREAM_TOKEN_RECEIVED,        // 1.12.6+；缺失 → 没有 ttft，只有 gen 总时长
      reasoningEvent: !!ev.STREAM_REASONING_DONE,     // 1.12.13+；缺失 → 只靠 </thinking> 正则切思维链
      filterParam: typeof c.setExtensionPrompt === 'function' && /filter/.test(Function.prototype.toString.call(c.setExtensionPrompt)),   // 1.13.2+（有默认参数，.length 不可靠，看源码文本）
      metadataSave: typeof c.saveMetadataDebounced === 'function',   // 1.13.3+
      tavernHelper: typeof injectPrompts === 'function',
    };
  })();
  { const missing = Object.keys(state.compat).filter((k) => !state.compat[k] && k !== 'tavernHelper'); if (missing.length) console.warn(LOG, 'host lacks:', missing.join(', '), '— running degraded'); }
  installTbc();
  watchWindows();
  {
    // 扩展加载时世界书列表可能还没就绪：等 APP_READY（酒馆对晚到的监听者会补发）
    const c = ctx(); const ready = c && c.eventTypes && c.eventTypes.APP_READY;
    if (FORM === 'extension' && ready) {
      let done = false;
      const fn = () => { if (done || destroyed) return; done = true; ensureGuideWorldbook(); };
      c.eventSource.on(ready, fn);
      disposers.push(() => { try { c.eventSource.removeListener(ready, fn); } catch (_) {} });
    } else ensureGuideWorldbook();
  }
  {
    // 兜底复查：有世界书事件时 10 分钟一次，没有时 2 分钟一次（原来 30 秒一次、每次整本拉取）
    const ev = (ctx() || {}).eventTypes || window.tavern_events || host.tavern_events || {};
    const every = ev.WORLDINFO_UPDATED || ev.WORLDINFO_SETTINGS_UPDATED ? CONFIG.GUIDE_CHECK_MS : 2 * 60 * 1000;
    const g = host.setInterval(() => { refreshGuideActive(); checkGuideConflict(); }, every);
    disposers.push(() => { host.clearInterval(g); if (guideCheckTimer) host.clearTimeout(guideCheckTimer); });
  }
  bridgeConnect(0);
  if (state.haptics.intiface.enabled) startIntiface();
  { const onHide = () => { try { actuators.stop(); } catch (_) {} try { directPanicStop(); } catch (_) {} }; host.addEventListener('pagehide', onHide); disposers.push(() => host.removeEventListener('pagehide', onHide)); }
  disposers.push(() => { try { state.bridge && state.bridge.close(); } catch (_) {} });
  render();
  adoptExistingConnection().then(() => { if (!state.connected) tryResume(); });

  try {
    const thv = typeof getTavernHelperVersion === 'function' ? getTavernHelperVersion() : 'n/a';
    const stv = typeof getTavernVersion === 'function' ? getTavernVersion() : 'n/a';
    console.log(LOG, `runtime ${VERSION} (bio-context ${HeartlinkCore.SPEC_VERSION}) ready; TavernHelper ${thv}; SillyTavern ${stv}; bluetooth ${bluetooth() ? 'yes' : 'no'}; restored connection ${state.connected}; events ${state.events.length}`);
  } catch (_) {}
})();
