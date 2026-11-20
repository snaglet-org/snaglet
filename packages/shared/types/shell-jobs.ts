/**
 * Background shell jobs (`shell` op:run with `background: true`): the
 * agent-private thread rows that record them. One row when a job is still
 * running past its start window, one when it ends (or, after a restart, when
 * boot recovery finds it cut off). Both carry `shell_job_id` in metadata so
 * boot recovery can pair them.
 */

/** messages.metadata.event_kind on a job's start row. */
export const SHELL_JOB_STARTED_EVENT_KIND = 'shell_job_started';

/** messages.metadata.event_kind on a job's end row (finished, killed or lost). */
export const SHELL_JOB_ENDED_EVENT_KIND = 'shell_job_ended';

/** Every job row's content opens with this, so the UI can match it without metadata. */
export const SHELL_JOB_LINE_PREFIX = '[shell job ';
