/* ========== views/arrivalStats ========== */
/* 材料台账「到货统计」页签：按年度计划汇总到货情况（全计划口径，不按项目拆分）。 */
const ArrivalStats = {
  setup() {
    const { ref, computed, onMounted } = Vue;
    const loading = ref(true);
    const materials = ref([]);
    const projects = ref([]);
    const plans = ref([]);
    const reqs = ref([]);
    const plan = ref('');
    const page = ref(1);
    const pageSize = ref(50);

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
    const paged = computed(() => agg.value.rows.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));
    const recent = computed(() => window.ArrivalCalc.recentArrivals(reqs.value, planNames.value, 50));

    function onPlanChange() { page.value = 1; }
    function fmt(n) {
      const v = Math.round((Number(n) || 0) * 10000) / 10000;
      return String(v);
    }
    onMounted(load);

    return { loading, plan, plans, page, pageSize, paged, agg, recent, onPlanChange, fmt, load };
  },
  template: `
  <div v-loading="loading">
    <div class="toolbar">
      <span style="font-weight:600;font-size:15px">到货统计</span>
      <el-select v-model="plan" style="width:220px" @change="onPlanChange">
        <el-option v-for="p in plans" :key="p.id" :label="p.name" :value="p.name" />
      </el-select>
      <span class="as-sum">材料 {{ agg.totalRows }} 行 · 按编码合并 {{ agg.kindCount }} 种 · 其中已到货 {{ agg.arrivedKindCount }} 种</span>
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

    <el-table :data="paged" class="mat-table as-table" style="width:100%">
      <el-table-column prop="code" label="物料编码" width="146">
        <template #default="{row}"><span class="mat-code">{{ row.code || '—' }}</span></template>
      </el-table-column>
      <el-table-column prop="description" label="物料描述" min-width="300">
        <template #default="{row}">
          <span class="mat-desc">{{ row.description }}</span>
          <span v-if="row.descConflict" class="as-flag" title="同编码存在多种描述，已按应到数量最大的一行显示">描述不一致</span>
        </template>
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
      <span class="mat-pager-total">已到货 {{ agg.rows.length }} 种 · 未到货 {{ agg.notArrivedKindCount }} 种</span>
      <el-pagination v-model:current-page="page" v-model:page-size="pageSize" :total="agg.rows.length"
        :page-sizes="[20, 50, 100, 200]" layout="prev, pager, next, sizes" background />
    </div>

    <div class="as-recent">
      <div class="as-recent-head">
        <span class="as-recent-title">最近到货动态</span>
        <span class="as-recent-sub">最近 {{ recent.length }} 条（按入库时间倒序）</span>
      </div>
      <el-table v-if="recent.length" :data="recent" class="mat-table" size="small" style="width:100%">
        <el-table-column prop="at" label="时间" width="150" />
        <el-table-column prop="reqNo" label="领料单号" width="180" />
        <el-table-column prop="description" label="材料" min-width="260">
          <template #default="{row}"><span class="mat-desc">{{ row.description || '—' }}</span></template>
        </el-table-column>
        <el-table-column label="本次到货数量" width="126" align="right">
          <template #default="{row}"><span class="mat-num">{{ fmt(row.qty) }}</span></template>
        </el-table-column>
        <el-table-column label="情况" min-width="180">
          <template #default="{row}">
            <el-tag size="small" :type="row.abnormal ? 'danger' : 'success'">{{ row.abnormal ? '异常' : '正常' }}</el-tag>
            <span v-if="row.abnormal && row.reason" class="as-reason">{{ row.reason }}</span>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-else description="该计划暂无入库记录" :image-size="72" />
    </div>
  </div>`
};
