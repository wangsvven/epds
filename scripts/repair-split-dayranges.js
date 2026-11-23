#!/usr/bin/env node
'use strict';
/* ========== 拆分日计划时间形态修复（存量） ==========
 * 背景：旧 dayRange 把「源计划两端 00:00:00（只存了日期、没有具体时刻）」拆成
 *       「当天 00:00:00 → 次日 00:00:00」，日历按日期含结束日 → 每条多显示一天。
 * 本脚本把这类记录的 endDate 就地改成「当天 23:59:59」，使其落在同一自然日。
 *
 * 安全边界：
 *   - 只接受显式 --db <path>，无默认路径；直接读写 JSON 文件，**不加载 server/core/db**
 *     （避免触发迁移 / saveDB / 令牌等副作用）。
 *   - 识别条件严格（缺一不可）：未软删、splitBatchId 非空、startDate 与 endDate 均严格符合
 *     `YYYY-MM-DD HH:MM:SS`（空格分隔、无 T、无毫秒、无时区）、startDate 时刻为 00:00:00、
 *     endDate 时刻为 00:00:00、endDate 日期恰为 startDate 次日。
 *     手工录入的跨天计划（无 splitBatchId）形态再像也不命中。
 *   - 变换只改 endDate 一个字段，其余字段不动。
 *
 * 用法：
 *   node scripts/repair-split-dayranges.js --db <db.json> [--dry-run]   只读，打印差异清单（默认）
 *   node scripts/repair-split-dayranges.js --db <db.json> --apply       备份后写入，并重读校验
 *   node scripts/repair-split-dayranges.js --db <db.json> --rollback <备份路径>
 */

const fs = require('fs');
const path = require('path');

const STRICT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const nextDayOf = (d) => {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
};
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
};

function usage(msg) {
  if (msg) console.error('错误：' + msg + '\n');
  console.error('用法：');
  console.error('  node scripts/repair-split-dayranges.js --db <db.json> [--dry-run]');
  console.error('  node scripts/repair-split-dayranges.js --db <db.json> --apply');
  console.error('  node scripts/repair-split-dayranges.js --db <db.json> --rollback <备份路径>');
  process.exit(1);
}

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
const argOf = (name) => { const i = argv.indexOf(name); return i > -1 ? argv[i + 1] : undefined; };
const has = (name) => argv.includes(name);
const DB_ARG = argOf('--db');
const ROLLBACK = argOf('--rollback');
const APPLY = has('--apply');
const DRY = has('--dry-run') || (!APPLY && !ROLLBACK);

if (!DB_ARG) usage('必须用 --db <path> 显式指定数据库文件（本脚本没有默认路径）');
if (APPLY && ROLLBACK) usage('--apply 与 --rollback 不能同时使用');
if (ROLLBACK) {
  if (!fs.existsSync(ROLLBACK)) usage('备份文件不存在：' + ROLLBACK);
  if (!fs.existsSync(DB_ARG)) usage('目标文件不存在：' + DB_ARG);
  fs.copyFileSync(ROLLBACK, DB_ARG);
  console.log('已回滚：' + DB_ARG);
  console.log('来源备份：' + ROLLBACK);
  process.exit(0);
}

const DB_PATH = path.resolve(DB_ARG);
if (!fs.existsSync(DB_PATH)) usage('数据库文件不存在：' + DB_PATH);

let raw, db;
try {
  raw = fs.readFileSync(DB_PATH, 'utf8');
  db = JSON.parse(raw);
} catch (e) {
  usage('数据库文件不是合法 JSON：' + e.message);
}

/* ---------- 识别 ---------- */
const plans = Array.isArray(db.workPlans) ? db.workPlans : [];
const candidates = [];     // 可修复
const odd = [];            // 形似但格式异形（带 T / 毫秒 / 时区等），只列出不动
let skippedDeleted = 0;

for (const p of plans) {
  if (!p || !p.splitBatchId) continue;                 // 无批次：一律不命中
  if (p.deleted) { skippedDeleted++; continue; }        // 软删不修（不计入候选也不计入异形）
  const s = String(p.startDate == null ? '' : p.startDate);
  const e = String(p.endDate == null ? '' : p.endDate);

  // 先看时刻形态是否「双端零点 + 日期相邻」，用于把异形格式单独摘出来
  const stLoose = s.length >= 19 ? s.slice(11, 19) : '';
  const etLoose = e.length >= 19 ? e.slice(11, 19) : '';
  const sdLoose = s.slice(0, 10), edLoose = e.slice(0, 10);
  const looksLikeTarget = stLoose === '00:00:00' && etLoose === '00:00:00' &&
    /^\d{4}-\d{2}-\d{2}$/.test(sdLoose) && edLoose === nextDayOf(sdLoose);

  const strictOk = STRICT.test(s) && STRICT.test(e);
  if (!strictOk) {
    if (looksLikeTarget) odd.push({ id: p.id, batch: p.splitBatchId, startDate: s, endDate: e, status: p.status, deleted: !!p.deleted });
    continue;
  }
  const sd = s.slice(0, 10), ed = e.slice(0, 10);
  if (stLoose !== '00:00:00') continue;                 // 开始时刻非零：不是本类问题
  if (etLoose !== '00:00:00') continue;                 // 结束时刻非零：保持现有行为
  if (ed !== nextDayOf(sd)) continue;                   // 结束日期不是次日：不属本类坏形态
  candidates.push({
    id: p.id, batch: p.splitBatchId, status: p.status, deleted: !!p.deleted,
    from: e, to: sd + ' 23:59:59'
  });
}

