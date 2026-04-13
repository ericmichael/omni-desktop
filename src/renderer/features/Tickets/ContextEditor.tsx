import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import YooptaEditor, { createYooptaEditor, Blocks, Marks, useYooptaEditor } from '@yoopta/editor';
import type { RenderBlockProps, SlateElement, YooptaContentValue, YooptaPlugin } from '@yoopta/editor';
import Paragraph from '@yoopta/paragraph';
import { HeadingOne, HeadingTwo, HeadingThree } from '@yoopta/headings';
import { BulletedList, NumberedList, TodoList } from '@yoopta/lists';
import Blockquote from '@yoopta/blockquote';
import Callout from '@yoopta/callout';
import Divider from '@yoopta/divider';
import Code from '@yoopta/code';
import Link from '@yoopta/link';
import Table from '@yoopta/table';
import Accordion from '@yoopta/accordion';
import { Bold, Italic, Underline, Strike, CodeMark, Highlight } from '@yoopta/marks';
import { markdown } from '@yoopta/exports';
import { applyTheme } from '@yoopta/themes-shadcn';

// UI components
import { FloatingToolbar } from '@yoopta/ui/floating-toolbar';
import { SlashCommandMenu } from '@yoopta/ui/slash-command-menu';
import { FloatingBlockActions } from '@yoopta/ui/floating-block-actions';
import { BlockOptions, useBlockActions } from '@yoopta/ui/block-options';
import { ActionMenuList } from '@yoopta/ui/action-menu-list';
import { SelectionBox } from '@yoopta/ui/selection-box';
import { BlockDndContext, SortableBlock, DragHandle } from '@yoopta/ui/block-dnd';
import { HighlightColorPicker } from '@yoopta/ui/highlight-color-picker';

// Icons
import {
  BoldIcon,
  ItalicIcon,
  Underline as UnderlineIcon,
  Strikethrough,
  CodeIcon,
  HighlighterIcon,
  ChevronDownIcon,
  GripVertical,
  PlusIcon,
} from 'lucide-react';

import { makeStyles, tokens } from '@fluentui/react-components';

// ---------------------------------------------------------------------------
// Plugins & Marks
// ---------------------------------------------------------------------------

const rawPlugins = [
  Paragraph,
  HeadingOne.extend({ elements: { 'heading-one': { placeholder: 'Heading 1' } } }),
  HeadingTwo,
  HeadingThree,
  BulletedList,
  NumberedList,
  TodoList,
  Blockquote,
  Callout,
  Divider,
  Code.Code,
  Link,
  Table,
  Accordion,
];

const plugins = applyTheme(rawPlugins) as unknown as YooptaPlugin<Record<string, SlateElement>, unknown>[];
const marks = [Bold, Italic, Underline, Strike, CodeMark, Highlight];

// ---------------------------------------------------------------------------
// Toolbar (inline formatting)
// ---------------------------------------------------------------------------

