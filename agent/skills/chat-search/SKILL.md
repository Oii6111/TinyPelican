# Chat Search

用于按联系人或关键词检索聊天记录。调用 `node core/agent/system-cli.js search-chat <关键词> [联系人]` 获取结构化结果；需要生成回复上下文时调用 `node core/agent/system-cli.js contact-context <联系人>` 获取画像与最近消息。不得直接读取或修改联系人 JSON、`inbox.jsonl`，不得扫描整个项目。