/* ---------- 输出 ---------- */
function printReport() {
  console.log('库文件：' + DB_PATH);
  console.log('周计划总数：' + plans.length + '（其中带 splitBatchId：' +
    plans.filter(p => p && p.splitBatchId).length + '；因软删跳过：' + skippedDeleted + '）');
  console.log('');
  console.log('可修复候选：' + candidates.length + ' 条');
  if (candidates.length) {
    console.log('  id          批次         状态     软删  改前 endDate          → 改后 endDate');
    for (const c of candidates) {
      console.log('  ' + c.id.padEnd(12) + c.batch.padEnd(13) + String(c.status || '-').padEnd(9) +
        (c.deleted ? '是' : '否').padEnd(6) + c.from + '  →  ' + c.to);
    }
  }
  console.log('');
  if (odd.length) {
    console.log('【异形格式 · 未命中 · 需人工核对】' + odd.length + ' 条');
    for (const o of odd) {
      console.log('  ' + o.id + '  [' + o.batch + ']  start=' + JSON.stringify(o.startDate) +
        '  end=' + JSON.stringify(o.endDate) + '  status=' + (o.status || '-'));
    }
    console.log('  说明：字段含 T 分隔 / 毫秒 / 时区等非标准写法，本脚本不处理。');
  } else {
    console.log('异形格式（带 T / 毫秒 / 时区）：0 条');
  }
}

printReport();

if (DRY && !APPLY) {
  console.log('');
  console.log('以上为 dry-run（未写入任何文件）。确认后加 --apply 执行。');
  process.exit(0);
}

/* ---------- apply ---------- */
if (!candidates.length) {
  console.log('');
  console.log('无候选，未做任何修改。');
  process.exit(0);
}
const backup = path.join(path.dirname(DB_PATH),
  path.basename(DB_PATH, '.json') + '.before-splitfix-' + stamp() + '.json');
fs.copyFileSync(DB_PATH, backup);
console.log('');
console.log('已备份：' + backup);

const beforeById = new Map();
for (const p of plans) if (p) beforeById.set(p.id, JSON.stringify(p));

const byId = new Map();
for (const c of candidates) byId.set(c.id, c.to);
for (const p of plans) {
  if (p && byId.has(p.id)) p.endDate = byId.get(p.id);
}

const nextRaw = JSON.stringify(db, null, 2);
fs.writeFileSync(DB_PATH, nextRaw, 'utf8');

/* 写后重读校验 */
const after = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
const afterPlans = Array.isArray(after.workPlans) ? after.workPlans : [];
const problems = [];
if (afterPlans.length !== plans.length) problems.push('记录数变化：' + plans.length + ' → ' + afterPlans.length);
for (const c of candidates) {
  const rec = afterPlans.find(x => x && x.id === c.id);
  if (!rec) { problems.push('目标记录丢失：' + c.id); continue; }
  if (rec.endDate !== c.to) problems.push('改后值不符：' + c.id + ' = ' + rec.endDate + '（期望 ' + c.to + '）');
}
const targetIds = new Set(candidates.map(c => c.id));
for (const rec of afterPlans) {
  if (!rec || targetIds.has(rec.id)) continue;
  if (JSON.stringify(rec) !== beforeById.get(rec.id)) problems.push('非目标记录被改动：' + rec.id);
}
// 幂等复核：按同一识别条件再扫一遍，应为 0
const stillBad = afterPlans.filter(p => {
  if (!p || !p.splitBatchId || p.deleted) return false;
  const s = String(p.startDate || ''), e = String(p.endDate || '');
  if (!STRICT.test(s) || !STRICT.test(e)) return false;
  return s.slice(11) === '00:00:00' && e.slice(11) === '00:00:00' && e.slice(0, 10) === nextDayOf(s.slice(0, 10));
}).length;

console.log('已写入：' + DB_PATH);
console.log('修改条数：' + candidates.length);
console.log('校验：记录数 ' + afterPlans.length + '（不变）｜目标值 ' +
  (candidates.length - problems.filter(x => /目标|改后值/.test(x)).length) + '/' + candidates.length +
  '｜其余记录未被改动 ' + (problems.some(x => /非目标/.test(x)) ? '否' : '是') +
  '｜残留候选 ' + stillBad);
if (problems.length) {
  console.log('');
  console.log('【校验发现问题】');
  problems.forEach(x => console.log('  - ' + x));
  console.log('可用 --rollback ' + backup + ' 回滚。');
  process.exit(2);
}
console.log('');
console.log('校验通过。回滚可用：node scripts/repair-split-dayranges.js --db ' + DB_PATH + ' --rollback ' + backup);
