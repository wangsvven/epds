/* ========== core/doc-templates ========== */
/* 文档路径解析与「现场勘察记录模板」识别（文档中心、初始化状态、工作票配置状态共用）。 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

const { DB, saveDB } = require('./db');

function resolveDocPath(p) {
  if (!p) return null;
  if (p.startsWith('assets/')) return path.join(ROOT, p);
  if (p.startsWith('uploads/')) return path.join(ROOT, 'data', p);
  return null;
}
// 从文档中心已上传的文件中识别「现场勘察（查勘）记录模板」，自动关联为 surveyTemplate
function isSurveyTemplateName(name) {
  const n = String(name || '');
  return /(勘察|查勘)/.test(n) && /\.(docx|doc)$/i.test(n);
}
function resolveSurveyTemplate() {
  const docs = DB.documents || {};
  const cur = docs.surveyTemplate;
  if (cur && cur.name) {
    const abs = resolveDocPath(cur.path);
    if (!abs || fs.existsSync(abs)) return cur; // 已关联且文件存在
  }
  const cands = (docs.files || [])
    .filter(f => !f.deleted && f.path && isSurveyTemplateName(f.name))
    .sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')));
  if (!cands.length) return null;
  const f = cands[0];
  const meta = {
    name: f.name, path: f.path, size: f.size || null,
    uploader: f.uploader || '', uploadedAt: f.uploadedAt || '',
    sourceFileId: f.id, autoLinked: true
  };
  DB.documents.surveyTemplate = meta;
  saveDB();
  return meta;
}

module.exports = { resolveDocPath, isSurveyTemplateName, resolveSurveyTemplate };
