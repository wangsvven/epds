/* ========== views/crud ========== */
/* 通用 CRUD 视图 CrudView 与其配置驱动部分：annualPlanCfg / substationCfg / teamCfg / borrowCfg / completionCfg。 */
/* ---------------- 通用 CRUD 视图（覆盖项目/计划/借工/竣工资料/用户/领料单/导入批次/出库） ---------------- */
const CrudView = {
  props: {
    config: { type: Object, required: true }
  },
  setup(props) {
    const list = ref([]);
    const loading = ref(false);
    const dialogVisible = ref(false);
    const editing = ref(false);
    const form = reactive({});
    const refOptions = reactive({});

    async function loadRefs() {
      if (props.config.refs) {
        for (const [field, cfg] of Object.entries(props.config.refs)) {
          try {
            const data = await api.get(cfg.endpoint);
            refOptions[field] = data.map(d => ({ label: d[cfg.label], value: d[cfg.value] }));
          } catch (e) { refOptions[field] = []; }
        }
      }
    }
    async function load() {
      loading.value = true;
      try { list.value = await api.get('/api/' + props.config.endpoint); }
      catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { loading.value = false; }
    }
    function openAdd() {
      Object.keys(form).forEach(k => delete form[k]);
      props.config.formFields.forEach(f => { form[f.key] = f.default !== undefined ? f.default : (f.type === 'number' ? 0 : ''); });
      editing.value = false; dialogVisible.value = true;
    }
    function openEdit(row) {
      Object.keys(form).forEach(k => delete form[k]);
      props.config.formFields.forEach(f => { form[f.key] = row[f.key] ?? ''; });
      form._id = row.id; editing.value = true; dialogVisible.value = true;
    }
    async function submit() {
      try {
        if (editing.value) await api.put('/api/' + props.config.endpoint + '/' + form._id, form);
        else await api.post('/api/' + props.config.endpoint, form);
        ElementPlus.ElMessage.success('已保存');
        dialogVisible.value = false; load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function remove(row) {
      try {
        await ElementPlus.ElMessageBox.confirm('确认删除该记录？', '提示', { type: 'warning' });
        await api.del('/api/' + props.config.endpoint + '/' + row.id);
        ElementPlus.ElMessage.success('已删除'); load();
      } catch (e) { if (e !== 'cancel') ElementPlus.ElMessage.error(e.message || '已取消'); }
    }
    function fieldOptions(key) { return refOptions[key] || []; }
    function cfgModule() {
      const e = props.config.endpoint;
      if (e === 'borrowWorks') return 'borrow';
      if (e === 'completionDocuments') return 'completion';
      return 'settings';
    }

    onMounted(() => { loadRefs(); load(); });

    return { list, loading, dialogVisible, editing, form, openAdd, openEdit, submit, remove, fieldOptions, tagType, cfgModule };
  },
  template: `
  <div>
    <div class="toolbar">
      <el-button v-if="canWrite(cfgModule())" type="primary" @click="openAdd">+ 新增</el-button>
      <span class="spacer"></span>
      <span style="color:var(--text-3);font-size:13px;">共 {{ list.length }} 条</span>
    </div>
    <el-table :data="list" v-loading="loading" border stripe style="width:100%">
      <el-table-column v-for="col in config.columns" :key="col.key" :prop="col.key" :label="col.label" :width="col.width">
        <template #default="{ row }">
          <el-tag v-if="col.tag" :type="tagType(row[col.key])">{{ row[col.key] }}</el-tag>
          <span v-else>{{ row[col.key] }}</span>
        </template>
      </el-table-column>
      <el-table-column v-if="canWrite(cfgModule())" label="操作" width="150" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog :title="(editing ? '编辑' : '') + (config.dialogTitle || config.title)" v-model="dialogVisible" width="520px">
      <el-form :model="form" label-width="100px">
        <el-form-item v-for="f in config.formFields" :key="f.key" :label="f.label" :required="f.required">
          <el-select v-if="f.type==='select'" v-model="form[f.key]" placeholder="请选择" style="width:100%">
            <el-option v-for="o in f.options || fieldOptions(f.key)" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
          <el-input-number v-else-if="f.type==='number'" v-model="form[f.key]" :min="0" style="width:100%" />
          <el-input v-else-if="f.type==='textarea'" v-model="form[f.key]" type="textarea" :rows="3" />
          <el-input v-else v-model="form[f.key]" :placeholder="f.placeholder || ''" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible=false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>`
};

/* ---------------- 全局设置（对齐真实系统截图：年度计划名称/属地供电所/班组管理/网站设置） ---------------- */
const annualPlanCfg = {
  endpoint: 'annualPlans', title: '年度计划名称', dialogTitle: '年度计划名称',
  columns: [ { key: 'name', label: '年度计划名称' }, { key: 'sort', label: '排序', width: 100 } ],
  formFields: [
    { key: 'name', label: '名称', required: true, placeholder: '如：2025年度配网工程' },
    { key: 'sort', label: '排序', type: 'number', default: 0 }
  ]
};
const substationCfg = {
  endpoint: 'substations', title: '属地供电所', dialogTitle: '属地供电所',
  columns: [ { key: 'name', label: '属地供电所' }, { key: 'sort', label: '排序', width: 100 } ],
  formFields: [
    { key: 'name', label: '名称', required: true, placeholder: '如：XX供电所' },
    { key: 'sort', label: '排序', type: 'number', default: 0 }
  ]
};
const teamCfg = {
  endpoint: 'teams', title: '班组管理', dialogTitle: '班组管理',
  columns: [
    { key: 'name', label: '班组名称' },
    { key: 'showOnDeploy', label: '当前部署展示', width: 140 },
    { key: 'inWorkerList', label: '是否列入作业人员名单', width: 190 },
    { key: 'sort', label: '排序', width: 90 }
  ],
  formFields: [
    { key: 'name', label: '班组名称', required: true, placeholder: '如：一班、机械施工' },
    { key: 'showOnDeploy', label: '当前部署展示', type: 'select', default: '展示', options: [{ label: '展示', value: '展示' }, { label: '隐藏', value: '隐藏' }] },
    { key: 'inWorkerList', label: '是否列入作业人员名单', type: 'select', default: '列入', options: [{ label: '列入', value: '列入' }, { label: '不列入', value: '不列入' }] },
    { key: 'sort', label: '排序', type: 'number', default: 0 }
  ]
};

/* 项目/计划/借工/竣工资料 配置 */
const borrowCfg = {
  endpoint: 'borrowWorks', title: '借工',
  columns: [
    { key: 'fromTeam', label: '借出班组' }, { key: 'toTeam', label: '借入班组' }, { key: 'reason', label: '事由' },
    { key: 'headcount', label: '人数', width: 80 }, { key: 'startDate', label: '开始', width: 120 }, { key: 'endDate', label: '结束', width: 120 },
    { key: 'status', label: '状态', tag: true, width: 100 }
  ],
  formFields: [
    { key: 'fromTeam', label: '借出班组' }, { key: 'toTeam', label: '借入班组' }, { key: 'reason', label: '事由', type: 'textarea' },
    { key: 'headcount', label: '人数', type: 'number' }, { key: 'startDate', label: '开始日期' }, { key: 'endDate', label: '结束日期' },
    { key: 'status', label: '状态', type: 'select', options: [{ label: '进行中', value: '进行中' }, { label: '已归还', value: '已归还' }] }
  ]
};
const completionCfg = {
  endpoint: 'completionDocuments', title: '竣工资料',
  columns: [
    { key: 'name', label: '资料名称' }, { key: 'category', label: '类别', width: 100 }, { key: 'status', label: '状态', tag: true, width: 100 }, { key: 'updatedAt', label: '更新时间', minWidth: 160 }
  ],
  formFields: [
    { key: 'name', label: '资料名称', required: true }, { key: 'category', label: '类别' },
    { key: 'status', label: '状态', type: 'select', options: [{ label: '编制中', value: '编制中' }, { label: '待审核', value: '待审核' }, { label: '已归档', value: '已归档' }] }
  ]
};