const EditorToolbar = () => {
  const editor = useYooptaEditor();
  const turnIntoRef = useRef<HTMLButtonElement>(null);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);

  const highlightValue = Marks.getValue(editor, { type: 'highlight' }) as
    | { color?: string; backgroundColor?: string }
    | null;

  return (
    <>
      <FloatingToolbar frozen={actionMenuOpen}>
        <FloatingToolbar.Content>
          <FloatingToolbar.Group>
            <FloatingToolbar.Button ref={turnIntoRef} onClick={() => setActionMenuOpen(true)}>
              Turn into
              <ChevronDownIcon width={16} height={16} />
            </FloatingToolbar.Button>
          </FloatingToolbar.Group>
          <FloatingToolbar.Separator />
          <FloatingToolbar.Group>
            {editor.formats.bold && (
              <FloatingToolbar.Button
                onClick={() => Marks.toggle(editor, { type: 'bold' })}
                active={Marks.isActive(editor, { type: 'bold' })}
                title="Bold"
              >
                <BoldIcon />
              </FloatingToolbar.Button>
            )}
            {editor.formats.italic && (
              <FloatingToolbar.Button
                onClick={() => Marks.toggle(editor, { type: 'italic' })}
                active={Marks.isActive(editor, { type: 'italic' })}
                title="Italic"
              >
                <ItalicIcon />
              </FloatingToolbar.Button>
            )}
            {editor.formats.underline && (
              <FloatingToolbar.Button
                onClick={() => Marks.toggle(editor, { type: 'underline' })}
                active={Marks.isActive(editor, { type: 'underline' })}
                title="Underline"
              >
                <UnderlineIcon />
              </FloatingToolbar.Button>
            )}
            {editor.formats.strike && (
              <FloatingToolbar.Button
                onClick={() => Marks.toggle(editor, { type: 'strike' })}
                active={Marks.isActive(editor, { type: 'strike' })}
                title="Strikethrough"
              >
                <Strikethrough />
              </FloatingToolbar.Button>
            )}
            {editor.formats.code && (
              <FloatingToolbar.Button
                onClick={() => Marks.toggle(editor, { type: 'code' })}
                active={Marks.isActive(editor, { type: 'code' })}
                title="Code"
              >
                <CodeIcon />
              </FloatingToolbar.Button>
            )}
            {editor.formats.highlight && (
              <HighlightColorPicker
                value={highlightValue ?? {}}
                presets={['#FFFF00', '#FFE066', '#FFCC99', '#FF9999', '#99CCFF', '#99FF99', '#FF99FF', '#000000']}
                onChange={(values) => {
                  Marks.add(editor, {
                    type: 'highlight',
                    value: { color: values.color, backgroundColor: values.backgroundColor },
                  });
                }}
              >
                <FloatingToolbar.Button
                  active={Marks.isActive(editor, { type: 'highlight' })}
                  title="Highlight"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (Marks.isActive(editor, { type: 'highlight' })) {
                      Marks.remove(editor, { type: 'highlight' });
                    }
                  }}
                  style={{
                    backgroundColor: Marks.isActive(editor, { type: 'highlight' })
                      ? highlightValue?.backgroundColor
                      : undefined,
                    color: Marks.isActive(editor, { type: 'highlight' }) ? highlightValue?.color : undefined,
                  }}
                >
                  <HighlighterIcon />
                </FloatingToolbar.Button>
              </HighlightColorPicker>
            )}
          </FloatingToolbar.Group>
        </FloatingToolbar.Content>
      </FloatingToolbar>

      <ActionMenuList
        open={actionMenuOpen}
        anchor={turnIntoRef.current}
        onOpenChange={setActionMenuOpen}
        view="small"
        placement="bottom-start"
      >
        <ActionMenuList.Content />
      </ActionMenuList>
    </>
  );
};

// ---------------------------------------------------------------------------
// Slash Command
// ---------------------------------------------------------------------------

const EditorSlashCommand = () => (
  <SlashCommandMenu>
    {(props) => (
      <SlashCommandMenu.Content>
        <SlashCommandMenu.List>
          <SlashCommandMenu.Empty>No blocks found</SlashCommandMenu.Empty>
          {props.items.map((item) => (
            <SlashCommandMenu.Item
              key={item.id}
              value={item.id}
              title={item.title}
              description={item.description}
            />
          ))}
        </SlashCommandMenu.List>
        <SlashCommandMenu.Footer />
      </SlashCommandMenu.Content>
    )}
  </SlashCommandMenu>
);

// ---------------------------------------------------------------------------
// Block Options (context menu on drag handle click)
// ---------------------------------------------------------------------------

type BlockOptionsProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  blockId: string | null;
  anchor: HTMLButtonElement | null;
};

const EditorBlockOptions = ({ open, onOpenChange, blockId, anchor }: BlockOptionsProps) => {
  const { duplicateBlock, copyBlockLink, deleteBlock } = useBlockActions();
  const turnIntoRef = useRef<HTMLButtonElement>(null);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);

  const onActionMenuClose = (menuOpen: boolean) => {
    setActionMenuOpen(menuOpen);
    if (!menuOpen) onOpenChange(false);
  };

  return (
    <>
      <BlockOptions open={open} onOpenChange={onOpenChange} anchor={anchor}>
        <BlockOptions.Content side="right" align="end">
          <BlockOptions.Group>
            <BlockOptions.Item ref={turnIntoRef} onSelect={() => setActionMenuOpen(true)} keepOpen>
              Turn into
            </BlockOptions.Item>
          </BlockOptions.Group>
          <BlockOptions.Separator />
          <BlockOptions.Group>
            <BlockOptions.Item
              onSelect={() => {
                if (blockId) duplicateBlock(blockId);
                onOpenChange(false);
              }}
            >
              Duplicate
            </BlockOptions.Item>
            <BlockOptions.Item
              onSelect={() => {
                if (blockId) copyBlockLink(blockId);
                onOpenChange(false);
              }}
            >
              Copy link to block
            </BlockOptions.Item>
            <BlockOptions.Item
              variant="destructive"
              onSelect={() => {
                if (blockId) deleteBlock(blockId);
                onOpenChange(false);
              }}
            >
              Delete
            </BlockOptions.Item>
          </BlockOptions.Group>
        </BlockOptions.Content>
      </BlockOptions>
      <ActionMenuList
        placement="right-start"
        open={actionMenuOpen}
        onOpenChange={onActionMenuClose}
        anchor={turnIntoRef.current}
      >
        <ActionMenuList.Content />
      </ActionMenuList>
    </>
  );
};

