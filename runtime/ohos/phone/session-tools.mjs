// 放行「上次运行被中断」的会话。
// 引擎的 lifecycle 守卫会把「工具已经派发、但结果没拿到」的调用永久记成 unknown：此后该会话的
// 每一步 admission 都会抛 ERR_OHOS_LIFECYCLE_RESULT_UNKNOWN，界面上显示成反复的「本轮运行失败」。
// 唯一的解锁口是 coordinator.acknowledgeUnknown(sessionId)，而手机端 Flutter 层没有对应按钮
// （Dart 不参与本机构建），所以把入口做成手机工具：任何对话里都能列出来并放行。
const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
const result = (ok, code, message, data) => ({ ok, code, message, data: data ?? '' });
const schema = { type: 'object', additionalProperties: false,
  properties: { ok: { type: 'boolean' }, code: { type: 'string' }, message: { type: 'string' }, data: { type: 'string' } },
  required: ['ok', 'code', 'message', 'data'] };
const str = (description) => ({ type: 'string', description });

// 与 coordinator：#unresolved / status() 的判定保持一致。
const unresolvedRows = (status) => (Array.isArray(status && status.calls) ? status.calls : [])
  .filter((row) => row && !row.active && (row.reconciliation?.blocking === true || row.phase !== 'committed') && row.reconciliation?.blocking !== false);

const bySession = (rows) => {
  const groups = new Map();
  for (const row of rows) {
    const id = String(row.sessionId ?? '');
    if (id.length === 0) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  return groups;
};

const describeRows = (rows) => rows.slice(0, 8).map((row) => '#' + row.callSeq + ' ' + String(row.phase)
  + (row.reconciliation ? '/' + String(row.reconciliation.basis) + (row.reconciliation.blocking ? '（阻塞）' : '') : '')).join('、');

const brief = (error) => String((error && (error.code ? error.code + ' ' : '')) + String((error && error.message) || error)).slice(0, 200);

async function runSession(ctx, args) {
  const coordinator = ctx.ohosLifecycle;
  if (!coordinator || typeof coordinator.status !== 'function') {
    return result(false, 'unsupported', '本机没有生命周期协调器，无法列出或放行会话', '');
  }
  const action = String(args.action || 'list');
  const wanted = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
  if (action === 'list') {
    const status = coordinator.status(wanted.length > 0 ? wanted : undefined);
    const groups = bySession(unresolvedRows(status));
    if (groups.size === 0) return result(true, 'ok', '没有被中断的会话：历史工具结果都已结算', '');
    const lines = [...groups.entries()].map(([id, rows]) => id + '：' + rows.length + ' 个未结算调用（' + describeRows(rows) + '）');
    return result(true, 'blocked', '有 ' + groups.size + ' 个会话因上次运行被中断而锁住，在这个会话里继续发消息会一直「本轮运行失败」；'
      + '用 action=release（可带 sessionId，不带就全部放行）把它们解开。', lines.join('\n'));
  }
  if (action === 'release') {
    if (typeof coordinator.acknowledgeUnknown !== 'function') {
      return result(false, 'unsupported', '这版引擎没有 acknowledgeUnknown，无法放行', '');
    }
    const status = coordinator.status(wanted.length > 0 ? wanted : undefined);
    const groups = bySession(unresolvedRows(status));
    const targets = wanted.length > 0 ? [wanted] : [...groups.keys()];
    if (targets.length === 0) return result(true, 'ok', '没有被中断的会话需要放行', '');
    const lines = [];
    let failed = 0;
    for (const id of targets) {
      try {
        const after = await coordinator.acknowledgeUnknown(id);
        lines.push('已放行 ' + id + ' → state=' + String(after && after.state));
      } catch (error) {
        failed += 1;
        lines.push('放行失败 ' + id + '：' + brief(error));
      }
    }
    return result(failed === 0, failed === 0 ? 'ok' : 'partial',
      failed === 0 ? '已放行 ' + targets.length + ' 个会话，回到对应会话继续发消息即可（被中断那一步的结果按「未知」丢弃，不会重放）'
        : failed + '/' + targets.length + ' 个会话没有放行，原因见下',
      lines.join('\n'));
  }
  return result(false, 'invalid_args', 'action 只支持 list / release', '');
}

export const sessionCatalog = Object.freeze([{
  name: 'mcp__phone__session',
  description: '列出并放行「上次运行被中断」的 DSH 会话。DSH 引擎死于工具执行中途时（进程被杀、崩溃、关机），该会话会被安全守卫永久锁住：之后每次发消息都只得到「本轮运行失败 Previous tool results require reconciliation」。'
    + 'action=list 列出被锁住的会话及其未结算调用；action=release 放弃这些未知结果并解锁（可带 sessionId，不带则放行全部），被中断那一步不会重放。',
  parameters: { type: 'object', additionalProperties: false, properties: {
    action: { type: 'string', enum: ['list', 'release'], description: 'list 只查看，release 放行（会丢弃被中断那一步的结果）' },
    sessionId: str('可选，会话 id（形如 session-xxxx）；release 时只放行这一个') },
    required: ['action'] },
}]);

export function registerSessionTools(ctx) {
  const disposers = [];
  try {
    for (const definition of sessionCatalog) {
      disposers.push(ctx.tools.register({
        name: definition.name, description: definition.description, parameters: definition.parameters,
        timeoutMs: 60000,
        output: { schema, render: (_args, value) => text(value) },
        async execute(args) {
          try { return await runSession(ctx, args || {}); }
          catch (error) { return result(false, 'failed', brief(error), ''); }
        },
      }));
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
