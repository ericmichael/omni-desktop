import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { Input } from './Input';

type InputProps = ComponentProps<typeof Input>;
type ComposerOwner = {
  container: HTMLDivElement;
  setProps: (props: InputProps) => void;
  focused: { current: HTMLElement | null };
};
const ComposerContext = createContext<ComposerOwner | null>(null);

/** Keep the actual composer mounted while the startup shell gives way to chat.
 * Only its host moves; focus, selection, attachments and local history survive. */
export function ConversationComposerProvider({ children }: { children: ReactNode }) {
  const [container] = useState(() => document.createElement('div'));
  const [props, setProps] = useState<InputProps | null>(null);
  const focused = useRef<HTMLElement | null>(null);
  const owner = useMemo(() => ({ container, setProps, focused }), [container]);
  useLayoutEffect(() => () => container.remove(), [container]);
  return (
    <ComposerContext.Provider value={owner}>
      {children}
      {props && createPortal(<Input key={props.conversationId} {...props} />, container)}
    </ComposerContext.Provider>
  );
}

export function ConversationComposer(props: InputProps) {
  const owner = useContext(ComposerContext);
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!owner || !host.current) {
      return;
    }
    if (owner.container.parentElement !== host.current) {
      host.current.appendChild(owner.container);
      owner.focused.current?.focus({ preventScroll: true });
      owner.focused.current = null;
    }
    owner.setProps(props);
    return () => {
      if (owner.container.contains(document.activeElement)) {
        owner.focused.current = document.activeElement as HTMLElement;
      }
    };
  }, [owner, props]);
  return owner ? <div ref={host} /> : <Input {...props} />;
}
