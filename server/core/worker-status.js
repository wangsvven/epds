/* ========== core/worker-status ========== */
/* 作业人员派生状态：服务端唯一口径，判定逻辑必须与 public/js/utils.js 的 WorkerStatus.of 完全一致。
 * 全系统（出库领取人校验、存量不一致检测）只调用这里，不许另写一份；冒烟有防漂移断言，
 * 同一组工人样本在前后端两份实现上跑出相同 derived / admitted。
 * 只计算、不写库：todayStr 由调用方按北京时间传 YYYY-MM-DD（core/util 的 bjStr().slice(0, 10)）。
 *   - 存储状态 待定 → 派生 待定（不可选人）
 *   - 存储状态 已退场 → 派生 已退场（不可选人）
 *   - 存储状态 已准入 且有效期结束日 < 今天 → 派生 待定（超期自动转，不落库）
 *   - 有效期为空 → 不触发自动转换，按存储状态
 *   - 到期距离 days = 结束日 − 今天（自然日）；结束日当天为 0，次日起为负 */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function workerStatusOf(w, todayStr) {
  const stored = String((w && w.status) || '已准入').trim();
  const today = String(todayStr || '').slice(0, 10);
  const end = String((w && w.validEnd) || '').trim().slice(0, 10);
  let days = null;
  if (end && DAY_RE.test(end) && DAY_RE.test(today)) {
    days = Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
  }
  const overdue = stored === '已准入' && days !== null && days < 0;
  const warn = stored === '已准入' && days !== null && days >= 0 && days <= 30;
  const derived = stored === '已退场' ? '已退场'
    : ((stored === '待定' || overdue) ? '待定' : '已准入');
  return {
    stored, derived, days,
    overdueDays: overdue ? -days : 0,
    warn, overdue,
    highlight: warn || overdue,
    admitted: derived === '已准入'
  };
}

// 可被选为领取人：未逻辑删除 + 派生状态为已准入。
// （前端名单来自 GET /api/workers，已过滤 deleted，所以那边的 WorkerStatus.of 不再看 deleted；
//   服务端要防直接把已删除记录传进来，多这一道判断，派生规则本身与前端一致。）
function isWorkerAdmitted(w, todayStr) {
  return !!(w && !w.deleted) && workerStatusOf(w, todayStr).admitted;
}

module.exports = { workerStatusOf, isWorkerAdmitted };
