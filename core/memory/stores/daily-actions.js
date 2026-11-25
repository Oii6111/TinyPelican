'use strict';

const { createHash } = require('node:crypto');

function actionFingerprint(action) {
  return createHash('sha256').update(JSON.stringify([action.kind, action.title.trim(), action.summary.trim()])).digest('hex');
}

/** 只按标题判断「是不是同一条」：换一批时用户嫌的就是这句话本身。 */
function titleKey(value) {
  return String(value || '').trim().replace(/\s+/g, '').toLocaleLowerCase();
}

function createDailyActionsStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS social_daily_batches (
      member_id INTEGER NOT NULL, local_date TEXT NOT NULL,
      contact_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', fingerprint TEXT NOT NULL DEFAULT '',
      generated_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
      error TEXT NOT NULL DEFAULT '', empty_reason TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(member_id, local_date)
    );
    CREATE TABLE IF NOT EXISTS social_daily_actions (
      id TEXT PRIMARY KEY, member_id INTEGER NOT NULL, local_date TEXT NOT NULL,
      fingerprint TEXT NOT NULL, payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', visible INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_social_daily_actions_member_date
      ON social_daily_actions(member_id, local_date);
  `);

  function decode(row) {
    if (!row) return null;
    return { ...JSON.parse(row.payload_json), id: row.id, memberId: row.member_id, date: row.local_date, status: row.status };
  }

  // 每个联系人「上次判下来的节奏」：既是下一次夹区间的基准，也是决策日志的存档。
  // 单独一条语句，幂等；不塞进上面那块建表里，避免和它纠缠在一起。
  db.exec(`
    CREATE TABLE IF NOT EXISTS social_interval_state (
      member_id INTEGER PRIMARY KEY,
      days INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      drivers_json TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'llm',
      clamped INTEGER NOT NULL DEFAULT 0,
      decided_at TEXT NOT NULL,
      goal TEXT NOT NULL DEFAULT ''
    );
  `);
  // 老库补列：社交目的改了以后旧节奏要作废，得留着它是针对哪一条目的算的
  try { db.exec("ALTER TABLE social_interval_state ADD COLUMN goal TEXT NOT NULL DEFAULT ''"); } catch {}

  function intervalState(memberId) {
    const row = db.prepare('SELECT * FROM social_interval_state WHERE member_id=?').get(memberId);
    if (!row) return null;
    let drivers = [];
    try { drivers = JSON.parse(row.drivers_json || '[]'); } catch {}
    return {
      days: Number(row.days),
      reason: row.reason || '',
      drivers: Array.isArray(drivers) ? drivers : [],
      source: row.source || 'llm',
      clamped: !!row.clamped,
      decidedAt: row.decided_at || '',
      goal: row.goal || ''
    };
  }

  function setIntervalState(memberId, { days, reason = '', drivers = [], source = 'llm', clamped = false, goal = '' }, now) {
    const safeDays = Math.max(1, Math.min(30, Math.round(Number(days) || 2)));
    db.prepare(`INSERT INTO social_interval_state(member_id,days,reason,drivers_json,source,clamped,decided_at,goal)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(member_id) DO UPDATE SET
      days=excluded.days,reason=excluded.reason,drivers_json=excluded.drivers_json,
      source=excluded.source,clamped=excluded.clamped,decided_at=excluded.decided_at,goal=excluded.goal`)
      .run(memberId, safeDays, String(reason || '').slice(0, 280),
        JSON.stringify(Array.isArray(drivers) ? drivers.slice(0, 4) : []),
        String(source || 'llm'), clamped ? 1 : 0, now, String(goal || '').trim().slice(0, 500));
    return intervalState(memberId);
  }

  function batch(memberId, date) {
    const row = db.prepare('SELECT * FROM social_daily_batches WHERE member_id=? AND local_date=?').get(memberId, date);
    if (!row) return null;
    return {
      status: row.status, fingerprint: row.fingerprint, generatedAt: row.generated_at,
      updatedAt: row.updated_at, error: row.error, emptyReason: row.empty_reason,
      contactName: row.contact_name
    };
  }

  function actions(memberId, date) {
    return db.prepare('SELECT * FROM social_daily_actions WHERE member_id=? AND local_date=? AND visible=1 ORDER BY created_at,id')
      .all(memberId, date).map(decode);
  }

  function queue(memberId, date, contactName, now) {
    db.prepare(`INSERT INTO social_daily_batches(member_id,local_date,contact_name,updated_at)
      VALUES(?,?,?,?) ON CONFLICT(member_id,local_date) DO UPDATE SET
      contact_name=excluded.contact_name,status='queued',error='',updated_at=excluded.updated_at`)
      .run(memberId, date, contactName, now);
  }

  function setStatus(memberId, date, status, now, error = '') {
    db.prepare('UPDATE social_daily_batches SET status=?,error=?,updated_at=? WHERE member_id=? AND local_date=?')
      .run(status, error, now, memberId, date);
  }

  /**
   * 落盘一次生成结果。
   * avoid：换一批时要避开的标题——模型很可能原样再给一遍，那就等于没换。
   * 若避开后一条新的都没换出来，保留原样返回 { reused: true }，别把用户正在看的建议清空。
   */
  function saveResult(memberId, date, result, fingerprint, now, { avoid = [] } = {}) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = actions(memberId, date);
      const handled = current.filter(action => action.status !== 'pending');
      const pending = current.filter(action => action.status === 'pending');
      const seen = new Set(handled.map(actionFingerprint));
      const avoided = new Set((avoid || []).map(titleKey).filter(Boolean));
      const fresh = [];
      for (const action of result.actions) {
        const digest = actionFingerprint(action);
        if (seen.has(digest) || avoided.has(titleKey(action.title)) || fresh.length >= Math.max(0, 2 - handled.length)) continue;
        seen.add(digest);
        fresh.push({ action, digest });
      }
      if (avoided.size && !fresh.length && pending.length) {
        db.exec('COMMIT');
        return { reused: true };
      }
      db.prepare("UPDATE social_daily_actions SET visible=0 WHERE member_id=? AND local_date=? AND status='pending'").run(memberId, date);
      const put = db.prepare(`INSERT INTO social_daily_actions(id,member_id,local_date,fingerprint,payload_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,visible=1,updated_at=excluded.updated_at`);
      for (const { action, digest } of fresh) {
        const id = 'daily_' + createHash('sha256').update(`${memberId}|${date}|${digest}`).digest('hex').slice(0, 24);
        put.run(id, memberId, date, digest, JSON.stringify(action), now, now);
      }
      db.prepare("UPDATE social_daily_batches SET status='ready',fingerprint=?,generated_at=?,updated_at=?,error='',empty_reason=? WHERE member_id=? AND local_date=?")
        .run(fingerprint, now, now, result.emptyReason || (!fresh.length && !handled.length ? '目前没有足够依据推荐具体行动，可以补充社交目的或近期聊天。' : ''), memberId, date);
      db.exec('COMMIT');
      return { reused: false };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function history(memberId, fromDate, throughDate) {
    return db.prepare('SELECT * FROM social_daily_actions WHERE member_id=? AND local_date>=? AND local_date<=? AND (visible=1 OR status<>?) ORDER BY local_date DESC,created_at DESC LIMIT 30')
      .all(memberId, fromDate, throughDate, 'pending').map(decode);
  }

  /** 近一段时间里，用户对建议的采纳/忽略次数（用于修正间隔，不用于内容生成）。 */
  function feedbackWindow(memberId, fromDate, throughDate) {
    const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM social_daily_actions
      WHERE member_id=? AND local_date>=? AND local_date<=? AND visible=1 AND status<>'pending'
      GROUP BY status`).all(memberId, fromDate, throughDate);
    const counts = { done: 0, dismissed: 0 };
    for (const row of rows) {
      if (row.status === 'done') counts.done += Number(row.n);
      else if (row.status === 'dismissed') counts.dismissed += Number(row.n);
    }
    return counts;
  }

  /** 上一次真正给出建议的日期，用于间隔判断。休息日不算，否则会连着休息下去。 */
  function lastGeneratedDate(memberId, beforeDate) {
    const row = db.prepare(`SELECT local_date FROM social_daily_batches
      WHERE member_id=? AND local_date<? AND status='ready'
      ORDER BY local_date DESC LIMIT 1`).get(memberId, beforeDate);
    return row ? row.local_date : '';
  }

  /** 按间隔跳过今天：写一条 resting 批次，避免前端把联系人当成待生成而反复请求。 */
  function rest(memberId, date, contactName, fingerprint, reason, now) {
    db.prepare(`INSERT INTO social_daily_batches(member_id,local_date,contact_name,status,fingerprint,error,empty_reason,updated_at)
      VALUES(?,?,?,'resting',?,'',?,?) ON CONFLICT(member_id,local_date) DO UPDATE SET
      contact_name=excluded.contact_name,status='resting',
      fingerprint=excluded.fingerprint,error='',empty_reason=excluded.empty_reason,updated_at=excluded.updated_at`)
      .run(memberId, date, contactName, fingerprint, reason, now);
  }

  function get(id) {
    return decode(db.prepare('SELECT * FROM social_daily_actions WHERE id=?').get(id));
  }

  function feedback(id, status, now) {
    const result = db.prepare('UPDATE social_daily_actions SET status=?,updated_at=? WHERE id=? AND visible=1').run(status, now, id);
    return result.changes ? get(id) : null;
  }

  function recover(now) {
    // 还没开始跑的批次直接抹掉，让当天首屏重新排队，用户看不到报错；
    // 只有真被中断的（running）才报错，等用户手动重试。
    db.prepare("DELETE FROM social_daily_batches WHERE status='queued'").run();
    db.prepare("UPDATE social_daily_batches SET status='error',error='上次生成已中断，请点击更新推荐重试。',updated_at=? WHERE status='running'").run(now);
  }

  return { batch, actions, queue, setStatus, saveResult, history, feedbackWindow, lastGeneratedDate, rest, get, feedback, recover, intervalState, setIntervalState };
}

module.exports = { createDailyActionsStore, actionFingerprint, titleKey };
