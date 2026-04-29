import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getRequest, getRequests, type RequestLog } from '../api/client';

type KindFilter = '' | 'chat' | 'scheduler';
type StatusFilter = '' | 'success' | 'error' | 'rejected';
type RequestTypeFilter = '' | 'code_query' | 'ado_query' | 'ado_file_review' | 'ado_file_lookup' | 'pr_review' | 'pipeline_monitor' | 'work_item_report' | 'public_realtime' | 'discussion' | 'scheduler' | 'general' | 'command';

export default function Requests() {
  const [requests, setRequests] = useState<RequestLog[]>([]);
  const [selected, setSelected] = useState<RequestLog | null>(null);
  const [kind, setKind] = useState<KindFilter>('');
  const [status, setStatus] = useState<StatusFilter>('');
  const [requestType, setRequestType] = useState<RequestTypeFilter>('');
  const [loading, setLoading] = useState(false);
  const [searchParams] = useSearchParams();

  async function load() {
    setLoading(true);
    try {
      const items = await getRequests({
        kind: kind || undefined,
        status: status || undefined,
        requestType: requestType || undefined,
        limit: 100,
      });
      setRequests(items);
      if (selected) {
        const refreshed = items.find((item) => item.requestId === selected.requestId);
        if (refreshed) {
          setSelected(await getRequest(refreshed.requestId));
        } else {
          setSelected(null);
        }
      }
    } finally {
      setLoading(false);
    }
  }

  async function openDetail(requestId: string) {
    setSelected(await getRequest(requestId));
  }

  useEffect(() => {
    load().catch(console.error);
  }, [kind, status, requestType]);

  useEffect(() => {
    const requestId = searchParams.get('requestId');
    const type = searchParams.get('requestType');
    if (type && isRequestTypeFilter(type)) {
      setRequestType(type);
    }
    if (requestId) {
      openDetail(requestId).catch(console.error);
    }
  }, [searchParams]);

  function formatSkillSources(item: RequestLog): string {
    if (item.activeSkills.length === 0) {
      return '-';
    }

    return item.activeSkills
      .map((name) => `${name} (${item.skillSources[name] ?? 'unknown'})`)
      .join(', ');
  }

  return (
    <div>
      <div className="flex mb">
        <h2 style={{flex: 1}}>请求记录</h2>
        <select value={kind} onChange={(e) => setKind(e.target.value as KindFilter)} style={{width: 140}}>
          <option value="">全部类型</option>
          <option value="chat">聊天</option>
          <option value="scheduler">定时任务</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} style={{width: 140}}>
          <option value="">全部状态</option>
          <option value="success">成功</option>
          <option value="error">失败</option>
          <option value="rejected">拒绝</option>
        </select>
        <select value={requestType} onChange={(e) => setRequestType(e.target.value as RequestTypeFilter)} style={{width: 180}}>
          <option value="">全部请求类型</option>
          <option value="pipeline_monitor">Pipeline</option>
          <option value="pr_review">PR Review</option>
          <option value="work_item_report">工作项报告</option>
          <option value="ado_file_review">ADO 文件 Review</option>
          <option value="ado_file_lookup">ADO 文件读取</option>
          <option value="ado_query">ADO 查询</option>
          <option value="code_query">代码查询</option>
          <option value="public_realtime">实时公开信息</option>
          <option value="discussion">讨论总结</option>
          <option value="scheduler">定时任务</option>
          <option value="command">指令</option>
          <option value="general">通用</option>
        </select>
        <button onClick={() => load()}>{loading ? '刷新中...' : '刷新'}</button>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>类型</th>
              <th>状态</th>
              <th>用户/任务</th>
              <th>房间</th>
              <th>请求类型</th>
              <th>模式</th>
              <th>耗时</th>
              <th>Skills</th>
              <th>Tools</th>
              <th>摘要</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((item) => (
              <tr key={item.requestId} onClick={() => openDetail(item.requestId)} style={{cursor: 'pointer'}}>
                <td>{new Date(item.finishedAt).toLocaleString()}</td>
                <td>{item.kind === 'chat' ? '聊天' : '定时任务'}</td>
                <td>
                  <span className={`badge ${item.status === 'success' ? 'ok' : item.status === 'rejected' ? 'warn' : 'err'}`}>
                    {item.status}
                  </span>
                </td>
                <td>{item.kind === 'chat' ? (item.username ?? '-') : (item.taskName ?? '-')}</td>
                <td>{item.roomId ?? '-'}</td>
                <td>{item.requestType ?? '-'}</td>
                <td>
                  <span className={`badge ${item.context?.modelMode === 'deep' ? 'warn' : 'ok'}`}>
                    {item.context?.modelMode === 'deep' ? '深度' : '普通'}
                  </span>
                </td>
                <td>{item.durationMs} ms</td>
                <td>{item.activeSkills.length > 0 ? item.activeSkills.join(', ') : '-'}</td>
                <td>{item.usedTools.length > 0 ? item.usedTools.join(', ') : '-'}</td>
                <td style={{maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
                  {item.prompt}
                </td>
              </tr>
            ))}
            {requests.length === 0 && (
              <tr>
                <td colSpan={11} style={{color: '#999'}}>暂无请求记录</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className="card">
          <h2>请求详情</h2>
          <table>
            <tbody>
              <tr><td>Request ID</td><td><code>{selected.requestId}</code></td></tr>
              <tr><td>类型</td><td>{selected.kind}</td></tr>
              <tr><td>状态</td><td>{selected.status}</td></tr>
              <tr><td>完成原因</td><td>{selected.finishReason ?? '-'}</td></tr>
              <tr><td>请求类型</td><td>{selected.requestType ?? '-'}</td></tr>
              <tr><td>模式</td><td>{selected.context?.modelMode === 'deep' ? '深度' : '普通'}</td></tr>
              <tr><td>模型</td><td>{selected.model}</td></tr>
              <tr><td>耗时</td><td>{selected.durationMs} ms</td></tr>
              <tr><td>轮次</td><td>{selected.rounds}</td></tr>
              <tr><td>用户</td><td>{selected.username ?? '-'}</td></tr>
              <tr><td>任务</td><td>{selected.taskName ?? '-'}</td></tr>
              <tr><td>任务模板</td><td>{selected.taskTemplateId ?? '-'}</td></tr>
              <tr><td>房间</td><td>{selected.roomId ?? '-'}</td></tr>
              <tr><td>Skills</td><td>{selected.activeSkills.join(', ') || '-'}</td></tr>
              <tr><td>Skill 来源</td><td>{formatSkillSources(selected)}</td></tr>
              <tr><td>Tools</td><td>{selected.usedTools.join(', ') || '-'}</td></tr>
              <tr>
                <td>Sources</td>
                <td>
                  {selected.sources && selected.sources.length > 0
                    ? selected.sources.map((source) => source.url
                      ? <div key={`${source.type}:${source.ref}`}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a></div>
                      : <div key={`${source.type}:${source.ref}`}>{source.title} <code>{source.ref}</code></div>)
                    : '-'}
                </td>
              </tr>
            </tbody>
          </table>

          <div style={{marginTop: 16}}>
            <div style={{marginBottom: 8, fontWeight: 600}}>请求内容</div>
            <pre style={{whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#f7f7f9', border: '1px solid #eee', borderRadius: 6, padding: 12, fontSize: 13, lineHeight: 1.5}}>
              {selected.prompt}
            </pre>
          </div>

          <div style={{marginTop: 16}}>
            <div style={{marginBottom: 8, fontWeight: 600}}>回复预览</div>
            <pre style={{whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#f7f7f9', border: '1px solid #eee', borderRadius: 6, padding: 12, fontSize: 13, lineHeight: 1.5}}>
              {selected.reply ?? selected.error ?? '-'}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function isRequestTypeFilter(value: string): value is RequestTypeFilter {
  return [
    'code_query',
    'ado_query',
    'ado_file_review',
    'ado_file_lookup',
    'pr_review',
    'pipeline_monitor',
    'work_item_report',
    'public_realtime',
    'discussion',
    'scheduler',
    'general',
    'command',
  ].includes(value);
}
