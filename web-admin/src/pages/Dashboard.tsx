import { useEffect, useState } from 'react';
import { getStatus, getTasks } from '../api/client';

export default function Dashboard() {
  const [status, setStatus] = useState<any>(null);
  const [taskCount, setTaskCount] = useState(0);

  useEffect(() => {
    getStatus().then(setStatus).catch(console.error);
    getTasks().then((t) => setTaskCount(t.length)).catch(() => {});
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
            <tr><td>模型</td><td>{status.model}</td></tr>
            <tr><td>调度任务</td><td>{status.scheduler?.active}/{status.scheduler?.total} 活跃</td></tr>
            <tr><td>版本</td><td>{status.version}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
