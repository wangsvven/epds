/* ========== core/material-calc ========== */
/* 材料数量与到库状态计算（数据迁移与材料接口共用）：已生成领料量、在途未入库余量、到库状态、数量四舍五入。 */
// 延迟取库：db.js 的迁移会调用 materialStatus，这里若在顶层 require('./db') 会形成循环依赖
function DB_() { return require('./db').DB; }

function roundQty(n) { return Math.round((Number(n) || 0) * 10000) / 10000; }

function qtyGeneratedOf(m) {
  let g = 0;
  DB_().materialRequisitions.forEach(r => {
    if (r.deleted || r.status === '已作废') return;
    (r.items || []).forEach(it => {
      if (it.materialId === m.id) g += Number(it.qty) || 0;
    });
  });
  return roundQty(g);
}
// 在途未入库余量 = 同空间待入库/部分到库领料单中该物料尚未入库的数量合计（用于计算可继续领料）
function qtyOutstandingOf(m) {
  let o = 0;
  DB_().materialRequisitions.forEach(r => {
    if (r.deleted) return;
    if (r.status !== '待入库' && r.status !== '部分到库') return;
    (r.items || []).forEach(it => {
      if (it.materialId !== m.id) return;
      const cr = (r.confirmRows || []).find(c => c.materialId === it.materialId);
      o += Math.max(0, (Number(it.qty) || 0) - (Number(cr && cr.thisQty) || 0));
    });
  });
  return roundQty(o);
}
function withGen(m) {
  const gen = qtyGeneratedOf(m);
  const canGen = roundQty(Math.max(0, m.qtyNotArrived - qtyOutstandingOf(m)));
  return { ...m, qtyGenerated: gen, qtyCanGen: canGen, status: materialStatus(m) };
}
function materialStatus(m) {
  if (Number(m.qtyRequired) > 0 && m.qtyArrived >= m.qtyRequired) return '全部到库';
  if (m.qtyArrived > 0) return '部分到库'; // 已有入库数量时到货情况优先（可继续领料仍按未到余量-已生成计算）
  if (qtyGeneratedOf(m) > 0) return '已生成领料单'; // 未入库但有领料单在途（剩余量仍可继续领料）
  return '未到库';
}

module.exports = { roundQty, qtyGeneratedOf, qtyOutstandingOf, withGen, materialStatus };
