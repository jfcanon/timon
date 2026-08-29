// Nesting for the list view: a subtask is drawn under its parent, indented one
// level, whenever both are in the same result set. When a filter hides the
// parent, the child is promoted to a root and shows its breadcrumb instead —
// a task never disappears just because its parent was filtered out.

import type { Task } from "./format";

export interface TreeNode {
  task: Task;
  children: TreeNode[];
}

export function buildTree(tasks: Task[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  for (const task of tasks) nodes.set(task.id, { task, children: [] });

  const roots: TreeNode[] = [];
  for (const task of tasks) {
    const node = nodes.get(task.id);
    if (!node) continue;
    const parent = task.parent_id ? nodes.get(task.parent_id) : undefined;
    if (parent && parent !== node && !isDescendant(parent, node)) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/** Guard against a cyclic parent chain in the data producing infinite nesting. */
function isDescendant(candidate: TreeNode, ancestor: TreeNode): boolean {
  const stack = [...ancestor.children];
  while (stack.length > 0) {
    const node = stack.pop() as TreeNode;
    if (node === candidate) return true;
    stack.push(...node.children);
  }
  return false;
}
