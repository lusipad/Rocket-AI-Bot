import { useState } from 'react';
import { Routes, Route, Link, useNavigate } from 'react-router-dom';
import { setToken, getToken, getStatus } from './api/client';
import Dashboard from './pages/Dashboard';
import Tasks from './pages/Tasks';
import TaskLogs from './pages/TaskLogs';
import Config from './pages/Config';

const style = `
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:system-ui,-apple-system,sans-serif; background:#f5f5f5; color:#333; }
nav { background:#1a1a2e; color:#fff; padding:0 24px; display:flex; align-items:center; height:56px; gap:24px; }
nav a { color:#a0a0c0; text-decoration:none; font-size:14px; padding:6px 0; border-bottom:2px solid transparent; }
nav a:hover,nav a.active { color:#fff; border-bottom-color:#6c63ff; }
nav .brand { font-weight:700; font-size:18px; color:#fff; margin-right:auto; }
main { max-width:1200px; margin:24px auto; padding:0 24px; }
.card { background:#fff; border-radius:8px; padding:20px; margin-bottom:16px; box-shadow:0 1px 3px rgba(0,0,0,0.1); }
.card h2 { font-size:16px; margin-bottom:12px; }
button { background:#6c63ff; color:#fff; border:none; padding:8px 16px; border-radius:6px; cursor:pointer; font-size:14px; }
button:hover { background:#5b52e0; }
button.danger { background:#dc3545; }
button.danger:hover { background:#c82333; }
button.sm { padding:4px 10px; font-size:12px; }
input,select { padding:8px 12px; border:1px solid #ddd; border-radius:6px; font-size:14px; width:100%; }
table { width:100%; border-collapse:collapse; }
th,td { text-align:left; padding:10px 8px; border-bottom:1px solid #eee; font-size:14px; }
th { font-weight:600; color:#666; }
.badge { display:inline-block; padding:2px 8px; border-radius:10px; font-size:12px; font-weight:600; }
.badge.ok { background:#d4edda; color:#155724; }
.badge.warn { background:#fff3cd; color:#856404; }
.badge.err { background:#f8d7da; color:#721c24; }
.auth { max-width:360px; margin:120px auto; }
.flex { display:flex; gap:12px; align-items:center; }
.mb { margin-bottom:12px; }
`;

export default function App() {
  const [authed, setAuthed] = useState(!!getToken());

  async function handleLogin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const t = (e.currentTarget.elements.namedItem('token') as HTMLInputElement).value;
    setToken(t);
    try {
      await getStatus();
      setAuthed(true);
    } catch {
      setToken(null);
      alert('Token 无效');
    }
  }

  if (!authed) {
    return (
      <>
        <style>{style}</style>
        <div className="auth card">
          <h2>RocketBot 管理</h2>
          <form onSubmit={handleLogin}>
            <input className="mb" type="password" name="token" placeholder="输入管理 Token" autoFocus />
            <button type="submit" style={{width:'100%'}}>登录</button>
          </form>
        </div>
      </>
    );
  }

  return (
    <>
      <style>{style}</style>
      <nav>
        <span className="brand">RocketBot</span>
        <Link to="/">仪表盘</Link>
        <Link to="/tasks">任务</Link>
        <Link to="/logs">日志</Link>
        <Link to="/config">配置</Link>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/logs" element={<TaskLogs />} />
          <Route path="/config" element={<Config />} />
        </Routes>
      </main>
    </>
  );
}
