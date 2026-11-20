import type { ToolHandler } from '@server/services/ToolService/types';

type PlanStatus = 'pending' | 'in_progress' | 'completed';

interface PlanItem {
  step: string;
  status: PlanStatus;
}

interface StoredPlan {
  explanation?: string;
  plan: PlanItem[];
  updatedAt: string;
}

const plans = new Map<string, StoredPlan>();

function contextKey(context: Parameters<ToolHandler>[2]): string {
  return `${context?.threadId ?? 'threadless'}:${context?.agentId ?? 'agentless'}`;
}

function parsePlan(raw: unknown): PlanItem[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('plan must be a non-empty array');
  }

  const plan = raw.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`plan[${index}] must be an object`);
    }
    const row = item as Record<string, unknown>;
    const step = String(row.step ?? '').trim();
    const status = String(row.status ?? '').trim() as PlanStatus;
    if (!step) throw new Error(`plan[${index}].step is required`);
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
      throw new Error(`plan[${index}].status must be pending, in_progress, or completed`);
    }
    return { step, status };
  });

  const inProgress = plan.filter((item) => item.status === 'in_progress');
  if (inProgress.length > 1) {
    throw new Error('At most one plan item can be in_progress');
  }

  return plan;
}

const tool: ToolHandler = async (input, _settings, context) => {
  const plan = parsePlan(input.plan);
  const explanation =
    typeof input.explanation === 'string' && input.explanation.trim()
      ? input.explanation.trim()
      : undefined;
  const stored: StoredPlan = {
    ...(explanation ? { explanation } : {}),
    plan,
    updatedAt: new Date().toISOString(),
  };
  plans.set(contextKey(context), stored);

  const lines = ['Plan updated.'];
  if (stored.explanation) lines.push(stored.explanation);
  for (const item of stored.plan) {
    lines.push(`- ${item.status}: ${item.step}`);
  }
  return lines.join('\n');
};

export default tool;
