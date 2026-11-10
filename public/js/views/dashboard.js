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
      // 每个接口独立容错：任一失败只让对应那一类缺席，不再整块清空。
      // 旧写法用 Promise.all 包住五类来源，任何一个 401/403/超时都会让「工作动态」全空且无提示。
      const pick = async (url, key) => {
        try {
          const r = await api.get(url);
          if (Array.isArray(r)) return r;
          if (key && r && Array.isArray(r[key])) return r[key];
          return (r && Array.isArray(r.data)) ? r.data : [];
        } catch (e) { return []; }
      };
      const [p, m, r, d, b] = await Promise.all([
        pick('/api/projects'), pick('/api/materials'), pick('/api/materialRequisitions'),
        pick('/api/documents', 'files'), pick('/api/borrowWorks')
      ]);
      stats.projects = p.length; stats.materials = m.length; stats.requisitions = r.length;
      stats.documents = d.length; stats.borrow = b.length;
      try { me.value = (await api.get('/api/me')).user; } catch (e) {}
      // 工作动态：九类来源各自只读自己模块的现有接口，聚合与排序交给 WorkFeed 纯函数
      const [w, ims, plans, outs, works, docs] = await Promise.all([
        pick('/api/workers'), pick('/api/materialImports'), pick('/api/workPlans'),
        pick('/api/materialOutbound'), pick('/api/actualWorks'), pick('/api/completionDocuments')
      ]);
      try {
        const today = ServerTime.ymd();
        const alerts = window.WorkerStatus.alerts(w, today);
        const feed = window.WorkFeed.build({
          workers: w, alerts, today,
          imports: ims, materials: m, plans, borrow: b,
          projects: p, requisitions: r, outbound: outs, works, docs
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
        <div v-if="!messages.length" class="wk-alert-empty">近 3 天无新增记录</div>
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
