import type { MessageItem, ToolItem } from './MessageList'

export type ActivityGroupData = {
  type: 'activity_group'
  runId: string
  tools: ToolItem[]
  isRunning: boolean
}

export type DisplayItem = MessageItem | ActivityGroupData

export type GroupSummary = {
  total: number
  reads: number
  edits: number
  commands: number
  searches: number
  other: number
  errors: number
}

export function groupItems(
  items: MessageItem[],
  currentRunId: string | undefined,
  thinking: boolean
): DisplayItem[] {
  const result: DisplayItem[] = []
  let acc: ToolItem[] = []
  let accRunId: string | undefined = undefined

  const flush = () => {
    if (acc.length === 0) {
return
}
    if (accRunId) {
      result.push({
        type: 'activity_group',
        runId: accRunId,
        tools: acc,
        isRunning: accRunId === currentRunId && thinking,
      })
    } else {
      // No runId — render individually (session history)
      for (const t of acc) {
result.push(t)
}
    }
    acc = []
    accRunId = undefined
  }

  for (const item of items) {
    if (item.type === 'tool') {
      const tool = item as ToolItem
      const rid = (tool as any).runId as string | undefined
      if (!rid) {
        // No runId — pass through as standalone
        flush()
        result.push(tool)
        continue
      }
      if (acc.length > 0 && rid !== accRunId) {
        flush()
      }
      accRunId = rid
      acc.push(tool)
    } else if (item.type === 'approval') {
      // Approvals break the group
      flush()
      result.push(item)
    } else {
      flush()
      result.push(item)
    }
  }
  flush()
  return result
}

const READ_PATTERNS = /^(read|cat|get|fetch|load|view|show|list|ls|glob|grep|search_file|file_content)/i
const EDIT_PATTERNS = /^(edit|write|update|set|create|delete|remove|patch|replace|mv|cp|rename)/i
const COMMAND_PATTERNS = /^(bash|shell|exec|run|command|terminal|cmd|npm|pip|make)/i
const SEARCH_PATTERNS = /^(search|find|grep|rg|ripgrep|glob|locate)/i

function categorize(toolName: string): keyof Omit<GroupSummary, 'total' | 'errors'> {
  if (SEARCH_PATTERNS.test(toolName)) {
return 'searches'
}
  if (READ_PATTERNS.test(toolName)) {
return 'reads'
}
  if (EDIT_PATTERNS.test(toolName)) {
return 'edits'
}
  if (COMMAND_PATTERNS.test(toolName)) {
return 'commands'
}
  return 'other'
}

export function computeGroupSummary(tools: ToolItem[]): GroupSummary {
  const s: GroupSummary = { total: tools.length, reads: 0, edits: 0, commands: 0, searches: 0, other: 0, errors: 0 }
  for (const t of tools) {
    s[categorize(t.tool)]++
    if (t.metadata?.display_type === 'error') {
s.errors++
}
  }
  return s
}

export function formatGroupSummary(s: GroupSummary): string {
  const parts = [`${s.total} tool${s.total === 1 ? '' : 's'}`]
  if (s.reads) {
parts.push(`${s.reads} read${s.reads === 1 ? '' : 's'}`)
}
  if (s.edits) {
parts.push(`${s.edits} edit${s.edits === 1 ? '' : 's'}`)
}
  if (s.commands) {
parts.push(`${s.commands} command${s.commands === 1 ? '' : 's'}`)
}
  if (s.searches) {
parts.push(`${s.searches} search${s.searches === 1 ? '' : 'es'}`)
}
  if (s.errors) {
parts.push(`${s.errors} error${s.errors === 1 ? '' : 's'}`)
}
  return parts.join(' \u00b7 ')
}
