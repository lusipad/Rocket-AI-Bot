import { useEffect, useState } from 'react';
import { getTasks, createTask, deleteTask, runTask, updateTask } from '../api/client';

export default function Tasks() {
  const [tasks, setTasks] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', cron: '', room: 'general', enabled: true });

  async function load() {
    try { setTasks(await getTasks()); } catch {}
  }
  useEffect(() => { load(); }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    await createTask(form);
    setShowForm(false);
    setForm({ name: '', cron: '', room: 'general', enabled: true });
    load();
  }

  async function handleToggle(task: any) {
    await updateTask(task.name, { enabled: !task.enabled });
    load();
  }

  async function handleRun(name: string) {
    const r = await runTask(name);
    alert(r.success ? '执行成功' : r.error);
    load();
  }

  async function handleDelete(name: string) {
    if (!confirm(`删除任务 "${name}"?`)) return;
    await deleteTask(name);
    load();
  }

  return (
    <div>
      <div className="flex mb">
        <h2 style={{flex:1}}>任务管理</h2>
        <button onClick={() => setShowForm(!showForm)}>+ 新建任务</button>
      </div>

      {showForm && (
        <div className="card">
          <form onSubmit={handleCreate}>
            <div className="mb"><input type="text" placeholder="任务名称" value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })} required /></div>
            <div className="mb"><input type="text" placeholder="Cron 表达式 (如 0 9 * * 1-5)" value={form.cron}
              onChange={e => setForm({ ...form, cron: e.target.value })} required /></div>
            <div className="mb flex">
              <input type="text" placeholder="目标频道" value={form.room}
                onChange={e => setForm({ ...form, room: e.target.value })} />
              <button type="submit">创建</button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        <table>
          <thead><tr><th>名称</th><th>Cron</th><th>频道</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            {tasks.map(t => (
              <tr key={t.name}>
                <td>{t.name}</td>
                <td><code>{t.cron}</code></td>
                <td>{t.room}</td>
                <td><span className={`badge ${t.enabled ? 'ok' : 'warn'}`}>{t.enabled ? '启用' : '禁用'}</span></td>
                <td className="flex">
                  <button className="sm" onClick={() => handleToggle(t)}>{t.enabled ? '禁用' : '启用'}</button>
                  <button className="sm" onClick={() => handleRun(t.name)}>执行</button>
                  <button className="sm danger" onClick={() => handleDelete(t.name)}>删除</button>
                </td>
              </tr>
            ))}
            {tasks.length === 0 && <tr><td colSpan={5} style={{color:'#999'}}>暂无任务</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
