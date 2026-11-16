#!/usr/bin/env node
/* ========== scripts/consistency-audit.js ==========
 * 材料台账「账目一致性」只读体检：把「写入时算好、存成字段」的值跟它的源数据重算一遍，
 * 找出「源数据变了、存值没跟着变」的漂移。起因见 2026-11-16 群晖期初缺陷：
 *   期初余额冻结成数值后，迁移前单据被作废时不会回补 → 截至日回放与当前聚合永久分叉。
 *
 * 纯只读：只读 db.json、只打印，不写库、不依赖 core/db（不会触发迁移或自愈），
 * 因此可以直接对上生产/群晖的库文件跑。退出码：0 = 全部一致，1 = 有差异。
 *
 * 用法：
 *   node scripts/consistency-audit.js                  # 默认读 ../data/db.json
 *   node scripts/consistency-audit.js --db /path/db.json
 *   node scripts/consistency-audit.js --db x.json --limit 20
 *   node scripts/consistency-audit.js --quiet          # 只输出汇总与首行
 */
const fs = require('fs');
const path = require('path');

const roundQty = n => Math.round((Number(n) || 0) * 10000) / 10000;
const dayPart = v => String(v == null ? '' : v).slice(0, 10);
const isBizDay = v => /^\d{4}-\d{2}-\d{2}$/.test(dayPart(v));

/* 材料台账一致性检查（纯函数，db 为整库对象）
 * 返回 [{ code, label, detail }]；空数组 = 全部一致。
 * 口径说明：
 *   - 「已到」的唯一来源应是未被删除、未作废领料单的 history 累计（= confirmRows 累计）
 *   - 出库单据行的 returned 应与该单 returns[] 明细合计相等
 *   - 材料未到量恒等于 max(0, 应到 − 已到)
 *   - 单据明细里的工程快照必须等于材料当前工程（不等即「跨工程占用」：
 *     列表按工程统计会漏掉它，而按日回放只认材料 id，两套口径必然分叉）
 */
