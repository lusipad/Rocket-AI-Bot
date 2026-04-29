import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getDevToolsMetrics, getStatus, type DevToolsMetrics } from '../api/client';

export default function Dashboard() {
  const [status, setStatus] = useState<any>(null);
  const [devTools, setDevTools] = useState<DevToolsMetrics | null>(null);

  useEffect(() => {
    Promise.all([
      getStatus(),
      getDevToolsMetrics(200),
    ]).then(([nextStatus, nextDevTools]) => {
      setStatus(nextStatus);
      setDevTools(nextDevTools);
    }).catch(console.error);
  }, []);

  if (!status) return <div>加载中...</div>;

  return (
    <div>
      <div className="card">
        <h2>Bot 状态</h2>
        <table>
          <tbody>
            <tr><td>运行时间</td><td>{Math.round(status.uptime / 60)} 分钟</td></tr>
            <tr><td>内存</td><td>{status.memory?.heapUsed}</td></tr>
            <tr>
              <td>Rocket.Chat</td>
              <td><span className={`badge ${status.connections?.rocketchat === 'connected' ? 'ok' : 'err'}`}>
                {status.connections?.rocketchat}
              </span></td>
            </tr>
            <tr>
              <td>LLM 熔断器</td>
              <td><span className={`badge ${status.connections?.llm === 'CLOSED' ? 'ok' : 'err'}`}>
                {status.connections?.llm}
              </span></td>
            </tr>
            <tr><td>默认模型</td><td>{status.model}</td></tr>
            <tr><td>深度模型</td><td>{status.deepModel ?? '-'}</td></tr>
            <tr><td>API 模式</td><td>{status.apiMode ?? '-'}</td></tr>
            <tr><td>调度任务</td><td>{status.scheduler?.active}/{status.scheduler?.total} 活跃</td></tr>
            <tr><td>Skills</td><td>{status.skills?.enabled}/{status.skills?.installed} 启用</td></tr>
            <tr><td>最近请求</td><td>{status.requests?.success}/{status.requests?.total} 成功</td></tr>
            <tr><td>聊天/任务</td><td>{status.requests?.byKind?.chat ?? 0}/{status.requests?.byKind?.scheduler ?? 0}</td></tr>
            <tr><td>版本</td><td>{status.version}</td></tr>
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>DevTools 工作流</h2>
        <table>
          <tbody>
            <tr><td>最近请求</td><td>{devTools?.devToolsTotal ?? 0}/{devTools?.total ?? 0}</td></tr>
            <tr><td>占比</td><td>{formatRate(devTools?.devToolsRate)}</td></tr>
            <tr><td>Source 覆盖</td><td>{devTools?.sourceCoverage.withSources ?? 0} 条 · {formatRate(devTools?.sourceCoverage.sourceRate)}</td></tr>
            <tr><td>请求类型</td><td>{formatCounts(devTools?.byRequestType)}</td></tr>
            <tr><td>工具</td><td>{formatCounts(devTools?.byTool)}</td></tr>
          </tbody>
        </table>
        <div style={{marginTop: 12}}>
          <Link to="/requests?requestType=pipeline_monitor" style={{marginRight: 12}}>Pipeline</Link>
          <Link to="/requests?requestType=pr_review" style={{marginRight: 12}}>PR</Link>
          <Link to="/requests?requestType=work_item_report">工作项</Link>
        </div>
      </div>
    </div>
  );
}

function formatRate(value: number | undefined): string {
  return value === undefined ? '-' : `${Math.round(value * 100)}%`;
}

function formatCounts(counts: Record<string, number> | undefined): string {
  if (!counts || Object.keys(counts).length === 0) {
    return '-';
  }

  return Object.entries(counts)
    .map(([name, count]) => `${name}: ${count}`)
    .join(', ');
}
