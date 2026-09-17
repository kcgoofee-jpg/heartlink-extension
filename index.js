// heartlink v0.17.3 — SillyTavern 扩展：心率注入 + 触觉输出（Tavern Bio-Context 参考实现）。构建产物。
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
    if (quiet.length >= CONFIG.QUIET_MIN_SAMPLES) return { bpm: percentile(quiet.map((s) => s.bpm), 0.5), method: 'quiet-median', n: quiet.length, hrv: hrvOver(quiet), noise: robustSd(quiet.map((s) => s.bpm)) };
    const all = inWin(samples, from, now);
    if (all.length >= CONFIG.QUIET_MIN_SAMPLES) return { bpm: percentile(all.map((s) => s.bpm), 0.2), method: 'p20', n: all.length, hrv: null, noise: robustSd(all.map((s) => s.bpm)) };
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

  // 把事件流切成本轮相位。now = 本次发送时刻。
  // opts.trigger = 'swipe'：读的是被换掉的那条回复，read = 回复出完 → 换页（A-6）
  function buildTurn(events, now, opts) {
    const trigger = opts && opts.trigger;
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
    // A-11：切走时刻也算标记，否则“最后一次活动 → 切走”这段会和 hidden 区间各报一遍
    const acts = inSpan.filter((e) => ['type', 'visible', 'hidden', 'swipe', 'activity'].includes(e.type)).map((e) => e.t);
    const marks = [spanFrom, ...acts, now].sort((a, b) => a - b);
    for (let i = 1; i < marks.length; i++) {
      if (marks[i] - marks[i - 1] <= CONFIG.AWAY_MS) continue;
      const [a, b] = [marks[i - 1], marks[i]];
      if (away.some(([x, y]) => a >= x && b <= y)) continue;
      away.push([a, b, 'idle']);
    }
    const merged = mergeSpans(away);
    const readEnd = readStart == null ? null : (fixedReadEnd != null ? fixedReadEnd : (typingStart != null ? typingStart : now));
    return { now, trigger: trigger || null, prevSend: prevSend && prevSend.t, streamStart: streamStart && streamStart.t, reasoningEnd: reasoningEnd && reasoningEnd.t, replyEnd: replyEnd && replyEnd.t, readStart, readEnd, typingStart, pauses, deletes, typeCount: types.length, lastLen, away: merged };
  }
  const DISCARDED_TRIGGERS = new Set(['swipe', 'regenerate']);

  // ---------- v0.3 §1.4 只减少输出的规则：峰值、HRV ----------
  const PEAK = { MIN_PHASE_MS: 10000, MIN_SAMPLES: 10, REF_MS: 10000, SMOOTH_HALF_MS: 2500, MIN_BPM: 5, NOISE_K: 2, RUN_N: 3, RUN_MS: 3000, MIN_COV: 70 };
  // picked：已剔除离开区间的相位样本（按时间排序）；noise：基线窗口的稳健标准差（没有时用相位前 10 秒的）
  // → { value, at } 或 null。峰值是 5 秒居中中位数平滑后的值，须高于前 10 秒中位数 max(5, 2×noise)，且连续 ≥ 3 个样本、跨度 ≥ 3 秒
  function detectPeak(picked, from, netMs, noise) {
    if (!picked || picked.length < PEAK.MIN_SAMPLES || netMs < PEAK.MIN_PHASE_MS) return null;
    const head = picked.filter((x) => x.t < from + PEAK.REF_MS).map((x) => x.bpm);
    if (!head.length) return null;
    const ref = median(head);
    const nz = Number.isFinite(noise) ? noise : robustSd(head);
    if (!Number.isFinite(nz)) return null;
    const target = ref + Math.max(PEAK.MIN_BPM, PEAK.NOISE_K * nz);
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

  // ---------- 每轮摘要（跨轮曲线与聊天变量用） ----------
  // 在发送时刻对刚结束的“读回复 / 写消息”做一份紧凑摘要；没有读回复相位时返回 null
  function turnSummary({ samples, turn, baseline }) {
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
      readPeak: rd.max, readMean: rd.mean, readFirst: rd.first, readLast: rd.last,
      peakAtSec: Math.round(netOffset(turn.away, turn.readStart, rd.peakAt) / 1000),
      awaySec: Math.round(ph.awayMs / 1000),
      hrv: gatedHrv(rd, ph.samples, turn.readStart, readEnd, ph.netMs),
      writeSec: wr ? Math.round(wr.netMs / 1000) : 0,
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
  function composeContext({ samples, events, activityLog, now, mode, baselineOverride, history, replyMeta, cpsOverride, kinds, deviceLines, extraLines, meta, prior, baseline }) {
    let readPos = null;
    const cadenceMs = meta && meta.cadenceMs ? meta.cadenceMs : null;
    const trigger = meta && TRIGGERS.includes(meta.trigger) ? meta.trigger : 'normal';
    const discarded = DISCARDED_TRIGGERS.has(trigger);
    const sparse = cadenceMs != null && cadenceMs >= SPARSE_MS;   // v0.3 §2.8：稀疏来源不输出 peak / hrv / series / read-pos
    const turn = buildTurn(events, now, { trigger });
    if (replyMeta) turn.replyMeta = replyMeta;
    const base = baselineOverride ? { bpm: baselineOverride.bpm, hrv: baselineOverride.hrv || null, method: 'manual', n: 0 } : baseline !== undefined ? baseline : sessionBaseline(samples, activityLog || events, now);
    const m = MODES.includes(mode) ? mode : 'author';
    // v0.3 §1.1：0.x 期间 mode 只写旧值（author / character），视角写在 view
    const header = `<bio_context v="${SPEC_VERSION}" mode="${LEGACY_MODE[m]}" view="${WIRE_MODE[m]}" source="${SOURCE}"${headerAttrs(meta)}>`;
    const L = [header];
    L.push(`sent: ${fmtClock(now)}`);
    // TBC 0.3 §1.3：相位归属，防止模型把上一轮读回复的反应安到新消息上
    L.push(discarded ? SCOPE_DISCARDED : trigger === 'impersonate' ? SCOPE_IMPERSONATE : SCOPE_LINE);
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
      const readEnd = turn.readEnd;
      // A-1：离开区间不进统计、不算时长；离开超过一半时不给峰值
      const ph = phaseStats(samples, turn.readStart, readEnd, turn.away);
      const rd = ph.st;
      const readSec = Math.round(ph.netMs / 1000);
      const awayHeavy = ph.awayMs * 2 > readEnd - turn.readStart;
      const cov = rd ? coverage(rd.n, 0, ph.netMs, cadenceMs) : null;
      const pk = rd && !sparse && !awayHeavy && !(cov != null && cov < PEAK.MIN_COV) ? detectPeak(ph.samples, turn.readStart, ph.netMs, base && base.noise) : null;
      const hasPeak = Boolean(pk);
      const peakAtSec = hasPeak ? Math.round(netOffset(turn.away, turn.readStart, pk.at) / 1000) : null;
      const peak = hasPeak ? ` peak ${pk.value} @${peakAtSec}s` : '';
      const hrv = sparse ? null : gatedHrv(rd, ph.samples, turn.readStart, readEnd, ph.netMs);
      const tooLong = ph.netMs > CONFIG.READ_SUSPICIOUS_MS;
      const flag = tooLong ? ' | flag: too-long (likely away)' : '';
      L.push(`read: ${fmtMS(readSec)} | ${fmtRange(rd)}${peak}${covTxt(cov)}${rrLoss(rd)}${hrv != null ? ` | hrv ${hrv} ms` : ''}${flag}`);
      // 可选字段 read-pos：峰值不明显、read 带 too-long、与离开区间重叠、换页/重新生成（回复已不在上下文里）、没有 replyMeta/字数为 0 时不输出
      if (hasPeak && !tooLong && !discarded && ph.awayMs === 0 && replyMeta && replyMeta.chars) {
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
      L.push(`write: ${fmtS(ph.netMs)}, ${turn.lastLen != null ? turn.lastLen : 'n/a'} chars, pauses ${turn.pauses}, edits ${turn.deletes} | ${fmtRange(wr)}${covTxt(wr ? coverage(wr.n, 0, ph.netMs, cadenceMs) : null)}${rrLoss(wr)}`);
    } else L.push('write: n/a (no typing detected)');

    L.push(turn.away.length
      ? 'away: ' + turn.away.slice(-5).map(([a, b, k]) => { const st = stats(inWin(samples, a, b)); return `${fmtClock(a)}–${fmtClock(b)} ${k}${st ? ` [${st.min}–${st.max}]` : ''}`; }).join('; ')
      : 'away: none');

    const sendSt = stats(inWin(samples, now - 5000, now));
    if (discarded) L.push(`send: ${NO_NEW_MESSAGE}`);
    else L.push(sendSt ? `send: ${sendSt.last} bpm${base ? ` (${sendSt.last >= base.bpm ? '+' : '-'}${Math.round(Math.abs(sendSt.last - base.bpm) / base.bpm * 100)}%)` : ''}` : 'send: n/a (no data in last 5s)');
    // 0.8：其它信号种类各一行，随后是执行器状态行（都是可选的增量行）
    if (kinds && typeof kinds === 'object') {
      for (const kind of Object.keys(kinds)) { if (kind === 'hr' || kind === 'rr' || ENV_KINDS.has(kind)) continue; const kl = kindLine(kind, kinds[kind], turn, now); if (kl) L.push(kl); }
      const el = envLine(kinds, now); if (el) L.push(el);
    }
    if (Array.isArray(deviceLines)) { for (const d of deviceLines) { const line = deviceLine(d); if (line) L.push(line); } }
    // 已按协议格式写好的扩展行（如 v0.3 §5.8 的 haptics 行）
    if (Array.isArray(extraLines)) { for (const x of extraLines) { if (x && !/[<>\x00-\x1f\x7f\u2028\u2029]/.test(x)) L.push(String(x)); } }
    const seqFrom = Math.max(turn.prevSend || 0, turn.readStart || 0, now - CONFIG.SERIES_MAX_MS);
    const seqStart = Math.floor(seqFrom / CONFIG.BUCKET_MS) * CONFIG.BUCKET_MS;
    const seq = series(samples, seqStart, now);
    if (!sparse && seq.some((v) => v !== '·')) L.push(`series(10s from ${fmtClock(seqStart)}): ${seq.join(' ')}`);   // 没有任何数据时不写（series 是可选行）
    L.push(NOTE_LINE);
    L.push('</bio_context>');
    const summary = turnSummary({ samples, turn, baseline: base });
    if (summary) summary.readPos = readPos;   // 0.7.1：read-pos 同步进摘要 → 聊天变量 bio.turns / 消息 extra.bio
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

  return {
    guideEntriesUpToDate, frameCoalescer,
    CONFIG, SPEC_VERSION, SOURCE, MODES,
    parseHeartRate, inWin, stats, series, isFresh, fmtClock, fmtDur,
    collectRR, rmssd, hrvInWindow,
    manualBaseline, quietWindows, sessionBaseline,
    detectPeak, gatedHrv, robustSd, compareVersions, guideVersionOf, guideDecision, replayBlock, sanitizeText, isIdent, isKindName, isDeviceName, isDateText, serialProblem, mergeSpans, overlapMs, phaseStats, LEGACY_MODE, TRIGGERS, BUS_ONLY_KINDS,
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
      if (!PATTERNS.includes(act.pattern)) { errors.push({ code: 'BAD_PATTERN', value: act.pattern, fallback: 'pulse' }); act.pattern = 'pulse'; }
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

  return { OUTPUTS, PATTERNS, RISKY_OUTPUTS, MAX_PER_REPLY, MAX_PER_REPLY_LIMIT, DEFAULT_MS, PROFILES, DEFAULT_PROFILE, resolveSettings, liftIntensity, BIO_ACT_TAG_RE, stripNonActionText, hideBioActs, parseBioActs, patternFrames, gate, playFrames, createRegistry, featuresFromDeviceList, levelMessage, positionMessage, stopMessage, strokePeriod, createStroker, createIntifaceClient };
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
//   getMode() / setMode(m) / toggleMode()  'author' | 'character' | 'aware'，按聊天记忆；没选过时用角色卡 data.extensions.tbc.mode_hint（TBC v0.3 §1.2）
//   connect() / disconnect()             connect 必须由真人点击触发（浏览器规定）
//   setManualBaseline() / clearManualBaseline()
//   getHistory()                         本聊天最近 20 轮摘要（也在聊天变量 bio.turns）
//   exportCsv()                          本聊天每轮摘要的 CSV 文本
//   exportEvents()                       { events, samples } 的 JSON 字符串
//   destroy()
// 页面事件（主窗口 dispatchEvent）：bio:sample { t, bpm, rr }；bio:inject { text, mode, summary }；bio:state getState()
(function heartlinkRuntime() {
  'use strict';

  const VERSION = '0.17.3';
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
    META_FALLBACK_MS: 10000,       // 聊天变量写入后，宿主这么久还没保存（且不在生成中）才自己存一次元数据
    GUIDE_CHECK_MS: 10 * 60 * 1000, // 读法世界书兜底复查间隔；平时靠 CHAT_CHANGED / WORLDINFO_* 事件触发
    BRIDGE_URL: 'ws://127.0.0.1:27130/tbc/v0.2',   // 0.9：本机桥（heartlink Desk）；页面自己连着蓝牙时忽略桥送来的 hr
    BRIDGE_RETRY_MS: [3000, 10000, 30000, 60000],
    HISTORY_MAX: 20,
    USER_GEN_KINDS: ['normal', 'regenerate', 'swipe', 'continue', 'impersonate', ''],
    // 正文里的思维链标签：<think> / <thinking>（含带前缀的变体，如 <my_thinking>）
    REASONING_END_RE: /<\/[a-z_]*think(?:ing)?\s*>/i,
    SIGNAL_RE: /(?:0_)?Reader Signal[^\n]*/,
    THINKING_BLOCK_RE: /<([a-z_]*think(?:ing)?)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    THINKING_PREFIX_RE: /^[\s\S]*?<\/[a-z_]*think(?:ing)?\s*>/i,   // 只有结束标签（预设用 prefill 开头）
    THINKING_TAIL_RE: /<[a-z_]*think(?:ing)?\b[^>]*>[\s\S]*$/i,     // 没有闭合的结尾思维链
    ACT_DELAY_MS: 400,          // 生成结束后等这么久再执行动作（等“停止”事件先到）
    TOOL_RECURSION_MS: 10000,   // 工具调用结果保存后这么久内的 normal 生成算递归，不开新一轮
    PENDING_GEN_MS: 5000,       // GENERATION_STARTED 之后这么久内的同类型 AFTER_COMMANDS 才算同一轮
    STYLE_BLOCK_RE: /<style[^>]*>[\s\S]*?<\/style>/gi,
    HTML_TAG_RE: /<[^>]+>/g,
    CJK_RE: /[一-鿿぀-ヿ가-힯]/g,
    CJK_RATIO_THRESHOLD: 0.3,
    // 0.10：触觉输出（TBC v0.3 §5）。默认关；玩具经 Intiface Central
    // profile：null = 用户还没选（按慢热执行，开振动时请用户选）；custom：用户对档位参数的覆盖（TBC v0.3 §5.8）
    // safeWords：可选，缺省关（兴奋时的“受不了”也会被拦，2026-09-17 实测）；词表可自定义
    HAPTICS: { enabled: false, maxIntensity: 1, fromReplies: true, off: [], profile: null, custom: {}, safeWords: { enabled: false, words: ['停下', '停一下', '先停', '停止', '快停', '别动了', '不要动'] }, intiface: { enabled: false, url: 'ws://127.0.0.1:12345' } },
    // 玩具本身没有间隔要求，间隔交给档位（§5.8）
    TOY_CAPS: { levels: true, maxIntensity: 1, maxDurationMs: 30000, minIntervalMs: 0, via: 'intiface' },
    ACTUATION_LINE_MS: 10 * 60 * 1000,
    LAB_URL: 'http://127.0.0.1:12346/lab/',   // 设备实验室（~/dev/tbc/device-lab，npm run sim）
  };
  const LOG = '[heartlink]';
  const GUIDE_BOOK = [{"name":"00 bio_context 读法","enabled":true,"content":"<bio_context_guide>\n对话中可能出现一个 <bio_context> 块（Tavern Bio-Context v0.3）。首行的 view 是视角（backstage 幕后 / in-story 入戏 / device-aware 知情），以它为准；mode 只是兼容旧读者的旧名。块首行还可能带 device / transport / cadence（采样间隔）/ rr（是否有心跳间期）/ trigger（本轮是新消息、重roll、continue 还是 impersonate）；cadence 越粗（30 秒以上）数据越稀疏，trigger 不是 normal 时 read 相位描述的是上一条被重roll或被续写的回复。它记录屏幕前那位真实读者在上一轮到这一轮之间的心率，按页面事件切成相位；数据来自读者佩戴的心率设备，是真实测量，不是剧情设定。\n相位归属（scope 行）：gen、read、read-pos 是读者等待和阅读**上一条回复**时的身体；write、send 是写**这一条消息**时和发送那一刻的身体。不要把 read 的峰值安到本轮新消息里发生的事情上。字段：\n- baseline：本场基线心率（quiet-median = 安静段中位数；p20 = 全场 20 分位；manual = 手动）与安静时 HRV。\n- prior：非实时来源（官方 API / 健康桥）的日级数据，带日期：昨夜恢复分、HRV、静息心率、睡眠时长、皮温。它说明读者今天的底子，不是此刻的反应；日期不是今天时不要当作今天。\n- history：最近几轮“读回复”的峰值、读时长、HRV，按时间顺序，最右是上一轮。看的是趋势：峰值一轮比一轮高说明越来越投入，越来越低说明在冷却。\n- gen：读者看上一条回复生成期间（ttft 等首字、reasoning 思维链、body 正文）的心率。\n- read：读上一条回复的时长、心率走向 [区间]、峰值出现在回复出完后多少秒、rr-loss（心跳间隔缺失率，越高说明手腕在动、数值可信度越低）、hrv。**这是最能反映读者对上一段内容反应的相位**；峰值时刻大致对应读到的位置。带 flag: too-long 的读回复不可当作阅读反应。\n- read-pos：把 read 的峰值时刻按阅读速度换算成大约读到回复的百分比与段落；est 是估计、cal 是按本场历史校准。它只回答“峰值大约对应哪一段”。写 partial 时表示读者读的时间远不够读完这条回复（在跳读或没读完），只给出峰值在读时长里的相对位置，不要当成段落位置。\n- cov：该相位的样本覆盖率，低于 70% 的相位数据不可靠。\n- write：写消息的时长、字数、停顿、删改与心率。手腕在动，只看大趋势。\n- away：页面切走或长时间无操作的区间，其中的心率与对话无关，忽略。\n- send：按下发送时的心率与相对基线的百分比。\n- env：读者所在房间的温湿度最近值，与身体反应无关，只是环境背景。\n- 其它信号行（如 pressure(civet, 100ms): read 7.9→12.3 kPa …）：读者身上别的传感器在同一相位里的走向，单位随行；只看相对变化，不与心率合成结论。\n- device：读者当前连接的设备正在做什么（强度、模式、持续时间），来自设备控制器的登记；它是作者视角的幕后事实，backstage 模式下角色不知道，in-story 模式下只允许角色察觉由它引起的可观察反应、不点名设备，device-aware 模式下角色知道这台设备、可以明说。\n- series：每 10 秒一个点的原始序列。\n判断尺度：baseline 为 n/a 时不做“比刚才 / 比平时快慢”的比较；与 away 重叠、带 flag 或 cov 低于 70% 的相位不据此判断。相对基线 10% 以内是噪声；持续高 20% 以上且出现在 read 相位，才是明确反应。HRV 明显低于安静值说明绷着或亢奋，明显高说明放松。块内没有结论，解释由你完成；块不出现时忽略本说明。\n</bio_context_guide>","strategy":{"type":"selective","keys":["<bio_context"]},"position":{"type":"after_character_definition","order":100},"recursion":{"prevent_incoming":true,"prevent_outgoing":true},"extra":{"heartlink":"0.17.3"}},{"name":"10 view=backstage 幕后（旧 mode=author）","enabled":true,"content":"<bio_context> 处于幕后模式（backstage，旧名 author）：它是给你这位作者/裁决者的幕后读者反馈，剧情里任何角色都不知道它，{{user}} 角色的身体状态与它无关。只做三件事：\n1. 从 read 与 history 判断读者对上一段的反应走向（被抓住了 / 平淡 / 正在冷却 / 数据不足），据此决定本段的详略、张力与结尾钩子；预设若有推进 / 节奏模式，结构（跳时、转场、新事件）仍按预设，读者反应只调写法。\n2. 反应上升时顺势推进、加深、留悬念；平淡时换手法（换视角、加冲突、加感官细节、缩短铺垫），不要重复上一段的写法；冷却时给一个新钩子。\n3. 不在正文里提及心率、设备、读者或任何数据；不让角色“察觉”读者；不因数据改变既定事实与规则裁决。","strategy":{"type":"selective","keys":["view=\"backstage\"","mode=\"author\""]},"position":{"type":"at_depth","role":"system","depth":0,"order":90},"recursion":{"prevent_incoming":true,"prevent_outgoing":true},"extra":{"heartlink":"0.17.3"}},{"name":"11 view=in-story 入戏（旧 mode=character）","enabled":true,"content":"<bio_context> 处于入戏模式（in-story，旧名 character）：读者代入 {{user}}。send 是 {{user}} 此刻的身体状态；read 是 {{user}} 经历上一段情节时的反应（只能对应上一段里发生的事，不能安到本轮新动作上）。让在场角色通过可观察的线索察觉（呼吸、面色、手、声音、姿态），并按各自性格与关系回应。仍然不说数字、不提设备；gen、write、away 的数据不用于角色感知。首行若有 perceiver 属性（卡片指定的感知者），只让这些角色表达察觉，其他在场角色照常行动、不评论 {{user}} 的身体。","strategy":{"type":"selective","keys":["view=\"in-story\""]},"position":{"type":"at_depth","role":"system","depth":0,"order":90},"recursion":{"prevent_incoming":true,"prevent_outgoing":true},"extra":{"heartlink":"0.17.3"}},{"name":"12 view=device-aware 知情","enabled":true,"content":"<bio_context> 处于知情模式（device-aware）：{{user}} 知道自己戴着设备，在场角色也知道，并能看到这份数据。角色可以引用数字（心率、比平静高多少、昨晚睡了多久），可以像教练或伴侣一样指导 {{user}}：提醒放松或屏住呼吸、问现在的感觉、说明接下来要让设备怎么动；haptics 行为 on 时可以用 <bio_act/>，并可以在正文里明说是自己让设备动的。仍然只描述数据、不替 {{user}} 下结论（不说“你一定很兴奋”），不臆断原因；read 只对应上一段发生的事；gen、write、away 的数据只作参考，不当作 {{user}} 对剧情的反应。首行若有 perceiver 属性，只让这些角色看数据、给指导。","strategy":{"type":"selective","keys":["view=\"device-aware\""]},"position":{"type":"at_depth","role":"system","depth":0,"order":90},"recursion":{"prevent_incoming":true,"prevent_outgoing":true},"extra":{"heartlink":"0.17.3"}}];
  const GUIDE_BOOK_NATIVE = [{"uid":0,"key":["<bio_context"],"keysecondary":[],"comment":"00 bio_context 读法","content":"<bio_context_guide>\n对话中可能出现一个 <bio_context> 块（Tavern Bio-Context v0.3）。首行的 view 是视角（backstage 幕后 / in-story 入戏 / device-aware 知情），以它为准；mode 只是兼容旧读者的旧名。块首行还可能带 device / transport / cadence（采样间隔）/ rr（是否有心跳间期）/ trigger（本轮是新消息、重roll、continue 还是 impersonate）；cadence 越粗（30 秒以上）数据越稀疏，trigger 不是 normal 时 read 相位描述的是上一条被重roll或被续写的回复。它记录屏幕前那位真实读者在上一轮到这一轮之间的心率，按页面事件切成相位；数据来自读者佩戴的心率设备，是真实测量，不是剧情设定。\n相位归属（scope 行）：gen、read、read-pos 是读者等待和阅读**上一条回复**时的身体；write、send 是写**这一条消息**时和发送那一刻的身体。不要把 read 的峰值安到本轮新消息里发生的事情上。字段：\n- baseline：本场基线心率（quiet-median = 安静段中位数；p20 = 全场 20 分位；manual = 手动）与安静时 HRV。\n- prior：非实时来源（官方 API / 健康桥）的日级数据，带日期：昨夜恢复分、HRV、静息心率、睡眠时长、皮温。它说明读者今天的底子，不是此刻的反应；日期不是今天时不要当作今天。\n- history：最近几轮“读回复”的峰值、读时长、HRV，按时间顺序，最右是上一轮。看的是趋势：峰值一轮比一轮高说明越来越投入，越来越低说明在冷却。\n- gen：读者看上一条回复生成期间（ttft 等首字、reasoning 思维链、body 正文）的心率。\n- read：读上一条回复的时长、心率走向 [区间]、峰值出现在回复出完后多少秒、rr-loss（心跳间隔缺失率，越高说明手腕在动、数值可信度越低）、hrv。**这是最能反映读者对上一段内容反应的相位**；峰值时刻大致对应读到的位置。带 flag: too-long 的读回复不可当作阅读反应。\n- read-pos：把 read 的峰值时刻按阅读速度换算成大约读到回复的百分比与段落；est 是估计、cal 是按本场历史校准。它只回答“峰值大约对应哪一段”。写 partial 时表示读者读的时间远不够读完这条回复（在跳读或没读完），只给出峰值在读时长里的相对位置，不要当成段落位置。\n- cov：该相位的样本覆盖率，低于 70% 的相位数据不可靠。\n- write：写消息的时长、字数、停顿、删改与心率。手腕在动，只看大趋势。\n- away：页面切走或长时间无操作的区间，其中的心率与对话无关，忽略。\n- send：按下发送时的心率与相对基线的百分比。\n- env：读者所在房间的温湿度最近值，与身体反应无关，只是环境背景。\n- 其它信号行（如 pressure(civet, 100ms): read 7.9→12.3 kPa …）：读者身上别的传感器在同一相位里的走向，单位随行；只看相对变化，不与心率合成结论。\n- device：读者当前连接的设备正在做什么（强度、模式、持续时间），来自设备控制器的登记；它是作者视角的幕后事实，backstage 模式下角色不知道，in-story 模式下只允许角色察觉由它引起的可观察反应、不点名设备，device-aware 模式下角色知道这台设备、可以明说。\n- series：每 10 秒一个点的原始序列。\n判断尺度：baseline 为 n/a 时不做“比刚才 / 比平时快慢”的比较；与 away 重叠、带 flag 或 cov 低于 70% 的相位不据此判断。相对基线 10% 以内是噪声；持续高 20% 以上且出现在 read 相位，才是明确反应。HRV 明显低于安静值说明绷着或亢奋，明显高说明放松。块内没有结论，解释由你完成；块不出现时忽略本说明。\n</bio_context_guide>","constant":false,"vectorized":false,"selective":true,"selectiveLogic":0,"addMemo":true,"order":100,"position":1,"disable":false,"excludeRecursion":true,"preventRecursion":true,"delayUntilRecursion":false,"probability":100,"useProbability":true,"depth":4,"group":"","groupOverride":false,"groupWeight":100,"scanDepth":null,"caseSensitive":false,"matchWholeWords":false,"useGroupScoring":null,"automationId":"","role":0,"sticky":0,"cooldown":0,"delay":0,"displayIndex":0,"heartlink":"0.17.3"},{"uid":1,"key":["view=\"backstage\"","mode=\"author\""],"keysecondary":[],"comment":"10 view=backstage 幕后（旧 mode=author）","content":"<bio_context> 处于幕后模式（backstage，旧名 author）：它是给你这位作者/裁决者的幕后读者反馈，剧情里任何角色都不知道它，{{user}} 角色的身体状态与它无关。只做三件事：\n1. 从 read 与 history 判断读者对上一段的反应走向（被抓住了 / 平淡 / 正在冷却 / 数据不足），据此决定本段的详略、张力与结尾钩子；预设若有推进 / 节奏模式，结构（跳时、转场、新事件）仍按预设，读者反应只调写法。\n2. 反应上升时顺势推进、加深、留悬念；平淡时换手法（换视角、加冲突、加感官细节、缩短铺垫），不要重复上一段的写法；冷却时给一个新钩子。\n3. 不在正文里提及心率、设备、读者或任何数据；不让角色“察觉”读者；不因数据改变既定事实与规则裁决。","constant":false,"vectorized":false,"selective":true,"selectiveLogic":0,"addMemo":true,"order":90,"position":4,"disable":false,"excludeRecursion":true,"preventRecursion":true,"delayUntilRecursion":false,"probability":100,"useProbability":true,"depth":0,"group":"","groupOverride":false,"groupWeight":100,"scanDepth":null,"caseSensitive":false,"matchWholeWords":false,"useGroupScoring":null,"automationId":"","role":0,"sticky":0,"cooldown":0,"delay":0,"displayIndex":1,"heartlink":"0.17.3"},{"uid":2,"key":["view=\"in-story\""],"keysecondary":[],"comment":"11 view=in-story 入戏（旧 mode=character）","content":"<bio_context> 处于入戏模式（in-story，旧名 character）：读者代入 {{user}}。send 是 {{user}} 此刻的身体状态；read 是 {{user}} 经历上一段情节时的反应（只能对应上一段里发生的事，不能安到本轮新动作上）。让在场角色通过可观察的线索察觉（呼吸、面色、手、声音、姿态），并按各自性格与关系回应。仍然不说数字、不提设备；gen、write、away 的数据不用于角色感知。首行若有 perceiver 属性（卡片指定的感知者），只让这些角色表达察觉，其他在场角色照常行动、不评论 {{user}} 的身体。","constant":false,"vectorized":false,"selective":true,"selectiveLogic":0,"addMemo":true,"order":90,"position":4,"disable":false,"excludeRecursion":true,"preventRecursion":true,"delayUntilRecursion":false,"probability":100,"useProbability":true,"depth":0,"group":"","groupOverride":false,"groupWeight":100,"scanDepth":null,"caseSensitive":false,"matchWholeWords":false,"useGroupScoring":null,"automationId":"","role":0,"sticky":0,"cooldown":0,"delay":0,"displayIndex":2,"heartlink":"0.17.3"},{"uid":3,"key":["view=\"device-aware\""],"keysecondary":[],"comment":"12 view=device-aware 知情","content":"<bio_context> 处于知情模式（device-aware）：{{user}} 知道自己戴着设备，在场角色也知道，并能看到这份数据。角色可以引用数字（心率、比平静高多少、昨晚睡了多久），可以像教练或伴侣一样指导 {{user}}：提醒放松或屏住呼吸、问现在的感觉、说明接下来要让设备怎么动；haptics 行为 on 时可以用 <bio_act/>，并可以在正文里明说是自己让设备动的。仍然只描述数据、不替 {{user}} 下结论（不说“你一定很兴奋”），不臆断原因；read 只对应上一段发生的事；gen、write、away 的数据只作参考，不当作 {{user}} 对剧情的反应。首行若有 perceiver 属性，只让这些角色看数据、给指导。","constant":false,"vectorized":false,"selective":true,"selectiveLogic":0,"addMemo":true,"order":90,"position":4,"disable":false,"excludeRecursion":true,"preventRecursion":true,"delayUntilRecursion":false,"probability":100,"useProbability":true,"depth":0,"group":"","groupOverride":false,"groupWeight":100,"scanDepth":null,"caseSensitive":false,"matchWholeWords":false,"useGroupScoring":null,"automationId":"","role":0,"sticky":0,"cooldown":0,"delay":0,"displayIndex":3,"heartlink":"0.17.3"}];
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
    // 一次用户发送只生成一个块（v0.3 §1.3-2）；生成类型与重放
    pendingGen: null, genKind: null, genStartT: 0, turnBlock: state.turnBlock || null, impersonateBlock: null, impersonating: false,
    groupTurn: null, toolCallsAt: 0, round: null, bgGens: [],
    badInput: state.badInput || 0, invalidBlocks: state.invalidBlocks || 0, guideConflict: state.guideConflict || null, guideWrote: state.guideWrote || null,
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
      if (typeof s.settingsFolded === 'boolean') state.settingsFolded = s.settingsFolded;
      if (s.playSeen) state.playSeen = true;
      if (s.haptics && typeof s.haptics === 'object') state.haptics = normalizeHaptics(s.haptics);
      if (typeof s.guideWrote === 'string') state.guideWrote = s.guideWrote;
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
    try { host.localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify({ manualBaseline: state.manualBaseline, modes: state.modes, deviceName: state.deviceName, prior: state.prior || null, injectEnabled: state.injectEnabled !== false, privacyAck: !!state.privacyAck, haptics: state.haptics, badgePos: state.badgePos || null, badgeHidden: !!state.badgeHidden, settingsFolded: !!state.settingsFolded, playSeen: !!state.playSeen, guideWrote: state.guideWrote || null })); }
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
  function pushEvent(type, extra, t) {
    const e = Object.assign({ t: t == null ? Date.now() : t, type }, extra || {});
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
      badInput: state.badInput || 0, invalidBlocks: state.invalidBlocks || 0, guideConflict: state.guideConflict || null,
    });
    try { d.haptics = { enabled: !!state.haptics.enabled, maxIntensity: state.haptics.maxIntensity, actuators: actuators.list().length, intiface: state.intifaceStatus }; } catch (_) {}
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
      pushSample(Math.round(sample.value), rr, t);
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
        const html = '<h3>选一个节奏</h3><p><b>慢热</b>：从轻开始，逐步升温。<br><b>持久</b>：中等强度，每次动得久。<br><b>狂暴</b>：高触发、高功率。<br><b>极限</b>：几乎一直开满。</p><p>之后可在玩具页随时切换。</p>';
        const r = await c.callGenericPopup(html, (c.POPUP_TYPE && c.POPUP_TYPE.TEXT) || 1, '', { okButton: '慢热', customButtons: [{ text: '持久', result: 11 }, { text: '狂暴', result: 12 }, { text: '极限', result: 13 }] });
        pick = { 11: 'steady', 12: 'frenzy', 13: 'max' }[r] || 'slow-burn';
      }
    } catch (_) {}
    setHaptics({ profile: pick });
    toast('info', `节奏：${PROFILE_ZH[pick]}（之后可在玩具页切换）`);
  }
  const PROFILE_ZH = { 'slow-burn': '慢热', steady: '持久', frenzy: '狂暴', max: '极限' };
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
    const entryKey = upTo >= 0 ? `${key}@${upTo}` : key;
    let prevUser = null;
    for (let k = i - 1; k >= 0; k--) if (chat[k].is_user) { prevUser = chat[k]; break; }
    const safe = prevUser && safeWordHit(prevUser.mes);
    const skipped = safe ? 'safeword' : !state.haptics.enabled ? 'disabled' : !state.haptics.fromReplies ? 'replies-off' : !actuators.list().length ? 'no-device' : null;
    replyEntry(entryKey, i, acts, errors, skipped);
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
  function baselineInfo(now) {
    if (state.manualBaseline) return { bpm: state.manualBaseline.bpm, hrv: state.manualBaseline.hrv || null, method: 'manual', n: 0 };
    return HeartlinkCore.sessionBaseline(state.samples, state.activityLog, now || Date.now());
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
    const value = Object.assign({ v: HeartlinkCore.SPEC_VERSION, source: HeartlinkCore.SOURCE, updatedAt: Date.now() }, modeFields(), { baseline: (baselineInfo() || {}).bpm || null, turns: history(), lastSignal: lastSignal() }, extra || {});
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
        // 0.7.2：不再主动调 saveChat（完整性检查 + 保存锁风险，见 docs/st-compat-audit-2026-09.md §4）；
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
    return HeartlinkCore.composeContext({ samples: state.samples, events: state.events, activityLog: state.activityLog, now: now || Date.now(), mode: getMode(), baselineOverride: state.manualBaseline, history: history(), replyMeta, cpsOverride, kinds: kinds(), deviceLines: deviceLines(), extraLines: [hapticsLine()].filter(Boolean), meta, prior: state.prior || null, baseline });
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
  // 一次用户发送只 compose 一次（A-12）：两个注入入口、群聊后面的成员、工具调用递归拿到的都是同一份（v0.3 §1.3-2）
  function composeTurnBlock(now, trigger) {
    const composed = compose(now, undefined, trigger);
    let text = composed.text;
    if (composed.invalid) state.invalidBlocks = (state.invalidBlocks || 0) + 1;
    else if (!HeartlinkCore.isFresh(state.lastSample, now) && state.samples.length) text = text.replace('\n</bio_context>', '\nwarn: device silent over 10s at send; recent phases may be incomplete\n</bio_context>');
    return { sendT: now, trigger, text, summary: composed.summary };
  }
  function recordSummary(block) {
    const summary = block.summary;
    const h = history();
    const dup = summary && h.length && h[h.length - 1].readStart === summary.readStart; // 同一段“读回复”只记一次（重复发送 / 重roll）
    if (summary && state.lastSummarizedSend !== block.sendT && !dup) {
      state.lastSummarizedSend = block.sendT;
      h.push(summary); if (h.length > CONFIG.HISTORY_MAX) h.splice(0, h.length - CONFIG.HISTORY_MAX);
      saveChatVariable({ last: summary });
      attachSummaryToMessage(summary);
    }
  }
  function injectContext(sendT) {
    if (state.injectEnabled === false) { clearInject(); return; }
    // 没有生理数据时，只有触觉状态值得告诉模型（TBC v0.3 §5.8）：开着触觉或连着设备就照常注入，其余行为 n/a
    if (!state.samples.length && !hapticsLine()) { console.log(LOG, 'no heart-rate data; nothing injected'); return; }
    const kind = state.genKind || 'normal';
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
        recordSummary(block);   // 摘要在 compose 之后才进 history，本轮块里的 history 不含本轮（A-12）
        fresh = true;
      }
      text = state.turnBlock.text;
    }
    const via = doInject(text);
    if (!via) { console.warn(LOG, 'no injection API available'); return; }
    state.injectedFor = sendT || Date.now(); state.lastInjectAt = Date.now();
    state.lastInjectText = text;
    if (fresh) {
      bridgeState();
      emit('bio:inject', Object.assign({ text }, modeFields(), { summary: state.turnBlock.summary }));   // 一次发送只广播一次
      console.log(LOG, `injected bio_context via ${via}:\n` + text);
    }
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
      const g = state.groupTurn;
      if (state.toolCallsAt && now - state.toolCallsAt < CONFIG.TOOL_RECURSION_MS) kind = 'tool';
      else if (g && g.started) kind = g.auto ? 'auto' : 'group';
      else if (p.auto) kind = 'auto';
      if (g && !g.started) { g.started = true; g.auto = p.auto; }
    }
    state.toolCallsAt = 0;
    try { const ch = (ctx() || {}).chat || []; const lu = [...ch].reverse().find((m) => m.is_user); if (lu && safeWordHit(lu.mes) && (actuators.list().some((a) => a.busy) || actuators.pending())) { actuators.stop(); toast('info', '听到了停止的话，设备已停'); } } catch (_) {}
    state.generating = true; state.streamStarted = false; state.reasoningEnded = false;
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
    state.round = { t: p.t, kind, acts: ACT_KINDS.has(kind), snapshot: replySig(lastReply()) };
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
        state.backgroundGen = true; clearInject(); state.backgroundSkipped = (state.backgroundSkipped || 0) + 1;
        state.bgGens.push(Date.now()); pushEvent('background_gen', { kind }); return;
      }
      state.backgroundGen = false;
      state.pendingGen = { kind: kind || 'normal', type: kind, t: Date.now(), auto: !!(option && option.automatic_trigger) };
    });
    const onAfterCommands = (type, option, dryRun) => {
      if (dryRun) return;
      const p = state.pendingGen;
      state.pendingGen = null;
      if (!p || Date.now() - p.t > CONFIG.PENDING_GEN_MS || String(type == null ? '' : type) !== p.type) return;
      beginRound(p);
      if (!state.backgroundGen && state.userGenActive) injectContext(state.lastSendT);
    };
    bind(events.GENERATION_AFTER_COMMANDS, onAfterCommands, true);
    // 0.9.4：只在拼提示词之前注入；CHAT_COMPLETION_PROMPT_READY 时提示词已拼好，此时再注入只会残留到下一次（后台）请求里
    bind(events.GENERATE_BEFORE_COMBINE_PROMPTS, () => {
      if (!events.GENERATION_AFTER_COMMANDS && state.pendingGen) onAfterCommands(state.pendingGen.type, null, false);   // 宿主没有 AFTER_COMMANDS 时在这里开始
      if (!state.backgroundGen && state.userGenActive) injectContext(state.lastSendT);
    }, true);
    bind(events.GROUP_WRAPPER_STARTED, () => { state.groupTurn = { started: false, auto: false }; });
    bind(events.GROUP_WRAPPER_FINISHED, () => { state.groupTurn = null; });
    bind(events.TOOL_CALLS_PERFORMED, () => { state.toolCallsAt = Date.now(); });
    bind(events.IMPERSONATE_READY, () => { state.impersonating = false; });
    bind(events.STREAM_TOKEN_RECEIVED, (text) => {
      if (!state.generating) return;
      if (!state.streamStarted) { state.streamStarted = true; pushEvent('stream_start'); }
      if (!state.reasoningEnded && typeof text === 'string' && CONFIG.REASONING_END_RE.test(text)) { state.reasoningEnded = true; pushEvent('reasoning_end', { via: 'thinking-tag' }); }
    });
    bind(events.STREAM_REASONING_DONE, () => { if (state.generating && !state.reasoningEnded) { state.reasoningEnded = true; pushEvent('reasoning_end', { via: 'api' }); } });
    // 结束一轮：只有本轮回复真的更新了才记 reply_end（API 报错、并发的后台生成结束都不算，A-7）
    const endRound = (via, messageId) => {
      if (state.generating) {
        const round = state.round;
        const updated = roundReplyUpdated(round);
        if (!updated && via === 'ended' && state.bgGens.length) {
          state.bgGens.shift();   // 非流式时并发的后台生成先结束，发的 ENDED 不是本轮的
          console.log(LOG, 'GENERATION_ENDED from a background generation; round continues');
          return;
        }
        state.generating = false;
        const kind = state.genKind;
        if (round) { round.endedAt = Date.now(); if (updated) round.replyId = lastReply().i; }
        if (updated && REPLY_KINDS.has(kind)) { pushEvent('reply_end', { via }); computeReplyMeta(); bridgeState(); }
        state.continueGen = false;
        const got = via === 'rendered' ? captureReaderSignal(typeof messageId === 'number' ? messageId : undefined) : false;
        if (!got) host.setTimeout(() => captureReaderSignal(), 1500);   // 兜底：非流式/思维链晚到时再试一次（这次只能等下一次宿主保存）
      } else if (via === 'ended' && state.bgGens.length) state.bgGens.shift();
      if (state.userGenActive) clearInject();   // 0.9.4：用户可见生成结束就撤掉，后台请求不会带上
      state.impersonating = false;
      state.backgroundGen = false; state.userGenActive = false;
    };
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
      if (state.chatIdSeen !== id) { state.events.length = 0; state.generating = false; state.userGenActive = false; state.pendingGen = null; state.round = null; state.turnBlock = null; state.impersonateBlock = null; state.lastInjectText = null; state.replyMeta = null; state.chatIdSeen = id; pushEvent('chat_changed', { id }); loadHistoryFromChat(); }
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
    // 没有 Worker 计时时，后台页的计时会被浏览器压慢，玩具可能停不下来：页面一藏起来就全停
    const onHideStop = () => { if (doc.visibilityState === 'hidden' && hTimers.kind === 'page') { try { actuators.stop(); } catch (_) {} } };
    doc.addEventListener('visibilitychange', onHideStop);
    disposers.push(() => doc.removeEventListener('visibilitychange', onHideStop));
  }

  // ---------- 悬浮窗（Shadow DOM，底色取酒馆主题变量；强调色固定，避免主题色是灰色时看不出状态） ----------
  // ST 1.18 的 style.css 给 html 加了 transform:translateZ(0) 且 html 高度为 0，fixed 元素改以 html 为包含块，
  // 用 bottom 定位会跑到屏幕上方外面；所以用视口单位算 top（2026-09-17 本地实测 top:-118px）。
  // 配色：底色 / 正文取酒馆主题变量，其它按正文颜色的明暗切深浅两套（:host(.light)，见 syncTone）；青绿 --on 固定，不跟随主题强调色
  const CSS = `
:host{all:initial;position:fixed;right:14px;top:calc(100vh - 122px);top:calc(100dvh - 122px);z-index:9999;
  --font:var(--mainFontFamily,-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif);
  --mono:var(--monoFontFamily,ui-monospace,"SF Mono",Menlo,monospace);
  --bg:var(--SmartThemeBlurTintColor,#141517);--ink:var(--SmartThemeBodyColor,#E9E7E3);
  --raise:#1C1D20;--hair:#2A2B2F;--muted:#8E8C88;--faint:#5C5B58;
  --heart:#E0564E;--on:#2E9E91;--stop:#D24B43;--warn:#D39A3C;--toy:#D0668C;
  --gen:#6E8BA8;--read:#C98A4B;--write:#B87A95;--shadow:0 12px 32px rgba(0,0,0,.28);
  font-family:var(--font);color:var(--ink);font-variant-numeric:tabular-nums}
:host(.light){--raise:#FFFFFF;--hair:#E4E1DB;--muted:#6F6C66;--faint:#A3A09A;
  --heart:#C8423A;--on:#1E8378;--stop:#C0392F;--warn:#A86F12;--toy:#B34D73;
  --gen:#56718E;--read:#A56A2C;--write:#985A76;--shadow:0 8px 24px rgba(0,0,0,.10)}
*{box-sizing:border-box}
button{font:inherit;color:inherit}
button:focus-visible{outline:2px solid var(--on);outline-offset:2px}
[hidden]{display:none!important}
@keyframes br{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.7)}}
/* 胶囊 */
.pill{display:inline-flex;align-items:center;gap:8px;height:44px;padding:0 12px 0 6px;border-radius:999px;background:var(--bg);border:1px solid var(--hair);
  box-shadow:var(--shadow);backdrop-filter:blur(16px) saturate(1.2);cursor:pointer;white-space:nowrap;user-select:none;transition:transform .15s ease}
.pill:hover{transform:translateY(-1px)}
.seg{display:inline-flex;align-items:center;gap:8px}
.segsep{width:1px;height:20px;background:var(--hair);margin:0 2px}
.dot{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;flex:0 0 auto}
.heart{position:relative;background:var(--heart)}
/* 心跳波纹：伪元素只动 transform / opacity（交给合成器），不再每帧重绘 box-shadow；z-index:-1 让它在圆点背后、胶囊背景之上 */
.heart::after{content:"";position:absolute;inset:0;z-index:-1;border-radius:50%;background:var(--heart);opacity:0;pointer-events:none}
.heart.on::after{animation:pulse var(--beat,1s) infinite}
.heart.stale{background:var(--warn)}
.heart.off{background:color-mix(in srgb,var(--muted) 40%,transparent)}
.heart svg{width:14px;height:14px;fill:#fff}
.toyd{background:color-mix(in srgb,var(--toy) 18%,transparent);color:var(--toy)}
.toyd svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round}
@keyframes pulse{0%{transform:scale(1);opacity:.45}70%{transform:scale(1.5);opacity:0}100%{transform:scale(1);opacity:0}}
.bpm{font:600 17px/1 var(--font);min-width:22px}
.spark{width:40px;height:16px;flex:0 0 auto}
.spark path{fill:none;stroke:var(--heart);stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round}
.spark line{stroke:var(--faint);stroke-dasharray:2 2}
.delta{font:600 12px/1 var(--font);color:var(--on)}
.delta.up{color:var(--read)}
.tag{font-size:12px;color:var(--muted)}
.tag.ch{color:var(--toy)}
.tn{font:600 14px/1 var(--font)}
.live{width:8px;height:8px;border-radius:50%;background:var(--toy);display:none}
.live.on{display:inline-block;animation:br 1.6s ease-in-out infinite}
/* 面板：固定头部 + 中间滚动 + 固定页脚 */
.card{display:none;position:absolute;right:0;bottom:52px;width:320px;max-height:560px;flex-direction:column;overscroll-behavior:contain;
  background:var(--bg);border:1px solid var(--hair);border-radius:14px;padding:0 12px;box-shadow:var(--shadow);backdrop-filter:blur(20px) saturate(1.2);
  font-size:13px;line-height:19px;text-align:left}
:host(.open) .card{display:flex;animation:rise .16s ease-out}
:host(.below) .card{bottom:auto;top:52px}
:host(.dragging) .pill{cursor:grabbing}
:host(.hidden){display:none!important}
@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.heart.on::after,.live.on,.pulse::before,:host(.open) .card{animation:none!important}.pill{transition:none}}
.head{flex:none}
.tabs{display:flex;align-items:center;height:40px;gap:18px;border-bottom:1px solid var(--hair)}
.tabs button[role="tab"]{position:relative;height:40px;display:flex;align-items:center;gap:6px;border:0;background:none;padding:0;cursor:pointer;font:600 13px/18px var(--font);color:var(--muted)}
.tabs button[aria-selected="true"]{color:var(--ink)}
.tabs button[aria-selected="true"]::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;background:var(--ink);border-radius:2px}
.d6{width:6px;height:6px;border-radius:50%;display:inline-block;flex:none;background:var(--on)}
.d6.warn{background:var(--warn)}
.d6.toy{background:var(--toy)}
.x{margin-left:auto;width:24px;height:24px;display:grid;place-items:center;border:0;background:none;padding:0;cursor:pointer;color:var(--muted);font-size:16px;line-height:1}
.x:hover{color:var(--ink)}
.stop{display:block;width:100%;height:36px;margin:12px 0;border:0;border-radius:10px;background:var(--stop);color:#fff;font:600 13px/1 var(--font);cursor:pointer}
:host(.busy) .stop{box-shadow:0 0 0 3px color-mix(in srgb,var(--stop) 25%,transparent)}
.stop:hover{filter:brightness(1.06)}
.stop:active{transform:translateY(1px)}
.body{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;margin:0 -12px;padding:0 12px}
.body.more{-webkit-mask-image:linear-gradient(#000 calc(100% - 16px),transparent);mask-image:linear-gradient(#000 calc(100% - 16px),transparent)}
.sec{padding:12px 0;border-top:1px solid var(--hair)}
.sec.first{border-top:0}
.sh{font:500 11px/14px var(--font);color:var(--muted);margin:0 0 8px;display:flex;align-items:center}
.sh em{margin-left:auto;font-style:normal;color:var(--toy)}
.status{display:flex;align-items:center;gap:6px;height:24px}
.status b{font-weight:600}
.status .st{color:var(--muted);display:inline-flex;align-items:center;font-size:12px}
.sdot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--faint)}
.sdot.ok{background:var(--on)}
.sdot.warn{background:var(--warn)}
.batt{margin-left:auto;font:500 11px/14px var(--font);color:var(--muted)}
.batt em{font-style:normal;color:var(--ink)}
.empty{color:var(--muted);margin:0 0 12px}
.link{border:0;background:none;padding:0;cursor:pointer;color:var(--on);font:12px/16px var(--font);margin-left:auto}
.link:hover{text-decoration:underline}
/* 时间线 */
.tl{position:relative;padding-left:20px}
.tl::before{content:"";position:absolute;left:3.5px;top:10px;bottom:12px;width:1px;background:var(--hair)}
.node{position:relative;padding:6px 0;--c:var(--faint)}
.node::before{content:"";position:absolute;left:-20px;top:11px;width:8px;height:8px;border-radius:50%;background:var(--c)}
.node.hol::before{background:var(--bg);box-shadow:inset 0 0 0 1.5px var(--c)}
.node.bare::before{display:none}
.node.pulse::before{animation:br 1.6s ease-in-out infinite}
.node.pulse.toy::before{box-shadow:0 0 0 4px color-mix(in srgb,var(--toy) 25%,transparent)}
.th{display:flex;align-items:baseline;gap:8px;font-size:13px;line-height:18px;min-width:0}
.th b{font-weight:600;white-space:nowrap}
.th .d{color:var(--ink);white-space:nowrap}
.th .m{color:var(--muted);font-size:12px;white-space:nowrap}
.th .m.w{color:var(--write)}
.th .m.t{color:var(--toy)}
.th .m.no{color:var(--warn);white-space:normal}
.th .r{margin-left:auto;display:flex;align-items:baseline;gap:4px}
.big{font:600 20px/24px var(--font);color:var(--ink)}
.tsub{font-size:12px;line-height:16px;color:var(--muted);margin-top:4px}
.chart{display:block;margin-top:6px;width:100%;overflow:visible}
.hatch{display:inline-block;width:10px;height:8px;vertical-align:-1px;margin-right:4px;background:repeating-linear-gradient(45deg,var(--muted) 0 1px,transparent 1px 3px);opacity:.7}
.node p{margin:2px 0 0;font-size:13px;line-height:19px}
.quote{color:var(--ink);max-height:5.7em;overflow:auto}
.sees b{font-weight:600}
.sees i{font-style:normal;color:var(--warn)}
.sees .mut{color:var(--muted);font-size:12px}
.sh .x{width:16px;height:14px;font-size:14px}
.ptext{margin:6px 0 0;max-height:12em;overflow:auto;white-space:pre-wrap;word-break:break-all;font:10px/1.5 var(--mono);color:var(--muted);background:var(--raise);border:1px solid var(--hair);border-radius:8px;padding:6px 8px}
.base{display:flex;align-items:center;gap:8px;font-size:12px;line-height:16px;padding-top:8px;border-top:1px solid var(--hair)}
.base b{font-weight:600}
.dash{width:14px;border-top:1px dashed var(--faint);flex:none}
.small{font:500 11px/14px var(--font);color:var(--muted);margin-top:4px}
.small em{font-style:normal;color:var(--ink)}
.basemenu{display:flex;gap:8px;margin-top:8px}
.basemenu button{flex:1;height:28px;border:1px solid var(--hair);background:none;border-radius:8px;font-size:12px;cursor:pointer}
.basemenu button:hover{border-color:var(--on);color:var(--on)}
.play{margin:0}
.play q{quotes:"「" "」";color:var(--toy)}
/* 设置与连接 */
.fold{display:flex;align-items:center;width:100%;height:36px;border:0;background:none;padding:0;cursor:pointer;font:600 13px/18px var(--font);text-align:left}
.chev{margin-left:auto;color:var(--muted);font-size:15px;line-height:1;transition:transform .15s}
.fold[aria-expanded="true"] .chev{transform:rotate(90deg)}
.set{display:flex;align-items:center;min-height:36px;gap:8px}
.set>:last-child{margin-left:auto}
.meaning{font-size:12px;line-height:16px;color:var(--muted);margin:-4px 0 4px}
.segctl{display:inline-flex;height:28px;border:1px solid var(--hair);border-radius:8px;padding:2px;gap:2px}
.segctl button{border:0;background:none;padding:0 10px;border-radius:6px;font-size:12px;color:var(--muted);cursor:pointer}
.segctl button.on{background:var(--on);color:#fff;font-weight:600}
.switch{width:32px;height:18px;border-radius:999px;border:0;padding:0;background:color-mix(in srgb,var(--muted) 45%,transparent);position:relative;cursor:pointer;flex:none;transition:background .15s}
.switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:left .15s}
.switch[aria-checked="true"]{background:var(--on)}
.switch[aria-checked="true"]::after{left:16px}
.textbtn{display:block;border:0;background:none;padding:0;margin-top:4px;cursor:pointer;font:13px/19px var(--font);color:var(--muted)}
.textbtn:hover{color:var(--stop)}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:4px 0}
.btn{min-height:36px;border:1px solid var(--hair);background:none;border-radius:8px;padding:6px 8px;font-size:13px;line-height:18px;font-weight:600;cursor:pointer;text-align:center}
.btn:hover{border-color:var(--on)}
.btn.primary{background:var(--on);border-color:var(--on);color:#fff}
.btn.on{border-color:var(--on);color:var(--on)}
.btn.full{grid-column:1/-1;width:100%}
.btn small{display:block;font-weight:400;font-size:11px;line-height:14px;color:var(--muted)}
.btn.on small{color:var(--on)}
.conn{display:flex;align-items:center;width:100%;min-height:36px;gap:8px;border:0;background:none;padding:0;cursor:pointer;font:13px/19px var(--font);text-align:left}
.conn .r{margin-left:auto;color:var(--muted);font-size:12px;display:flex;align-items:center;gap:6px}
.conn .chev{margin-left:0}
:host(.devs) .conn .chev{transform:rotate(90deg)}
.devs{display:none;max-height:15em;overflow:auto;padding:0 0 4px}
:host(.devs) .devs{display:block}
.devs b{display:block;margin:6px 0 2px;font-size:12px}
.devs label{display:flex;gap:8px;align-items:center;cursor:pointer;min-height:24px;font-size:12px}
.devs label i{font-style:normal;color:var(--muted);font-size:11px}
.devs input{accent-color:var(--on);margin:0;width:14px;height:14px}
.help{display:none;margin:12px 0 0;padding:8px 12px 8px 24px;border-radius:10px;background:var(--raise);border:1px solid var(--hair);font-size:12px;line-height:16px;max-height:14em;overflow:auto}
:host(.help) .help{display:block}
.help li{margin:4px 0}
.help li.error b{color:var(--stop)}
.help li.warn b{color:var(--warn)}
.foot{flex:none;display:flex;gap:4px 14px;flex-wrap:wrap;align-items:center;border-top:1px solid var(--hair);padding:8px 4px 10px;font:500 11px/14px var(--font);color:var(--muted)}
.foot button{border:0;background:none;padding:0;cursor:pointer;color:var(--muted);font:500 11px/14px var(--font)}
.foot button:hover{color:var(--ink)}
.foot .ver{margin-left:auto}
.foot .warn{color:var(--warn)}`;
  const HEART_SVG = '<svg viewBox="0 0 24 24"><path d="M12 21s-7-4.6-9.3-8.6C.6 8.7 2.6 4.5 6.6 4.5c2 0 3.4 1.1 4.1 2.2.7-1.1 2.1-2.2 4.1-2.2 4 0 6 4.2 3.9 7.9C19 16.4 12 21 12 21z"/></svg>';
  const WAVE_SVG = '<svg viewBox="0 0 24 24"><path d="M3 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0"/></svg>';
  const IBI_SVG = '<svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true"><path d="M0 7h3l1.5-4 2.5 8 2-6 1 2h4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/></svg>';

  let hostEl = null, root = null, el = {};
  function mountBadge() {
    const old = doc.getElementById(CONFIG.HOST_ID); if (old) old.remove();
    hostEl = doc.createElement('div'); hostEl.id = CONFIG.HOST_ID;
    root = hostEl.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style>
<div class="card" part="card" role="dialog" aria-label="heartlink 悬浮窗">
  <div class="head">
    <div class="tabs" role="tablist">
      <button role="tab" data-tab="hr">健康设备<i class="d6" data-f="hrBadge"></i></button>
      <button role="tab" data-tab="toy">玩具<i class="d6" data-f="toyBadge"></i></button>
      <button class="x" data-close title="收起" aria-label="收起">×</button>
    </div>
    <div data-pane="toy"><button class="stop" data-act="halt">全部停止</button></div>
  </div>
  <div class="body" data-f="body">
  <ul class="help" data-f="help"></ul>

  <section data-pane="hr">
    <div class="sec first" data-f="hrEmpty">
      <p class="empty">还没连接设备。手环 / 心率带要先打开“心率广播”，并用桌面版 Chrome 或 Edge。</p>
      <button class="btn primary full" data-act="hr">连接设备</button>
    </div>
    <div data-f="hrLive">
      <div class="sec first">
        <div class="status"><span class="sdot" data-f="hrDot"></span><b data-f="dev">--</b><span class="st" data-f="hrState"></span><span class="batt" data-f="batt"></span></div>
      </div>
      <div class="sec">
        <div class="tl">
          <div data-f="plist"></div>
          <div class="node hol" data-f="pnote" hidden><div class="th"><span class="m">发出第一条消息后，这里按相位分段显示</span></div></div>
          <div class="node bare">
            <div class="base"><i class="dash"></i><span data-f="base">平静心率</span><button class="link" data-act="basemenu" title="虚线是平静心率，胶囊上的百分比也是和它比">调整</button></div>
            <div class="basemenu" data-f="baseMenu" hidden><button data-act="baseline">记下现在为平静</button><button data-act="clear">改回自动计算</button></div>
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
    <div class="sec">
      <button class="fold" data-act="fold" aria-expanded="true">设置与连接<span class="chev">›</span></button>
      <div data-f="hrFold">
        <div class="set"><span>模式</span><div class="segctl"><button data-set="mode:author">幕后</button><button data-set="mode:character">入戏</button><button data-set="mode:aware">知情</button></div></div>
        <div class="meaning" data-f="modeHint"></div>
        <div class="set"><span>发给模型</span><button class="switch" role="switch" data-act="inject" aria-label="发给模型"></button></div>
        <div data-f="hrTools"><button class="textbtn" data-act="disconnect">断开设备</button></div>
      </div>
    </div>
  </section>

  <section data-pane="toy">
    <div class="sec" data-f="toyEmpty"><p class="empty" style="margin:0">还没连玩具：打开“剧情联动”，再选一种连接方式。</p></div>
    <div class="sec" data-f="toyTiles">
      <div class="sh">上一条回复的动作<em data-f="now"></em></div>
      <div class="tl" data-f="lastact"></div>
    </div>
    <div class="sec" data-f="play">
      <div class="sh">在对话里这样玩<button class="x" data-act="playClose" title="收起玩法说明" aria-label="收起玩法说明">×</button></div>
      <p class="play">角色在回复里写动作，回复写完就动。也可以直接对角色说<q>轻一点</q><q>再强点</q><q>像心跳那样</q><q>慢慢来</q>。</p>
    </div>
    <div class="sec">
      <button class="fold" data-act="fold" aria-expanded="true">设置与连接<span class="chev">›</span></button>
      <div data-f="toyFold">
        <div class="set"><span>剧情联动</span><button class="switch" role="switch" data-act="vib" aria-label="剧情联动"></button></div>
        <div class="set"><span>节奏</span><div class="segctl"><button data-set="profile:slow-burn">慢热</button><button data-set="profile:steady">持久</button><button data-set="profile:frenzy">狂暴</button><button data-set="profile:max">极限</button></div></div>
        <button class="conn" data-act="devs" data-f="connRow"><span>连接设备</span><span class="r"><i class="d6"></i><span data-f="connTxt">已连接</span><span class="chev">›</span></span></button>
        <div class="row2" data-f="connBtns">
          <button class="btn" data-act="toy" title="先装好 Intiface Central、点 Start Server 并在里面连上玩具">通过 Intiface<small data-f="out">推荐</small></button>
          <button class="btn" data-act="wasm" title="不装 Intiface：Chrome 直接用蓝牙连玩具（支持的型号与 Intiface 相同）。还没有经过真实设备验证">浏览器直接连<small data-f="wasmState">测试</small></button>
          ${DEV_TOOLS ? '<button class="btn full" data-act="lab" title="打开设备模拟器小窗口（本机 device-lab，先运行 npm run sim）">设备模拟器</button>' : ''}
        </div>
        <div class="devs" data-f="devs"></div>
      </div>
    </div>
  </section>
  </div>

  <div class="foot">
    <button data-act="help" data-f="helpBtn">排查问题</button>
    <button data-act="play" data-f="playBtn" hidden>玩法</button>
    <button data-act="hide">隐藏悬浮窗</button>
    <span class="ver">v${VERSION}<span data-f="foot"></span></span>
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
    ['base', 'hrv', 'last', 'hrvLine', 'dev', 'out', 'sig', 'sigBox', 'foot', 'hrBadge', 'toyBadge', 'hrEmpty', 'hrLive', 'hrDot', 'hrState', 'batt', 'plist', 'pnote', 'baseMenu', 'modeHint', 'hrTools', 'hrFold', 'toyFold', 'toyEmpty', 'toyTiles', 'now', 'lastact', 'wasmState', 'help', 'devs', 'helpBtn', 'sees', 'ptext', 'body', 'play', 'playBtn', 'connRow', 'connTxt', 'connBtns']
      .forEach((f) => { el[f] = q(`[data-f="${f}"]`); });
    el.folds = [...root.querySelectorAll('[data-act="fold"]')];
    el.connDot = q('[data-f="connRow"] .d6');
    el.body.addEventListener('scroll', () => syncMore(), { passive: true });
    el.seg = { hr: q('[data-seg="hr"]'), toy: q('[data-seg="toy"]'), none: q('[data-seg="none"]') };
    el.segsep = q('.segsep');
    el.tn = q('.tn'); el.live = q('.live');
    el.tabs = [...root.querySelectorAll('[data-tab]')];
    el.panes = [...root.querySelectorAll('[data-pane]')];
    el.sets = [...root.querySelectorAll('[data-set]')];
    el.injSw = q('[data-act="inject"]'); el.vibSw = q('[data-act="vib"]');
    el.toyBtn = q('[data-act="toy"]'); el.wasmBtn = q('[data-act="wasm"]');
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
        if (key === 'profile') { if (hapticsPolicy().profile !== val) { setHaptics({ profile: val }); toast('info', `节奏：${PROFILE_ZH[val] || val}`); } return; }
        if (key === 'cap') { setHaptics({ maxIntensity: Number(val) }); return; }
        return;
      }
      const btn = t.closest && t.closest('[data-act]');
      if (btn) {
        const act = btn.getAttribute('data-act');
        if (act === 'help') { if (hostEl.classList.toggle('help')) scheduleGuideCheck(); return render(); }
        if (act === 'devs') { hostEl.classList.toggle('devs'); return render(); }
        if (act === 'lab') {
          const win = host.open(CONFIG.LAB_URL, 'tbc-device-lab', 'popup=yes,width=1180,height=820');
          if (!win) toast('warning', '浏览器拦下了弹出窗口：请允许本站弹窗，或直接打开 ' + CONFIG.LAB_URL);
          else toast('info', `模拟器已在小窗口打开，页面顶部会显示扩展是否已接入。${hTimers.kind === 'worker' ? '酒馆页被挡住或切到后台时，触觉计时照常。' : '注意：这个浏览器不支持后台计时，切走酒馆页时强度帧会变慢。'}`);
          return;
        }
        if (act === 'wasm') { if (WASM.client) { stopWasm(); toast('info', '已断开浏览器直接连'); } else { toast('info', '测试功能：正在加载直连组件（约数 MB），稍后浏览器会弹出蓝牙设备选择。还没有经过真实设备测试，遇到问题请到仓库反馈。'); startWasm(); } return; }
        if (act === 'inject') { setExposure({ inject: state.injectEnabled === false }); toast('info', state.injectEnabled === false ? '已停止发给模型：模型收不到设备数据' : '已恢复发给模型'); return; }
        if (act === 'vib') { const on = !state.haptics.enabled; setHaptics({ enabled: on }); if (on) askProfile(); toast(on ? 'warning' : 'info', on ? '剧情联动已打开' : '剧情联动已关闭，玩具已停'); return; }
        if (act === 'toy') { const on = !state.haptics.intiface.enabled; setHaptics({ intiface: { enabled: on } }); toast('info', on ? `正在连接 Intiface（${state.haptics.intiface.url}）；先在 Intiface Central 里点 Start Server` : '已断开 Intiface'); return; }
        if (act === 'hide') { setBadgeHidden(true); toast('info', '悬浮窗已隐藏。要恢复：点酒馆左下角的魔杖菜单 → “显示 heartlink 悬浮窗”。'); return; }
        if (act === 'halt') { actuators.stop(); closePanel(); toast('info', '已停止所有设备'); return; }
        if (act === 'fold') { state.settingsFolded = !state.settingsFolded; saveSettings(); return render(); }
        if (act === 'playClose') { state.playSeen = true; state.playOpen = false; saveSettings(); return render(); }
        if (act === 'play') { state.playOpen = true; state.badgeTab = 'toy'; return render(); }
        if (act === 'preview') { el.ptext.hidden = !el.ptext.hidden; btn.textContent = el.ptext.hidden ? '看原文' : '收起'; if (!el.ptext.hidden) { el.ptext.textContent = compose().text; console.log(LOG, 'preview:\n' + el.ptext.textContent); } return; }
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
    card.style.maxHeight = `${Math.max(180, Math.floor(down ? below : above) - 8)}px`;
  }
  // 中间区域还能往下滚时，底边淡出提示
  function syncMore() {
    const b = el.body; if (!b) return;
    b.classList.toggle('more', b.scrollHeight - b.scrollTop - b.clientHeight > 2);
  }
  // 深浅配色跟着酒馆正文颜色走：正文偏暗 = 浅色主题
  let toneKey = '';
  function syncTone() {
    try {
      const c = host.getComputedStyle(hostEl).color;
      if (c === toneKey) return;
      toneKey = c;
      const m = (c.match(/[\d.]+/g) || []).map(Number);
      const lum = m.length >= 3 ? (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255 : 1;
      hostEl.classList.toggle('light', lum < 0.5);
    } catch (_) {}
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
  //   颜色是 CSS 变量；看生成的三小段只用顶部线条的透明度区分
  const PH = {
    wait: { name: '等首字', c: 'gen', o: 0.55 }, think: { name: '思考', c: 'gen', o: 0.75 }, body: { name: '正文', c: 'gen', o: 1 }, gen: { name: '看生成', c: 'gen', o: 1 },
    read: { name: '读回复', c: 'read', o: 1 }, write: { name: '写消息', c: 'write', o: 1 },
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
  // 时间线：每个相位一个节点；看生成、读回复各带一张小走势图，所有小图纵向比例相同、以底边为准对齐，平静心率虚线在同一高度
  const CHART_W = 274;
  function renderPhases(base, now) {
    const { groups, away } = phaseModel(now);
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
    let k = 3;   // 每 bpm 多少像素：取能让每张图都放得下的最大值
    for (const c of charts) {
      if (!c) continue;
      const hi = Math.max(lo + 6, ...c.vals.filter((v) => v != null), base ? base.bpm : lo);
      k = Math.min(k, (c.h - 8) / (hi - lo));
    }
    k = Math.max(0.3, k);
    let peak = null;
    const rd = groups.find((g) => g.k === 'read');
    if (rd) for (const x of pts) if (x.t >= rd.a && x.t <= rd.b && (!peak || x.bpm > peak.bpm)) peak = x;
    const chartSvg = (c, idx) => {
      const { g, h, N, span, vals } = c;
      const W = CHART_W;
      const X = (tt) => Math.max(0, Math.min(W, (tt - g.a) / span * W));
      const Y = (v) => h - 4 - (v - lo) * k;
      let s = `<svg class="chart" viewBox="0 0 ${W} ${h}" height="${h}" preserveAspectRatio="none" aria-hidden="true"><defs><pattern id="hlaway${idx}" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="5" style="stroke:var(--muted);stroke-width:1.4;stroke-opacity:.5"/></pattern></defs>`;
      for (const sb of g.subs) {
        const x = X(sb.a); const w = Math.max(1, X(sb.b) - x); const inner = sb.a > g.a ? 0.5 : 0;
        s += `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${h}" style="fill:var(--${PH[sb.k].c});fill-opacity:${sb.live ? 0.24 : 0.14}"/>`;
        s += `<rect x="${(x + inner).toFixed(1)}" y="0" width="${Math.max(0, w - inner * 2).toFixed(1)}" height="2" style="fill:var(--${PH[sb.k].c});opacity:${PH[sb.k].o}"/>`;
      }
      for (const [a, b] of away) if (b > g.a && a < g.b) s += `<rect x="${X(a).toFixed(1)}" y="2" width="${Math.max(1, X(b) - X(a)).toFixed(1)}" height="${h - 2}" fill="url(#hlaway${idx})"><title>离开，不计入</title></rect>`;
      if (base) { const yb = Y(base.bpm).toFixed(1); s += `<line x1="0" x2="${W}" y1="${yb}" y2="${yb}" style="stroke:var(--faint);stroke-width:1;stroke-dasharray:3 3"/>`; }
      // 断开超过 3 桶才断线（偶尔漏一两个样本不算中断）
      let d = ''; let gap = Infinity;
      vals.forEach((v, i) => { if (v == null) { gap++; return; } d += `${gap > 3 ? 'M' : 'L'}${((i + 0.5) * W / N).toFixed(1)},${Y(v).toFixed(1)}`; gap = 0; });
      if (d) s += `<path d="${d}" style="fill:none;stroke:var(--heart);stroke-width:1.75;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke"/>`;
      if (g.k === 'read' && peak && d) s += `<circle cx="${X(peak.t).toFixed(1)}" cy="${Y(peak.bpm).toFixed(1)}" r="3" style="fill:var(--heart);stroke:var(--bg);stroke-width:1.5"/>`;
      return s + '</svg>';
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
      if (g.k === 'read' && peak) {
        const fl = pts.filter((x) => x.t >= g.a && x.t <= g.b);
        const up = fl.length ? fl[fl.length - 1].bpm - fl[0].bpm : 0;
        arrow = up >= 3 ? ' ↑' : up <= -3 ? ' ↓' : '';
        right = `<span class="r"><span class="m">峰值</span><span class="big">${peak.bpm}</span></span>`;
      }
      const aw = awayIn(g);
      if (aw >= 1000) sub += `${sub ? ' · ' : ''}<i class="hatch" title="离开的时段不计入"></i>离开 ${fmt(Math.round(aw / 1000))}`;
      const liveTag = g.live ? `<span class="m${g.k === 'write' ? ' w' : ''}">进行中</span>` : '';
      return `<div class="node${g.live ? ' pulse' : ''}" style="--c:var(--${PH[g.k].c})"><div class="th"><b>${PH[g.k].name}</b><span class="d">${dur}${arrow}</span>${liveTag}${right}</div>`
        + (c ? chartSvg(c, i) : '') + (sub ? `<div class="tsub">${sub}</div>` : '') + '</div>';
    }).join(''));
    el.pnote.hidden = groups.length > 0;
    const how = base ? { manual: ' · 手动记下', p20: ' · 估算' }[base.method] || '' : '';
    setHtml(el.base, base ? `平静心率 <b>${base.bpm}</b>${how}` : '平静心率稍后自动算出');
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
  const onRenderVisibility = () => renderQ.onVisible();
  function renderNow() {
    if (!root || destroyed) return;
    const now = Date.now();
    const fresh = HeartlinkCore.isFresh(state.lastSample, now);
    const on = state.connected && fresh;
    const mode = getMode();
    const base = state.connected ? baselineInfo(now) : null;
    const d = on && base ? Math.round((state.lastSample.bpm - base.bpm) / base.bpm * 100) : null;
    syncTone();
    // 胶囊：心率段
    el.heart.className = 'dot heart ' + (on ? 'on' : state.connected ? 'stale' : 'off');
    if (on) {   // 心率变化不到 5 bpm 不改动画时长：改 --beat 会让动画重新计时、样式重算
      const bpm = Math.max(state.lastSample.bpm, 30);
      if (beatBpm == null || Math.abs(bpm - beatBpm) >= 5) { beatBpm = bpm; hostEl.style.setProperty('--beat', (60 / bpm) + 's'); }
    }
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
    el.delta.title = base ? `现在比平静心率 ${base.bpm} ${d >= 0 ? '高' : '低'} ${Math.abs(d || 0)}%` : '';
    el.delta.className = 'delta' + (d != null && d >= 10 ? ' up' : '');
    let tag;
    if (state.newerVersion) tag = '请刷新';   // 别的页面已装更新版本，优先提示
    else if (state.waitingForDevice && !state.connected) tag = '等设备回来';
    else if (state.reconnecting) tag = '重连中';
    else if (!state.connected) tag = state.bridgeUp && fresh ? '经本机桥' : '未连接';
    else if (!fresh) tag = `${Math.round((now - (state.lastSample ? state.lastSample.t : now)) / 1000)} 秒无数据`;
    else tag = (MODE_ZH[mode] || '幕后') + (state.injectEnabled === false ? ' · 未发送' : modeSource() === 'card' ? ' · 卡片设定' : '');
    el.tag.textContent = tag;
    el.tag.className = 'tag' + (state.connected && fresh && mode !== 'author' ? ' ch' : '');
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
    hostEl.classList.toggle('busy', busy.length > 0);
    const info = state.deviceInfo || {};
    el.pill.title = `heartlink ${VERSION}${state.connected ? ` · ${state.deviceName || ''}${info.firmware ? ' · fw ' + info.firmware : ''}` : ''} · 点一下打开，按住可拖动`;
    if (!hostEl.classList.contains('open')) return;   // 面板收起时不用算后面的
    fitPanel();
    // 面板：标签页（小圆点只表示状态，数字只在胶囊上）
    const tab = state.badgeTab === 'toy' ? 'toy' : 'hr';   // 默认健康设备
    el.tabs.forEach((b) => b.setAttribute('aria-selected', String(b.getAttribute('data-tab') === tab)));
    el.panes.forEach((pn) => { pn.hidden = pn.getAttribute('data-pane') !== tab; });
    el.hrBadge.hidden = !(state.connected || state.reconnecting || state.waitingForDevice);
    el.hrBadge.className = 'd6' + (state.connected ? '' : ' warn');
    el.hrBadge.title = state.connected ? '已连接' : state.reconnecting ? '重连中' : '等设备回来';
    el.toyBadge.hidden = !toyActive;
    el.toyBadge.className = 'd6' + (busy.length ? ' toy' : '');
    el.toyBadge.title = busy.length ? '正在动' : '已连接';
    // 设置与连接：折叠状态记在设置里
    const folded = !!state.settingsFolded;
    el.folds.forEach((b) => b.setAttribute('aria-expanded', String(!folded)));
    el.hrFold.hidden = folded; el.toyFold.hidden = folded;
    // 健康设备页
    el.hrEmpty.hidden = hrActive;
    el.hrLive.hidden = !hrActive;
    el.hrTools.hidden = !state.connected && !state.reconnecting && !state.waitingForDevice;
    if (hrActive) {
      const m2 = sourceMeta();
      el.dev.textContent = `${(state.deviceName || '心率设备').split(' ')[0]}${info.model ? ' ' + info.model : ''}`;
      el.hrDot.className = 'sdot ' + (on ? 'ok' : 'warn');
      if (on) { setHtml(el.hrState, m2.rr ? IBI_SVG : ''); el.hrState.title = m2.rr ? '含心跳间隔' : ''; }
      else { htmlCache.delete(el.hrState); el.hrState.textContent = tag; el.hrState.title = ''; }
      setHtml(el.batt, state.battery != null ? `电量 <em>${esc(state.battery)}%</em>` : '');
      renderPhases(base, now);
      const hist = history(); const lastTurn = hist[hist.length - 1];
      const hrv = lastTurn ? lastTurn.hrv : base && base.hrv;
      const hrvHtml = hrv != null ? `心率变异 <em>${esc(hrv)}ms</em>` : lastTurn ? '心率变异信号不足' : '';
      const peaks = hist.slice(-5).map((x) => x.readPeak).filter((v) => v != null);
      const lastHtml = peaks.length ? `${hrvHtml ? ' · ' : ''}前几轮峰值 ${peaks.map((v) => `<em>${esc(v)}</em>`).join(' · ')}` : '';
      setHtml(el.hrv, hrvHtml); setHtml(el.last, lastHtml);
      el.hrvLine.hidden = !hrvHtml && !lastHtml;
      // 这一轮会注入什么（一句话）；具体时长、峰值在上面的时间线里，这里只说比平静高多少
      if (state.injectEnabled === false) setHtml(el.sees, '<i>“发给模型”已关，模型收不到这些数据。</i>');
      else {
        const c2 = compose(now, state.connected ? base : undefined);
        const sm = c2.summary;
        const modeTxt = `按${MODE_ZH[mode] || '幕后'}方式使用`;
        if (sm) {
          const parts = ['读回复多久'];
          if (base) { const pct = Math.round((sm.readPeak - base.bpm) / base.bpm * 100); parts.push(`峰值比平静${pct >= 0 ? '高' : '低'} <b>${Math.abs(pct)}%</b>`); }
          else parts.push('峰值');
          if (sm.writeSec) parts.push('这条写了多久');
          setHtml(el.sees, `${parts.join('、')}，${modeTxt}。`);
        } else setHtml(el.sees, '<span class="mut">还没有数据，角色回复后开始记。</span>');
        if (!el.ptext.hidden) el.ptext.textContent = c2.text;
      }
      const sig = lastSignal();
      el.sigBox.hidden = !sig;
      el.sig.textContent = sig ? `“${sig.text}”` : '';
    }
    el.modeHint.textContent = MODE_HINT[mode] || MODE_HINT.author;
    el.injSw.setAttribute('aria-checked', String(state.injectEnabled !== false));
    // 玩具页
    const pol = hapticsPolicy();
    el.vibSw.setAttribute('aria-checked', String(!!state.haptics.enabled));
    el.sets.forEach((b) => {
      const [key, val] = b.getAttribute('data-set').split(':');
      const cur = key === 'mode' ? mode : key === 'profile' ? pol.profile : String(state.haptics.maxIntensity);
      b.className = cur === val ? 'on' : '';
    });
    const intiOn = state.intifaceStatus === 'connected'; const wasmOn = WASM.status === 'connected';
    el.out.textContent = { idle: '推荐', connecting: '连接中…', connected: '已连接', disconnected: '已断开', error: '连不上，Intiface 开了吗' }[state.intifaceStatus] || '推荐';
    el.toyBtn.className = 'btn' + (state.haptics.intiface.enabled ? ' on' : '');
    el.wasmState.textContent = { idle: '测试', loading: '加载中…', connected: '已连接', error: '连接失败' }[WASM.status] || '测试';
    el.wasmBtn.className = 'btn' + (WASM.client ? ' on' : '');
    // 连上以后，连接方式收成一行；点开看连接按钮与选择设备
    const anyDev = acts.length > 0;
    el.connRow.hidden = !anyDev;
    el.connBtns.hidden = anyDev && !hostEl.classList.contains('devs');
    const via = [intiOn && 'Intiface', wasmOn && '浏览器直接连'].filter(Boolean).join('、');
    el.connTxt.textContent = via ? `${via} · 已连接` : '已连接';
    el.connDot.className = 'd6' + (busy.length ? ' toy' : '');
    el.toyEmpty.hidden = nToy > 0;
    el.toyTiles.hidden = nToy === 0;
    const lastReply = (state.replyLog || []).filter((x) => x.chatId === chatId()).slice(-1)[0];
    const SKIP_ZH = { disabled: '联动没开', 'replies-off': '回复联动关了', 'no-device': '没有设备', safeword: '安全词拦下' };
    const PAT_ZH = { pulse: '轻点', double: '两下', triple: '三下', long: '持续', heartbeat: '心跳', wave: '波浪' };
    // 玩法说明只在刚开始时显示：看到第一条带动作的回复（或点 ×）后收起，底部留“玩法”可再打开
    if (!state.playSeen && (state.replyLog || []).some((x) => x.acts && x.acts.length)) { state.playSeen = true; saveSettings(); }
    el.play.hidden = !!state.playSeen && !state.playOpen;
    el.playBtn.hidden = tab !== 'toy' || !el.play.hidden;
    let movingShown = false;
    if (!lastReply) setHtml(el.lastact, '<div class="node hol"><div class="th"><span class="m">角色写出动作后会列在这里</span></div></div>');
    else {
      // 动作按顺序执行：有设备在动时，最后一个已执行的动作就是正在动的那个
      let movingIdx = -1;
      if (busy.length && !lastReply.skipped) lastReply.acts.forEach((a, i) => { const r = lastReply.results[i]; if (r && r.results.some((x) => x.ok)) movingIdx = i; });
      movingShown = movingIdx >= 0;
      const rows = lastReply.acts.map((a, i) => {
        const r = lastReply.results[i];
        const okN = r ? r.results.filter((x) => x.ok).length : 0;
        const val = `${Math.round((a.intensity ?? 0.5) * 100)}%${a.durationMs ? ` · ${(a.durationMs / 1000).toFixed(a.durationMs % 1000 ? 1 : 0)}s` : ''}`;
        let cls = 'node'; let c = 'on'; let mid = ''; let right = '';
        if (lastReply.skipped) { c = 'warn'; right = `<span class="r m no">${esc(SKIP_ZH[lastReply.skipped] || lastReply.skipped)}</span>`; }
        else if (!r) { cls += ' hol'; c = 'faint'; right = '<span class="r m">排队中</span>'; }
        else if (!okN) { c = 'warn'; right = '<span class="r m no">没执行</span>'; }
        else {
          right = `<span class="r m">${okN} 路</span>`;
          if (i === movingIdx) { cls += ' pulse toy'; c = 'toy'; mid = '<span class="m t">正在动</span>'; }
        }
        return `<div class="${cls}" style="--c:var(--${c})"><div class="th"><b>${esc(PAT_ZH[a.pattern] || a.pattern)}</b><span class="d">${val}</span>${mid}${right}</div></div>`;
      });
      setHtml(el.lastact, '<div class="node hol"><div class="th"><span class="m">回复写完</span></div></div>'
        + (rows.join('') || '<div class="node hol"><div class="th"><span class="m">这条回复没有动作</span></div></div>'));
    }
    el.now.textContent = busy.length && !movingShown ? '正在动' : '';
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
    setHtml(el.help, probs.length ? probs.map((p) => `<li class="${p.severity}"><b>${esc(p.message)}</b>${p.hint ? `<br>${esc(p.hint)}` : ''}</li>`).join('') : '<li>一切正常。</li>');
    const warn = probs.some((p) => p.severity !== 'info');
    el.helpBtn.textContent = warn ? '排查问题 ●' : '排查问题';
    el.helpBtn.className = warn ? 'warn' : '';
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
  doc.addEventListener('visibilitychange', onRenderVisibility);
  disposers.push(() => doc.removeEventListener('visibilitychange', onRenderVisibility));
  const ticker = host.setInterval(() => { render(); emitDiagnosticsIfChanged(); checkStale(); }, CONFIG.RENDER_MS);
  disposers.push(() => host.clearInterval(ticker));
  bindTavernEvents();
  bindHostEvents();
  watchChatForActs();
  scheduleHide();
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
  {
    // 兜底复查：有世界书事件时 10 分钟一次，没有时 2 分钟一次（原来 30 秒一次、每次整本拉取）
    const ev = (ctx() || {}).eventTypes || window.tavern_events || host.tavern_events || {};
    const every = ev.WORLDINFO_UPDATED || ev.WORLDINFO_SETTINGS_UPDATED ? CONFIG.GUIDE_CHECK_MS : 2 * 60 * 1000;
    const g = host.setInterval(() => { refreshGuideActive(); checkGuideConflict(); }, every);
    disposers.push(() => { host.clearInterval(g); if (guideCheckTimer) host.clearTimeout(guideCheckTimer); });
  }
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
