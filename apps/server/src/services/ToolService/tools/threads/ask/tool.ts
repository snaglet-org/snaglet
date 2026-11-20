import { asTrimmedString } from '@snaglet/shared/utils';
import type {
  ClarificationAnswer,
  ClarificationQuestion,
  ClarificationQuestionType,
} from '@snaglet/shared/types';
import type { ToolHandler } from '@server/services/ToolService/types';

const QUESTION_TYPES: ClarificationQuestionType[] = ['text', 'single_select', 'multi_select'];

function parseQuestion(raw: unknown, index: number): ClarificationQuestion {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`questions[${index}] must be an object`);
  }
  const q = raw as Record<string, unknown>;
  const id = asTrimmedString(q.id);
  if (!id) throw new Error(`questions[${index}].id is required (a short snake_case key)`);
  const prompt = asTrimmedString(q.prompt);
  if (!prompt) throw new Error(`questions[${index}].prompt is required`);
  const type = asTrimmedString(q.type) as ClarificationQuestionType | undefined;
  if (!type || !QUESTION_TYPES.includes(type)) {
    throw new Error(`questions[${index}].type must be one of: ${QUESTION_TYPES.join(', ')}`);
  }

  const question: ClarificationQuestion = { id, prompt, type };

  if (type === 'single_select' || type === 'multi_select') {
    if (!Array.isArray(q.options)) {
      throw new Error(`questions[${index}].options is required for ${type}`);
    }
    const options = q.options.map((o) => asTrimmedString(o)).filter((o): o is string => !!o);
    if (options.length === 0) {
      throw new Error(`questions[${index}].options must have at least one non-empty choice`);
    }
    question.options = options;
    if (typeof q.allow_other === 'boolean') question.allowOther = q.allow_other;
    if (type === 'multi_select') {
      if (typeof q.min_select === 'number') question.minSelect = q.min_select;
      if (typeof q.max_select === 'number') question.maxSelect = q.max_select;
    }
  }
  if (typeof q.required === 'boolean') question.required = q.required;

  return question;
}

function renderAnswer(q: ClarificationQuestion, answer: ClarificationAnswer | undefined): string {
  if (!answer) return '(no answer)';
  if (q.type === 'text') return answer.text?.trim() || '(no answer)';
  const parts = [...(answer.selected ?? [])];
  if (answer.text?.trim()) parts.push(`Other: ${answer.text.trim()}`);
  return parts.length > 0 ? parts.join(', ') : '(no answer)';
}

/**
 * `ask` — pose interactive questions to the user and block the run
 * until they answer. Relies on context.requestClarification, injected by the
 * socket dispatch layer; unavailable on headless (non-socket) runs.
 */
const tool: ToolHandler = async (input, _settings, context) => {
  if (context?.unattended) {
    throw new Error(
      `ask needs a person to answer, and this run is unattended (started by ${context.unattended.source} ` +
        `"${context.unattended.name}"); nobody is there. Carry on with your best judgment, or leave ` +
        'the question in your reply for a person to answer later.'
    );
  }
  if (!context?.requestClarification) {
    throw new Error(
      'ask is only available in a live user thread (no user is connected to answer).'
    );
  }

  const rawQuestions = input.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw new Error('questions must be a non-empty array');
  }
  const questions = rawQuestions.map(parseQuestion);

  const seen = new Set<string>();
  for (const q of questions) {
    if (seen.has(q.id)) throw new Error(`Duplicate question id "${q.id}" — ids must be unique`);
    seen.add(q.id);
  }

  const preamble = asTrimmedString(input.preamble);
  const result = await context.requestClarification({
    preamble: preamble || undefined,
    questions,
  });

  if (result.status === 'timed_out') {
    return 'The user did not answer in time (clarification timed out). Proceed with your best judgment, or ask again if it is essential.';
  }
  if (result.status === 'dismissed') {
    return 'The user dismissed the clarification without answering. Proceed with your best judgment, or ask again if it is essential.';
  }

  const lines = questions.map(
    (q) => `- ${q.prompt} [${q.id}]: ${renderAnswer(q, result.answers[q.id])}`
  );
  return ['The user answered:', ...lines].join('\n');
};

export default tool;