function auditDB(db) {
  const rows = [];
  const push = (code, label, detail) => rows.push({ code, label, detail });
  const mats = (db.materials || []).filter(m => m && !m.deleted);
  const reqs = (db.materialRequisitions || []).filter(r => r && !r.deleted);
  const obs = (db.materialOutbound || []).filter(o => o && !o.deleted);
  const matById = {};
  mats.forEach(m => { matById[m.id] = m; });

  mats.forEach(m => {
    const rs = reqs.filter(r => r.status !== '已作废' && (r.items || []).some(it => it && it.materialId === m.id));
    let hist = 0, conf = 0;
    rs.forEach(r => {
      (r.history || []).forEach(h => {
        const row = (h.rows || []).find(x => x && x.materialId === m.id);
        hist = roundQty(hist + (Number(row && row.thisQty) || 0));
      });
      const c = (r.confirmRows || []).find(x => x && x.materialId === m.id);
      conf = roundQty(conf + (Number(c && c.thisQty) || 0));
    });
    if (roundQty(m.qtyArrived) !== hist) {
      push('C1', '已到 ≠ 入库 history 合计', m.id + ' ' + m.description + '｜已到 ' + roundQty(m.qtyArrived) + ' / history ' + hist);
    }
    if (roundQty(m.qtyArrived) !== conf) {
      push('C2', '已到 ≠ confirmRows 合计', m.id + ' ' + m.description + '｜已到 ' + roundQty(m.qtyArrived) + ' / confirm ' + conf);
    }
    if (conf !== hist) {
      push('C3', 'confirmRows ≠ history 合计（同一事实两处存）', m.id + ' ' + m.description + '｜confirm ' + conf + ' / history ' + hist);
    }
    const wantNot = roundQty(Math.max(0, roundQty(m.qtyRequired) - roundQty(m.qtyArrived)));
    if (roundQty(m.qtyNotArrived) !== wantNot) {
      push('C5', '未到 ≠ max(0, 应到 − 已到)', m.id + ' ' + m.description + '｜未到 ' + roundQty(m.qtyNotArrived) + ' / 应 ' + wantNot);
    }
    if (roundQty(m.qtyArrived) < 0) push('C14', '已到为负', m.id + ' ' + m.description + '｜' + roundQty(m.qtyArrived));
  });

  obs.forEach(o => {
    (o.items || []).forEach(it => {
      if (!it || !it.materialId) return;
      let ret = 0;
      (o.returns || []).forEach(x => {
        const row = (x.rows || []).find(y => y && y.materialId === it.materialId);
        ret = roundQty(ret + (Number(row && row.qty) || 0));
      });
      if (roundQty(it.returned) !== ret) {
        push('C4', '归还字段 ≠ returns 明细合计', o.outNo + ' ' + it.materialId + '｜字段 ' + roundQty(it.returned) + ' / 明细 ' + ret);
      }
      if (!(roundQty(it.qty) > 0)) push('C15', '出库数量 ≤ 0', o.outNo + ' ' + it.materialId + '｜qty ' + it.qty);
      const m = matById[it.materialId];
      if (!m) {
        push('C8', '出库指向不存在/已删除材料', o.outNo + ' ' + it.materialId + ' ' + (it.description || ''));
      } else if (String(o.project || '') !== String(m.project || '')) {
        push('C7', '出库工程 ≠ 材料工程（跨工程占用）', o.outNo + '｜单 ' + o.project + ' / 料 ' + m.project + '｜' + it.materialId);
      }
    });
    if (!isBizDay(o.outDate)) push('C12', '出库日期非法', o.outNo + '｜outDate ' + o.outDate);
    (o.returns || []).forEach(x => {
      if (!isBizDay(x.returnDate)) push('C12', '归还日期非法', o.outNo + '｜returnDate ' + x.returnDate);
    });
  });

  (db.materialRequisitions || []).forEach(r => {
    if (!r || r.deleted) return;
    (r.items || []).forEach(it => {
      if (!it || !it.materialId) return;
      if (!matById[it.materialId]) push('C9', '领料指向不存在/已删除材料', r.reqNo + ' ' + it.materialId);
    });
    if (r.status === '已入库') {
      (r.items || []).forEach(it => {
        const c = (r.confirmRows || []).find(x => x && x.materialId === it.materialId);
        if (roundQty(c && c.thisQty) < roundQty(it.qty)) {
          push('C11', '状态「已入库」但确认量不足', r.reqNo + ' ' + it.materialId + '｜确认 ' + roundQty(c && c.thisQty) + ' / 应到 ' + roundQty(it.qty));
        }
      });
    }
  });

  return rows;
}

module.exports = { auditDB };

/* ---------- CLI ---------- */
if (require.main === module) {
  const argv = process.argv.slice(2);
  const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const dbPath = path.resolve(argOf('--db', path.join(__dirname, '..', 'data', 'db.json')));
  const limit = Number(argOf('--limit', '6')) || 6;
  const quiet = argv.includes('--quiet');
  if (!fs.existsSync(dbPath)) { console.error('找不到库文件：' + dbPath); process.exit(2); }
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const rows = auditDB(db);
  const alive = a => (a || []).filter(x => x && !x.deleted).length;
  console.log('库：' + dbPath);
  console.log('材料 ' + alive(db.materials) + ' / 领料单 ' + alive(db.materialRequisitions) + ' / 出库单 ' + alive(db.materialOutbound));
  if (!rows.length) { console.log('账目一致：未发现「存值 ≠ 明细」的漂移'); process.exit(0); }
  const byCode = {};
  rows.forEach(r => (byCode[r.code + ' ' + r.label] = byCode[r.code + ' ' + r.label] || []).push(r.detail));
  console.log('发现 ' + rows.length + ' 处不一致：');
  Object.keys(byCode).sort().forEach(k => {
    console.log('■ ' + k + '：' + byCode[k].length + ' 条');
    if (quiet) return;
    byCode[k].slice(0, limit).forEach(x => console.log('    ' + x));
    if (byCode[k].length > limit) console.log('    …另 ' + (byCode[k].length - limit) + ' 条');
  });
  console.log('说明：只读体检，不改任何数据。处置请对照「材料明细 / 领料单 / 出库管理」逐条核对。');
  process.exit(1);
}
