import type { TaskDef } from './persistence.js';

export interface TaskTemplate {
  id: string;
  title: string;
  description: string;
  category: 'azure-devops';
  defaultCron: string;
  defaultRoom: string;
  defaultPrompt: string;
}

export interface TaskTemplateInput {
  name: string;
  room?: string;
  cron?: string;
  prompt?: string;
  enabled?: boolean;
}

const TASK_TEMPLATES: TaskTemplate[] = [
  {
    id: 'pr-status-summary',
    title: 'PR 状态摘要',
    description: '汇总 main 分支相关 PR、评审阻塞点和下一步动作。',
    category: 'azure-devops',
    defaultCron: '0 10 * * 1-5',
    defaultRoom: 'general',
    defaultPrompt: [
      '检查 Azure DevOps Server 中 main 分支相关的 PR 和评审动态。',
      '输出待处理 PR、阻塞原因、需要关注的文件或评审意见，以及今天建议推进的下一步。',
      '只基于可检索到的 Azure DevOps 数据回答；如果权限或数据不足，明确说明缺口，不要编造。',
    ].join('\n'),
  },
  {
    id: 'pipeline-health-check',
    title: 'Pipeline 健康检查',
    description: '检查 main 分支最近构建或发布状态并归纳失败风险。',
    category: 'azure-devops',
    defaultCron: '30 10 * * 1-5',
    defaultRoom: 'general',
    defaultPrompt: [
      '检查 Azure DevOps Server 中 main 分支最近的 pipeline/build 状态。',
      '输出失败或不稳定的构建、失败阶段、可能责任线索、影响范围，以及建议处理顺序。',
      '只基于可检索到的 Azure DevOps 数据回答；如果权限或数据不足，明确说明缺口，不要编造。',
    ].join('\n'),
  },
  {
    id: 'work-item-risk-digest',
    title: '工作项风险摘要',
    description: '按阻塞、超期、缺少负责人等维度汇总工作项风险。',
    category: 'azure-devops',
    defaultCron: '0 18 * * 1-5',
    defaultRoom: 'general',
    defaultPrompt: [
      '读取 Azure DevOps Server 当前项目的工作项。',
      '按阻塞、超期、缺少负责人、状态长时间未更新和高优先级未推进分类输出风险摘要。',
      '给出今天最应该处理的前三项动作；只基于可检索到的数据回答，不要编造。',
    ].join('\n'),
  },
];

export function listTaskTemplates(): TaskTemplate[] {
  return TASK_TEMPLATES;
}

export function getTaskTemplate(id: string): TaskTemplate | undefined {
  return TASK_TEMPLATES.find(template => template.id === id);
}

export function createTaskFromTemplate(template: TaskTemplate, input: TaskTemplateInput): TaskDef {
  const name = input.name.trim();
  const prompt = input.prompt?.trim();
  const cron = input.cron?.trim();
  const room = input.room?.trim();

  return {
    name,
    templateId: template.id,
    prompt: prompt || template.defaultPrompt,
    cron: cron || template.defaultCron,
    room: room || template.defaultRoom,
    enabled: input.enabled ?? true,
  };
}
