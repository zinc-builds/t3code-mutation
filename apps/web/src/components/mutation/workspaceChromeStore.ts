import {
  admitWorkspaceChromeValue,
  applyWorkspaceChromePatch,
  readWorkspaceStateEnvelope,
  resolveWorkspaceChromeValues,
  workspaceChromeDefault,
  workspaceChromeValuesEqual,
  WORKSPACE_CHROME_MISSING_ERROR,
  type WorkspaceChrome,
  type WorkspaceChromeCommand,
  type WorkspaceChromeValue,
  type WorkspaceChromeValues,
} from "@t3tools/shared/mutationWorkspaceChrome";
import { create } from "zustand";

/**
 * The native chrome of the workspace on screen. One at a time: the app has
 * one sidebar and one header. T3 owns the values; the page hears about user
 * changes as `command` and `controls` events and reshapes the chrome with
 * patches, which are not echoed back to it.
 */
export interface WorkspaceChromeSession {
  readonly attachmentId: string;
  readonly chrome: WorkspaceChrome;
  readonly values: WorkspaceChromeValues;
  /** The page's own `setState` object, stored beside the values. */
  readonly pageState: unknown;
  /** Whether the stored state was read; nothing is written before, so a failed read cannot clobber it. */
  readonly loaded: boolean;
  /** Whether the user or page set a value, which a late read of stored values must not undo. */
  readonly valuesEdited: boolean;
  /** Bumped by every change worth storing. */
  readonly revision: number;
}

interface WorkspaceChromeStoreState {
  readonly session: WorkspaceChromeSession | null;
}

export const useWorkspaceChromeStore = create<WorkspaceChromeStoreState>(() => ({
  session: null,
}));

export type WorkspaceChromeEvent =
  | {
      readonly kind: "command";
      readonly attachmentId: string;
      readonly command: WorkspaceChromeCommand;
    }
  | {
      readonly kind: "controls";
      readonly attachmentId: string;
      readonly values: WorkspaceChromeValues;
    };

const listeners = new Set<(event: WorkspaceChromeEvent) => void>();

/** What the page should hear: user actions and value changes. The frame's bridge forwards them. */
export function subscribeWorkspaceChromeEvents(listener: (event: WorkspaceChromeEvent) => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function emit(event: WorkspaceChromeEvent) {
  for (const listener of listeners) listener(event);
}

function current(attachmentId?: string): WorkspaceChromeSession | null {
  const { session } = useWorkspaceChromeStore.getState();
  return session !== null && (attachmentId === undefined || session.attachmentId === attachmentId)
    ? session
    : null;
}

function update(session: WorkspaceChromeSession) {
  useWorkspaceChromeStore.setState({ session });
}

export function openWorkspaceChromeSession(attachmentId: string, chrome: WorkspaceChrome) {
  if (current(attachmentId) !== null) return;
  update({
    attachmentId,
    chrome,
    values: resolveWorkspaceChromeValues(chrome),
    pageState: undefined,
    loaded: false,
    valuesEdited: false,
    revision: 0,
  });
}

export function closeWorkspaceChromeSession(attachmentId: string) {
  if (current(attachmentId) !== null) useWorkspaceChromeStore.setState({ session: null });
}

/**
 * Adopts the thread's stored state once read: its control values (unless the
 * user already changed one) and the page's own state (unless the page already
 * set it). Undefined `stored` means the read failed: defaults stay and nothing
 * is written.
 */
export function loadWorkspaceChromeState(
  attachmentId: string,
  stored: { state: unknown } | undefined,
) {
  const session = current(attachmentId);
  if (session === null) return;
  if (stored === undefined) {
    emit({ kind: "controls", attachmentId, values: session.values });
    return;
  }
  const { controls, page } = readWorkspaceStateEnvelope(stored.state);
  const values = session.valuesEdited
    ? session.values
    : resolveWorkspaceChromeValues(session.chrome, controls);
  update({
    ...session,
    values,
    pageState: session.pageState === undefined ? page : session.pageState,
    loaded: true,
  });
  emit({ kind: "controls", attachmentId, values });
}

/** Sets a control from native UI: stored, and sent to the page as a command and new controls. */
export function setWorkspaceChromeValue(id: string, value: WorkspaceChromeValue) {
  const session = current();
  if (session === null) return;
  const admitted = admitWorkspaceChromeValue(session.chrome, id, value);
  if (admitted === undefined || session.values[id] === admitted) return;
  const values = { ...session.values, [id]: admitted };
  update({ ...session, values, valuesEdited: true, revision: session.revision + 1 });
  const { attachmentId } = session;
  emit({ kind: "command", attachmentId, command: { id, value: admitted } });
  emit({ kind: "controls", attachmentId, values });
}

export function resetWorkspaceChromeValue(id: string) {
  const session = current();
  const fallback = session === null ? undefined : workspaceChromeDefault(session.chrome, id);
  if (fallback !== undefined) setWorkspaceChromeValue(id, fallback);
}

/** A button or menu item: a command with no value. */
export function runWorkspaceChromeCommand(id: string) {
  const session = current();
  if (session !== null)
    emit({ kind: "command", attachmentId: session.attachmentId, command: { id } });
}

export function performWorkspaceChromeCommand(command: WorkspaceChromeCommand) {
  if (command.value === undefined) runWorkspaceChromeCommand(command.id);
  else setWorkspaceChromeValue(command.id, command.value);
}

/** The page's `setState`, stored with the values. False when `attachmentId` has no chrome session. */
export function setWorkspaceChromePageState(attachmentId: string, state: unknown): boolean {
  const session = current(attachmentId);
  if (session === null) return false;
  update({ ...session, pageState: state ?? null, revision: session.revision + 1 });
  return true;
}

/** The page's `setChrome(patch)`; returns an error message for the page when it does not apply. */
export function patchWorkspaceChrome(attachmentId: string, patch: unknown): string | undefined {
  const session = current(attachmentId);
  if (session === null) {
    return WORKSPACE_CHROME_MISSING_ERROR;
  }
  const result = applyWorkspaceChromePatch(session.chrome, session.values, patch);
  if ("error" in result) return result.error;
  const valuesChanged = !workspaceChromeValuesEqual(session.values, result.values);
  update({
    ...session,
    chrome: result.chrome,
    values: valuesChanged ? result.values : session.values,
    valuesEdited: session.valuesEdited || valuesChanged,
    revision: valuesChanged ? session.revision + 1 : session.revision,
  });
  return undefined;
}

export function useWorkspaceChromeValue(id: string): WorkspaceChromeValue | undefined {
  return useWorkspaceChromeStore((state) => state.session?.values[id]);
}
