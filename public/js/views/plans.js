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
    const TICKET_TYPES = ['配电：配电第一种工作票', '配电：配电第二种工作票', '低压：低压工作票', '线路：线路第一种工作票', '线路：线路第二种工作票', '配电：低压工作票'];
    const VOLTAGE_LEVELS = ['0.4kV', '10kV', '20kV', '35kV', '110kV', '220kV'];
    const WORK_TYPES = ['配农网工程', '生产检修改造', '外部工程', '业扩工程', '迁改工程', '借工'];
    const SPECIALTIES = ['运检', '营销'];
    const DEPTS = ['设备部', '产业部'];
    // 风险因素 = 9 个固定大类（规范文件危险点库的分类口径）；风险管控措施按所选大类从库的对应明细自动带出，非硬编码
    const RISK_CATEGORIES = ['有限空间', '机械伤害', '起重伤害', '触电', '高处坠落', '倒塔/坍塌', '跨越风险', '物体打击', '动火作业'];
    const riskFactors = ref(RISK_CATEGORIES.slice());   // 下拉选项：9 个风险大类
    const hazardLibrary = ref([]);                      // 危险点库全部明细（含 category 字段）
    const substations = ref([]);                        // 属地供电所（全局设置）
    const units = ref([]);                              // 单位维护（分包/兄弟/监理/抄送）
    function unitsByType(type) { return units.value.filter(u => u.type === type); }
    async function loadHazards() {
      try {
        const d = await api.get('/api/documents');
        hazardLibrary.value = ((d && d.hazardLibrary) || []).slice().sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
      } catch (e) {}
      try {
        const r = await api.get('/api/substations');
        substations.value = (Array.isArray(r) ? r : (r.data || [])).slice().sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
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
    const projects = ref([]); const projectsFull = ref([]); const teams = ref([]); const workers = ref([]);
    const filters = reactive({ startDate: '', endDate: '', name: '', content: '', noProject: false, team: '', leader: '', ticketType: '', projectScope: [] });
    const page = ref(1); const pageSize = ref(20);
    const dlg = reactive({ visible: false, editingId: null, form: null });
    const emptyForm = () => ({
      name: '', content: '', shadowContent: '', planType: '周计划',
      project: '', subProject: '', workType: '配农网工程',
      startDate: '', endDate: '', specialty: '运检', dept: '设备部',
      voltage: '10kV', ticketType: '配电：配电第一种工作票',
      address: '', station: '', machine: '是', riskLevel: '四级', controlMeasures: '',
      gridRisk: '无', riskFactors: [], majorRisk: '无',
      buildCity: '', buildCounty: '', execCity: '', execCounty: '',
      substation: '', subcontractors: [], supervisor: '', ccUnits: [],
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
      try { const r = await api.get('/api/teams'); teams.value = (Array.isArray(r) ? r : (r.data || [])).map(t => t.name).filter(Boolean); } catch (e) {}
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
        body.name = (row.name || '') + '（副本）'; body.status = '未执行';
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
    async function notePlan(row) {
      try {
        const { value } = await ElementPlus.ElMessageBox.prompt('请输入备注内容', '备注', { inputValue: row.planNote || '', inputType: 'textarea', inputPlaceholder: '选填' });
        await api.put('/api/workPlans/' + row.id, { planNote: value || '' });
        ElementPlus.ElMessage.success('备注已保存'); load();
      } catch (e) { if (e !== 'cancel') ElementPlus.ElMessage.error(e.message || '已取消'); }
    }
    function addMaterialFor(row) { ElementPlus.ElMessage.info('请在「项目列表」对应项目详情中上传该计划的施工资料'); }
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
      dlg.editingId = null; dlg.form = emptyForm();
      // 计划类型跟随当前所在 tab：月计划管理 tab 新增存为月计划，其余存周计划
      dlg.form.planType = tab.value === 'month' ? '月计划' : '周计划';
      // 从项目详情跳转过来时，关联项目默认带入（避免新增后因项目筛选而"消失"）
      if (filters.projectScope.length) dlg.form.project = filters.projectScope[0];
      // 作业单位联动：分包与监理默认排序第一条，抄送默认排序前两条；建管/实施单位留空由用户自行编辑
      const fb = unitsByType('分包单位'); if (fb.length) dlg.form.subcontractors = [fb[0].name];
      const sj = unitsByType('监理单位'); if (sj.length) dlg.form.supervisor = sj[0].name;
      const cs = unitsByType('抄送单位'); if (cs.length) dlg.form.ccUnits = cs.slice(0, 2).map(u => u.name);
      // 编号规则：年+月+流水号，自动带出年+月（如 202610），流水号由用户续填
      const d0 = new Date();
      const ym = d0.getFullYear() + String(d0.getMonth() + 1).padStart(2, '0');
      dlg.form.surveyNo = ym; dlg.form.workTicketNo = ym;
      dlg.visible = true;
    }
    function openEdit(row) {
      dlg.editingId = row.id; dlg.form = JSON.parse(JSON.stringify(row)); dlg.visible = true;
      if (!dlg.form.controlMeasures && (dlg.form.riskFactors || []).length) dlg.form.controlMeasures = genMeasures(dlg.form.riskFactors);
      // 字段规范化（老数据补齐）
      ['subcontractors', 'ccUnits', 'chargePersons'].forEach(k => { if (!Array.isArray(dlg.form[k])) dlg.form[k] = []; });
      ['staffText', 'teamLeader', 'staffCount', 'highStaff', 'gasTester', 'guardian', 'chargePerson', 'chargePersonPhone', 'arrivalPersons', 'safetyPatrol', 'wlPole', 'wlLine1035', 'wlCable', 'wlRing', 'wlVacuum', 'wlTransformer', 'wlLine04', 'outageRange', 'outageHours', 'surveyNo', 'workTicketNo'].forEach(k => { if (dlg.form[k] === undefined || dlg.form[k] === null) dlg.form[k] = ''; });
    }
    async function submit() {
      const f = dlg.form;
      // 统一为 YYYY-MM-DD HH:mm:ss（历史数据为 HH:mm），保证下面的字符串比较与导出稳定
      const normDT = v => (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(v || '').trim()) ? String(v).trim() + ':00' : v);
      f.startDate = normDT(f.startDate); f.endDate = normDT(f.endDate);
      if (!String(f.name || '').trim()) { ElementPlus.ElMessage.warning('请填写作业计划名称'); return; }
      if (!f.startDate || !f.endDate) { ElementPlus.ElMessage.warning('请选择计划开始/结束日期'); return; }
      if (f.endDate < f.startDate) { ElementPlus.ElMessage.warning('计划结束日期不能早于开始日期'); return; }
      if (!f.substation) { ElementPlus.ElMessage.warning('请选择作业班组（属地供电所）'); return; }
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
        // 施工班组首行同步到列表的作业班组/班组长展示字段
        if (Array.isArray(f.teams) && f.teams.length) {
          if (f.teams[0].team) body.team = f.teams[0].team;
          if (f.teams[0].leader) body.leader = f.teams[0].leader;
        }
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

    return { TABS, tab, list, loading, projects, projectsFull, teams, workers, riskFactors, filters, page, pageSize, paged, filtered, scopeLabel, clearProjectScope, dlg, upcoming, calendarDays, fmtDT, dash, rowClass, copyPlan, execPlan, cancelPlan, notePlan, addMaterialFor, TICKET_TYPES, VOLTAGE_LEVELS, WORK_TYPES, SPECIALTIES, DEPTS, RISK_LEVELS, GRID_RISKS, MAJOR_RISKS, genMeasures, subProjectOptions, substations, unitsByType, workersFull, contacts, staffPick, groupedTeams, staffKey, openStaffPick, confirmStaffPick, toggleIdentity, onChargePersonInput, oneKeyFill, load, onTab, openAdd, openEdit, onProjectSelect, submit, remove, importPlans, exportPlans, qtyDlg, QTY_FIELDS, openQuantities, submitQuantities };
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
        <el-table-column type="index" label="序号" width="50" align="center" />
        <el-table-column prop="name" label="作业计划名称" min-width="160" show-overflow-tooltip />
        <el-table-column prop="team" label="作业班组" min-width="100" show-overflow-tooltip :formatter="(r,c,v)=>dash(v)" />
        <el-table-column prop="leader" label="班组长" width="84" :formatter="(r,c,v)=>dash(v)" />
        <el-table-column prop="startDate" label="计划开始" width="100" :formatter="(r,c,v)=>fmtDT(v)" />
        <el-table-column prop="endDate" label="计划结束" width="100" :formatter="(r,c,v)=>fmtDT(v)" />
        <el-table-column prop="ticketType" label="工作票类型" min-width="140" show-overflow-tooltip :formatter="(r,c,v)=>dash(v)" />
        <el-table-column prop="voltage" label="电压等级" width="84" align="center" :formatter="(r,c,v)=>dash(v)" />
        <el-table-column prop="station" label="变电站/线路" min-width="110" show-overflow-tooltip :formatter="(r,c,v)=>dash(v)" />
        <el-table-column prop="chargePerson" label="工作负责人" width="96" show-overflow-tooltip :formatter="(r,c,v)=>dash(v)" />
        <el-table-column prop="chargePersonPhone" label="工作负责人联系电话" width="142" show-overflow-tooltip :formatter="(r,c,v)=>dash(v)" />
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{row}">
            <div v-if="canWrite('plans')" class="plan-acts">
              <el-button link type="warning" size="small" @click="addMaterialFor(row)">添加资料</el-button>
              <el-button link type="warning" size="small" @click="openEdit(row)">编辑</el-button>
              <el-button link type="warning" size="small" @click="copyPlan(row)">复制</el-button>
              <el-button link type="warning" size="small" @click="execPlan(row)">执行</el-button>
              <el-button link type="warning" size="small" @click="notePlan(row)">备注</el-button>
              <el-button link type="danger" size="small" @click="cancelPlan(row)">取消</el-button>
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
              <el-select v-model="dlg.form.ticketType" style="width:100%">
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
            <el-form-item label="作业班组（属地供电所）" required>
              <el-select v-model="dlg.form.substation" placeholder="请选择" filterable clearable style="width:100%">
                <el-option v-for="s in substations" :key="s.id || s.name" :label="s.name" :value="s.name" />
              </el-select>
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
              <el-input v-model="dlg.form.surveyNo" placeholder="年+月+流水号（年月已自动带出）" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="工作票编号">
              <el-input v-model="dlg.form.workTicketNo" placeholder="年+月+流水号（年月已自动带出）" />
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
    const WEEK = ['一', '二', '三', '四', '五', '六', '日'];
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
      // 以周一为首日：把 getDay()(周日=0) 折算成 0..6
      const lead = (new Date(view.y, view.m - 1, 1).getDay() + 6) % 7;
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
