/* ========== views/users ========== */
/* 用户管理相关视图：作业人员名单 WorkersPanel / WorkersView、账号 AccountsPanel、用户管理 UsersView 及其枚举常量。 */
/* 用户管理 — 标签页2：作业人员名单（对齐原系统截图） */
const WORKER_IDENTITY_OPTIONS = ['技工（计入高处作业人员）', '民工', '其他技工（不计入高处作业人员）'];
const WORKER_CERT_OPTIONS = ['高压电工', '低压电工', '高处', '电力电缆作业', '电气试验', '司索工', '吊车司机', '挖机操作工'];

const WorkersPanel = {
  // variant: 'page' = 独立二级页「作业人员与班组」（含卡片头与班组维护）
  //          'tab'  = 用户管理 → 作业人员名单标签（无卡片头、无班组区块，列含身份证号）
  props: { variant: { type: String, default: 'page' } },
  setup(props) {
    const isTab = computed(() => props.variant === 'tab');
    const list = ref([]);
    const teams = ref([]);
    const loading = ref(false);
    const filters = reactive({ name: '', identity: '', team: '' });
    const page = ref(1);
    const pageSize = 20;
    const dialogVisible = ref(false);
    const editing = ref(false);
    const form = reactive({ name: '', idNumber: '', phone: '', identity: '', team: '', certTypes: [], validRange: null });
    const fileInput = ref(null);
    // 班组维护（新增 / 编辑 / 删除）：班组即全局字典 teams，周计划选项对应 showOnDeploy
    const teamDlg = reactive({ visible: false, editing: false, busy: false, id: '', name: '', showOnDeploy: '展示', sort: 0, inWorkerList: '列入' });
    const sortedTeams = computed(() => [...teams.value].sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0)));
    function openTeamAdd() {
      Object.assign(teamDlg, { visible: true, editing: false, id: '', name: '', showOnDeploy: '展示', sort: sortedTeams.value.length, inWorkerList: '列入' });
    }
    function openTeamEdit(row) {
      Object.assign(teamDlg, {
        visible: true, editing: true, id: row.id, name: row.name || '',
        showOnDeploy: row.showOnDeploy || '展示', sort: Number(row.sort) || 0, inWorkerList: row.inWorkerList || '列入'
      });
    }
    async function saveTeam() {
      const name = (teamDlg.name || '').trim();
      if (!name) { ElementPlus.ElMessage.warning('请填写班组名称'); return; }
      teamDlg.busy = true;
      try {
        const payload = { name, showOnDeploy: teamDlg.showOnDeploy, inWorkerList: teamDlg.inWorkerList, sort: Number(teamDlg.sort) || 0 };
        if (teamDlg.editing) await api.put('/api/teams/' + teamDlg.id, payload);
        else await api.post('/api/teams', payload);
        ElementPlus.ElMessage.success('已保存');
        teamDlg.visible = false; load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { teamDlg.busy = false; }
    }
    async function removeTeam(row) {
      try { await ElementPlus.ElMessageBox.confirm('确认删除班组「' + row.name + '」？', '提示', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' }); }
      catch (e) { return; }
      try {
        await api.del('/api/teams/' + row.id);
        ElementPlus.ElMessage.success('已删除'); load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    // 「周计划选项」列：展示/隐藏 以「显示/隐藏」呈现（对齐截图口径）
    function weekOption(row) { return row.showOnDeploy === '隐藏' ? '隐藏' : '显示'; }

    async function load() {
      loading.value = true;
      try {
        list.value = await api.get('/api/workers');
        try { teams.value = await api.get('/api/teams'); } catch (e) { teams.value = []; }
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { loading.value = false; }
    }
    const filtered = computed(() => list.value.filter(w => {
      if (filters.name && !(w.name || '').includes(filters.name)) return false;
      if (filters.identity && w.identity !== filters.identity) return false;
      if (filters.team && w.team !== filters.team) return false;
      return true;
    }));
    const paged = computed(() => filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize));
    function resetFilters() { filters.name = ''; filters.identity = ''; filters.team = ''; page.value = 1; }

    function fmtCN(d) {
      if (!d) return '';
      const [y, m, dd] = d.split('-');
      return `${y}年${m}月${dd}日`;
    }
    function fmtValid(row) {
      if (!row.validStart && !row.validEnd) return '-';
      return (fmtCN(row.validStart) || '?') + (row.validEnd ? ' - ' + fmtCN(row.validEnd) : '');
    }
    function fmtCerts(row) {
      return (row.certTypes && row.certTypes.length) ? row.certTypes.join('；') : '-';
    }

    function openAdd() {
      Object.assign(form, { name: '', idNumber: '', phone: '', identity: '', team: '', certTypes: [], validRange: null });
      editing.value = false; dialogVisible.value = true;
    }
    function openEdit(row) {
      Object.assign(form, {
        name: row.name || '', idNumber: row.idNumber || '', phone: row.phone || '',
        identity: row.identity || '', team: row.team || '',
        certTypes: [...(row.certTypes || [])],
        validRange: (row.validStart && row.validEnd) ? [row.validStart, row.validEnd] : null,
        _id: row.id
      });
      editing.value = true; dialogVisible.value = true;
    }
    function validate() {
      if (!form.name.trim()) { ElementPlus.ElMessage.error('请填写姓名'); return false; }
      if (form.idNumber && !/^\d{17}[\dXx]$/.test(form.idNumber)) { ElementPlus.ElMessage.error('身份证号需为18位数字，末位可为X'); return false; }
      if (form.phone && !/^1\d{10}$/.test(form.phone)) { ElementPlus.ElMessage.error('电话号码需为11位手机号'); return false; }
      return true;
    }
    async function submit() {
      if (!validate()) return;
      const payload = {
        name: form.name.trim(), idNumber: form.idNumber.trim(), phone: form.phone.trim(),
        identity: form.identity, team: form.team, certTypes: form.certTypes,
        validStart: form.validRange ? form.validRange[0] : '',
        validEnd: form.validRange ? form.validRange[1] : ''
      };
      try {
        if (editing.value) await api.put('/api/workers/' + form._id, payload);
        else await api.post('/api/workers', payload);
        ElementPlus.ElMessage.success('已保存');
        dialogVisible.value = false; load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function togglePending(row) {
      const to = row.status === '待定' ? '已准入' : '待定';
      try {
        await api.put('/api/workers/' + row.id, { status: to });
        ElementPlus.ElMessage.success(to === '待定' ? '已移入待定库，该人员不再供周计划选择' : '已恢复准入');
        load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function remove(row) {
      try {
        await ElementPlus.ElMessageBox.confirm(`确认删除作业人员「${row.name}」？`, '提示', { type: 'warning' });
        await api.del('/api/workers/' + row.id);
        ElementPlus.ElMessage.success('已删除'); load();
      } catch (e) { if (e !== 'cancel') ElementPlus.ElMessage.error(e.message || '已取消'); }
    }

    function downloadTemplate() {
      const a = document.createElement('a');
      a.href = '/assets/worker_import_template.xlsx';
      a.download = '作业人员名单导入模板.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
    }
    function downloadExport() {
      const token = localStorage.getItem('erp_token');
      fetch('/api/workers/export', { headers: { Authorization: 'Bearer ' + token } })
        .then(r => { if (!r.ok) throw new Error('导出失败'); return r.blob(); })
        .then(blob => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob); a.download = '作业人员名单.xlsx'; a.click();
        })
        .catch(e => ElementPlus.ElMessage.error(e.message));
    }
    function triggerImport() { if (fileInput.value) fileInput.value.click(); }
    async function onFileChange(ev) {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!file) return;
      const fd = new FormData(); fd.append('file', file);
      try {
        const res = await fetch('/api/workers/import', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + localStorage.getItem('erp_token') },
          body: fd
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '导入失败');
        ElementPlus.ElMessage.success('成功导入 ' + data.added + ' 名作业人员');
        load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }

    onMounted(load);
    return { isTab, list, teams, sortedTeams, loading, filters, page, pageSize, filtered, paged, resetFilters, dialogVisible, editing, form, fileInput,
      openAdd, openEdit, submit, togglePending, remove, downloadTemplate, downloadExport, triggerImport, onFileChange, load,
      teamDlg, openTeamAdd, openTeamEdit, saveTeam, removeTeam, weekOption,
      fmtValid, fmtCerts, WORKER_IDENTITY_OPTIONS, WORKER_CERT_OPTIONS };
  },
  template: `
  <div>
    <input ref="fileInput" type="file" accept=".csv,.xls,.xlsx" style="display:none" @change="onFileChange" />

    <!-- 独立二级页：作业人员与班组 -->
    <div v-if="!isTab" class="wv-card">
      <div class="wv-head">
        <span class="wv-title">作业人员与班组</span>
        <div class="wv-actions">
          <el-button v-if="canWrite('users')" @click="openTeamAdd">新增班组</el-button>
          <el-button v-if="canWrite('users')" type="primary" @click="openAdd">新增人员</el-button>
          <el-button v-if="canWrite('users')" @click="triggerImport">选择文件导入</el-button>
          <el-button @click="downloadExport">下载</el-button>
          <el-button @click="downloadTemplate">下载模板</el-button>
          <el-button :loading="loading" @click="load">刷新人员</el-button>
        </div>
      </div>

      <div class="wv-body">
        <div class="wv-alert">
          <span class="wv-alert-icon">i</span>
          <div class="wv-alert-main">
            <div class="wv-alert-title">配置说明</div>
            <div class="wv-alert-text">作业人员名单用于周计划和工作票的现场人员选择，与登录账号分开管理。导入支持 CSV、XLS、XLSX，身份证号填写18位数字（末位可为X），手机号填写11位数字；准入有效期填写完整范围，如 2026-01-01 - 2026-12-31，也可用 2026年1月1日 - 2026年12月31日。证件类型支持多个，手动填写时只能使用模板「选项」表中的名称，并用中文分号（；）分隔。导入前会检查整份文件，存在错误时不会提交。</div>
          </div>
        </div>

        <div class="wv-section">作业人员名单</div>
        <div class="wv-filters">
          <el-input v-model="filters.name" placeholder="按姓名筛选" clearable style="width:200px" @input="page=1" />
          <el-select v-model="filters.identity" placeholder="身份" clearable style="width:230px" @change="page=1">
            <el-option v-for="o in WORKER_IDENTITY_OPTIONS" :key="o" :label="o" :value="o" />
          </el-select>
          <el-select v-model="filters.team" placeholder="班组" clearable style="width:170px" @change="page=1">
            <el-option v-for="t in teams" :key="t.id" :label="t.name" :value="t.name" />
          </el-select>
          <el-button @click="resetFilters">重置</el-button>
        </div>

        <el-table class="flat-table" :data="paged" v-loading="loading" style="width:100%" empty-text="暂无人员">
          <el-table-column prop="name" label="姓名" min-width="90" />
          <el-table-column prop="identity" label="身份" min-width="185" />
          <el-table-column prop="team" label="班组" min-width="100" />
          <el-table-column prop="phone" label="电话" min-width="120" />
          <el-table-column label="证件" min-width="120"><template #default="{row}">{{ fmtCerts(row) }}</template></el-table-column>
          <el-table-column label="准入有效期" min-width="190"><template #default="{row}">{{ fmtValid(row) }}</template></el-table-column>
          <el-table-column label="状态" width="95">
            <template #default="{row}">
              <el-tag :type="row.status==='待定' ? 'warning' : 'success'" size="small">{{ row.status || '已准入' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="170">
            <template #default="{row}">
              <el-button v-if="canWrite('users')" link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
              <el-button v-if="canWrite('users')" link type="primary" size="small" @click="togglePending(row)">{{ row.status==='待定' ? '恢复准入' : '待定库' }}</el-button>
              <el-button v-if="canWrite('users')" link type="danger" size="small" @click="remove(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <div v-if="filtered.length > pageSize" style="display:flex;justify-content:flex-end;margin-top:12px">
          <el-pagination background layout="prev, pager, next" :total="filtered.length" :page-size="pageSize" :current-page="page" @current-change="p=>page=p" />
        </div>

        <div class="wv-section">班组</div>
        <el-table class="flat-table" :data="sortedTeams" v-loading="loading" style="width:100%" empty-text="暂无班组">
          <el-table-column prop="name" label="班组" min-width="200" />
          <el-table-column label="周计划选项" min-width="200"><template #default="{row}">{{ weekOption(row) }}</template></el-table-column>
          <el-table-column label="排序" min-width="120"><template #default="{row}">{{ Number(row.sort) || 0 }}</template></el-table-column>
          <el-table-column label="操作" width="180">
            <template #default="{row}">
              <el-button v-if="canWrite('users')" size="small" @click="openTeamEdit(row)">编辑</el-button>
              <el-button v-if="canWrite('users')" size="small" class="wv-del-btn" @click="removeTeam(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>

    <!-- 用户管理 → 作业人员名单标签：不出现卡片头与班组区块 -->
    <div v-else>
      <div class="wv-alert">
        <span class="wv-alert-icon">i</span>
        <div class="wv-alert-main">
          <div class="wv-alert-title">配置说明</div>
          <div class="wv-alert-text">作业人员名单用于维护实际参与现场作业、可在周计划和工作票中选择的人员，与登录账号分开管理。作业人员无需登录系统；建议维护姓名、电话、身份、班组、证件类型和准入有效期。移入待定后，该人员不再供周计划选择。</div>
        </div>
      </div>

      <div class="ck-toolbar">
        <el-button v-if="canWrite('users')" type="primary" size="small" @click="openAdd">新增</el-button>
        <el-button v-if="canWrite('users')" size="small" @click="triggerImport">选择文件导入</el-button>
        <span class="ck-hint">支持 .csv、.xls、.xlsx；请按模板填写，身份证号、手机号和有效期格式错误时整批不会导入。</span>
        <el-button size="small" @click="downloadExport">下载</el-button>
        <el-button link type="primary" @click="downloadTemplate">下载模板</el-button>
      </div>

      <div class="wv-filters">
        <el-input v-model="filters.name" placeholder="按姓名筛选" clearable style="width:160px" @input="page=1" />
        <el-select v-model="filters.identity" placeholder="身份" clearable style="width:230px" @change="page=1">
          <el-option v-for="o in WORKER_IDENTITY_OPTIONS" :key="o" :label="o" :value="o" />
        </el-select>
        <el-select v-model="filters.team" placeholder="班组" clearable style="width:150px" @change="page=1">
          <el-option v-for="t in teams" :key="t.id" :label="t.name" :value="t.name" />
        </el-select>
        <el-button @click="resetFilters">重置</el-button>
        <span class="ck-note">由资料员维护，无需为每名作业人员创建登录账号</span>
      </div>

      <el-table class="flat-table" :data="paged" v-loading="loading" style="width:100%" empty-text="暂无人员">
        <el-table-column prop="name" label="姓名" min-width="90" />
        <el-table-column prop="identity" label="身份" min-width="190" />
        <el-table-column prop="team" label="班组" min-width="100" />
        <el-table-column label="证件类型" min-width="170"><template #default="{row}">{{ fmtCerts(row) }}</template></el-table-column>
        <el-table-column label="准入有效期" min-width="200"><template #default="{row}">{{ fmtValid(row) }}</template></el-table-column>
        <el-table-column prop="idNumber" label="身份证号" min-width="180" />
        <el-table-column prop="phone" label="电话号码" min-width="140" />
        <el-table-column label="状态" width="100">
          <template #default="{row}">
            <el-tag :type="row.status==='待定' ? 'warning' : 'success'" size="small">{{ row.status || '已准入' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="170">
          <template #default="{row}">
            <el-button v-if="canWrite('users')" link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button v-if="canWrite('users')" link type="primary" size="small" @click="togglePending(row)">{{ row.status==='待定' ? '恢复准入' : '待定库' }}</el-button>
            <el-button v-if="canWrite('users')" link type="danger" size="small" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div style="display:flex;justify-content:flex-end;margin-top:12px">
        <el-pagination background layout="prev, pager, next" :total="filtered.length" :page-size="pageSize" :current-page="page" @current-change="p=>page=p" />
      </div>
    </div>

    <el-dialog :title="editing ? '编辑人员' : '新增人员'" v-model="dialogVisible" width="620px" label-position="top">
      <el-form :model="form" label-position="top">
        <el-form-item label="姓名" required>
          <el-input v-model="form.name" placeholder="姓名" />
        </el-form-item>
        <el-form-item label="身份证号">
          <el-input v-model="form.idNumber" placeholder="选填，18位数字，末位可为X" />
        </el-form-item>
        <el-form-item label="电话号码">
          <el-input v-model="form.phone" placeholder="选填，11位手机号" />
        </el-form-item>
        <el-form-item label="身份">
          <el-select v-model="form.identity" placeholder="选填" style="width:100%" clearable>
            <el-option v-for="o in WORKER_IDENTITY_OPTIONS" :key="o" :label="o" :value="o" />
          </el-select>
        </el-form-item>
        <el-form-item label="班组">
          <el-select v-model="form.team" placeholder="选填" style="width:100%" clearable>
            <el-option v-for="t in teams" :key="t.id" :label="t.name" :value="t.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="证件类型">
          <el-select v-model="form.certTypes" placeholder="选填，可多选" style="width:100%" multiple clearable filterable>
            <el-option v-for="o in WORKER_CERT_OPTIONS" :key="o" :label="o" :value="o" />
          </el-select>
        </el-form-item>
        <el-form-item label="准入有效期">
          <el-date-picker v-model="form.validRange" type="daterange" range-separator="→"
            start-placeholder="开始日期" end-placeholder="结束日期"
            value-format="YYYY-MM-DD" style="width:100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible=false">取消</el-button>
        <el-button type="primary" @click="submit">确定</el-button>
      </template>
    </el-dialog>

    <el-dialog :title="teamDlg.editing ? '编辑班组' : '新增班组'" v-model="teamDlg.visible" width="480px" label-position="top">
      <el-form :model="teamDlg" label-position="top">
        <el-form-item label="班组" required>
          <el-input v-model="teamDlg.name" placeholder="如：施工一队" maxlength="60" />
        </el-form-item>
        <el-form-item label="周计划选项">
          <el-select v-model="teamDlg.showOnDeploy" style="width:100%">
            <el-option label="显示" value="展示" />
            <el-option label="隐藏" value="隐藏" />
          </el-select>
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="teamDlg.sort" :min="0" :max="999" style="width:100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="teamDlg.visible=false">取消</el-button>
        <el-button type="primary" :loading="teamDlg.busy" @click="saveTeam">确定</el-button>
      </template>
    </el-dialog>
  </div>`
};

/* 作业人员与班组：独立二级页（初始化向导「班组与施工人员 → 去设置」跳转落地页）
   与「用户管理 → 作业人员名单」标签共用同一个 WorkersPanel 组件 */
const WorkersView = {
  template: `<div class="wv-page"><WorkersPanel /></div>`
};

/* 登录账号列表（对齐原系统截图）：管理可登录系统的人员 */
const AccountsPanel = {
  setup() {
    const { ref, reactive, onMounted } = Vue;
    const EP = ElementPlus;
    const list = ref([]);
    const loading = ref(false);
    const showPwd = ref(false);
    const GROUPS = ['超级用户', '资料员', '材料员', '班组长'];
    const dlg = reactive({ visible: false, mode: 'create', id: '', loginName: '', email: '', password: '', name: '', phone: '', userGroup: '班组长', busy: false });
    const detail = reactive({ visible: false, row: null });
    async function load() {
      loading.value = true;
      try { list.value = await api.get('/api/users'); }
      catch (e) { EP.ElMessage.error(e.message); }
      finally { loading.value = false; }
    }
    function openCreate() { Object.assign(dlg, { visible: true, mode: 'create', id: '', loginName: '', email: '', password: '', name: '', phone: '', userGroup: '班组长', busy: false }); showPwd.value = false; }
    function openEdit(row) { Object.assign(dlg, { visible: true, mode: 'edit', id: row.id, loginName: row.loginName || row.username, email: row.email || '', password: '', name: row.name || '', phone: row.phone || '', userGroup: row.userGroup || '班组长', busy: false }); showPwd.value = false; }
    function openDetail(row) { detail.row = row; detail.visible = true; }
    async function save() {
      if (!dlg.loginName.trim()) { EP.ElMessage.warning('请填写登录名'); return; }
      if (!dlg.email.trim()) { EP.ElMessage.warning('请填写邮箱'); return; }
      if (dlg.mode === 'create' && !dlg.password) { EP.ElMessage.warning('请填写密码'); return; }
      if (dlg.password) {
        if (dlg.password.length < 8 || dlg.password.length > 32) { EP.ElMessage.warning('密码需为 8-32 位'); return; }
        let cls = 0;
        if (/[a-z]/.test(dlg.password)) cls++;
        if (/[A-Z]/.test(dlg.password)) cls++;
        if (/\d/.test(dlg.password)) cls++;
        if (/[^A-Za-z0-9]/.test(dlg.password)) cls++;
        if (cls < 3) { EP.ElMessage.warning('密码需包含大写/小写/数字/符号中的至少三类'); return; }
      }
      dlg.busy = true;
      try {
        const body = { loginName: dlg.loginName.trim(), email: dlg.email.trim(), name: dlg.name.trim(), phone: dlg.phone.trim(), userGroup: dlg.userGroup };
        if (dlg.password) body.password = dlg.password;
        if (dlg.mode === 'create') await api.post('/api/users', body);
        else await api.put('/api/users/' + dlg.id, body);
        dlg.visible = false; EP.ElMessage.success('已保存'); load();
      } catch (e) { EP.ElMessage.error(e.message); }
      finally { dlg.busy = false; }
    }
    async function remove(row) {
      try { await EP.ElMessageBox.confirm('确定删除账号「' + (row.loginName || row.username) + '」？', '删除账号', { type: 'warning' }); }
      catch (e) { return; }
      try { await api.del('/api/users/' + row.id); EP.ElMessage.success('已删除'); load(); }
      catch (e) { EP.ElMessage.error(e.message); }
    }
    function groupTag(g) { return g === '超级用户' ? 'danger' : (g === '资料员' ? 'success' : (g === '材料员' ? 'warning' : 'info')); }
    onMounted(load);
    return { list, loading, showPwd, dlg, detail, GROUPS, groupTag, openCreate, openEdit, openDetail, save, remove };
  },
  template: `
  <div>
    <el-alert type="info" :closable="false" show-icon style="margin-bottom:14px">
      <template #title><b>配置说明</b></template>
      <div>登录账号列表用于管理本企业需要登录系统的人员、登录资料和操作权限，与作业人员名单、外部通讯录分开维护。仅为需要使用系统的人员创建账号，无需为每名现场作业人员开通账号。</div>
      <div style="margin-top:6px">新增时填写登录名、邮箱和密码，建议补充姓名、电话，并按职责选择用户组。账号的新增、编辑与删除仅超级用户可操作。</div>
    </el-alert>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap">
      <span style="color:var(--text-2);font-size:13px">仅为需要登录系统的人员创建账号，并按职责分配权限</span>
      <el-button v-if="canAdmin()" type="primary" @click="openCreate">新增用户</el-button>
    </div>
    <el-table :data="list" v-loading="loading" border stripe style="width:100%">
      <el-table-column prop="email" label="邮箱" min-width="220" />
      <el-table-column label="姓名" min-width="120"><template #default="{ row }">{{ row.name || '-' }}</template></el-table-column>
      <el-table-column label="电话" width="150">
        <template #default="{ row }">{{ row.phone || '-' }}</template>
      </el-table-column>
      <el-table-column label="用户组" width="110">
        <template #default="{ row }"><el-tag :type="groupTag(row.userGroup)" size="small">{{ row.userGroup }}</el-tag></template>
      </el-table-column>
      <el-table-column label="操作" width="200" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="openDetail(row)">详情</el-button>
          <el-button v-if="canAdmin()" link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
          <el-button v-if="canAdmin() && !row.isSelf" link type="danger" size="small" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog :title="dlg.mode === 'create' ? '新增用户' : '编辑用户'" v-model="dlg.visible" width="480px">
      <el-form label-position="top">
        <el-form-item label="登录名" required>
          <el-input v-model="dlg.loginName" placeholder="CloudBase 登录名" :disabled="dlg.mode === 'edit'" />
        </el-form-item>
        <el-form-item label="邮箱" required>
          <el-input v-model="dlg.email" placeholder="用于登录" />
        </el-form-item>
        <el-form-item label="密码" :required="dlg.mode === 'create'">
          <el-input v-model="dlg.password" :type="showPwd ? 'text' : 'password'" placeholder="8-32 位，至少三类字符">
            <template #suffix><span style="cursor:pointer;font-size:12px" @click="showPwd = !showPwd">{{ showPwd ? '隐藏' : '显示' }}</span></template>
          </el-input>
        </el-form-item>
        <el-form-item label="姓名">
          <el-input v-model="dlg.name" placeholder="选填，用于班组长下拉展示" />
        </el-form-item>
        <el-form-item label="电话">
          <el-input v-model="dlg.phone" placeholder="选填，用于资料填报联系方式" />
        </el-form-item>
        <el-form-item label="用户组" required>
          <el-select v-model="dlg.userGroup" style="width:100%">
            <el-option v-for="g in GROUPS" :key="g" :label="g" :value="g" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dlg.visible=false">取消</el-button>
        <el-button type="primary" :loading="dlg.busy" @click="save">确定</el-button>
      </template>
    </el-dialog>

    <el-dialog title="账号详情" v-model="detail.visible" width="460px">
      <el-descriptions v-if="detail.row" :column="1" border>
        <el-descriptions-item label="登录名">{{ detail.row.loginName || detail.row.username }}</el-descriptions-item>
        <el-descriptions-item label="邮箱">{{ detail.row.email || '-' }}</el-descriptions-item>
        <el-descriptions-item label="姓名">{{ detail.row.name || '-' }}</el-descriptions-item>
        <el-descriptions-item label="电话">{{ detail.row.phone || '-' }}</el-descriptions-item>
        <el-descriptions-item label="用户组">{{ detail.row.userGroup }}</el-descriptions-item>
        <el-descriptions-item label="可写模块">{{ ['超级用户','资料员'].includes(detail.row.userGroup) ? '全部模块' : (detail.row.userGroup === '材料员' ? '材料台账' : (detail.row.userGroup === '班组长' ? '计划管理 · 当日计划工作量' : '只读')) }}</el-descriptions-item>
        <el-descriptions-item label="状态">{{ detail.row.status }}</el-descriptions-item>
      </el-descriptions>
      <template #footer><el-button @click="detail.visible=false">关闭</el-button></template>
    </el-dialog>
  </div>`
};

/* 用户管理：登录账号列表 / 作业人员名单 / 外部通讯录 */
const UsersView = {
  setup() {
    const { ref, onMounted } = Vue;
    const tab = ref('accounts');
    // 支持从其它页面编程式跳转到指定标签页（如外部通讯录）
    onMounted(() => {
      if (window.__pendingUsersTab) { tab.value = window.__pendingUsersTab; window.__pendingUsersTab = ''; }
    });
    return { tab };
  },
  template: `
  <div>
    <el-tabs v-model="tab">
      <el-tab-pane label="登录账号列表" name="accounts"><AccountsPanel /></el-tab-pane>
      <el-tab-pane label="作业人员名单" name="workers" lazy><WorkersPanel variant="tab" /></el-tab-pane>
      <el-tab-pane label="外部通讯录" name="contacts" lazy><ContactsPanel /></el-tab-pane>
    </el-tabs>
  </div>`
};
