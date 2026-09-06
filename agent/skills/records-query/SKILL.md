# Records Query

用于回答待办、提醒、日程和待确认意图列表问题。调用 `node core/agent/system-cli.js query <scope>` 获取结构化结果；只展示用户请求的类别，不混入其他类别。禁止读取 `tasks.json`、`intents.json` 或其他存储文件。
