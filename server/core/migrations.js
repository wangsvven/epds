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
  ,
  /* ---------- 迁移 3：材料业务日期回填 + 存量标记（P4-5） ----------
   * 背景：旧单只有 createdAt / history.at，没有 reqDate / arrivalDate / outDate / returnDate；
   * 单号里的日期才是「业务日期」的唯一历史线索（出库单的 workDate 是作业日，不能拿来当出库日）。
   * 规则：只补空字段，不改单号、不改 createdAt / confirmedAt / history.at / voidedAt、不改数量与状态；
   *       处理当时已存在的领料单 / 出库单打 legacy: true（新单由创建接口写 legacy: false）。
   * 注意：区分存量只能看 legacy，不能看业务日期字段在不在——本迁移会把字段补齐。 */
  {
    id: '20261111-material-biz-dates',
    desc: '材料业务日期回填（reqDate / arrivalDate / outDate / returnDate）并给存量单据打 legacy 标记',
    needs(DB) {
      const rq = Array.isArray(DB.materialRequisitions) ? DB.materialRequisitions : [];
      const ob = Array.isArray(DB.materialOutbound) ? DB.materialOutbound : [];
      if (rq.some(r => r && (!r.reqDate || r.legacy === undefined))) return true;
      if (rq.some(r => r && (r.history || []).some(h => h && !h.arrivalDate))) return true;
      if (ob.some(o => o && (!o.outDate || o.legacy === undefined))) return true;
      if (ob.some(o => o && (o.returns || []).some(x => x && !x.returnDate))) return true;
      return false;
    },
    run(DB) {
      const p2 = n => String(n).padStart(2, '0');
      const now = new Date(Date.now() + 8 * 3600 * 1000);
      const today = now.getUTCFullYear() + '-' + p2(now.getUTCMonth() + 1) + '-' + p2(now.getUTCDate());
      const dayOf = s => {
        const v = String(s == null ? '' : s).slice(0, 10);
        return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
      };
      // 单号里的日期：LL-YYYYMMDD-NNNN / OUT-YYYYMMDD-NNNN
      const fromNo = (no, prefix) => {
        const m = String(no == null ? '' : no).match(new RegExp('^' + prefix + '(\\d{4})(\\d{2})(\\d{2})-'));
        return m ? m[1] + '-' + m[2] + '-' + m[3] : '';
      };
      const rq = Array.isArray(DB.materialRequisitions) ? DB.materialRequisitions : [];
      const ob = Array.isArray(DB.materialOutbound) ? DB.materialOutbound : [];
      let fReq = 0, fArr = 0, fOut = 0, fRet = 0, markRq = 0, markOb = 0, fallback = 0;
      rq.forEach(r => {
        if (!r) return;
        if (!r.reqDate) {
          // 单号日期 → createdAt 日期 → 今天（兜底只应对 createdAt 缺失的异常记录，正常库不会走到）
          let d = fromNo(r.reqNo, 'LL-') || dayOf(r.createdAt);
          if (!d) { d = today; fallback++; }
          r.reqDate = d; fReq++;
        }
        (r.history || []).forEach(h => {
          if (!h || h.arrivalDate) return;
          h.arrivalDate = dayOf(h.at) || dayOf(r.confirmedAt) || r.reqDate || today; fArr++;
        });
        if (r.legacy === undefined) { r.legacy = true; markRq++; }
      });
      ob.forEach(o => {
        if (!o) return;
        if (!o.outDate) {
          // 只认单号日期，绝不用 workDate（作业日）冒充出库日
          let d = fromNo(o.outNo, 'OUT-') || dayOf(o.createdAt);
          if (!d) { d = today; fallback++; }
          o.outDate = d; fOut++;
        }
        (o.returns || []).forEach(x => {
          if (!x || x.returnDate) return;
          x.returnDate = dayOf(x.at) || o.outDate || today; fRet++;
        });
        if (o.legacy === undefined) { o.legacy = true; markOb++; }
      });
      console.log('[migrate] 业务日期回填：领料单 reqDate ' + fReq + ' / 入库 arrivalDate ' + fArr
        + ' / 出库 outDate ' + fOut + ' / 归还 returnDate ' + fRet
        + '；存量标记 领料 ' + markRq + ' 张、出库 ' + markOb + ' 张'
        + (fallback ? '；兜底用今天 ' + fallback + ' 处（缺 createdAt，请人工复核）' : ''));
      return true;
    }
  }
  // ↓ 以后新增数据迁移：在此追加 { id, desc, needs?, run } 即可，随版本升级自动执行。
];

module.exports = { MIGRATIONS };
