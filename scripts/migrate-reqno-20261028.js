#!/usr/bin/env node
/* ========== 领料单号一次性迁移：全部历史单重编为 LL-YYYYMMDD-NNN ==========
 * 背景：定版格式为 LL-YYYYMMDD-NNN（3 位当日流水）。历史存在 LL-YYYYMMDD-NNNN（4 位流水）、
 *       LL-YYYYMMDD-NNNNNN（6 位时间后缀），以及上一批短暂使用的无前缀 YYYYMMDD-NNN。
 * 规则：按 reqNo 中的日期分组；组内按 createdAt 升序（并列时按旧后缀数值升序、再按 id）定先后；
 *       依次赋 LL-日期-001、002、003…。只改 reqNo，其余字段与记录顺序一律不动（含已删除、已作废）。
 * 幂等：已是目标格式且序号与规则一致时不写盘，重复运行结果不变。
 *
 * 用法：
 *   node scripts/migrate-reqno-20261028.js                预演（只打印映射，不写盘，作用于 <repo>/data）
 *   node scripts/migrate-reqno-20261028.js --apply        执行写盘
 *   node scripts/migrate-reqno-20261028.js --data /path   指定数据目录（默认 <repo>/data）
 *   node scripts/migrate-reqno-20261028.js --json out.json 同时把映射表写成 JSON
 *
 * 注意：必须在目标实例**停机**状态下执行（运行中的进程内存里持有 DB，改文件会被覆盖）。
 */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const DATA_ARG = (() => { const i = argv.indexOf('--data'); return i > -1 ? argv[i + 1] : ''; })();
const JSON_ARG = (() => { const i = argv.indexOf('--json'); return i > -1 ? argv[i + 1] : ''; })();
const STRICT = argv.includes('--strict');   // 有「无法解析」的记录时是否也中止（默认跳过不动、继续）
const DATA_DIR = DATA_ARG ? path.resolve(DATA_ARG) : path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

// 目标格式：LL-YYYYMMDD-3 位及以上数字
const TARGET_RE = /^LL-(\d{8})-(\d{3,})$/;
// 解析（兼容历史三种写法）：可选 LL- 前缀 + 8 位日期 + '-' + 数字后缀
const PARSE_RE = /^(?:LL-)?(\d{8})-(\d+)$/;

function parseReqNo(no) {
  const m = String(no == null ? '' : no).match(PARSE_RE);
  if (!m) return null;
  return { date: m[1], sufLen: m[2].length, seq: parseInt(m[2], 10) };
}

function buildMapping(list) {
  const groups = new Map();
  const skipped = [];
  list.forEach((rec, idx) => {
    const p = parseReqNo(rec.reqNo);
    if (!p) { skipped.push({ idx, id: rec.id, reqNo: rec.reqNo, createdAt: rec.createdAt, reason: '无法解析出日期' }); return; }
    if (!groups.has(p.date)) groups.set(p.date, []);
    groups.get(p.date).push({ rec, idx, p });
  });
  const mapping = [];
  [...groups.keys()].sort().forEach(date => {
    const rows = groups.get(date).slice().sort((a, b) => {
      const ca = String(a.rec.createdAt || ''), cb = String(b.rec.createdAt || '');
      if (ca !== cb) return ca < cb ? -1 : 1;          // createdAt 升序（空串排最前，再由后缀/id 兜底）
      if (a.p.seq !== b.p.seq) return a.p.seq - b.p.seq; // 并列：旧后缀数值升序
      return String(a.rec.id) < String(b.rec.id) ? -1 : 1;
    });
    rows.forEach((row, i) => {
      mapping.push({
        id: row.rec.id, createdAt: row.rec.createdAt, deleted: !!row.rec.deleted, status: row.rec.status,
        old: String(row.rec.reqNo), next: 'LL-' + date + '-' + String(i + 1).padStart(3, '0'), idx: row.idx
      });
    });
  });
  return { mapping, skipped };
}

