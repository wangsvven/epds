/* ========== js/work-feed ========== */
/* 首页「工作动态」来源规则：全部为纯函数，只读入参、现算、不落库。
 *
 * 约定：
 *  - 每个来源函数只消费自己模块的数据，来源之间互不依赖；build() 是聚合层，只负责调用与排序。
 *  - todayStr 一律由调用方按北京时间传 YYYY-MM-DD（ServerTime.ymd()），便于单测注入任意「今天」。
 *  - 时间戳两种形态：createdAt 是 UTC ISO（需 +8h 转北京自然日）；importedAt / exitedAt 是
 *    北京时间 'YYYY-MM-DD HH:mm[:ss]' 字符串（前 10 位即北京自然日）。
 *  - 输出消息 = { kind, label, nav, day, text[, order] }；kind 同时驱动标签配色。
 */
(function () {
  var TECH_IDENTITY = '技工（计入高处作业人员）';   // 已裁定：只有精确等于该值才算「技工」
  var DAY_MS = 86400000;
  var DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

  function bjDay(v) {
    if (v === null || v === undefined) return '';
    var s = String(v).trim();
    if (!s) return '';
    // 带时区的 UTC ISO（createdAt）：需 +8h 才是北京自然日
    if (/^\d{4}-\d{2}-\d{2}T/.test(s) && /(Z|[+-]\d{2}:\d{2})$/.test(s)) {
      var isoMs = Date.parse(s);
      return isFinite(isoMs) ? new Date(isoMs + 8 * 3600 * 1000).toISOString().slice(0, 10) : '';
    }
    // 北京时间字符串（importedAt / exitedAt / 纯日期）：前 10 位就是自然日
    if (/^\d{4}-\d{2}-\d{2}([ T]|$)/.test(s)) return s.slice(0, 10);
    var ms = Date.parse(s);
    if (!isFinite(ms)) return '';
    return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
  }
  function shiftDay(day, n) {
    if (!DAY_RE.test(day || '')) return '';
    var ms = Date.parse(day + 'T00:00:00Z');
    return isFinite(ms) ? new Date(ms + n * DAY_MS).toISOString().slice(0, 10) : '';
  }
  function dayLabel(day, today) {
    if (day === today) return '今日';
    if (day === shiftDay(today, -1)) return '昨日';
    return String(day || '').slice(5);        // 前天 → MM-DD，如 11-07
  }
  function inWindow(day, today) {
    if (!DAY_RE.test(day || '') || !DAY_RE.test(today || '')) return false;
    var from = shiftDay(today, -2);
    return !!from && day >= from && day <= today;
  }
  /* 点名排序：技工优先，同组内按 timeKey 升序，再按姓名稳定收尾。 */
  function techFirst(list, timeKey) {
    return (list || []).slice().sort(function (a, b) {
      var at = (a && a.identity === TECH_IDENTITY) ? 0 : 1;
      var bt = (b && b.identity === TECH_IDENTITY) ? 0 : 1;
      if (at !== bt) return at - bt;
      var av = String((a && a[timeKey]) || ''), bv = String((b && b[timeKey]) || '');
      return av.localeCompare(bv) || String((a && a.name) || '').localeCompare(String((b && b.name) || ''), 'zh');
    });
  }

  /* ---------- 来源一：准入预警（聚合一条） ----------
     alerts: WorkerStatus.alerts() 的结果；workers 仅用于补 identity（派生结果里不带身份）。 */
  function alertMessage(alerts, workers) {
    var byId = {};
    (workers || []).forEach(function (w) { if (w && w.id) byId[w.id] = w; });
    var list = (alerts || []).map(function (a) {
      return { name: String(a.name || ''), validEnd: String(a.validEnd || ''),
        identity: String((byId[a.id] || {}).identity || '') };
    });
    if (!list.length) return null;
    var ordered = techFirst(list, 'validEnd');
    var n = ordered.length;
    var who;
    if (n === 1) who = ordered[0].name;
    else if (n <= 3) who = ordered.slice(0, n).map(function (x) { return x.name; }).join('、');
    else who = ordered.slice(0, 3).map(function (x) { return x.name; }).join('、') + ' 等' + n + '人';
    return {
      kind: 'alert', label: '准入预警', nav: 'users', usersTab: 'workers', day: '',
      text: who + '准入有效期已到期或即将到期，请及时续期'
    };
  }

  /* ---------- 来源二：人员动态（按天汇总退场） ----------
     只认 status='已退场' 且 exitedAt 落在窗口内的记录；存量无 exitedAt 的不显示。 */
  function personMessages(workers, today) {
    var byDay = {};
    (workers || []).forEach(function (w) {
      if (!w || w.deleted || w.status !== '已退场') return;
      var day = bjDay(w.exitedAt);
      if (!inWindow(day, today)) return;
      (byDay[day] = byDay[day] || []).push(w);
    });
    return Object.keys(byDay).map(function (day) {
      var arr = techFirst(byDay[day], 'exitedAt');
      var n = arr.length;
      var who = n <= 3
        ? arr.map(function (x) { return x.name; }).join('、')
        : arr.slice(0, 3).map(function (x) { return x.name; }).join('、') + '等' + n + '人';
      return {
        kind: 'person', label: '人员动态', nav: 'users', usersTab: 'workers',
        day: day, text: dayLabel(day, today) + who + '已退场'
      };
    });
  }

  /* ---------- 来源三：材料动态（按天汇总，批次优先） ----------
     批次：rowsTotal 求和 = 录入总行数；materialIds.length（回退 rows）求和 = 实际新增。
     无批次的当日手工新增：materials 中 createdAt 在窗口内且无 importId 的条数。 */
  function materialMessages(imports, materials, today) {
    var byDay = {};
    function slot(day) {
      return byDay[day] || (byDay[day] = { rowsTotal: 0, added: 0, manual: 0, hasBatch: false });
    }
    (imports || []).forEach(function (b) {
      if (!b || b.deleted) return;
      var day = bjDay(b.importedAt);
      if (!inWindow(day, today)) return;
      var e = slot(day);
      e.hasBatch = true;
      e.rowsTotal += Number(b.rowsTotal) || 0;
      e.added += Array.isArray(b.materialIds) ? b.materialIds.length : (Number(b.rows) || 0);
    });
    (materials || []).forEach(function (m) {
      if (!m || m.deleted || m.importId) return;
      var day = bjDay(m.createdAt);
      if (!inWindow(day, today)) return;
      slot(day).manual += 1;
    });
    return Object.keys(byDay).map(function (day) {
      var e = byDay[day], label = dayLabel(day, today);
      return {
        kind: 'material', label: '材料动态', nav: 'materials', day: day,
        text: e.hasBatch
          ? label + '录入材料 ' + e.rowsTotal + ' 条，新增 ' + e.added + ' 条'
          : label + '新增材料 ' + e.manual + ' 条'
      };
    });
  }

  /* ---------- 来源四：计划动态（按天、按 planType 分行） ---------- */
  function planMessages(plans, today) {
    var byDay = {};
    (plans || []).forEach(function (p) {
      if (!p || p.deleted) return;
      var day = bjDay(p.createdAt);
      if (!inWindow(day, today)) return;
      var t = String(p.planType || '');
      if (t !== '周计划' && t !== '月计划') return;
      var e = byDay[day] || (byDay[day] = {});
      e[t] = (e[t] || 0) + 1;
    });
    var out = [];
    Object.keys(byDay).forEach(function (day) {
      var label = dayLabel(day, today);
      ['周计划', '月计划'].forEach(function (t, i) {
        if (!byDay[day][t]) return;
        out.push({
          kind: 'plan', label: '计划动态', nav: 'plans', day: day, order: i,
          text: label + '新增' + t + ' ' + byDay[day][t] + ' 条'
        });
      });
    });
    return out;
  }

  /* ---------- 来源五：借工动态（按天一行） ---------- */
  function borrowMessages(borrow, today) {
    var byDay = {};
    (borrow || []).forEach(function (b) {
      if (!b || b.deleted) return;
      var day = bjDay(b.createdAt);
      if (!inWindow(day, today)) return;
      byDay[day] = (byDay[day] || 0) + 1;
    });
    return Object.keys(byDay).map(function (day) {
      return {
        kind: 'borrow', label: '借工动态', nav: 'borrow', day: day,
        text: dayLabel(day, today) + '新增借工记录 ' + byDay[day] + ' 条'
      };
    });
  }

  var KIND_ORDER = { person: 0, material: 1, plan: 2, borrow: 3 };
  /* 聚合层：预警置顶，其余按日期倒序，同日内 人员 → 材料 → 计划 → 借工。 */
  function collect(parts) {
    var dyn = [].concat(parts.person || [], parts.material || [], parts.plan || [], parts.borrow || []);
    dyn.sort(function (a, b) {
      if (a.day !== b.day) return a.day > b.day ? -1 : 1;
      var d = (KIND_ORDER[a.kind] === undefined ? 9 : KIND_ORDER[a.kind]) -
        (KIND_ORDER[b.kind] === undefined ? 9 : KIND_ORDER[b.kind]);
      return d || ((a.order || 0) - (b.order || 0));
    });
    var out = parts.alert ? [parts.alert] : [];
    return out.concat(dyn);
  }

  /* build() 只做「取各来源 → 收集排序」，不含任何业务判断。 */
  function build(input) {
    var o = input || {};
    var alerts = o.alerts || [];
    var parts = {
      alert: alertMessage(alerts, o.workers),
      person: personMessages(o.workers, o.today),
      material: materialMessages(o.imports, o.materials, o.today),
      plan: planMessages(o.plans, o.today),
      borrow: borrowMessages(o.borrow, o.today)
    };
    return { messages: collect(parts), alertCount: alerts.length };
  }

  var api = {
    TECH_IDENTITY: TECH_IDENTITY, bjDay: bjDay, shiftDay: shiftDay,
    dayLabel: dayLabel, inWindow: inWindow, techFirst: techFirst,
    alertMessage: alertMessage, personMessages: personMessages,
    materialMessages: materialMessages, planMessages: planMessages,
    borrowMessages: borrowMessages, collect: collect, build: build
  };
  if (typeof window !== 'undefined') window.WorkFeed = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
