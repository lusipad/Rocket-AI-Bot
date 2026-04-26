import { useEffect, useState } from 'react';
import { getStatus, probeApiModes, type ApiModeProbeSummary } from '../api/client';

export default function Config() {
  const [status, setStatus] = useState<any>(null);
  const [probe, setProbe] = useState<ApiModeProbeSummary | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);

  useEffect(() => {
    getStatus().then(setStatus).catch(console.error);
  }, []);

  async function handleProbe() {
    setProbing(true);
    setProbeError(null);
    try {
      setProbe(await probeApiModes());
    } catch (error) {
      setProbeError(error instanceof Error ? error.message : String(error));
    } finally {
      setProbing(false);
    }
  }

  return (
    <div>
      <div className="card">
        <h2>当前配置</h2>
        <table>
          <tbody>
            <tr><td>LLM 模型</td><td>{status?.model ?? '-'}</td></tr>
            <tr><td>深度模型</td><td>{status?.deepModel ?? '-'}</td></tr>
            <tr><td>API 模式</td><td>{status?.apiMode ?? '-'}</td></tr>
            <tr><td>Web 端口</td><td>{3001}</td></tr>
            <tr><td>Codex 路径</td><td>在 config/default.yaml 中配置</td></tr>
            <tr><td>仓库路径</td><td>在 config/default.yaml 中配置</td></tr>
          </tbody>
        </table>
        <p style={{marginTop:16,color:'#666',fontSize:13}}>
          详细配置请在 <code>config/default.yaml</code> 和 <code>.env</code> 中修改，重启生效。
        </p>
      </div>

      <div className="card">
        <div className="flex mb">
          <h2 style={{flex: 1, marginBottom: 0}}>LLM API 模式探测</h2>
          <button onClick={handleProbe} disabled={probing}>{probing ? '探测中...' : '开始探测'}</button>
        </div>
        {probeError && <p style={{color:'#721c24',fontSize:13,marginBottom:12}}>{probeError}</p>}
        {probe && (
          <>
            <table>
              <tbody>
                <tr><td>当前模式</td><td>{probe.current}</td></tr>
                <tr><td>推荐模式</td><td>{probe.recommended ?? '-'}</td></tr>
              </tbody>
            </table>
            <table style={{marginTop:12}}>
              <thead>
                <tr>
                  <th>模式</th>
                  <th>结果</th>
                  <th>耗时</th>
                  <th>模型</th>
                  <th>回复/错误</th>
                </tr>
              </thead>
              <tbody>
                {probe.results.map((item) => (
                  <tr key={item.mode}>
                    <td>{item.mode}</td>
                    <td>
                      <span className={`badge ${item.ok ? 'ok' : 'err'}`}>{item.ok ? '可用' : '失败'}</span>
                    </td>
                    <td>{item.durationMs} ms</td>
                    <td>{item.model ?? '-'}</td>
                    <td style={{maxWidth:420,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={item.reply ?? item.error ?? '-'}>
                      {item.reply ?? item.error ?? '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {!probe && !probeError && (
          <p style={{color:'#666',fontSize:13}}>
            探测会分别向 chat_completions 和 responses 发送一次最小请求，只展示推荐值，不会自动修改配置。
          </p>
        )}
      </div>
    </div>
  );
}
