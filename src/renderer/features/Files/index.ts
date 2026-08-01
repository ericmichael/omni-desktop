export { CodeMirrorEditor, type CodeMirrorEditorProps } from './CodeMirrorEditor';
export { FilesSurface, WorkspaceFilesPortal } from './FilesSurface';
export {
  dispatchOpenFileIntent,
  emitOpenFileIntent,
  type OpenFileDispatchOptions,
  type OpenFileFailureReason,
  type OpenFileIntent,
  type OpenFileIntentSource,
  type OpenFileLocation,
  type OpenFileResult,
  type OpenFileResultEvent,
  type OpenFileTarget,
  type OpenFileTargetRequest,
  registerOpenFileTarget,
  subscribeOpenFileResults,
} from './open-file-intent';
export type { WorkspaceFileTreeProps, WorkspaceTreeWatchRegistry } from './WorkspaceFileTree';
export { WorkspaceFileTree } from './WorkspaceFileTree';
