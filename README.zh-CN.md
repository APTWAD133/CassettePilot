# CassettePilot

[English](README.md)

CassettePilot 是一款以 Windows 为首要平台的 Electron 应用，用于制作磁带控制轨，并通过实体磁带卡座控制已获授权的音乐播放。独立的自包含 .NET 音频主机负责 WASAPI 采集、信号解码、定位、增益控制和播放，不依赖渲染进程的事件循环。

`0.1.0` 是本项目作为独立代码仓库发布的第一个版本。

## 负责任地使用

本项目为独立项目，与网易没有隶属、认可或合作关系。仅应在您有权使用相关账号、API、内容和操作时使用音乐服务集成。您有责任遵守适用的著作权法、录音相关法律法规及音乐服务条款。

本应用不会授予下载、录制、保留、再分发或公开表演受保护音频的许可。“录制实际音乐”路径仅适用于您拥有或已获得明确录制授权的音频。控制信号工作流录制的是数据而不是音乐。以上内容仅为项目使用说明，不构成法律意见。

## 功能

- 双面混音带可视化编辑器，支持覆盖编辑、裁剪点、淡入淡出、增益自动化、吸附和键盘快捷键。
- 生成带有载波、纠错和 CRC 校验的 48 kHz 立体声控制信号。
- Windows 原生 WASAPI 输入/输出，支持磁带速度恢复，并在载波丢失时快速暂停。
- 磁带卡座和磁带诊断测量。
- 通过内置或外部兼容网易云音乐提供程序进行已获授权的搜索、元数据读取、登录和播放。
- 使用当前 Windows 账号加密保存桌面端登录 Cookie。
- 英文和简体中文界面。
- Windows x64 便携式打包。

信号格式和物理层设计请参阅 [docs/protocol.md](docs/protocol.md)。

## 下载与运行

发布完成后，可从 [GitHub Releases](https://github.com/APTWAD133/CassettePilot/releases) 下载 `CassettePilot-0.1.0-x64.exe`。该便携式可执行文件为自包含程序：普通用户无需安装 Node.js、npm、.NET SDK 或安装程序。

普通用户的系统要求：

- x64 硬件上的 Windows 10 或更高版本。
- 若要使用实体控制和诊断工作流，需要磁带卡座及合适的音频接口。

当前可执行文件尚未进行代码签名，因此 Windows SmartScreen 可能显示警告。运行前请核对发布页面提供的校验值。

## 从源代码构建并运行

开发环境需要 x64 Windows、Node.js 20 或更高版本及 npm，以及 .NET 8 SDK。

安装锁定版本的依赖并构建原生音频主机：

```powershell
npm ci
npm run build:native
npm start
```

Electron 应用会在随机可用端口上启动仅限本机回环访问的服务器。渲染进程不能访问 Node.js，应用启用了上下文隔离和沙箱，并将麦克风及扬声器选择权限限制在应用自身的回环源。

仅进行浏览器端开发时：

```powershell
npm ci
npm run dev:web
```

随后打开 <http://127.0.0.1:4173/>。浏览器模式不提供全部桌面端和原生音频功能。

## 配置

应用无需配置文件即可运行。可选的开发环境变量记录在 [.env.example](.env.example) 中：

- `PORT`：本地 Web 开发端口，默认为 `4173`。
- `NETEASE_API_BASE`：外部兼容提供程序的基础 URL；留空时使用内置提供程序。
- `NETEASE_COOKIE`：仅用于开发的提供程序 Cookie，属于敏感信息，绝不能提交到代码仓库。

本项目不会自动加载 `.env`。请在 Shell 中设置变量，或使用您自己的本地环境加载工具。例如：

```powershell
$env:NETEASE_API_BASE="http://127.0.0.1:3000"
npm run dev:web
```

打包后的桌面应用使用当前 Windows 账号加密提供程序 Cookie，并将应用状态保存在便携式可执行文件旁的 `CassettePilot Data` 目录中。退出登录会删除保存的提供程序凭据。

## 音乐服务行为

锁定版本的 `@neteasecloudmusicapienhanced/api` 在回环服务器后运行。应用仅请求已登录账号获准访问的 URL，并在需要时逐级回退到较低音质。应用不会启用提供程序的跨服务解锁模式，并为流式响应设置 `Cache-Control: no-store`。

该提供程序并非官方组件，其上游行为、可用性和条款可能发生变化。分发应用前请阅读 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 开发与测试

运行 JavaScript 自动化测试和语法检查：

```powershell
npm test
npm run check
```

构建并验证原生编解码器和音频管线：

```powershell
npm run build:native
npm run test:native
```

原生验证会生成临时控制信号样本，检查 JavaScript 编码器与原生解码器的一致性，验证重采样和载波检测，并测试捕获数据块丢失后的重新捕获。

可选的 Electron 后台媒体冒烟测试需要交互式 Windows 桌面和音频环境：

```powershell
npm run test:electron-background
```

## 打包

构建免安装的 Windows x64 可执行文件：

```powershell
npm run dist
```

输出位于 `dist/`。在发布生成的软件包前，请检查其中包含的依赖许可证，扫描凭据和不应包含的本地数据，并记录 SHA-256 校验值。

## 隐私与本地数据

- 桌面应用不会将登录 Cookie 保存到项目文件或暴露给浏览器代码。
- 本地设置、混音带集合、日志和校准报告应保存在便携式数据目录中，并已从 Git 中排除。
- 音频流仅通过内存代理并标记为 `no-store`；本项目不包含音乐文件。
- 上传的校准录音和生成的 WAV 文件已从 Git 中排除。

## 贡献与安全

开发和贡献要求请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)，私密报告安全漏洞的方法请参阅 [SECURITY.md](SECURITY.md)。

## 许可证

项目原创代码和 CassettePilot 图标作品采用 [MIT License](LICENSE)。依赖项和服务集成仍受其各自许可证与条款约束，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
