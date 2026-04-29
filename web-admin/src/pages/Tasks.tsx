import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getTasks,
  getTaskTemplates,
  createTask,
  createTaskFromTemplate,
  deleteTask,
  runTask,
  updateTask,
  type Task,
  type TaskTemplate,
  type TaskRunResult,
} from '../api/client';

const EMPTY_FORM: Task = {
  name: '',
  prompt: '',
  cron: '',
  room: 'general',
  enabled: true,
};

export default function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [form, setForm] = useState<Task>(EMPTY_FORM);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [runResults, setRunResults] = useState<Record<string, TaskRunResult>>({});

  async function load() {
    try {
      const [nextTasks, nextTemplates] = await Promise.all([
        getTasks(),
        getTaskTemplates(),
      ]);
      setTasks(nextTasks);
      setTemplates(nextTemplates);
    } catch {}
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
      if (selectedTemplateId) {
        await createTaskFromTemplate({ ...form, templateId: selectedTemplateId });
      } else {
        await createTask(form);
      }
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
    setRunResults(results => ({ ...results, [name]: r }));
    alert(r.success ? '执行成功' : (r.error ?? '执行失败'));
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
    setSelectedTemplateId(task.templateId ?? null);
    setShowForm(true);
  }

  function handleUseTemplate(template: TaskTemplate) {
    setEditingName(null);
    setSelectedTemplateId(template.id);
    setForm({
      name: suggestTaskName(template.id),
      templateId: template.id,
      prompt: template.defaultPrompt,
      cron: template.defaultCron,
      room: template.defaultRoom,
      enabled: true,
    });
    setShowForm(true);
  }

  function suggestTaskName(templateId: string): string {
    if (!tasks.some(task => task.name === templateId)) return templateId;
    let index = 2;
    while (tasks.some(task => task.name === `${templateId}-${index}`)) index += 1;
    return `${templateId}-${index}`;
  }

  function resetForm() {
    setEditingName(null);
    setSelectedTemplateId(null);
    setForm(EMPTY_FORM);
    setShowForm(false);
  }

  const selectedTemplate = templates.find(template => template.id === selectedTemplateId);

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

      {templates.length > 0 && (
        <div className="card">
          <h2>DevTools 任务模板</h2>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))',gap:12}}>
            {templates.map(template => (
              <div key={template.id} style={{border:'1px solid #eee',borderRadius:8,padding:12}}>
                <div className="flex mb" style={{alignItems:'flex-start'}}>
                  <div style={{flex:1}}>
                    <strong>{template.title}</strong>
                    <div style={{fontSize:12,color:'#666',marginTop:4}}>{template.description}</div>
                  </div>
                  <span className="badge ok">{template.category}</span>
                </div>
                <div style={{fontSize:12,color:'#666',marginBottom:10}}>
                  <code>{template.defaultCron}</code> · #{template.defaultRoom}
                </div>
                <button className="sm" type="button" onClick={() => handleUseTemplate(template)}>
                  使用模板
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {showForm && (
        <div className="card">
          <h2>{editingName ? '编辑任务' : '创建任务'}</h2>
          {selectedTemplate && (
            <div className="mb" style={{fontSize:13,color:'#555'}}>
              基于模板：<strong>{selectedTemplate.title}</strong>
            </div>
          )}
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
          <thead><tr><th>名称</th><th>来源</th><th>任务内容</th><th>Cron</th><th>频道</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            {tasks.map(t => {
              const runRequestId = runResults[t.name]?.requestId;
              return (
                <tr key={t.name}>
                  <td>{t.name}</td>
                  <td>{t.templateId ? <code>{t.templateId}</code> : '自定义'}</td>
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
                    {runRequestId && (
                      <Link to={`/requests?requestId=${encodeURIComponent(runRequestId)}`} style={{fontSize:12}}>
                        请求日志
                      </Link>
                    )}
                    <button className="sm danger" onClick={() => handleDelete(t.name)}>删除</button>
                  </td>
                </tr>
              );
            })}
            {tasks.length === 0 && <tr><td colSpan={7} style={{color:'#999'}}>暂无任务</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
