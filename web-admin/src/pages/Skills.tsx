import { useEffect, useState, type FormEvent } from 'react';
import {
  deleteSkill,
  getSkill,
  getSkills,
  installSkill,
  reloadSkills,
  updateSkill,
  type Skill,
  type SkillDetail,
} from '../api/client';

const OFFICIAL_SKILL_SOURCE = 'https://github.com/openai/skills';
const OFFICIAL_SKILL_SUBDIR = 'skills/.curated/openai-docs';

export default function Skills() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [saving, setSaving] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [selectedSkillName, setSelectedSkillName] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<SkillDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installSource, setInstallSource] = useState('');
  const [installSubdir, setInstallSubdir] = useState('');

  async function refresh() {
    try {
      const nextSkills = await getSkills();
      setSkills(nextSkills);
      if (selectedSkillName && nextSkills.some((skill) => skill.name === selectedSkillName)) {
        await loadDetail(selectedSkillName);
      } else if (selectedSkillName) {
        setSelectedSkillName(null);
        setSelectedSkill(null);
      }
    } catch (error) {
      console.error(error);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function reload() {
    try {
      setReloading(true);
      const nextSkills = await reloadSkills();
      setSkills(nextSkills);
      if (selectedSkillName && nextSkills.some((skill) => skill.name === selectedSkillName)) {
        await loadDetail(selectedSkillName);
      } else if (selectedSkillName) {
        setSelectedSkillName(null);
        setSelectedSkill(null);
      }
    } catch (error) {
      console.error(error);
      alert(error instanceof Error ? error.message : String(error));
    } finally {
      setReloading(false);
    }
  }

  async function toggle(skill: Skill) {
    try {
      setSaving(skill.name);
      const updated = await updateSkill(skill.name, !skill.enabled);
      setSkills((current) => current.map((item) => item.name === updated.name ? updated : item));
      if (selectedSkillName === updated.name) {
        setSelectedSkill((current) => current ? { ...current, enabled: updated.enabled } : current);
      }
    } finally {
      setSaving(null);
    }
  }

  async function loadDetail(name: string) {
    try {
      setLoadingDetail(true);
      setSelectedSkillName(name);
      const detail = await getSkill(name);
      setSelectedSkill(detail);
    } catch (error) {
      console.error(error);
      alert(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingDetail(false);
    }
  }

  async function remove(skill: Skill) {
    if (!confirm(`确认卸载 skill "${skill.name}" 吗？这会从项目的 .agents/skills 目录中移除它。`)) {
      return;
    }

    try {
      setRemoving(skill.name);
      const nextSkills = await deleteSkill(skill.name);
      setSkills(nextSkills);
      if (selectedSkillName === skill.name) {
        setSelectedSkillName(null);
        setSelectedSkill(null);
      }
    } catch (error) {
      console.error(error);
      alert(error instanceof Error ? error.message : String(error));
    } finally {
      setRemoving(null);
    }
  }

  async function install(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!installSource.trim()) {
      alert('请先填写 Git 仓库地址或本地仓库路径。');
      return;
    }

    try {
      setInstalling(true);
      const response = await installSkill({
        source: installSource.trim(),
        subdir: installSubdir.trim() || undefined,
      });
      setSkills(response.skills);
      setSelectedSkillName(response.installed.name);
      setSelectedSkill(response.installed);
      setInstallSource('');
      setInstallSubdir('');
    } catch (error) {
      console.error(error);
      alert(error instanceof Error ? error.message : String(error));
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div>
      <div className="card">
        <div className="flex mb">
          <h2 style={{ flex: 1 }}>Skills</h2>
          <button className="sm" onClick={refresh}>刷新</button>
          <button className="sm" onClick={reload} disabled={reloading}>
            {reloading ? '扫描中...' : '重新扫描'}
          </button>
        </div>
        <p style={{ marginBottom: 12, color: '#666', fontSize: 13 }}>
          这里显示已装载的项目级 skills。安装外部 skill 后，点“重新扫描”即可发现；启用后才会出现在聊天可用 skill 列表里。
        </p>
        <form onSubmit={install} style={{ marginBottom: 16 }}>
          <div className="flex mb">
            <input
              type="text"
              placeholder={`例如：${OFFICIAL_SKILL_SOURCE}`}
              value={installSource}
              onChange={(event) => setInstallSource(event.target.value)}
              disabled={installing}
            />
            <input
              type="text"
              placeholder={`例如：${OFFICIAL_SKILL_SUBDIR}`}
              value={installSubdir}
              onChange={(event) => setInstallSubdir(event.target.value)}
              disabled={installing}
            />
            <button className="sm" type="submit" disabled={installing}>
              {installing ? '安装中...' : '安装 skill'}
            </button>
            <button
              className="sm"
              type="button"
              disabled={installing}
              onClick={() => {
                setInstallSource(OFFICIAL_SKILL_SOURCE);
                setInstallSubdir(OFFICIAL_SKILL_SUBDIR);
              }}
            >
              填入官方示例
            </button>
          </div>
          <div style={{ color: '#666', fontSize: 12 }}>
            默认从仓库里自动识别唯一的 `SKILL.md`；如果仓库里有多个 skill，请填写子目录。
          </div>
          <div style={{ color: '#666', fontSize: 12, marginTop: 6 }}>
            官方示例：`{OFFICIAL_SKILL_SOURCE}` + `{OFFICIAL_SKILL_SUBDIR}`
          </div>
        </form>
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>说明</th>
              <th>允许工具</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {skills.map((skill) => (
              <tr key={skill.name}>
                <td>
                  <div>{skill.name}</div>
                  <div style={{ color: '#999', fontSize: 12 }}>{skill.filePath}</div>
                </td>
                <td>{skill.description}</td>
                <td>{skill.allowedTools.length > 0 ? skill.allowedTools.join(', ') : '不限'}</td>
                <td>
                  <span className={`badge ${skill.enabled ? 'ok' : 'warn'}`}>
                    {skill.enabled ? '已启用' : '未启用'}
                  </span>
                </td>
                <td>
                  <div className="flex">
                    <button
                      className="sm"
                      onClick={() => loadDetail(skill.name)}
                      disabled={loadingDetail && selectedSkillName === skill.name}
                    >
                      详情
                    </button>
                    <button
                      className="sm"
                      onClick={() => toggle(skill)}
                      disabled={saving === skill.name}
                    >
                      {skill.enabled ? '禁用' : '启用'}
                    </button>
                    <button
                      className="sm danger"
                      onClick={() => remove(skill)}
                      disabled={removing === skill.name}
                    >
                      卸载
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {skills.length === 0 && (
              <tr>
                <td colSpan={5} style={{ color: '#999' }}>暂无已装载 skill</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Skill 详情</h2>
        {!selectedSkill && (
          <div style={{ color: '#999' }}>选择一个 skill 查看详情。</div>
        )}
        {selectedSkill && (
          <div>
            <table>
              <tbody>
                <tr><td>名称</td><td>{selectedSkill.name}</td></tr>
                <tr><td>说明</td><td>{selectedSkill.description}</td></tr>
                <tr><td>状态</td><td>{selectedSkill.enabled ? '已启用' : '未启用'}</td></tr>
                <tr><td>文件</td><td>{selectedSkill.filePath}</td></tr>
                <tr><td>目录</td><td>{selectedSkill.directory}</td></tr>
                <tr><td>允许工具</td><td>{selectedSkill.allowedTools.length > 0 ? selectedSkill.allowedTools.join(', ') : '不限'}</td></tr>
              </tbody>
            </table>
            <div style={{ marginTop: 16 }}>
              <div style={{ marginBottom: 8, fontWeight: 600 }}>SKILL 指令</div>
              <pre style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                background: '#f7f7f9',
                border: '1px solid #eee',
                borderRadius: 6,
                padding: 12,
                fontSize: 13,
                lineHeight: 1.5,
              }}
              >
                {selectedSkill.instructions}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
