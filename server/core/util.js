/* ========== core/util ========== */
/* 无业务含义的纯工具：编号生成、时间格式化、日期/CSV 解析、上传名修复、docx 文本提取、zip/crc32 打包等。 */
const zlib = require('zlib');

// 业务记录可见性：仅过滤已逻辑删除的行
function aliveFilter() { return rec => !!rec && !rec.deleted; }

// 修复历史上传文件名乱码：浏览器按 UTF-8 发送 filename，旧版 multer 以 latin1 解码
function repairUploadName(s) {
  if (!s || typeof s !== 'string') return s;
  if (!/[\u00c0-\u00ff]/.test(s)) return s;
  try {
    const t = Buffer.from(s, 'latin1').toString('utf8');
    if (t === s || t.includes('\ufffd')) return s;
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(t)) return t;
  } catch (e) {}
  return s;
}

function genId(prefix) {
  return prefix + Math.random().toString(36).slice(2, 9);
}
function nowISO() { return new Date().toISOString(); }

// 文档中心「上传时间」戳（本地时区，精确到分）
function fmtNow() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// 工作票配置版本指纹显示用（本地时区，精确到秒）
function fmtStamp(d) {
  const p2 = n => String(n).padStart(2, '0');
  return d.getFullYear() + '/' + p2(d.getMonth() + 1) + '/' + p2(d.getDate()) + ' ' +
         p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
}

function parseCNDate(s) {
  const m = String(s).trim().match(/^(\d{4})[年/.\/-](\d{1,2})[月/.\/-](\d{1,2})日?$/);
  if (!m) return null;
  const d = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  return isNaN(new Date(d).getTime()) ? null : d;
}

// 极简 CSV 解析（UTF-8，支持引号转义），避免 SheetJS 把长数字转 number 丢精度、把中文按 Latin-1 解码
function parseCSVBuffer(buf) {
  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQ = false;
      } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(c => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); if (row.some(c => c !== '')) rows.push(row); }
  return rows;
}

// ---------- 零依赖 docx 文本提取（最小 ZIP 解压 + 解析 word/document.xml） ----------
function decodeXmlEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function unzipEntry(buf, entryName) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return null;
  let p = buf.readUInt32LE(eocd + 16); // 中央目录偏移
  while (p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === entryName) {
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const compSize = buf.readUInt32LE(localOffset + 18);
      const method = buf.readUInt16LE(localOffset + 8);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const raw = buf.slice(dataStart, dataStart + compSize);
      if (method === 0) return raw;
      if (method === 8) return zlib.inflateRawSync(raw);
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
function extractDocxText(buf) {
  const xml = unzipEntry(buf, 'word/document.xml');
  if (!xml) return [];
  const text = xml.toString('utf8');
  const lines = [];
  for (const para of text.split(/<\/w:p>/)) {
    const parts = [...para.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m => decodeXmlEntities(m[1]));
    const line = parts.join('').replace(/\s+$/, '');
    if (line.trim()) lines.push(line.trim());
  }
  return lines;
}

// ---------- 无依赖 zip 打包（项目资料打包下载用） ----------
function crc32(buf) {
  if (!crc32.table) {
    crc32.table = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc32.table[n] = c >>> 0; }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crc32.table[(crc ^ buf[i]) & 0xff];
  return (crc ^ (-1)) >>> 0;
}
function buildStoreZip(entries) {
  const locals = [], central = [];
  let offset = 0;
  entries.forEach(e => {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(e.data.length, 18); lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, e.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(e.data.length, 20); ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, nameBuf]));
    offset += 30 + nameBuf.length + e.data.length;
  });
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

module.exports = {
  aliveFilter, repairUploadName, genId, nowISO, fmtNow, fmtStamp,
  parseCNDate, parseCSVBuffer, decodeXmlEntities, unzipEntry, extractDocxText,
  crc32, buildStoreZip
};
