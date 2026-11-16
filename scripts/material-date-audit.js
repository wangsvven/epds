#!/usr/bin/env node
/* ========== scripts/material-date-audit.js ==========
 * 材料业务日期与期初数据的「只读审计」。
 *
 * 用法：node scripts/material-date-audit.js [db.json 路径]
 *   缺省读 <repo>/data/db.json；建议传副本路径，避免碰生产库。
 *
 * 硬约束：
 *   - 只读：直接 JSON.parse 文件，**不 require 任何 server/ 模块**，
 *     因此不会触发自动迁移、不会 saveDB、不会建备份文件；
 *   - 前后各算一次 md5，退出前比对，文件被改动即报错（exit 2）；
 *   - 输出只含内部 id 与单号，不含领取人/电话等个人信息。
 *
 * 统计项与《登记出库按出库日期核算可用库存》第 0 步一一对应：
 *   ① history 缺 arrivalDate（按回退来源分类）
 *   ② 出库单缺 outDate、归还条目缺 returnDate
 *   ③ bizDateFallback: true 清单
 *   ④ 材料缺期初三字段
 *   ⑤ openingRaw < 0 清单
 *   ⑥ legacy 领料单 / 出库单数量
 *   ⑦ 同工程同编码多 id 的材料组数
 *   ⑧ openingAvailable > 0 但 qtyArrived <= 0（核实 /stock 的 qtyArrived > 0 是否漏掉合法期初来源）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'data', 'db.json');
if (!fs.existsSync(FILE)) {
  console.error('找不到数据文件：' + FILE);
  process.exit(1);
}
const md5Of = p => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
const before = md5Of(FILE);
const db = JSON.parse(fs.readFileSync(FILE, 'utf8'));

const arr = v => (Array.isArray(v) ? v : []);
const dayOf = v => {
  const s = String(v == null ? '' : v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
};
const num = v => Number(v) || 0;
const alive = x => x && !x.deleted;

const out = [];
const line = s => out.push(s == null ? '' : s);
const cut = (list, n) => list.slice(0, n === undefined ? 10 : n);

const reqs = arr(db.materialRequisitions);
const obs = arr(db.materialOutbound);
const mats = arr(db.materials);

/* ---------- ① history 缺 arrivalDate，按回退来源分类 ---------- */
const fb = { hAt: [], reqConfirmedAt: [], reqReqDate: [], none: [] };
let histTotal = 0;
let histWithArrival = 0;
reqs.filter(alive).forEach(r => {
  if (r.status === '已作废') return;   // 作废单不产生事件，日期缺失不影响回放
  arr(r.history).forEach((h, hi) => {
    arr(h && h.rows).forEach(row => {
      if (!row || num(row.thisQty) <= 0) return;   // eventsOf 只取 thisQty > 0
      histTotal++;
      const d0 = dayOf(h && h.arrivalDate);
      if (d0) { histWithArrival++; return; }
      if (dayOf(h && h.at)) fb.hAt.push({ reqNo: r.reqNo || '', reqId: r.id, h: hi });
      else if (dayOf(r.confirmedAt)) fb.reqConfirmedAt.push({ reqNo: r.reqNo || '', reqId: r.id, h: hi });
      else if (dayOf(r.reqDate)) fb.reqReqDate.push({ reqNo: r.reqNo || '', reqId: r.id, h: hi });
      else fb.none.push({ reqNo: r.reqNo || '', reqId: r.id, h: hi });
    });
  });
});

/* ---------- ② 出库单缺 outDate / 归还条目缺 returnDate ---------- */
const obNoOutDate = [];
const obRetNoDate = [];
obs.filter(alive).forEach(o => {
  const d = dayOf(o.outDate);
  if (!d) obNoOutDate.push({ outNo: o.outNo || '', id: o.id, legacy: o.legacy === true, bizDateFallback: o.bizDateFallback === true });
  arr(o.returns).forEach((x, xi) => {
    if (!x) return;
    const hasRow = arr(x.rows).some(y => y && num(y.qty) > 0);
    if (!hasRow) return;
    if (!dayOf(x.returnDate) && !d) obRetNoDate.push({ outNo: o.outNo || '', id: o.id, ri: xi });
  });
});

/* ---------- ③ bizDateFallback ---------- */
const fallbackReqs = reqs.filter(r => alive(r) && r.bizDateFallback === true);
const fallbackObs = obs.filter(o => alive(o) && o.bizDateFallback === true);

