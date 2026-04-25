import { useEffect, useState } from 'react';
import { getTasks, createTask, deleteTask, runTask, updateTask, type Task } from '../api/client';

const EMPTY_FORM: Task = {
  name: '',
  prompt: '',
  cron: '',
  room: 'general',
  enabled: true,
};

export default function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [form, setForm] = useState<Task>(EMPTY_FORM);

  async function load() {
    try { setTasks(await getTasks()); } catch {}
  }
  useEffect(() => { load(); }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (editingName) {
      await updateTask(editingName, {
        prompt: form.prompt,
        cron: form.cron,
        room: form.room,
        enabled: form.enabled,
      });
    } else {
      await createTask(form);
    }
    resetForm();
    load();
  }

  async function handleToggle(task: Task) {
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

  function handleEdit(task: Task) {
    setEditingName(task.name);
    setForm(task);
    setShowForm(true);
  }

  function resetForm() {
    setEditingName(null);
    setForm(EMPTY_FORM);
    setShowForm(false);
  }

  return (
    <div>
      <div className="flex mb">
        <h2 style={{flex:1}}>任务管理</h2>
        <button onClick={() => {
          if (showForm && !editingName) {
            resetForm();
            return;
          }
          setEditingName(null);
          setForm(EMPTY_FORM);
          setShowForm(true);
        }}
        >
          + 新建任务
        </button>
      </div>

      {showForm && (
        <div className="card">
          <form onSubmit={handleSubmit}>
            <div className="mb"><input type="text" placeholder="任务名称" value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })} disabled={!!editingName} required /></div>
            <div className="mb">
              <textarea
                placeholder="任务内容，例如：联网搜索最近24小时重要AI新闻，整理3条，每条包含标题、摘要和原始链接"
                value={form.prompt}
                onChange={e => setForm({ ...form, prompt: e.target.value })}
                rows={4}
                required
                style={{width:'100%',padding:'8px 12px',border:'1px solid #ddd',borderRadius:6,fontSize:14}}
              />
            </div>
            <div className="mb"><input type="text" placeholder="Cron 表达式 (如 0 9 * * 1-5)" value={form.cron}
              onChange={e => setForm({ ...form, cron: e.target.value })} required /></div>
            <div className="mb flex">
              <input type="text" placeholder="目标频道" value={form.room}
                onChange={e => setForm({ ...form, room: e.target.value })} />
            </div>
            <div className="mb flex">
              <label className="flex" style={{gap:8}}>
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={e => setForm({ ...form, enabled: e.target.checked })}
                  style={{width:'auto'}}
                />
                启用任务
              </label>
            </div>
            <div className="flex">
              <button type="submit">{editingName ? '保存' : '创建'}</button>
              <button type="button" onClick={resetForm}>取消</button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        <table>
          <thead><tr><th>名称</th><th>任务内容</th><th>Cron</th><th>频道</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            {tasks.map(t => (
              <tr key={t.name}>
                <td>{t.name}</td>
                <td style={{maxWidth:320,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={t.prompt}>
                  {t.prompt}
                </td>
                <td><code>{t.cron}</code></td>
                <td>{t.room}</td>
                <td><span className={`badge ${t.enabled ? 'ok' : 'warn'}`}>{t.enabled ? '启用' : '禁用'}</span></td>
                <td className="flex">
                  <button className="sm" onClick={() => handleEdit(t)}>编辑</button>
                  <button className="sm" onClick={() => handleToggle(t)}>{t.enabled ? '禁用' : '启用'}</button>
                  <button className="sm" onClick={() => handleRun(t.name)}>执行</button>
                  <button className="sm danger" onClick={() => handleDelete(t.name)}>删除</button>
                </td>
              </tr>
            ))}
            {tasks.length === 0 && <tr><td colSpan={6} style={{color:'#999'}}>暂无任务</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
