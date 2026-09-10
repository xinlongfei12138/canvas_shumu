# Windows 源码安装与启动

此源码包不包含依赖、构建产物、浏览器画布数据、模型配置或 API Key。

## 1. 安装 Node.js

安装 Node.js 20.19 或更高版本，然后在 PowerShell 中确认：

```powershell
node --version
npm --version
```

## 2. 安装并构建画布

在解压后的项目根目录打开 PowerShell：

```powershell
cd web
npm install
npm run build
npm run start
```

也可以双击项目根目录的 `Start-Canvas.cmd` 启动。它会先检查 GitHub Release 和 `main` 分支版本，再检查 `web` 与 Canvas Agent 的依赖；依赖缺失或锁文件变化时会自动安装，源码更新或缺少构建产物时会自动构建。

启用本地自动更新：

默认更新仓库已经设置为 `xinlongfei12138/canvas_shumu`。以后发布新版本时，启动脚本会自动检查；只有需要切换更新仓库时，才需要复制 `update.config.example.json` 为 `.update-config.json` 并修改 `repository`。

只更新而不启动画布时，可以双击项目根目录的 `Update-Canvas.bat`。它也会自动修复依赖并完成必要构建。

更新脚本会保留 `.update-config.json`、依赖目录和本地 `data`，并在更新后重新构建前端与 Canvas Agent。浏览器里的模型配置、画布和素材不在源码包中，也不会被源码更新覆盖。

终端保持运行，然后只使用下面的地址打开画布：

```text
http://127.0.0.1:3000
```

不要在 `127.0.0.1:3000` 与 `localhost:3000` 之间切换。浏览器会把它们视为两个站点，画布、素材和模型配置不会共用。

## 3. 启动 Canvas Agent

另开一个 PowerShell 窗口，在项目根目录执行：

```powershell
cd canvas-agent
npm install
npm run build
npm run start
```

默认地址为 `http://127.0.0.1:17371`。终端输出的 Connect token 用于网页连接本地 Agent。

## 4. 可选：启动本地代理

只有在画布设置中启用了本地代理时才需要启动：

```powershell
cd canvas-proxy
npm start
```

## 5. 导入配置

在画布右上角打开“配置”，点击“导入配置”，选择手动导出的 JSON。配置文件包含 API Key 和 WebDAV 凭据，不要公开分享。

浏览器画布数据和本地素材不在源码包或配置 JSON 中。需要迁移画布时，请在原电脑的画布库中单独导出画布，再到新电脑导入。

## 更新后仍显示旧版本

1. 确认终端所在目录是本次解压的新源码目录。
2. 在 `web` 目录重新运行 `npm install` 和 `npm run build`。
3. 停止旧的 3000 端口进程，再运行 `npm run start`。
4. 打开 `http://127.0.0.1:3000` 并刷新页面。

页面右上角应显示根目录 `VERSION` 文件中的当前版本号。
