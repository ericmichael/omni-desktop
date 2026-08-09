import { XIcon } from 'lucide-react';
import {
  type ComponentProps,
  forwardRef,
  type HTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
import { TabsList, TabsTrigger } from '@/renderer/ds/ui/tabs';

/**
 * The launcher's one app-tab language: compact closable chips in a
 * horizontally scrollable strip. The look layer over the vendored
 * ``ds/ui/tabs`` primitives (same split as ``PageTabs``) — change how app
 * tabs read here, not at call sites.
 *
 * Two flavors share the chip recipe so every tab strip in the product
 * reads identically:
 * - ``ClosableTab`` — a Radix ``TabsTrigger`` inside ``ClosableTabsList``,
 *   for strips whose activation is Radix Tabs state (sidecar apps,
 *   terminals). The close button renders BESIDE the trigger (a button
 *   inside a trigger is invalid nesting), positioned over its reserved
 *   right padding.
 * - ``ClosableTabChip`` — a headless ``data-state``-driven tab for strips
 *   with their own interaction stack (the browser's dnd-kit reorder,
 *   context menus, pinning). It renders one plain element, so drag
 *   listeners, refs, and transforms attach directly and the close button
 *   nests inside it.
 *
 * Both flavors close on middle-click (handled on mousedown — the
 * browser's default middle-click autoscroll fires on mouseup), and both
 * isolate close-button pointer events so closing never activates, drags,
 * or context-menus the tab underneath.
 */

/** Chip layout + rest/hover/focus treatment, shared by both flavors. */
const CHIP =
  'relative inline-flex h-7 max-w-45 flex-none items-center justify-start gap-1.5 overflow-hidden rounded-md border border-transparent pl-2 text-xs font-medium whitespace-nowrap text-muted-foreground transition-colors duration-100 hover:bg-accent/50 hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none';

/** Active treatment, keyed on data-state so Radix and headless chips
 *  share it. Later-in-cn duplicates of the vendored trigger's variant
 *  classes resolve in our favor via tailwind-merge. */
const CHIP_ACTIVE =
  'data-[state=active]:bg-accent data-[state=active]:text-foreground dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-accent';

function stopPointer(event: ReactPointerEvent | ReactMouseEvent): void {
  event.stopPropagation();
}

function closeOnMiddleClick(onClose: (() => void) | undefined, event: ReactMouseEvent): void {
  if (event.button === 1 && onClose) {
    event.preventDefault();
    onClose();
  }
}

export function ClosableTabsList({ className, ...props }: ComponentProps<typeof TabsList>) {
  return (
    <TabsList
      className={cn(
        'scrollbar-none h-9 min-w-0 flex-1 justify-start gap-1.5 overflow-x-auto overflow-y-hidden rounded-none bg-transparent p-0 [&::-webkit-scrollbar]:hidden',
        className
      )}
      {...props}
    />
  );
}

/** The close affordance, pointer-isolated from whatever hosts it. */
export function TabCloseButton({
  label,
  onClose,
  mode = 'hover',
  className,
}: {
  label: string;
  onClose: () => void;
  /** 'hover' reveals on tab hover/focus; 'always' keeps it visible. */
  mode?: 'hover' | 'always';
  className?: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className={cn(
        'absolute right-0.5 top-1/2 size-5 -translate-y-1/2 transition-colors duration-100',
        mode === 'hover' && 'opacity-0 focus-visible:opacity-100 group-hover/closable-tab:opacity-100',
        className
      )}
      aria-label={`Close ${label}`}
      title={`Close ${label}`}
      onPointerDown={stopPointer}
      onMouseDown={stopPointer}
      onClick={(event) => {
        event.stopPropagation();
        onClose();
      }}
    >
      <XIcon className="size-3" />
    </Button>
  );
}

/**
 * Radix flavor: a closable tab for ``Tabs``-driven strips. Forwards ref
 * and spreads rest props (style, drag listeners) on the outer wrapper so
 * sortable reordering composes; ``className`` styles the trigger itself,
 * ``wrapperClassName`` the wrapper (e.g. drag opacity).
 */
export const ClosableTab = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement> & {
    value: string;
    label: string;
    icon?: ReactNode;
    /** Omit to render a plain (non-closable) tab in the same strip. */
    onClose?: () => void;
    closeMode?: 'hover' | 'always';
    wrapperClassName?: string;
  }
>(({ value, label, icon, onClose, closeMode = 'hover', className, wrapperClassName, ...props }, ref) => {
  return (
    <div ref={ref} className={cn('group/closable-tab relative flex min-w-0 shrink-0', wrapperClassName)} {...props}>
      <TabsTrigger
        value={value}
        title={label}
        className={cn(
          CHIP,
          CHIP_ACTIVE,
          'group-data-[variant=default]/tabs-list:data-[state=active]:shadow-none',
          onClose ? 'pr-7' : 'pr-2',
          className
        )}
        onMouseDown={(event) => closeOnMiddleClick(onClose, event)}
      >
        {icon}
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
      </TabsTrigger>
      {onClose ? <TabCloseButton label={label} onClose={onClose} mode={closeMode} /> : null}
    </div>
  );
});
ClosableTab.displayName = 'ClosableTab';

/**
 * Headless flavor: the same chip, driven by an explicit ``active`` prop
 * via ``data-state``. Forwards ref and spreads rest props on the single
 * root element so sortable refs/listeners, context-menu ``asChild``
 * triggers, and drag transforms compose directly — spread FIRST, so the
 * chip's own semantics (role="tab", tabIndex, aria-selected) win over
 * helper attributes like dnd-kit's role="button".
 *
 * Keyboard: Enter/Space activate (dispatching the chip's click), Delete or
 * Backspace closes. Hosts implement arrow-key movement across the strip;
 * pass ``tabIndex`` for a roving-tabindex tablist (0 on the active tab,
 * −1 elsewhere) — it defaults to 0 for standalone use.
 */
export const ClosableTabChip = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement> & {
    active: boolean;
    label: string;
    icon?: ReactNode;
    /** Icon-only presentation (e.g. pinned favicon tabs). Middle-click
     *  close still works; the close button is omitted. */
    iconOnly?: boolean;
    onClose?: () => void;
    closeMode?: 'hover' | 'always';
  }
>(
  (
    {
      active,
      label,
      icon,
      iconOnly,
      onClose,
      closeMode = 'hover',
      className,
      children,
      onMouseDown,
      onKeyDown,
      tabIndex,
      ...props
    },
    ref
  ) => (
    <div
      {...props}
      ref={ref}
      role="tab"
      aria-selected={active}
      data-state={active ? 'active' : 'inactive'}
      tabIndex={tabIndex ?? 0}
      title={label}
      className={cn(
        CHIP,
        CHIP_ACTIVE,
        'group/closable-tab cursor-pointer select-none',
        onClose && !iconOnly ? 'pr-7' : 'pr-2',
        className
      )}
      onMouseDown={(event) => {
        closeOnMiddleClick(onClose, event);
        onMouseDown?.(event);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.currentTarget.click();
        } else if ((event.key === 'Delete' || event.key === 'Backspace') && onClose) {
          event.preventDefault();
          onClose();
        }
        onKeyDown?.(event);
      }}
    >
      {icon}
      {!iconOnly && <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>}
      {onClose && !iconOnly ? <TabCloseButton label={label} onClose={onClose} mode={closeMode} /> : null}
      {children}
    </div>
  )
);
ClosableTabChip.displayName = 'ClosableTabChip';
