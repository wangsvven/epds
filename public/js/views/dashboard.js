/* ========== views/dashboard ========== */
/* 首页仪表盘 Dashboard：统计卡 + 「工作动态」小白板（多来源派生、现算不落库）。 */
/* ---------------- 首页仪表盘 ---------------- */
const Dashboard = {
  setup() {
    const stats = reactive({ projects: 0, materials: 0, requisitions: 0, documents: 0, borrow: 0 });
    const me = ref({});
    const messages = ref([]);
    const alertCount = ref(0);
    async function load() {
      let mats = [];
      try {
        const [p, m, r, d, b] = await Promise.all([
          api.get('/api/projects'), api.get('/api/materials'), api.get('/api/materialRequisitions'),
          api.get('/api/documents'), api.get('/api/borrowWorks')
        ]);
        mats = Array.isArray(m) ? m : [];
        stats.projects = p.length; stats.materials = mats.length; stats.requisitions = r.length;
        stats.documents = d.files.length; stats.borrow = b.length;
      } catch (e) {}
      try { me.value = (await api.get('/api/me')).user; } catch (e) {}
      // 工作动态：五类来源各自只读自己模块的现有接口，聚合与排序交给 WorkFeed 纯函数
      try {
        const [w, ims, plans, borrow] = await Promise.all([
          api.get('/api/workers'), api.get('/api/materialImports'),
          api.get('/api/workPlans'), api.get('/api/borrowWorks')
        ]);
        const workers = Array.isArray(w) ? w : (w.data || []);
        const today = ServerTime.ymd();
        const alerts = window.WorkerStatus.alerts(workers, today);
        const feed = window.WorkFeed.build({
          workers, alerts, today,
          imports: Array.isArray(ims) ? ims : [],
          materials: mats,
          plans: Array.isArray(plans) ? plans : [],
          borrow: Array.isArray(borrow) ? borrow : []
        });
        messages.value = feed.messages;
        alertCount.value = feed.alertCount;
      } catch (e) { messages.value = []; alertCount.value = 0; }
    }
    // 点击只导航到对应模块列表页；预警/人员动态落到「用户管理 · 作业人员名单」，
    // 并显式清掉上一批的 __pendingFocusWorker，确保不再直开某人的编辑弹窗。
    function goTo(m) {
      window.__pendingUsersTab = m.usersTab || '';
      window.__pendingFocusWorker = null;
      window.dispatchEvent(new CustomEvent('nav-to', { detail: m.nav }));
    }
    onMounted(load);
    return { stats, me, messages, alertCount, goTo };
  },
  template: `
  <div>
    <el-row :gutter="16">
      <el-col :span="4" :xs="12"><div class="stat-card"><div class="num">{{ stats.projects }}</div><div class="label">在建/在管项目</div></div></el-col>
      <el-col :span="4" :xs="12"><div class="stat-card"><div class="num">{{ stats.materials }}</div><div class="label">物料明细条目</div></div></el-col>
      <el-col :span="4" :xs="12"><div class="stat-card"><div class="num">{{ stats.requisitions }}</div><div class="label">领料单</div></div></el-col>
      <el-col :span="4" :xs="12"><div class="stat-card"><div class="num">{{ stats.documents }}</div><div class="label">文档中心文件</div></div></el-col>
      <el-col :span="4" :xs="12"><div class="stat-card"><div class="num">{{ stats.borrow }}</div><div class="label">借工记录</div></div></el-col>
      <el-col :span="4" :xs="12"><div class="stat-card"><div class="num" style="color:var(--ok-text)">在线</div><div class="label">当前用户：{{ me.name || me.username || '-' }}</div></div></el-col>
    </el-row>

    <div class="wk-board-row">
      <div class="stat-card wk-alert-card">
        <div class="wk-alert-head">工作动态<span v-if="alertCount" class="wk-alert-count">{{ alertCount }}</span></div>
        <div v-if="!messages.length" class="wk-alert-empty">暂无工作动态</div>
        <div v-else class="wk-alert-list">
          <div v-for="(m,i) in messages" :key="i" class="wk-alert-item" :title="m.text" @click="goTo(m)">
            <span class="fd-tag" :class="'fd-tag-' + m.kind">{{ m.label }}</span>
            <span class="fd-text">{{ m.text }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>`
};
