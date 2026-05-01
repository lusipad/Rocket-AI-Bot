import { useEffect, useState } from 'react';
import {
  clearDiscussionSummary,
  getContextPolicy,
  getDiscussionSummaries,
  rebuildDiscussionSummary,
  updateContextPolicy,
  type ContextPolicy,
  type DiscussionSummaryEntry,
} from '../api/client';

export default function ContextPage() {
  const [policy, setPolicy] = useState<ContextPolicy | null>(null);
  const [summaries, setSummaries] = useState<DiscussionSummaryEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [workingKey, setWorkingKey] = useState<string | null>(null);

  async function load() {
    setRefreshing(true);
    try {
      const [nextPolicy, nextSummaries] = await Promise.all([
        getContextPolicy(),
        getDiscussionSummaries(200),
      ]);
      setPolicy(nextPolicy);
      setSummaries(nextSummaries);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    load().catch(console.error);
  }, []);

  async function savePolicy() {
    if (!policy) return;
    setSaving(true);
    try {
      setPolicy(await updateContextPolicy(policy));
    } finally {
      setSaving(false);
    }
  }

  async function clearSummary(item: DiscussionSummaryEntry) {
    const key = buildSummaryKey(item);
    setWorkingKey(key);
    try {
      await clearDiscussionSummary({ roomId: item.roomId, threadId: item.threadId });
      await load();
    } finally {
      setWorkingKey(null);
    }
  }

  async function rebuildSummary(item: DiscussionSummaryEntry) {
    const key = buildSummaryKey(item);
    setWorkingKey(key);
    try {
      await rebuildDiscussionSummary({
        roomId: item.roomId,
        roomType: item.roomType,
        threadId: item.threadId,
      });
      await load();
    } finally {
      setWorkingKey(null);
    }
  }

  if (!policy) {
    return <div>加载中...</div>;
  }

  return (
    <div>
      <div className="flex mb">
        <h2 style={{flex: 1}}>上下文治理</h2>
        <button className="sm" onClick={() => load()}>{refreshing ? '刷新中...' : '刷新'}</button>
        <button onClick={() => savePolicy()} disabled={saving}>{saving ? '保存中...' : '保存策略'}</button>
      </div>

      <div className="card">
        <h2>上下文策略</h2>
        <p style={{marginBottom: 12, color: '#666', fontSize: 13}}>
          这些设置只影响后台如何选取上下文，不改变用户提问方式。
        </p>
        <table>
          <thead>
            <tr>
              <th>范围</th>
              <th>普通请求最近消息</th>
              <th>讨论型请求最近消息</th>
              <th>启用讨论摘要</th>
            </tr>
          </thead>
          <tbody>
            {renderScopeRow('私聊', policy.direct, (patch) => setPolicy({ ...policy, direct: { ...policy.direct, ...patch } }))}
            {renderScopeRow('房间', policy.group, (patch) => setPolicy({ ...policy, group: { ...policy.group, ...patch } }))}
            {renderScopeRow('Thread', policy.thread, (patch) => setPolicy({ ...policy, thread: { ...policy.thread, ...patch } }))}
          </tbody>
        </table>
        <div style={{marginTop: 16}}>
          <div style={{fontWeight: 600, marginBottom: 8}}>公开频道回看窗口</div>
          <div className="flex">
            <label style={{flex: 1}}>
              <div style={{marginBottom: 6, color: '#666', fontSize: 13}}>普通请求（分钟）</div>
              <input
                type="number"
                value={policy.publicChannel.lookbackMinutes}
                min={5}
                max={1440}
                onChange={(e) => setPolicy({
                  ...policy,
                  publicChannel: {
                    ...policy.publicChannel,
                    lookbackMinutes: Number(e.target.value),
                  },
                })}
              />
            </label>
            <label style={{flex: 1}}>
              <div style={{marginBottom: 6, color: '#666', fontSize: 13}}>讨论型请求（分钟）</div>
              <input
                type="number"
                value={policy.publicChannel.discussionLookbackMinutes}
                min={5}
                max={1440}
                onChange={(e) => setPolicy({
                  ...policy,
                  publicChannel: {
                    ...policy.publicChannel,
                    discussionLookbackMinutes: Number(e.target.value),
                  },
                })}
              />
            </label>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>讨论摘要缓存</h2>
        <table>
          <thead>
            <tr>
              <th>范围</th>
              <th>房间</th>
              <th>消息数</th>
              <th>更新时间</th>
              <th>摘要</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {summaries.map((item) => {
              const key = buildSummaryKey(item);
              const busy = workingKey === key;
              return (
                <tr key={key}>
                  <td>{item.threadId ? 'Thread' : '房间'}</td>
                  <td>
                    <div>{item.roomId}</div>
                    {item.threadId && <div style={{color: '#666', fontSize: 12}}>thread: {item.threadId}</div>}
                  </td>
                  <td>{item.sourceMessageCount}</td>
                  <td>{new Date(item.updatedAt).toLocaleString()}</td>
                  <td style={{maxWidth: 420}}>
                    <div style={{whiteSpace: 'pre-wrap', wordBreak: 'break-word'}}>{item.summary}</div>
                  </td>
                  <td>
                    <div className="flex">
                      <button className="sm" disabled={busy} onClick={() => rebuildSummary(item)}>
                        {busy ? '处理中...' : '重建'}
                      </button>
                      <button className="sm danger" disabled={busy} onClick={() => clearSummary(item)}>
                        清空
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {summaries.length === 0 && (
              <tr>
                <td colSpan={6} style={{color: '#999'}}>暂无讨论摘要缓存</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function renderScopeRow(
  label: string,
  scope: ContextPolicy['direct'],
  update: (patch: Partial<ContextPolicy['direct']>) => void,
) {
  return (
    <tr key={label}>
      <td>{label}</td>
      <td>
        <input
          type="number"
          value={scope.recentMessageCount}
          min={1}
          max={120}
          onChange={(e) => update({ recentMessageCount: Number(e.target.value) })}
        />
      </td>
      <td>
        <input
          type="number"
          value={scope.discussionRecentMessageCount}
          min={1}
          max={120}
          onChange={(e) => update({ discussionRecentMessageCount: Number(e.target.value) })}
        />
      </td>
      <td>
        <label className="flex" style={{gap: 8}}>
          <input
            type="checkbox"
            checked={scope.summaryEnabled}
            onChange={(e) => update({ summaryEnabled: e.target.checked })}
            style={{width: 'auto'}}
          />
          启用
        </label>
      </td>
    </tr>
  );
}

function buildSummaryKey(item: DiscussionSummaryEntry): string {
  return `${item.roomId}::${item.threadId ?? 'root'}`;
}
