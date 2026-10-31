/* ========== 单据流水号一次性迁移：领料单 / 出库单统一为 4 位流水 ==========
 * 目标格式：
 *   领料单  LL-YYYYMMDD-NNNN（如 LL-20261028-0001）
 *   出库单  OUT-YYYYMMDD-NNNN（如 OUT-20261024-0001）
 * 规则（其余不变）：
 *   - 前缀与日期段不变，只把流水位统一为「4 位补零、从 0001 起」
 *   - 按单号中的日期分组；组内按 createdAt 升序（并列按旧流水数值、再按 id）重新编号
 *   - 含已删除 / 已作废记录一并重编（单号不回收），记录顺序与其余字段一律不动
 * 安全：
 *   - 默认 dry-run，只打印映射；加 --apply 才写盘
 *   - 写盘前自动备份到 _backup/db.json.before-no4-<HHMMSS>
 *   - 全库引用检查：旧单号若出现在自身 reqNo/outNo 以外的位置，默认阻断（--force 可越过）
 *
 * 用法：
 *   node scripts/migrate-no4-20261031.js                 # 预演
 *   node scripts/migrate-no4-20261031.js --apply         # 执行
 *   node scripts/migrate-no4-20261031.js --db /tmp/x/data/db.json --apply
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FORCE = args.includes('--force');
const dbArgIdx = args.indexOf('--db');
const ROOT = path.join(__dirname, '..');
const DB_PATH = dbArgIdx >= 0 && args[dbArgIdx + 1] ? args[dbArgIdx + 1] : path.join(ROOT, 'data', 'db.json');

// 解析单号：可选前缀 + 8 位日期 + '-' + 数字流水
function parseNo(no, prefix) {
  const s = String(no == null ? '' : no).trim();
  const re = new RegExp('^' + prefix + '(\\d{8})-(\\d+)$');
  const m = s.match(re);
  return m ? { date: m[1], seq: parseInt(m[2], 10), seqText: m[2] } : null;
}

function plan(records, prefix, field) {
  const groups = new Map();
  const skipped = [];
  records.forEach((rec, idx) => {
    const p = parseNo(rec && rec[field], prefix);
    if (!p) { skipped.push({ idx, id: rec && rec.id, no: rec && rec[field] }); return; }
    if (!groups.has(p.date)) groups.set(p.date, []);
    groups.get(p.date).push({ rec, idx, old: String(rec[field]), ...p });
  });
  const rows = [];
  [...groups.keys()].sort().forEach(date => {
    const list = groups.get(date).sort((a, b) => {
      const ca = String(a.rec.createdAt || ''), cb = String(b.rec.createdAt || '');
      if (ca !== cb) return ca < cb ? -1 : 1;
      if (a.seq !== b.seq) return a.seq - b.seq;
      return String(a.rec.id || '').localeCompare(String(b.rec.id || ''));
    });
    list.forEach((r, i) => {
      r.next = prefix + date + '-' + String(i + 1).padStart(4, '0');
      rows.push(r);
    });
  });
  return { rows, skipped };
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  while (true) {
    const k = text.indexOf(needle, i);
    if (k < 0) break;
    n++; i = k + needle.length;
  }
  return n;
}

(function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error('找不到数据库文件：' + DB_PATH);
    process.exit(1);
  }
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  const rq = Array.isArray(db.materialRequisitions) ? db.materialRequisitions : [];
  const ob = Array.isArray(db.materialOutbound) ? db.materialOutbound : [];

  const r1 = plan(rq, 'LL-', 'reqNo');
  const r2 = plan(ob, 'OUT-', 'outNo');

  // 引用检查：把库里所有 reqNo / outNo 字段清空后再找旧号，剩下的才是「被别处引用」
  const scratch = JSON.parse(JSON.stringify(db));
  (scratch.materialRequisitions || []).forEach(x => { if (x) x.reqNo = ''; });
  (scratch.materialOutbound || []).forEach(x => { if (x) x.outNo = ''; });
  const dump = JSON.stringify(scratch);
  const refProblems = [];
  [...r1.rows, ...r2.rows].forEach(r => {
    if (r.old === r.next) return;
    const hits = countOccurrences(dump, r.old);
    if (hits > 0) refProblems.push({ field: r.rec.reqNo === r.old ? 'reqNo' : 'outNo', id: r.rec.id, old: r.old, next: r.next, hits });
  });

  const changedRq = r1.rows.filter(r => r.old !== r.next);
  const changedOb = r2.rows.filter(r => r.old !== r.next);

  console.log('数据库：' + DB_PATH);
  console.log('领料单 ' + rq.length + ' 条（需改 ' + changedRq.length + '，无法解析 ' + r1.skipped.length + '）');
  console.log('出库单 ' + ob.length + ' 条（需改 ' + changedOb.length + '，无法解析 ' + r2.skipped.length + '）');
  console.log('');
  console.log('--- 领料单映射 ---');
  changedRq.forEach(r => console.log('  ' + r.old.padEnd(22) + ' → ' + r.next + '   ' + (r.rec.createdAt || '') + (r.rec.deleted ? '  [已删除]' : '') + (r.rec.status === '已作废' ? '  [已作废]' : '')));
  console.log('--- 出库单映射 ---');
  changedOb.forEach(r => console.log('  ' + r.old.padEnd(24) + ' → ' + r.next + '   ' + (r.rec.createdAt || '') + (r.rec.deleted ? '  [已删除]' : '')));

  if (r1.skipped.length || r2.skipped.length) {
    console.log('');
    console.log('--- 无法解析（保持原样） ---');
    [...r1.skipped.map(x => ({ ...x, t: '领料单' })), ...r2.skipped.map(x => ({ ...x, t: '出库单' }))]
      .forEach(x => console.log('  ' + x.t + ' #' + x.idx + ' id=' + x.id + ' 单号=' + JSON.stringify(x.no)));
  }

  if (refProblems.length) {
    console.log('');
    console.log('--- 引用告警：旧单号出现在其他位置 ---');
    refProblems.forEach(p => console.log('  ' + p.field + ' ' + p.old + ' 在库中出现 ' + p.hits + ' 次（id=' + p.id + '）'));
  }

  const dupCheck = new Map();
  [...r1.rows, ...r2.rows].forEach(r => dupCheck.set(r.next, (dupCheck.get(r.next) || 0) + 1));
  const dups = [...dupCheck.entries()].filter(([, n]) => n > 1);

  if (!APPLY) {
    console.log('');
    console.log('（预演模式，未写盘；确认无误后加 --apply 执行）');
    return;
  }
  if (dups.length) { console.error('新单号存在重复，已中止：' + JSON.stringify(dups.slice(0, 5))); process.exit(2); }
  if (refProblems.length && !FORCE) {
    console.error('检测到旧单号被其他字段引用，已中止（确认可忽略时加 --force）：' + refProblems.length + ' 处');
    process.exit(3);
  }

  // 备份
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p2 = n => String(n).padStart(2, '0');
  const stamp = d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()) + '-' + p2(d.getUTCHours()) + p2(d.getUTCMinutes()) + p2(d.getUTCSeconds());
  // 备份放在「db 所在项目」的 _backup 下：真实库 → epds/_backup，副本 → 副本目录/_backup
  const backupDir = path.join(path.dirname(DB_PATH), '..', '_backup');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, 'db.json.before-no4-' + stamp);
  fs.copyFileSync(DB_PATH, backup);
  console.log('');
  console.log('已备份：' + backup);

  // 写回（只改 reqNo / outNo）
  r1.rows.forEach(r => { r.rec.reqNo = r.next; });
  r2.rows.forEach(r => { r.rec.outNo = r.next; });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
  console.log('已写盘：领料单 ' + changedRq.length + ' 条、出库单 ' + changedOb.length + ' 条');
})();
