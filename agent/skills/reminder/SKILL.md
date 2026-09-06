# Reminder

用户要求“提醒”“别忘了”或周期提醒时使用。调用 `POST /api/tasks`，使用 `type=reminder` 及 `dueAt` 或 `kind=cron,cron`。提醒与待办、日程分开保存。
