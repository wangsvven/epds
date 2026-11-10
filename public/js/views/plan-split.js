/* ========== views/plan-split ==========
 * 周计划拆分弹窗（window.PlanSplitDlg，全局注册为 <plan-split-dlg>）。
 * 只做「预览 → 逐天确认 → 提交」：解析与校验全在服务端 core/plan-split，前端不重复实现规则。
 * 入口与守卫在 views/plans.js（更多下拉「拆分 / 撤销拆分」）。
 * 桌面用五列表格；≤768px 改为逐天卡片，避免宽表在手机上被裁切。
 */

/* 解析结果 chips：表格与卡片共用，避免两处渲染口径漂移 */
const SplitItemsChips = {
  props: { items: { type: Array, default: () => [] } },
  template: `
  <div v-if="!items.length" class="psp-empty">—</div>
  <div v-else class="psp-items">
    <span v-for="(it, i) in items" :key="i" class="psp-chip" :class="{ 'is-unparsed': it.unparsed, 'is-unmapped': it.unmapped }">
      <template v-if="!it.unparsed">
        <span v-if="it['地点']" class="psp-loc">{{ it['地点'] }} · </span>{{ it['工序'] }}<span v-if="it['规格']"> {{ it['规格'] }}</span><span v-if="it['数量'] !== null && it['数量'] !== undefined" class="psp-num"> {{ it['数量'] }}{{ it['单位'] }}</span>
      </template>
      <template v-else>{{ it['原文'] }}</template>
      <em v-if="it.unparsed" class="psp-flag is-warn">未解析</em>
      <em v-else-if="it.unmapped" class="psp-flag is-gray">未映射</em>
      <em v-if="it.expandedFrom" class="psp-flag is-plain">已展开「同上」</em>
    </span>
  </div>`
};

/* 七类当天工作量：只读展示 + 可改数字，改动作为确认稿覆盖值 */
const SplitQtyGrid = {
  props: { row: { type: Object, required: true }, labels: { type: Array, default: () => [] } },
  emits: ['qty'],
  methods: {
    val(k) {
      const v = this.row.quantities ? this.row.quantities[k] : '';
      return (v === 0 || v) ? String(v) : '';
    }
  },
  template: `
  <div class="psp-qty">
    <label v-for="q in labels" :key="q[0]" class="psp-qty-cell" :class="{ 'is-empty': !val(q[0]) }">
      <span class="psp-qty-lb">{{ q[1] }}</span>
      <el-input size="small" :model-value="val(q[0])" placeholder="—" @update:model-value="v => $emit('qty', q[0], v)" />
    </label>
  </div>`
};

