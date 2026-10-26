/* ========== js/main ========== */
/* 根组件 App、侧栏菜单图标、createApp / 全局 mixin / 组件注册 / mount（只放这里）。 */
/* ---------------- 根组件：登录 + 布局 + 路由 ---------------- */
// 侧栏菜单图标（内联 SVG，随文字颜色变化，暗色模式无需另配图）
const _ico = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const MENU_ICONS = {
  home: _ico('<path d="M4 10.6 12 4l8 6.6V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>'),
  projects: _ico('<path d="M3 7.5A2 2 0 0 1 5 5.5h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  materials: _ico('<path d="M20.5 8 12 3.5 3.5 8v8L12 20.5 20.5 16z"/><path d="M3.5 8 12 12.5 20.5 8M12 12.5v8"/>'),
  plans: _ico('<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17"/>'),
  borrow: _ico('<path d="M4 8h13l-3-3M20 16H7l3 3"/>'),
  completion: _ico('<path d="M14 3.5H7A2 2 0 0 0 5 5.5v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9z"/><path d="M14 3.5v5h5"/><path d="m9 14.5 2 2 4-4.5"/>'),
  actualWorks: _ico('<path d="M4 20h16"/><rect x="6" y="11" width="3" height="6" rx=".6"/><rect x="10.5" y="7" width="3" height="10" rx=".6"/><rect x="15" y="13" width="3" height="4" rx=".6"/>'),
  documents: _ico('<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4M9 12h6M9 16h4.5"/>'),
  settings: _ico('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2.5 12h3M18.5 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'),
  users: _ico('<circle cx="12" cy="8" r="3.4"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/>'),
  workers: _ico('<circle cx="9" cy="8" r="3.2"/><path d="M2.8 19.5a6.2 6.2 0 0 1 12.4 0"/><path d="M16.5 5.6a3 3 0 0 1 0 5.6M17.6 19.5a6.4 6.4 0 0 0-1.6-4.2"/>'),
  init: _ico('<path d="M12 3.5l1.7 4.3 4.3 1.7-4.3 1.7L12 15.5l-1.7-4.3L6 9.5l4.3-1.7z"/><path d="M18.3 15.6l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z"/>')
};

const App = {
  setup() {
    const { onUnmounted } = Vue;
    const token = ref(localStorage.getItem('erp_token'));
    const me = reactive({ name: '', role: '' });
    const viewVersion = ref(0);
    const tenant = ref('');
    // 主页脚版本号：由 /api/public-config 下发（服务端读 package.json，禁止前端写死）
    const siteVersion = ref('');
    // 首次使用初始化向导是否已完成
    const initialized = ref(true);
    const initMode = computed(() => !!token.value && !initialized.value);
    // 移动端（<768px）默认收起侧栏，避免抽屉一进来就压住内容
    const collapsed = ref(typeof window !== 'undefined' && window.innerWidth < 768);
    const route = ref('home');
    const loginForm = reactive({ username: '', password: '' });
    const loginLoading = ref(false);
    // 登录页背景 / 品牌：背景由服务端直出到 CSS 变量 --login-bg（无闪跳），
    // 这里仅作为回退（如从非 / 路径进入）与品牌名同步。
    const loginBg = ref('');
    const loginBrand = reactive({ companyName: '' });

    // ===== 明暗主题：首屏由 index.html 内联脚本预先定好，这里只做切换与持久化 =====
    const theme = ref(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
    function applyTheme(next) {
      theme.value = next;
      document.documentElement.classList.toggle('dark', next === 'dark');
      try { localStorage.setItem('erp_theme', next); } catch (e) {}
    }
    function toggleTheme() { applyTheme(theme.value === 'dark' ? 'light' : 'dark'); }
    function menuIcon(key) { return MENU_ICONS[key] || MENU_ICONS.home; }

    // 首次初始化未完成时仅以下页面可访问，其余点击一律转跳初始化向导
    const INIT_ALLOWED = ['init', 'documents', 'settings', 'users', 'workers'];
    const allMenu = [
      { key: 'home', label: '用户中心', sub: '数据概览与常用入口', comp: 'Dashboard' },
      { key: 'projects', label: '项目列表', sub: '工程项目台账 · 进度与资料', comp: 'ProjectsView' },
      { key: 'materials', label: '材料台账', sub: '材料明细 · 领料出库与库存', comp: 'MaterialsView' },
      { key: 'plans', label: '计划管理', sub: '周计划 / 月计划 / 当日施工量', comp: 'PlansView' },
      { key: 'borrow', label: '借工管理', sub: '借工登记与用工台账', comp: 'CrudView', cfg: borrowCfg },
      { key: 'completion', label: '竣工资料（开发中）', sub: '竣工资料归档', comp: 'CrudView', cfg: completionCfg },
      { key: 'actualWorks', label: '工程实际施工量', comp: 'ActualConstructionView', hideTitle: true },
      { key: 'documents', label: '文档中心', comp: 'DocumentsView', hideTitle: true },
      { key: 'settings', label: '全局设置', sub: '系统参数 · 单位与字典维护', comp: 'SettingsView' },
      { key: 'users', label: '用户管理', sub: '登录账号 · 作业人员 · 外部通讯录', comp: 'UsersView' },
      { key: 'workers', label: '作业人员与班组', sub: '人员名单与班组', comp: 'WorkersView', hidden: true, hideTitle: true },
      { key: 'init', label: '初始化设置', sub: '首次使用引导', comp: 'InitView', hidden: true }
    ];
    // init 为首次向导隐藏入口
    const visibleMenu = computed(() => allMenu.filter(m => !m.hidden));
    const current = computed(() => allMenu.find(m => m.key === route.value) || visibleMenu.value[0] || allMenu[0]);

    async function fetchMe() {
      try {
        const r = await api.get('/api/me');
        me.name = r.user.name; me.role = r.user.role;
        Auth.loaded = true;
        Auth.isAdmin = !!r.user.isAdmin;
        Auth.group = r.user.role;
        Auth.displayName = r.user.name || r.user.username || '';
        Auth.writeModules = (r.user.permissions && r.user.permissions.writeModules) || [];
        // 顶栏企业名跟随「网站设置-企业名称」；未填写时整行不渲染（不再回退旧系统名）
        tenant.value = (r.settings && r.settings.companyName) || '';
        // 首次使用初始化向导：未完成时进入「初始化设置」首屏
        initialized.value = !!(r.settings && r.settings.initialized);
        // 首次初始化未完成：若当前停留在非允许页面（含首页），强制转跳回初始化向导
        if (!initialized.value && !INIT_ALLOWED.includes(route.value)) route.value = 'init';
      } catch (e) {}
    }
    async function login() {
      loginLoading.value = true;
      try {
        const r = await api.post('/api/login', loginForm);
        localStorage.setItem('erp_token', r.token);
        token.value = r.token; me.name = r.user.name; me.role = r.user.role;
        await fetchMe();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { loginLoading.value = false; }
    }
    function logout() { localStorage.removeItem('erp_token'); Auth.loaded = false; Auth.isAdmin = false; Auth.writeModules = []; token.value = ''; location.reload(); }
    // 页面跳转：移动端自动收起抽屉；未完成初始化时，除「文档中心/全局设置/用户管理」外一律转跳回初始化向导
    function go(key) {
      if (initMode.value && !INIT_ALLOWED.includes(key)) {
        route.value = 'init';
        if (typeof window !== 'undefined' && window.innerWidth < 768) collapsed.value = true;
        ElementPlus.ElMessage.info('请先完成系统初始化设置');
        return;
      }
      route.value = key;
      if (typeof window !== 'undefined' && window.innerWidth < 768) collapsed.value = true;
    }

    // 安全网：任何非经 go() 直接修改 route 的路径，未初始化时若落在受限页面，强制转跳
    watch(route, (v) => { if (initMode.value && !INIT_ALLOWED.includes(v)) route.value = 'init'; });
    // 初始化完成：放行业务页面并进入用户中心（不依赖 fetchMe 异步时序）
    function onInitDone() { initialized.value = true; route.value = 'home'; }

    onMounted(() => {
      if (token.value) fetchMe();
      // 登录页公开配置（无需登录）：背景图 + 系统名 / 企业名
      api.get('/api/public-config').then(c => {
        const bg = c.loginBg || '/login-bg/valley.jpg';
        loginBg.value = bg;
        // 回退设置：仅当服务端未注入（值为 none）时才覆盖，避免覆盖正确的直出值造成闪跳
        const cur = getComputedStyle(document.documentElement).getPropertyValue('--login-bg').trim();
        if (!cur || cur === 'none') document.documentElement.style.setProperty('--login-bg', "url('" + bg + "')");
        loginBrand.companyName = c.companyName || '';
        siteVersion.value = c.version || '';
      }).catch(() => {});
      // 项目详情跳转：进入材料台账 / 计划管理（跨模块导航）
      // 跨模块跳转同样受初始化守卫约束：未初始化时业务页面一律转跳初始化向导
      function navMaterials() { go('materials'); }
      function navPlans() { go('plans'); }
      function navTo(e) { go(e.detail); }
      window.addEventListener('nav-materials', navMaterials);
      window.addEventListener('nav-plans', navPlans);
      window.addEventListener('nav-to', navTo);
      window.addEventListener('init-done', onInitDone);
      onUnmounted(() => {
        window.removeEventListener('nav-materials', navMaterials);
        window.removeEventListener('nav-plans', navPlans);
        window.removeEventListener('nav-to', navTo);
        window.removeEventListener('init-done', onInitDone);
      });
    });
    // 网站设置保存后实时刷新顶部标题/企业名称
    window.addEventListener('brand-changed', fetchMe);

    return { token, me, tenant, siteVersion, initialized, initMode, collapsed, route, loginForm, loginLoading, loginBg, loginBrand, visibleMenu, current, login, logout, go, viewVersion, theme, toggleTheme, menuIcon };
  },
  template: `
  <div v-if="!token">
    <div class="login-wrap">
      <div class="login-bg-rotate">
        <div class="login-bg-lqip"></div>
        <div class="login-bg-layer"></div>
      </div>
      <div class="login-ambient" aria-hidden="true"><span class="b1"></span><span class="b2"></span><span class="b3"></span></div>
      <div class="login-card">
        <div class="login-inner">
          <div class="brand">
            <div class="brand-bolt" aria-hidden="true">
              <svg viewBox="0 0 24 30"><path d="M14.5 0 2 17.5h7.2L6.8 30 22 11.8h-7.4L14.5 0z" fill="url(#epdGradBright)"/></svg>
            </div>
            <h2><span class="lb-1">Electric Power</span><span class="lb-2">Data System</span></h2>
            <div class="sub">本地自托管版 · 请登录</div>
          </div>
          <el-form @submit.prevent="login">
            <el-form-item><el-input v-model="loginForm.username" placeholder="账号" size="large" autocomplete="username" @keyup.enter="login" /></el-form-item>
            <el-form-item><el-input v-model="loginForm.password" type="password" placeholder="密码" size="large" show-password autocomplete="current-password" @keyup.enter="login" /></el-form-item>
            <el-button type="primary" size="large" class="login-btn" :loading="loginLoading" @click="login">登录</el-button>
          </el-form>
        </div>
      </div>
      <div class="login-page-footer">
        <div class="company" v-if="loginBrand.companyName">{{ loginBrand.companyName }}</div>
        <div class="sysver">Electric Power Data System · 本地版{{ siteVersion ? ' v' + siteVersion : '' }}</div>
      </div>
    </div>
  </div>
  <div v-else class="app-shell">
    <header class="app-header">
      <div class="left">
        <button class="icon-btn" @click="collapsed=!collapsed" :title="collapsed?'展开菜单':'收起菜单'" aria-label="菜单">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3.5 7h17M3.5 12h17M3.5 17h17"/></svg>
        </button>
        <div class="app-brand" aria-hidden="true">
          <svg viewBox="0 0 24 30"><path d="M14.5 0 2 17.5h7.2L6.8 30 22 11.8h-7.4L14.5 0z" fill="url(#epdGradDeep)"/></svg>
        </div>
        <div class="brand-lockup">
          <div class="brand-org" v-if="tenant">{{ tenant }}</div>
          <div class="brand-title"><span class="bt-a">Electric Power</span> <span class="bt-grad">Data System</span></div>
        </div>
      </div>
      <div class="right">
        <button class="theme-toggle" @click="toggleTheme" :title="theme==='dark' ? '切换到浅色模式' : '切换到深色模式'">
          <svg v-if="theme==='dark'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <circle cx="12" cy="12" r="4"/><path d="M12 2.6v2.2M12 19.2v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.6 12h2.2M19.2 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6"/>
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20 14.2A8.2 8.2 0 0 1 9.8 4 8.4 8.4 0 1 0 20 14.2z"/>
          </svg>
          <span>{{ theme==='dark' ? '浅色' : '深色' }}</span>
        </button>
        <span class="user-name">{{ me.name || me.username }}</span>
        <span v-if="me.role" class="user-role">{{ me.role }}</span>
        <span class="logout-btn" @click="logout">退出登录</span>
      </div>
    </header>
    <div class="layout">
      <aside class="aside" :class="{ collapsed }">
        <div v-for="m in visibleMenu" :key="m.key" class="menu-item" :class="{ active: route===m.key || (m.key==='home' && route==='init') }" @click="go(m.key)">
          <span class="mi" v-html="menuIcon(m.key)"></span>
          <span class="mt">{{ m.label }}</span>
        </div>
      </aside>
      <div class="aside-mask" v-if="!collapsed" @click="collapsed = true"></div>
      <main class="main">
        <div v-if="initMode && route!=='init'" class="init-bar">
          <span>企业初始化尚未完成。</span>
          <span class="link" @click="go('init')">返回初始化卡片</span>
        </div>
        <div class="page-head" v-if="!current.hideTitle">
          <h2 class="page-title">{{ current.label }}</h2>
          <div class="page-sub" v-if="current.sub">{{ current.sub }}</div>
        </div>
        <InitView v-if="route==='init'" />
        <component :is="current.comp" v-else-if="current.comp==='CrudView'" :config="current.cfg" :key="current.key + '-' + viewVersion" />
        <component :is="current.comp" v-else :key="current.key + '-' + viewVersion" />
      </main>
    </div>
  </div>`
};

const app = createApp(App);

// 全局权限助手：各组件模板可直接用 canWrite('模块') / canAdmin()
app.mixin({
  methods: {
    canWrite(mod) {
      if (!Auth.loaded) return false;
      return Auth.writeModules.includes('*') || Auth.writeModules.includes(mod);
    },
    canAdmin() { return !!Auth.isAdmin; }
  }
});
const lp = (typeof ElementPlusLocaleZhCn !== 'undefined') ? { locale: ElementPlusLocaleZhCn } : ((ElementPlus.lang && ElementPlus.lang.zhCn) ? { locale: ElementPlus.lang.zhCn } : {});
app.use(ElementPlus, lp);
app.component('FunnelIcon', FunnelIcon);
app.component('CrudView', CrudView);
app.component('ProjectsView', ProjectsView);
app.component('DocumentsView', DocumentsView);
app.component('MaterialsView', MaterialsView);
app.component('Dashboard', Dashboard);
app.component('SettingsView', SettingsView);
app.component('InitView', InitView);
app.component('WorkersPanel', WorkersPanel);
app.component('ContactsPanel', ContactsPanel);
app.component('WorkersView', WorkersView);
app.component('UsersView', UsersView);
app.component('AccountsPanel', AccountsPanel);
app.component('Requisitions', Requisitions);
app.component('Imports', Imports);
app.component('Outbounds', Outbounds);
app.component('ArrivalStats', ArrivalStats);

app.component('PlanDateTime', PlanDateTime);
app.component('PlansView', PlansView);
app.component('ActualConstructionView', ActualConstructionView);
app.mount('#app');
