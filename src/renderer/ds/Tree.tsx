import { ChevronRightIcon } from 'lucide-react';
import {
  createContext,
  forwardRef,
  type HTMLAttributes,
  isValidElement,
  type MouseEvent,
  type PropsWithChildren,
  type ReactNode,
  useContext,
  useMemo,
} from 'react';

import { cn } from '@/renderer/ds/cn';

export type TreeItemOpenChangeData = { openItems: Set<unknown>; value: unknown; open: boolean };
export type TreeProps = HTMLAttributes<HTMLDivElement> & {
  openItems?: Iterable<unknown>;
  onOpenChange?: (data: TreeItemOpenChangeData) => void;
};

type TreeContextValue = { openItems: Set<unknown>; toggle?: (value: unknown) => void };
const TreeContext = createContext<TreeContextValue>({ openItems: new Set() });
const TreeItemContext = createContext<{ branch: boolean; open: boolean; toggle?: () => void }>({
  branch: false,
  open: false,
});

export const Tree = ({ openItems, onOpenChange, className, children, ...props }: PropsWithChildren<TreeProps>) => {
  const parent = useContext(TreeContext);
  const items = useMemo(
    () => (openItems == null ? parent.openItems : new Set(openItems)),
    [openItems, parent.openItems]
  );
  const toggle = onOpenChange
    ? (value: unknown) => {
        const next = new Set(items);
        const open = !next.has(value);
        if (open) {
          next.add(value);
        } else {
          next.delete(value);
        }
        onOpenChange({ openItems: next, value, open });
      }
    : parent.toggle;
  return (
    <TreeContext.Provider value={{ openItems: items, toggle }}>
      <div
        role={parent.toggle ? 'group' : 'tree'}
        className={cn('flex flex-col', parent.toggle && 'ml-4', className)}
        {...props}
      >
        {children}
      </div>
    </TreeContext.Provider>
  );
};

type TreeItemProps = HTMLAttributes<HTMLDivElement> & { itemType?: 'leaf' | 'branch'; value: unknown };
export const TreeItem = forwardRef<HTMLDivElement, PropsWithChildren<TreeItemProps>>(
  ({ itemType = 'leaf', value, className, children, onKeyDown, ...props }, ref) => {
    const tree = useContext(TreeContext);
    const branch = itemType === 'branch';
    const open = tree.openItems.has(value);
    return (
      <TreeItemContext.Provider value={{ branch, open, toggle: branch ? () => tree.toggle?.(value) : undefined }}>
        <div
          ref={ref}
          role="treeitem"
          tabIndex={0}
          aria-expanded={branch ? open : undefined}
          className={cn('outline-none', className)}
          onKeyDown={(event) => {
            if (
              event.currentTarget === event.target &&
              branch &&
              ((event.key === 'ArrowRight' && !open) ||
                (event.key === 'ArrowLeft' && open) ||
                event.key === 'Enter' ||
                event.key === ' ')
            ) {
              event.preventDefault();
              tree.toggle?.(value);
            }
            onKeyDown?.(event);
          }}
          {...props}
        >
          {children}
        </div>
      </TreeItemContext.Provider>
    );
  }
);
TreeItem.displayName = 'TreeItem';

type TreeItemLayoutProps = HTMLAttributes<HTMLDivElement> & {
  iconBefore?: ReactNode;
  aside?: ReactNode;
  actions?: ReactNode | { visible?: boolean; children?: ReactNode };
};
export const TreeItemLayout = ({
  iconBefore,
  aside,
  actions,
  className,
  children,
  onClick,
  ...props
}: TreeItemLayoutProps) => {
  const item = useContext(TreeItemContext);
  const actionContent: ReactNode =
    actions && typeof actions === 'object' && !isValidElement(actions) && 'children' in actions
      ? actions.children
      : (actions as ReactNode);
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (item.branch) {
      item.toggle?.();
    }
    onClick?.(event);
  };
  return (
    <div
      className={cn(
        'hover:bg-accent flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 py-1 text-sm',
        className
      )}
      onClick={handleClick}
      {...props}
    >
      {item.branch && (
        <ChevronRightIcon className={cn('size-3.5 shrink-0 transition-transform', item.open && 'rotate-90')} />
      )}
      {iconBefore}
      <span data-slot="tree-item-main" className="min-w-0 flex-1 truncate">
        {children}
      </span>
      {aside}
      {actionContent}
    </div>
  );
};
