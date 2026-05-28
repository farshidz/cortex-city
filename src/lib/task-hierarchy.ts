import type { Task } from "@/lib/types";

export interface TaskTableRow {
  task: Task;
  depth: number;
}

export function getTaskTableRows(tasks: Task[]): TaskTableRow[] {
  const taskIds = new Set(tasks.map((task) => task.id));
  const childrenByParentId = new Map<string, Task[]>();
  const roots: Task[] = [];

  for (const task of tasks) {
    if (
      task.parent_task_id &&
      task.parent_task_id !== task.id &&
      taskIds.has(task.parent_task_id)
    ) {
      const children = childrenByParentId.get(task.parent_task_id) ?? [];
      children.push(task);
      childrenByParentId.set(task.parent_task_id, children);
    } else {
      roots.push(task);
    }
  }

  const rows: TaskTableRow[] = [];
  const visited = new Set<string>();

  function appendTask(task: Task, depth: number) {
    if (visited.has(task.id)) return;

    visited.add(task.id);
    rows.push({ task, depth });

    for (const child of childrenByParentId.get(task.id) ?? []) {
      appendTask(child, depth + 1);
    }
  }

  for (const task of roots) {
    appendTask(task, 0);
  }

  for (const task of tasks) {
    appendTask(task, 0);
  }

  return rows;
}
