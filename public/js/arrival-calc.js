/* ========== arrival-calc ========== */
/* 到货统计聚合（纯函数，无 Vue/无 DOM 依赖）：前端页面与冒烟脚本共用同一套口径。
   - aggregate(materials, projectNames)：按物料编码合并，复用材料台账的 qtyRequired/qtyArrived 字段
   - recentArrivals(requisitions, projectNames, limit)：领料单入库记录按时间倒序 */
(function (root) {
  function round4(n) { return Math.round((Number(n) || 0) * 10000) / 10000; }
  function nameSet(names) { return new Set((names || []).filter(Boolean)); }

  function aggregate(materials, projectNames) {
    const set = nameSet(projectNames);
    const rows = (materials || []).filter(m => m && !m.deleted && set.has(m.project));
    const map = new Map();
    rows.forEach(m => {
      const code = String(m.code || '').trim();
      const key = code ? 'c:' + code : 'd:' + String(m.description || '') + '|' + String(m.unit || '');
      const req = Number(m.qtyRequired) || 0;
      const arr = Number(m.qtyArrived) || 0;
      let g = map.get(key);
      if (!g) {
        g = { code, description: m.description || '', unit: m.unit || '', required: 0, arrived: 0, rowCount: 0, maxReq: -1, units: new Set(), descs: new Set() };
        map.set(key, g);
      }
      g.required = round4(g.required + req);
      g.arrived = round4(g.arrived + arr);
      g.rowCount++;
      if (m.unit) g.units.add(String(m.unit));
      if (m.description) g.descs.add(String(m.description));
      // 描述/单位取「应到数量最大的一行」
      if (req > g.maxReq) { g.maxReq = req; g.description = m.description || ''; g.unit = m.unit || ''; }
    });
    const all = [...map.values()].map(g => {
      const notArrived = round4(Math.max(0, g.required - g.arrived));
      return {
        code: g.code,
        description: g.description,
        unit: g.unit,
        required: g.required,
        arrived: g.arrived,
        notArrived,
        progress: g.required > 0 ? Math.min(100, Math.round(g.arrived / g.required * 10000) / 100) : 0,
        status: (g.required > 0 && g.arrived >= g.required) ? '全部到库' : '部分到库',
        rowCount: g.rowCount,
        unitConflict: g.units.size > 1,
        units: [...g.units],
        descConflict: g.descs.size > 1
      };
    });
    // 只列已到合计 > 0；按未到降序，全部到齐（未到=0）排最后
    const listed = all.filter(r => r.arrived > 0);
    listed.sort((a, b) => {
      const an = a.notArrived > 0 ? 0 : 1;
      const bn = b.notArrived > 0 ? 0 : 1;
      if (an !== bn) return an - bn;
      if (a.notArrived !== b.notArrived) return b.notArrived - a.notArrived;
      return String(a.code).localeCompare(String(b.code));
    });
    const requiredSum = round4(all.reduce((s, r) => s + r.required, 0));
    const arrivedSum = round4(all.reduce((s, r) => s + r.arrived, 0));
    return {
      rows: listed,
      totalRows: rows.length,
      kindCount: all.length,
      arrivedKindCount: listed.length,
      notArrivedKindCount: all.length - listed.length,
      requiredSum,
      arrivedSum,
      notArrivedSum: round4(Math.max(0, requiredSum - arrivedSum)),
      rate: requiredSum > 0 ? Math.round(arrivedSum / requiredSum * 10000) / 100 : 0
    };
  }

  function recentArrivals(requisitions, projectNames, limit) {
    const set = nameSet(projectNames);
    const out = [];
    (requisitions || []).forEach(rec => {
      if (!rec || rec.deleted || rec.status === '已作废') return; // 作废单的入库已冲销，不计入动态
      const items = rec.items || [];
      const ps = new Set([...(rec.projects || []), ...items.map(i => i.project)].filter(Boolean));
      let inPlan = false;
      ps.forEach(p => { if (set.has(p)) inPlan = true; });
      if (!inPlan) return;
      (rec.history || []).forEach(h => {
        (h.rows || []).forEach(r => {
          const it = items.find(x => x.materialId === r.materialId) || {};
          out.push({
            at: h.at || '',
            reqNo: rec.reqNo || '',
            description: it.description || '',
            code: it.code || '',
            unit: it.unit || '',
            qty: round4(r.thisQty),
            abnormal: !!r.abnormal,
            reason: r.reason || ''
          });
        });
      });
    });
    out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return out.slice(0, limit || 50);
  }

  root.ArrivalCalc = { aggregate, recentArrivals, round4 };
})(typeof window !== 'undefined' ? window : this);
