import { useEffect, useState } from 'react';
import { getStatus } from '../api/client';

export default function Dashboard() {
  const [status, setStatus] = useState<any>(null);

  useEffect(() => {
    getStatus().then(setStatus).catch(console.error);
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
    </div>
  );
}
