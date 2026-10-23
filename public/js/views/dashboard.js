/* ========== views/dashboard ========== */
/* 首页仪表盘 Dashboard。 */
/* ---------------- 首页仪表盘 ---------------- */
const Dashboard = {
  setup() {
    const stats = reactive({ projects: 0, materials: 0, requisitions: 0, documents: 0, borrow: 0 });
    const me = ref({});
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
    }
    onMounted(load);
    return { stats, me };
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
  </div>`
};
