# DeepSeek Harness Desktop

DeepSeek Harness 的 Windows Electron 桌面封装。客户端启动或复用本机 dsh Host，
并直接加载 Host 提供的官方前端，因此功能、数据和外观与浏览器版一致。

## 项目结构

```text
deepseek-harness/
├─ build/icon.ico         # 程序、托盘和安装器图标
├─ build/installer.nsh    # 安装注册表身份与安装目录
├─ renderer/              # Host 启动期间显示的轻量加载页
├─ main.js                # Host、窗口、托盘和单实例生命周期
├─ preload.js             # 加载状态的最小 IPC 桥
├─ package.json           # electron-builder 配置与精确版本
└─ package-lock.json      # 完整依赖锁
```

## 开发与打包

```powershell
npm ci
npm start
npm run dist
```

`npm run dist` 生成 x64 NSIS 安装版。打包仅保留简体中文和英文的 Electron
语言资源，并使用最高压缩等级。

安装包使用辅助安装模式，用户可以在安装过程中自行选择安装位置。

也可以直接调用公共 Windows 打包脚本并指定目标：

```powershell
.\scripts\build.ps1 -Target Installer
.\scripts\build.ps1 -Target Uninstaller
.\scripts\build.ps1 -Target Portable
```

三个产物分别使用独立的双击入口：

- `scripts\build-installer.bat`：只生成 NSIS 安装器。
- `scripts\build-uninstaller.bat`：只生成独立卸载入口。
- `scripts\build-portable.bat`：只生成便携版。

三个脚本会保留同版本的其他产物，不会相互覆盖。

构建脚本会记录依赖、`package-lock.json`、Node.js 和 npm 的组合指纹。指纹没有
变化时自动复用 `node_modules`，变化时才执行 `npm ci`。`-ForceInstall` 可以强制
重新安装依赖，`-SkipInstall` 可以显式跳过检查。其他参数包括
`-KeepOldArtifacts` 和 `-KeepUnpacked`。

## Windows 代码签名

发布构建可以通过环境变量为安装器、便携版和独立卸载器配置同一份 PFX 证书：

```powershell
$env:DSH_SIGN_CERTIFICATE = 'D:\certificates\release.pfx'
$env:DSH_SIGN_PASSWORD = 'PFX 密码'
$env:DSH_SIGNTOOL_PATH = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe' # 可选
$env:DSH_TIMESTAMP_URL = 'http://timestamp.digicert.com' # 可选
.\scripts\build.ps1 -Target Installer -RequireSigning
```

`DSH_SIGNTOOL_PATH` 未设置时会自动查找 Windows SDK。`-RequireSigning` 会在证书
缺失时终止发布，避免误发未签名 EXE。请勿把 PFX 文件或密码提交到项目中。

## 运行机制

应用优先复用 `http://127.0.0.1:3080`，也可以通过 `DSH_DESKTOP_HOST` 指定
其他地址。没有可用 Host 时，应用会在启动页列出缺少或版本不符合要求的环境，
由用户勾选后再下载和安装。dsh 默认安装为 `@deepseek-ai/dsh@0.1.0-rc.6`，也可以在
客户端内更新或回退到已支持的版本。

如果电脑没有 Node.js/npm，可选择下载客户端专用的 Node.js 24.19.0。该运行时安装
在客户端数据目录的 `runtime` 子目录，不需要管理员权限、不依赖 winget，也不会
修改系统 PATH；官方源不可用时自动切换到 npmmirror。检测到 winget 的电脑也可在
界面中选择安装系统版 Node.js。dsh 不内置在 EXE 中。

本地 Host 使用以下参数启动，并在退出应用时自动结束：

```text
dsh --profile web --host 127.0.0.1 --port 0
```

关闭窗口会驻留系统托盘；重复启动只会聚焦已有窗口。所有后台命令均隐藏运行，
不会弹出控制台黑框。

## Harness 运行时版本管理

在“帮助 → 管理 Harness 版本”中可以从 npm 查看并安装更新版本。更新前客户端会
把当前 `@deepseek-ai/dsh` 完整安装目录保存到用户数据目录的 `dsh-backups` 子目录；
版本切换成功后会自动重启 Host。版本管理窗口中的“回退”可以恢复任意一个历史备份，
当前选择会保存到用户数据目录，客户端下次启动仍使用该版本。外部 Host 不支持由桌面端
更新或回退。
