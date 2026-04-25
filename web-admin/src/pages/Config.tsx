import { useEffect, useState } from 'react';
import { getStatus } from '../api/client';

export default function Config() {
  const [status, setStatus] = useState<any>(null);

  useEffect(() => {
    getStatus().then(setStatus).catch(console.error);
  }, []);

  return (
    <div>
      <div className="card">
        <h2>当前配置</h2>
        <table>
          <tbody>
            <tr><td>LLM 模型</td><td>{status?.model ?? '-'}</td></tr>
            <tr><td>Web 端口</td><td>{3001}</td></tr>
            <tr><td>Codex 路径</td><td>在 config/default.yaml 中配置</td></tr>
            <tr><td>仓库路径</td><td>在 config/default.yaml 中配置</td></tr>
          </tbody>
        </table>
        <p style={{marginTop:16,color:'#666',fontSize:13}}>
          详细配置请在 <code>config/default.yaml</code> 和 <code>.env</code> 中修改，重启生效。
        </p>
      </div>
    </div>
  );
}
