#!/usr/bin/env node
/* ========== 非 ZT 数据三方比对（只读） ==========
 * 用途：每批验收与发布前，确认生产 / 副本 / 基线三方「业务数据」的差异。
 *
 * 只读约定（写死，不改）：
 *   - 只 fs.readFileSync 三份 db.json，不启服务、不调任何接口（自然也没有写接口）、不写任何库；
 *   - 不修改入参文件，不产生临时文件。
 *
 * 口径（写死，不改）：
 *   - 项目名以「ZT测试-」开头的视为测试数据，其余为业务数据；
 *   - 领料单的项目取 items[].project 与 projects[]，只要出现非测试项目就按业务数据统计（宁可多比，不藏数据）；
 *   - 出库单取 project，材料取 project；
 *   - 「含已删除」「未删除」两种计数都输出，逐条比对时两者都参与。
 *
 * 门禁口径（--gate）：
 *   - copy-baseline（推荐，R4-NZT 用）：只有「副本 vs 基线」决定退出码；
 *     生产与基线的差异照常逐条打印，但标为观察项，不判整门失败。
 *     发布前应把当时的生产快照作为基线，这样门禁等价于「副本对发布前生产」。
 *   - all（默认，保留原严格口径）：三方任一差异都判失败。
 *
 * 用法：
 *   node scripts/non-zt-compare.js --baseline <基线 db.json> [--gate copy-baseline] [--prod <生产 db.json>] [--copy <副本 db.json>]
 *   默认：--copy = 本脚本所在项目的 data/db.json；--prod = 环境变量 EPDS_PROD_DB 或本机生产目录
 * 退出码：0 = 门禁通过（copy-baseline 下输出 GATE PASS）；1 = 门禁失败；2 = 参数/文件/JSON 错误
 */
const fs = require('fs');
const path = require('path');

const ZT_RE = /^ZT测试-/;
const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
function argOf(name, dft) {
  const i = argv.indexOf('--' + name);
  return i > -1 && argv[i + 1] ? argv[i + 1] : dft;
}
const BASE_PATH = argOf('baseline', '');
const COPY_PATH = argOf('copy', path.join(ROOT, 'data', 'db.json'));
const PROD_PATH = argOf('prod', process.env.EPDS_PROD_DB || '/Users/admin/WorkBuddy/复刻/epds/data/db.json');
const GATE = argOf('gate', 'all');

if (!BASE_PATH) {
  console.error('用法：node scripts/non-zt-compare.js --baseline <基线 db.json> [--gate copy-baseline|all] [--prod <生产 db.json>] [--copy <副本 db.json>]');
  process.exit(2);
}
if (GATE !== 'all' && GATE !== 'copy-baseline') {
  console.error('--gate 只能是 copy-baseline 或 all，收到：' + GATE);
  process.exit(2);
}

function load(label, p) {
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) { console.error('找不到' + label + '：' + abs); process.exit(2); }
  const st = fs.statSync(abs);
  let db;
  try { db = JSON.parse(fs.readFileSync(abs, 'utf8')); }
  catch (e) { console.error(label + ' 不是合法 JSON：' + e.message); process.exit(2); }
  return {
    label, path: abs, db,
    mtime: new Date(st.mtimeMs + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ') + '（北京时间）',
    size: st.size
  };
}

const SRC = {
  base: load('基线', BASE_PATH),
  prod: load('生产', PROD_PATH),
  copy: load('副本', COPY_PATH)
};

const arr = (db, k) => (Array.isArray(db[k]) ? db[k] : []);
const round = n => Math.round((Number(n) || 0) * 10000) / 10000;
const sumBy = (rows, field) => round((rows || []).reduce((s, r) => s + (Number(r && r[field]) || 0), 0));

const isTestProject = n => ZT_RE.test(String(n == null ? '' : n).trim());

