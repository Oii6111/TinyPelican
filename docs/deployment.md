# 新电脑部署

## 环境

需要 Node.js 22.13 或更高版本，推荐 Node 24 LTS。项目使用内置的 node:sqlite，Node 18/20 无法启动核心。

## 开发启动

在仓库最内层目录执行：

    npm install
    npm run daemon

首次启动会从 config.example.json 自动创建 config.json，不会覆盖已有配置。默认数据目录是项目根目录；如果 checkout 目录只读，先设置：

    $env:XIAOTIHU_DATA_DIR = "$env:LOCALAPPDATA/TinyPelican-dev/data"

Electron 会在默认用户目录不可写时回退到其他可写目录。安装版默认把数据隔离在 `%APPDATA%/TinyPelican/data`，不会自动读取旧版 `%APPDATA%/xiaotihu`；也可以显式设置 XIAOTIHU_DATA_DIR 或 XIAOTIHU_USER_DATA_DIR。DSH_HOME 同样必须可写。

## 一键启动

双击 启动小鹈鹕.bat。start.ps1 会启动核心并轮询 /api/health，最多等待 90 秒，确认核心真正就绪后才打开浏览器。

## 压缩包

如果解压后出现 TinyPelican-main/TinyPelican-main，进入最内层目录再执行安装。Electron 二进制下载失败时重新执行 app 目录中的 npm install。
