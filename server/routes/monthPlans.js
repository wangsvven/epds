/* ========== routes/monthPlans ========== */
/* 月计划：按用户模板导出 xlsx（主网 / 配网两张子表）。
   月计划的导入与列表仍走 routes/plans.js 的 /api/workPlans/import 与通用 CRUD；
   本文件必须先于 plans.js 加载，否则 /api/workPlans/month-plan.xlsx 会被 /:id 抢先匹配。 */
const app = require('../core/app');
const { DB } = require('../core/db');
const { bjDate } = require('../core/util');
const { buildMonthPlanXlsx } = require('../core/month-plan-xlsx');

// 月计划导出：按用户提供的「月计划导出模板」生成（主网 / 配网两张子表、20 列、标题+表头+红字说明）。
// 前端按当前筛选传 ids（顺序即导出行序），不传则导出全部未删除的月计划，按停电时间排序。
app.get('/api/workPlans/month-plan.xlsx', async (req, res) => {
  try {
    const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
    const all = (DB.workPlans || []).filter(p => p && p.planType === '月计划' && !p.deleted);
    let rows;
    if (ids.length) {
      const map = new Map(all.map(p => [p.id, p]));
      rows = ids.map(id => map.get(id)).filter(Boolean);
    } else {
      rows = all.slice().sort((a, b) => String(a.outageStart || '').localeCompare(String(b.outageStart || '')));
    }
    const now = bjDate();
    const year = Number(req.query.year) || now.getUTCFullYear();
    const month = Number(req.query.month) || (now.getUTCMonth() + 1);
    const first = rows.find(r => String(r.opsUnit || '').trim());
    const company = first ? String(first.opsUnit).trim() : 'XX供电公司';
    const buf = await buildMonthPlanXlsx(rows, { company, year, month });
    const fname = company + year + '年' + month + '月检修计划.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="month-plan.xlsx"; filename*=UTF-8\'\'' + encodeURIComponent(fname));
    res.end(Buffer.from(buf));
  } catch (e) {
    res.status(500).json({ error: '导出失败：' + e.message });
  }
});