// 引用检查：全库搜索旧单号字符串，排除每个记录自身的 reqNo 字段
function collectStrings(node, pathStr, out) {
  if (node == null) return;
  if (typeof node === 'string') { out.push({ value: node, path: pathStr }); return; }
  if (Array.isArray(node)) { node.forEach((v, i) => collectStrings(v, pathStr + '[' + i + ']', out)); return; }
  if (typeof node === 'object') Object.keys(node).forEach(k => collectStrings(node[k], pathStr ? pathStr + '.' + k : k, out));
}

function main() {
  if (!fs.existsSync(DB_PATH)) { console.error('找不到 ' + DB_PATH); process.exit(1); }
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  const list = Array.isArray(db.materialRequisitions) ? db.materialRequisitions : [];
  const { mapping, skipped } = buildMapping(list);

  // 幂等判定：每条的新号都与现值一致 → 无需改动
  const changed = mapping.filter(m => m.old !== m.next);

  // 引用检查
  const strings = [];
  collectStrings(db, '', strings);
  const ownPaths = new Set(mapping.map(m => 'materialRequisitions[' + m.idx + '].reqNo'));
  const refs = [];
  mapping.forEach(m => {
    strings.forEach(s => {
      if (ownPaths.has(s.path)) return;                 // 自身 reqNo 字段跳过
      if (s.value === m.old || (s.value.length > m.old.length && s.value.indexOf(m.old) > -1)) {
        refs.push({ reqNo: m.old, path: s.path, value: s.value.slice(0, 80) });
      }
    });
  });

  // 新号唯一性
  const seen = new Map();
  const dupes = [];
  mapping.forEach(m => { if (seen.has(m.next)) dupes.push(m.next); else seen.set(m.next, m.id); });

  console.log('数据目录：' + DATA_DIR);
  console.log('模式：' + (APPLY ? '执行写盘' : '预演（不写盘）'));
  console.log('领料单总数：' + list.length + '｜可解析：' + mapping.length + '｜无法解析：' + skipped.length + '｜需改号：' + changed.length);
  console.log('');
  console.log('旧号 → 新号');
  mapping.forEach(m => {
    console.log('  ' + m.old.padEnd(20) + ' → ' + m.next + (m.old === m.next ? '  （已是目标值）' : '') + '   [' + m.createdAt + ']' + (m.deleted ? ' 已删除' : '') + ' ' + (m.status || ''));
  });
  if (skipped.length) {
    console.log('');
    console.log('⚠ 无法解析（未改动，待裁定）：');
    skipped.forEach(s => console.log('  ' + JSON.stringify(s)));
  }
  if (refs.length) {
    console.log('');
    console.log('⚠ 其它位置存在旧单号副本（需人工裁定）：');
    refs.forEach(r => console.log('  ' + r.reqNo + ' @ ' + r.path + ' = ' + r.value));
  } else {
    console.log('');
    console.log('引用检查：全库除自身 reqNo 字段外，无旧单号副本（下载文件名/导出均为即时拼接）。');
  }
  if (dupes.length) { console.log(''); console.log('⚠ 新号重复：' + [...new Set(dupes)].join('、')); }

  if (JSON_ARG) {
    fs.writeFileSync(JSON_ARG, JSON.stringify({ dataDir: DATA_DIR, total: list.length, mapping, skipped, refs }, null, 2), 'utf8');
    console.log('\n映射表已写出：' + JSON_ARG);
  }

  if (!APPLY) { console.log('\n未加 --apply，未写盘。'); return; }
  if (refs.length || dupes.length || (STRICT && skipped.length)) {
    console.log('\n存在 refs / dupes' + (STRICT ? ' / skipped' : '') + '，按护栏中止写盘。');
    process.exit(2);
  }
  if (!changed.length) { console.log('\n已是目标格式，无需写盘（幂等）。'); return; }

  // 只改 reqNo，其余字段与数组顺序不动
  mapping.forEach(m => { db.materialRequisitions[m.idx].reqNo = m.next; });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
  console.log('\n已写盘：' + DB_PATH + '（改号 ' + changed.length + ' 条）');
}

main();
