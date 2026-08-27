// 兼容入口：历史脚本 require('./logger') 时复用核心日志模块
'use strict';

module.exports = require('./core/lib/log');
