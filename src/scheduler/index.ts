import cron from 'node-cron';
import type { Logger } from '../utils/logger.js';
import { TaskPersistence, type TaskDef } from './persistence.js';

export type TaskRunner = (task: TaskDef) => Promise<{ success: boolean; output?: string; error?: string }>;

export class Scheduler {
  private jobs = new Map<string, cron.ScheduledTask>();
  private persistence: TaskPersistence;
  private runner: TaskRunner;
  private logger: Logger;

  constructor(persistence: TaskPersistence, runner: TaskRunner, logger: Logger) {
    this.persistence = persistence;
    this.runner = runner;
    this.logger = logger;
  }

  /** 启动所有启用的任务 */
  start(): void {
    const tasks = this.persistence.loadTasks();
    for (const task of tasks) {
      if (task.enabled) this.registerTask(task);
    }
    this.logger.info(`调度器已启动，${tasks.filter(t => t.enabled).length} 个任务`);
  }

  /** 添加或更新任务 */
  addTask(task: TaskDef): void {
    // 移除旧注册
    this.removeTask(task.name);

    const tasks = this.persistence.loadTasks();
    const idx = tasks.findIndex(t => t.name === task.name);
    if (idx >= 0) tasks[idx] = task;
    else tasks.push(task);
    this.persistence.saveTasks(tasks);

    if (task.enabled) this.registerTask(task);
  }

  /** 移除任务 */
  removeTask(name: string): void {
    const job = this.jobs.get(name);
    if (job) { job.stop(); this.jobs.delete(name); }

    const tasks = this.persistence.loadTasks().filter(t => t.name !== name);
    this.persistence.saveTasks(tasks);
  }

  /** 立即执行一次任务 */
  async runNow(name: string): Promise<{ success: boolean; output?: string; error?: string }> {
    const tasks = this.persistence.loadTasks();
    const task = tasks.find(t => t.name === name);
    if (!task) return { success: false, error: `任务 ${name} 不存在` };

    this.logger.info('手动执行任务', { name });
    const result = await this.runner(task);
    this.persistence.recordHistory(name, result.success, result.output, result.error);
    return result;
  }

  /** 列出所有任务 */
  listTasks(): TaskDef[] {
    return this.persistence.loadTasks();
  }

  /** 获取任务历史 */
  getHistory(taskName?: string, limit?: number): ReturnType<typeof this.persistence.getRecentHistory> {
    return this.persistence.getRecentHistory(taskName, limit);
  }

  stopAll(): void {
    for (const [name, job] of this.jobs) {
      job.stop();
      this.logger.info('任务已停止', { name });
    }
    this.jobs.clear();
  }

  private registerTask(task: TaskDef): void {
    if (!cron.validate(task.cron)) {
      this.logger.warn('无效 cron', { name: task.name, cron: task.cron });
      return;
    }

    const job = cron.schedule(task.cron, async () => {
      this.logger.info('定时任务触发', { name: task.name });
      const result = await this.runner(task);
      this.persistence.recordHistory(task.name, result.success, result.output, result.error);
    });

    this.jobs.set(task.name, job);
    this.logger.info('任务已注册', { name: task.name, cron: task.cron });
  }
}
