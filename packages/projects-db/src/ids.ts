import { nanoid } from 'nanoid';

export const projectId = () => `proj_${nanoid(12)}`;
export const ticketId = () => `tkt_${nanoid(12)}`;
export const milestoneId = () => `ms_${nanoid(12)}`;
export const pageId = () => `pg_${nanoid(12)}`;
export const inboxId = () => `inb_${nanoid(12)}`;
export const columnId = () => `col_${nanoid(12)}`;
export const commentId = () => `cmt_${nanoid(12)}`;
export const taskId = () => `task_${nanoid(12)}`;
