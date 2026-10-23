/* ========== views/init ========== */
/* 首次使用初始化视图 InitView（前期检查 5 项基础设置）。 */
/* ---------------- 首次使用初始化（前期检查：5 项基础设置） ---------------- */
const InitView = {
  setup() {
    const status = reactive({ initialized: false, companyName: '', workers: 0, workersWithTeam: 0 });
    const loading = ref(true);
    const finishing = ref(false);

    async function loadStatus() {
      try {
        const s = await api.get('/api/init-status');
        Object.assign(status, s);
      } catch (e) {}
      finally { loading.value = false; }
    }

    // 各项完成度：全部基于后端真实数据（外部通讯录不列入初始化必填项，可后续在「用户管理」补充）
    const doneMap = computed(() => ({
      company: !!status.companyName,
      workers: status.workersWithTeam > 0
    }));

    const steps = computed(() => {
      const d = doneMap.value;
      return [
        { key: 'company', title: '企业名称', target: 'settings',
          desc: '网站标题作为企业在页面显示的名称，点击下方按钮前往「全局设置 · 网站设置」填写。',
          statusText: d.company ? status.companyName : '尚未填写企业名称' },
        { key: 'workers', title: '班组与施工人员', target: 'workers',
          desc: '至少建立一个班组和一位已确认的施工人员。账号与施工人员分开维护。',
          statusText: d.workers ? '已建立班组和施工人员' : '请建立班组并添加施工人员' }
      ];
    });

    const doneCount = computed(() => Object.values(doneMap.value).filter(Boolean).length);
    const pct = computed(() => Math.round(doneCount.value / steps.value.length * 100));
    // 企业名称为必填项；其余为基础配置项，可在对应模块随时补充
    const canStart = computed(() => doneMap.value.company);

    function goTarget(t, tab) {
      if (t === 'settings') window.__pendingSettingsTab = 'site';
      if (t === 'users' && tab) window.__pendingUsersTab = tab;
      window.dispatchEvent(new CustomEvent('nav-to', { detail: t }));
    }
    async function finish() {
      if (!canStart.value) { ElementPlus.ElMessage.warning('请先填写并保存企业名称'); return; }
      finishing.value = true;
      try {
        await api.put('/api/settings', { initialized: true });
        ElementPlus.ElMessage.success('初始化完成，欢迎使用');
        // 刷新顶栏企业名/标题，并标记初始化完成（App 监听到后放行并进入用户中心）
        window.dispatchEvent(new CustomEvent('brand-changed'));
        window.dispatchEvent(new CustomEvent('init-done'));
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { finishing.value = false; }
    }

    // 从网站设置保存后返回向导时同步刷新完成情况
    function onBrandChanged() { loadStatus(); }
    onMounted(() => { loadStatus(); window.addEventListener('brand-changed', onBrandChanged); });
    onUnmounted(() => window.removeEventListener('brand-changed', onBrandChanged));
    return { status, loading, finishing, doneMap, doneCount, pct, canStart, steps, goTarget, finish };
  },
  template: `
  <div class="init-page">
    <div class="init-tabs"><span class="init-tab">前期检查</span></div>

    <div class="init-intro"><span class="dot"></span>首次使用请完成以下基础设置，完成后即可开始使用系统。</div>

    <div class="init-progress-row">
      <div class="init-progress"><div class="init-progress-inner" :style="{ width: pct + '%' }"></div></div>
      <span class="init-progress-num">{{ doneCount }}/{{ steps.length }}</span>
    </div>

    <div class="init-grid">
      <div v-for="s in steps" :key="s.key" class="init-block">
        <div class="init-block-head">
          <span class="init-block-title">{{ s.title }}</span>
          <span class="init-badge" :class="doneMap[s.key] ? 'done' : 'pending'">{{ doneMap[s.key] ? '已完成' : '待完成' }}</span>
        </div>
        <div class="init-block-desc">{{ s.desc }}</div>
        <div class="init-block-status" :class="{ pending: !doneMap[s.key] }">{{ s.statusText }}</div>

        <!-- 本页仅做引导：企业名称统一在「全局设置 · 网站设置」中填写与修改 -->
        <div class="init-block-actions">
          <el-button size="small" @click="goTarget(s.target, s.tab)">{{ doneMap[s.key] ? '查看或修改' : '去设置' }}</el-button>
        </div>
      </div>
    </div>

    <div class="init-footer">
      <span class="tip">企业名称为必填项；班组与施工人员可稍后补充，外部通讯录可在「用户管理」中随时维护。</span>
      <el-button type="primary" :loading="finishing" :disabled="!canStart" @click="finish">开始使用</el-button>
    </div>
  </div>`
};