// ---------------------------------------------------------------------------
// Floating Block Actions (+ and drag handle)
// ---------------------------------------------------------------------------

const EditorFloatingBlockActions = () => {
  const editor = useYooptaEditor();
  const dragHandleRef = useRef<HTMLButtonElement>(null);
  const [blockOptionsOpen, setBlockOptionsOpen] = useState(false);

  const onPlusClick = (blockId: string | null) => {
    if (!blockId) return;
    const block = Blocks.getBlock(editor, { id: blockId });
    if (!block) return;
    editor.insertBlock('Paragraph', { at: block.meta.order + 1, focus: true });
  };

  const onDragClick = (blockId: string | null) => {
    if (!blockId) return;
    const block = Blocks.getBlock(editor, { id: blockId });
    if (!block) return;
    editor.setPath({ current: block.meta.order });
    setBlockOptionsOpen(true);
  };

  return (
    <FloatingBlockActions frozen={blockOptionsOpen}>
      {({ blockId }) => (
        <>
          <FloatingBlockActions.Button onClick={() => onPlusClick(blockId)} title="Add block">
            <PlusIcon />
          </FloatingBlockActions.Button>
          <DragHandle blockId={blockId} ref={dragHandleRef} asChild>
            <FloatingBlockActions.Button onClick={() => onDragClick(blockId)} title="Drag to reorder">
              <GripVertical />
            </FloatingBlockActions.Button>
          </DragHandle>

          <EditorBlockOptions
            open={blockOptionsOpen}
            onOpenChange={setBlockOptionsOpen}
            blockId={blockId}
            anchor={dragHandleRef.current}
          />
        </>
      )}
    </FloatingBlockActions>
  );
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const useStyles = makeStyles({
  root: {
    minHeight: '80px',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    // Override dnd-kit sortable transition to exclude opacity.
    // The default includes "opacity 200ms ease" which causes blocks to
    // become invisible when Yoopta inserts/splits blocks on Enter,
    // because dnd-kit's drop animation sets active elements to opacity:0.
    '--yoopta-ui-block-dnd-transition': 'transform 200ms ease',
    // Force sortable blocks to always be fully opaque
    '& .yoopta-ui-block-dnd-sortable': {
      opacity: '1 !important',
    },
  },
});

const EDITOR_STYLE = { width: '100%', paddingBottom: 40 };

// ---------------------------------------------------------------------------
// ContextEditor
// ---------------------------------------------------------------------------

type ContextEditorProps = {
  /** Markdown string to initialize from. */
  initialMarkdown: string;
  /** Called with updated markdown string on every change. */
  onChangeMarkdown: (md: string) => void;
};

export const ContextEditor = memo(({ initialMarkdown, onChangeMarkdown }: ContextEditorProps) => {
  const styles = useStyles();
  const initializedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const editor = useMemo(
    () => createYooptaEditor({ plugins, marks }),
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Load initial markdown content
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    if (initialMarkdown.trim()) {
      try {
        const content = markdown.deserialize(editor, initialMarkdown);
        editor.withoutSavingHistory(() => {
          editor.setEditorValue(content);
        });
      } catch {
        // If deserialization fails, leave editor empty — user can type fresh
      }
    }
  }, [editor, initialMarkdown]);

  const handleChange = useCallback(
    (value: YooptaContentValue) => {
      try {
        const md = markdown.serialize(editor, value);
        onChangeMarkdown(md);
      } catch {
        // Serialization can fail during intermediate states; ignore
      }
    },
    [editor, onChangeMarkdown]
  );

  const renderBlock = useCallback(({ children, blockId }: RenderBlockProps) => {
    return (
      <SortableBlock id={blockId} useDragHandle>
        {children}
      </SortableBlock>
    );
  }, []);

  return (
    <div ref={containerRef} className={styles.root}>
      <BlockDndContext editor={editor}>
        <YooptaEditor
          editor={editor}
          style={EDITOR_STYLE}
          onChange={handleChange}
          renderBlock={renderBlock}
          placeholder="Describe your project — goals, constraints, context... (type / for commands)"
          autoFocus={false}
        >
          <EditorToolbar />
          <EditorFloatingBlockActions />
          <EditorSlashCommand />
          <SelectionBox selectionBoxElement={containerRef} />
        </YooptaEditor>
      </BlockDndContext>
    </div>
  );
});
ContextEditor.displayName = 'ContextEditor';