const PlanSplitDlg = {
  props: {
    modelValue: { type: Boolean, default: false },
    plan: { type: Object, default: null }
  },
  emits: ['update:modelValue', 'done'],
  components: { SplitItemsChips, SplitQtyGrid },
  setup(props, { emit }) {
    const { ref, computed, watch, onMounted, onUnmounted } = Vue;
    const loading = ref(false);
    const submitting = ref(false);
    const errors = ref([]);
    const days = ref([]);
    const planName = ref('');
    const planRange = ref('');
    const narrow = ref(false);

    const QTY_LABELS = [
      ['wlPole', '杆塔(基)'], ['wlLine1035', '10kV(km)'], ['wlCable', '电缆(km)'],
      ['wlRing', '环网柜(个)'], ['wlVacuum', '真空(个)'], ['wlTransformer', '变压器(个)'], ['wlLine04', '0.4kV(km)']
    ];

    const visible = computed({
      get: () => props.modelValue,
      set: v => emit('update:modelValue', v)
    });
    const canSubmit = computed(() => !errors.value.length && days.value.length > 1 && !loading.value && !submitting.value);

    function syncNarrow() { narrow.value = window.innerWidth <= 768; }
    onMounted(() => { syncNarrow(); window.addEventListener('resize', syncNarrow); });
    onUnmounted(() => { window.removeEventListener('resize', syncNarrow); });

    function mdLabel(date) {
      const p = String(date || '').slice(0, 10).split('-');
      return (+p[1]) + '月' + (+p[2]) + '日';
    }
    function weekday(date) {
      const t = Date.parse(String(date).slice(0, 10) + 'T00:00:00Z');
      if (isNaN(t)) return '';
      return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(t).getUTCDay()];
    }
    function timeOf(v) { return String(v || '').slice(11, 16); }
    function setQty(row, k, v) {
      const q = Object.assign({}, row.quantities || {});
      const s = String(v == null ? '' : v).trim();
      if (s === '') delete q[k]; else q[k] = s;
      row.quantities = q;
      row.qtyTouched = true;
    }
    // 用当前行内容重组整篇文档：标题用「M月D日：」，与解析器的显式日期口径一致
    function rebuildContent() {
      return days.value.map(d => mdLabel(d.date) + '：' + String(d.content || '')).join('\n');
    }

    async function preview(content) {
      if (!props.plan) return;
      loading.value = true;
      try {
        const body = (content === undefined) ? {} : { content: content };
        const res = await api.post('/api/workPlans/' + props.plan.id + '/split/preview', body);
        errors.value = Array.isArray(res.errors) ? res.errors : [];
        const prev = {};
        days.value.forEach(d => { prev[d.date] = d; });
        days.value = (res.days || []).map(d => {
          const old = prev[d.date];
          const row = Object.assign({}, d, { qtyTouched: !!(old && old.qtyTouched) });
          // 用户手动改过工作量的行，重新解析时保留其覆盖值
          if (old && old.qtyTouched) row.quantities = Object.assign({}, d.quantities, old.quantities);
          return row;
        });
      } catch (e) {
        errors.value = [e.message || '预览失败'];
        days.value = [];
      } finally { loading.value = false; }
    }

    // 打开时先清空再填头部：reset 会清 planName/planRange，顺序不能反
    watch(() => props.modelValue, v => {
      if (!v) { errors.value = []; days.value = []; planName.value = ''; planRange.value = ''; return; }
      errors.value = []; days.value = [];
      const p = props.plan || {};
      planName.value = p.name || '';
      planRange.value = p.startDate
        ? (String(p.startDate) + ' ~ ' + String(p.endDate))
        : '';
      preview();
    });

    async function reparse() { await preview(rebuildContent()); }
    async function reparseRow() { await reparse(); }

    async function submit() {
      if (!canSubmit.value) return;
      submitting.value = true;
      try {
        const payload = days.value.map(d => {
          const q = {};
          Object.keys(d.quantities || {}).forEach(k => {
            const s = String(d.quantities[k]).trim();
            if (s === '') q[k] = '';
            else if (!isNaN(Number(s))) q[k] = Number(s);
          });
          return { date: d.date, content: String(d.content || '').trim(), quantities: q };
        });
        const res = await api.post('/api/workPlans/' + props.plan.id + '/split', { days: payload });
        const n = (res.children || []).length;
        ElementPlus.ElMessage.success('已生成 ' + n + ' 条日计划');
        visible.value = false;
        emit('done', { count: n, batchId: res.batchId });
      } catch (e) {
        const d = e.data || {};
        errors.value = Array.isArray(d.errors) ? d.errors : [e.message || '拆分失败'];
        ElementPlus.ElMessage.error(e.message || '拆分失败');
      } finally { submitting.value = false; }
    }

    return {
      visible, loading, submitting, errors, days, planName, planRange, QTY_LABELS, narrow,
      canSubmit, mdLabel, weekday, timeOf, setQty, reparse, reparseRow, submit
    };
  },
  template: `
  <el-dialog v-model="visible" title="拆分周计划" width="min(1180px, 96%)" top="6vh" class="psp-dlg">
    <div class="psp-head">
      <div class="psp-title">{{ planName }}</div>
      <div class="psp-sub" v-if="planRange">原计划起止：{{ planRange }}</div>
    </div>

    <div v-if="errors.length" class="psp-errors">
      <div class="psp-errors-title">请先修正以下问题（共 {{ errors.length }} 条）</div>
      <div v-for="(e, i) in errors" :key="i" class="psp-err-line">{{ e }}</div>
    </div>
    <div v-else-if="days.length" class="psp-ok">
      <span class="psp-ok-dot"></span>日期已与计划起止范围严格匹配
    </div>

    <div class="psp-body" v-loading="loading">
      <!-- 桌面：五列表；窄屏：逐天卡片 -->
      <el-table v-if="!narrow" :data="days" size="small" border class="psp-table" style="width:100%" empty-text="暂无可拆分的每日内容">
        <el-table-column label="日期" width="100">
          <template #default="{row}">
            <div class="psp-date">{{ mdLabel(row.date) }}</div>
            <div class="psp-wd">{{ weekday(row.date) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="时间段" width="112">
          <template #default="{row}">
            <div class="psp-time">{{ timeOf(row.start) }} ~ {{ timeOf(row.end) }}</div>
            <div v-if="String(row.end).slice(0,10) !== String(row.start).slice(0,10)" class="psp-wd">次日结束</div>
          </template>
        </el-table-column>
        <el-table-column label="当天内容（可编辑）" min-width="256">
          <template #default="{row}">
            <el-input v-model="row.content" type="textarea" :autosize="{minRows:2,maxRows:6}" placeholder="当天工作内容" />
          </template>
        </el-table-column>
        <el-table-column label="解析结果" min-width="250">
          <template #default="{row}"><split-items-chips :items="row.items" /></template>
        </el-table-column>
        <el-table-column label="当天工作量" min-width="258">
          <template #default="{row}">
            <split-qty-grid :row="row" :labels="QTY_LABELS" @qty="(k, v) => setQty(row, k, v)" />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="86" align="center">
          <template #default>
            <el-button link type="primary" size="small" :disabled="loading" @click="reparseRow">重新解析</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div v-else class="psp-cards">
        <div v-if="!days.length" class="psp-empty">暂无可拆分的每日内容</div>
        <div v-for="row in days" :key="row.date" class="psp-card">
          <div class="psp-card-head">
            <b>{{ mdLabel(row.date) }}</b>
            <span class="psp-wd">{{ weekday(row.date) }}</span>
            <span class="psp-time">{{ timeOf(row.start) }} ~ {{ timeOf(row.end) }}</span>
            <el-button link type="primary" size="small" class="psp-card-reparse" :disabled="loading" @click="reparseRow">重新解析</el-button>
          </div>
          <el-input v-model="row.content" type="textarea" :autosize="{minRows:2,maxRows:6}" placeholder="当天工作内容" />
          <split-items-chips :items="row.items" />
          <split-qty-grid :row="row" :labels="QTY_LABELS" @qty="(k, v) => setQty(row, k, v)" />
        </div>
      </div>
    </div>

    <div class="psp-tip">拆分后父计划收缩为第一天（名称不变），其余每天生成一条子计划；勘察编号与工作票编号父子共用，生成文档按各自日期另行生成。</div>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button :disabled="loading" @click="reparse">重新解析全部</el-button>
      <el-button type="primary" :loading="submitting" :disabled="!canSubmit" @click="submit">确认拆分</el-button>
    </template>
  </el-dialog>`
};
window.PlanSplitDlg = PlanSplitDlg;
