/* ========== views/plans ========== */
/* 计划管理视图 PlansView 与其自研时间选择组件 PlanDateTime。 */
/* ---------------- 计划管理（周计划 / 月计划 / 日计划日历） ---------------- */
const PlansView = {
  setup() {
    const { ref, reactive, computed, onMounted, onUnmounted } = Vue;
    const TABS = [
      { key: 'week', label: '周计划管理' }, { key: 'month', label: '月计划管理' }, { key: 'archived', label: '已归档月计划' },
      { key: 'executed', label: '已执行' }, { key: 'settled', label: '已结算零星计划' }, { key: 'canceled', label: '已取消周计划' }
    ];
    // 工作票类型与类型码集中在 js/plan-no.js（与编号纯函数同源，避免两处漂移）
    const TICKET_TYPES = PlanNo.TICKET_TYPES;
    const VOLTAGE_LEVELS = ['0.4kV', '10kV', '20kV', '35kV', '110kV', '220kV'];
    const WORK_TYPES = ['配农网工程', '生产检修改造', '外部工程', '业扩工程', '迁改工程', '借工'];
    const SPECIALTIES = ['运检', '营销'];
    const DEPTS = ['设备部', '产业部'];
    // 风险因素 = 9 个固定大类（规范文件危险点库的分类口径）；风险管控措施按所选大类从库的对应明细自动带出，非硬编码
    const RISK_CATEGORIES = ['有限空间', '机械伤害', '起重伤害', '触电', '高处坠落', '倒塔/坍塌', '跨越风险', '物体打击', '动火作业'];
    const riskFactors = ref(RISK_CATEGORIES.slice());   // 下拉选项：9 个风险大类
    const hazardLibrary = ref([]);                      // 危险点库全部明细（含 category 字段）
    const units = ref([]);                              // 单位维护（分包/兄弟/监理/抄送）
    function unitsByType(type) { return units.value.filter(u => u.type === type); }
    async function loadHazards() {
      try {
        const d = await api.get('/api/documents');
        hazardLibrary.value = ((d && d.hazardLibrary) || []).slice().sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
      } catch (e) {}
      try {
        const r = await api.get('/api/units');
        units.value = (Array.isArray(r) ? r : (r.data || [])).slice().sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
      } catch (e) {}
    }
    // 9 大类的规范化简写管控措施（源自文档中心规范文件，按类固化，非随机生成）
    const RISK_CATEGORY_MEASURES = {
      '有限空间': '①进入有限空间作业前，必须申请办理好进出申请单。②进入前，先排风后检测。气体检测工作应实时进行。③有限空间设置专责监护人，有限空间监护应在有限空间外持续监护。④有限空间施工应打开井口，井口设专人看护，二级及以上环境，应进行强制通风。⑤井口围栏上应挂有限空间警示牌和信息牌。⑥如气体检测不合格，达到二级及以上环境指标时，作业人员必须马上撤出。⑦有限空间工作完毕撤出时应清点人数。⑧作业人员必须正确佩戴和使用劳动防护用品，与外部有可靠的通讯联络；监护人不得离开作业现场，并与作业人员保持联系。⑨使用鼓风机通风。⑩现场配备正压式呼吸机。⑪现场配备救生设备担架、软梯、三脚架各1付。',
      '机械伤害': '①投入使用的机械设备必须完好，安全防护措施齐全，机械设备有生产许可证、出厂合格证。②作业人员必须佩戴好劳动保护用品，严格按说明书及安全操作规程进行操作。',
      '起重伤害': '①工作负责人负责指定吊车停靠位置。②吊车停稳后放下两侧支脚，保持车身平稳，并铺好垫木，垫木长度不小于1.2m。③吊装过程中基坑内、吊件垂直下方、受力钢丝绳的内角侧严禁有人；除指挥人及指定人员外，其他人员应在离开箱变高度的1.2倍距离以外。④系好临时风绳控制箱变。⑤在起吊、牵引过程中，受力钢丝绳的周围、上下方、内角侧和起吊物的下面，严禁有人逗留和通过；吊运中不得从人员上方通过，吊臂下严禁站人；不准用手拉或跨越钢丝绳。',
      '触电': '分别在有可能送电到作业地点的各个线路端口验无电后装设相应电压等级的接地线；作业人员施工作业时不能超出接地线保护范围。',
      '高处坠落': '正确使用安全带，在杆上不能失去安全带、安全绳的保护，安全带、绳应高挂低用；工作人员上杆时安全带、后背保护绳交替使用，杆上工作时安全带和安全绳应分别挂在电杆不同部位的牢固构件上；上下杆过程中注意安全，全过程安全带保护，匀步上下杆，翻越横担或杆上构件过程中不得失去安全保护；工作人员应相互加强监护，随时提醒杆上工作人员注意安全。',
      '倒塔/坍塌': '登杆前检查杆根是否牢固，如杆根不牢固应采取可靠安全措施后再行登杆。',
      '跨越风险': '在跨越特殊地形、障碍物时，派驻专职安全员全程监护。',
      '物体打击': '使用合格的安全帽、安全带，正确佩戴安全帽、安全带；传递工具材料使用绳索，严禁抛扔；登杆前检查杆根是否牢固。',
      '动火作业': '制作专项施工方案，经审批后实施。'
    };
    // 按已选风险大类顺序，带出对应分类的规范化简写管控措施
    function genMeasures(factors) {
      const lines = [];
      let ci = 0;
      (factors || []).forEach(cat => {
        const m = RISK_CATEGORY_MEASURES[cat];
        if (!m) return;
        ci++;
        lines.push('(' + ci + ') ' + cat);
        lines.push(m);
      });
      return lines.join('\n');
    }
    const RISK_LEVELS = ['三级', '四级', '五级'];
    const GRID_RISKS = ['无', '一级', '二级', '三级'];
    const MAJOR_RISKS = ['无', '有'];
    const tab = ref('week');
    const list = ref([]);
    const loading = ref(false);
    const projects = ref([]); const projectsFull = ref([]); const workers = ref([]);
    const teams = ref([]);                              // 班组管理（施工班组）→ 作业班组下拉源
    const filters = reactive({ startDate: '', endDate: '', name: '', content: '', noProject: false, team: '', leader: '', ticketType: '', projectScope: [] });
    const page = ref(1); const pageSize = ref(20);
    const dlg = reactive({ visible: false, editingId: null, form: null, ticketNoDirty: false });
    const emptyForm = () => ({
      name: '', content: '', shadowContent: '', planType: '周计划',
      project: '', subProject: '', workType: '配农网工程',
      startDate: '', endDate: '', specialty: '运检', dept: '设备部',
      voltage: '10kV', ticketType: '配电：配电第一种工作票',
      address: '', station: '', machine: '是', riskLevel: '四级', controlMeasures: '',
      gridRisk: '无', riskFactors: [], majorRisk: '无',
      buildCity: '', buildCounty: '', execCity: '', execCounty: '',
      team: '', subcontractors: [], supervisor: '', ccUnits: [],
      staffText: '', teamLeader: '', staffCount: '', highStaff: '', gasTester: '', guardian: '',
      chargePerson: '', chargePersonPhone: '', arrivalPersons: '', safetyPatrol: '',
      wlPole: '', wlLine1035: '', wlCable: '', wlRing: '', wlVacuum: '', wlTransformer: '', wlLine04: '',
      outageRange: '', outageHours: '', surveyNo: '', workTicketNo: '',
      workUnit: '', chargePersons: [], staff: [],
      finishDate: '', planNote: '',
      teams: [], materials: [], status: '未执行'
    });

    function fmtDate(d) {
      const p = n => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }
    async function loadMeta() {
      try {
        const r = await api.get('/api/projects');
        const arr = Array.isArray(r) ? r : (r.data || []);
        projectsFull.value = arr;
        projects.value = arr.map(p => p.name || p.projectName).filter(Boolean);
      } catch (e) {}
      try {
        const r = await api.get('/api/teams');
        const arr = Array.isArray(r) ? r : (r.data || []);
        teams.value = arr.slice().sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)).map(t => t.name).filter(Boolean);
      } catch (e) {}
      try { const r = await api.get('/api/workers'); const arr = Array.isArray(r) ? r : (r.data || []); workersFull.value = arr; workers.value = arr.map(w => w.name).filter(Boolean); } catch (e) {}
      try { const r = await api.get('/api/contacts'); contacts.value = Array.isArray(r) ? r : (r.data || []); } catch (e) {}
      await loadHazards();
    }
    // 选中关联项目 → 自动读取项目信息回填（名称/作业类型/专业/部门/电压/作业地址/变电站线路）
    function onProjectSelect(name) {
      const p = projectsFull.value.find(x => (x.name || x.projectName) === name);
      if (!p) return;
      const f = dlg.form;
      if (f) {
        f.name = p.name || name;
        if (p.workType && WORK_TYPES.includes(p.workType)) f.workType = p.workType;
        if (p.specialty && SPECIALTIES.includes(p.specialty)) f.specialty = p.specialty;
        if (p.provincialDept && DEPTS.includes(p.provincialDept)) f.dept = p.provincialDept;
        if (p.voltage && VOLTAGE_LEVELS.includes(p.voltage)) f.voltage = p.voltage;
        const addrParts = [p.address, p.substation].filter(Boolean);
        const coords = (p.lng && p.lat) ? ('（' + p.lng + ',' + p.lat + '）') : '';
        if (addrParts.length || coords) f.address = addrParts.join('/') + coords;
        if (p.substation) f.station = p.substation;
        f.subProject = '';
      }
    }
    const subProjectOptions = computed(() => {
      const p = projectsFull.value.find(x => (x.name || x.projectName) === (dlg.form && dlg.form.project));
      return (p && Array.isArray(p.subProjects)) ? p.subProjects.map(s => s.name || s).filter(Boolean) : [];
    });
    async function load() {
      loading.value = true;
      try {
        const r = await api.get('/api/workPlans');
        const arr = Array.isArray(r) ? r : (r.data || []);
        arr.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        list.value = arr;
      } catch (e) { ElementPlus.ElMessage.error(e.message); } finally { loading.value = false; }
    }
    const tabList = computed(() => list.value.filter(p => {
      if (tab.value === 'week') return p.planType === '周计划' && !['已归档', '已取消', '已执行', '已结算'].includes(p.status);
      if (tab.value === 'month') return p.planType === '月计划' && !['已归档', '已取消', '已执行', '已结算'].includes(p.status);
      if (tab.value === 'archived') return p.planType === '月计划' && p.status === '已归档';
      if (tab.value === 'executed') return p.status === '已执行';
      if (tab.value === 'settled') return p.status === '已结算';
      if (tab.value === 'canceled') return p.planType === '周计划' && p.status === '已取消';
      return true;
    }));
    const filtered = computed(() => tabList.value.filter(p => {
      // 项目详情跳转带入的项目范围（项目名 + 其子项目名），精确匹配，不受关键词模糊匹配影响
      if (filters.projectScope.length && !filters.projectScope.includes(p.project)) return false;
      if (filters.startDate && p.startDate < filters.startDate) return false;
      if (filters.endDate && p.endDate > filters.endDate) return false;
      if (filters.name && !String(p.name || '').includes(filters.name)) return false;
      if (filters.content && !String(p.content || '').includes(filters.content)) return false;
      if (filters.noProject && p.project) return false;
      if (filters.team && p.team !== filters.team) return false;
      if (filters.leader && p.leader !== filters.leader) return false;
      if (filters.ticketType && p.ticketType !== filters.ticketType) return false;
      return true;
    }));
    const paged = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));
    // 日计划日历概览：未来 21 天内的有效计划（跨日计划按覆盖日期展示）
    const daySlice = v => String(v || '').slice(0, 10);
    const upcoming = computed(() => {
      const today = fmtDate(new Date());
      const end21 = fmtDate(new Date(Date.now() + 21 * 86400000));
      return list.value.filter(p => !['已取消', '已归档'].includes(p.status) && p.startDate && p.endDate && daySlice(p.endDate) >= today && daySlice(p.startDate) <= end21);
    });
    // 日历卡片：按有安排的日期展示（10月16日 周五 / 条数徽标 / 班组长 / 时间+计划名）
    const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const calendarDays = computed(() => {
      const days = [];
      for (let i = 0; i <= 21; i++) {
        const d = new Date(Date.now() + i * 86400000);
        const ds = fmtDate(d);
        const plans = upcoming.value.filter(p => daySlice(p.startDate) <= ds && daySlice(p.endDate) >= ds);
        if (plans.length) days.push({ ds, label: (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WEEK_CN[d.getDay()], plans });
      }
      return days;
    });
    // 表格展示：日期 MM-DD HH:mm，空值显示 -
    function fmtDT(v) { if (!v) return '-'; const s = String(v); return s.length > 10 ? s.slice(5, 16) : s.slice(5); }
    function dash(v) { const s = String(v == null ? '' : v).trim(); return s || '-'; }
    // 行高亮：覆盖今天且未取消/归档的计划（进行中）
    function rowClass({ row }) {
      const t = fmtDate(new Date());
      return (!['已取消', '已归档'].includes(row.status) && daySlice(row.startDate) <= t && daySlice(row.endDate) >= t) ? 'plan-ongoing' : '';
    }
    // 操作列：复制 / 执行 / 备注 / 取消
    async function copyPlan(row) {
      try {
        const body = JSON.parse(JSON.stringify(row));
        delete body.id; delete body.createdAt;
        delete body.teamSafetyMeasures;   // 周计划无此字段（历史误加已撤），复制也不带
        body.name = (row.name || '') + '（副本）'; body.status = '未执行';
        // 编号按规则重新生成，不连号复制：年月取复制当天，工作票走被复制记录那条类型线
        const ym = PlanNo.ymOf(new Date());
        body.surveyNo = PlanNo.nextSurveyNo(list.value, ym);
        body.workTicketNo = PlanNo.nextTicketNo(list.value, ym, body.ticketType);
        await api.post('/api/workPlans', body);
        ElementPlus.ElMessage.success('已复制为新计划'); load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function execPlan(row) {
      try {
        await ElementPlus.ElMessageBox.confirm('确认将该计划标记为已执行？', '提示', { type: 'warning' });
        await api.put('/api/workPlans/' + row.id, { status: '已执行' });
        ElementPlus.ElMessage.success('已执行'); load();
      } catch (e) { if (e !== 'cancel') ElementPlus.ElMessage.error(e.message || '已取消'); }
    }
    async function cancelPlan(row) {
      try {
        await ElementPlus.ElMessageBox.confirm('确认取消该计划？取消后可在「已取消周计划」中查看。', '提示', { type: 'warning' });
        await api.put('/api/workPlans/' + row.id, { status: '已取消' });
        ElementPlus.ElMessage.success('已取消'); load();
      } catch (e) { if (e !== 'cancel') ElementPlus.ElMessage.error(e.message || '已取消'); }
    }
    // 恢复：已取消的计划 → 状态回到「未执行」，重新出现在「周计划管理」
    async function restorePlan(row) {
      try {
        await ElementPlus.ElMessageBox.confirm('确认恢复作业计划「' + row.name + '」？恢复后将回到「周计划管理」。', '提示', { type: 'warning' });
        await api.put('/api/workPlans/' + row.id, { status: '未执行' });
        ElementPlus.ElMessage.success('已恢复，计划已回到周计划管理');
        load();
      } catch (e) { if (e !== 'cancel') ElementPlus.ElMessage.error(e.message || '已取消'); }
    }
    async function notePlan(row) {
      try {
        const { value } = await ElementPlus.ElMessageBox.prompt('请输入备注内容', '备注', { inputValue: row.planNote || '', inputType: 'textarea', inputPlaceholder: '选填' });
        await api.put('/api/workPlans/' + row.id, { planNote: value || '' });
        ElementPlus.ElMessage.success('备注已保存'); load();
      } catch (e) { if (e !== 'cancel') ElementPlus.ElMessage.error(e.message || '已取消'); }
    }
    // ---------- 施工资料弹窗（勘察记录 / 生成资料 / 图纸 / 压缩包均接真实接口） ----------
    const matDlg = reactive({
      visible: false,
      plan: null,
      zIndex: undefined          // 每次打开压到当前最上层弹窗之上（勘察编辑器叠开作业资料时也成立）
    });
    const matDrawingInput = ref(null);                                  // 图纸上传的隐藏 file 控件
    const matPackInput = ref(null);                                     // 压缩包上传的隐藏 file 控件
    // 图纸表直接绑当前计划的 drawings（老记录没有该字段按空数组）
    const matDrawings = computed(() => (matDlg.plan && Array.isArray(matDlg.plan.drawings)) ? matDlg.plan.drawings : []);
    // 生成资料表：现场勘察记录等（老记录没有 generatedFiles 按空数组）
    const matGenFiles = computed(() => (matDlg.plan && Array.isArray(matDlg.plan.generatedFiles)) ? matDlg.plan.generatedFiles : []);
    // 压缩包表：每个计划最多一条（老记录没有 materialPackage 字段按 null → 空态）
    const matPackage = computed(() => {
      const pk = matDlg.plan && matDlg.plan.materialPackage;
      return (pk && typeof pk === 'object' && !Array.isArray(pk)) ? [pk] : [];
    });
    // 重新拉取当前计划最新数据（survey + generatedFiles + drawings），弹窗与编辑器共用
    async function reloadMatPlan() {
      const id = matDlg.plan && matDlg.plan.id;
      if (!id) return null;
      try {
        const fresh = await api.get('/api/workPlans/' + id);
        if (fresh && matDlg.plan && matDlg.plan.id === id) {
          if (!Array.isArray(fresh.drawings)) fresh.drawings = [];
          if (!Array.isArray(fresh.generatedFiles)) fresh.generatedFiles = [];
          matDlg.plan = fresh;
        }
        return fresh;
      } catch (e) { return null; }
    }
    // 当前可见弹窗里最大的 z-index（EP 弹窗复用旧 z-index，叠开时须自己抬一层）
    function topOverlayZ() {
      let z = 2000;
      document.querySelectorAll('.el-overlay').forEach(el => {
        const v = parseInt(getComputedStyle(el).zIndex, 10);
        if (!Number.isNaN(v)) z = Math.max(z, v);
      });
      return z;
    }
    // 打开弹窗时以服务端最新数据为准，保证刚上传/刚生成完关掉重开能看到
    // raise=true 用于从勘察编辑器里叠开：把 z-index 抬到当前最上层弹窗之上（EP 会复用旧 z-index）
    async function openPlanMaterials(row, raise) {
      matDlg.plan = row || null;
      matDlg.zIndex = raise ? (topOverlayZ() + 2) : undefined;
      matDlg.visible = true;
      if (!row || !row.id) return;
      await reloadMatPlan();
    }
    // 占位：生成资料本期仍未接后端，统一走这里，不假装执行真实动作
    function matTodo() { ElementPlus.ElMessage.info('施工资料功能分项开发中'); }

    // ---- 图纸：上传 / 下载 / 删除（单文件、不限类型，服务端 upload 单文件上限 20MB） ----
    function triggerDrawingUpload() {
      if (!matDlg.plan || !matDlg.plan.id) return;
      if (matDrawingInput.value) { matDrawingInput.value.value = ''; matDrawingInput.value.click(); }
    }
    async function onDrawingUpload(ev) {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!file || !matDlg.plan) return;
      if (file.size > 20 * 1024 * 1024) { ElementPlus.ElMessage.error('文件过大，单个图纸不超过 20MB'); return; }
      const fd = new FormData();
      fd.append('file', file);
      try {
        const item = await api.upload('/api/workPlans/' + matDlg.plan.id + '/drawings', fd);
        if (!Array.isArray(matDlg.plan.drawings)) matDlg.plan.drawings = [];
        matDlg.plan.drawings.push(item);
        ElementPlus.ElMessage.success(file.name + ' 上传成功');
      } catch (e) {
        ElementPlus.ElMessage.error(e.message || '上传失败');
      }
    }
    // 创建时间：与文档中心文件表同一格式（YYYY-MM-DD HH:mm，本地时区）
    function matFmtTime(s) {
      if (!s) return '-';
      const d = new Date(s);
      if (isNaN(d)) return s;
      const p = n => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    async function matDownloadDrawing(f) {
      try {
        const r = await fetch('/api/workPlans/' + matDlg.plan.id + '/drawings/' + f.id + '/download', {
          headers: { Authorization: 'Bearer ' + localStorage.getItem('erp_token') }
        });
        if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || '下载失败'); }
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = f.name || '图纸';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } catch (e) { ElementPlus.ElMessage.error(e.message || '下载失败'); }
    }
    async function matDeleteDrawing(f) {
      try {
        await ElementPlus.ElMessageBox.confirm('确认删除图纸「' + f.name + '」？删除后文件不可恢复。', '删除图纸', { type: 'warning' });
      } catch (e) { return; }
      try {
        await api.del('/api/workPlans/' + matDlg.plan.id + '/drawings/' + f.id);
        matDlg.plan.drawings = (matDlg.plan.drawings || []).filter(x => x.id !== f.id);
        ElementPlus.ElMessage.success('已删除');
      } catch (e) { ElementPlus.ElMessage.error(e.message || '删除失败'); }
    }

    // ---- 资料压缩包：单包、上传即替换（ZIP/7z/RAR，≤1MB；替换失败旧包仍可用） ----
    const PACK_EXTS = ['zip', '7z', 'rar'];
    const PACK_MAX = 1024 * 1024;
    function triggerPackUpload() {
      if (!matDlg.plan || !matDlg.plan.id) return;
      if (matPackInput.value) { matPackInput.value.value = ''; matPackInput.value.click(); }
    }
    function packExtOf(name) {
      const n = String(name || '');
      const i = n.lastIndexOf('.');
      return i < 0 ? '' : n.slice(i + 1).toLowerCase();
    }
    async function onPackUpload(ev) {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!file || !matDlg.plan) return;
      // 前端先拦：格式与大小不合规一律不发请求
      if (!PACK_EXTS.includes(packExtOf(file.name))) {
        ElementPlus.ElMessage.error('仅支持 ZIP、7z、RAR 格式的压缩包');
        return;
      }
      if (file.size > PACK_MAX) { ElementPlus.ElMessage.error('压缩包大小不能超过 1MB'); return; }
      const had = !!(matDlg.plan.materialPackage && matDlg.plan.materialPackage.id);
      const fd = new FormData();
      fd.append('file', file);
      try {
        const item = await api.upload('/api/workPlans/' + matDlg.plan.id + '/package', fd);
        matDlg.plan.materialPackage = item;
        ElementPlus.ElMessage.success(had ? '已替换原压缩包' : '上传成功');
      } catch (e) {
        // 失败：服务端保证旧包与记录原样，这里也不动本地状态
        ElementPlus.ElMessage.error(e.message || '上传失败');
      }
    }
    async function matDownloadPackage(f) {
      try {
        const r = await fetch('/api/workPlans/' + matDlg.plan.id + '/package/download', {
          headers: { Authorization: 'Bearer ' + localStorage.getItem('erp_token') }
        });
        if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || '下载失败'); }
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = f.name || '资料压缩包';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } catch (e) { ElementPlus.ElMessage.error(e.message || '下载失败'); }
    }
    async function matDeletePackage(f) {
      try {
        await ElementPlus.ElMessageBox.confirm('确认删除压缩包「' + f.name + '」？删除后文件不可恢复。', '删除压缩包', { type: 'warning' });
      } catch (e) { return; }
      try {
        await api.del('/api/workPlans/' + matDlg.plan.id + '/package');
        matDlg.plan.materialPackage = null;
        ElementPlus.ElMessage.success('已删除');
      } catch (e) { ElementPlus.ElMessage.error(e.message || '删除失败'); }
    }
    // ---- 生成资料：下载 / 删除（现场勘察记录 docx；每次生成新增一条，不覆盖旧的） ----
    async function matDownloadGen(f) {
      try {
        const r = await fetch('/api/workPlans/' + matDlg.plan.id + '/generated/' + f.id + '/download', {
          headers: { Authorization: 'Bearer ' + localStorage.getItem('erp_token') }
        });
        if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || '下载失败'); }
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = f.name || '生成资料';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } catch (e) { ElementPlus.ElMessage.error(e.message || '下载失败'); }
    }
    async function matDeleteGen(f) {
      try {
        await ElementPlus.ElMessageBox.confirm('确认删除生成资料「' + f.name + '」？删除后文件不可恢复。', '删除生成资料', { type: 'warning' });
      } catch (e) { return; }
      try {
        await api.del('/api/workPlans/' + matDlg.plan.id + '/generated/' + f.id);
        if (Array.isArray(matDlg.plan.generatedFiles)) {
          matDlg.plan.generatedFiles = matDlg.plan.generatedFiles.filter(x => x.id !== f.id);
        }
        ElementPlus.ElMessage.success('已删除');
      } catch (e) { ElementPlus.ElMessage.error(e.message || '删除失败'); }
    }
    // ---- 现场勘察记录：四期第一步（作业分组 + 勘察单位/部门/编号/双重名称 + 3.工作任务 + 4.1 + 4.2） ----
    // ---- 四期第二步：4.3 环境描述 + 危险点条目组（envDesc / hazardPoints） ----
    // ---- 四期第三步：4.4 两组措施 + 10kV/0.4kV 接地线 + 勘察日期（含逐行归属） ----
    const SURVEY_GROUPING_OPTS = ['不分小组', '分2个小组', '分3个小组'];
    // 4.3 预置的 7 条标准危险点（按参考系统顺序；逐条按标题精确匹配危险点库，未命中跳过、不编造）
    const SURVEY_STD_HAZARDS = [
      '高空坠落风险', '倒杆伤害风险', '物体打击风险', '超出作业范围误登杆风险',
      '工器具是否合格风险', '触电伤害风险', '施工区域外来人员进入风险'
    ];
    const SURVEY_HP_SCOPE_ALL = '全组';
    const surveyDlg = reactive({
      visible: false, form: null, seed: null,
      saving: false, generating: false, errId: '',
      snapshot: '',                         // 打开（或保存成功）时的表单模型快照，用于判定「未保存」
      banner: { type: '', text: '' }        // 顶部横幅：ok=在线编辑内容已保存 / info=已加载已保存的在线勘察记录
    });
    const SV_BANNER_LOADED = '已加载已保存的在线勘察记录；危险点库更新不会自动覆盖已保存措施。';
    const SV_BANNER_SAVED = '在线编辑内容已保存';
    const SV_BANNER_GENERATED = '已生成「现场勘察记录.docx」；继续修改后再次点「保存并生成」会覆盖更新同一份，不会新增勘察单。';
    const SV_BANNER_UPDATED = '已更新「现场勘察记录.docx」（覆盖同一份，未新增勘察单）。';
    // 编辑器标题：现场勘察记录在线编辑（结构化槽位） - {关联项目名}
    const surveyTitle = computed(() => {
      const p = matDlg.plan || {};
      const proj = String(p.project || '').trim();
      const sub = String(p.subProject || '').trim();
      const name = proj && sub ? proj + ' / ' + sub : (proj || sub);
      return '现场勘察记录在线编辑（结构化槽位）' + (name ? ' - ' + name : '');
    });
    const hazardPick = ref('');
    const hpOpen = reactive({});           // 危险点卡展开状态（key = 条目 id；默认全部折叠，不落库）
    function toggleHp(hp) { if (hp) hpOpen[hp.id] = !hpOpen[hp.id]; }
    function openHp(hp) { if (hp) hpOpen[hp.id] = true; }
    const matSurveyed = computed(() => !!(matDlg.plan && matDlg.plan.survey && typeof matDlg.plan.survey === 'object' && !Array.isArray(matDlg.plan.survey)));
    // 生成资料空态：未勘察 / 已勘察未生成 两种文案
    const matGenEmpty = computed(() => matSurveyed.value
      ? '暂无生成资料，在勘察记录中点「保存并生成」即可生成'
      : '完成现场勘察后，可生成工作票资料');
    // 危险点库按分类分组（下拉用；库本体来自 /api/documents，与文档中心同一数据通道）
    const hazardGroups = computed(() => {
      const map = new Map();
      hazardLibrary.value.forEach(h => {
        const c = h.category || '未分类';
        if (!map.has(c)) map.set(c, []);
        map.get(c).push(h);
      });
      return [...map.entries()].map(([label, items]) => ({ label, items }));
    });
    function newHpId() { return 'hp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
    function todayYmd() {
      const d = new Date(); const p = n => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }
    function scrollHp(id) {
      const el = document.getElementById('hp-' + id);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
    }
    // 来源值（seed）= 徽标比对的基准；只有「首次创建」才把这组值真正填进表单。
    //   A 类·抄周计划字段：部门（班组）=plan.team｜编号=部门+plan.surveyNo（存完整编号）
    //                     ｜3.工作任务=plan.content｜4.1=plan.outageRange
    //   B 类·模板侧标准内容/规则算出：4.3 环境描述=模板标准文案｜4.4 班组措施=模板标准文案
    //                     ｜勘察日期=plan.startDate 前 10 位（取不到则不作为来源）
    //   C 类·不带入（现场勘察时才定）：勘察单位、勘察设备双重名称、4.2 保留的带电部位、4.4 运维措施、接地线
    const SV_ENV_DESC_DEFAULT = '工作环境：本次施工作业在乡村，现场车流量较小，人流量较少。';
    // 4.4 班组应采取的安全措施：取自勘察单模板侧标准内容（整行一条；分组时默认归属「全组」）。
    // 与周计划无关——周计划没有对应字段，不得从任何计划字段取值。
    const SV_TEAM_MEASURES_DEFAULT = '所有下户表计负荷侧空开出线，分别用绝缘胶布将线头包裹严实，并悬挂“禁止合闸，线路有人工作”标识牌一块。';
    function surveySeed(plan) {
      const p = plan || {};
      const s = v => String(v == null ? '' : v).trim();
      const team = s(p.team);
      let no = s(p.surveyNo);
      // 编号：编辑器里存的就是拼好的完整编号（部门+编号）；已带部门前缀不重复拼，部门为空则裸号
      if (team && no && no.indexOf(team) !== 0) no = team + no;
      const day = s(p.startDate).slice(0, 10);
      return {
        team: team,
        surveyNo: no,
        // 4.3 环境描述：首个默认文案只在「首次创建」时带入（见 openSurveyEditor），可改可清空
        envDesc: SV_ENV_DESC_DEFAULT,
        workTask: s(p.content),
        outageScope: s(p.outageRange),
        // 4.4 班组措施：模板侧标准文案（周计划无此字段，不从计划取值）
        teamMeasures: SV_TEAM_MEASURES_DEFAULT,
        surveyDate: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : ''
      };
    }
    // 小组人员选项：作业人员名单（GET /api/workers，即「用户管理-作业人员名单」那套数据），排除状态「待定」
    const surveyPeople = computed(() => workersFull.value.filter(w => w.name && w.status !== '待定'));
    // 勘察单位下拉选项：汇总系统内已出现的单位值 —— 周计划「作业建管单位（市/县）」
    // 「作业实施单位（市/县）」+ 已保存 survey 的 surveyUnit，去重排序；支持自定义输入，
    // 存量值即使不在选项里也能正常回显（当前值一并并入选项）。
    const svUnitOpts = computed(() => {
      const set = new Set();
      const push = v => { const s = String(v == null ? '' : v).trim(); if (s) set.add(s); };
      (list.value || []).forEach(p => {
        push(p.buildCity); push(p.buildCounty); push(p.execCity); push(p.execCounty);
        if (p.survey && typeof p.survey === 'object') push(p.survey.surveyUnit);
      });
      if (surveyDlg.form) push(surveyDlg.form.surveyUnit);
      return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
    });
    const svGroupCount = computed(() => {
      const g = surveyDlg.form && surveyDlg.form.grouping;
      return g === '分2个小组' ? 2 : g === '分3个小组' ? 3 : 0;
    });
    const svGrouped = computed(() => svGroupCount.value > 0);
    // 危险点归属选项：不分小组只有「全组」；分 N 组时额外给出 1..N 小组
    const hpScopeOpts = computed(() => {
      const n = svGroupCount.value;
      const arr = [SURVEY_HP_SCOPE_ALL];
      for (let i = 1; i <= n; i++) arr.push(i + '小组');
      return arr;
    });
    // 归属取值：只认「全组 / 1小组 / 2小组 / 3小组」，其余回落「全组」
    function hpScopeOf(v) {
      const s = String(v == null ? '' : v).trim();
      return ['全组', '1小组', '2小组', '3小组'].indexOf(s) > -1 ? s : SURVEY_HP_SCOPE_ALL;
    }
    // ---- 逐行归属（4.4 班组措施 / 10kV / 0.4kV 接地线）：文本非空行 ↔ scopes 按序对齐 ----
    const SX_SCOPE_FIELDS = [
      { text: 'teamMeasures', sc: 'teamMeasureScopes' },
      { text: 'ground10', sc: 'ground10Scopes' },
      { text: 'ground04', sc: 'ground04Scopes' }
    ];
    const sxPrev = {};   // 每个文本字段上一次的非空行快照（用于识别「删掉的是哪一行」）
    function sxLines(v) {
      return String(v == null ? '' : v).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    }
    // 最长公共子序列：返回 { 新行下标: 旧行下标 }，用来把未改动行的归属原地保留
    function lcsPairs(a, b) {
      const n = a.length, m = b.length;
      const dp = [];
      for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
      const out = {}; let i = 0, j = 0;
      while (i < n && j < m) {
        if (a[i] === b[j]) { out[j] = i; i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
        else j++;
      }
      return out;
    }
    // 按当前文本行重算 scopes：内容未变的行保留原归属；原地改字的行按顺序配对保留；
    // 新增行补「全组」；被删掉的行其归属随之移除（后续行前移）
    function applyScopeAlign(textKey, scKey, lines) {
      const f = surveyDlg.form; if (!f) return;
      const oldLines = Array.isArray(sxPrev[textKey]) ? sxPrev[textKey] : [];
      const oldScopes = Array.isArray(f[scKey]) ? f[scKey].slice() : [];
      const map = lcsPairs(oldLines, lines);
      const usedOld = {}; Object.keys(map).forEach(k => { usedOld[map[k]] = true; });
      const freeNew = lines.map((_, i) => i).filter(i => map[i] === undefined);
      const freeOld = oldLines.map((_, i) => i).filter(i => !usedOld[i]);
      freeNew.forEach((ni, k) => { if (k < freeOld.length) map[ni] = freeOld[k]; });
      f[scKey] = lines.map((_, i) => (map[i] === undefined ? SURVEY_HP_SCOPE_ALL : hpScopeOf(oldScopes[map[i]])));
      sxPrev[textKey] = lines.slice();
    }
    // 文本框输入：用事件值算行（不依赖 v-model 更新时序）
    function onScopeTextInput(textKey, scKey, v) {
      const f = surveyDlg.form; if (!f) return;
      const val = (v === undefined || v === null) ? f[textKey] : v;
      if (!svGrouped.value) { sxPrev[textKey] = sxLines(val); return; }
      applyScopeAlign(textKey, scKey, sxLines(val));
    }
    // 打开编辑器 / 切换分组后：把 scopes 补齐到当前行数（缺的补「全组」），并重置行快照
    function padScopes() {
      const f = surveyDlg.form; if (!f) return;
      SX_SCOPE_FIELDS.forEach(({ text, sc }) => {
        const lines = sxLines(f[text]);
        const arr = Array.isArray(f[sc]) ? f[sc] : [];
        const out = [];
        for (let i = 0; i < lines.length; i++) out.push(hpScopeOf(arr[i]));
        f[sc] = out;
        sxPrev[text] = lines;
      });
    }
    // 首次创建时预置标准危险点：标题精确匹配库记录（hazard 字段），命中即取库 id/标题/措施
    const hpSeedStat = { hits: 0, miss: [] };
    function seedHazardPoints() {
      const out = [];
      hpSeedStat.hits = 0; hpSeedStat.miss = [];
      SURVEY_STD_HAZARDS.forEach(t => {
        const h = hazardLibrary.value.find(x => String(x.hazard == null ? '' : x.hazard).trim() === t);
        if (!h) { hpSeedStat.miss.push(t); return; }
        hpSeedStat.hits++;
        out.push({
          id: newHpId(), hazardId: h.id, title: h.hazard,
          situation: '', measure: h.measure || '', scope: SURVEY_HP_SCOPE_ALL
        });
      });
      return out;
    }
    async function ensureHazards() { if (!hazardLibrary.value.length) await loadHazards(); }
    // 补齐小组数组到当前分组数；分组数变小时不截断（第三组数据留在数组里，界面不显示、保存原样带回）
    function padGroups(n) {
      const f = surveyDlg.form; if (!f) return;
      if (!Array.isArray(f.groups)) f.groups = [];
      while (f.groups.length < n) f.groups.push({ leader: '', members: [], workLocation: '', workTask: '' });
    }
    function onGroupingChange() { padGroups(svGroupCount.value); padScopes(); }
    function svMembersText(g) { return '已选 ' + ((g && Array.isArray(g.members)) ? g.members.length : 0) + ' 人'; }
    // ---------- 小组人员选择器：小组长（技工单选）/ 本组人员（按身份分组多选）共用一套弹窗 ----------
    // 取代原先挤在小组卡首行的两个下拉：小组长只列技工、本组人员按「技工 / 民工」分组勾选，
    // 本组小组长固定勾选且不可取消，已被其它小组占用的人员置灰并标注归属组，避免重复选派。
    const svPick = reactive({ visible: false, mode: 'members', gi: 0, draft: [], leader: '', q: '' });
    // 身份归并：真实数据里身份是「技工（计入高处作业人员）」，界面只显示「技工」；未命中归到「其他」
    function svIdentityGroup(w) {
      const id = String((w && w.identity) || '').trim();
      if (!id) return '其他';
      if (id.indexOf('技工') > -1) return '技工';
      if (id.indexOf('民工') > -1) return '民工';
      return id;
    }
    // 人员清单：按姓名去重（groups.members 存的就是姓名），技工在前、民工在后，其余按原顺序排在最后
    const svPeopleList = computed(() => {
      const seen = {}; const out = [];
      surveyPeople.value.forEach(w => {
        const name = String(w.name || '').trim();
        if (!name || seen[name]) return;
        seen[name] = 1;
        out.push({ name, group: svIdentityGroup(w), team: String(w.team || '').trim() });
      });
      const rank = g => (g === '技工' ? 0 : g === '民工' ? 1 : 2);
      return out.map((p, i) => ({ p, i })).sort((a, b) => (rank(a.p.group) - rank(b.p.group)) || (a.i - b.i)).map(x => x.p);
    });
    // 名单里只有一个班组时，不必在每一格重复班组名
    const svMultiTeam = computed(() => {
      const set = {};
      svPeopleList.value.forEach(p => { if (p.team) set[p.team] = 1; });
      return Object.keys(set).length > 1;
    });
    const svPickTitle = computed(() => (svPick.gi + 1) + '小组 · ' + (svPick.mode === 'leader' ? '选择小组长' : '选择本组人员'));
    // 占用表：除当前小组外，其他小组的组长/组员都不可再选，标注归属组
    const svPickRows = computed(() => {
      const f = surveyDlg.form;
      if (!f || !Array.isArray(f.groups)) return [];
      const gi = svPick.gi; const g = f.groups[gi] || {};
      const taken = {};
      f.groups.forEach((x, i) => {
        if (i === gi || !x) return;
        const lab = (i + 1) + '小组';
        if (x.leader && !taken[x.leader]) taken[x.leader] = lab + '组长';
        (Array.isArray(x.members) ? x.members : []).forEach(n => { if (n && !taken[n]) taken[n] = lab; });
      });
      const q = String(svPick.q || '').trim().toLowerCase();
      const leader = String(g.leader || '');
      const base = svPick.mode === 'leader' ? svPeopleList.value.filter(p => p.group === '技工') : svPeopleList.value;
      return base
        .filter(p => !q || p.name.toLowerCase().indexOf(q) > -1 || p.team.toLowerCase().indexOf(q) > -1)
        .map(p => {
          const isLeader = !!leader && p.name === leader;
          const locked = isLeader && svPick.mode === 'members';   // 本组小组长：固定勾选、不可取消
          const on = svPick.mode === 'leader' ? (p.name === svPick.leader) : (locked || svPick.draft.indexOf(p.name) > -1);
          return { name: p.name, group: p.group, team: p.team, on, isLeader, takenBy: taken[p.name] || '', locked, disabled: locked || !!taken[p.name] };
        });
    });
    const svPickGroups = computed(() => {
      const map = {}; const order = [];
      svPickRows.value.forEach(r => { if (!map[r.group]) { map[r.group] = []; order.push(r.group); } map[r.group].push(r); });
      return order.map(name => ({ name, rows: map[name] }));
    });
    const svPickAvail = computed(() => svPickRows.value.filter(r => !r.disabled && !r.isLeader));
    const svPickAllOn = computed(() => svPickAvail.value.length > 0 && svPickAvail.value.every(r => r.on));
    const svPickSomeOn = computed(() => !svPickAllOn.value && svPickAvail.value.some(r => r.on));
    function svOpenLeader(gi) {
      const f = surveyDlg.form; if (!f) return;
      const g = f.groups[gi] || {};
      svPick.gi = gi; svPick.mode = 'leader'; svPick.q = '';
      svPick.leader = g.leader || ''; svPick.draft = [];
      svPick.visible = true;
    }
    function svOpenMembers(gi) {
      const f = surveyDlg.form; if (!f) return;
      const g = f.groups[gi] || {};
      svPick.gi = gi; svPick.mode = 'members'; svPick.q = '';
      svPick.leader = '';
      // 旧记录里组长可能同时出现在 members 里：打开时先剔掉，避免同一人算两次
      svPick.draft = (Array.isArray(g.members) ? g.members : []).filter(n => n && n !== g.leader);
      svPick.visible = true;
    }
    function svToggleRow(r) {
      if (r.disabled) return;
      if (svPick.mode === 'leader') { svPick.leader = r.name; return; }
      const i = svPick.draft.indexOf(r.name);
      if (i > -1) svPick.draft.splice(i, 1); else svPick.draft.push(r.name);
    }
    function svToggleAll(v) {
      const names = svPickAvail.value.map(r => r.name);
      if (!v) { svPick.draft = svPick.draft.filter(n => names.indexOf(n) === -1); return; }
      names.forEach(n => { if (svPick.draft.indexOf(n) === -1) svPick.draft.push(n); });
    }
    function svConfirmPick() {
      const f = surveyDlg.form; if (!f) return;
      if (!Array.isArray(f.groups)) f.groups = [];
      const gi = svPick.gi;
      if (!f.groups[gi]) f.groups[gi] = { leader: '', members: [], workLocation: '', workTask: '' };
      const g = f.groups[gi];
      if (svPick.mode === 'leader') {
        g.leader = svPick.leader || '';
        // 同一人只占一个位置：升为组长后从本组人员里移除
        g.members = (Array.isArray(g.members) ? g.members : []).filter(n => n && n !== g.leader);
      } else {
        g.members = svPick.draft.filter(n => n && n !== g.leader);
      }
      svPick.visible = false;
    }
    function svRemoveMember(gi, name) {
      const f = surveyDlg.form; const g = f && Array.isArray(f.groups) ? f.groups[gi] : null;
      if (!g || !Array.isArray(g.members)) return;
      g.members = g.members.filter(n => n !== name);
    }
    // 徽标：只表达「该字段当前值的来源」，实时按「当前值 vs 来源值」比对计算，不落库。
    //   四种文案（仅这四种）：周计划自动带入 / 规则自动带入 / 人工填写 / 待填写
    //   判定：当前值非空且 === 来源值 → 该来源对应的自动带入（A 类→周计划自动带入，B 类→规则自动带入）
    //         当前值非空但 ≠ 来源值（含本无来源）→ 人工填写
    //         当前值为空 → 来源有值（被人工清掉）= 人工填写；来源也为空 = 待填写
    //   来源值（seed）在打开时按计划/规则算一次，保存动作不改它 → 保存前后、重开前后徽标一致
    //   作业分组是模板外的纯控制项，不挂任何徽标；小组卡内字段同样不挂
    const SV_SEED_FIELDS = ['team', 'surveyNo', 'workTask', 'outageScope', 'surveyDate', 'teamMeasures', 'envDesc'];
    // B 类（固定文案 / 规则算出）→「规则自动带入」；其余带入字段是 A 类（抄周计划字段）→「周计划自动带入」
    const SV_RULE_FIELDS = ['envDesc', 'surveyDate', 'teamMeasures'];
    const SV_BADGE_FIELDS = [
      'surveyUnit', 'team', 'surveyNo', 'dualName', 'workTask', 'outageScope', 'retainedLive',
      'envDesc', 'opsMeasures', 'teamMeasures', 'ground10', 'ground04', 'surveyDate'
    ];
    const svBadges = computed(() => {
      const f = surveyDlg.form; const seed = surveyDlg.seed || {};
      if (!f) return {};
      const str = v => (v == null ? '' : String(v)).trim();
      const out = {};
      SV_BADGE_FIELDS.forEach(k => {
        const cur = str(f[k]);
        const src = SV_SEED_FIELDS.indexOf(k) > -1 ? str(seed[k]) : '';
        if (cur && src && cur === src) {
          out[k] = { text: SV_RULE_FIELDS.indexOf(k) > -1 ? '规则自动带入' : '周计划自动带入', cls: 'auto' };
        } else if (cur || src) {
          out[k] = { text: '人工填写', cls: 'manual' };
        } else {
          out[k] = { text: '待填写', cls: 'todo' };
        }
      });
      return out;
    });
    // 打开编辑器：带入只发生在「首次创建」；已保存的 survey 一律原样加载（不重新带入、不补默认、不覆盖）。
    // 来源值 seed 始终按计划/规则算一次，只用于徽标比对，不因「已保存」而清零。
    async function openSurveyEditor() {
      const plan = matDlg.plan;
      if (!plan || !plan.id) return;
      // 来源值 = 计划字段原样搬运（部门/完整编号/3.工作任务/4.1/勘察日期）+ 规则默认文案（4.3/4.4）
      // 不带入（现场勘察时才定）：勘察单位、勘察设备双重名称、4.2 保留的带电部位。
      const saved = (plan.survey && typeof plan.survey === 'object' && !Array.isArray(plan.survey)) ? plan.survey : null;
      const str = v => (v == null ? '' : String(v)).trim();
      const seed = surveySeed(plan);
      surveyDlg.seed = seed;
      // 旧数据兼容：4a 阶段 survey 里 workLocation（工作地点）与 workTask（工作内容）是两个分开的框，
      // 本批起合并为一个「3.工作任务」框 —— 打开时按「工作地点 + 换行 + 工作内容」拼接显示，
      // 保存时只落 workTask、并把 workLocation 置空（一次性并入，重开不再重复拼接）。
      const savedLoc = saved ? str(saved.workLocation) : '';
      const savedTask = saved ? str(saved.workTask) : '';
      const mergedTask = savedLoc
        ? (savedTask ? savedLoc + '\n' + savedTask : savedLoc)
        : savedTask;   // 已保存原样，不回落计划内容（带入只发生在首次创建）
      if (saved) {
        surveyDlg.form = {
          grouping: SURVEY_GROUPING_OPTS.indexOf(saved.grouping) > -1 ? saved.grouping : '不分小组',
          // 已保存一律原样：勘察单位 / 部门 / 编号 / 双重名称，没有就是空，不回落计划值
          surveyUnit: str(saved.surveyUnit), team: str(saved.team), surveyNo: str(saved.surveyNo),
          dualName: str(saved.dualName),
          workLocation: '', workTask: mergedTask,
          outageScope: str(saved.outageScope), retainedLive: str(saved.retainedLive),
          groups: (Array.isArray(saved.groups) ? saved.groups : []).map(g => ({
            leader: g.leader || '',
            members: Array.isArray(g.members) ? g.members.slice() : [],
            workLocation: g.workLocation || '', workTask: g.workTask || ''
          })),
          // 4.3 / 4.4：已保存内容一律原样加载，不补默认、不覆盖
          envDesc: str(saved.envDesc),
          opsMeasures: str(saved.opsMeasures),
          teamMeasures: str(saved.teamMeasures),
          ground10: str(saved.ground10), ground04: str(saved.ground04),
          teamMeasureScopes: Array.isArray(saved.teamMeasureScopes) ? saved.teamMeasureScopes.slice() : [],
          ground10Scopes: Array.isArray(saved.ground10Scopes) ? saved.ground10Scopes.slice() : [],
          ground04Scopes: Array.isArray(saved.ground04Scopes) ? saved.ground04Scopes.slice() : [],
          // 勘察日期：已保存原样（空就是空，不回落今天——「今天」只用于首次创建）
          surveyDate: str(saved.surveyDate),
          hazardPoints: (Array.isArray(saved.hazardPoints) ? saved.hazardPoints : []).map(h => ({
            id: h.id || newHpId(),
            hazardId: h.hazardId || '',
            title: h.title || '',
            situation: h.situation || '',
            measure: h.measure || '',
            scope: hpScopeOf(h.scope)
          }))
        };
      } else {
        await ensureHazards();   // 预置标准危险点依赖危险点库，未加载先取一次
        surveyDlg.form = {
          grouping: '不分小组',
          surveyUnit: '', team: seed.team, surveyNo: seed.surveyNo, dualName: '',
          workLocation: '', workTask: seed.workTask,
          outageScope: seed.outageScope, retainedLive: '', groups: [],
          envDesc: seed.envDesc, opsMeasures: '', teamMeasures: seed.teamMeasures, ground10: '', ground04: '',
          teamMeasureScopes: [], ground10Scopes: [], ground04Scopes: [],
          surveyDate: seed.surveyDate || todayYmd(), hazardPoints: seedHazardPoints()
        };
      }
      Object.keys(hpOpen).forEach(k => { delete hpOpen[k]; });   // 每次打开一律折叠
      padGroups(svGroupCount.value);
      padScopes();
      surveyDlg.errId = '';
      hazardPick.value = '';
      surveyDlg.generating = false;
      // 已保存过的才提示「已加载已保存的在线勘察记录」
      surveyDlg.banner = saved ? { type: 'info', text: SV_BANNER_LOADED } : { type: '', text: '' };
      surveyDlg.snapshot = svFormJson();   // 打开即拍快照：带入的种子/已存原值都不算脏
      surveyDlg.visible = true;
    }
    // ---------- 未保存保护：打开/保存成功时对表单模型拍快照，当前模型与之不一致即为脏 ----------
    // 比对的是整份表单（作业分组、单位/部门/编号/双重名称、工作任务与小组卡、4.1、4.2、
    // 环境描述、危险点条目、4.4 两措施与逐行归属、两组接地线与逐行归属、勘察日期）
    function svFormJson() { return surveyDlg.form ? JSON.stringify(surveyDlg.form) : ''; }
    function svIsDirty() { return !!surveyDlg.form && svFormJson() !== surveyDlg.snapshot; }
    // 关闭拦截：右上角 X / ESC / 点击遮罩三条路径统一走这里；干净直接关，脏才弹提醒
    function onSurveyBeforeClose(done) {
      if (!svIsDirty()) { done(); return; }
      ElementPlus.ElMessageBox.confirm(
        '关闭后，本次未保存的修改将丢失。是否仍要关闭？',
        '尚有未保存的勘察内容',
        {
          confirmButtonText: '放弃修改并关闭',
          cancelButtonText: '继续编辑',
          type: 'warning',
          confirmButtonClass: 'el-button--danger'
        }
      ).then(() => { done(); }).catch(() => { /* 继续编辑：什么都不做，内容原样保留 */ });
    }
    function addHazardFromLib() {
      const h = hazardLibrary.value.find(x => x.id === hazardPick.value) || null;
      hazardPick.value = '';
      if (!h || !surveyDlg.form) return;
      const hp = { id: newHpId(), hazardId: h.id, title: h.hazard || '', situation: '', measure: h.measure || '', scope: SURVEY_HP_SCOPE_ALL };
      surveyDlg.form.hazardPoints.push(hp);
      Vue.nextTick(() => scrollHp(hp.id));
    }
    // 标题弹窗（自定义条目用）：返回去空白的标题，取消/空值返回 ''
    function promptHazardTitle(hp, isNew) {
      return ElementPlus.ElMessageBox.prompt(
        isNew ? '请填写自定义危险点的标题' : '修改自定义危险点的标题',
        isNew ? '新增自定义危险点' : '修改危险点标题',
        {
          confirmButtonText: '确定', cancelButtonText: '取消',
          inputValue: hp ? (hp.title || '') : '',
          inputPlaceholder: '请输入危险点标题',
          inputValidator: v => (!!(v && String(v).trim()) || '标题不能为空')
        }
      ).then(({ value }) => String(value).trim()).catch(() => '');
    }
    // 标题只在卡头显示：库条目锁定不可改，自定义条目点标题可再次改名
    // 库条目标题点击不拦截冒泡 → 沿用卡头的展开/收起
    function onTitleClick(hp, e) {
      if (!hp || hp.hazardId) return;
      if (e && e.stopPropagation) e.stopPropagation();
      renameHazard(hp);
    }
    async function renameHazard(hp) {
      if (!hp || hp.hazardId) return;
      const t = await promptHazardTitle(hp, false);
      if (!t || t === hp.title) return;
      hp.title = t;
      surveyDlg.errId = '';
    }
    async function addCustomHazard() {
      if (!surveyDlg.form) return;
      const title = await promptHazardTitle(null, true);
      if (!title) return;
      const hp = { id: newHpId(), hazardId: '', title, situation: '', measure: '', scope: SURVEY_HP_SCOPE_ALL };
      surveyDlg.form.hazardPoints.push(hp);
      openHp(hp);                                    // 新条目自动展开，便于填措施
      Vue.nextTick(() => scrollHp(hp.id));
    }
    function libHazard(hp) { return (hp && hp.hazardId) ? (hazardLibrary.value.find(x => x.id === hp.hazardId) || null) : null; }
    // 恢复标准措施：仅当来自危险点库、且库里措施与当前不同时可用
    function canRestoreMeasure(hp) {
      const lib = libHazard(hp);
      return !!(lib && String(lib.measure || '') !== String(hp.measure || ''));
    }
    function restoreMeasure(hp) {
      const lib = libHazard(hp);
      if (!lib) return;
      hp.measure = lib.measure || '';
    }
    function moveHazard(hp, dir) {
      const arr = surveyDlg.form && surveyDlg.form.hazardPoints;
      if (!arr) return;
      const i = arr.indexOf(hp); const j = i + dir;
      if (i < 0 || j < 0 || j >= arr.length) return;
      arr.splice(j, 0, arr.splice(i, 1)[0]);
    }
    function removeHazard(hp) {
      const arr = surveyDlg.form && surveyDlg.form.hazardPoints;
      if (!arr) return;
      const i = arr.indexOf(hp);
      if (i > -1) arr.splice(i, 1);
    }
    // 校验 + PUT（「保存在线编辑内容」与「保存并生成」共用；成功返回 true 并给绿色横幅）
    async function putSurvey() {
      const plan = matDlg.plan; const f = surveyDlg.form;
      if (!plan || !plan.id || !f || surveyDlg.saving) return false;
      // 4.3 危险点校验：标题与措施必填；拦下后展开并定位到第一条有问题的卡片
      const hpArr = f.hazardPoints || [];
      for (let i = 0; i < hpArr.length; i++) {
        const t = String(hpArr[i].title || '').trim();
        const m = String(hpArr[i].measure || '').trim();
        if (!t || !m) {
          surveyDlg.errId = hpArr[i].id;
          openHp(hpArr[i]);
          Vue.nextTick(() => scrollHp(hpArr[i].id));
          ElementPlus.ElMessage.error('第 ' + (i + 1) + ' 条危险点' + (!t ? '缺少标题' : '「' + t + '」缺少对应安全措施'));
          return false;
        }
      }
      surveyDlg.errId = '';
      // 逐行归属按最终文本行数对齐（多出的行补「全组」，行被删则归属随之移除）
      padScopes();
      const body = {
        grouping: f.grouping || '不分小组',
        surveyUnit: f.surveyUnit || '', team: f.team || '', surveyNo: f.surveyNo || '',
        dualName: f.dualName || '',
        // 3.工作任务已合并为一个框（workTask）：workLocation 一律置空，避免旧数据重复拼接
        workLocation: '', workTask: f.workTask || '',
        outageScope: f.outageScope || '', retainedLive: f.retainedLive || '',
        groups: (f.groups || []).map(g => ({
          leader: g.leader || '',
          members: Array.isArray(g.members) ? g.members.slice() : [],
          workLocation: g.workLocation || '', workTask: g.workTask || ''
        })),
        // 4.3：环境描述 + 危险点条目组（只存原始条目，4.4 组装结果生成时再算）
        envDesc: f.envDesc || '',
        hazardPoints: hpArr.map(h => ({
          id: h.id, hazardId: h.hazardId || '', title: h.title || '',
          situation: h.situation || '', measure: h.measure || '', scope: hpScopeOf(h.scope)
        })),
        // 4.4 / 接地线 / 勘察日期（commonMeasures、recorder 不做编辑字段，不提交 → 服务端保留旧值）
        opsMeasures: f.opsMeasures || '', teamMeasures: f.teamMeasures || '',
        ground10: f.ground10 || '', ground04: f.ground04 || '',
        teamMeasureScopes: Array.isArray(f.teamMeasureScopes) ? f.teamMeasureScopes.slice() : [],
        ground10Scopes: Array.isArray(f.ground10Scopes) ? f.ground10Scopes.slice() : [],
        ground04Scopes: Array.isArray(f.ground04Scopes) ? f.ground04Scopes.slice() : [],
        surveyDate: f.surveyDate || ''
      };
      surveyDlg.saving = true;
      try {
        const saved = await api.put('/api/workPlans/' + plan.id + '/survey', body);
        plan.survey = saved;              // 勘察区立即切到「已勘察」
        surveyDlg.banner = { type: 'ok', text: SV_BANNER_SAVED };
        surveyDlg.snapshot = svFormJson();   // 保存成功 → 快照对齐当前值，脏清除
        return true;
      } catch (e) {
        ElementPlus.ElMessage.error(e.message || '保存失败');
        return false;
      } finally { surveyDlg.saving = false; }
    }
    // 保存在线编辑内容：保存成功不关编辑器（右上角 X 关闭），顶部只给绿色横幅
    async function saveSurvey() {
      await putSurvey();          // 成功后由顶部绿色横幅提示，不额外弹 toast
    }
    // 保存并生成 现场勘察记录：先走同一套校验与 PUT，成功后调生成接口
    // 生成成功不关闭编辑器——可能还有地方要改；改完再点即覆盖更新同一份，不新增勘察单
    async function saveAndGenerate() {
      const plan = matDlg.plan;
      if (!plan || !plan.id || surveyDlg.saving || surveyDlg.generating) return;
      if (!(await putSurvey())) return;
      surveyDlg.generating = true;
      try {
        const r = await api.post('/api/workPlans/' + plan.id + '/survey/generate');
        const updated = !!(r && r.updated);
        ElementPlus.ElMessage.success(updated ? '已更新「现场勘察记录.docx」' : '已生成「现场勘察记录.docx」');
        surveyDlg.banner = { type: 'ok', text: updated ? SV_BANNER_UPDATED : SV_BANNER_GENERATED };
        await reloadMatPlan();            // 施工资料弹窗的生成资料区随之刷新（编辑器保持打开）
      } catch (e) {
        // 失败：编辑器保持打开，已保存的内容不丢
        ElementPlus.ElMessage.error(e.message || '生成失败');
      } finally { surveyDlg.generating = false; }
    }
    // 打开作业资料：在编辑器之上叠开施工资料弹窗，编辑器不关闭
    async function openMaterialsFromEditor() {
      if (!matDlg.plan || !matDlg.plan.id) return;
      await openPlanMaterials(matDlg.plan, true);
    }
    // ---------- 人员安排：从作业人员名单勾选（按班组/身份分组，全选支持） ----------
    const workersFull = ref([]);
    const contacts = ref([]);
    const staffPick = reactive({ visible: false, checked: {} });
    function staffKey(w) { return w.id || ((w.name || '') + '|' + (w.phone || '')); }
    const groupedTeams = computed(() => {
      const admitted = workersFull.value.filter(w => w.status !== '待定');
      const byTeam = {};
      admitted.forEach(w => { const t = w.team || '未分组'; (byTeam[t] = byTeam[t] || []).push(w); });
      return Object.keys(byTeam).sort().map(team => ({
        team,
        identities: Object.entries(byTeam[team].reduce((m, w) => {
          const id = w.identity || '其他';
          (m[id] = m[id] || []).push(w); return m;
        }, {})).map(([identity, list]) => ({ identity, list }))
      }));
    });
    function openStaffPick() {
      if (!workersFull.value.length) loadMeta();
      staffPick.checked = {};
      staffPick.visible = true;
    }
    function toggleIdentity(it) {
      const keys = it.list.map(staffKey);
      const all = keys.every(k => staffPick.checked[k]);
      keys.forEach(k => { staffPick.checked[k] = !all; });
    }
    function confirmStaffPick() {
      const sel = workersFull.value.filter(w => staffPick.checked[staffKey(w)]);
      dlg.form.staffText = sel.map(w => w.name + '/' + (w.phone || '')).join('；');
      dlg.form.staffCount = sel.length ? String(sel.length) : '';
      dlg.form.highStaff = sel.filter(w => String(w.identity || '').includes('计入高处作业人员')).map(w => w.name).join('；');
      staffPick.visible = false;
    }
    // 工作负责人：外部通讯录中匹配姓名自动带出手机号
    function onChargePersonInput() {
      const n = String(dlg.form.chargePerson || '').trim();
      const c = n && contacts.value.find(x => x.name === n);
      if (c && c.phone) dlg.form.chargePersonPhone = c.phone;
    }
    // 一键填入：按关联项目进度填入杆塔/电缆完成量
    function oneKeyFill() {
      const f = dlg.form;
      const p = projectsFull.value.find(x => (x.name || x.projectName) === f.project);
      if (!p || !p.progress) { ElementPlus.ElMessage.warning('请先选择关联项目，且项目需有进度数据'); return; }
      const pr = p.progress;
      if (pr.pole && pr.pole.done != null) f.wlPole = String(pr.pole.done);
      if (pr.cable && pr.cable.done != null) f.wlCable = String(pr.cable.done);
      ElementPlus.ElMessage.success('已按项目进度填入杆塔、电缆完成量，其余请自行填写');
    }
    let unitsLoaded = false;
    async function openAdd() {
      if (!unitsLoaded) { await loadHazards(); unitsLoaded = true; }
      if (!teams.value.length) await loadMeta();   // 新实例/刚维护完班组后打开，也能取到最新施工班组
      dlg.editingId = null; dlg.form = emptyForm();
      // 计划类型跟随当前所在 tab：月计划管理 tab 新增存为月计划，其余存周计划
      dlg.form.planType = tab.value === 'month' ? '月计划' : '周计划';
      // 从项目详情跳转过来时，关联项目默认带入（避免新增后因项目筛选而"消失"）
      if (filters.projectScope.length) dlg.form.project = filters.projectScope[0];
      // 作业单位联动：分包与监理默认排序第一条，抄送默认排序前两条；建管/实施单位留空由用户自行编辑
      const fb = unitsByType('分包单位'); if (fb.length) dlg.form.subcontractors = [fb[0].name];
      const sj = unitsByType('监理单位'); if (sj.length) dlg.form.supervisor = sj[0].name;
      const cs = unitsByType('抄送单位'); if (cs.length) dlg.form.ccUnits = cs.slice(0, 2).map(u => u.name);
      // 编号自动生成：勘察 = 年月 + 当月最大流水 +1；工作票 = 年月 + 类型码 + 该类型最大流水 +1
      // 统计口径 = list（GET /api/workPlans 的全量存活记录，不受页签/筛选/分页影响）
      const ym = PlanNo.ymOf(new Date());
      dlg.form.surveyNo = PlanNo.nextSurveyNo(list.value, ym);
      dlg.form.workTicketNo = PlanNo.nextTicketNo(list.value, ym, dlg.form.ticketType);
      dlg.ticketNoDirty = false;
      dlg.visible = true;
    }
    function openEdit(row) {
      dlg.editingId = row.id; dlg.form = JSON.parse(JSON.stringify(row)); dlg.visible = true;
      dlg.ticketNoDirty = false;   // 编辑模式不重算编号，也不因切换类型而改写
      if (!dlg.form.controlMeasures && (dlg.form.riskFactors || []).length) dlg.form.controlMeasures = genMeasures(dlg.form.riskFactors);
      // 字段规范化（老数据补齐）
      ['subcontractors', 'ccUnits', 'chargePersons'].forEach(k => { if (!Array.isArray(dlg.form[k])) dlg.form[k] = []; });
      ['staffText', 'teamLeader', 'staffCount', 'highStaff', 'gasTester', 'guardian', 'chargePerson', 'chargePersonPhone', 'arrivalPersons', 'safetyPatrol', 'wlPole', 'wlLine1035', 'wlCable', 'wlRing', 'wlVacuum', 'wlTransformer', 'wlLine04', 'outageRange', 'outageHours', 'surveyNo', 'workTicketNo', 'team'].forEach(k => { if (dlg.form[k] === undefined || dlg.form[k] === null) dlg.form[k] = ''; });
    }
    async function submit() {
      const f = dlg.form;
      // 统一为 YYYY-MM-DD HH:mm:ss（历史数据为 HH:mm），保证下面的字符串比较与导出稳定
      const normDT = v => (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(v || '').trim()) ? String(v).trim() + ':00' : v);
      f.startDate = normDT(f.startDate); f.endDate = normDT(f.endDate);
      if (!String(f.name || '').trim()) { ElementPlus.ElMessage.warning('请填写作业计划名称'); return; }
      if (!f.startDate || !f.endDate) { ElementPlus.ElMessage.warning('请选择计划开始/结束日期'); return; }
      if (f.endDate < f.startDate) { ElementPlus.ElMessage.warning('计划结束日期不能早于开始日期'); return; }
      if (!f.team) { ElementPlus.ElMessage.warning('请选择作业班组'); return; }
      if (!String(f.staffText || '').trim()) { ElementPlus.ElMessage.warning('请选择作业实施（施工）人员'); return; }
      if (!f.teamLeader) { ElementPlus.ElMessage.warning('请选择班组长'); return; }
      // 当日计划工作量：数字格式校验
      const INT_RE = /^\d+$/, DEC3_RE = /^\d+(\.\d{1,3})?$/, DEC_RE = /^\d+(\.\d+)?$/;
      const numChecks = [['杆塔（基）', f.wlPole, INT_RE], ['10kV/35kV线路（km/单线）', f.wlLine1035, DEC3_RE], ['电缆（千米）', f.wlCable, DEC3_RE], ['环网柜（个）', f.wlRing, INT_RE], ['真空开关（个）', f.wlVacuum, INT_RE], ['变压器（个）', f.wlTransformer, INT_RE], ['0.4/0.22kV线路（km/单线）', f.wlLine04, DEC3_RE], ['时户数', f.outageHours, DEC_RE]];
      for (const [lb, v, re] of numChecks) {
        const s = String(v == null ? '' : v).trim();
        if (s && !re.test(s)) { ElementPlus.ElMessage.warning('「' + lb + '」格式不正确，请检查'); return; }
      }
      try {
        const body = { ...f, name: String(f.name).trim() };
        // 周计划没有「班组应采取的安全措施」字段（历史误加，已撤）：保存体一律不带该键，
        // 既不写入新值，也不回写旧值——存量数据留在库里不动（不删、不迁移）。
        delete body.teamSafetyMeasures;
        // 作业班组 / 班组长同步到列表展示字段（列表、筛选、日历、导出均读 team / leader）
        if (f.team) body.team = f.team;
        if (f.teamLeader) body.leader = f.teamLeader;
        if (Array.isArray(f.chargePersons) && f.chargePersons.length) body.chargePerson = f.chargePersons[0];
        if (dlg.editingId) await api.put('/api/workPlans/' + dlg.editingId, body);
        else await api.post('/api/workPlans', body);
        ElementPlus.ElMessage.success(dlg.editingId ? '计划已更新' : '计划已新增');
        dlg.visible = false; load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function remove(row) {
      try {
        await ElementPlus.ElMessageBox.confirm('确认删除作业计划「' + row.name + '」？', '提示', { type: 'warning' });
        await api.del('/api/workPlans/' + row.id);
        ElementPlus.ElMessage.success('已删除'); load();
      } catch (e) { if (e !== 'cancel') ElementPlus.ElMessage.error(e.message || '已取消'); }
    }
    function importPlans() {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = '.xlsx,.xls,.csv';
      input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const fd = new FormData(); fd.append('file', file);
        try {
          const res = await fetch('/api/workPlans/import', { method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('erp_token') }, body: fd });
          const d = await res.json();
          if (!res.ok) throw new Error(d.error || '导入失败');
          ElementPlus.ElMessage.success('已导入 ' + d.added + ' 条作业计划');
          load();
        } catch (e) { ElementPlus.ElMessage.error(e.message); }
      };
      input.click();
    }
    async function exportPlans() {
      try {
        const token = localStorage.getItem('erp_token');
        const res = await fetch('/api/workPlans/export', { headers: { Authorization: 'Bearer ' + token } });
        if (!res.ok) throw new Error('导出失败');
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'workPlans_export.xlsx';
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(a.href);
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    function onTab() { page.value = 1; }
    // 项目详情「查看月/周计划」：切到对应页签，并把列表限定在该项目（含其子项目）
    const scopeLabel = ref('');
    function clearProjectScope() { filters.projectScope = []; scopeLabel.value = ''; page.value = 1; }
    function applyProjectNav(nav) {
      if (!nav) return;
      if (nav.tab && TABS.some(t => t.key === nav.tab)) tab.value = nav.tab;
      // 清掉可能把目标计划筛掉的其它条件，保证跳转后一定看得到本项目的计划
      Object.assign(filters, { startDate: '', endDate: '', name: '', content: '', noProject: false, team: '', leader: '', ticketType: '' });
      filters.projectScope = (Array.isArray(nav.names) ? nav.names : []).filter(Boolean);
      scopeLabel.value = nav.label || filters.projectScope[0] || '';
      page.value = 1;
    }
    function onFilterProject(e) {
      const d = e.detail || {};
      applyProjectNav({ tab: d.tab, label: d.project, names: d.project ? [d.project] : [] });
    }
    // 计划管理为懒挂载：跳转前暂存的意图在本次 setup 中消费（首次挂载即可落到正确页签与范围）
    if (window.__pendingPlansNav) { applyProjectNav(window.__pendingPlansNav); window.__pendingPlansNav = null; }
    window.addEventListener('plans-filter-project', onFilterProject);
    onUnmounted(() => window.removeEventListener('plans-filter-project', onFilterProject));
    onMounted(() => { loadMeta(); load(); });
    const qtyDlg = reactive({ visible: false, id: '', name: '', busy: false, form: {} });
    const QTY_FIELDS = [
      { key: 'wlPole', label: '杆塔（基）' },
      { key: 'wlLine1035', label: '10kV/35kV线路（km/单线）' },
      { key: 'wlCable', label: '电缆（千米）' },
      { key: 'wlRing', label: '环网柜（个）' },
      { key: 'wlVacuum', label: '真空开关（个）' },
      { key: 'wlTransformer', label: '变压器（个）' },
      { key: 'wlLine04', label: '0.4/0.22kV线路（km/单线）' }
    ];
    function openQuantities(row) {
      const f = {};
      QTY_FIELDS.forEach(x => { f[x.key] = row[x.key] || ''; });
      Object.assign(qtyDlg, { visible: true, id: row.id, name: row.name || '', busy: false, form: f });
    }
    async function submitQuantities() {
      qtyDlg.busy = true;
      try {
        await api.put('/api/workPlans/' + qtyDlg.id + '/quantities', qtyDlg.form);
        ElementPlus.ElMessage.success('施工量已保存');
        qtyDlg.visible = false; load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { qtyDlg.busy = false; }
    }

    // 新增模式切换工作票类型 → 立即按新类型重算；用户手改过编号（脏标记）后不再覆盖；编辑模式一律不动
    function onTicketTypeChange(v) {
      if (dlg.editingId || dlg.ticketNoDirty) return;
      const type = v || (dlg.form && dlg.form.ticketType);
      dlg.form.workTicketNo = PlanNo.nextTicketNo(list.value, PlanNo.ymOf(new Date()), type);
    }
    function onTicketNoInput() { dlg.ticketNoDirty = true; }

    return { TABS, tab, list, loading, projects, projectsFull, teams, workers, riskFactors, filters, page, pageSize, paged, filtered, scopeLabel, clearProjectScope, dlg, upcoming, calendarDays, fmtDT, dash, rowClass, copyPlan, execPlan, cancelPlan, restorePlan, notePlan, openPlanMaterials, matDlg, matTodo, matDrawings, matDrawingInput, triggerDrawingUpload, onDrawingUpload, matFmtTime, matDownloadDrawing, matDeleteDrawing, matPackage, matPackInput, triggerPackUpload, onPackUpload, matDownloadPackage, matDeletePackage, matSurveyed, matGenFiles, matGenEmpty, matDownloadGen, matDeleteGen, surveyDlg, openSurveyEditor, onSurveyBeforeClose, SURVEY_GROUPING_OPTS, surveyPeople, svUnitOpts, svGroupCount, svGrouped, onGroupingChange, svMembersText, svPick, svPickTitle, svPickGroups, svPickAllOn, svPickSomeOn, svToggleAll, svToggleRow, svOpenLeader, svOpenMembers, svConfirmPick, svRemoveMember, svPeopleList, svMultiTeam, svBadges, surveyTitle, sxLines, onScopeTextInput, hazardPick, hazardGroups, hpOpen, toggleHp, openHp, hpScopeOpts, hpScopeOf, onTitleClick, renameHazard, addHazardFromLib, addCustomHazard, canRestoreMeasure, restoreMeasure, moveHazard, removeHazard, saveSurvey, saveAndGenerate, openMaterialsFromEditor, TICKET_TYPES, VOLTAGE_LEVELS, WORK_TYPES, SPECIALTIES, DEPTS, RISK_LEVELS, GRID_RISKS, MAJOR_RISKS, genMeasures, subProjectOptions, unitsByType, workersFull, contacts, staffPick, groupedTeams, staffKey, openStaffPick, confirmStaffPick, toggleIdentity, onChargePersonInput, oneKeyFill, load, onTab, openAdd, openEdit, onProjectSelect, submit, remove, importPlans, exportPlans, qtyDlg, QTY_FIELDS, openQuantities, submitQuantities, onTicketTypeChange, onTicketNoInput };
  },
  template: `
  <div>
    <div style="background:var(--surface);border:1px solid var(--line);border-radius:4px;padding:16px 18px;margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="font-size:17px;font-weight:600">日计划日历</div>
      </div>
      <div style="color:var(--text-3);font-size:12px;margin-top:6px">未来 21 天共 {{ upcoming.length }} 个日历安排，跨日计划按覆盖日期展示</div>
      <div v-if="!calendarDays.length" style="margin-top:12px;background:var(--surface-3);border:1px solid var(--line);border-radius:6px;padding:16px;font-size:13px;color:var(--text-3)">未来 21 天暂无施工计划</div>
      <div v-else style="display:flex;gap:12px;overflow-x:auto;padding:12px 2px 4px">
        <div v-for="d in calendarDays" :key="d.ds" style="min-width:250px;max-width:280px;flex:0 0 auto;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:12px 14px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <b style="font-size:14px">{{ d.label }}</b>
            <span style="background:#3370ff;color:#fff;border-radius:10px;font-size:12px;padding:1px 9px">{{ d.plans.length }} 条</span>
          </div>
          <div style="color:var(--text-2);font-size:13px;margin-top:8px">班组长：{{ d.plans[0].leader || d.plans[0].team || '-' }}</div>
          <div v-for="p in d.plans" :key="p.id" style="color:var(--text-2);font-size:13px;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
            <span v-if="(p.startDate || '').length > 10" style="margin-right:4px">{{ p.startDate.slice(11, 16) }}</span>{{ p.name }}
          </div>
        </div>
      </div>
    </div>

    <div class="plan-card">
      <el-tabs v-model="tab" class="plan-tabs" @tab-change="onTab">
        <el-tab-pane v-for="t in TABS" :key="t.key" :label="t.label" :name="t.key" />
      </el-tabs>

      <div v-if="filters.projectScope.length" class="plan-scope">
        <span class="pf-label">关联项目：</span>
        <el-tag closable effect="plain" type="primary" @close="clearProjectScope">
          {{ scopeLabel }}<template v-if="filters.projectScope.length > 1">（含 {{ filters.projectScope.length - 1 }} 个子项目）</template>
        </el-tag>
        <span class="plan-scope-tip">由项目详情「查看月计划 / 查看周计划」带入，关闭标签可查看全部计划</span>
      </div>

      <div class="plan-filters">
        <el-date-picker v-model="filters.startDate" type="date" placeholder="开始日期" value-format="YYYY-MM-DD" class="pf-date" @change="page=1" />
        <el-date-picker v-model="filters.endDate" type="date" placeholder="结束日期" value-format="YYYY-MM-DD" class="pf-date" @change="page=1" />
        <div class="pf-item"><span class="pf-label">作业计划名称：</span>
          <el-input v-model="filters.name" placeholder="关键词" clearable class="pf-input" @input="page=1" />
        </div>
        <div class="pf-item"><span class="pf-label">工作内容：</span>
          <el-input v-model="filters.content" placeholder="关键词" clearable class="pf-input" @input="page=1" />
        </div>
        <el-checkbox v-model="filters.noProject" class="pf-check" @change="page=1">未关联项目</el-checkbox>
        <div class="pf-item"><span class="pf-label">作业班组：</span>
          <el-select v-model="filters.team" placeholder="全部" clearable class="pf-select" @change="page=1">
            <el-option v-for="t in teams" :key="t" :label="t" :value="t" />
          </el-select>
        </div>
        <div class="pf-item"><span class="pf-label">班组长：</span>
          <el-select v-model="filters.leader" placeholder="全部" clearable class="pf-select" @change="page=1">
            <el-option v-for="w in workers" :key="w" :label="w" :value="w" />
          </el-select>
        </div>
        <div class="pf-item"><span class="pf-label">工作票类型：</span>
          <el-select v-model="filters.ticketType" placeholder="全部" clearable class="pf-select pf-select-wide" @change="page=1">
            <el-option v-for="t in TICKET_TYPES" :key="t" :label="t" :value="t" />
          </el-select>
        </div>
      </div>

      <div class="plan-toolbar">
        <el-button v-if="canWrite('plans')" type="primary" size="small" @click="openAdd">新增</el-button>
        <el-button v-if="canWrite('plans')" size="small" @click="importPlans">导入 xlsx</el-button>
        <el-button size="small" @click="exportPlans">导出 xlsx</el-button>
      </div>

      <el-table :data="paged" v-loading="loading" class="plan-table" style="width:100%" :row-class-name="rowClass">
        <el-table-column type="index" label="序号" width="52" align="center" />
        <el-table-column prop="name" label="作业计划名称" min-width="150" show-overflow-tooltip />
        <el-table-column prop="team" label="作业班组" min-width="92" show-overflow-tooltip :formatter="(r,c,v)=>dash(v)" />
        <el-table-column prop="leader" label="班组长" width="76" :formatter="(r,c,v)=>dash(v)" />
        <el-table-column prop="startDate" label="计划开始" width="110" class-name="pf-nowrap" :formatter="(r,c,v)=>fmtDT(v)" />
        <el-table-column prop="endDate" label="计划结束" width="110" class-name="pf-nowrap" :formatter="(r,c,v)=>fmtDT(v)" />
        <el-table-column prop="ticketType" label="工作票类型" min-width="132" show-overflow-tooltip :formatter="(r,c,v)=>dash(v)" />
        <el-table-column prop="voltage" label="电压等级" width="78" align="center" :formatter="(r,c,v)=>dash(v)" />
        <el-table-column prop="station" label="变电站/线路" min-width="100" show-overflow-tooltip :formatter="(r,c,v)=>dash(v)" />
        <el-table-column prop="chargePerson" label="工作负责人" width="92" show-overflow-tooltip :formatter="(r,c,v)=>dash(v)" />
        <el-table-column prop="chargePersonPhone" label="工作负责人联系电话" width="144" show-overflow-tooltip :formatter="(r,c,v)=>dash(v)" />
        <el-table-column label="操作" width="184" fixed="right">
          <template #default="{row}">
            <div v-if="canWrite('plans')" class="plan-acts">
              <template v-if="tab === 'canceled'">
                <el-button link type="warning" size="small" @click="openPlanMaterials(row)">施工资料</el-button>
                <el-button link type="warning" size="small" @click="copyPlan(row)">复制</el-button>
                <el-button link type="primary" size="small" @click="restorePlan(row)">恢复</el-button>
              </template>
              <template v-else>
                <el-button link type="warning" size="small" @click="openPlanMaterials(row)">施工资料</el-button>
                <el-button link type="warning" size="small" @click="openEdit(row)">编辑</el-button>
                <el-button link type="warning" size="small" @click="copyPlan(row)">复制</el-button>
                <el-button link type="warning" size="small" @click="execPlan(row)">执行</el-button>
                <el-button link type="warning" size="small" @click="notePlan(row)">备注</el-button>
                <el-button link type="danger" size="small" @click="cancelPlan(row)">取消</el-button>
              </template>
            </div>
            <el-button v-else-if="canWrite('planQuantities')" link type="primary" size="small" @click="openQuantities(row)">填写施工量</el-button>
            <span v-else style="color:var(--text-3)">-</span>
          </template>
        </el-table-column>
        <template #empty>
          <div class="plan-empty">
            <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M11 38v9a5 5 0 0 0 5 5h32a5 5 0 0 0 5-5v-9" />
              <path d="M11 38l7-21a5 5 0 0 1 4.7-3.4h18.6A5 5 0 0 1 46 17l7 21" />
              <path d="M11 38h11l2.5 5h15L42 38h11" />
            </svg>
            <span>暂无数据</span>
          </div>
        </template>
      </el-table>

      <el-dialog title="填写工程实际施工量" v-model="qtyDlg.visible" width="620px" label-position="top">
        <div style="color:var(--text-2);font-size:13px;margin-bottom:12px">计划：{{ qtyDlg.name }}</div>
        <el-form label-position="top">
          <el-row :gutter="20">
            <el-col v-for="f in QTY_FIELDS" :key="f.key" :xs="24" :sm="12">
              <el-form-item :label="f.label">
                <el-input v-model="qtyDlg.form[f.key]" placeholder="选填" />
              </el-form-item>
            </el-col>
          </el-row>
        </el-form>
        <template #footer>
          <el-button @click="qtyDlg.visible=false">取消</el-button>
          <el-button type="primary" :loading="qtyDlg.busy" @click="submitQuantities">保存</el-button>
        </template>
      </el-dialog>

      <div class="plan-pager">
        <span class="pp-total">共 {{ filtered.length }} 条，第 {{ page }} 页</span>
        <el-select v-model="pageSize" size="small" class="pp-size" @change="page=1">
          <el-option v-for="s in [20, 50, 100]" :key="s" :label="s + ' 条/页'" :value="s" />
        </el-select>
        <el-button size="small" :disabled="page <= 1" @click="page = page - 1">上一页</el-button>
        <el-button size="small" :disabled="page >= Math.max(1, Math.ceil(filtered.length / pageSize))" @click="page = page + 1">下一页</el-button>
      </div>
    </div>

    <el-dialog :title="(dlg.editingId ? '编辑' : '新增') + (dlg.form && dlg.form.planType === '月计划' ? '月计划' : '周计划')" v-model="dlg.visible" width="min(1180px, 94%)" top="4vh">
      <el-form v-if="dlg.form" label-position="top" style="max-height:72vh;overflow:auto;padding-right:6px">
        <div style="border:1px solid var(--line);border-radius:6px;padding:16px 20px 2px;margin:2px 0 14px;background:var(--surface)">
          <div style="font-size:15px;font-weight:600;margin-bottom:14px">项目与作业风险</div>
        <el-row :gutter="20">
          <el-col :xs="24" :sm="12">
            <el-form-item label="关联项目">
              <el-select v-model="dlg.form.project" placeholder="请选择，关联后作业内容将同步到该项目已报计划量" filterable clearable style="width:100%" @change="onProjectSelect">
                <el-option v-for="p in projects" :key="p" :label="p" :value="p" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="子项目">
              <el-select v-model="dlg.form.subProject" :placeholder="subProjectOptions.length ? '请选择子项目' : '当前包下无其他子项目'" :disabled="!subProjectOptions.length" clearable style="width:100%">
                <el-option v-for="s in subProjectOptions" :key="s" :label="s" :value="s" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :xs="24" :sm="12">
            <el-form-item label="作业计划名称" required><el-input v-model="dlg.form.name" placeholder="请输入作业计划名称" /></el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="作业类型" required>
              <el-select v-model="dlg.form.workType" style="width:100%">
                <el-option v-for="t in WORK_TYPES" :key="t" :label="t" :value="t" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :xs="24" :sm="12">
            <el-form-item label="计划开始时间"><plan-date-time v-model="dlg.form.startDate" placeholder="请选择日期" /></el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="计划结束时间"><plan-date-time v-model="dlg.form.endDate" placeholder="请选择日期" /></el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :xs="24" :sm="12">
            <el-form-item label="作业专业">
              <el-select v-model="dlg.form.specialty" style="width:100%">
                <el-option v-for="s in SPECIALTIES" :key="s" :label="s" :value="s" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="省专业管理部门">
              <el-select v-model="dlg.form.dept" style="width:100%">
                <el-option v-for="d in DEPTS" :key="d" :label="d" :value="d" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :xs="24" :sm="12">
            <el-form-item label="电压等级">
              <el-select v-model="dlg.form.voltage" style="width:100%">
                <el-option v-for="v in VOLTAGE_LEVELS" :key="v" :label="v" :value="v" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="工作票类型">
              <el-select v-model="dlg.form.ticketType" style="width:100%" @change="onTicketTypeChange">
                <el-option v-for="t in TICKET_TYPES" :key="t" :label="t" :value="t" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :xs="24" :sm="12">
            <el-form-item label="作业地址"><el-input v-model="dlg.form.address" placeholder="可修改默认地址" /></el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="变电站/线路"><el-input v-model="dlg.form.station" placeholder="如：10kV怀农线" /></el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :xs="24" :sm="12">
            <el-form-item label="作业内容">
              <el-input v-model="dlg.form.content" type="textarea" :rows="3" placeholder="请规范使用动、名词，动词在前，名词和数量在后。比如：开挖坑洞 5个；安装开关 1台" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="影子作业内容">
              <el-input v-model="dlg.form.shadowContent" type="textarea" :rows="3" placeholder="请填；生成工作票时优先使用，留空则使用作业内容" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :xs="24" :sm="12">
            <el-form-item label="是否涉及机械施工">
              <el-select v-model="dlg.form.machine" style="width:100%">
                <el-option label="是" value="是" /><el-option label="否" value="否" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="作业风险等级">
              <el-select v-model="dlg.form.riskLevel" style="width:100%">
                <el-option v-for="r in RISK_LEVELS" :key="r" :label="r" :value="r" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :xs="24" :sm="12">
            <el-form-item label="电网风险等级">
              <el-select v-model="dlg.form.gridRisk" style="width:100%">
                <el-option v-for="g in GRID_RISKS" :key="g" :label="g" :value="g" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="风险因素">
              <el-select v-model="dlg.form.riskFactors" multiple filterable style="width:100%" placeholder="请选择风险因素（来自规范文件危险点库）" @change="f => dlg.form.controlMeasures = genMeasures(f)">
                <el-option v-for="r in riskFactors" :key="r" :label="r" :value="r" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :xs="24" :sm="12">
            <el-form-item label="重特大人身事故风险">
              <el-select v-model="dlg.form.majorRisk" style="width:100%">
                <el-option v-for="m in MAJOR_RISKS" :key="m" :label="m" :value="m" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="风险管控措施">
              <el-input v-model="dlg.form.controlMeasures" type="textarea" :autosize="{ minRows: 1, maxRows: 24 }" placeholder="选择风险因素后自动带出对应措施，可手工修改" style="--el-input-height:32px" />
            </el-form-item>
          </el-col>
        </el-row>
        </div>

        <div style="border:1px solid var(--line);border-radius:6px;padding:16px 20px 2px;margin:6px 0 14px;background:var(--surface)">
          <div style="font-size:15px;font-weight:600;margin-bottom:14px">作业单位</div>
        <el-row :gutter="20">
          <el-col :xs="24" :sm="12">
            <el-form-item label="作业建管单位（市）">
              <el-input v-model="dlg.form.buildCity" placeholder="请输入" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="作业建管单位（县）">
              <el-input v-model="dlg.form.buildCounty" placeholder="请输入" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="作业实施单位（市）">
              <el-input v-model="dlg.form.execCity" placeholder="请输入" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="作业实施单位（县）">
              <el-input v-model="dlg.form.execCounty" placeholder="请输入" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="作业班组" required>
              <el-select v-model="dlg.form.team" placeholder="请选择施工班组" filterable clearable style="width:100%">
                <el-option v-for="t in teams" :key="t" :label="t" :value="t" />
              </el-select>
              <div v-if="!teams.length" style="color:var(--text-3);font-size:12px;line-height:1.6">暂无施工班组，请先在「设置 → 班组管理」新增</div>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="分包单位">
              <el-select v-model="dlg.form.subcontractors" multiple filterable placeholder="可多选" style="width:100%">
                <el-option v-for="u in unitsByType('分包单位')" :key="u.id" :label="u.name" :value="u.name" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="监理单位">
              <el-select v-model="dlg.form.supervisor" placeholder="请选择" filterable clearable style="width:100%">
                <el-option v-for="u in unitsByType('监理单位')" :key="u.id" :label="u.name" :value="u.name" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="抄送单位">
              <el-select v-model="dlg.form.ccUnits" multiple filterable placeholder="请选择" style="width:100%">
                <el-option v-for="u in unitsByType('抄送单位')" :key="u.id" :label="u.name" :value="u.name" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        </div>

        <div style="border:1px solid var(--line);border-radius:6px;padding:16px 20px 2px;margin:6px 0 14px;background:var(--surface)">
          <div style="font-size:15px;font-weight:600;margin-bottom:14px">人员安排</div>
        <el-row :gutter="20">
          <el-col :xs="24" :sm="12">
            <el-form-item label="作业实施（施工）人员（不包含工作负责人）" required>
              <el-button @click="openStaffPick">从作业人员名单选择</el-button>
              <el-input v-model="dlg.form.staffText" type="textarea" :rows="3" placeholder="点击上方「从作业人员名单选择」勾选后自动填入" style="margin-top:8px" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="班组长" required>
              <el-select v-model="dlg.form.teamLeader" placeholder="请选择" filterable clearable style="width:100%">
                <el-option v-for="w in workers" :key="w" :label="w" :value="w" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="作业人员（共多少人）">
              <el-input v-model="dlg.form.staffCount" placeholder="由上方人员选择自动带出" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="其中高处作业人员">
              <el-input v-model="dlg.form.highStaff" placeholder="由上方人员选择自动带出（仅「技工（计入高处作业人员）」身份计入）" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="气体检测人员">
              <el-input v-model="dlg.form.gasTester" placeholder="如：不涉及" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="专责监护人">
              <el-input v-model="dlg.form.guardian" placeholder="请输入" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="工作负责人">
              <el-input v-model="dlg.form.chargePerson" placeholder="请输入姓名，无默认值" @input="onChargePersonInput" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="工作负责人联系方式">
              <el-input v-model="dlg.form.chargePersonPhone" placeholder="手机号（外部通讯录中匹配姓名将自动带出）" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="到岗到位人员">
              <el-input v-model="dlg.form.arrivalPersons" placeholder="请输入" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="安全巡查人员">
              <el-input v-model="dlg.form.safetyPatrol" placeholder="选填" />
            </el-form-item>
          </el-col>
        </el-row>
        </div>

        <div style="border:1px solid var(--line);border-radius:6px;padding:16px 20px 2px;margin:6px 0 14px;background:var(--surface)">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
            <span style="font-size:15px;font-weight:600">当日计划工作量</span>
            <el-link type="primary" :underline="false" @click="oneKeyFill">一键填入</el-link>
          </div>
        <el-row :gutter="20">
          <el-col :xs="24" :sm="12">
            <el-form-item label="杆塔（基）">
              <el-input v-model="dlg.form.wlPole" placeholder="选填，整数" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="10kV/35kV线路（km/单线）">
              <el-input v-model="dlg.form.wlLine1035" placeholder="选填，最多三位小数" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="电缆（千米）">
              <el-input v-model="dlg.form.wlCable" placeholder="选填，最多三位小数" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="环网柜（个）">
              <el-input v-model="dlg.form.wlRing" placeholder="选填，整数" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="真空开关（个）">
              <el-input v-model="dlg.form.wlVacuum" placeholder="选填，整数" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="变压器（个）">
              <el-input v-model="dlg.form.wlTransformer" placeholder="选填，整数" />
            </el-form-item>
          </el-col>
          <el-col :xs="24">
            <el-form-item label="0.4/0.22kV线路（km/单线）">
              <el-input v-model="dlg.form.wlLine04" placeholder="选填，最多三位小数" />
            </el-form-item>
          </el-col>
        </el-row>
        </div>

        <el-row :gutter="20">
          <el-col :xs="24" :sm="12">
            <el-form-item label="停电范围">
              <el-input v-model="dlg.form.outageRange" placeholder="选填" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="时户数">
              <el-input v-model="dlg.form.outageHours" placeholder="选填，支持小数" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="勘察编号">
              <el-input v-model="dlg.form.surveyNo" placeholder="自动生成，可手动修改" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="工作票编号">
              <el-input v-model="dlg.form.workTicketNo" placeholder="自动生成，可手动修改" @input="onTicketNoInput" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="dlg.visible=false">取 消</el-button>
        <el-button type="primary" @click="submit">确 定</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="staffPick.visible" title="从作业人员名单选择（作业实施人员，不包含工作负责人）" width="min(760px, 94%)">
      <div style="max-height:56vh;overflow:auto">
        <div v-for="g in groupedTeams" :key="g.team" style="border:1px solid var(--line);border-radius:6px;padding:12px 16px;margin-bottom:12px">
          <div style="font-weight:600;margin-bottom:8px">班组：{{ g.team }}</div>
          <div v-for="it in g.identities" :key="it.identity" style="margin-bottom:8px">
            <div style="margin-bottom:4px">身份：{{ it.identity }}<el-link type="primary" :underline="false" style="margin-left:10px" @click="toggleIdentity(it)">全选</el-link></div>
            <el-checkbox v-for="w in it.list" :key="w.id" v-model="staffPick.checked[staffKey(w)]" style="margin-right:16px">{{ w.name }} / {{ w.phone || '-' }}</el-checkbox>
          </div>
        </div>
        <div v-if="!groupedTeams.length" style="color:var(--text-3);font-size:13px;text-align:center;padding:20px 0">暂无已准入的作业人员，请先在「用户管理-作业人员名单」中维护</div>
      </div>
      <template #footer>
        <el-button @click="staffPick.visible=false">取 消</el-button>
        <el-button type="primary" @click="confirmStaffPick">确 定</el-button>
      </template>
    </el-dialog>

    <!-- 施工资料：勘察记录（编辑保存）、图纸、资料压缩包已接真实接口（生成资料仍为后续分项） -->
    <el-dialog v-model="matDlg.visible" :z-index="matDlg.zIndex" :title="'施工资料 - ' + ((matDlg.plan && (matDlg.plan.project || matDlg.plan.name)) || '')" width="min(1120px, 94%)" top="5vh">
      <div style="max-height:70vh;overflow:auto;padding-right:4px">
        <!-- 现场勘察记录（未勘察 / 已勘察 + 结构化编辑器；生成 docx 属后续分项） -->
        <div style="border:1px solid var(--line);border-radius:8px;padding:14px 18px;margin-bottom:18px;background:var(--surface-2)">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
            <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
              <span style="font-size:15px;font-weight:600">现场勘察记录</span>
              <span v-if="matSurveyed" style="font-size:13px;color:var(--text-2)">已勘察 · {{ (matDlg.plan.survey && matDlg.plan.survey.surveyDate) || '-' }}</span>
              <span v-else style="font-size:13px;color:var(--text-3)">未勘察</span>
            </div>
            <el-button v-if="matSurveyed" size="small" @click="openSurveyEditor">查看或编辑勘察记录</el-button>
            <el-button v-else type="primary" size="small" @click="openSurveyEditor">开始勘察</el-button>
          </div>
        </div>

        <!-- 生成资料 -->
        <div style="border:1px solid var(--line);border-radius:8px;padding:14px 18px;margin-bottom:18px;background:var(--surface-2)">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap">
            <span style="font-size:15px;font-weight:600">生成资料</span>
            <div style="display:flex;gap:10px">
              <el-button type="primary" size="small" @click="matTodo">修改签字页</el-button>
              <el-button type="primary" size="small" @click="matTodo">一键生成作业资料</el-button>
            </div>
          </div>
          <el-table :data="matGenFiles" class="mat-file-table" size="small" border :empty-text="matGenEmpty" style="width:100%">
            <el-table-column prop="category" label="资料类别" width="180" />
            <el-table-column prop="name" label="文件名称" min-width="260" show-overflow-tooltip />
            <el-table-column label="创建时间" width="180">
              <template #default="{ row }"><span style="color:var(--text-2)">{{ matFmtTime(row.uploadedAt) }}</span></template>
            </el-table-column>
            <el-table-column label="操作" width="140">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click="matDownloadGen(row)">下载</el-button>
                <el-button link type="danger" size="small" @click="matDeleteGen(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <!-- 图纸 -->
        <div style="border:1px solid var(--line);border-radius:8px;padding:14px 18px;margin-bottom:18px;background:var(--surface-2)">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap">
            <span style="font-size:15px;font-weight:600">图纸</span>
            <el-button size="small" @click="triggerDrawingUpload">上传图纸</el-button>
          </div>
          <el-table :data="matDrawings" class="mat-file-table" size="small" border empty-text="暂无图纸" style="width:100%">
            <el-table-column prop="category" label="资料类别" width="180" />
            <el-table-column prop="name" label="文件名称" min-width="260" show-overflow-tooltip />
            <el-table-column label="创建时间" width="180">
              <template #default="{ row }"><span style="color:var(--text-2)">{{ matFmtTime(row.uploadedAt) }}</span></template>
            </el-table-column>
            <el-table-column label="操作" width="140">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click="matDownloadDrawing(row)">下载</el-button>
                <el-button link type="danger" size="small" @click="matDeleteDrawing(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <!-- 资料压缩包 -->
        <div style="border:1px solid var(--line);border-radius:8px;padding:14px 18px;margin-bottom:18px;background:var(--surface-2)">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap">
            <span style="font-size:15px;font-weight:600">资料压缩包</span>
            <el-button size="small" @click="triggerPackUpload">上传压缩包</el-button>
          </div>
          <div style="font-size:12.5px;color:var(--text-3);margin:-2px 0 10px">ZIP、7z、RAR，单文件不超过 1MB。上传成功后替换当前包；上传失败时旧包仍可使用。</div>
          <el-table :data="matPackage" class="mat-file-table" size="small" border empty-text="暂无资料压缩包" style="width:100%">
            <el-table-column prop="category" label="资料类别" width="180" />
            <el-table-column prop="name" label="文件名称" min-width="260" show-overflow-tooltip />
            <el-table-column label="创建时间" width="180">
              <template #default="{ row }"><span style="color:var(--text-2)">{{ matFmtTime(row.uploadedAt) }}</span></template>
            </el-table-column>
            <el-table-column label="操作" width="140">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click="matDownloadPackage(row)">下载</el-button>
                <el-button link type="danger" size="small" @click="matDeletePackage(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>
      <input ref="matDrawingInput" type="file" style="display:none" @change="onDrawingUpload" />
      <input ref="matPackInput" type="file" accept=".zip,.7z,.rar" style="display:none" @change="onPackUpload" />
      <template #footer>
        <el-button @click="matDlg.visible=false">关 闭</el-button>
      </template>
    </el-dialog>

    <!-- 现场勘察记录编辑器（四期收官：字段与勘察单模板全槽位对齐 + 保存并生成 docx） -->
    <el-dialog v-model="surveyDlg.visible" :title="surveyTitle" width="min(900px, 94%)" top="4vh" append-to-body :before-close="onSurveyBeforeClose">
      <div v-if="surveyDlg.banner.text" class="sv-banner" :class="'sv-banner-' + surveyDlg.banner.type">{{ surveyDlg.banner.text }}</div>
      <div v-if="surveyDlg.form" style="max-height:72vh;overflow:auto;padding-right:6px">
        <el-form label-position="top" size="default">
          <el-form-item label="作业分组">
            <el-select v-model="surveyDlg.form.grouping" style="width:220px" @change="onGroupingChange">
              <el-option v-for="g in SURVEY_GROUPING_OPTS" :key="g" :label="g" :value="g" />
            </el-select>
          </el-form-item>

          <!-- 一行三列：勘察单位 / 部门（班组）/ 编号 -->
          <div class="sv-row3">
            <el-form-item>
              <template #label>
                <span class="sv-lab">勘察单位<span v-if="svBadges.surveyUnit" class="sv-chip" :class="'sv-' + svBadges.surveyUnit.cls">{{ svBadges.surveyUnit.text }}</span></span>
              </template>
              <el-select v-model="surveyDlg.form.surveyUnit" filterable allow-create default-first-option clearable placeholder="请选择勘察单位" style="width:100%">
                <el-option v-for="u in svUnitOpts" :key="u" :label="u" :value="u" />
              </el-select>
            </el-form-item>
            <el-form-item>
              <template #label>
                <span class="sv-lab">部门（班组）<span v-if="svBadges.team" class="sv-chip" :class="'sv-' + svBadges.team.cls">{{ svBadges.team.text }}</span></span>
              </template>
              <el-input v-model="surveyDlg.form.team" placeholder="请填写部门（班组）" />
            </el-form-item>
            <el-form-item>
              <template #label>
                <span class="sv-lab">编号<span v-if="svBadges.surveyNo" class="sv-chip" :class="'sv-' + svBadges.surveyNo.cls">{{ svBadges.surveyNo.text }}</span></span>
              </template>
              <el-input v-model="surveyDlg.form.surveyNo" placeholder="请填写编号" />
            </el-form-item>
          </div>

          <el-form-item>
            <template #label>
              <span class="sv-lab">勘察设备的双重名称<span v-if="svBadges.dualName" class="sv-chip" :class="'sv-' + svBadges.dualName.cls">{{ svBadges.dualName.text }}</span></span>
            </template>
            <el-input v-model="surveyDlg.form.dualName" type="textarea" :rows="3" placeholder="请输入勘察设备的双重名称" />
          </el-form-item>

          <!-- 3.工作任务：不分组 = 单个合并框（工作地点 + 工作内容）；分组 = N 张小组卡 -->
          <template v-if="!svGrouped">
            <el-form-item>
              <template #label>
                <span class="sv-lab">3.工作任务[工作地点（地段）以及工作内容]：<span v-if="svBadges.workTask" class="sv-chip" :class="'sv-' + svBadges.workTask.cls">{{ svBadges.workTask.text }}</span></span>
              </template>
              <el-input v-model="surveyDlg.form.workTask" type="textarea" :rows="4" placeholder="请填写工作地点（地段）以及工作内容" />
            </el-form-item>
          </template>

          <div v-else class="sv-sec">
            <!-- 标题 + [工作地点…] 是同一段标题文字（同字号/同字重/同色），后接蓝色「按小组拆分」chip -->
            <div class="sv-sec-head">
              <span class="sv-sec-title">3.工作任务[工作地点（地段）以及工作内容]：</span>
              <span class="sv-chip sv-split">按小组拆分</span>
            </div>

            <template v-if="svGrouped">
              <div v-if="String(surveyDlg.form.workTask || '').trim()" class="sv-notice">
                <div class="sv-notice-t">
                  <svg class="sv-notice-i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="1.7" /><path d="M12 7.4v5.9" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" /><circle cx="12" cy="16.9" r="1.15" fill="currentColor" /></svg>
                  <span>原作业内容无法按当前小组数自动拆分，请手动分配到各组；原文已保留。</span>
                </div>
                <el-input :model-value="surveyDlg.form.workTask" type="textarea" :rows="3" readonly class="sv-notice-text" />
              </div>
              <div v-for="i in svGroupCount" :key="i" class="sv-group">
                <!-- 紧凑首行：{n}小组（加粗纯文本）+ 小组长（技工选择弹窗）+ 本组人员（分组勾选弹窗，含实时人数） -->
                <div class="sv-gline">
                  <span class="sv-gname">{{ i }}小组</span>
                  <span class="sv-gpair sv-gpair-lead">
                    <span class="sv-glab">小组长</span>
                    <button type="button" class="sv-pick sv-pick-lead" :class="{ 'is-empty': !surveyDlg.form.groups[i - 1].leader }" @click="svOpenLeader(i - 1)">
                      <span class="sv-pick-t">{{ surveyDlg.form.groups[i - 1].leader || '选择技工' }}</span>
                      <svg class="sv-pick-i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 9.5 12 15l5.5-5.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" /></svg>
                    </button>
                  </span>
                  <span class="sv-gpair sv-gpair-mem">
                    <span class="sv-glab">本组人员</span>
                    <button type="button" class="sv-pick sv-pick-mem" :class="{ 'is-empty': !surveyDlg.form.groups[i - 1].members.length }" @click="svOpenMembers(i - 1)">
                      <span class="sv-pick-t">{{ surveyDlg.form.groups[i - 1].members.length ? svMembersText(surveyDlg.form.groups[i - 1]) : '选择本组人员' }}</span>
                      <svg class="sv-pick-i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 9.5 12 15l5.5-5.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" /></svg>
                    </button>
                  </span>
                </div>
                <!-- 已选人员：一人一枚可移除的 chip，避免「只看见人数、看不见是谁」 -->
                <div v-if="surveyDlg.form.groups[i - 1].leader || surveyDlg.form.groups[i - 1].members.length" class="sv-gwho">
                  <span v-if="surveyDlg.form.groups[i - 1].leader" class="sv-mchip sv-mchip-lead">{{ surveyDlg.form.groups[i - 1].leader }}<i class="sv-mchip-tag">组长</i></span>
                  <span v-for="n in surveyDlg.form.groups[i - 1].members" :key="n" class="sv-mchip">{{ n }}<i class="sv-mchip-x" title="移出本组" @click.stop="svRemoveMember(i - 1, n)">×</i></span>
                </div>
                <el-input v-model="surveyDlg.form.groups[i - 1].workLocation" type="textarea" :rows="2" placeholder="工作地点" class="sv-gtext" />
                <el-input v-model="surveyDlg.form.groups[i - 1].workTask" type="textarea" :rows="2" placeholder="工作内容" class="sv-gtext" />
              </div>
            </template>
          </div>

          <el-form-item>
            <template #label>
              <span class="sv-lab">4.1 工作地点需要停电的范围<span v-if="svBadges.outageScope" class="sv-chip" :class="'sv-' + svBadges.outageScope.cls">{{ svBadges.outageScope.text }}</span></span>
            </template>
            <el-input v-model="surveyDlg.form.outageScope" type="textarea" :rows="3" placeholder="请填写需要停电的范围" />
          </el-form-item>

          <el-form-item>
            <template #label>
              <span class="sv-lab">4.2 保留的带电部位<span v-if="svBadges.retainedLive" class="sv-chip" :class="'sv-' + svBadges.retainedLive.cls">{{ svBadges.retainedLive.text }}</span></span>
            </template>
            <el-input v-model="surveyDlg.form.retainedLive" type="textarea" :rows="3" placeholder="不在停电范围的带电部位请手动填入" />
          </el-form-item>

          <!-- ===== 4.3 作业现场的条件、环境及其他危险点（四期第二步：环境描述 + 危险点条目组） ===== -->
          <div class="sv-sec">
            <!-- 标题与「应注明…」是同一段标题文字：同字号同字重同色，连续折行，不做副标题 -->
            <div class="shp-head">4.3作业现场的条件、环境及其他危险点（应注明：交叉、邻近（同杆塔、并行）电力线路；多电源、自发电情况，有可能反送电的设备和分支线；地下管网沟道及其他影响施工作业的设施情况）</div>

            <el-form-item>
              <template #label>
                <span class="sv-lab">环境描述<span v-if="svBadges.envDesc" class="sv-chip" :class="'sv-' + svBadges.envDesc.cls">{{ svBadges.envDesc.text }}</span></span>
              </template>
              <el-input v-model="surveyDlg.form.envDesc" type="textarea" :rows="3" placeholder="请输入环境描述" />
            </el-form-item>

            <div class="shp-sub" :class="{ 'shp-sub-c': svGrouped }">
              <span class="shp-sub-t">4.3 危险点及对应安全措施</span>
            </div>

            <div v-if="!surveyDlg.form.hazardPoints.length" class="survey-hp-empty">尚未添加危险点：可从下方搜索危险点库添加，或新增自定义危险点</div>
            <div v-for="(hp, i) in surveyDlg.form.hazardPoints" :key="hp.id" :id="'hp-' + hp.id" class="survey-hp" :class="{ 'hp-err': surveyDlg.errId === hp.id, 'hp-open': !!hpOpen[hp.id] }">
              <div class="survey-hp-bar" @click="toggleHp(hp)">
                <span class="shp-no">（{{ i + 1 }}）</span>
                <span class="survey-hp-title" :class="{ 'shp-title-edit': !hp.hazardId }" :title="hp.hazardId ? hp.title : '点击修改标题'" @click="onTitleClick(hp, $event)">{{ hp.title || '（未命名危险点）' }}</span>
                <span v-if="svGrouped" class="sv-chip sv-split sv-scope-chip">{{ hpScopeOf(hp.scope) }}</span>
                <div class="survey-hp-acts">
                  <el-button size="small">{{ hpOpen[hp.id] ? '收起详情' : '展开详情' }}</el-button>
                  <el-button size="small" :disabled="i === 0" @click.stop="moveHazard(hp, -1)">上移</el-button>
                  <el-button size="small" :disabled="i === surveyDlg.form.hazardPoints.length - 1" @click.stop="moveHazard(hp, 1)">下移</el-button>
                  <el-button size="small" type="danger" plain @click.stop="removeHazard(hp)">删除</el-button>
                </div>
              </div>
              <div v-show="hpOpen[hp.id]" class="shp-body">
                <div v-if="svGrouped" class="shp-scope-row">
                  <span class="shp-scope-lab">所属小组</span>
                  <el-select v-model="hp.scope" size="small" class="shp-scope">
                    <el-option v-for="s in hpScopeOpts" :key="s" :label="s" :value="s" />
                  </el-select>
                </div>
                <el-input v-model="hp.situation" type="textarea" :rows="2" placeholder="4.3中的现场具体情况（可选）" />
                <el-input v-model="hp.measure" type="textarea" :rows="3" placeholder="对应安全措施（必填）" />
                <div class="shp-foot">
                  <span class="shp-src" :class="hp.hazardId ? 'shp-src-lib' : 'shp-src-mine'">{{ hp.hazardId ? '危险点库' : '自定义' }}</span>
                  <el-button v-if="hp.hazardId" size="small" :disabled="!canRestoreMeasure(hp)" @click="restoreMeasure(hp)">恢复标准措施</el-button>
                </div>
              </div>
            </div>

            <div class="survey-add">
              <el-select v-model="hazardPick" filterable clearable class="shp-pick" placeholder="搜索危险点库，例如：邻近、跨越" @change="addHazardFromLib">
                <el-option-group v-for="g in hazardGroups" :key="g.label" :label="g.label">
                  <el-option v-for="h in g.items" :key="h.id" :label="h.hazard" :value="h.id" />
                </el-option-group>
              </el-select>
              <el-button @click="addCustomHazard">新增自定义危险点</el-button>
            </div>
          </div>

          <!-- ===== 4.4 两组措施 / 10kV、0.4kV 接地线 / 勘察日期（四期第三步；记录人与通用措施在 4b 生成时处理） ===== -->
          <el-form-item>
            <template #label>
              <span class="sv-lab">4.4 运维人员采取的安全措施<span v-if="svBadges.opsMeasures" class="sv-chip" :class="'sv-' + svBadges.opsMeasures.cls">{{ svBadges.opsMeasures.text }}</span></span>
            </template>
            <el-input v-model="surveyDlg.form.opsMeasures" type="textarea" :rows="3" placeholder="请填写运维人员采取的安全措施" />
          </el-form-item>

          <el-form-item>
            <template #label>
              <span class="sv-lab">4.4 班组应采取的安全措施<span v-if="svGrouped" class="sv-chip sv-split">每条选择一个小组</span><span v-else-if="svBadges.teamMeasures" class="sv-chip" :class="'sv-' + svBadges.teamMeasures.cls">{{ svBadges.teamMeasures.text }}</span></span>
            </template>
            <div class="sx-block">
              <el-input v-model="surveyDlg.form.teamMeasures" type="textarea" :rows="4" placeholder="每行一条措施；分组时可在下方逐行设置所属小组" @input="v => onScopeTextInput('teamMeasures', 'teamMeasureScopes', v)" />
              <div v-if="svGrouped && sxLines(surveyDlg.form.teamMeasures).length" class="sx-lines">
                <div class="sx-lines-head">逐行设置所属小组（共 {{ sxLines(surveyDlg.form.teamMeasures).length }} 条）</div>
                <div v-for="(ln, i) in sxLines(surveyDlg.form.teamMeasures)" :key="'tm-' + i" class="sx-line">
                  <span class="sx-line-no">{{ i + 1 }}.</span>
                  <span class="sx-line-txt" :title="ln">{{ ln }}</span>
                  <el-select v-model="surveyDlg.form.teamMeasureScopes[i]" size="small" class="sx-line-scope">
                    <el-option v-for="s in hpScopeOpts" :key="s" :label="s" :value="s" />
                  </el-select>
                </div>
              </div>
            </div>
          </el-form-item>

          <el-form-item>
            <template #label>
              <span class="sv-lab">10kV 接地线位置（每行一个）<span v-if="svGrouped" class="sv-chip sv-split">每条选择一个小组</span><span v-else-if="svBadges.ground10" class="sv-chip" :class="'sv-' + svBadges.ground10.cls">{{ svBadges.ground10.text }}</span></span>
            </template>
            <div class="sx-block">
              <el-input v-model="surveyDlg.form.ground10" type="textarea" :rows="3" placeholder="请输入10kV接地线位置，每行一个" @input="v => onScopeTextInput('ground10', 'ground10Scopes', v)" />
              <div v-if="svGrouped && sxLines(surveyDlg.form.ground10).length" class="sx-lines">
                <div class="sx-lines-head">逐行设置所属小组（共 {{ sxLines(surveyDlg.form.ground10).length }} 处）</div>
                <div v-for="(ln, i) in sxLines(surveyDlg.form.ground10)" :key="'g10-' + i" class="sx-line">
                  <span class="sx-line-no">{{ i + 1 }}.</span>
                  <span class="sx-line-txt" :title="ln">{{ ln }}</span>
                  <el-select v-model="surveyDlg.form.ground10Scopes[i]" size="small" class="sx-line-scope">
                    <el-option v-for="s in hpScopeOpts" :key="s" :label="s" :value="s" />
                  </el-select>
                </div>
              </div>
            </div>
          </el-form-item>

          <el-form-item>
            <template #label>
              <span class="sv-lab">0.4kV 接地线位置（每行一个）<span v-if="svGrouped" class="sv-chip sv-split">每条选择一个小组</span><span v-else-if="svBadges.ground04" class="sv-chip" :class="'sv-' + svBadges.ground04.cls">{{ svBadges.ground04.text }}</span></span>
            </template>
            <div class="sx-block">
              <el-input v-model="surveyDlg.form.ground04" type="textarea" :rows="3" placeholder="请输入0.4kV接地线位置，每行一个" @input="v => onScopeTextInput('ground04', 'ground04Scopes', v)" />
              <div v-if="svGrouped && sxLines(surveyDlg.form.ground04).length" class="sx-lines">
                <div class="sx-lines-head">逐行设置所属小组（共 {{ sxLines(surveyDlg.form.ground04).length }} 处）</div>
                <div v-for="(ln, i) in sxLines(surveyDlg.form.ground04)" :key="'g04-' + i" class="sx-line">
                  <span class="sx-line-no">{{ i + 1 }}.</span>
                  <span class="sx-line-txt" :title="ln">{{ ln }}</span>
                  <el-select v-model="surveyDlg.form.ground04Scopes[i]" size="small" class="sx-line-scope">
                    <el-option v-for="s in hpScopeOpts" :key="s" :label="s" :value="s" />
                  </el-select>
                </div>
              </div>
            </div>
          </el-form-item>

          <el-form-item>
            <template #label>
              <span class="sv-lab">勘察日期<span v-if="svBadges.surveyDate" class="sv-chip" :class="'sv-' + svBadges.surveyDate.cls">{{ svBadges.surveyDate.text }}</span></span>
            </template>
            <el-date-picker v-model="surveyDlg.form.surveyDate" type="date" value-format="YYYY-MM-DD" format="YYYY年M月D日" placeholder="请选择勘察日期" class="sx-date" />
          </el-form-item>
        </el-form>
      </div>
      <template #footer>
        <div class="sv-foot">
          <el-button :loading="surveyDlg.saving" @click="saveSurvey">保存在线编辑内容</el-button>
          <el-button type="primary" :loading="surveyDlg.generating" :disabled="surveyDlg.saving" @click="saveAndGenerate">{{ surveyDlg.generating ? '生成中…' : '保存并生成 现场勘察记录' }}</el-button>
          <el-button @click="openMaterialsFromEditor">打开作业资料</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- ===== 小组人员选择弹窗：小组长（技工单选）/ 本组人员（技工·民工分组多选，组长固定勾选） ===== -->
    <el-dialog v-model="svPick.visible" :title="svPickTitle" width="min(560px, 94%)" top="7vh" append-to-body class="svp-dlg" :close-on-click-modal="false">
      <div class="svp-sub">{{ svPick.mode === 'leader' ? '仅技工可担任小组长；已被其他小组选用的人员不可重复选择。' : '小组长固定选中；其他小组的人员不可重复选择。' }}</div>
      <div v-if="svPick.mode === 'members'" class="svp-tools">
        <el-checkbox :model-value="svPickAllOn" :indeterminate="svPickSomeOn" @change="svToggleAll">全选可用人员</el-checkbox>
        <span class="svp-count">已选 {{ svPick.draft.length }} 人</span>
      </div>
      <el-input v-if="svPeopleList.length > 6" v-model="svPick.q" size="small" clearable placeholder="搜索姓名或班组" class="svp-q" />
      <div class="svp-body">
        <div v-for="sec in svPickGroups" :key="sec.name" class="svp-sec">
          <div class="svp-sec-h">
            <span class="svp-sec-t">{{ sec.name }}</span>
            <span class="svp-sec-n">{{ svPick.mode === 'leader' ? '共 ' + sec.rows.length + ' 人' : sec.rows.filter(r => r.on).length + ' / ' + sec.rows.length }}</span>
          </div>
          <div class="svp-grid">
            <button v-for="r in sec.rows" :key="r.name" type="button" class="svp-item" :class="{ on: r.on, off: r.disabled, radio: svPick.mode === 'leader' }" :disabled="r.disabled" @click="svToggleRow(r)">
              <span class="svp-box"><svg v-if="r.on" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.4 6.3 4.9 8.8 9.6 3.6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" /></svg></span>
              <span class="svp-name">{{ r.name }}</span>
              <span v-if="r.isLeader" class="svp-tag svp-tag-lead">小组长</span>
              <span v-else-if="r.takenBy" class="svp-tag">{{ r.takenBy }}</span>
              <span v-else-if="r.team && svMultiTeam" class="svp-team">{{ r.team }}</span>
            </button>
          </div>
        </div>
        <div v-if="!svPickGroups.length" class="svp-empty">{{ svPeopleList.length ? '没有匹配的人员' : '作业人员名单中暂无可用人员，请先在「用户管理 - 作业人员名单」维护' }}</div>
      </div>
      <template #footer>
        <div class="svp-foot">
          <el-button v-if="svPick.mode === 'leader' && svPick.leader" text class="svp-clear" @click="svPick.leader = ''">清空选择</el-button>
          <span class="svp-foot-r">
            <el-button @click="svPick.visible = false">取 消</el-button>
            <el-button type="primary" @click="svConfirmPick">确 定</el-button>
          </span>
        </div>
      </template>
    </el-dialog>
  </div>`
};
/* ===== 日期时间选择器：日历 + 时/分/秒三列 + 此刻/确定（对齐原系统截图，用于计划开始/结束时间） ===== */
const PlanDateTime = {
  props: {
    modelValue: { type: String, default: '' },
    placeholder: { type: String, default: '请选择日期' },
    disabled: { type: Boolean, default: false }
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    const { ref, reactive, computed, nextTick, onBeforeUnmount } = Vue;
    const pad = n => String(n).padStart(2, '0');
    // 星期表头按全局「星期开始于」(getDay 口径 0=周日..6=周六) 旋转；默认值 1 时与旧版一致
    const WEEK = computed(() => {
      const ws = (window.normWeekStart ? window.normWeekStart(window.WeekStart && window.WeekStart.value) : 1);
      const order = ['日', '一', '二', '三', '四', '五', '六']; // order[getDay()] = 星期标签
      const out = [];
      for (let i = 0; i < 7; i++) out.push(order[(ws + i) % 7]);
      return out;
    });
    const HOURS = Array.from({ length: 24 }, (_, i) => pad(i));
    const MINUTES = Array.from({ length: 60 }, (_, i) => pad(i));
    const SECONDS = Array.from({ length: 60 }, (_, i) => pad(i));
    // 无限循环滚动：同一组数值重复 5 份，打开时定位到中间一份；越出后在滚动停止时按整周期跳回等值位置
    const ROW = 36;             // 单元格行高（与 .pdt-cell 样式保持一致）
    const BAND_TOP = ROW * 3;   // 选中带顶边 = 第 4 行（可视 7 行）
    const REPEAT = 5;           // 重复份数（前后各留 2 份余量）
    const rep = arr => { const out = []; for (let c = 0; c < REPEAT; c++) arr.forEach(v => out.push(v)); return out; };
    const HOURS_REP = rep(HOURS), MINUTES_REP = rep(MINUTES), SECONDS_REP = rep(SECONDS);
    const open = ref(false);
    const triggerEl = ref(null);
    const panelEl = ref(null);
    const colH = ref(null); const colM = ref(null); const colS = ref(null);
    const colRef = { h: colH, mi: colM, s: colS };
    const colList = { h: HOURS, mi: MINUTES, s: SECONDS };
    const colSelKey = { h: 'h', mi: 'mi', s: 's' };
    const sync = { h: false, mi: false, s: false };   // 程序滚动期间不回读，避免自激
    const timers = { h: 0, mi: 0, s: 0 };
    const pos = reactive({ top: 0, left: 0, width: 460 });
    const now0 = new Date();
    const view = reactive({ y: now0.getFullYear(), m: now0.getMonth() + 1 });
    const sel = reactive({ y: 0, m: 0, d: 0, h: 0, mi: 0, s: 0, has: false });

    function parse(v) {
      const t = String(v == null ? '' : v).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
      if (!t) return null;
      return { y: +t[1], m: +t[2], d: +t[3], h: t[4] ? +t[4] : 0, mi: t[5] ? +t[5] : 0, s: t[6] ? +t[6] : 0 };
    }
    const text = computed(() => {
      const p = parse(props.modelValue);
      return p ? p.y + '-' + pad(p.m) + '-' + pad(p.d) + ' ' + pad(p.h) + ':' + pad(p.mi) + ':' + pad(p.s) : '';
    });
    const cells = computed(() => {
      // 月首偏移按全局「星期开始于」旋转：lead = (当月1号周几 - weekStart + 7) % 7
      const ws = (window.normWeekStart ? window.normWeekStart(window.WeekStart && window.WeekStart.value) : 1);
      const lead = ((new Date(view.y, view.m - 1, 1).getDay()) - ws + 7) % 7;
      const list = [];
      for (let i = 0; i < 42; i++) {
        const d = new Date(view.y, view.m - 1, 1 - lead + i);
        list.push({ y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), cur: d.getMonth() + 1 === view.m });
      }
      return list;
    });
    function isToday(c) {
      const t = new Date();
      return c.y === t.getFullYear() && c.m === t.getMonth() + 1 && c.d === t.getDate();
    }
    function isSel(c) { return sel.has && sel.y === c.y && sel.m === c.m && sel.d === c.d; }
    function move(n) {
      const d = new Date(view.y, view.m - 1 + n, 1);
      view.y = d.getFullYear(); view.m = d.getMonth() + 1;
    }
    function applyPos() {
      const el = triggerEl.value; if (!el) return;
      const r = el.getBoundingClientRect();
      const pw = Math.min(460, window.innerWidth - 24);
      const ph = panelEl.value ? panelEl.value.offsetHeight : 338;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8));
      let top = r.bottom + 6;
      if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
      pos.width = pw; pos.left = left; pos.top = top;
    }
    // 把某一列滚到「中间一份 + 当前值」的位置，使该值落在选中带上
    function scrollValueToBand(kind, value, smooth) {
      const el = colRef[kind].value; if (!el) return;
      const n = colList[kind].length;
      const top = (2 * n + Number(value || 0)) * ROW - BAND_TOP;
      if (smooth && el.scrollTo) el.scrollTo({ top, behavior: 'smooth' });
      else el.scrollTop = top;
    }
    // 滚动中：只做防抖，不动 scrollTop（否则会打断惯性）
    function onColScroll(kind) {
      clearTimeout(timers[kind]);
      timers[kind] = setTimeout(() => snapCol(kind), 150);
    }
    // 滚动停止：先按整周期归位到中间一份（内容重复，视觉无感），再把最近的数值吸附到选中带
    function snapCol(kind) {
      const el = colRef[kind].value; if (!el || sync[kind]) return;
      const n = colList[kind].length, period = n * ROW, base = 2 * period - BAND_TOP;
      const rel = (((el.scrollTop - base) % period) + period) % period;
      if (Math.abs(rel - (el.scrollTop - base)) > 0.5) el.scrollTop = base + rel;
      const i = Math.max(0, Math.min(Math.round((el.scrollTop + BAND_TOP) / ROW), n * REPEAT - 1));
      pickTime(colSelKey[kind], pad(i % n));
      const top = i * ROW - BAND_TOP;
      if (Math.abs(el.scrollTop - top) > 0.5) {
        sync[kind] = true;
        el.scrollTo({ top, behavior: 'smooth' });
        setTimeout(() => { sync[kind] = false; }, 300);
      }
    }
    // 点某一格：选离当前位置最近的一份同值格，平滑滚到带上
    function pickCell(kind, v) {
      const el = colRef[kind].value; if (!el) return;
      const n = colList[kind].length;
      const cur = Math.round((el.scrollTop + BAND_TOP) / ROW);
      const curVal = ((cur % n) + n) % n;
      const fwd = ((Number(v) - curVal) + n) % n;
      const delta = fwd <= n / 2 ? fwd : fwd - n;
      const target = Math.max(0, Math.min(cur + delta, n * REPEAT - 1));
      sync[kind] = true;
      el.scrollTo({ top: target * ROW - BAND_TOP, behavior: 'smooth' });
      pickTime(colSelKey[kind], v);
      setTimeout(() => { sync[kind] = false; }, 320);
    }
    function onDocDown(e) {
      if (panelEl.value && panelEl.value.contains(e.target)) return;
      if (triggerEl.value && triggerEl.value.contains(e.target)) return;
      close();
    }
    function onKey(e) {
      if (e.key !== 'Escape' || !open.value) return;
      // 只关选择器，不要把整个弹窗一起关掉（ElDialog 的 Esc 监听在 document 冒泡阶段）
      e.stopPropagation(); e.preventDefault();
      close();
    }
    function bindEvents() {
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', applyPos);
      window.addEventListener('scroll', applyPos, true);
    }
    function unbindEvents() {
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', applyPos);
      window.removeEventListener('scroll', applyPos, true);
    }
    function doOpen() {
      if (props.disabled) return;
      const p = parse(props.modelValue);
      if (p) Object.assign(sel, p, { has: true });
      else Object.assign(sel, { y: 0, m: 0, d: 0, h: 0, mi: 0, s: 0, has: false });
      const t = new Date();
      view.y = p ? p.y : t.getFullYear();
      view.m = p ? p.m : t.getMonth() + 1;
      open.value = true;
      applyPos(); bindEvents();
      nextTick(() => {
        applyPos();
        ['h', 'mi', 's'].forEach(kind => {
          if (!colRef[kind].value) return;
          sync[kind] = true;
          scrollValueToBand(kind, sel.has ? sel[colSelKey[kind]] : 0, false);
          // 打开时的定位不算用户滚动：屏蔽到防抖窗口之后再放行，避免空值时被自动「选中」
          setTimeout(() => { sync[kind] = false; }, 350);
        });
      });
    }
    function close() { open.value = false; unbindEvents(); }
    function toggle() { open.value ? close() : doOpen(); }
    function pickDay(c) {
      sel.y = c.y; sel.m = c.m; sel.d = c.d; sel.has = true;
      if (c.m !== view.m || c.y !== view.y) { view.y = c.y; view.m = c.m; }
    }
    function pickTime(key, v) {
      sel[key] = Number(v);
      if (!sel.has) {
        const t = new Date();
        sel.y = t.getFullYear(); sel.m = t.getMonth() + 1; sel.d = t.getDate(); sel.has = true;
      }
    }
    function confirm() {
      if (!sel.has) return;
      emit('update:modelValue', sel.y + '-' + pad(sel.m) + '-' + pad(sel.d) + ' ' + pad(sel.h) + ':' + pad(sel.mi) + ':' + pad(sel.s));
      close();
    }
    function pickNow() {
      const t = new Date();
      Object.assign(sel, { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate(), h: t.getHours(), mi: t.getMinutes(), s: t.getSeconds(), has: true });
      view.y = sel.y; view.m = sel.m;
      confirm();
    }
    function clear() { emit('update:modelValue', ''); }
    onBeforeUnmount(unbindEvents);

    return { pad, WEEK, HOURS_REP, MINUTES_REP, SECONDS_REP, open, triggerEl, panelEl, colH, colM, colS, pos, view, sel, text, cells, isToday, isSel, move, toggle, close, pickDay, pickTime, confirm, pickNow, clear, onColScroll, pickCell };
  },
  template: `
  <div class="pdt" :class="{ 'is-open': open }">
    <div class="pdt-input" :class="{ 'is-empty': !text, 'is-disabled': disabled }" ref="triggerEl" tabindex="0" @click="toggle" @keydown.enter.prevent="toggle" @keydown.space.prevent="toggle">
      <span class="pdt-text">{{ text || placeholder }}</span>
      <span v-if="text && !disabled" class="pdt-clear" title="清空" @click.stop="clear">
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </span>
      <span class="pdt-ico" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="16" height="16"><rect x="3.6" y="5.4" width="16.8" height="15" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3.6 10.2h16.8M8.2 3.4v3.6M15.8 3.4v3.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </span>
    </div>
    <teleport to="body">
      <div v-if="open" class="pdt-panel" ref="panelEl" :style="{ top: pos.top + 'px', left: pos.left + 'px', width: pos.width + 'px' }">
        <div class="pdt-body">
          <div class="pdt-cal">
            <div class="pdt-head">
              <button type="button" class="pdt-nav" title="上一年" @click="move(-12)">«</button>
              <button type="button" class="pdt-nav" title="上个月" @click="move(-1)">‹</button>
              <div class="pdt-title"><span>{{ view.y }}年</span><span>{{ view.m }}月</span></div>
              <button type="button" class="pdt-nav" title="下个月" @click="move(1)">›</button>
              <button type="button" class="pdt-nav" title="下一年" @click="move(12)">»</button>
            </div>
            <div class="pdt-week"><span v-for="w in WEEK" :key="w">{{ w }}</span></div>
            <div class="pdt-grid">
              <div v-for="(c, i) in cells" :key="i" class="pdt-day" :class="{ out: !c.cur, today: isToday(c), on: isSel(c) }" @click="pickDay(c)">{{ c.d }}</div>
            </div>
          </div>
          <div class="pdt-time">
            <div class="pdt-time-head"><span>时</span><span>分</span><span>秒</span></div>
            <div class="pdt-cols">
              <div class="pdt-band" aria-hidden="true"></div>
              <div class="pdt-col" ref="colH" @scroll="onColScroll('h')">
                <div v-for="(h, i) in HOURS_REP" :key="'h' + i" class="pdt-cell" :class="{ on: sel.has && pad(sel.h) === h }" @click="pickCell('h', h)">{{ h }}</div>
              </div>
              <div class="pdt-col" ref="colM" @scroll="onColScroll('mi')">
                <div v-for="(m, i) in MINUTES_REP" :key="'m' + i" class="pdt-cell" :class="{ on: sel.has && pad(sel.mi) === m }" @click="pickCell('mi', m)">{{ m }}</div>
              </div>
              <div class="pdt-col" ref="colS" @scroll="onColScroll('s')">
                <div v-for="(s, i) in SECONDS_REP" :key="'s' + i" class="pdt-cell" :class="{ on: sel.has && pad(sel.s) === s }" @click="pickCell('s', s)">{{ s }}</div>
              </div>
            </div>
          </div>
        </div>
        <div class="pdt-foot">
          <button type="button" class="pdt-now" @click="pickNow">此刻</button>
          <button type="button" class="pdt-ok" :disabled="!sel.has" @click="confirm">确定</button>
        </div>
      </div>
    </teleport>
  </div>`
};
