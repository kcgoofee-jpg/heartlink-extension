// heartlink v0.14.0 — SillyTavern 扩展：心率注入 + 触觉输出（Tavern Bio-Context 参考实现）。构建产物。
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
//   composeContext() → 注入给模型的 <bio_context> 文本块（Tavern Bio-Context，见 docs/spec-draft.md）
const HeartlinkCore = (() => {
  'use strict';

  const CONFIG = {
    STALE_MS: 10000,            // 最后一个样本超过 10 秒视为数据不可用
    IDLE_MS: 60000,             // 60 秒无按键且页面前台 = 安静（自动基线用）
    PAUSE_MS: 5000,             // 打字中停顿超过 5 秒算一次停顿
    AWAY_MS: 60000,             // 60 秒连活动信号都没有算无操作
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
  function isFresh(sample, now) { return Boolean(sample) && now - sample.t <= CONFIG.STALE_MS; }
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
  // 安静段：从事件流推出“页面前台且 60 秒内无按键”的区间
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
    const busy = keys.map((t) => [t - 1000, t + CONFIG.IDLE_MS]).concat(hiddenSpans).sort((a, b) => a[0] - b[0]);
    const wins = [];
    let cur = from;
    for (const [a, b] of busy) { if (a > cur) wins.push([cur, Math.min(a, to)]); cur = Math.max(cur, b); if (cur >= to) break; }
    if (cur < to) wins.push([cur, to]);
    return wins.filter(([a, b]) => b - a >= 30000);
  }
  // 会话自动基线：安静段样本中位数；不足则全场 20 分位；再不足 null
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
    if (quiet.length >= CONFIG.QUIET_MIN_SAMPLES) return { bpm: percentile(quiet.map((s) => s.bpm), 0.5), method: 'quiet-median', n: quiet.length, hrv: hrvOver(quiet) };
    const all = inWin(samples, from, now);
    if (all.length >= CONFIG.QUIET_MIN_SAMPLES) return { bpm: percentile(all.map((s) => s.bpm), 0.2), method: 'p20', n: all.length, hrv: null };
    return null;
  }

  // ---------- 相位 ----------
  // 把事件流切成本轮相位。now = 本次发送时刻。
  function buildTurn(events, now) {
    const ev = events.filter((e) => e.t <= now).sort((a, b) => a.t - b.t);
    const last = (type, before = now) => { for (let i = ev.length - 1; i >= 0; i--) if (ev[i].type === type && ev[i].t <= before) return ev[i]; return null; };
    const replyEnd = last('reply_end');
    const swipe = last('swipe');
    const readStart = swipe && replyEnd && swipe.t > replyEnd.t ? swipe.t : (replyEnd ? replyEnd.t : null);
    const prevSend = replyEnd ? last('send', replyEnd.t - 1) : null;
    // 首字 / 思维链结束 必须落在“上一次发送 → 回复出完”之间，否则是更早一轮残留的事件，作废
    let streamStart = replyEnd ? last('stream_start', replyEnd.t) : null;
    if (streamStart && prevSend && streamStart.t < prevSend.t) streamStart = null;
    let reasoningEnd = replyEnd ? last('reasoning_end', replyEnd.t) : null;
    if (reasoningEnd && ((prevSend && reasoningEnd.t < prevSend.t) || (streamStart && reasoningEnd.t < streamStart.t))) reasoningEnd = null;
    const types = ev.filter((e) => e.type === 'type' && (readStart == null || e.t > readStart));
    const typingStart = types.length ? types[0].t : null;
    let pauses = 0, deletes = 0, lastLen = null;
    for (let i = 0; i < types.length; i++) {
      if (i > 0 && types[i].t - types[i - 1].t > CONFIG.PAUSE_MS) pauses++;
      if (lastLen != null && typeof types[i].len === 'number' && types[i].len < lastLen) deletes++;
      if (typeof types[i].len === 'number') lastLen = types[i].len;
    }
    // 离开：页面切走的区间；或连 activity（鼠标 / 滚动 / 按键）都没有的空档
    const away = [];
    const spanFrom = readStart != null ? readStart : (typingStart != null ? typingStart : now - CONFIG.SERIES_MAX_MS);
    const inSpan = ev.filter((e) => e.t >= spanFrom && e.t <= now);
    let hiddenAt = null;
    for (const e of inSpan) {
      if (e.type === 'hidden') hiddenAt = e.t;
      if (e.type === 'visible' && hiddenAt != null) { away.push([hiddenAt, e.t, 'hidden']); hiddenAt = null; }
    }
    if (hiddenAt != null) away.push([hiddenAt, now, 'hidden']);
    const acts = inSpan.filter((e) => ['type', 'visible', 'swipe', 'activity'].includes(e.type)).map((e) => e.t);
    const marks = [spanFrom, ...acts, now].sort((a, b) => a - b);
    for (let i = 1; i < marks.length; i++) {
      if (marks[i] - marks[i - 1] <= CONFIG.AWAY_MS) continue;
      const [a, b] = [marks[i - 1], marks[i]];
      if (away.some(([x, y]) => a >= x && b <= y)) continue;
      away.push([a, b, 'idle']);
    }
    away.sort((x, y) => x[0] - y[0]);
    return { now, prevSend: prevSend && prevSend.t, streamStart: streamStart && streamStart.t, reasoningEnd: reasoningEnd && reasoningEnd.t, replyEnd: replyEnd && replyEnd.t, readStart, typingStart, pauses, deletes, typeCount: types.length, lastLen, away };
  }

  // ---------- 每轮摘要（跨轮曲线与聊天变量用） ----------
  // 在发送时刻对刚结束的“读回复 / 写消息”做一份紧凑摘要；没有读回复相位时返回 null
  function turnSummary({ samples, turn, baseline }) {
    if (turn.readStart == null) return null;
    const readEnd = turn.typingStart != null ? turn.typingStart : turn.now;
    const rd = stats(inWin(samples, turn.readStart, readEnd));
    if (!rd) return null;
    const sendSt = stats(inWin(samples, turn.now - 5000, turn.now));
    return {
      t: turn.now, readStart: turn.readStart, readSec: Math.round((readEnd - turn.readStart) / 1000),
      readPeak: rd.max, readMean: rd.mean, readFirst: rd.first, readLast: rd.last,
      peakAtSec: Math.round((rd.peakAt - turn.readStart) / 1000),
      hrv: rd.rrDropout <= 0.5 ? hrvInWindow(samples, turn.readStart, readEnd) : null,
      writeSec: turn.typingStart != null ? Math.round((turn.now - turn.typingStart) / 1000) : 0,
      sendBpm: sendSt ? sendSt.last : null,
      baseline: baseline ? baseline.bpm : null,
      genSec: turn.prevSend && turn.replyEnd ? Math.round((turn.replyEnd - turn.prevSend) / 1000) : null,
      replyChars: turn.replyMeta ? turn.replyMeta.chars : null,
    };
  }
  const fmtMS = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  // 跨轮曲线一行（spec: history），最多 8 轮，按时间顺序，最右是上一轮
  function historyLine(history, maxTurns = 8) {
    const h = (history || []).slice(-maxTurns);
    if (!h.length) return null;
    const peaks = h.map((x) => x.readPeak).join(' ');
    const durs = h.map((x) => fmtMS(x.readSec)).join(' ');
    const hrvs = h.map((x) => (x.hrv != null ? x.hrv : '·')).join(' ');
    return `history: read-peaks ${peaks} | read-dur ${durs} | hrv ${hrvs}`;
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
  function estimateCps({ history, defaultCps }) {
    const rates = (history || [])
      .filter((h) => h && typeof h.replyChars === 'number' && h.replyChars > 0 && typeof h.readSec === 'number' && h.readSec >= 20 && h.readSec <= 600)
      .map((h) => h.replyChars / h.readSec);
    if (rates.length >= CONFIG.CPS_CAL_MIN_TURNS) return { cps: Math.round(median(rates) * 10) / 10, source: 'cal' };
    return { cps: defaultCps, source: 'est' };
  }

  // ---------- 注入块：Tavern Bio-Context（协议仓库 ../spec） ----------
  // 固定英文键，每行一个字段，缺失写 n/a；块内不解释。
  const SPEC_VERSION = '0.3';
  const SOURCE = 'heartlink';
  const MODES = ['author', 'character'];
  // TBC 0.3：块与变量里写新名字；内部仍用 author / character
  const WIRE_MODE = { author: 'backstage', character: 'in-story' };
  const SCOPE_LINE = 'scope: gen, read = previous reply; write, send = this message';
  const fmtS = (ms) => `${Math.round(ms / 1000)}s`;
  const fmtRange = (st) => (st ? `hr ${st.first}→${st.last} [${st.min}–${st.max}]` : 'hr n/a');
  const rrLoss = (st) => (st ? ` | rr-loss ${Math.round(st.rrDropout * 100)}%` : '');

  // { samples, events, activityLog?, now, mode: 'author'|'character', baselineOverride?: {bpm, hrv}, history?: [turnSummary...],
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
  function kindLine(kind, meta, turn, now) {
    const smp = (meta && meta.samples) || [];
    const unit = meta && meta.unit && meta.unit !== 'raw' ? ` ${meta.unit}` : '';
    const head = `${kind}(${(meta && meta.source) || 'unknown'}${meta && meta.cadence ? `, ${meta.cadence}` : ''}):`;
    const parts = [];
    if (turn.readStart) {
      const readEnd = turn.typingStart || now;
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
  // 执行器登记的状态行：单行、去掉多余空白、≤120 字符、不带标签
  function deviceLine(text) {
    if (text == null) return null;
    const t = String(text).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    return `device: ${t.length > 120 ? t.slice(0, 117) + '...' : t}`;
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
    if (!f.bluetooth && f.transport !== 'bridge' && f.transport !== 'bus') add('NO_BLUETOOTH', 'error', '这个浏览器不支持 Web Bluetooth', '用桌面版 Chrome 或 Edge 打开酒馆；手机和 Safari 暂不支持');
    if (f.bluetooth && f.secureContext === false) add('INSECURE_CONTEXT', 'error', '页面不是安全上下文，蓝牙不可用', '用 https 或 localhost 打开酒馆');
    const hasData = f.lastSampleAgeMs != null;
    if (!f.connected && !hasData) add('NO_DEVICE', 'warn', '没有连接健康设备', '点悬浮窗 → 健康设备 → 连接设备；手环 / 心率带要先打开心率广播');
    if ((f.connected || hasData) && f.lastSampleAgeMs != null && f.lastSampleAgeMs > 10000) add('DEVICE_SILENT', 'warn', `已经 ${Math.round(f.lastSampleAgeMs / 1000)} 秒没有收到心率`, '检查设备是否戴好、离电脑是否太远、是否还在广播');
    if (f.rr === false) add('NO_RR', 'info', '这台设备不提供心跳间隔，没有 HRV', '不影响使用；需要 HRV 请换胸带或 WHOOP 等支持 RR 的设备');
    if (f.cadenceMs != null && f.cadenceMs >= 30000) add('SPARSE_SOURCE', 'info', '数据很稀疏（30 秒以上一个）', '部分相位会写 n/a，属于正常');
    if (f.mode === 'author') add('MODE_BACKSTAGE', 'info', '当前是幕后模式，角色不会提起你的身体状态', '想让角色察觉，在健康设备页把模式切到入戏');
    if (f.injectEnabled === false) add('INJECTION_DISABLED', 'warn', '你关掉了“发给模型”，模型收不到设备数据', '在健康设备页打开“发给模型”');
    if (f.guideActive === false) add('GUIDE_INACTIVE', 'warn', '没有找到启用的读法世界书，模型可能看不懂设备数据', '刷新页面让 heartlink 自动安装；或在世界信息里把“heartlink·读法”设为全局');
    if (f.multiWindow) add('MULTI_WINDOW', 'warn', '这个聊天在别的窗口也开着，会互相覆盖', '只保留一个窗口');
    if (f.hostOk === false) add('HOST_UNSUPPORTED', 'error', '酒馆缺少注入所需的接口', '升级酒馆到 1.13 以上');
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
      injection: { enabled: f.injectEnabled !== false, last_at: f.lastInjectAt ?? null, last_trigger: f.lastTrigger ?? null, background_skipped: f.backgroundSkipped ?? 0 },
      interpretation: { guide_active: f.guideActive ?? null },
      problems,
    };
  }

  // TBC v0.3 §1.2 卡片声明：data.extensions.tbc = { mode_hint, perceiver }
  // 实现内部仍用 author / character 两档；device-aware 暂按 character 处理
  function normalizeMode(v) {
    const m = String(v == null ? '' : v).trim().toLowerCase();
    if (m === 'author' || m === 'backstage') return 'author';
    if (m === 'character' || m === 'in-story' || m === 'device-aware') return 'character';
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
  function headerAttrs(meta) {
    const a = [];
    if (!meta) return '';
    if (meta.device) a.push(`device="${String(meta.device).replace(/"/g, '')}"`);
    if (meta.transport) a.push(`transport="${meta.transport}"`);
    if (meta.cadence) a.push(`cadence="${meta.cadence}"`);
    if (typeof meta.rr === 'boolean') a.push(`rr="${meta.rr ? 'yes' : 'no'}"`);
    if (meta.trigger) a.push(`trigger="${meta.trigger}"`);
    if (meta.perceiver && meta.perceiver.length) a.push(`perceiver="${meta.perceiver.map((x) => String(x).replace(/["<>]/g, '')).join('、')}"`);
    return a.length ? ' ' + a.join(' ') : '';
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
    return `prior(${prior.source || 'api'}, ${prior.date || 'n/a'}): ${parts.join(' | ')}`;
  }
  // env：房间温湿度，只写最近值，不进相位统计
  function envLine(kinds, now) {
    if (!kinds) return null;
    const t = kinds.room_temperature, h = kinds.humidity;
    const last = (k) => (k && k.samples && k.samples.length ? k.samples[k.samples.length - 1] : null);
    const lt = last(t), lh = last(h);
    const fresh = (x) => x && now - x.t <= 10 * 60 * 1000;
    if (!fresh(lt) && !fresh(lh)) return null;
    const src = (t && t.source) || (h && h.source) || 'unknown';
    const cad = (t && t.cadence) || (h && h.cadence);
    const parts = [];
    if (fresh(lt)) parts.push(`${fmtVal(lt.value)}°C`);
    if (fresh(lh)) parts.push(`${fmtVal(lh.value)}% rh`);
    return `env(${src}${cad ? `, ${cad}` : ''}): ${parts.join(' ')}`;
  }
  const ENV_KINDS = new Set(['room_temperature', 'humidity']);

  function composeContext({ samples, events, activityLog, now, mode, baselineOverride, history, replyMeta, cpsOverride, kinds, deviceLines, extraLines, meta, prior }) {
    let readPos = null;
    const cadenceMs = meta && meta.cadenceMs ? meta.cadenceMs : null;
    const turn = buildTurn(events, now);
    if (replyMeta) turn.replyMeta = replyMeta;
    const base = baselineOverride ? { bpm: baselineOverride.bpm, hrv: baselineOverride.hrv || null, method: 'manual', n: 0 } : sessionBaseline(samples, activityLog || events, now);
    const m = MODES.includes(mode) ? mode : 'author';
    const L = [`<bio_context v="${SPEC_VERSION}" mode="${WIRE_MODE[m]}" source="${SOURCE}"${headerAttrs(meta)}>`];
    L.push(`sent: ${fmtClock(now)}`);
    L.push(SCOPE_LINE);   // TBC 0.3 §1.3：相位归属，防止模型把上一轮读回复的反应安到新消息上
    L.push(base ? `baseline: ${base.bpm} bpm (${base.method}${base.n ? `, n=${base.n}` : ''}${base.hrv ? `; hrv ${base.hrv} ms` : ''})` : 'baseline: n/a (session too short)');
    const pl = priorLine(prior); if (pl) L.push(pl);
    L.push(historyLine(history) || 'history: n/a');

    if (turn.prevSend && turn.replyEnd) {
      const gen = stats(inWin(samples, turn.prevSend, turn.replyEnd));
      const parts = [];
      if (turn.streamStart) parts.push(`ttft ${fmtS(turn.streamStart - turn.prevSend)}`);
      if (turn.reasoningEnd && turn.streamStart) parts.push(`reasoning ${fmtS(turn.reasoningEnd - turn.streamStart)}`);
      if (turn.reasoningEnd) parts.push(`body ${fmtS(turn.replyEnd - turn.reasoningEnd)}`);
      L.push(`gen: ${fmtS(turn.replyEnd - turn.prevSend)}${parts.length ? ` (${parts.join(', ')})` : ''} | ${fmtRange(gen)}${covTxt(gen ? coverage(gen.n, turn.prevSend, turn.replyEnd, cadenceMs) : null)}`);
    } else L.push('gen: n/a');

    if (turn.readStart != null) {
      const readEnd = turn.typingStart != null ? turn.typingStart : now;
      const rd = stats(inWin(samples, turn.readStart, readEnd));
      const hasPeak = Boolean(rd && rd.max > rd.first + 3);
      const peak = hasPeak ? ` peak ${rd.max} @${fmtS(rd.peakAt - turn.readStart)}` : '';
      const hrv = rd && rd.rrDropout <= 0.5 ? hrvInWindow(samples, turn.readStart, readEnd) : null;
      const tooLong = readEnd - turn.readStart > CONFIG.READ_SUSPICIOUS_MS;
      const flag = tooLong ? ' | flag: too-long (likely away)' : '';
      L.push(`read: ${fmtMS(Math.round((readEnd - turn.readStart) / 1000))} | ${fmtRange(rd)}${peak}${covTxt(rd ? coverage(rd.n, turn.readStart, readEnd, cadenceMs) : null)}${rrLoss(rd)}${hrv != null ? ` | hrv ${hrv} ms` : ''}${flag}`);
      // 可选字段 read-pos（v0.1.1 提案）：峰值不明显或 read 带 too-long 标记或没有 replyMeta/字数为 0 时不输出这一行
      if (hasPeak && !tooLong && replyMeta && replyMeta.chars) {
        const cjk = typeof replyMeta.cjkRatio === 'number' && replyMeta.cjkRatio >= 0.3;
        const defaultCps = cjk ? CONFIG.READ_CPS_CJK : CONFIG.READ_CPS_LATIN;
        const cpsInfo = cpsOverride && typeof cpsOverride.cps === 'number' ? cpsOverride : { cps: defaultCps, source: 'est' };
        const peakAtSec = Math.round((rd.peakAt - turn.readStart) / 1000);
        const readSec = Math.round((readEnd - turn.readStart) / 1000);
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

    if (turn.typingStart != null) {
      const wr = stats(inWin(samples, turn.typingStart, now));
      L.push(`write: ${fmtS(now - turn.typingStart)}, ${turn.lastLen != null ? turn.lastLen : 'n/a'} chars, pauses ${turn.pauses}, edits ${turn.deletes} | ${fmtRange(wr)}${covTxt(wr ? coverage(wr.n, turn.typingStart, now, cadenceMs) : null)}${rrLoss(wr)}`);
    } else L.push('write: n/a (no typing detected)');

    L.push(turn.away.length
      ? 'away: ' + turn.away.slice(-5).map(([a, b, k]) => { const st = stats(inWin(samples, a, b)); return `${fmtClock(a)}–${fmtClock(b)} ${k}${st ? ` [${st.min}–${st.max}]` : ''}`; }).join('; ')
      : 'away: none');

    const sendSt = stats(inWin(samples, now - 5000, now));
    L.push(sendSt ? `send: ${sendSt.last} bpm${base ? ` (${sendSt.last >= base.bpm ? '+' : '-'}${Math.round(Math.abs(sendSt.last - base.bpm) / base.bpm * 100)}%)` : ''}` : 'send: n/a (no data in last 5s)');
    // 0.8：其它信号种类各一行，随后是执行器状态行（都是可选的增量行）
    if (kinds && typeof kinds === 'object') {
      for (const kind of Object.keys(kinds)) { if (kind === 'hr' || kind === 'rr' || ENV_KINDS.has(kind)) continue; L.push(kindLine(kind, kinds[kind], turn, now)); }
      const el = envLine(kinds, now); if (el) L.push(el);
    }
    if (Array.isArray(deviceLines)) { for (const d of deviceLines) { const line = deviceLine(d); if (line) L.push(line); } }
    // 已按协议格式写好的扩展行（如 v0.3 §5.8 的 haptics 行）
    if (Array.isArray(extraLines)) { for (const x of extraLines) { if (x && !/[<>\n]/.test(x)) L.push(String(x)); } }
    const seqFrom = Math.max(turn.prevSend || 0, turn.readStart || 0, now - CONFIG.SERIES_MAX_MS);
    const seqStart = Math.floor(seqFrom / CONFIG.BUCKET_MS) * CONFIG.BUCKET_MS;
    const seq = series(samples, seqStart, now);
    if (seq.some((v) => v !== '·')) L.push(`series(10s from ${fmtClock(seqStart)}): ${seq.join(' ')}`);   // 没有任何数据时不写（series 是可选行）
    L.push('note: observable record only; phase edges are page events; hr lags seconds; wrist motion lowers confidence');
    L.push('</bio_context>');
    const summary = turnSummary({ samples, turn, baseline: base });
    if (summary) summary.readPos = readPos;   // 0.7.1：read-pos 同步进摘要 → 聊天变量 bio.turns / 消息 extra.bio
    return { text: L.join('\n'), turn, baseline: base, summary };
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

  return {
    CONFIG, SPEC_VERSION, SOURCE, MODES,
    parseHeartRate, inWin, stats, series, isFresh, fmtClock, fmtDur,
    collectRR, rmssd, hrvInWindow,
    manualBaseline, quietWindows, sessionBaseline,
    buildTurn, turnSummary, historyLine, readPosition, estimateCps, composeContext, attachBio, kindLine, deviceLine, coverage, priorLine, envLine, headerAttrs, normalizeMode, readCardHints, sparkPath, buildDiagnostics, WIRE_MODE, SCOPE_LINE,
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
  const onlyRisky = (caps) => caps.outputs.every((o) => RISKY_OUTPUTS.includes(o));
  const MAX_PER_REPLY = 3;
  const DEFAULT_INTENSITY = 0.5;
  const DEFAULT_MS = { pulse: 200, double: 500, triple: 800, long: 1500, heartbeat: 2700, wave: 3000 };
  const DEFAULT_MIN_INTERVAL_MS = 10000;
  // v0.3 §5.8 档位与自定义参数（与 ../spec/tools/bio-act.mjs 一致）
  const PROFILES = {
    'slow-burn': { floor: 0, defaultMs: { long: 1500, heartbeat: 2700, wave: 3000 }, minIntervalMs: 1500, maxPerReply: 3 },
    frenzy: { floor: 0.4, defaultMs: { long: 5000, heartbeat: 5400, wave: 6000 }, minIntervalMs: 800, maxPerReply: 5 },
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

  function parseBioActs(text, opts) {
    const limit = opts && Number.isInteger(opts.maxPerReply) ? Math.min(MAX_PER_REPLY_LIMIT, Math.max(0, opts.maxPerReply)) : MAX_PER_REPLY;
    const acts = [];
    const errors = [];
    const re = /<bio_act\b([^>]*?)\/?>/g;
    let m;
    while ((m = re.exec(String(text || '')))) {
      const a = {};
      const ar = /([a-zA-Z_]+)\s*=\s*"([^"]*)"/g;
      let x;
      while ((x = ar.exec(m[1]))) a[x[1]] = x[2];
      const act = { target: a.target || '*', output: a.output || '*', pattern: a.pattern || 'pulse', intensity: num(a.intensity) ?? DEFAULT_INTENSITY, durationMs: num(a.ms) };
      if (!OUTPUTS.includes(act.output)) { errors.push({ code: 'BAD_OUTPUT', value: act.output }); continue; }
      if (!PATTERNS.includes(act.pattern)) { errors.push({ code: 'BAD_PATTERN', value: act.pattern, fallback: 'pulse' }); act.pattern = 'pulse'; }
      if (!Number.isFinite(act.intensity) || act.intensity < 0 || act.intensity > 1) { errors.push({ code: 'BAD_INTENSITY', value: a.intensity }); act.intensity = Math.min(1, Math.max(0, Number.isFinite(act.intensity) ? act.intensity : DEFAULT_INTENSITY)); }
      if (act.durationMs != null && (!Number.isFinite(act.durationMs) || act.durationMs <= 0)) { errors.push({ code: 'BAD_MS', value: a.ms }); act.durationMs = null; }
      if (acts.length >= limit) { errors.push({ code: 'TOO_MANY', value: acts.length + 1 }); continue; }
      acts.push(act);
    }
    return { acts, errors };
  }

  function patternFrames(pattern, intensity, durationMs, opts) {
    const o = opts || {};
    const I = liftIntensity(intensity, o.floor || 0);
    const D = Object.assign({}, DEFAULT_MS, o.defaultMs || {});
    const r = (v) => Math.round(v * 1000) / 1000;
    switch (pattern) {
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
  function createRegistry({ timers, now, emit, policy, log }) {
    const T = timers;
    const items = new Map();   // id → { caps, handler, lastAt, run }
    const queued = new Set();  // 回复里排队、还没开始的动作（timer id）；全部停止时一并取消
    let last = null;
    let lastOk = null;   // 块里的 device 行用最近一次成功的触发

    function register(id, caps, handler) {
      if (!id || !caps || !Array.isArray(caps.outputs) || !caps.outputs.length) throw new Error('tbc.registerActuator: need (id, { outputs: [...] }, handler)');
      if (typeof handler !== 'function') throw new Error('tbc.registerActuator: handler must be a function');
      const prev = items.get(id);
      if (prev && prev.run) prev.run.cancel();
      items.set(String(id), { caps: Object.assign({ patterns: PATTERNS.slice(), levels: true, minIntervalMs: DEFAULT_MIN_INTERVAL_MS }, caps), handler, lastAt: prev ? prev.lastAt : null, run: null });
      emit('bio:actuators', list());
    }
    function unregister(id) {
      const it = items.get(String(id));
      if (!it) return;
      stopOne(String(id), it);
      items.delete(String(id));
      emit('bio:actuators', list());
    }
    function list() {
      return [...items.entries()].map(([id, it]) => Object.assign({ id }, it.caps, { busy: !!it.run }));
    }
    // 用户关掉的执行器（policy().off）不参与匹配
    function matches(target, output) {
      const off = new Set((policy() || {}).off || []);
      if (target && target !== '*') { const it = items.get(target); return it && !off.has(target) ? [[target, it]] : []; }
      return [...items.entries()].filter(([id, it]) => !off.has(id) && ((output === '*' || !output) ? !onlyRisky(it.caps) : it.caps.outputs.includes(output)));
    }
    function stopOne(id, it) {
      if (it.run) { it.run.cancel(); it.run = null; }
      try { const r = it.handler({ stop: true }); if (r && r.catch) r.catch(() => {}); } catch (_) {}
    }
    function stop(id) {
      if (id) { const it = items.get(String(id)); if (it) stopOne(String(id), it); }
      else {
        for (const x of queued) T.clearTimeout(x);
        queued.clear();
        for (const [k, it] of items) stopOne(k, it);
      }
      emit('bio:actuate', { t: now(), target: id || '*', action: { stop: true }, results: [], source: 'stop' });
    }

    async function actuate(target, action, opts) {
      const a = Object.assign({ output: '*', pattern: 'pulse' }, action || {});
      const source = (opts && opts.source) || 'api';
      const hits = matches(target || '*', a.output);
      if (!hits.length) return { ok: false, refused: 'unknown-target' };
      const t = now();
      const results = [];
      for (const [id, it] of hits) {
        const g = gate({ now: t, policy: policy(), caps: it.caps, lastAt: it.lastAt, action: a });
        if (g.refused) { results.push({ id, ok: false, refused: g.refused, retryInMs: g.retryInMs }); continue; }
        const frames = patternFrames(g.pattern, g.intensity, g.durationMs, { defaultMs: (policy() || {}).defaultMs });
        const span = frames[frames.length - 1][0];
        const deadline = t + span + 1000;
        if (it.run) it.run.cancel();
        it.lastAt = t;
        const job = { action: Object.assign({}, a, { pattern: g.pattern, intensity: g.intensity, durationMs: g.durationMs }), frames, deadline };
        let finished = false;
        const watchdog = T.setTimeout(() => { if (!finished) { log('watchdog stop', id); stopOne(id, it); } }, span + 1000);
        const cancelInner = { cancel() {} };
        it.run = { cancel() { finished = true; T.clearTimeout(watchdog); cancelInner.cancel(); } };
        Promise.resolve()
          .then(() => it.handler(Object.assign(job, { bindCancel: (fn) => { cancelInner.cancel = fn; } })))
          .catch((err) => log('actuator failed', id, err && err.message))
          .then(() => { finished = true; T.clearTimeout(watchdog); if (items.get(id) === it) it.run = null; });
        const res = { id, ok: true };
        if (g.clipped) res.clipped = g.clipped;
        if (g.fallback) res.fallback = g.fallback;
        results.push(res);
      }
      const ok = results.some((r) => r.ok);
      last = { t, target: target || '*', action: a, results, source };
      if (results.some((r) => r.ok)) lastOk = last;
      emit('bio:actuate', last);
      if (ok) return { ok: true, results };
      return { ok: false, refused: results[0].refused, results };
    }

    // 回复里的 <bio_act/>：按顺序排队，同一执行器之间等够最小间隔（一条回复最多 3 个，档位或用户可改到 5）
    function runReplyActs(acts, source) {
      const ids = [];
      let prevAt = 0;
      let prevSpan = 0;
      let first = true;
      const pol = policy() || {};
      const limit = Number.isInteger(pol.maxPerReply) ? Math.min(MAX_PER_REPLY_LIMIT, pol.maxPerReply) : MAX_PER_REPLY;
      for (const act of acts.slice(0, limit)) {
        const hits = matches(act.target, act.output);
        if (!hits.length) continue;
        const gap = Math.max(...hits.map(([, it]) => intervalFor(it.caps, pol)));
        const ready = Math.max(0, ...hits.map(([, it]) => (it.lastAt == null ? 0 : it.lastAt + gap - now() + 50)));
        const at = first ? ready : Math.max(ready, prevAt + Math.max(gap, prevSpan + 300) + 50);
        const frames = patternFrames(act.pattern, act.intensity, act.durationMs, { defaultMs: pol.defaultMs });
        const tid = T.setTimeout(() => { queued.delete(tid); actuate(act.target, act, { source }); }, at);
        queued.add(tid); ids.push(tid);
        prevAt = at; prevSpan = frames[frames.length - 1][0]; first = false;
      }
      return { scheduled: ids.length, cancel() { ids.forEach((x) => { T.clearTimeout(x); queued.delete(x); }); } };
    }

    return { register, unregister, list, actuate, stop, runReplyActs, pending: () => queued.size, last: () => last, lastOk: () => lastOk };
  }

  // ---------- Intiface / buttplug ----------
  // 设备特性 → 执行器描述：[{ key, deviceIndex, featureIndex, output, min, max, name, gapMs }]
  function featuresFromDeviceList(devices, version) {
    const out = [];
    if (version >= 4) {
      for (const d of Object.values(devices || {})) {
        for (const f of Object.values(d.DeviceFeatures || {})) {
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
  function createIntifaceClient({ WebSocket, url, clientName, timers, onFeatures, onStatus, log }) {
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
      status: () => ({ status, version, features: features.length, url }),
    };
  }

  return { OUTPUTS, PATTERNS, RISKY_OUTPUTS, MAX_PER_REPLY, MAX_PER_REPLY_LIMIT, DEFAULT_MS, PROFILES, DEFAULT_PROFILE, resolveSettings, liftIntensity, parseBioActs, patternFrames, gate, playFrames, createRegistry, featuresFromDeviceList, levelMessage, positionMessage, stopMessage, strokePeriod, createStroker, createIntifaceClient };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = HeartlinkHaptics;

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
//   getMode() / setMode(m) / toggleMode()  'author' | 'character'，按聊天记忆；没选过时用角色卡 data.extensions.tbc.mode_hint（TBC v0.3 §1.2）
//   connect() / disconnect()             connect 必须由真人点击触发（浏览器规定）
//   setManualBaseline() / clearManualBaseline()
//   getHistory()                         本聊天最近 20 轮摘要（也在聊天变量 bio.turns）
//   exportCsv()                          本聊天每轮摘要的 CSV 文本
//   exportEvents()                       { events, samples } 的 JSON 字符串
//   destroy()
// 页面事件（主窗口 dispatchEvent）：bio:sample { t, bpm, rr }；bio:inject { text, mode, summary }；bio:state getState()
(function heartlinkRuntime() {
  'use strict';

  const VERSION = '0.14.0';
  const CONFIG = {
    RUNTIME_KEY: '__HEARTLINK_RUNTIME__',
    PUBLIC_KEY: 'heartlink',
    INJECT_ID: 'bio-context',
    INJECT: { position: 'in_chat', depth: 0, role: 'system', should_scan: true },
    STORAGE_KEY: 'heartlink.settings.v4',
    HOST_ID: 'heartlink-badge-host',
    MAX_SAMPLES: 3600,
    MAX_EVENTS: 4000,
    TYPE_COALESCE_MS: 400,
    ACTIVITY_THROTTLE_MS: 10000,
    RECONNECT_DELAYS_MS: [1000, 2000, 4000, 8000, 15000],   // 用完后改为等设备的广播（设备回到附近自动连）
    STALE_MS: 15000,        // 显示已连接但这么久没数据：重新订阅；再过 STALE_MS 仍没有：断开重连
    RENDER_MS: 2000,
    BRIDGE_URL: 'ws://127.0.0.1:27130/tbc/v0.2',   // 0.9：本机桥（heartlink Desk）；页面自己连着蓝牙时忽略桥送来的 hr
    BRIDGE_RETRY_MS: [3000, 10000, 30000, 60000],
    HISTORY_MAX: 20,
    USER_GEN_KINDS: ['normal', 'regenerate', 'swipe', 'continue', 'impersonate', ''],
    REASONING_END_RE: /<\/[a-z_]*thinking>/i,
    SIGNAL_RE: /(?:0_)?Reader Signal[^\n]*/,
    THINKING_BLOCK_RE: /<[a-z_]*thinking>[\s\S]*?<\/[a-z_]*thinking>/gi,
    STYLE_BLOCK_RE: /<style[^>]*>[\s\S]*?<\/style>/gi,
    HTML_TAG_RE: /<[^>]+>/g,
    CJK_RE: /[一-鿿぀-ヿ가-힯]/g,
    CJK_RATIO_THRESHOLD: 0.3,
    // 0.10：触觉输出（TBC v0.3 §5）。默认关；玩具经 Intiface Central
    // profile：null = 用户还没选（按慢热执行，开振动时请用户选）；custom：用户对档位参数的覆盖（TBC v0.3 §5.8）
    // safeWords：可选，缺省关（兴奋时的“受不了”也会被拦，2026-09-17 实测）；词表可自定义
    HAPTICS: { enabled: false, maxIntensity: 0.6, fromReplies: true, off: [], profile: null, custom: {}, safeWords: { enabled: false, words: ['停下', '停一下', '先停', '停止', '快停', '别动了', '不要动'] }, intiface: { enabled: false, url: 'ws://127.0.0.1:12345' } },
    // 玩具本身没有间隔要求，间隔交给档位（§5.8）
    TOY_CAPS: { levels: true, maxIntensity: 1, maxDurationMs: 30000, minIntervalMs: 0, via: 'intiface' },
    ACTUATION_LINE_MS: 10 * 60 * 1000,
    LAB_URL: 'http://127.0.0.1:12346/lab/',   // 设备实验室（~/dev/tbc/device-lab，npm run sim）
  };
  const LOG = '[heartlink]';
  const GUIDE_BOOK = [{"name":"00 bio_context 读法（常驻）","enabled":true,"content":"<bio_context_guide>\n对话中可能出现一个 <bio_context> 块（Tavern Bio-Context v0.3）。块首行可能带 device / transport / cadence（采样间隔）/ rr（是否有心跳间期）/ trigger（本轮是新消息、重roll、continue 还是 impersonate）；cadence 越粗（30 秒以上）数据越稀疏，trigger 不是 normal 时 read 相位描述的是上一条被重roll或被续写的回复。它记录屏幕前那位真实读者在上一轮到这一轮之间的心率，按页面事件切成相位；数据来自读者佩戴的心率设备，是真实测量，不是剧情设定。\n相位归属（scope 行）：gen、read、read-pos 是读者等待和阅读**上一条回复**时的身体；write、send 是写**这一条消息**时和发送那一刻的身体。不要把 read 的峰值安到本轮新消息里发生的事情上。字段：\n- baseline：本场基线心率（quiet-median = 安静段中位数；p20 = 全场 20 分位；manual = 手动）与安静时 HRV。\n- prior：非实时来源（官方 API / 健康桥）的日级数据，带日期：昨夜恢复分、HRV、静息心率、睡眠时长、皮温。它说明读者今天的底子，不是此刻的反应；日期不是今天时不要当作今天。\n- history：最近几轮“读回复”的峰值、读时长、HRV，按时间顺序，最右是上一轮。看的是趋势：峰值一轮比一轮高说明越来越投入，越来越低说明在冷却。\n- gen：读者看上一条回复生成期间（ttft 等首字、reasoning 思维链、body 正文）的心率。\n- read：读上一条回复的时长、心率走向 [区间]、峰值出现在回复出完后多少秒、rr-loss（心跳间隔缺失率，越高说明手腕在动、数值可信度越低）、hrv。**这是最能反映读者对上一段内容反应的相位**；峰值时刻大致对应读到的位置。带 flag: too-long 的读回复不可当作阅读反应。\n- read-pos：把 read 的峰值时刻按阅读速度换算成大约读到回复的百分比与段落；est 是估计、cal 是按本场历史校准。它只回答“峰值大约对应哪一段”。写 partial 时表示读者读的时间远不够读完这条回复（在跳读或没读完），只给出峰值在读时长里的相对位置，不要当成段落位置。\n- cov：该相位的样本覆盖率，低于 70% 的相位数据不可靠。\n- write：写消息的时长、字数、停顿、删改与心率。手腕在动，只看大趋势。\n- away：页面切走或长时间无操作的区间，其中的心率与对话无关，忽略。\n- send：按下发送时的心率与相对基线的百分比。\n- env：读者所在房间的温湿度最近值，与身体反应无关，只是环境背景。\n- 其它信号行（如 pressure(civet, 100ms): read 7.9→12.3 kPa …）：读者身上别的传感器在同一相位里的走向，单位随行；只看相对变化，不与心率合成结论。\n- device：读者当前连接的设备正在做什么（强度、模式、持续时间），来自设备控制器的登记；它是作者视角的幕后事实，author 模式下角色不知道，character 模式下只允许角色察觉由它引起的可观察反应，不点名设备。\n- series：每 10 秒一个点的原始序列。\n判断尺度：baseline 为 n/a 时不做“比刚才 / 比平时快慢”的比较；与 away 重叠、带 flag 或 cov 低于 70% 的相位不据此判断。相对基线 10% 以内是噪声；持续高 20% 以上且出现在 read 相位，才是明确反应。HRV 明显低于安静值说明绷着或亢奋，明显高说明放松。块内没有结论，解释由你完成；块不出现时忽略本说明。\n</bio_context_guide>","strategy":{"type":"constant","keys":[]},"position":{"type":"after_character_definition","order":100},"recursion":{"prevent_incoming":true,"prevent_outgoing":true},"extra":{"heartlink":"0.14.0"}},{"name":"10 mode=backstage 幕后（旧 author）","enabled":true,"content":"<bio_context> 处于幕后模式（backstage，旧名 author）：它是给你这位作者/裁决者的幕后读者反馈，剧情里任何角色都不知道它，{{user}} 角色的身体状态与它无关。只做三件事：\n1. 从 read 与 history 判断读者对上一段的反应走向（被抓住了 / 平淡 / 正在冷却 / 数据不足），据此决定本段的详略、张力与结尾钩子；预设若有推进 / 节奏模式，结构（跳时、转场、新事件）仍按预设，读者反应只调写法。\n2. 反应上升时顺势推进、加深、留悬念；平淡时换手法（换视角、加冲突、加感官细节、缩短铺垫），不要重复上一段的写法；冷却时给一个新钩子。\n3. 不在正文里提及心率、设备、读者或任何数据；不让角色“察觉”读者；不因数据改变既定事实与规则裁决。","strategy":{"type":"selective","keys":["mode=\"backstage\"","mode=\"author\""]},"position":{"type":"at_depth","role":"system","depth":2,"order":90},"recursion":{"prevent_incoming":true,"prevent_outgoing":true},"extra":{"heartlink":"0.14.0"}},{"name":"11 mode=in-story 入戏（旧 character）","enabled":true,"content":"<bio_context> 处于入戏模式（in-story，旧名 character）：读者代入 {{user}}。send 是 {{user}} 此刻的身体状态；read 是 {{user}} 经历上一段情节时的反应（只能对应上一段里发生的事，不能安到本轮新动作上）。让在场角色通过可观察的线索察觉（呼吸、面色、手、声音、姿态），并按各自性格与关系回应。仍然不说数字、不提设备；gen、write、away 的数据不用于角色感知。首行若有 perceiver 属性（卡片指定的感知者），只让这些角色表达察觉，其他在场角色照常行动、不评论 {{user}} 的身体。","strategy":{"type":"selective","keys":["mode=\"in-story\"","mode=\"character\""]},"position":{"type":"at_depth","role":"system","depth":2,"order":90},"recursion":{"prevent_incoming":true,"prevent_outgoing":true},"extra":{"heartlink":"0.14.0"}}];
  const GUIDE_BOOK_NATIVE = [{"uid":0,"key":[],"keysecondary":[],"comment":"00 bio_context 读法（常驻）","content":"<bio_context_guide>\n对话中可能出现一个 <bio_context> 块（Tavern Bio-Context v0.3）。块首行可能带 device / transport / cadence（采样间隔）/ rr（是否有心跳间期）/ trigger（本轮是新消息、重roll、continue 还是 impersonate）；cadence 越粗（30 秒以上）数据越稀疏，trigger 不是 normal 时 read 相位描述的是上一条被重roll或被续写的回复。它记录屏幕前那位真实读者在上一轮到这一轮之间的心率，按页面事件切成相位；数据来自读者佩戴的心率设备，是真实测量，不是剧情设定。\n相位归属（scope 行）：gen、read、read-pos 是读者等待和阅读**上一条回复**时的身体；write、send 是写**这一条消息**时和发送那一刻的身体。不要把 read 的峰值安到本轮新消息里发生的事情上。字段：\n- baseline：本场基线心率（quiet-median = 安静段中位数；p20 = 全场 20 分位；manual = 手动）与安静时 HRV。\n- prior：非实时来源（官方 API / 健康桥）的日级数据，带日期：昨夜恢复分、HRV、静息心率、睡眠时长、皮温。它说明读者今天的底子，不是此刻的反应；日期不是今天时不要当作今天。\n- history：最近几轮“读回复”的峰值、读时长、HRV，按时间顺序，最右是上一轮。看的是趋势：峰值一轮比一轮高说明越来越投入，越来越低说明在冷却。\n- gen：读者看上一条回复生成期间（ttft 等首字、reasoning 思维链、body 正文）的心率。\n- read：读上一条回复的时长、心率走向 [区间]、峰值出现在回复出完后多少秒、rr-loss（心跳间隔缺失率，越高说明手腕在动、数值可信度越低）、hrv。**这是最能反映读者对上一段内容反应的相位**；峰值时刻大致对应读到的位置。带 flag: too-long 的读回复不可当作阅读反应。\n- read-pos：把 read 的峰值时刻按阅读速度换算成大约读到回复的百分比与段落；est 是估计、cal 是按本场历史校准。它只回答“峰值大约对应哪一段”。写 partial 时表示读者读的时间远不够读完这条回复（在跳读或没读完），只给出峰值在读时长里的相对位置，不要当成段落位置。\n- cov：该相位的样本覆盖率，低于 70% 的相位数据不可靠。\n- write：写消息的时长、字数、停顿、删改与心率。手腕在动，只看大趋势。\n- away：页面切走或长时间无操作的区间，其中的心率与对话无关，忽略。\n- send：按下发送时的心率与相对基线的百分比。\n- env：读者所在房间的温湿度最近值，与身体反应无关，只是环境背景。\n- 其它信号行（如 pressure(civet, 100ms): read 7.9→12.3 kPa …）：读者身上别的传感器在同一相位里的走向，单位随行；只看相对变化，不与心率合成结论。\n- device：读者当前连接的设备正在做什么（强度、模式、持续时间），来自设备控制器的登记；它是作者视角的幕后事实，author 模式下角色不知道，character 模式下只允许角色察觉由它引起的可观察反应，不点名设备。\n- series：每 10 秒一个点的原始序列。\n判断尺度：baseline 为 n/a 时不做“比刚才 / 比平时快慢”的比较；与 away 重叠、带 flag 或 cov 低于 70% 的相位不据此判断。相对基线 10% 以内是噪声；持续高 20% 以上且出现在 read 相位，才是明确反应。HRV 明显低于安静值说明绷着或亢奋，明显高说明放松。块内没有结论，解释由你完成；块不出现时忽略本说明。\n</bio_context_guide>","constant":true,"vectorized":false,"selective":true,"selectiveLogic":0,"addMemo":true,"order":100,"position":1,"disable":false,"excludeRecursion":true,"preventRecursion":true,"delayUntilRecursion":false,"probability":100,"useProbability":true,"depth":4,"group":"","groupOverride":false,"groupWeight":100,"scanDepth":null,"caseSensitive":false,"matchWholeWords":false,"useGroupScoring":null,"automationId":"","role":0,"sticky":0,"cooldown":0,"delay":0,"displayIndex":0},{"uid":1,"key":["mode=\"backstage\"","mode=\"author\""],"keysecondary":[],"comment":"10 mode=backstage 幕后（旧 author）","content":"<bio_context> 处于幕后模式（backstage，旧名 author）：它是给你这位作者/裁决者的幕后读者反馈，剧情里任何角色都不知道它，{{user}} 角色的身体状态与它无关。只做三件事：\n1. 从 read 与 history 判断读者对上一段的反应走向（被抓住了 / 平淡 / 正在冷却 / 数据不足），据此决定本段的详略、张力与结尾钩子；预设若有推进 / 节奏模式，结构（跳时、转场、新事件）仍按预设，读者反应只调写法。\n2. 反应上升时顺势推进、加深、留悬念；平淡时换手法（换视角、加冲突、加感官细节、缩短铺垫），不要重复上一段的写法；冷却时给一个新钩子。\n3. 不在正文里提及心率、设备、读者或任何数据；不让角色“察觉”读者；不因数据改变既定事实与规则裁决。","constant":false,"vectorized":false,"selective":true,"selectiveLogic":0,"addMemo":true,"order":90,"position":4,"disable":false,"excludeRecursion":true,"preventRecursion":true,"delayUntilRecursion":false,"probability":100,"useProbability":true,"depth":2,"group":"","groupOverride":false,"groupWeight":100,"scanDepth":null,"caseSensitive":false,"matchWholeWords":false,"useGroupScoring":null,"automationId":"","role":0,"sticky":0,"cooldown":0,"delay":0,"displayIndex":1},{"uid":2,"key":["mode=\"in-story\"","mode=\"character\""],"keysecondary":[],"comment":"11 mode=in-story 入戏（旧 character）","content":"<bio_context> 处于入戏模式（in-story，旧名 character）：读者代入 {{user}}。send 是 {{user}} 此刻的身体状态；read 是 {{user}} 经历上一段情节时的反应（只能对应上一段里发生的事，不能安到本轮新动作上）。让在场角色通过可观察的线索察觉（呼吸、面色、手、声音、姿态），并按各自性格与关系回应。仍然不说数字、不提设备；gen、write、away 的数据不用于角色感知。首行若有 perceiver 属性（卡片指定的感知者），只让这些角色表达察觉，其他在场角色照常行动、不评论 {{user}} 的身体。","constant":false,"vectorized":false,"selective":true,"selectiveLogic":0,"addMemo":true,"order":90,"position":4,"disable":false,"excludeRecursion":true,"preventRecursion":true,"delayUntilRecursion":false,"probability":100,"useProbability":true,"depth":2,"group":"","groupOverride":false,"groupWeight":100,"scanDepth":null,"caseSensitive":false,"matchWholeWords":false,"useGroupScoring":null,"automationId":"","role":0,"sticky":0,"cooldown":0,"delay":0,"displayIndex":2}];
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
    injectEnabled: state.injectEnabled !== false, privacyAck: !!state.privacyAck, injectedFor: null, lastInjectAt: state.lastInjectAt || null, backgroundSkipped: state.backgroundSkipped || 0,
    guideActive: state.guideActive ?? null, multiWindow: false, lastProblemKey: '',
    lastSummarizedSend: state.lastSummarizedSend || null,
    deviceName: state.deviceName || null, deviceInfo: state.deviceInfo || null, battery: state.battery ?? null,
    generating: false, backgroundGen: false, streamStarted: false, reasoningEnded: false,
    subscribing: null, advWatch: null, waitingForDevice: false, staleStep: 0, menuWait: false, badgeTab: null,
    lastSendT: state.lastSendT || null, lastTypeT: 0, lastLen: 0, lastActivityT: 0, chatIdSeen: state.chatIdSeen || null,
    onSample: null, onConnection: null, notifyHandler: state.notifyHandler || null, disconnectHandler: state.disconnectHandler || null,
    haptics: state.haptics || JSON.parse(JSON.stringify(CONFIG.HAPTICS)), intifaceStatus: 'idle', genStoppedAt: 0, lastActedReply: state.lastActedReply || null,
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
      if (typeof s.injectEnabled === 'boolean') state.injectEnabled = s.injectEnabled;
      if (s.privacyAck) state.privacyAck = true;
      if (s.badgePos && Number.isFinite(s.badgePos.right) && Number.isFinite(s.badgePos.top)) state.badgePos = s.badgePos;
      if (typeof s.badgeHidden === 'boolean') state.badgeHidden = s.badgeHidden;
      if (s.haptics && typeof s.haptics === 'object') state.haptics = normalizeHaptics(s.haptics);
    } catch (err) { console.warn(LOG, 'loadSettings failed', err); }
  }
  // 旧设置缺的字段补缺省；安全词开关与词表分开合并
  function normalizeHaptics(h) {
    const d = JSON.parse(JSON.stringify(CONFIG.HAPTICS));
    const x = Object.assign(d, h || {});
    x.intiface = Object.assign({}, CONFIG.HAPTICS.intiface, (h && h.intiface) || {});
    x.safeWords = Object.assign({}, CONFIG.HAPTICS.safeWords, (h && h.safeWords) || {});
    if (!Array.isArray(x.safeWords.words)) x.safeWords.words = CONFIG.HAPTICS.safeWords.words.slice();
    x.safeWords.words = x.safeWords.words.map((w) => String(w).trim()).filter(Boolean).slice(0, 50);
    x.custom = x.custom && typeof x.custom === 'object' ? x.custom : {};
    if (!HeartlinkHaptics.PROFILES[x.profile]) x.profile = null;
    return x;
  }
  function safeWordHit(text) {
    const sw = state.haptics.safeWords;
    if (!sw || !sw.enabled) return false;
    const t = String(text || '');
    return sw.words.some((w) => w && t.includes(w));
  }
  function saveSettings() {
    try { host.localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify({ manualBaseline: state.manualBaseline, modes: state.modes, deviceName: state.deviceName, prior: state.prior || null, injectEnabled: state.injectEnabled !== false, privacyAck: !!state.privacyAck, haptics: state.haptics, badgePos: state.badgePos || null, badgeHidden: !!state.badgeHidden })); }
    catch (err) { console.warn(LOG, 'saveSettings failed', err); }
  }
  function toast(kind, text) {
    try { if (typeof toastr !== 'undefined' && toastr[kind]) { toastr[kind](text, 'heartlink'); return; } } catch (_) {}
    console.log(LOG, kind, text);
  }
  function ctx() { try { return host.SillyTavern.getContext(); } catch (_) { return null; } }
  function chatId() { const c = ctx(); return (c && c.chatId) || 'default'; }
  function emit(name, detail) { try { host.dispatchEvent(new host.CustomEvent(name, { detail })); } catch (_) {} }

  // ---------- 事件记录 ----------
  const ACTIVITY_TYPES = new Set(['type', 'activity', 'visible', 'hidden']);
  function pushEvent(type, extra) {
    const e = Object.assign({ t: Date.now(), type }, extra || {});
    state.events.push(e);
    if (state.events.length > CONFIG.MAX_EVENTS) state.events.splice(0, state.events.length - CONFIG.MAX_EVENTS);
    if (ACTIVITY_TYPES.has(type)) {
      state.activityLog.push(e);
      if (state.activityLog.length > CONFIG.MAX_EVENTS) state.activityLog.splice(0, state.activityLog.length - CONFIG.MAX_EVENTS);
    }
    return e;
  }

  // ---------- 蓝牙 ----------
  function bluetooth() { try { return host.navigator.bluetooth || null; } catch (_) { return null; } }
  function pushSample(bpm, rr) {
    const sample = { t: Date.now(), bpm, rr: rr || [] };
    state.samples.push(sample);
    if (state.samples.length > CONFIG.MAX_SAMPLES) state.samples.splice(0, state.samples.length - CONFIG.MAX_SAMPLES);
    state.lastSample = sample;
    if (typeof state.onSample === 'function') { try { state.onSample(sample); } catch (_) {} }
    emit('bio:sample', sample);
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
  function setPrior(prior) {   // 非实时来源（whoop-api / 健康桥）的日级先验：{ source, date, fields:{recovery,hrv,rhr,sleepHours,spo2,skinTemp} }
    if (prior && typeof prior === 'object') { state.prior = { source: String(prior.source || 'api'), date: prior.date || null, fields: Object.assign({}, prior.fields || {}) }; }
    else state.prior = null;
    saveSettings(); render(); emit('bio:state', getState());
    return state.prior;
  }

  // ---------- 0.8：TBC 总线（协议 device-interface-zh.md §1–§3）——别的脚本/扩展往这里 push 样本、登记设备状态行、订阅事件 ----------
  function setExposure(x) {
    if (x && typeof x.inject === 'boolean') { state.injectEnabled = x.inject; if (!x.inject) clearInject(); saveSettings(); render(); }
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
    });
    try { d.haptics = { enabled: !!state.haptics.enabled, maxIntensity: state.haptics.maxIntensity, actuators: actuators.list().length, intiface: state.intifaceStatus }; } catch (_) {}
    return d;
  }
  function exportDiagnostics() { return JSON.stringify(diagnostics(), null, 2); }
  // 没有酒馆助手时，世界书走酒馆核心接口（REST 读写 + /world 开关全局）
  const nativeWb = {
    ok() { const c = ctx(); return !!(c && typeof c.getRequestHeaders === 'function' && typeof c.executeSlashCommandsWithOptions === 'function'); },
    async get(name) {
      const r = await host.fetch('/api/worldinfo/get', { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ name }) });
      if (!r.ok) return null;
      const j = await r.json();
      return j && j.entries && Object.keys(j.entries).length ? Object.values(j.entries) : null;
    },
    async put(name, list) {
      const c = ctx(); const data = { entries: {} };
      list.forEach((e, i) => { data.entries[i] = e; });
      const r = await host.fetch('/api/worldinfo/edit', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify({ name, data }) });
      if (!r.ok) throw new Error('写世界书失败 ' + r.status);
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
  // 读法世界书是否启用（找含 <bio_context_guide> 的已启用条目）；30 秒刷新一次
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
  // 0.9.5：读法世界书由脚本自己维护——缺了就建、版本旧了就换、没绑全局就绑；旧的手动导入版（条目名相同）解绑，避免两份读法
  async function ensureGuideWorldbookNative() {
    if (!GUIDE_BOOK_NATIVE || !nativeWb.ok()) { state.guideSync = { at: Date.now(), skipped: 'no-api' }; return; }
    try {
      const current = await nativeWb.get(GUIDE_BOOK_NAME);
      const upToDate = !!current && current.length === GUIDE_BOOK_NATIVE.length && GUIDE_BOOK_NATIVE.every((e) => current.some((x) => x.comment === e.comment && x.content === e.content && !x.disable));
      if (!upToDate) await nativeWb.put(GUIDE_BOOK_NAME, GUIDE_BOOK_NATIVE);
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
      const upToDate = current && current.length === GUIDE_BOOK.length && current.every((e) => e.extra && e.extra.heartlink === VERSION);
      if (!upToDate) await TH.createOrReplaceWorldbook(GUIDE_BOOK_NAME, GUIDE_BOOK, { render: 'none' });
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
  function tbcPush(sample) {
    if (!sample || typeof sample !== 'object' || typeof sample.value !== 'number' || !sample.kind) throw new Error('tbc.push: need { kind, value }');
    const t = typeof sample.t === 'number' ? sample.t : Date.now();
    const source = String(sample.source || 'external');
    if (sample.kind === 'hr') { pushSample(Math.round(sample.value), Array.isArray(sample.rr) ? sample.rr : []); return; }
    const k = kinds(); const kind = String(sample.kind);
    if (!k[kind]) k[kind] = { source, unit: sample.unit || 'raw', cadence: sample.cadence || null, device: sample.device || null, samples: [] };
    const bucket = k[kind];
    bucket.source = source; if (sample.unit) bucket.unit = sample.unit; if (sample.cadence) bucket.cadence = sample.cadence;
    bucket.samples.push({ t, value: sample.value, quality: sample.quality });
    if (bucket.samples.length > CONFIG.MAX_SAMPLES) bucket.samples.splice(0, bucket.samples.length - CONFIG.MAX_SAMPLES);
    emit('bio:sample', Object.assign({ t, source, kind, value: sample.value }, sample));
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
  // 桥在 heartlink Desk（macOS 菜单栏 App）里：它连蓝牙、推 bio:sample；页面把状态回传（cmd:state / prior），
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
  function hapticsPolicy() {
    const wear = kinds().wear;
    const lastWear = wear && wear.samples.length ? wear.samples[wear.samples.length - 1].value : null;
    const set = HeartlinkHaptics.resolveSettings(state.haptics.profile, state.haptics.custom);
    return Object.assign(set, { enabled: !!state.haptics.enabled, maxIntensity: state.haptics.maxIntensity, worn: lastWear === 0 ? false : null, off: state.haptics.off || [] });
  }
  const actuators = HeartlinkHaptics.createRegistry({
    timers: hTimers, now: () => Date.now(), policy: hapticsPolicy,
    emit: (name, detail) => {
      emit(name, detail);
      if (name === 'bio:actuators') { try { emit('bio:output-state', outputState()); } catch (_) {} }
      if (name !== 'bio:actuate') return;
      bridgeSend({ event: 'bio:actuate', detail });
      const src = String(detail.source || '');
      if (src.startsWith('reply:')) {
        const e = (state.replyLog || []).find((x) => x.key === src.slice(6));
        if (e) { e.results.push({ t: detail.t, pattern: detail.action.pattern, results: detail.results }); emit('bio:reply-acts', e); }
      }
      render();
    },
    log: (...a) => console.warn(LOG, ...a),
  });
  const toyFeatures = new Map();   // key → feature（带 driver：intiface 或 wasm）
  let intiface = null;
  // 每个来源（intiface / wasm）各自同步自己的特性，互不影响
  function syncToys(source, driver, features) {
    const keep = new Set(features.map((f) => f.key));
    for (const [key, f] of [...toyFeatures.entries()]) if (f.source === source && !keep.has(key)) { toyFeatures.delete(key); actuators.unregister(key); }
    for (const f0 of features) {
      if (toyFeatures.has(f0.key)) continue;
      const f = Object.assign({ source }, f0);
      toyFeatures.set(f.key, f);
      // 按位置控制的抽动类用抽动器把强度换成往返速度；其余直接按强度设值
      const stroker = f.mode === 'position' ? HeartlinkHaptics.createStroker({ move: (pos, ms) => driver.alive() && driver.setPosition(f, pos, ms), timers: hTimers }) : null;
      const setLevel = (lv) => { if (!driver.alive()) return; if (stroker) stroker.setLevel(lv); else driver.setLevel(f, lv); };
      actuators.register(f.key, Object.assign({ outputs: [f.output], device: `${f.name}${f.feature ? ' ' + f.feature : ''}`.slice(0, 64) }, CONFIG.TOY_CAPS, { via: source === 'wasm' ? 'page' : 'intiface' }), (job) => {
        if (!driver.alive()) return;
        if (job.stop) { if (stroker) stroker.stop(); driver.stop(f); return; }
        const run = HeartlinkHaptics.playFrames(job.frames, setLevel, hTimers);
        job.bindCancel(() => { run.cancel(); setLevel(0); });
        return run.done;
      });
    }
    render();
  }
  const intifaceDriver = { alive: () => !!intiface, setLevel: (f, lv) => intiface.setLevel(f, lv), setPosition: (f, p, ms) => intiface.setPosition(f, p, ms), stop: (f) => intiface.stop(f) };
  function startIntiface() {
    if (intiface || typeof host.WebSocket !== 'function') return;
    intiface = HeartlinkHaptics.createIntifaceClient({
      WebSocket: host.WebSocket, url: state.haptics.intiface.url, clientName: `heartlink ${VERSION}`, timers: hTimers,
      onFeatures: (fs) => syncToys('intiface', intifaceDriver, fs),
      onStatus: (st, detail) => {
        const was = state.intifaceStatus; state.intifaceStatus = st; state.intifaceDetail = detail || null;
        if (st === 'connected' && was !== 'connected') toast('success', `已连上 Intiface（协议 v${detail && detail.version}）`);
        if (st === 'disconnected' && was === 'connected') { actuators.stop(); toast('warning', 'Intiface 断开了，设备已停；会自动重连'); }
        render();
      },
      log: (...a) => console.warn(LOG, ...a),
    });
    intiface.connect();
  }
  function stopIntiface() {
    if (!intiface) return;
    actuators.stop();
    intiface.close(); intiface = null;
    syncToys('intiface', intifaceDriver, []);
    state.intifaceStatus = 'idle';
  }

  // ---------- 实验：浏览器内直连（buttplug-wasm，不用装 Intiface） ----------
  // 未经真实设备测试。设备库与 Intiface 相同；需要桌面 Chrome / Edge；必须由用户点击触发。
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
    if (!host.navigator || !host.navigator.bluetooth) { toast('error', '这个浏览器不支持网页蓝牙，请用桌面 Chrome / Edge'); return; }
    try {
      WASM.status = 'loading'; render();
      if (!WASM.lib) {
        const [bp, bw] = await Promise.all([import('https://cdn.jsdelivr.net/npm/buttplug@4/+esm'), import('https://cdn.jsdelivr.net/npm/buttplug-wasm@3/+esm')]);
        WASM.lib = Object.assign({}, bp, { WasmConnector: bw.ButtplugWasmClientConnector });
      }
      if (!WASM.client) {
        const client = new WASM.lib.ButtplugClient(`heartlink ${VERSION}`);
        client.addListener('deviceadded', (d) => { WASM.devices.set(d.index, d); syncToys('wasm', wasmDriver, wasmFeatures()); toast('success', `已直连：${d.displayName || d.name}`); });
        client.addListener('deviceremoved', (d) => { WASM.devices.delete(d.index); actuators.stop(); syncToys('wasm', wasmDriver, wasmFeatures()); });
        client.addListener('disconnect', () => { WASM.devices.clear(); actuators.stop(); syncToys('wasm', wasmDriver, []); WASM.status = 'idle'; render(); });
        await client.connect(new WASM.lib.WasmConnector());
        WASM.client = client;
      }
      WASM.status = 'connected'; render();
      await WASM.client.startScanning();   // 浏览器弹出选设备窗口
    } catch (err) {
      WASM.status = 'error'; render();
      toast('error', '直连失败：' + (err && err.message || err) + '。可以改用 Intiface。');
    }
  }
  async function stopWasm() {
    try { if (WASM.client) { await WASM.client.stopAllDevices().catch(() => {}); await WASM.client.disconnect(); } } catch (_) {}
    WASM.client = null; WASM.devices.clear(); syncToys('wasm', wasmDriver, []); WASM.status = 'idle'; render();
  }
  function setHaptics(patch) {
    const pt = patch || {};
    const next = normalizeHaptics(Object.assign({}, state.haptics, pt, {
      intiface: Object.assign({}, state.haptics.intiface, pt.intiface || {}),
      safeWords: Object.assign({}, state.haptics.safeWords, pt.safeWords || {}),
      custom: pt.custom === null ? {} : Object.assign({}, state.haptics.custom, pt.custom || {}),
    }));
    next.maxIntensity = Math.min(1, Math.max(0.05, Number(next.maxIntensity) || CONFIG.HAPTICS.maxIntensity));
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
    return {
      enabled: !!state.haptics.enabled, maxIntensity: state.haptics.maxIntensity,
      profile: set.profile, profileChosen: !!state.haptics.profile,
      settings: { floor: set.floor, defaultMs: set.defaultMs, minIntervalMs: set.minIntervalMs, maxPerReply: set.maxPerReply },
      fromReplies: state.haptics.fromReplies !== false,
      actuators: actuators.list().filter((a) => !off.has(a.id)).length,
    };
  }
  function getHaptics() {
    return Object.assign(JSON.parse(JSON.stringify(state.haptics)), { settings: hapticsPolicy(), timers: hTimers.kind, intifaceStatus: state.intifaceStatus, wasmStatus: WASM.status, actuators: actuators.list(), last: actuators.last(), replyLog: (state.replyLog || []).filter((x) => x.chatId === chatId()) });
  }
  // 块里的 haptics 行（§5.8）：开着时写上限与档位；关着但有设备时写 off
  function hapticsLine() {
    const n = actuators.list().filter((a) => !(state.haptics.off || []).includes(a.id)).length;
    if (!state.haptics.enabled) return n ? 'haptics(heartlink): off' : null;
    const set = hapticsPolicy();
    return `haptics(heartlink): on | cap ${Math.round(state.haptics.maxIntensity * 100)}% | profile ${set.profile} | actuators ${n}`;
  }
  // 开振动时还没选档位：请用户选（慢热 / 狂暴），之后可在玩具页切换
  async function askProfile() {
    if (state.haptics.profile) return;
    let pick = 'slow-burn';
    try {
      const c = ctx();
      if (c && typeof c.callGenericPopup === 'function') {
        const html = '<h3>选一个节奏</h3><p><b>慢热</b>：从轻开始，逐步升温，强度与时长都偏保守。</p><p><b>狂暴</b>：高触发、高功率——大多数回合都会动，强度至少四成，时长更长。</p><p>之后可在玩具页随时切换；强度上限始终有效。</p>';
        const r = await c.callGenericPopup(html, (c.POPUP_TYPE && c.POPUP_TYPE.CONFIRM) || 2, '', { okButton: '狂暴', cancelButton: '慢热' });
        pick = r === 1 || r === true ? 'frenzy' : 'slow-burn';
      }
    } catch (_) {}
    setHaptics({ profile: pick });
    toast('info', `节奏：${pick === 'frenzy' ? '狂暴' : '慢热'}（之后可在玩具页切换）`);
  }
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
  function replyEntry(key, index, acts, errors, skipped) {
    const log = state.replyLog || (state.replyLog = []);
    const e = { key, chatId: chatId(), index, t: Date.now(), acts, errors: errors.map((x) => x.code), skipped: skipped || null, results: [] };
    log.push(e);
    if (log.length > 60) log.splice(0, log.length - 60);
    emit('bio:reply-acts', e);
    return e;
  }
  function actOnReply() {
    const c = ctx(); const chat = (c && c.chat) || [];
    const i = chat.length - 1;
    const msg = chat[i];
    if (!msg || msg.is_user || msg.is_system) return;
    const key = `${chatId()}|${i}|${msg.swipe_id || 0}|${String(msg.mes || '').length}`;
    if (state.lastActedReply === key) return;
    const { acts, errors } = HeartlinkHaptics.parseBioActs(msg.mes, { maxPerReply: hapticsPolicy().maxPerReply });
    if (errors.length) console.warn(LOG, 'bio_act errors', errors);
    if (!acts.length && !errors.length) return;
    state.lastActedReply = key;
    let prevUser = null;
    for (let k = i - 1; k >= 0; k--) if (chat[k].is_user) { prevUser = chat[k]; break; }
    const safe = prevUser && safeWordHit(prevUser.mes);
    const skipped = safe ? 'safeword' : !state.haptics.enabled ? 'disabled' : !state.haptics.fromReplies ? 'replies-off' : !actuators.list().length ? 'no-device' : null;
    replyEntry(key, i, acts, errors, skipped);
    if (skipped || !acts.length) { render(); return; }
    actuators.runReplyActs(acts, `reply:${key}`);
  }

  function installTbc() {
    const existing = host.tbc;
    if (existing && existing._owner !== 'heartlink' && typeof existing.version === 'string' && existing.version >= TBC_VERSION) {
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
      stop: (id) => actuators.stop(id), actuators: actuators.list,
      outputState, replyActs: () => JSON.parse(JSON.stringify((state.replyLog || []).filter((x) => x.chatId === chatId()))),
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
      try { const parsed = HeartlinkCore.parseHeartRate(event.target.value); pushSample(parsed.bpm, parsed.rr); }
      catch (err) { console.warn(LOG, 'parse failed', err); }
    };
    characteristic.addEventListener('characteristicvaluechanged', state.notifyHandler);
    state.disconnectHandler = () => onDisconnected(device);
    device.addEventListener('gattserverdisconnected', state.disconnectHandler);
    state.device = device; state.characteristic = characteristic;
    state.deviceName = device.name || state.deviceName;
    state.connected = true; state.reconnecting = false; state.connectedAt = Date.now(); state.staleStep = 0;
    stopAdvertisementWatch();
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
    if (await waitForAdvertisement(device)) { notifyConnection(); toast('info', '心率设备暂时连不上，设备回到附近会自动重连。'); return; }
    notifyConnection();
    toast('warning', '心率设备断开，自动重连失败。点悬浮窗 → 健康设备 → 连接设备。');
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
    state.advWatch = null; state.waitingForDevice = false;
    if (!w) return;
    try { w.device.removeEventListener('advertisementreceived', w.onAdv); } catch (_) {}
    try { if (w.ac) w.ac.abort(); } catch (_) {}   // Chrome：用 signal 结束扫描
    try { if (typeof w.device.unwatchAdvertisements === 'function') w.device.unwatchAdvertisements(); } catch (_) {}
  }
  // 看门狗：显示已连接却长时间没数据（常见的“假连接”）→ 先重新订阅，仍没有就断开，交给重连流程
  async function checkStale() {
    if (!state.connected || !state.device || state.subscribing) return;
    const last = Math.max(state.lastSample ? state.lastSample.t : 0, state.connectedAt || 0);
    const idle = Date.now() - last;
    if (idle < CONFIG.STALE_MS) { if (idle < 3000) { state.staleStep = 0; if (state.lastSample && Date.now() - state.lastSample.t < 3000) { state.staleFixes = 0; state.staleGaveUp = false; } } return; }
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
  const CONNECT_HELP = '没有选择设备。列表里找不到时请检查：① 设备打开了“心率广播”（华为/小米/荣耀在运动健康 App 里开，WHOOP 在 App 的心率广播里开）；② 手环没被其他电脑或网页占着；③ 离电脑近一些；④ 用桌面版 Chrome / Edge。';
  async function connect() {
    const bt = bluetooth();
    if (!bt) { toast('error', '这个浏览器不支持 Web Bluetooth。请用桌面版 Chrome 或 Edge。'); return false; }
    try {
      const device = await bt.requestDevice({ filters: [{ services: ['heart_rate'] }], optionalServices: ['battery_service', 'device_information'] });
      await subscribe(device);
      toast('success', `已连接 ${device.name || '心率设备'}`);
      if (!state.privacyAck) {
        state.privacyAck = true; saveSettings();
        toast('info', '提示：心率会作为一段文字随提示词发给你配置的模型服务商，不会发到别处。不想发送时，在悬浮窗的健康设备页关掉“发给模型”。');
      }
      return true;
    } catch (err) {
      if (err && err.name === 'NotFoundError') { toast('info', CONNECT_HELP); return false; }
      console.warn(LOG, 'connect failed', err); toast('error', `连接失败：${err && err.message ? err.message : err}`);
      return false;
    }
  }
  function disconnect() {
    stopAdvertisementWatch();
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
  function baselineInfo() {
    if (state.manualBaseline) return { bpm: state.manualBaseline.bpm, hrv: state.manualBaseline.hrv || null, method: 'manual', n: 0 };
    return HeartlinkCore.sessionBaseline(state.samples, state.activityLog, Date.now());
  }
  function setManualBaseline() {
    const r = HeartlinkCore.manualBaseline(state.samples, Date.now());
    if (!r.ok) { toast('warning', `还不能记基线：${r.reason}`); return null; }
    state.manualBaseline = { bpm: r.bpm, hrv: r.hrv };
    saveSettings(); render();
    toast('success', `手动基线：${r.bpm} bpm${r.hrv ? `，HRV ${r.hrv} ms` : ''}（覆盖自动基线）`);
    return state.manualBaseline;
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
    if (own) return own === 'character' ? 'character' : 'author';
    const h = cardHints();
    return h && h.mode ? h.mode : 'author';
  }
  function setMode(mode) {
    mode = HeartlinkCore.normalizeMode(mode) || mode;
    if (!HeartlinkCore.MODES.includes(mode)) throw new Error('mode must be backstage | in-story (or author | character)');
    state.modes[chatId()] = mode; saveSettings(); render(); emit('bio:state', getState());
    toast('info', mode === 'author' ? '模式：幕后（角色不知道，只影响写法）' : '模式：入戏（角色能察觉你的身体状态）');
    return mode;
  }
  function toggleMode() { return setMode(getMode() === 'author' ? 'character' : 'author'); }

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
  function saveChatVariable(extra) {
    const value = Object.assign({ v: HeartlinkCore.SPEC_VERSION, source: HeartlinkCore.SOURCE, updatedAt: Date.now(), mode: getMode(), baseline: (baselineInfo() || {}).bpm || null, turns: history(), lastSignal: lastSignal() }, extra || {});
    try {
      if (typeof insertOrAssignVariables === 'function') { insertOrAssignVariables({ bio: value }, { type: 'chat' }); return; }
      const c = ctx(); if (!c || !c.chatMetadata) return;               // 核心回退：写元数据，用元数据保存接口（1.13.3+ 有 debounced），不整聊天保存
      c.chatMetadata.variables = c.chatMetadata.variables || {};
      c.chatMetadata.variables.bio = value;
      if (typeof c.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
      else if (typeof c.saveMetadata === 'function') c.saveMetadata();
    } catch (err) { console.warn(LOG, 'saveChatVariable failed', err); }
  }
  // 把刚结束的读回复摘要写到那条 AI 消息上：导出 JSONL 时每条消息自带数据
  function attachSummaryToMessage(summary) {
    try {
      const c = ctx(); if (!c || !c.chat) return;
      for (let i = c.chat.length - 1; i >= 0; i--) {
        const m = c.chat[i];
        if (m.is_user) continue;
        // 0.7.2：不再主动调 saveChat（完整性检查 + 保存锁风险，见 docs/st-compat-audit-2026-09.md §4）；
        // 此刻用户消息已由酒馆落盘，这里写的数据会随本轮回复结束时酒馆自己的保存一起落盘
        HeartlinkCore.attachBio(m, Object.assign({}, summary, { v: HeartlinkCore.SPEC_VERSION, source: HeartlinkCore.SOURCE, mode: getMode() }));
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
      const reasoning = (m.extra && m.extra.reasoning) || ((m.mes || '').match(/<(?:[a-z_]*)thinking>([\s\S]*?)<\/(?:[a-z_]*)thinking>/i) || [])[1] || '';
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
  function compose(now) {
    const replyMeta = state.replyMeta || null;
    const cjk = Boolean(replyMeta && typeof replyMeta.cjkRatio === 'number' && replyMeta.cjkRatio >= CONFIG.CJK_RATIO_THRESHOLD);
    const defaultCps = cjk ? HeartlinkCore.CONFIG.READ_CPS_CJK : HeartlinkCore.CONFIG.READ_CPS_LATIN;
    const cpsOverride = HeartlinkCore.estimateCps({ history: history(), defaultCps });
    return HeartlinkCore.composeContext({ samples: state.samples, events: state.events, activityLog: state.activityLog, now: now || Date.now(), mode: getMode(), baselineOverride: state.manualBaseline, history: history(), replyMeta, cpsOverride, kinds: kinds(), deviceLines: deviceLines(), extraLines: [hapticsLine()].filter(Boolean), meta: sourceMeta(), prior: state.prior || null });
  }
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
  function injectContext(sendT) {
    if (state.injectEnabled === false) { clearInject(); return; }
    // 没有生理数据时，只有触觉状态值得告诉模型（TBC v0.3 §5.8）：开着触觉或连着设备就照常注入，其余行为 n/a
    if (!state.samples.length && !hapticsLine()) { console.log(LOG, 'no heart-rate data; nothing injected'); return; }
    if (state.continueGen && state.lastInjectText) {          // 0.7.2：continue 没有新的读回复相位，只重放上一次的块，不记摘要、不进历史
      const via = doInject(state.lastInjectText);
      if (via) console.log(LOG, `continue: re-injected previous bio_context via ${via}`);
      return;
    }
    const now = sendT || Date.now();
    const composed = compose(now);
    let text = composed.text;
    if (!HeartlinkCore.isFresh(state.lastSample, now)) text = text.replace('</bio_context>', 'warn: device silent >10s at send; recent phases may be incomplete\n</bio_context>');
    const via = doInject(text);
    if (!via) { console.warn(LOG, 'no injection API available'); return; }
    state.injectedFor = now; state.lastInjectAt = Date.now();
    const h = history();
    const dup = composed.summary && h.length && h[h.length - 1].readStart === composed.summary.readStart; // 同一段“读回复”只记一次（重复发送 / 重roll）
    if (composed.summary && state.lastSummarizedSend !== now && !dup) {
      state.lastSummarizedSend = now;
      h.push(composed.summary); if (h.length > CONFIG.HISTORY_MAX) h.splice(0, h.length - CONFIG.HISTORY_MAX);
      saveChatVariable({ last: composed.summary });
      attachSummaryToMessage(composed.summary);
    }
    state.lastInjectText = text;
    bridgeState();
    if (state.lastEmittedSend !== now) { state.lastEmittedSend = now; emit('bio:inject', { text, mode: getMode(), summary: composed.summary }); }   // 0.8.1：一次发送只广播一次（注入本身仍在三个事件上各做一次，酒馆只取最后一次）
    console.log(LOG, `injected bio_context via ${via}:\n` + text);
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

    bind(events.GENERATION_STARTED, (type, option, dryRun) => {
      if (dryRun) return;
      const kind = String(type == null ? '' : type);
      if (!userKinds.has(kind)) { state.backgroundGen = true; clearInject(); state.backgroundSkipped = (state.backgroundSkipped || 0) + 1; pushEvent('background_gen', { kind }); return; }
      state.backgroundGen = false; state.generating = true; state.streamStarted = false; state.reasoningEnded = false;
      try { const ch = (ctx() || {}).chat || []; const lu = [...ch].reverse().find((m) => m.is_user); if (lu && safeWordHit(lu.mes) && (actuators.list().some((a) => a.busy) || actuators.pending())) { actuators.stop(); toast('info', '听到了停止的话，设备已停'); } } catch (_) {}
      state.userGenActive = true;
      state.lastTrigger = kind || 'normal';
      state.continueGen = kind === 'continue' || kind === 'impersonate';
      if (state.continueGen) return;                      // continue / impersonate：不是新的一轮，不切相位（只重放上一块）
      state.lastSendT = Date.now();
      pushEvent('send', { kind: kind || 'normal' });
    });
    // 0.9.4：只在拼提示词之前注入；CHAT_COMPLETION_PROMPT_READY 时提示词已拼好，此时再注入只会残留到下一次（后台）请求里
    [events.GENERATION_AFTER_COMMANDS, events.GENERATE_BEFORE_COMBINE_PROMPTS]
      .forEach((n) => bind(n, () => { if (!state.backgroundGen && state.userGenActive) injectContext(state.lastSendT); }, true));
    bind(events.STREAM_TOKEN_RECEIVED, (text) => {
      if (!state.generating) return;
      if (!state.streamStarted) { state.streamStarted = true; pushEvent('stream_start'); }
      if (!state.reasoningEnded && typeof text === 'string' && CONFIG.REASONING_END_RE.test(text)) { state.reasoningEnded = true; pushEvent('reasoning_end', { via: 'thinking-tag' }); }
    });
    bind(events.STREAM_REASONING_DONE, () => { if (state.generating && !state.reasoningEnded) { state.reasoningEnded = true; pushEvent('reasoning_end', { via: 'api' }); } });
    const endGen = (via) => (arg) => {
      if (state.generating) {
        state.generating = false;
        if (!state.continueGen) { pushEvent('reply_end', { via }); computeReplyMeta(); bridgeState(); }
        state.continueGen = false;
        // CHARACTER_MESSAGE_RENDERED 的第一个参数是 messageId，且此时酒馆还没保存本轮聊天：同步抽 Reader Signal 就能免费落盘
        const got = via === 'rendered' ? captureReaderSignal(typeof arg === 'number' ? arg : undefined) : false;
        if (!got) host.setTimeout(() => captureReaderSignal(), 1500);   // 兜底：非流式/思维链晚到时再试一次（这次只能等下一次宿主保存）
      }
      if (state.userGenActive) clearInject();   // 0.9.4：用户可见生成结束就撤掉，后台请求不会带上
      state.backgroundGen = false; state.userGenActive = false;
    };
    bind(events.CHARACTER_MESSAGE_RENDERED, endGen('rendered'));
    bind(events.GENERATION_ENDED, (arg) => {
      const wasUser = state.userGenActive;
      endGen('ended')(arg);
      if (wasUser && !(state.genStoppedAt && state.genStoppedAt >= (state.lastSendT || 0))) host.setTimeout(actOnReply, 400);
    });
    bind(events.GENERATION_STOPPED, (arg) => { state.genStoppedAt = Date.now(); endGen('stopped')(arg); });
    bind(events.MESSAGE_SWIPED, () => pushEvent('swipe'));
    bind(events.CHAT_CHANGED, () => {
      const id = chatId();
      if (state.chatIdSeen !== id) { state.events.length = 0; state.generating = false; state.replyMeta = null; state.chatIdSeen = id; pushEvent('chat_changed', { id }); loadHistoryFromChat(); }
      else pushEvent('chat_reloaded');
      host.setTimeout(render, 300);
    });
    console.log(LOG, 'bound tavern events via', typeof eventOn === 'function' ? 'tavern-helper' : 'st-core');
  }

  function bindHostEvents() {
    const ta = doc.getElementById('send_textarea');
    if (ta) {
      const onInput = () => {
        const now = Date.now();
        const len = (ta.value || '').length;
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
    // 没有 Worker 计时时，后台页的计时会被浏览器压慢，玩具可能停不下来：页面一藏起来就全停
    const onHideStop = () => { if (doc.visibilityState === 'hidden' && hTimers.kind === 'page') { try { actuators.stop(); } catch (_) {} } };
    doc.addEventListener('visibilitychange', onHideStop);
    disposers.push(() => doc.removeEventListener('visibilitychange', onHideStop));
  }

  // ---------- 悬浮窗（Shadow DOM，底色取酒馆主题变量；强调色固定，避免主题色是灰色时看不出状态） ----------
  // ST 1.18 的 style.css 给 html 加了 transform:translateZ(0) 且 html 高度为 0，fixed 元素改以 html 为包含块，
  // 用 bottom 定位会跑到屏幕上方外面；所以用视口单位算 top（2026-09-17 本地实测 top:-118px）。
  const CSS = `
:host{all:initial;position:fixed;right:14px;top:calc(100vh - 122px);top:calc(100dvh - 122px);z-index:9999;
  --font:var(--mainFontFamily,-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif);
  --mono:var(--monoFontFamily,ui-monospace,"SF Mono",Menlo,monospace);
  --ink:var(--SmartThemeBodyColor,#e8e6ee);
  --surface:var(--SmartThemeBlurTintColor,rgba(22,22,28,.94));
  --raise:rgba(255,255,255,.055);--raise2:rgba(255,255,255,.09);--hair:rgba(255,255,255,.09);
  --muted:rgba(232,230,238,.58);
  --heart:#ef5a55;--teal:#2bb8a8;--teal-soft:rgba(43,184,168,.16);--pink:#ff6fa3;--pink-soft:rgba(255,111,163,.16);--amber:#e8a23c;
  font-family:var(--font);color:var(--ink)}
*{box-sizing:border-box}
button{font:inherit;color:inherit}
button:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
[hidden]{display:none!important}
/* 胶囊 */
.pill{display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 12px 0 5px;border-radius:999px;background:var(--surface);border:1px solid var(--hair);
  box-shadow:0 8px 28px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.06);backdrop-filter:blur(16px) saturate(1.2);cursor:pointer;white-space:nowrap;user-select:none;transition:transform .15s ease}
.pill:hover{transform:translateY(-1px)}
.seg{display:inline-flex;align-items:center;gap:7px}
.segsep{width:1px;height:16px;background:var(--hair)}
.dot{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;flex:0 0 auto}
.heart{background:var(--heart);box-shadow:0 0 0 0 rgba(239,90,85,.45)}
.heart.on{animation:pulse var(--beat,1s) infinite}
.heart.stale{background:var(--amber)}
.heart.off{background:rgba(255,255,255,.14)}
.heart svg{width:13px;height:13px;fill:#fff}
.toyd{background:var(--pink-soft);color:var(--pink)}
.toyd svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(239,90,85,.45)}70%{box-shadow:0 0 0 8px rgba(239,90,85,0)}100%{box-shadow:0 0 0 0 rgba(239,90,85,0)}}
.bpm{font:700 15px/1 var(--mono);font-variant-numeric:tabular-nums;min-width:24px}
.spark{width:46px;height:16px;flex:0 0 auto}
.spark path{fill:none;stroke:var(--heart);stroke-width:1.6;stroke-linejoin:round;stroke-linecap:round}
.spark line{stroke:currentColor;opacity:.35;stroke-dasharray:2 2}
.delta{font:600 11px/1 var(--mono);color:var(--teal)}
.delta.up{color:var(--amber)}
.tag{font-size:12px;color:var(--muted)}
.tag.ch{color:var(--pink)}
.tn{font:700 13px/1 var(--mono)}
.live{width:7px;height:7px;border-radius:50%;background:var(--pink);box-shadow:0 0 0 3px var(--pink-soft);display:none}
.live.on{display:inline-block;animation:blink 1.2s infinite}
@keyframes blink{50%{opacity:.35}}
/* 面板 */
.card{display:none;position:absolute;right:0;bottom:46px;width:304px;max-height:560px;overflow:auto;overscroll-behavior:contain;background:var(--surface);border:1px solid var(--hair);border-radius:18px;padding:10px;
  box-shadow:0 18px 48px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.05);backdrop-filter:blur(20px) saturate(1.2);font-size:12.5px;line-height:1.45}
:host(.open) .card{display:block;animation:rise .16s ease-out}
:host(.below) .card{bottom:auto;top:46px}
:host(.dragging) .pill{cursor:grabbing}
:host(.hidden){display:none!important}
@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.heart.on,.live.on,:host(.open) .card{animation:none}.pill{transition:none}}
.head{display:flex;gap:8px;align-items:center;margin-bottom:10px}
.tabs{flex:1;display:grid;grid-template-columns:1fr 1fr;padding:3px;border-radius:12px;background:var(--raise)}
.tabs button{border:0;background:transparent;border-radius:9px;padding:7px 4px;font-size:12.5px;font-weight:600;color:var(--muted);cursor:pointer;display:flex;gap:6px;justify-content:center;align-items:center}
.tabs button[aria-selected="true"]{background:var(--raise2);color:var(--ink);box-shadow:0 1px 3px rgba(0,0,0,.25)}
.tabs i{font-style:normal;font:600 10px/1 var(--mono);padding:3px 6px;border-radius:999px;background:var(--teal-soft);color:var(--teal)}
.tabs i:empty{display:none}
.tabs i.warn{background:rgba(232,162,60,.16);color:var(--amber)}
.tabs i.pk{background:var(--pink-soft);color:var(--pink)}
.x{width:30px;height:30px;border-radius:10px;border:0;background:var(--raise);cursor:pointer;font-size:16px;line-height:1;color:var(--muted)}
.x:hover{color:var(--ink);background:var(--raise2)}
.block{background:var(--raise);border-radius:14px;padding:10px 12px;margin-bottom:8px}
.status{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted)}
.status b{color:var(--ink);font-weight:600}
.sdot{width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.25)}
.sdot.ok{background:var(--teal);box-shadow:0 0 0 3px var(--teal-soft)}
.sdot.warn{background:var(--amber)}
.chip{margin-left:auto;font:600 10.5px/1 var(--mono);padding:3px 7px;border-radius:999px;background:var(--raise2);color:var(--muted)}
.chip:empty{display:none}
.big{display:flex;align-items:baseline;gap:6px;margin:6px 0 2px}
.big .n{font:700 34px/1 var(--mono);font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.big .u{color:var(--muted);font-size:12px}
.big .d{margin-left:auto;font:600 12px/1 var(--mono);color:var(--teal)}
.big .d.up{color:var(--amber)}
.wide{width:100%;height:38px;display:block}
.wide path{fill:none;stroke:var(--heart);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.wide path.area{fill:rgba(239,90,85,.12);stroke:none}
.wide .ref{stroke:rgba(255,255,255,.35);stroke-width:1;stroke-dasharray:3 3;vector-effect:non-scaling-stroke}
.reflab{fill:rgba(255,255,255,.5);font:9px var(--mono)}
.empty{color:var(--muted);font-size:12.5px;line-height:1.55;margin:2px 0 10px}
.trend{display:block;width:100%;height:auto;margin-top:8px;border-radius:8px}
.trend .ln{fill:none;stroke:var(--heart);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.trend .ref{stroke:rgba(255,255,255,.45);stroke-width:1;stroke-dasharray:3 3}
.trend .pk{fill:#fff}
.trend .pkt{fill:var(--ink);font:600 8.5px var(--mono);text-anchor:middle}
.trend .cur{fill:var(--heart)}
.trend .cur.live{fill:var(--pink);animation:blink 1.2s infinite}
.pseg{display:grid;gap:4px;margin-top:5px}
.sg{min-width:0;display:flex;gap:1px;height:5px;border-radius:3px;overflow:hidden;opacity:.75}
.sg.on{opacity:1}
.sg i.on{background-image:repeating-linear-gradient(90deg,rgba(255,255,255,.4) 0 4px,transparent 4px 8px)!important;animation:blink 1.4s infinite}
.plist{margin-top:8px;display:grid;gap:3px}
.pr{display:grid;grid-template-columns:8px auto auto 1fr;align-items:center;gap:6px;font-size:11.5px;min-width:0}
.pr i{width:8px;height:8px;border-radius:2px}
.pr b{font-weight:600}
.pr em{font:10.5px var(--mono);font-style:normal;color:var(--muted)}
.pr.on em{color:var(--pink)}
.pr span{font:10.5px var(--mono);color:var(--muted);text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pnote{color:var(--muted);font-size:11.5px;margin:6px 0 0}
.baselab{display:flex;align-items:center;gap:6px;width:100%;margin-top:8px;border:0;background:transparent;padding:2px 0;cursor:pointer;font-size:11.5px;color:var(--muted);text-align:left}
.baselab i{width:18px;border-top:1px dashed rgba(255,255,255,.6)}
.baselab span{font:600 11.5px var(--mono);color:var(--ink)}
.baselab em{margin-left:auto;font-style:normal;color:var(--teal)}
.baselab:hover em{text-decoration:underline}
.basemenu{display:flex;gap:6px;margin-top:8px}
.basemenu button{flex:1;border:1px solid var(--hair);background:var(--raise2);border-radius:9px;padding:6px;font-size:12px;cursor:pointer}
.basemenu button:hover{border-color:var(--teal);color:var(--teal)}
.tiles{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px}
.tile{background:var(--raise);border-radius:12px;padding:8px 10px;min-width:0}
.tile span{display:block;font-size:11px;color:var(--muted);margin-bottom:3px}
.tile b{display:block;font:600 13px/1.25 var(--mono);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tile b i{font-style:normal;color:var(--muted);font-weight:400;font-size:11px}
.quote{border-left:2px solid var(--pink);padding:6px 10px;margin-bottom:8px;background:var(--pink-soft);border-radius:0 12px 12px 0;font-size:12px;max-height:5.6em;overflow:auto}
.quote span{display:block;font-size:10.5px;color:var(--pink);font-weight:600;margin-bottom:2px}
.list{background:var(--raise);border-radius:14px;padding:2px 12px;margin-bottom:8px}
.item{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:40px;border-bottom:1px solid var(--hair)}
.item:last-child{border-bottom:0}
.item .lab{display:flex;flex-direction:column}
.item .lab small{color:var(--muted);font-size:10.5px}
.switch{width:40px;height:24px;border-radius:999px;border:0;background:rgba(255,255,255,.18);position:relative;cursor:pointer;flex:0 0 auto;transition:background .15s}
.switch::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.35);transition:left .15s}
.switch[aria-checked="true"]{background:var(--teal)}
.switch[aria-checked="true"]::after{left:19px}
.segctl{display:inline-grid;grid-auto-flow:column;padding:2px;border-radius:9px;background:rgba(0,0,0,.22)}
.segctl button{border:0;background:transparent;border-radius:7px;padding:4px 9px;font-size:11.5px;font-weight:600;color:var(--muted);cursor:pointer}
.segctl button.on{background:var(--teal);color:#fff}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px}
.btn{border:1px solid var(--hair);background:var(--raise);border-radius:11px;padding:9px 8px;font-size:12.5px;font-weight:600;cursor:pointer;text-align:center;transition:background .12s}
.btn:hover{background:var(--raise2)}
.btn.primary{background:var(--teal);border-color:var(--teal);color:#fff}
.btn.primary:hover{filter:brightness(1.08)}
.btn.on{border-color:var(--teal);color:var(--teal);background:var(--teal-soft)}
.btn.full{grid-column:1/-1;width:100%}
.btn small{display:block;font-weight:400;font-size:10.5px;color:var(--muted);margin-top:1px}
.btn.on small{color:var(--teal)}
.stop{width:100%;border:0;border-radius:14px;padding:12px;margin-bottom:8px;background:linear-gradient(180deg,#f0625d,#d9463f);color:#fff;font-size:14px;font-weight:700;letter-spacing:.08em;cursor:pointer;box-shadow:0 6px 18px rgba(217,70,63,.35)}
.stop:hover{filter:brightness(1.06)}
.stop:active{transform:translateY(1px)}
.expander{width:100%;display:flex;justify-content:space-between;align-items:center;border:0;background:var(--raise);border-radius:12px;padding:9px 12px;font-size:12.5px;font-weight:600;cursor:pointer;margin-bottom:8px}
.expander::after{content:"›";color:var(--muted);font-size:16px;transition:transform .15s}
:host(.devs) .expander::after{transform:rotate(90deg)}
.devs{display:none;background:var(--raise);border-radius:12px;padding:6px 12px 8px;margin:-4px 0 8px;max-height:15em;overflow:auto}
:host(.devs) .devs{display:block}
.devs b{display:block;margin:6px 0 2px;font-size:12px}
.devs label{display:flex;gap:8px;align-items:center;cursor:pointer;padding:3px 0;font-size:12px}
.devs label i{font-style:normal;color:var(--muted);font:10.5px var(--mono)}
.devs input{accent-color:var(--teal);margin:0;width:15px;height:15px}
.help{display:none;margin:0 0 8px;padding:8px 12px 8px 26px;border-radius:12px;background:var(--raise);font-size:12px;max-height:14em;overflow:auto}
:host(.help) .help{display:block}
.help li{margin:3px 0}
.help li.error b{color:var(--heart)}
.help li.warn b{color:var(--amber)}
.foot{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:center;padding:4px 4px 0;color:var(--muted);font-size:11.5px}
.foot button{border:0;background:transparent;padding:0;cursor:pointer;color:var(--muted);font-size:11.5px}
.foot button:hover{color:var(--ink)}
.foot .ver{margin-left:auto;font:10.5px var(--mono);opacity:.7}
.foot .warn{color:var(--amber)}`;
  const HEART_SVG = '<svg viewBox="0 0 24 24"><path d="M12 21s-7-4.6-9.3-8.6C.6 8.7 2.6 4.5 6.6 4.5c2 0 3.4 1.1 4.1 2.2.7-1.1 2.1-2.2 4.1-2.2 4 0 6 4.2 3.9 7.9C19 16.4 12 21 12 21z"/></svg>';
  const WAVE_SVG = '<svg viewBox="0 0 24 24"><path d="M3 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0"/></svg>';

  let hostEl = null, root = null, el = {};
  function mountBadge() {
    const old = doc.getElementById(CONFIG.HOST_ID); if (old) old.remove();
    hostEl = doc.createElement('div'); hostEl.id = CONFIG.HOST_ID;
    root = hostEl.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style>
<div class="card" part="card" role="dialog" aria-label="heartlink 悬浮窗">
  <div class="head">
    <div class="tabs" role="tablist">
      <button role="tab" data-tab="hr">健康设备<i data-f="hrBadge"></i></button>
      <button role="tab" data-tab="toy">玩具<i data-f="toyBadge" class="pk"></i></button>
    </div>
    <button class="x" data-close title="收起" aria-label="收起">×</button>
  </div>

  <section data-pane="hr">
    <div data-f="hrEmpty">
      <p class="empty">还没连接设备。手环 / 心率带要先打开“心率广播”，并用桌面版 Chrome 或 Edge。</p>
      <div class="row2"><button class="btn primary full" data-act="hr">连接设备</button></div>
    </div>
    <div data-f="hrLive">
      <div class="block">
        <div class="status"><span class="sdot" data-f="hrDot"></span><b data-f="dev">--</b><span data-f="hrState"></span><span class="chip" data-f="batt"></span></div>
        <svg class="trend" viewBox="0 0 260 56" data-f="tsvg" aria-label="本轮心率走势，底色为相位"></svg>
        <div class="pseg" data-f="pseg"></div>
        <div class="plist" data-f="plist"></div>
        <p class="pnote" data-f="pnote" hidden>发出第一条消息后，这里按相位分段显示。</p>
        <button class="baselab" data-act="basemenu" title="平静心率：虚线的位置；右上角的百分比也是和它比。点一下可以记下或改回自动"><i></i><span data-f="base">平静心率 --</span><em>调整</em></button>
        <div class="basemenu" data-f="baseMenu" hidden>
          <button data-act="baseline">记下现在为平静</button><button data-act="clear">改回自动计算</button>
        </div>
      </div>
      <div class="tiles">
        <div class="tile"><span>心率变异</span><b data-f="hrv">--</b></div>
        <div class="tile"><span>最近几轮峰值</span><b data-f="last">--</b></div>
      </div>
      <div class="quote" data-f="sigBox"><span>模型上一轮的判断</span><div data-f="sig">--</div></div>
    </div>
    <div class="list">
      <div class="item"><div class="lab">模式<small data-f="modeHint">角色能察觉你的身体状态</small></div>
        <div class="segctl"><button data-set="mode:author">幕后</button><button data-set="mode:character">入戏</button></div></div>
      <div class="item"><div class="lab">发给模型<small>每轮随提示词发送设备数据</small></div><button class="switch" role="switch" data-act="inject" aria-label="发给模型"></button></div>
    </div>
    <div class="row2" data-f="hrTools">
      <button class="btn full" data-act="disconnect">断开设备</button>
    </div>
    <ul class="help" data-f="help"></ul>
  </section>

  <section data-pane="toy">
    <button class="stop" data-act="halt">全部停止</button>
    <p class="empty" data-f="toyEmpty">还没连玩具：打开“剧情联动”，再选一种连接方式。两种方式能连的型号相同（buttplug 设备库）。</p>
    <div class="tiles" data-f="toyTiles">
      <div class="tile"><span>正在运行</span><b data-f="now">--</b></div>
      <div class="tile"><span>上一条回复的动作</span><b data-f="lastact">--</b></div>
    </div>
    <div class="list">
      <div class="item"><div class="lab">剧情联动<small>回复里的动作可以让玩具动</small></div><button class="switch" role="switch" data-act="vib" aria-label="剧情联动"></button></div>
      <div class="item"><div class="lab">节奏</div><div class="segctl"><button data-set="profile:slow-burn">慢热</button><button data-set="profile:frenzy">狂暴</button></div></div>
      <div class="item"><div class="lab">强度上限</div><div class="segctl"><button data-set="cap:0.3">30%</button><button data-set="cap:0.6">60%</button><button data-set="cap:1">100%</button></div></div>
    </div>
    <div class="row2">
      <button class="btn" data-act="toy" title="推荐：先装好 Intiface Central、点 Start Server 并在里面连上玩具">通过 Intiface<small data-f="out">推荐 · 未连接</small></button>
      <button class="btn" data-act="wasm" title="不装 Intiface：Chrome 直接用蓝牙连玩具（支持的型号与 Intiface 相同）。测试功能，未经真实设备验证">浏览器直接连<small data-f="wasmState">不装软件 · 测试</small></button>
      ${DEV_TOOLS ? '<button class="btn full" data-act="lab" title="打开设备模拟器小窗口（本机 device-lab，先运行 npm run sim）">设备模拟器</button>' : ''}
    </div>
    <button class="expander" data-act="devs">选择设备<span></span></button>
    <div class="devs" data-f="devs"></div>
  </section>

  <div class="foot">
    <button data-act="help" data-f="helpBtn">排查问题</button>
    <button data-act="preview">查看发送内容</button>
    <button data-act="hide">隐藏悬浮窗</button>
    <span class="ver">v${VERSION} <span data-f="foot"></span></span>
  </div>
</div>
<div class="pill" part="pill" title="heartlink">
  <span class="seg" data-seg="hr">
    <span class="dot heart off">${HEART_SVG}</span>
    <span class="bpm">--</span>
    <svg class="spark" viewBox="0 0 44 14"><line class="ref" x1="0" y1="8" x2="44" y2="8"/><path d=""/></svg>
    <span class="delta"></span>
    <span class="tag">未连接</span>
  </span>
  <span class="segsep"></span>
  <span class="seg" data-seg="toy"><span class="dot toyd">${WAVE_SVG}</span><span class="tn">--</span><span class="live"></span></span>
  <span class="seg" data-seg="none"><span class="dot heart off">${HEART_SVG}</span><span class="tag">连接设备</span></span>
</div>`;
    const q = (s) => root.querySelector(s);
    el = { heart: q('[data-seg="hr"] .heart'), bpm: q('.bpm'), poly: q('.spark path'), sparkRef: q('.spark .ref'), delta: q('.delta'), tag: q('[data-seg="hr"] .tag'), pill: q('.pill'), spark: q('.spark') };
    ['base', 'read', 'hrv', 'last', 'dev', 'out', 'sig', 'sigBox', 'foot', 'hrBadge', 'toyBadge', 'hrEmpty', 'hrLive', 'hrDot', 'hrState', 'batt', 'tsvg', 'pseg', 'plist', 'pnote', 'baseMenu', 'modeHint', 'hrTools', 'toyEmpty', 'toyTiles', 'now', 'lastact', 'wasmState', 'help', 'devs', 'helpBtn']
      .forEach((f) => { el[f] = q(`[data-f="${f}"]`); });
    el.seg = { hr: q('[data-seg="hr"]'), toy: q('[data-seg="toy"]'), none: q('[data-seg="none"]') };
    el.segsep = q('.segsep');
    el.tn = q('.tn'); el.live = q('.live');
    el.tabs = [...root.querySelectorAll('[data-tab]')];
    el.panes = [...root.querySelectorAll('[data-pane]')];
    el.sets = [...root.querySelectorAll('[data-set]')];
    el.injSw = q('[data-act="inject"]'); el.vibSw = q('[data-act="vib"]');
    el.toyBtn = q('[data-act="toy"]'); el.wasmBtn = q('[data-act="wasm"]'); el.offBtn = q('[data-act="disconnect"]');
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
      const setBtn = t.closest && t.closest('[data-set]');
      if (setBtn) {
        const [key, val] = setBtn.getAttribute('data-set').split(':');
        if (key === 'mode') { if (getMode() !== val) setMode(val); return; }
        if (key === 'profile') { if (hapticsPolicy().profile !== val) { setHaptics({ profile: val }); toast('info', `节奏：${val === 'frenzy' ? '狂暴' : '慢热'}`); } return; }
        if (key === 'cap') { setHaptics({ maxIntensity: Number(val) }); return; }
        return;
      }
      const btn = t.closest && t.closest('[data-act]');
      if (btn) {
        const act = btn.getAttribute('data-act');
        if (act === 'help') { hostEl.classList.toggle('help'); return render(); }
        if (act === 'devs') { hostEl.classList.toggle('devs'); return render(); }
        if (act === 'lab') {
          const win = host.open(CONFIG.LAB_URL, 'tbc-device-lab', 'popup=yes,width=1180,height=820');
          if (!win) toast('warning', '浏览器拦下了弹出窗口：请允许本站弹窗，或直接打开 ' + CONFIG.LAB_URL);
          else toast('info', `模拟器已在小窗口打开，页面顶部会显示扩展是否已接入。${hTimers.kind === 'worker' ? '酒馆页被挡住或切到后台时，触觉计时照常。' : '注意：这个浏览器不支持后台计时，切走酒馆页时强度帧会变慢。'}`);
          return;
        }
        if (act === 'wasm') { if (WASM.client) { stopWasm(); toast('info', '已断开浏览器直接连'); } else { toast('info', '测试功能：正在加载直连组件（约数 MB），稍后浏览器会弹出蓝牙设备选择。还没有经过真实设备测试，遇到问题请到仓库反馈。'); startWasm(); } return; }
        if (act === 'inject') { setExposure({ inject: state.injectEnabled === false }); toast('info', state.injectEnabled === false ? '已停止发给模型：模型收不到设备数据' : '已恢复发给模型'); return; }
        if (act === 'vib') { const on = !state.haptics.enabled; setHaptics({ enabled: on }); if (on) askProfile(); toast(on ? 'warning' : 'info', on ? `剧情联动已打开：回复里的动作和脚本可以让玩具动，强度不超过 ${Math.round(state.haptics.maxIntensity * 100)}%。随时点“全部停止”。` : '剧情联动已关闭，玩具已停'); return; }
        if (act === 'toy') { const on = !state.haptics.intiface.enabled; setHaptics({ intiface: { enabled: on } }); toast('info', on ? `正在连接 Intiface（${state.haptics.intiface.url}）；先在 Intiface Central 里点 Start Server` : '已断开 Intiface'); return; }
        if (act === 'hide') { setBadgeHidden(true); toast('info', '悬浮窗已隐藏。要恢复：点酒馆左下角的魔杖菜单 → “显示 heartlink 悬浮窗”。'); return; }
        if (act === 'halt') { actuators.stop(); closePanel(); toast('info', '已停止所有设备'); return; }
        if (act === 'preview') { console.log(LOG, 'preview:\n' + compose().text); toast('info', '这一轮要发给模型的内容已打印到浏览器控制台'); return; }
        if (act === 'basemenu') { el.baseMenu.hidden = !el.baseMenu.hidden; return; }
        if (act === 'baseline') { el.baseMenu.hidden = true; return setManualBaseline(); }
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
    doc.body.appendChild(hostEl);
    placeBadge();
    hostEl.classList.toggle('hidden', !!state.badgeHidden);
    syncMenuItem();
    // 拖动：按住胶囊移动超过 5 像素才算拖动；位置记在设置里（离右边、离上边的像素）
    let dragged = false;
    const pill = q('.pill');
    pill.style.touchAction = 'none';
    pill.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const r = hostEl.getBoundingClientRect();
      const start = { x: e.clientX, y: e.clientY, right: host.innerWidth - r.right, top: r.top };
      let moving = false;
      const move = (ev) => {
        const dx = ev.clientX - start.x; const dy = ev.clientY - start.y;
        if (!moving && Math.hypot(dx, dy) < 5) return;
        if (!moving) { moving = true; hostEl.classList.add('dragging'); hostEl.classList.remove('open'); }
        state.badgePos = { right: start.right - dx, top: start.top + dy };
        placeBadge();
      };
      const up = () => {
        host.removeEventListener('pointermove', move); host.removeEventListener('pointerup', up); host.removeEventListener('pointercancel', up);
        if (moving) { dragged = true; hostEl.classList.remove('dragging'); saveSettings(); host.setTimeout(() => { dragged = false; }, 400); }
      };
      host.addEventListener('pointermove', move); host.addEventListener('pointerup', up); host.addEventListener('pointercancel', up);
    });
    const onResize = () => placeBadge();
    host.addEventListener('resize', onResize);
    disposers.push(() => host.removeEventListener('resize', onResize));
    const closeMenu = (event) => { if (hostEl && !hostEl.contains(event.target)) closePanel(); };
    doc.addEventListener('click', closeMenu, true);
    disposers.push(() => doc.removeEventListener('click', closeMenu, true));
  }
  function closePanel() {
    if (!hostEl) return;
    const was = hostEl.classList.contains('open');
    hostEl.classList.remove('open', 'help', 'devs');
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
  function fitPanel() {
    const card = root && root.querySelector('.card');
    if (!card) return;
    const r = hostEl.getBoundingClientRect();
    const above = r.top - 16; const below = host.innerHeight - r.bottom - 16;
    const down = below > above;
    hostEl.classList.toggle('below', down);
    card.style.maxHeight = `${Math.max(180, Math.floor(down ? below : above) - 44)}px`;
  }
  // 胶囊与面板里的走势线：虚线是平静心率，曲线相对它上下浮动（百分比也是和它比）
  function sparkPath(ref) {
    const now = Date.now();
    const pts = HeartlinkCore.series(state.samples, now - 60000, now).map((v) => (v === '·' ? null : v));
    const d = HeartlinkCore.sparkPath(pts, 44, 14, 6, ref);
    return { d, refY: HeartlinkCore.sparkPath.refY };
  }
  // 本轮相位（与注入块同一套边界，HeartlinkCore.buildTurn）：
  //   看生成 = 等首字 → 思维链 → 正文（非流式时只有一段）；读回复；写消息；离开（页面切走 / 长时间没操作）不计
  const PH = {
    wait: { name: '等首字', color: '#5e6bb8' }, think: { name: '思维链', color: '#9a86f0' }, body: { name: '正文', color: '#7c8cf0' }, gen: { name: '看生成', color: '#7c8cf0' },
    read: { name: '读回复', color: '#ef5a55' }, write: { name: '写消息', color: '#ff6fa3' },
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
  function renderPhases(base, now) {
    const { groups, away } = phaseModel(now);
    const t0 = groups.length ? groups[0].a : now - 180000;
    const t1 = groups.length ? groups[groups.length - 1].b : now;
    const span = Math.max(1000, t1 - t0);
    const pts = state.samples.filter((x) => x.t >= t0 && x.t <= t1);
    const W = 260, H = 56, N = 52;
    const buckets = Array.from({ length: N }, () => []);
    for (const x of pts) buckets[Math.min(N - 1, Math.floor((x.t - t0) / span * N))].push(x.bpm);
    const vals = buckets.map((b) => (b.length ? b.reduce((m, v) => m + v, 0) / b.length : null));
    const nums = vals.filter((v) => v != null).concat(base ? [base.bpm] : []);
    let lo = nums.length ? Math.min(...nums) : 60; let hi = nums.length ? Math.max(...nums) : 100;
    if (hi - lo < 12) lo -= (12 - (hi - lo)) / 2, hi = lo + 12;
    hi += (hi - lo) * 0.18;   // 顶部留出峰值标注的位置
    const X = (tt) => Math.max(0, Math.min(W, (tt - t0) / span * W));
    // 自己画线（和纵轴一致，给峰值留头部空间）
    const d = HeartlinkCore.sparkPath(vals.concat([]), W, H, 12, base ? base.bpm : null) && (() => {
      const xy = vals.map((v, i) => (v == null ? null : [(i + 0.5) * W / N, H - 1.5 - (v - lo) / (hi - lo) * (H - 3)]));
      let out = ''; let pen = false;
      for (const q of xy) { if (!q) { pen = false; continue; } out += `${pen ? 'L' : 'M'}${q[0].toFixed(1)},${q[1].toFixed(1)}`; pen = true; }
      return out;
    })();
    const refY = base ? +(H - 1.5 - (base.bpm - lo) / (hi - lo) * (H - 3)).toFixed(1) : null;
    const Y = (v) => H - 1.5 - (v - lo) / (hi - lo) * (H - 3);
    let svg = '<defs><pattern id="hlaway" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2" height="5" fill="rgba(255,255,255,.14)"/></pattern></defs>';
    for (const g of groups) for (const sb of g.subs) svg += `<rect x="${X(sb.a).toFixed(1)}" y="0" width="${Math.max(1, X(sb.b) - X(sb.a)).toFixed(1)}" height="${H}" fill="${PH[sb.k].color}" fill-opacity="${sb.live ? 0.2 : 0.11}"/>`;
    for (const [a, b] of away) if (b > t0 && a < t1) svg += `<rect x="${X(a).toFixed(1)}" y="0" width="${Math.max(1, X(b) - X(a)).toFixed(1)}" height="${H}" fill="url(#hlaway)"/>`;
    if (refY != null) svg += `<line x1="0" x2="${W}" y1="${refY}" y2="${refY}" class="ref"/>`;
    if (d) svg += `<path d="${d}" class="ln"/>`;
    const rd = groups.find((g) => g.k === 'read');
    let peak = null;
    if (rd) for (const x of pts) if (x.t >= rd.a && x.t <= rd.b && (!peak || x.bpm > peak.bpm)) peak = x;
    if (peak && d) svg += `<circle cx="${X(peak.t).toFixed(1)}" cy="${Y(peak.bpm).toFixed(1)}" r="3" class="pk"/><text x="${Math.min(W - 9, Math.max(9, X(peak.t))).toFixed(1)}" y="${Math.max(8, Y(peak.bpm) - 5).toFixed(1)}" class="pkt">${peak.bpm}</text>`;
    const liveNow = groups.some((g) => g.live);
    if (state.lastSample && d && state.lastSample.t >= t0) svg += `<circle cx="${Math.min(W - 3, X(state.lastSample.t)).toFixed(1)}" cy="${Y(state.lastSample.bpm).toFixed(1)}" r="3" class="cur${liveNow ? ' live' : ''}"/>`;
    el.tsvg.innerHTML = svg;
    el.pnote.hidden = groups.length > 0;
    const fmt = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : `${sec}s`);
    const secs = (a, b) => Math.round((b - a) / 1000);
    const awayIn = (g) => away.reduce((m, [a, b]) => m + Math.max(0, Math.min(b, g.b) - Math.max(a, g.a)), 0);
    el.pseg.style.gridTemplateColumns = groups.map((g) => `${Math.max(26, X(g.b) - X(g.a)).toFixed(0)}fr`).join(' ') || '1fr';
    el.pseg.innerHTML = groups.map((g) => `<div class="sg${g.live ? ' on' : ''}">${g.subs.map((sb) => `<i style="flex:${Math.max(1, sb.b - sb.a)};background:${PH[sb.k].color}"${sb.live ? ' class="on"' : ''}></i>`).join('')}</div>`).join('');
    el.plist.innerHTML = groups.map((g) => {
      let detail = '';
      const SHORT = { wait: '首字', think: '思考', body: '正文' };
      if (g.k === 'gen' && g.subs.length > 1) detail = g.subs.map((sb) => `${SHORT[sb.k]} ${fmt(secs(sb.a, sb.b))}`).join(' · ');
      else if (g.k === 'gen' && g.live) detail = '等待中';
      if (g.k === 'read' && peak) {
        const fl = pts.filter((x) => x.t >= g.a && x.t <= g.b);
        const up = fl.length ? fl[fl.length - 1].bpm - fl[0].bpm : 0;
        detail = `峰值 ${peak.bpm}${up >= 3 ? ' ↑' : up <= -3 ? ' ↓' : ''}`;
      }
      if (g.k === 'write' && state.lastSample) detail = `现在 ${state.lastSample.bpm}`;
      const aw = awayIn(g);
      if (aw >= 1000) detail += `${detail ? ' · ' : ''}离开 ${fmt(Math.round(aw / 1000))}（不计）`;
      return `<div class="pr${g.live ? ' on' : ''}"><i style="background:${PH[g.k].color}"></i><b>${PH[g.k].name}</b><em>${g.live ? '进行中 ' : ''}${fmt(secs(g.a, g.b))}</em><span>${detail}</span></div>`;
    }).join('');
    el.base.textContent = base ? `平静心率 ${base.bpm}（${BASE_SHORT[base.method] || base.method}）` : '平静心率：数据还不够，稍后自动算出';
  }
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const BASE_SHORT = { manual: '手动', 'quiet-median': '自动', p20: '估算' };
  function render() {
    if (!root || destroyed) return;
    const now = Date.now();
    const fresh = HeartlinkCore.isFresh(state.lastSample, now);
    const on = state.connected && fresh;
    const mode = getMode();
    const base = state.connected ? baselineInfo() : null;
    const d = on && base ? Math.round((state.lastSample.bpm - base.bpm) / base.bpm * 100) : null;
    // 胶囊：心率段
    el.heart.className = 'dot heart ' + (on ? 'on' : state.connected ? 'stale' : 'off');
    if (on) hostEl.style.setProperty('--beat', (60 / Math.max(state.lastSample.bpm, 30)) + 's');
    el.bpm.textContent = on ? String(state.lastSample.bpm) : '--';
    el.bpm.style.display = (state.connected || (state.bridgeUp && fresh)) ? '' : 'none';   // 0.9：桥送来的心率也显示
    el.spark.style.display = on ? '' : 'none';
    if (on) {
      const sp = sparkPath(base ? base.bpm : null);
      el.poly.setAttribute('d', sp.d);
      el.sparkRef.style.display = sp.refY == null ? 'none' : '';
      if (sp.refY != null) { el.sparkRef.setAttribute('y1', sp.refY); el.sparkRef.setAttribute('y2', sp.refY); }
    }
    el.delta.textContent = d != null ? `${d >= 0 ? '+' : ''}${d}%` : '';
    el.delta.title = base ? `现在比平静心率（${base.bpm}）${d >= 0 ? '高' : '低'} ${Math.abs(d || 0)}%` : '';
    el.delta.className = 'delta' + (d != null && d >= 10 ? ' up' : '');
    let tag;
    if (state.newerVersion) tag = '请刷新';   // 别的页面已装更新版本，优先提示
    else if (state.waitingForDevice && !state.connected) tag = '等设备回来';
    else if (state.reconnecting) tag = '重连中';
    else if (!state.connected) tag = state.bridgeUp && fresh ? '经本机桥' : '未连接';
    else if (!fresh) tag = `${Math.round((now - (state.lastSample ? state.lastSample.t : now)) / 1000)} 秒无数据`;
    else tag = (mode === 'author' ? '幕后' : '入戏') + (state.injectEnabled === false ? '（未发送）' : modeSource() === 'card' ? '（卡片设定）' : '');
    el.tag.textContent = tag;
    el.tag.className = 'tag' + (state.connected && fresh && mode === 'character' ? ' ch' : '');
    // 胶囊：玩具段；只显示正在用的
    const acts = actuators.list();
    const busy = acts.filter((a) => a.busy);
    const offSet = new Set(state.haptics.off || []);
    const nToy = acts.filter((a) => !offSet.has(a.id)).length;
    const hrActive = state.connected || state.reconnecting || !!state.waitingForDevice || (state.bridgeUp && fresh);
    const toyActive = nToy > 0 || busy.length > 0;   // 只在真的连上玩具时显示（开了联动但没设备不算）
    el.seg.hr.hidden = !hrActive;
    el.seg.toy.hidden = !toyActive;
    el.seg.none.hidden = hrActive || toyActive;
    el.segsep.hidden = !(hrActive && toyActive);
    el.tn.textContent = `${nToy} 路`;
    el.live.className = 'live' + (busy.length ? ' on' : '');
    const info = state.deviceInfo || {};
    el.pill.title = `heartlink ${VERSION}${state.connected ? ` · ${state.deviceName || ''}${info.firmware ? ' · fw ' + info.firmware : ''}` : ''} · 点一下打开，按住可拖动`;
    if (!hostEl.classList.contains('open')) return;   // 面板收起时不用算后面的
    fitPanel();
    // 面板：标签页
    const tab = state.badgeTab === 'toy' ? 'toy' : 'hr';   // 默认健康设备
    el.tabs.forEach((b) => b.setAttribute('aria-selected', String(b.getAttribute('data-tab') === tab)));
    el.panes.forEach((pn) => { pn.hidden = pn.getAttribute('data-pane') !== tab; });
    el.hrBadge.textContent = state.connected ? '已连接' : state.reconnecting ? '重连中' : state.waitingForDevice ? '等设备' : '';
    el.hrBadge.className = state.connected ? '' : 'warn';
    el.toyBadge.textContent = nToy ? `${nToy} 路` : '';
    // 健康设备页
    el.hrEmpty.hidden = hrActive;
    el.hrLive.hidden = !hrActive;
    el.hrTools.hidden = !hrActive;
    el.offBtn.hidden = !state.connected && !state.reconnecting && !state.waitingForDevice;
    if (hrActive) {
      const m2 = sourceMeta();
      el.dev.textContent = `${(state.deviceName || '心率设备').split(' ')[0]}${info.model ? ' ' + info.model : ''}`;
      el.hrDot.className = 'sdot ' + (on ? 'ok' : 'warn');
      el.hrState.textContent = on ? (m2.rr ? '· 含心跳间隔' : '') : `· ${tag}`;
      el.batt.textContent = state.battery != null ? `电量 ${state.battery}%` : '';
      renderPhases(base, now);
      const hist = history(); const lastTurn = hist[hist.length - 1];
      el.hrv.innerHTML = lastTurn ? (lastTurn.hrv != null ? `${lastTurn.hrv} <i>ms</i>` : '<i>信号不足</i>') : (base && base.hrv ? `${base.hrv} <i>ms</i>` : '--');
      el.last.textContent = hist.length ? hist.slice(-5).map((x) => x.readPeak).join(' ') : '--';
      const sig = lastSignal();
      el.sigBox.hidden = !sig;
      el.sig.textContent = sig ? sig.text : '';
    }
    el.modeHint.textContent = mode === 'author' ? '角色不知道，只影响写法' : '角色能察觉你的身体状态';
    el.injSw.setAttribute('aria-checked', String(state.injectEnabled !== false));
    // 玩具页
    const pol = hapticsPolicy();
    el.vibSw.setAttribute('aria-checked', String(!!state.haptics.enabled));
    el.sets.forEach((b) => {
      const [key, val] = b.getAttribute('data-set').split(':');
      const cur = key === 'mode' ? (mode === 'author' ? 'author' : 'character') : key === 'profile' ? pol.profile : String(state.haptics.maxIntensity);
      b.className = cur === val ? 'on' : '';
    });
    const nIntiface = [...toyFeatures.values()].filter((f) => f.source === 'intiface').length;
    const nWasm = [...toyFeatures.values()].filter((f) => f.source === 'wasm').length;
    el.out.textContent = { idle: '推荐 · 未连接', connecting: '连接中…', connected: `已连接 · ${nIntiface} 路`, disconnected: '已断开', error: '连不上，Intiface 开了吗' }[state.intifaceStatus] || '推荐 · 未连接';
    el.toyBtn.className = 'btn' + (state.haptics.intiface.enabled ? ' on' : '');
    el.wasmState.textContent = { idle: '不装软件 · 测试', loading: '加载中…', connected: `已连接 · ${nWasm} 路`, error: '连接失败' }[WASM.status] || '不装软件 · 测试';
    el.wasmBtn.className = 'btn' + (WASM.client ? ' on' : '');
    el.toyEmpty.hidden = nToy > 0;
    el.toyTiles.hidden = nToy === 0;
    el.now.innerHTML = busy.length ? `${busy.length} 路` : '<i>没有</i>';
    const lastReply = (state.replyLog || []).filter((x) => x.chatId === chatId()).slice(-1)[0];
    const SKIP_ZH = { disabled: '联动没开', 'replies-off': '回复联动关了', 'no-device': '没有设备', safeword: '安全词拦下' };
    el.lastact.innerHTML = lastReply ? `${lastReply.acts.length} 个 · ${lastReply.skipped ? `<i>${esc(SKIP_ZH[lastReply.skipped] || lastReply.skipped)}</i>` : lastReply.results.length ? '已发送' : '排队中'}` : '<i>还没有</i>';
    if (hostEl.classList.contains('devs')) {
      const OUT_ZH = { Vibrate: '振动', Oscillate: '往复', Rotate: '旋转', Constrict: '收缩', HwPositionWithDuration: '抽动', Position: '位置', Estim: '电刺激', Temperature: '加热' };
      const groups = {};
      for (const a of acts) { const k = (toyFeatures.get(a.id) || {}).name || a.device || a.id; (groups[k] = groups[k] || []).push(a); }
      const html = Object.keys(groups).length
        ? Object.entries(groups).map(([name, list]) => `<b>${esc(name)}</b>` + list.map((a) => `<label><input type="checkbox" data-id="${esc(a.id)}"${offSet.has(a.id) ? '' : ' checked'}>${esc(a.outputs.map((o) => OUT_ZH[o] || o).join('/'))} <i>${esc(a.id.split(':').slice(1, 3).join('-'))}</i></label>`).join('')).join('')
        : '还没有设备。先连接 Intiface 或蓝牙直连。';
      if (el.devs.getAttribute('data-h') !== html) { el.devs.innerHTML = html; el.devs.setAttribute('data-h', html); }
    }
    // 底部
    const probs = diagnostics().problems;
    el.help.innerHTML = probs.length ? probs.map((p) => `<li class="${p.severity}"><b>${esc(p.message)}</b>${p.hint ? `<br>${esc(p.hint)}` : ''}</li>`).join('') : '<li>一切正常。</li>';
    const warn = probs.some((p) => p.severity !== 'info');
    el.helpBtn.textContent = warn ? '排查问题 ●' : '排查问题';
    el.helpBtn.className = warn ? 'warn' : '';
    const nctx = Object.keys(contextSources()).length; const nk = Object.keys(kinds()).length;
    el.foot.textContent = `· ${state.samples.length >= 1000 ? (state.samples.length / 1000).toFixed(1) + 'k' : state.samples.length} 样本${nk ? ` · +${nk} 类` : ''}${nctx ? ` · ${nctx} 设备行` : ''}`;
  }

  // ---------- 公开接口与生命周期 ----------
  function getState() {
    const now = Date.now();
    return {
      version: VERSION, spec: HeartlinkCore.SPEC_VERSION, connected: state.connected, reconnecting: state.reconnecting,
      bpm: state.lastSample ? state.lastSample.bpm : null, fresh: HeartlinkCore.isFresh(state.lastSample, now),
      baseline: baselineInfo(), mode: getMode(), modeSource: modeSource(), cardHints: cardHints(), chatId: chatId(),
      events: state.events.length, samples: state.samples.length,
      device: state.deviceName, deviceInfo: state.deviceInfo, battery: state.battery, lastSignal: lastSignal(), compat: state.compat || null, tbc: tbcSources(), prior: state.prior || null, meta: sourceMeta(), bridge: { up: !!state.bridgeUp, info: state.bridgeInfo || null }, guideSync: state.guideSync || null,
    };
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    state.onSample = null; state.onConnection = null;
    try { actuators.stop(); } catch (_) {}
    try { stopIntiface(); } catch (_) {}
    try { stopWasm(); } catch (_) {}
    try { stopAdvertisementWatch(); } catch (_) {}
    while (disposers.length) { try { disposers.pop()(); } catch (_) {} }
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
    getMode, setMode, toggleMode,
    connect, disconnect, setManualBaseline, clearManualBaseline,
    injectContext, exportCsv, setPrior, diagnostics, exportDiagnostics, setExposure, ensureGuideWorldbook,
    getHaptics, setHaptics, actuate: (target, action, opts) => actuators.actuate(target, action, opts), stopHaptics: () => actuators.stop(), actOnReply,
    exportEvents: () => JSON.stringify({ version: VERSION, exportedAt: Date.now(), events: state.events, samples: state.samples }),
    destroy,
  };
  host[CONFIG.RUNTIME_KEY] = api;
  host[CONFIG.PUBLIC_KEY] = api;
  try { if (typeof initializeGlobal === 'function') initializeGlobal('heartlink', api); } catch (_) {}

  loadSettings();
  if (!state.chatIdSeen) state.chatIdSeen = chatId();
  if (!history().length) loadHistoryFromChat();
  mountBadge();
  state.onSample = () => render();
  state.onConnection = () => render();
  const ticker = host.setInterval(() => { render(); emitDiagnosticsIfChanged(); checkStale(); }, CONFIG.RENDER_MS);
  disposers.push(() => host.clearInterval(ticker));
  bindTavernEvents();
  bindHostEvents();
  // 0.7.2：能力探测代替版本号（ST 无稳定的版本接口）；缺哪项就降级哪项，见 docs/st-compat-audit-2026-09.md §3
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
  { const g = host.setInterval(refreshGuideActive, 30000); disposers.push(() => host.clearInterval(g)); }
  bridgeConnect(0);
  if (state.haptics.intiface.enabled) startIntiface();
  { const onHide = () => { try { actuators.stop(); } catch (_) {} }; host.addEventListener('pagehide', onHide); disposers.push(() => host.removeEventListener('pagehide', onHide)); }
  disposers.push(() => { try { state.bridge && state.bridge.close(); } catch (_) {} });
  render();
  adoptExistingConnection().then(() => { if (!state.connected) tryResume(); });

  try {
    const thv = typeof getTavernHelperVersion === 'function' ? getTavernHelperVersion() : 'n/a';
    const stv = typeof getTavernVersion === 'function' ? getTavernVersion() : 'n/a';
    console.log(LOG, `runtime ${VERSION} (bio-context ${HeartlinkCore.SPEC_VERSION}) ready; TavernHelper ${thv}; SillyTavern ${stv}; bluetooth ${bluetooth() ? 'yes' : 'no'}; restored connection ${state.connected}; events ${state.events.length}`);
  } catch (_) {}
})();