/* ---------- ④ 材料缺期初三字段 ---------- */
const OPEN_KEYS = ['openingAvailable', 'openingDate', 'openingAt'];
const matNoOpening = mats.filter(alive).filter(m => OPEN_KEYS.some(k => m[k] === undefined || m[k] === null || m[k] === ''));
const matNoRaw = mats.filter(alive).filter(m => m.openingRaw === undefined);

/* ---------- ⑤ openingRaw < 0 ---------- */
const matNegRaw = mats.filter(alive).filter(m => m.openingRaw !== undefined && num(m.openingRaw) < 0);

/* ---------- ⑥ legacy 单量 ---------- */
const legacyReqs = reqs.filter(r => alive(r) && r.legacy === true);
const legacyObs = obs.filter(o => alive(o) && o.legacy === true);

/* ---------- ⑦ 同工程同编码多 id ---------- */
const byProjCode = new Map();
mats.filter(alive).forEach(m => {
  const code = String(m.code == null ? '' : m.code).trim();
  if (!code) return;
  const k = String(m.project == null ? '' : m.project) + '\u0001' + code;
  if (!byProjCode.has(k)) byProjCode.set(k, []);
  byProjCode.get(k).push(m);
});
const dupGroups = [...byProjCode.entries()].filter(([, v]) => v.length > 1)
  .map(([k, v]) => ({ project: k.split('\u0001')[0], code: k.split('\u0001')[1], ids: v.map(m => m.id), n: v.length }))
  .sort((a, b) => b.n - a.n);

/* ---------- ⑧ openingAvailable > 0 但 qtyArrived <= 0 ---------- */
const openNoArrived = mats.filter(alive)
  .filter(m => num(m.openingAvailable) > 0 && num(m.qtyArrived) <= 0)
  .map(m => ({ id: m.id, code: m.code, project: m.project, openingAvailable: m.openingAvailable, openingRaw: m.openingRaw, qtyArrived: m.qtyArrived }));

/* ---------- 报告 ---------- */
line('# 材料业务日期与期初 · 只读审计');
line('');
line('- 数据文件：`' + FILE + '`');
line('- 文件大小：' + fs.statSync(FILE).size + ' B');
line('- 审计前 md5：`' + before + '`');
line('- 集合规模：材料 ' + mats.length + '（有效 ' + mats.filter(alive).length + '）｜领料单 ' + reqs.length + '｜出库单 ' + obs.length);
line('');

line('## ① history 缺 arrivalDate（仅统计未删除且未作废、thisQty > 0 的条目）');
line('');
line('- 参与回放的 history 条目：**' + histTotal + '**，其中带 arrivalDate：**' + histWithArrival + '**，需走回退链：**' + (histTotal - histWithArrival) + '**');
line('- 回退到 `h.at`：' + fb.hAt.length + '｜`r.confirmedAt`：' + fb.reqConfirmedAt.length + '｜`r.reqDate`：' + fb.reqReqDate.length + '｜无任何可用日期：' + fb.none.length);
if (fb.hAt.length || fb.reqConfirmedAt.length || fb.reqReqDate.length || fb.none.length) {
  line('');
  line('| 回退来源 | 单号 | 单 id | history 序号 |');
  line('|---|---|---|---|');
  [['h.at', fb.hAt], ['confirmedAt', fb.reqConfirmedAt], ['reqDate', fb.reqReqDate], ['无日期', fb.none]]
    .forEach(([src, list]) => cut(list, 15).forEach(x => line('| ' + src + ' | ' + (x.reqNo || '—') + ' | `' + x.reqId + '` | ' + x.h + ' |')));
}
line('');

line('## ② 出库单缺 outDate / 归还条目缺 returnDate');
line('');
line('- 未删除出库单缺 outDate：**' + obNoOutDate.length + '**');
if (obNoOutDate.length) {
  line('');
  line('| 单号 | id | legacy | bizDateFallback |');
  line('|---|---|---|---|');
  cut(obNoOutDate).forEach(x => line('| ' + (x.outNo || '—') + ' | `' + x.id + '` | ' + (x.legacy ? '是' : '否') + ' | ' + (x.bizDateFallback ? '是' : '否') + ' |'));
}
line('- 归还条目缺 returnDate 且所属出库单也无 outDate：**' + obRetNoDate.length + '**');
if (obRetNoDate.length) {
  line('');
  line('| 单号 | id | 归还序号 |');
  line('|---|---|---|');
  cut(obRetNoDate).forEach(x => line('| ' + (x.outNo || '—') + ' | `' + x.id + '` | ' + x.ri + ' |'));
}
line('');

