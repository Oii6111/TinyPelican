// 小鹈鹕 V3 — 纯代码批次处理器（CLI 壳，逻辑在 core/ingest/pipeline）
// 读 batches/*.jsonl -> 按 contact 分组建档 -> 成功后删除批次
// 最后 stdout 只输出一个整数：本次真正新增的消息条数
'use strict';

const { processAllBatches } = require('./core/ingest/pipeline');

const total = processAllBatches();
console.log(total);
