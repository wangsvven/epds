/* ========== views/dashboard ========== */
/* 首页仪表盘 Dashboard。 */
/* ---------------- 首页仪表盘 ---------------- */
const Dashboard = {
  setup() {
    const stats = reactive({ projects: 0, materials: 0, requisitions: 0, documents: 0, borrow: 0 });
    const me = ref({});
    const alerts = ref([]);
    async function load() {
      try {
        const [p, m, r, d, b] = await Promise.all([
          api.get('/api/projects'), api.get('/api/materials'), api.get('/api/materialRequisitions'),
          api.get('/api/documents'), api.get('/api/borrowWorks')
        ]);
        stats.projects = p.length; stats.materials = m.length; stats.requisitions = r.length;
        stats.documents = d.files.length; stats.borrow = b.length;
      } catch (e) {}
      try { me.value = (await api.get('/api/me')).user; } catch (e) {}
      // 准入到期预警：全部由作业人员现有数据派生，不新建集合/字段，超期在前、其余按到期日升序
      try {
        const w = await api.get('/api/workers');
        const arr = Array.isArray(w) ? w : (w.data || []);
        alerts.value = WorkerStatus.alerts(arr, ServerTime.ymd());
      } catch (e) { alerts.value = []; }
    }
    function alertLine(a) {
      return a.name + '（' + (a.team || '未分组') + '）· ' + a.validEnd;
    }
    function focusWorker(a) {
      window.__pendingUsersTab = 'workers';
      window.__pendingFocusWorker = { id: a.id, name: a.name };
      window.dispatchEvent(new CustomEvent('nav-to', { detail: 'users' }));
    }
    onMounted(load);
    return { stats, me, alerts, alertLine, focusWorker };
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
        <div class="wk-alert-head">准入到期预警<span class="wk-alert-count">{{ alerts.length }}</span></div>
        <div v-if="!alerts.length" class="wk-alert-empty">暂无准入到期预警</div>
        <div v-else class="wk-alert-list">
          <div v-for="a in alerts" :key="a.id" class="wk-alert-item" :title="alertLine(a)" @click="focusWorker(a)">
            <span class="wk-alert-line">{{ alertLine(a) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>`
};
