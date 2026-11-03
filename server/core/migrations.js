/* ========== core/migrations ==========
 * 版本化数据迁移注册表：由 core/db 的 runDataMigrations() 在每次启动时执行「尚未应用」的迁移。
 * 这样以后任何「需要改历史数据」的事（改字段、重排编号、补默认值…）都只需在下面数组末尾
 * 追加一条，随版本发出去，用户升级后首次启动即自动完成，数据库里 appliedMigrations 记录已应用项。
 *
 * 迁移项结构：
 *   {
 *     id:   唯一标识（建议日期前缀，按数组顺序执行）,
 *     desc: 说明（日志/排障用）,
 *     needs?(DB): 可选。返回 true 表示「确有需要处理的数据」；省略则默认未应用即执行一次。
 *                  用于避免在不相关的库上做无意义的备份/写入。
 *     run(DB):   执行迁移。返回 false 表示被阻断/需人工（不标记已应用，记入 migrationsBlocked，避免反复执行）；
 *                返回 true / 无返回 表示成功。
 *   }
 * 约定：run 只在未应用时执行一次，但内部仍应尽量安全（先校验、按需才改）。
 */

/* ---------- 迁移 1：领料/出库单流水号统一为 4 位 ----------
 * 背景：v2.17 之前领料单流水 3 位（LL-YYYYMMDD-001）、出库单 6 位（OUT-...-000001）；
 * v2.17 起新单改为 4 位。历史单需一次性重排：按日期分组、createdAt 升序重编为 0001 起，
 * 含已删除/已作废（单号不回收）。规则与 scripts/migrate-no4-20261031.js 一致。 */
function _no4Parse(no, prefix) {
  const s = String(no == null ? '' : no).trim();
  const m = s.match(new RegExp('^' + prefix + '(\\d{8})-(\\d+)$'));
  return m ? { date: m[1], seq: parseInt(m[2], 10), len: m[2].length } : null;
}
function _no4Plan(records, prefix, field) {
  const groups = new Map();
  (records || []).forEach(rec => {
    const p = _no4Parse(rec && rec[field], prefix);
    if (!p) return; // 无法解析（如 OUT-LEGACY-*）保持原样
    if (!groups.has(p.date)) groups.set(p.date, []);
    groups.get(p.date).push({ rec, old: String(rec[field]), ...p });
  });
  const rows = [];
  [...groups.keys()].sort().forEach(date => {
    groups.get(date).sort((a, b) => {
      const ca = String(a.rec.createdAt || ''), cb = String(b.rec.createdAt || '');
      if (ca !== cb) return ca < cb ? -1 : 1;
      if (a.seq !== b.seq) return a.seq - b.seq;
      return String(a.rec.id || '').localeCompare(String(b.rec.id || ''));
    }).forEach((r, i) => { r.next = prefix + date + '-' + String(i + 1).padStart(4, '0'); rows.push(r); });
  });
  return rows;
}
function _no4Count(text, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = text.indexOf(needle, i)) >= 0) { n++; i += needle.length; }
  return n;
}
function _no4Lists(DB) {
  return {
    rq: Array.isArray(DB.materialRequisitions) ? DB.materialRequisitions : [],
    ob: Array.isArray(DB.materialOutbound) ? DB.materialOutbound : []
  };
}

const MIGRATIONS = [
  {
    id: '20261102-no4-reqno-outno',
    desc: '领料/出库单流水号统一为 4 位（旧格式 3 位/6 位）',
    needs(DB) {
      const { rq, ob } = _no4Lists(DB);
      return [..._no4Plan(rq, 'LL-', 'reqNo'), ..._no4Plan(ob, 'OUT-', 'outNo')].some(r => r.len !== 4);
    },
    run(DB) {
      const { rq, ob } = _no4Lists(DB);
      const r1 = _no4Plan(rq, 'LL-', 'reqNo');
      const r2 = _no4Plan(ob, 'OUT-', 'outNo');
      const changed = [...r1, ...r2].filter(r => r.old !== r.next);
      // 引用校验：旧号若出现在自身 reqNo/outNo 以外的位置 → 阻断（需人工 --force）
      const scratch = JSON.parse(JSON.stringify(DB));
      (scratch.materialRequisitions || []).forEach(x => { if (x) x.reqNo = ''; });
      (scratch.materialOutbound || []).forEach(x => { if (x) x.outNo = ''; });
      const dump = JSON.stringify(scratch);
      const blocked = changed.filter(r => _no4Count(dump, r.old) > 0);
      if (blocked.length) {
        console.warn('[migrate] 流水号迁移被阻断：' + blocked.length + ' 个旧单号被其它字段引用；请执行 scripts/migrate-no4-20261031.js --apply --force 人工处理');
        return false;
      }
      r1.forEach(r => { r.rec.reqNo = r.next; });
      r2.forEach(r => { r.rec.outNo = r.next; });
      console.log('[migrate] 流水号已统一为 4 位：领料单改动 ' + r1.filter(r => r.old !== r.next).length + ' 条，出库单改动 ' + r2.filter(r => r.old !== r.next).length + ' 条');
      return true;
    }
  }
  ,
  {
    id: '20261103-borrow-v2',
    desc: '借工明细模型升级：旧 fromTeam/toTeam/reason/headcount/startDate/status → 新 unit/direction/workContent/techCount/workDate/signStatus 等',
    needs(DB) {
      return (Array.isArray(DB.borrowWorks) ? DB.borrowWorks : []).some(r => r && r.signStatus === undefined);
    },
    run(DB) {
      const list = Array.isArray(DB.borrowWorks) ? DB.borrowWorks : [];
      list.forEach(r => {
        if (!r || r.signStatus !== undefined) return; // 已有新字段：整条跳过，不重复覆盖
        r.techCount = Number(r.headcount) || 0;
        r.workerCount = 0;
        r.vehicleCount = 0;
        r.workContent = r.reason || '';
        r.applyDate = r.startDate || '';
        r.workDate = r.startDate || '';
        r.signStatus = (r.status === '已归还') ? '已签单' : '未签单';
        r.unit = r.toTeam || '';
        r.direction = '我方借出';
        r.projectType = '';
        r.projectName = '';
        r.remark = '';
        r.evidences = [];
        r.generatedFiles = [];
      });
      return true;
    }
  }
  // ↓ 以后新增数据迁移：在此追加 { id, desc, needs?, run } 即可，随版本升级自动执行。
];

module.exports = { MIGRATIONS };
