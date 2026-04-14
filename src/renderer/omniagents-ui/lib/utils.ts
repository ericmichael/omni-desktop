import clsx, { type ClassValue } from 'clsx'

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs)
}

/**
 * Format a timestamp as relative time (e.g., "2 minutes ago", "Yesterday")
 */
export function formatRelativeTime(timestamp: string | Date | undefined): string {
  if (!timestamp) {
return ''
}

  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp
  const now = new Date()
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000)

  if (seconds < 60) {
return 'Just now'
}
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60)
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`
  }
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600)
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  }
  if (seconds < 172800) {
return 'Yesterday'
}
  if (seconds < 604800) {
    const days = Math.floor(seconds / 86400)
    return `${days} days ago`
  }

  // Format as date for older items
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * Generate a session title from the first user message
 */
export function generateSessionTitle(session: { first_message?: any }): string {
  if (!session.first_message) {
return 'New conversation'
}

  try {
    const content = session.first_message.content
    if (typeof content === 'string' && content.trim()) {
      // Take first 50 characters and add ellipsis if needed
      const text = content.trim()
      return text.length > 50 ? `${text.slice(0, 50)  }...` : text
    }
    if (Array.isArray(content)) {
      // Handle content array (might have text and images)
      const textPart = content.find((part: any) => part.type === 'input_text' || typeof part === 'string')
      if (textPart) {
        const text = typeof textPart === 'string' ? textPart : textPart.text
        return text.length > 50 ? `${text.slice(0, 50)  }...` : text
      }
    }
  } catch {
    // Fallback
  }

  return 'New conversation'
}

