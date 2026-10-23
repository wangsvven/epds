/* ========== core/upload ========== */
/* 文件上传基础设施：multer 实例（内存暂存、单文件 ≤20MB、文件名按 UTF-8 解析）。 */
const multer = require('multer');

// 材料 Excel 导入：内存暂存，单文件上限 20MB
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 }, defParamCharset: 'utf8' });

module.exports = upload;
