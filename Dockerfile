# 电网生产ERP（本地版）— 自托管镜像
# 零构建：前端是静态文件，无需打包；后端单进程 Node + Express + JSON 存储
FROM node:20-alpine

WORKDIR /app

# 先装依赖，利用镜像层缓存（依赖均为纯 JS，alpine 无需原生编译）
COPY package*.json ./
RUN npm install --omit=dev

# 复制全部应用代码（含 public/、assets/、server.js）
COPY . .

# 数据与用户上传目录（data/uploads，由代码统一使用）由运行时 volume 提供；
# 此处预建 /app/data，首次启动若 db.json 为空会自动 seedDB()
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=5173
EXPOSE 5173

# 启动命令与本地 npm start 一致
CMD ["node", "server.js"]
