# 更新和卸载的数据保留

安装器和普通卸载默认保留用户数据。`deleteAppDataOnUninstall` 必须为 false，自定义卸载宏不能删除 APPDATA 下的应用目录。

历史版本曾在普通卸载时删除 `AppData/Roaming/xiaotihu` 和 `AppData/Roaming/TinyPelican`。这些目录包含对话、DSH profile 和其他记录。正常覆盖升级会给旧卸载程序传递 `--updated`；先手动卸载或显式要求删除数据会绕过升级保护。

新代码无法更改用户机器上已经生成的旧卸载程序。升级旧版本前应先退出应用，备份用户的实际数据目录和 DSH_HOME，直接运行新安装包，不要先执行旧卸载程序。默认数据目录为 `%APPDATA%/xiaotihu`；自定义环境变量和目录回退可能使数据位于其他位置。

记录消失也可能是数据目录或 DSH 实例改变，不能仅凭界面空白判定文件已经删除。排查时应保留现有目录，检查旧账户、备份、原 DSH_HOME 以及独立安装 DSH 的会话。已经删除且没有备份的数据无法保证恢复。

`node scripts/verify-installer.cjs` 用隔离安装器验证升级卸载、应用运行时升级卸载和普通卸载都保留模拟用户数据。