line('## ③ bizDateFallback: true');
line('');
line('- 领料单 **' + fallbackReqs.length + '** 张，出库单 **' + fallbackObs.length + '** 张');
if (fallbackReqs.length || fallbackObs.length) {
  line('');
  line('| 类型 | 单号 | id | 业务日期 |');
  line('|---|---|---|---|');
  cut(fallbackReqs).forEach(r => line('| 领料单 | ' + (r.reqNo || '—') + ' | `' + r.id + '` | ' + (dayOf(r.reqDate) || '—') + ' |'));
  cut(fallbackObs).forEach(o => line('| 出库单 | ' + (o.outNo || '—') + ' | `' + o.id + '` | ' + (dayOf(o.outDate) || '—') + ' |'));
}
line('');

line('## ④ 材料缺期初三字段（openingAvailable / openingDate / openingAt）');
line('');
line('- 缺任一字段：**' + matNoOpening.length + '** 条｜缺 openingRaw：**' + matNoRaw.length + '** 条');
if (matNoOpening.length) {
  line('');
  line('| id | code | 缺哪些 | createdAt | qtyArrived |');
  line('|---|---|---|---|---|');
  cut(matNoOpening).forEach(m => line('| `' + m.id + '` | ' + (m.code || '—') + ' | ' + OPEN_KEYS.filter(k => m[k] === undefined || m[k] === null || m[k] === '').join('、') + ' | ' + (m.createdAt || '—') + ' | ' + m.qtyArrived + ' |'));
}
line('');

line('## ⑤ openingRaw < 0（老账负余额）');
line('');
line('- **' + matNegRaw.length + '** 条');
if (matNegRaw.length) {
  line('');
  line('| id | code | project | openingRaw | openingAvailable | qtyArrived |');
  line('|---|---|---|---|---|---|');
  cut(matNegRaw).forEach(m => line('| `' + m.id + '` | ' + (m.code || '—') + ' | ' + (m.project || '—') + ' | ' + m.openingRaw + ' | ' + m.openingAvailable + ' | ' + m.qtyArrived + ' |'));
}
line('');

line('## ⑥ legacy 单量');
line('');
line('- 领料单 legacy：**' + legacyReqs.length + '** / ' + reqs.filter(alive).length + '｜出库单 legacy：**' + legacyObs.length + '** / ' + obs.filter(alive).length);
line('');

line('## ⑦ 同工程同编码多 id 的材料组');
line('');
line('- **' + dupGroups.length + '** 组（涉及材料 ' + dupGroups.reduce((s, g) => s + g.n, 0) + ' 条）');
if (dupGroups.length) {
  line('');
  line('- 最多的一组：' + dupGroups[0].n + ' 条（' + (dupGroups[0].project || '—') + ' / ' + dupGroups[0].code + '）');
  line('');
  line('| 工程 | 编码 | 条数 | id 列表（前 4） |');
  line('|---|---|---|---|');
  cut(dupGroups, 15).forEach(g => line('| ' + (g.project || '—') + ' | ' + g.code + ' | ' + g.n + ' | `' + g.ids.slice(0, 4).join('`, `') + '` |'));
}
line('');

line('## ⑧ openingAvailable > 0 但 qtyArrived <= 0（/stock 的 qtyArrived > 0 是否会漏掉）');
line('');
line('- **' + openNoArrived.length + '** 条');
if (openNoArrived.length) {
  line('');
  line('| id | code | project | openingAvailable | openingRaw | qtyArrived |');
  line('|---|---|---|---|---|---|');
  cut(openNoArrived).forEach(m => line('| `' + m.id + '` | ' + (m.code || '—') + ' | ' + (m.project || '—') + ' | ' + m.openingAvailable + ' | ' + m.openingRaw + ' | ' + m.qtyArrived + ' |'));
}
line('');

const after = md5Of(FILE);
line('## 只读校验');
line('');
line('- 审计后 md5：`' + after + '`');
line('- 结论：' + (before === after ? '**文件未变（只读成立）**' : '**文件发生变化，审计过程有写入，须立即排查**'));

console.log(out.join('\n'));
if (before !== after) process.exit(2);
