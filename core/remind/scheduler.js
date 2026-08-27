// 小鹈鹕核心 — 进程内定时调度（替代外部 cron）
'use strict';

const { log } = require('../lib/log');

class Scheduler {
  constructor() {
    this.jobs = [];
    this.timers = new Map();
    this.running = false;
  }

  register({ name, intervalMs, run, immediate = false }) {
    if (!name || !intervalMs || typeof run !== 'function') {
      throw new Error('定时任务需要 name/intervalMs/run');
    }
    this.jobs.push({ name, intervalMs, run, running: false });
    if (immediate && this.running) {
      this._run(this.jobs[this.jobs.length - 1]);
    }
  }

  start() {
    this.running = true;
    for (const job of this.jobs) {
      this._schedule(job);
      log('info', 'scheduler', `已注册定时任务 ${job.name}（每 ${Math.round(job.intervalMs / 60000)} 分钟）`);
      if (job.immediate) this._run(job);
    }
  }

  _schedule(job) {
    if (!this.running) return;
    const timer = setTimeout(() => this._run(job), job.intervalMs);
    this.timers.set(job.name, timer);
  }

  async _run(job) {
    if (job.running || !this.running) return;
    job.running = true;
    try {
      await job.run();
    } catch (e) {
      log('error', 'scheduler', `${job.name} 执行异常：${(e && e.message) || e}`);
    } finally {
      job.running = false;
      if (this.running) this._schedule(job);
    }
  }

  stop() {
    this.running = false;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

module.exports = { Scheduler };