/* 三张表的取数口径：isBusiness 判断是否业务数据；sig 为逐条比对指纹（单号/状态/数量/录入时间） */
const TABLES = [
  {
    key: 'materialRequisitions',
    name: '领料单',
    isBusiness(r) {
      const names = [];
      (r.items || []).forEach(i => { if (i && i.project) names.push(i.project); });
      (r.projects || []).forEach(p => { if (p) names.push(p); });
      if (!names.length) return true; // 没有项目名的记录不隐藏
      return names.every(n => !isTestProject(n));
    },
    no: r => r.reqNo || r.id || '',
    label: r => r.reqNo || r.id || '(无单号)',
    qty: r => String(sumBy(r.items, 'qty')),
    status: r => r.status || '',
    time: r => r.createdAt || ''
  },
  {
    key: 'materialOutbound',
    name: '出库单',
    isBusiness(r) { return !isTestProject(r.project); },
    no: r => r.outNo || r.id || '',
    label: r => r.outNo || r.id || '(无单号)',
    qty: r => sumBy(r.items, 'qty') + '/' + sumBy(r.items, 'returned'),
    status: r => r.status || '',
    time: r => r.createdAt || ''
  },
  {
    key: 'materials',
    name: '材料',
    isBusiness(r) { return !isTestProject(r.project); },
    no: r => r.code || '',
    label: r => [r.code || '(无编码)', r.description || ''].join(' ').trim(),
    qty: r => round(r.qtyRequired) + '/' + round(r.qtyArrived),
    status: r => r.status || '',
    time: r => r.createdAt || ''
  }
];

function pick(S, table) {
  const all = arr(S.db, table.key);
  const biz = all.filter(r => r && table.isBusiness(r));
  const alive = biz.filter(r => !r.deleted);
  const map = new Map();
  biz.forEach(r => {
    const k = String(r.id || table.no(r) || '');
    if (!k) return;
    map.set(k, {
      label: table.label(r),
      sig: JSON.stringify([table.no(r), table.status(r), table.qty(r), table.time(r)]),
      deleted: !!r.deleted,
      raw: [table.no(r), table.status(r), table.qty(r), table.time(r)]
    });
  });
  return { all: biz.length, alive: alive.length, map };
}

const ids = ['base', 'prod', 'copy'];
const pad = (s, n) => { s = String(s); let w = 0; for (const ch of s) w += ch.charCodeAt(0) > 255 ? 2 : 1; return s + ' '.repeat(Math.max(0, n - w)); };
const strict = GATE === 'all';

console.log('==== 非 ZT 数据三方比对（只读） ====');
ids.forEach(k => console.log(pad(SRC[k].label, 4) + '：' + SRC[k].path + '\n      修改时间 ' + SRC[k].mtime + ' · ' + SRC[k].size + ' 字节'));
console.log('口径：项目名不以「ZT测试-」开头视为业务数据；含已删除 / 未删除两种计数都输出');
console.log('门禁：' + (strict ? '三方任一差异均失败（all）' : '只看「副本 vs 基线」，生产差异仅作观察（copy-baseline）') + '\n');

