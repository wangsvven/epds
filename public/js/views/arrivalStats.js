/* ========== views/arrivalStats ========== */
/* 材料台账「到货统计」页签：按年度计划汇总到货情况（全计划口径，不按项目拆分）。
   另有「到货日期」视角：选中某天后看当日到货汇总、主表当日列，并把最近动态改成日志样式。 */
const ArrivalStats = {
  setup() {
    const { ref, computed, onMounted, watch } = Vue;
    const loading = ref(true);
    const materials = ref([]);
    const projects = ref([]);
    const plans = ref([]);
    const reqs = ref([]);
    const plan = ref('');
    const page = ref(1);
    const pageSize = ref(50);
    const arrivalDate = ref('');   // YYYY-MM-DD，空 = 全量视角
    const onlyDay = ref(true);     // 选日期时是否只看当日有到货的行

    async function load() {
      loading.value = true;
      try {
        const [ms, ps, pl, rq] = await Promise.all([
          api.get('/api/materials'), api.get('/api/projects'), api.get('/api/annualPlans'),
          api.get('/api/materialRequisitions').catch(() => [])
        ]);
        materials.value = ms || [];
        projects.value = ps || [];
        plans.value = pl || [];
        reqs.value = Array.isArray(rq) ? rq : [];
        pickDefaultPlan();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { loading.value = false; }
    }
    // 默认当前年度计划（名称含当前年份），没有则取第一个
    function pickDefaultPlan() {
      const cur = plans.value.find(p => String(p.name || '').includes(String(new Date().getFullYear())));
      plan.value = cur ? cur.name : (plans.value[0] ? plans.value[0].name : '');
    }
    // 该计划下的全部工程名（含子项目）
    const planNames = computed(() => {
      const names = [];
      projects.value.forEach(p => {
        if (p.annualPlan !== plan.value) return;
        if (p.name) names.push(p.name);
        (p.subProjects || []).forEach(s => { if (s.name) names.push(s.name); });
      });
      return names;
    });
    const agg = computed(() => window.ArrivalCalc.aggregate(materials.value, planNames.value));

    // 全量入库事件（日志与当日计算共用同一份数据）
    const allEvents = computed(() => window.ArrivalCalc.recentArrivals(reqs.value, planNames.value, 100000));
    const recent = computed(() => allEvents.value.slice(0, 40));

    const dayEvents = computed(() => {
      const d = arrivalDate.value;
      if (!d) return [];
      return allEvents.value.filter(e => String(e.at || '').slice(0, 10) === d);
    });
    // 当日按「编码 + 描述」聚合（与 aggregate 同键）
    const dayQtyMap = computed(() => {
      const map = new Map();
      if (!arrivalDate.value) return map;
      const r4 = window.ArrivalCalc.round4;
      dayEvents.value.forEach(e => {
        const key = String(e.code || '') + '||' + String(e.description || '');
        map.set(key, r4((map.get(key) || 0) + (Number(e.qty) || 0)));
      });
      return map;
    });
    const dayKinds = computed(() => dayQtyMap.value.size);
    const daySum = computed(() => {
      let s = 0;
      dayQtyMap.value.forEach(v => { s += v; });
      return window.ArrivalCalc.round4(s);
    });

    const rowsWithDay = computed(() => agg.value.rows.map(r => Object.assign({}, r, {
      dayQty: dayQtyMap.value.get(String(r.code || '') + '||' + String(r.description || '')) || 0
    })));
    // 主表行集：未选日期 = 全量；选日期 = 全部行（带 dayQty），onlyDay 时只留当日有到货的
    const viewRows = computed(() => {
      if (!arrivalDate.value) return agg.value.rows;
      return onlyDay.value ? rowsWithDay.value.filter(r => r.dayQty > 0) : rowsWithDay.value;
    });
    const paged = computed(() => viewRows.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));

    const pagerText = computed(() => {
      if (arrivalDate.value && onlyDay.value) {
        return mdDate(arrivalDate.value) + '到货 ' + dayKinds.value + ' 种 · 其余 ' +
          (agg.value.kindCount - dayKinds.value) + ' 种当日无到货';
      }
      return '已到货 ' + agg.value.rows.length + ' 种 · 未到货 ' + agg.value.notArrivedKindCount + ' 种';
    });
    const daySummary = computed(() => {
      if (!arrivalDate.value) return '';
      if (!dayEvents.value.length) return cnDate(arrivalDate.value) + '：当日暂无到货记录';
      return cnDate(arrivalDate.value) + '到货：' + dayEvents.value.length + ' 条记录 · 涉及 ' +
        dayKinds.value + ' 种材料 · 当日到货合计 ' + fmt(daySum.value);
    });
    const emptyText = computed(() => (arrivalDate.value && viewRows.value.length === 0) ? '当日无到货记录' : '暂无数据');

    // 日志按日期分组（数据已按时间倒序）
    const logGroups = computed(() => {
      const groups = [];
      let cur = null;
      recent.value.forEach(e => {
        const d = String(e.at || '').slice(0, 10);
        if (!cur || cur.date !== d) { cur = { date: d, items: [] }; groups.push(cur); }
        cur.items.push(e);
      });
      return groups;
    });

    function pad2(n) { return String(n).padStart(2, '0'); }
    function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
    function cnDate(v) {
      const [y, m, d] = String(v).split('-');
      return y + '年' + Number(m) + '月' + Number(d) + '日';
    }
    function mdDate(v) {
      const [, m, d] = String(v).split('-');
      return Number(m) + '月' + Number(d) + '日';
    }
    function setToday() { arrivalDate.value = ymd(new Date()); page.value = 1; }
    function setYesterday() { arrivalDate.value = ymd(new Date(Date.now() - 86400000)); page.value = 1; }

    function onPlanChange() { page.value = 1; arrivalDate.value = ''; }
    function onOnlyDayChange() { page.value = 1; }
    function fmt(n) {
      const v = Math.round((Number(n) || 0) * 10000) / 10000;
      return String(v);
    }

    // 下载日志：全量事件导出为 Markdown 表格
    function downloadLog() {
      if (!allEvents.value.length) return;
      const t = new Date();
      const stamp = ymd(t) + ' ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes());
      const lines = [
        '# 到货日志（' + (plan.value || '') + '）',
        '',
        '导出时间：' + stamp,
        '',
        '| 时间 | 领料单号 | 材料 | 本次到货数量 | 情况 |',
        '| --- | --- | --- | --- | --- |'
      ];
      allEvents.value.forEach(e => {
        const state = e.abnormal ? ('异常' + (e.reason ? '（' + e.reason + '）' : '')) : '正常';
        lines.push('| ' + (e.at || '') + ' | ' + (e.reqNo || '') + ' | ' + (e.description || '') +
          ' | ' + fmt(e.qty) + ' | ' + state + ' |');
      });
      const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '到货日志.md';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(a.href);
    }

    watch(arrivalDate, () => { page.value = 1; });
    onMounted(load);

    return {
      loading, plan, plans, page, pageSize, paged, agg, recent, allEvents, onPlanChange, fmt, load,
      arrivalDate, onlyDay, viewRows, pagerText, daySummary, dayEvents, dayKinds, daySum,
      emptyText, logGroups, setToday, setYesterday, onOnlyDayChange, downloadLog
    };
  },
  template: `
  <div v-loading="loading">
    <div class="toolbar">
      <span style="font-weight:600;font-size:15px">到货统计</span>
      <el-select v-model="plan" style="width:220px" @change="onPlanChange">
        <el-option v-for="p in plans" :key="p.id" :label="p.name" :value="p.name" />
      </el-select>
      <span class="as-dategrp">
        <span class="as-datelb">到货日期</span>
        <el-date-picker v-model="arrivalDate" type="date" value-format="YYYY-MM-DD" clearable
          placeholder="选择日期" class="as-date" :teleported="true" />
      </span>
      <el-button size="small" class="as-quick" @click="setToday">今天</el-button>
      <el-button size="small" class="as-quick" @click="setYesterday">昨天</el-button>
      <span class="as-sum">材料 {{ agg.totalRows }} 行 · 按编码 + 名称合并 {{ agg.kindCount }} 种 · 其中已到货 {{ agg.arrivedKindCount }} 种</span>
      <span class="spacer"></span>
      <el-button @click="load">刷新统计</el-button>
    </div>

    <div class="mat-stats as-stats">
      <div class="mat-stat">
        <div class="mat-stat-lb">应到总量</div>
        <div class="mat-stat-v">{{ fmt(agg.requiredSum) }}</div>
      </div>
      <div class="mat-stat">
        <div class="mat-stat-lb">已到总量</div>
        <div class="mat-stat-v">{{ fmt(agg.arrivedSum) }}</div>
      </div>
      <div class="mat-stat">
        <div class="mat-stat-lb">未到总量</div>
        <div class="mat-stat-v">{{ fmt(agg.notArrivedSum) }}</div>
      </div>
      <div class="mat-stat">
        <div class="mat-stat-lb">整体到货率</div>
        <div class="mat-stat-v">{{ agg.rate }}%</div>
      </div>
    </div>

    <div v-if="arrivalDate" class="as-day-sum">
      <span class="as-day-text">{{ daySummary }}</span>
      <span class="spacer"></span>
      <span class="as-day-switch">只看当日有到货</span>
      <el-switch v-model="onlyDay" size="small" @change="onOnlyDayChange" />
    </div>

    <el-table :data="paged" class="mat-table as-table" style="width:100%" :empty-text="emptyText">
      <el-table-column prop="code" label="物料编码" width="146">
        <template #default="{row}"><span class="mat-code">{{ row.code || '—' }}</span></template>
      </el-table-column>
      <el-table-column prop="description" label="物料描述" min-width="300">
        <template #default="{row}"><span class="mat-desc">{{ row.description }}</span></template>
      </el-table-column>
      <el-table-column label="单位" width="76" align="center">
        <template #default="{row}">
          <span class="mat-sub">{{ row.unit || '—' }}</span>
          <el-tooltip v-if="row.unitConflict" :content="'同编码存在单位：' + row.units.join(' / ')" placement="top">
            <span class="as-flag is-warn">单位不一致</span>
          </el-tooltip>
        </template>
      </el-table-column>
      <el-table-column label="应到合计" width="112" align="right">
        <template #default="{row}"><span class="mat-num">{{ fmt(row.required) }}</span></template>
      </el-table-column>
      <el-table-column label="已到合计" width="112" align="right">
        <template #default="{row}"><span class="mat-num">{{ fmt(row.arrived) }}</span></template>
      </el-table-column>
      <el-table-column v-if="arrivalDate" label="当日到货" width="112" align="right">
        <template #default="{row}">
          <span class="mat-num as-daynum" :class="{ 'is-zero': !row.dayQty }">{{ row.dayQty > 0 ? fmt(row.dayQty) : '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="未到" width="106" align="right">
        <template #default="{row}"><span class="mat-num">{{ fmt(row.notArrived) }}</span></template>
      </el-table-column>
      <el-table-column label="进度" min-width="180">
        <template #default="{row}">
          <div class="as-progress">
            <el-progress :percentage="row.progress" :stroke-width="10" :show-text="false" :status="row.progress >= 100 ? 'success' : ''" />
            <span class="as-pct">{{ row.progress }}%</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="104" align="center">
        <template #default="{row}">
          <el-tag size="small" :type="row.status === '全部到库' ? 'success' : 'warning'">{{ row.status }}</el-tag>
        </template>
      </el-table-column>
    </el-table>

    <div class="mat-pager">
      <span class="mat-pager-total">{{ pagerText }}</span>
      <el-pagination v-model:current-page="page" v-model:page-size="pageSize" :total="viewRows.length"
        :page-sizes="[20, 50, 100, 200]" layout="prev, pager, next, sizes" background />
    </div>

    <div class="as-recent">
      <div class="as-recent-head">
        <span class="as-recent-title">最近到货动态</span>
        <span class="as-recent-sub">最近 40 条（按入库时间倒序）</span>
        <span class="spacer"></span>
        <el-button size="small" :disabled="!allEvents.length" @click="downloadLog">下载日志</el-button>
      </div>
      <div v-if="recent.length" class="as-log">
        <div v-for="g in logGroups" :key="g.date" class="as-log-group">
          <div class="as-log-date">{{ g.date }}</div>
          <div v-for="(e, i) in g.items" :key="g.date + '-' + i" class="as-log-item">
            <span class="as-log-time">{{ (e.at || '').slice(11, 16) }}</span>
            <span class="as-log-req" :title="e.reqNo">{{ e.reqNo || '—' }}</span>
            <span class="as-log-desc">{{ e.description || '—' }}</span>
            <span class="as-log-qty">{{ fmt(e.qty) }}</span>
            <el-tag size="small" :type="e.abnormal ? 'danger' : 'success'">{{ e.abnormal ? '异常' : '正常' }}</el-tag>
            <span v-if="e.abnormal && e.reason" class="as-log-reason">{{ e.reason }}</span>
          </div>
        </div>
      </div>
      <el-empty v-else description="该计划暂无入库记录" :image-size="72" />
      <div class="as-log-foot">共 {{ allEvents.length }} 条记录 · 下载日志包含全部记录</div>
    </div>
  </div>`
};
