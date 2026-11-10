/* ========== core/plan-split ==========
 * 周计划拆分：把「工作内容」按每日日期标题切分、逐条结构化（地点/工序/规格/数量/单位）、
 * 并把条目映射回七类日工作量字段。
 *
 * 纯函数（不 require db / app），是全系统唯一实现；规则要改只改 SPLIT_DICT。
 * 与用户定版口径一致：
 *   - 日期标题支持 03日 / 8月3日 / 8月3号 / 2026年8月3日 / 2026-08-03，标题后可跟冒号；
 *   - 换行与「逗号/分号/顿号后紧跟日期标题」都要切开（同行连写多天）；
 *   - 第一个标题之前有正文 → 报错；「DD日」的月份按段落顺序推断，天数回退则进位到下月；
 *   - 校验一次性收集全部问题，不只报第一条。
 */

/* 七类日工作量字段（与计划表单一一致） */
const QTY_FIELDS = ['wlPole', 'wlLine1035', 'wlCable', 'wlRing', 'wlVacuum', 'wlTransformer', 'wlLine04'];

/* ---------- 词典与映射表（唯一可改规则处） ---------- */
const SPLIT_DICT = {
  // 工序词典：取「最靠前」的命中；同位置取更长的词。坑洞类统一归并到基础开挖。
  processes: [
    { name: '基础开挖', words: ['基础开挖', '开挖', '挖坑', '基坑', '坑洞', '掏挖', '基础'] },
    { name: '电杆转运', words: ['电杆转运', '二次搬运', '转运', '运输'] },
    { name: '电杆组立', words: ['电杆组立', '杆塔组立', '组立', '立杆'] },
    { name: '金具及铁附件安装', words: ['金具及铁附件安装', '金具', '铁附件', '横担', '抱箍'] },
    { name: '导线安装', words: ['导线安装', '导线展放', '导线', '放线', '紧线', '架线'] },
    { name: '电缆敷设', words: ['电缆敷设', '电缆'] },
    { name: '设备安装', words: ['设备安装', '开关安装', '刀闸', '避雷器'] },
    { name: '环网柜安装', words: ['环网柜'] },
    { name: '真空开关安装', words: ['真空开关', '断路器'] },
    { name: '变压器及成套设备安装', words: ['变压器', '台变', '成套设备'] },
    { name: '拉线制作', words: ['拉线制作', '拉线'] },
    { name: '接地焊接', words: ['接地焊接', '接地', '焊接'] }
  ],
  // 工程量单位：countUnits 优先当作「数量」，measureUnits 可被当作「规格」（如 15米电杆）
  units: ['个', '基', '处', '组', '台', '根', '档', '条', '套', '座', '米', 'km', '千米'],
  countUnits: ['个', '基', '处', '组', '台', '根', '档', '条', '套', '座'],
  measureUnits: ['米', 'km', '千米'],
  // 地点前的施工方式修饰词：从地点中剔除（不单列字段）
  modifiers: ['人工配合机械', '人工', '机械', '配合'],
  // 七类工程量映射：按工序命中；导线安装再按电压等级区分 10kV/35kV 与 0.4kV
  // convert: num=原值；km=米换算为千米
  quantityMap: [
    { field: 'wlPole', processes: ['电杆组立'], convert: 'num' },
    { field: 'wlCable', processes: ['电缆敷设'], convert: 'km' },
    { field: 'wlRing', processes: ['环网柜安装'], convert: 'num' },
    { field: 'wlVacuum', processes: ['真空开关安装'], convert: 'num' },
    { field: 'wlTransformer', processes: ['变压器及成套设备安装'], convert: 'num' },
    { field: 'wlLine1035', processes: ['导线安装'], convert: 'km', unless: /0[.．]4\s*(kv|千伏)|低压/i },
    { field: 'wlLine04', processes: ['导线安装'], convert: 'km', when: /0[.．]4\s*(kv|千伏)|低压/i }
  ],
  // 「同上」类写法：整条展开为上一天条目
  sameAsPrev: ['同上', '同昨日', '同前一天', '同前一日']
};

/* ---------- 日期标题 ---------- */
const HEAD_RES = [
  { kind: 'ymd', re: /^(\d{4})-(\d{1,2})-(\d{1,2})\s*[：:]?/ },
  { kind: 'ymd', re: /^(\d{4})年(\d{1,2})月(\d{1,2})\s*[日号]\s*[：:]?/ },
  { kind: 'md', re: /^(\d{1,2})月(\d{1,2})\s*[日号]\s*[：:]?/ },
  { kind: 'd', re: /^(\d{1,2})\s*[日号]\s*[：:]?/ }
];
const SEPARATORS = '，,；;、';