let gateDiffs = 0;
let watchDiffs = 0;
const rows = [];
TABLES.forEach(t => {
  const P = {}; ids.forEach(k => { P[k] = pick(SRC[k], t); });
  const db1 = P.prod.all - P.base.all;
  const db2 = P.copy.all - P.base.all;
  rows.push({
    name: t.name,
    base: P.base.all + '/' + P.base.alive,
    prod: P.prod.all + '/' + P.prod.alive,
    copy: P.copy.all + '/' + P.copy.alive,
    d1: (db1 > 0 ? '+' : '') + db1,
    d2: (db2 > 0 ? '+' : '') + db2
  });
  // 逐条：并集里任一方缺失或指纹不同都算差异；门禁模式下按「是否涉及副本对基线」分类
  const keys = new Set([...P.base.map.keys(), ...P.prod.map.keys(), ...P.copy.map.keys()]);
  const list = [];
  const add = (text, gate) => list.push({ text, gate: strict ? true : !!gate });
  keys.forEach(k => {
    const e = ids.map(x => P[x].map.get(k));
    const miss = ids.filter((x, i) => !e[i]);
    const labels = e.filter(Boolean).map(x => x.label);
    if (miss.length) {
      add((labels[0] || k) + '：仅存在于 ' + ids.filter((x, i) => e[i]).map(x => SRC[x].label).join('/') + '，缺失于 ' + miss.map(x => SRC[x].label).join('/'),
        !!e[0] !== !!e[2]); // 基线与副本对「是否存在」不一致才进门禁；仅生产多/少算观察
      return;
    }
    if (e[0].sig !== e[1].sig || e[0].sig !== e[2].sig) {
      const fields = ['单号', '状态', '数量', '录入时间'];
      const detail = fields.map((f, i) => {
        const vals = e.map(x => String(x.raw[i]));
        return vals[0] === vals[1] && vals[0] === vals[2] ? '' : f + '=' + vals.join(' | ');
      }).filter(Boolean).join('；');
      add(labels[0] + '：' + detail + '（顺序：基线 | 生产 | 副本）', e[0].sig !== e[2].sig);
    }
    // 删除标记也纳入（同一单号一边删一边没删）
    if (e[0].deleted !== e[1].deleted || e[0].deleted !== e[2].deleted) {
      add(labels[0] + '：删除标记不一致（基线 ' + e[0].deleted + ' / 生产 ' + e[1].deleted + ' / 副本 ' + e[2].deleted + '）',
        e[0].deleted !== e[2].deleted);
    }
  });
  const g = list.filter(x => x.gate);
  const w = list.filter(x => !x.gate);
  gateDiffs += g.length;
  watchDiffs += w.length;
  if (list.length) {
    console.log('【' + t.name + '】差异 ' + list.length + ' 条' + (strict ? '' : '（门禁 ' + g.length + ' / 观察 ' + w.length + '）') + '：');
    list.slice(0, 50).forEach(x => console.log('  - ' + (strict ? '' : (x.gate ? '[门禁] ' : '[观察] ')) + x.text));
    if (list.length > 50) console.log('  …… 其余 ' + (list.length - 50) + ' 条省略');
    console.log('');
  }
});

console.log(pad('表', 8) + pad('基线 全/有效', 16) + pad('生产 全/有效', 16) + pad('副本 全/有效', 16) + pad('生产−基线', 12) + '副本−基线');
rows.forEach(r => console.log(pad(r.name, 8) + pad(r.base, 16) + pad(r.prod, 16) + pad(r.copy, 16) + pad(r.d1, 12) + r.d2));

const countDiff = rows.some(r => r.d1 !== '0' || r.d2 !== '0');
const gateCountDiff = rows.some(r => r.d2 !== '0');

if (strict) {
  if (gateDiffs || countDiff) {
    console.log('\n结果：DIFF（逐条差异 ' + gateDiffs + ' 条' + (countDiff ? '，行数存在差值' : '') + '）');
    process.exit(1);
  }
  console.log('\nSAME：三张表在「非 ZT 业务数据」口径下完全一致（含未删除与含已删除两种计数均无差值）');
  process.exit(0);
}

// copy-baseline：生产差异只观察，不判失败
if (gateDiffs || gateCountDiff) {
  console.log('\n结果：GATE FAIL（副本对基线：逐条差异 ' + gateDiffs + ' 条' + (gateCountDiff ? '，行数有差值' : '') + '）'
    + (watchDiffs ? '；另有生产观察差异 ' + watchDiffs + ' 条' : ''));
  process.exit(1);
}
console.log('\nGATE PASS：副本与基线在「非 ZT 业务数据」口径下一致（含未删除与含已删除两种计数均无差值）');
if (watchDiffs || (countDiff && rows.some(r => r.d1 !== '0'))) {
  console.log('观察：生产与基线存在差异 ' + watchDiffs + ' 条（行数差见上表「生产−基线」列），按约定不影响本次门禁；发布前应以当时的生产快照为基线复核。');
} else {
  console.log('观察：生产与基线也无差异。');
}
process.exit(0);
