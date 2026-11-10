/* ========== js/plan-staff ========== */
/* 周计划人员防冲突：纯函数模块，只读入参、不写库、不依赖视图。
 *
 * 比对键 = 「姓名|电话」（计划只存 staffText / chargePerson，不存 worker id）。
 * 时间一律 YYYY-MM-DD HH:mm:ss；历史 HH:mm 值在比较前补齐 :00，保证首尾相接判定不被字符串长度误导。
 * 占用方 = planType 恰为「周计划」、存储状态恰为「未执行」、id !== selfId、且区间严格相交的计划。
 */
(function () {
  function keyOf(name, phone) {
    return String(name == null ? '' : name).trim() + '|' + String(phone == null ? '' : phone).trim();
  }
  /* 「姓名/电话；姓名/电话」→ [{name, phone}]；按最后一个「/」拆分，电话可为空。 */
  function parseStaff(staffText) {
    var s = String(staffText == null ? '' : staffText).trim();
    if (!s) return [];
    return s.split('；').map(function (item) {
      var t = String(item == null ? '' : item).trim();
      if (!t) return null;
      var i = t.lastIndexOf('/');
      var p = i < 0 ? { name: t, phone: '' } : { name: t.slice(0, i).trim(), phone: t.slice(i + 1).trim() };
      return p.name ? p : null;
    }).filter(Boolean);
  }
  /* 一条计划的参与人键集合：实施人员 + 工作负责人（负责人姓名为空则不加），去重、保持顺序。 */
  function participantsOf(plan) {
    if (!plan) return [];
    var out = [], seen = {};
    parseStaff(plan.staffText).forEach(function (p) {
      var k = keyOf(p.name, p.phone);
      if (!seen[k]) { seen[k] = 1; out.push(k); }
    });
    var cn = String(plan.chargePerson == null ? '' : plan.chargePerson).trim();
    if (cn) {
      var ck = keyOf(cn, plan.chargePersonPhone);
      if (!seen[ck]) { seen[ck] = 1; out.push(ck); }
    }
    return out;
  }
  function normDT(v) {
    var s = String(v == null ? '' : v).trim();
    return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s) ? s + ':00' : s;
  }
  /* 区间相交：严格小于比较，首尾恰好相接（aEnd === bStart）不算冲突；任一时间缺失返回 false。 */
  function overlaps(aStart, aEnd, bStart, bEnd) {
    var a = normDT(aStart), ae = normDT(aEnd), b = normDT(bStart), be = normDT(bEnd);
    if (!a || !ae || !b || !be) return false;
    return a < be && b < ae;
  }
  /* 返回 { '姓名|电话': [冲突计划...] }；起止任一为空、或占用方无有效时间时不产生冲突。 */
  function findConflicts(plans, selfId, start, end) {
    var out = {};
    var sid = selfId == null ? '' : String(selfId);
    var s = normDT(start), e = normDT(end);
    if (!s || !e) return out;
    (plans || []).forEach(function (p) {
      if (!p || p.deleted) return;
      if (String(p.planType || '') !== '周计划') return;
      if (String(p.status || '') !== '未执行') return;
      if (sid && String(p.id || '') === sid) return;
      if (!overlaps(s, e, p.startDate, p.endDate)) return;
      participantsOf(p).forEach(function (k) {
        (out[k] = out[k] || []).push(p);
      });
    });
    return out;
  }

  var api = { keyOf: keyOf, parseStaff: parseStaff, participantsOf: participantsOf, overlaps: overlaps, findConflicts: findConflicts };
  if (typeof window !== 'undefined') window.PlanStaff = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
