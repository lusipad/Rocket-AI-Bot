import { useEffect, useState } from 'react';
import { getHistory } from '../api/client';

export default function TaskLogs() {
  const [logs, setLogs] = useState<any[]>([]);

  async function load() {
    try { setLogs(await getHistory()); } catch {}
  }
  useEffect(() => { load(); }, []);

  return (
    <div>
      <div className="flex mb">
        <h2 style={{flex:1}}>执行日志</h2>
        <button onClick={load}>刷新</button>
      </div>
      <div className="card">
        <table>
          <thead><tr><th>任务</th><th>时间</th><th>结果</th><th>输出</th></tr></thead>
          <tbody>
            {logs.map((l, i) => (
              <tr key={i}>
                <td>{l.taskName}</td>
                <td>{new Date(l.timestamp).toLocaleString()}</td>
                <td><span className={`badge ${l.success ? 'ok' : 'err'}`}>{l.success ? '成功' : '失败'}</span></td>
                <td style={{maxWidth:400,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                  {l.output ?? l.error ?? '-'}
                </td>
              </tr>
            ))}
            {logs.length === 0 && <tr><td colSpan={4} style={{color:'#999'}}>暂无记录</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