function isHeadingStart(text) {
  const s = String(text || '');
  return HEAD_RES.some(h => h.re.test(s));
}

function matchHeading(text) {
  const s = String(text || '');
  for (let i = 0; i < HEAD_RES.length; i++) {
    const h = HEAD_RES[i];
    const m = h.re.exec(s);
    if (!m) continue;
    const label = String(m[0]).replace(/[：:]\s*$/, '').trim();
    if (h.kind === 'ymd') return { kind: 'ymd', y: +m[1], m: +m[2], d: +m[3], label, len: m[0].length };
    if (h.kind === 'md') return { kind: 'md', y: null, m: +m[1], d: +m[2], label, len: m[0].length };
    return { kind: 'd', y: null, m: null, d: +m[1], label, len: m[0].length };
  }
  return null;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function ymd(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }
/* 子计划名称后缀：M月D日（不补零，与用户定版一致） */
function mdLabel(date) {
  const p = String(date || '').slice(0, 10).split('-');
  return (+p[1]) + '月' + (+p[2]) + '日';
}
function isRealDate(y, m, d) {
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function dayList(startDate, endDate) {
  const s = String(startDate || '').slice(0, 10);
  const e = String(endDate || '').slice(0, 10);
  const out = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}$/.test(e)) return out;
  const cur = new Date(s + 'T00:00:00Z');
  const last = new Date(e + 'T00:00:00Z');
  let guard = 0;
  while (cur <= last && guard++ < 400) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/* 按行 + 行内分隔符切段：分隔符后紧跟日期标题才算切点（前瞻判断，不用 lookbehind） */
function segmentContent(content) {
  const lines = String(content == null ? '' : content).replace(/\r\n?/g, '\n').split('\n');
  const raw = [];
  lines.forEach(line => {
    const cuts = [];
    for (let i = 0; i < line.length; i++) {
      if (SEPARATORS.indexOf(line[i]) < 0) continue;
      let j = i + 1;
      while (j < line.length && /\s/.test(line[j])) j++;
      if (isHeadingStart(line.slice(j))) cuts.push(i + 1);
    }
    let prev = 0;
    cuts.forEach(c => { raw.push(line.slice(prev, c)); prev = c; });
    raw.push(line.slice(prev));
  });
  return raw
    .map(s => String(s == null ? '' : s).trim().replace(new RegExp('[' + SEPARATORS + ']+$'), '').trim())
    .filter(Boolean);
}

/* ---------- 单条解析 ---------- */
function parseItem(text) {
  const src = String(text == null ? '' : text).trim();
  const out = { 原文: src, 地点: '', 工序: '', 规格: '', 数量: null, 单位: '' };
  if (!src) return out;

  // 工序：优先取「施工方式修饰词」之后的命中（避免把「#3台变」这类地名当成工序），
  // 同起点取更长词；没有修饰词时取最靠前的命中。
  const mod = SPLIT_DICT.modifiers
    .map(w => ({ w, i: src.indexOf(w) }))
    .filter(x => x.i >= 0)
    .sort((a, b) => a.i - b.i)[0];
  const pick = minPos => {
    let hit = null;
    SPLIT_DICT.processes.forEach(p => {
      p.words.forEach(w => {
        const i = src.indexOf(w);
        if (i < 0 || i < minPos) return;
        if (!hit || i < hit.i || (i === hit.i && w.length > hit.len)) hit = { i, len: w.length, name: p.name };
      });
    });
    return hit;
  };
  let hit = pick(mod ? mod.i + mod.w.length : 0);
  if (!hit) hit = pick(0);
  if (hit) {
    out.工序 = hit.name;
    out.地点 = src.slice(0, hit.i).trim();
  }

  // 地点：剔除施工方式修饰词与电压等级（10kV/0.4kV 是电压，不是地点），剩下的才算地点
  if (out.地点) {
    let loc = out.地点;
    SPLIT_DICT.modifiers.forEach(w => { loc = loc.split(w).join(' '); });
    loc = loc.replace(/\d+(?:\.\d+)?\s*(?:kv|千伏)/gi, ' ');
    loc = loc.replace(/\s+/g, ' ').replace(/^[，,；;、\s]+|[，,；;、\s]+$/g, '').trim();
    out.地点 = loc;
  }

  // 数量与单位：数字 + 量词；多个候选时取最后一个（前面带「米」的通常是规格）
  const unitRe = new RegExp('(\\d+(?:\\.\\d+)?)\\s*(' + SPLIT_DICT.units.join('|') + ')', 'i');
  const cands = [];
  let m;
  const re = new RegExp(unitRe.source, 'gi');
  while ((m = re.exec(src)) !== null) cands.push({ num: +m[1], unit: m[2], raw: m[0], index: m.index });
  let qty = null;
  if (cands.length === 1) qty = cands[0];
  else if (cands.length > 1) {
    const counts = cands.filter(c => SPLIT_DICT.countUnits.indexOf(c.unit) > -1);
    qty = counts.length ? counts[counts.length - 1] : cands[cands.length - 1];
  }
  if (qty) { out.数量 = qty.num; out.单位 = qty.unit; }

  // 规格：Φ… / 型号 token / 「N米」（数量已占用同一处则跳过）
  const specParts = [];
  const phi = /Φ\s*\d+(?:\.\d+)?/i.exec(src);
  if (phi) specParts.push(phi[0].replace(/\s+/g, ''));
  const measure = src.match(/(\d+(?:\.\d+)?)\s*米/);
  if (measure && (!qty || qty.raw.replace(/\s+/g, '') !== measure[0].replace(/\s+/g, ''))) {
    specParts.push(measure[1] + '米');
  }
  const model = /(?:^|[^A-Za-z0-9])([A-Za-z]{1,4}[-—]?\d{1,4}[A-Za-z0-9\-\/]*)/.exec(src);
  if (model && !/^\d/.test(model[1]) && !phi) specParts.push(model[1]);
  out.规格 = specParts.join(' ');

  // 抽不出工序或数量 → 未解析（预览标黄）
  out.unparsed = !out.工序 || out.数量 == null;
  // 解析成功但映射不上七类字段 → 未映射（预览标灰）；由 quantitiesOf 统一标记
  out.unmapped = false;
  return out;
}

/* 每天的条目解析；「同上」类整条展开为上一天条目并标 expandedFrom */
function parseDayItems(dayContent, prevItems) {
  const segs = String(dayContent == null ? '' : dayContent)
    .split(/[，,；;。\n、]/)
    .map(s => String(s == null ? '' : s).trim().replace(/[。；;，,、]+$/, '').trim())
    .filter(Boolean);
  const items = [];
  segs.forEach(seg => {
    if (SPLIT_DICT.sameAsPrev.indexOf(seg) > -1) {
      (prevItems || []).forEach(it => {
        items.push(Object.assign({}, it, { expandedFrom: '同上', 原文: seg }));
      });
      return;
    }
    items.push(parseItem(seg));
  });
  return items;
}

/* ---------- 七类工程量 ---------- */
function mapFieldOf(item) {
  if (!item || !item.工序 || item.数量 == null) return null;
  let field = null;
  SPLIT_DICT.quantityMap.forEach(rule => {
    if (field) return;
    if (rule.processes.indexOf(item.工序) < 0) return;
    if (rule.when && !rule.when.test(item.原文)) return;
    if (rule.unless && rule.unless.test(item.原文)) return;
    field = rule.field;
  });
  return field;
}
function qtyValueOf(item, field) {
  const rule = SPLIT_DICT.quantityMap.filter(r => r.field === field)[0] || {};
  const n = Number(item.数量);
  if (!isFinite(n)) return 0;
  if (rule.convert === 'km' && String(item.单位) === '米') return n / 1000;
  return n;
}
/* 汇总当天七字段；同时给每条目标记 unmapped（解析成功但映射不上） */
function quantitiesOf(items) {
  const q = {};
  (items || []).forEach(it => {
    const field = mapFieldOf(it);
    if (!field) { if (it && !it.unparsed) it.unmapped = true; return; }
    const v = qtyValueOf(it, field);
    q[field] = Number(((q[field] || 0) + v).toFixed(3));
  });
  return q;
}

/* ---------- 主入口：按天切分 + 校验 + 结构化 ---------- */
function parseDailyContent(content, startDate, endDate) {
  const errors = [];
  const expected = dayList(startDate, endDate);
  const startY = expected.length ? +expected[0].slice(0, 4) : 0;
  const startM = expected.length ? +expected[0].slice(5, 7) : 0;
  const segs = segmentContent(content);
  const parsed = [];
  const seen = {};

  if (!segs.length || !segs.some(s => !!matchHeading(s))) {
    return {
      ok: false,
      errors: ['未识别到每日日期标题，请使用"03日：…"或"8月3号：…"等格式'],
      days: []
    };
  }

  let curY = startY, curM = startM, prevDay = null;
  let current = null;   // 当前累计的天
  segs.forEach((seg, idx) => {
    const h = matchHeading(seg);
    if (!h) {
      // 第一个标题之前的正文 → 段未带日期标题；标题之后的续行归当天内容
      if (!current) { errors.push('第 ' + (idx + 1) + ' 段未带日期标题'); return; }
      current.content = current.content ? (current.content + '\n' + seg) : seg;
      return;
    }
    // 解析日期：显式年月 → 直接用；只有月日 → 年份按计划开始年（跨年顺延）；
    // 只有「DD日」→ 月份沿用上一段，天数回退则月份 +1
    if (h.kind === 'ymd') { curY = h.y; curM = h.m; prevDay = h.d; }
    else if (h.kind === 'md') {
      curY = (startY && h.m < startM) ? startY + 1 : startY;
      curM = h.m; prevDay = h.d;
    } else {
      if (prevDay != null && h.d < prevDay) {
        curM += 1;
        if (curM > 12) { curM = 1; curY += 1; }
      }
      prevDay = h.d;
    }
    const date = ymd(curY, curM, prevDay);
    if (!isRealDate(curY, curM, prevDay)) {
      errors.push('工作内容日期"' + h.label + '"不是有效日期');
      current = { date, label: h.label, content: seg.slice(h.len).trim() };
      return;
    }
    const day = { date, label: h.label, content: seg.slice(h.len).trim() };
    if (seen[date] != null) errors.push('工作内容日期"' + h.label + '"重复');
    seen[date] = (seen[date] || 0) + 1;
    if (!day.content) errors.push('工作内容日期"' + h.label + '"内容为空');
    parsed.push(day);
    current = day;
  });

  // 范围校验 + 缺天校验（逐天列全）
  const inRange = {};
  parsed.forEach(d => {
    if (expected.indexOf(d.date) < 0) errors.push('工作内容日期"' + d.label + '"不在计划日期范围内');
    else inRange[d.date] = true;
  });
  expected.forEach(d => {
    if (!inRange[d]) errors.push('工作内容缺少计划日期：' + d);
  });

  // 条目结构化（按日期顺序，逐日可继承上一天条目）
  let prevItems = [];
  const days = parsed.map(d => {
    const items = parseDayItems(d.content, prevItems);
    const quantities = quantitiesOf(items);
    prevItems = items;
    return { date: d.date, content: d.content, items, quantities };
  });

  return { ok: errors.length === 0, errors, days };
}

/* 每天起止时刻 = 当天日期 + 父计划原开始/结束时刻；结束时刻 ≤ 开始时刻则结束顺延次日 */
function dayRange(date, startDate, endDate) {
  const d = String(date || '').slice(0, 10);
  const st = String(startDate || '').slice(11) || '00:00:00';
  const et = String(endDate || '').slice(11) || '23:59:59';
  const start = d + ' ' + st;
  let endDay = d;
  if (et <= st) {
    const dt = new Date(d + 'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() + 1);
    endDay = dt.toISOString().slice(0, 10);
  }
  return { start, end: endDay + ' ' + et };
}

/* 用户确认稿的工作量覆盖：显式数字覆盖，显式空串删除，未传沿用解析值 */
function mergeQuantities(parsed, override) {
  const q = Object.assign({}, parsed || {});
  if (override && typeof override === 'object') {
    QTY_FIELDS.forEach(k => {
      if (!Object.prototype.hasOwnProperty.call(override, k)) return;
      const raw = override[k];
      if (raw === '' || raw === null || raw === undefined) { delete q[k]; return; }
      const n = Number(String(raw).trim());
      if (isFinite(n)) q[k] = n;
    });
  }
  return q;
}

module.exports = {
  SPLIT_DICT, QTY_FIELDS,
  parseDailyContent, parseDayItems, parseItem, quantitiesOf, mapFieldOf,
  segmentContent, matchHeading, dayList, dayRange, mdLabel, mergeQuantities, ymd, isRealDate
};
