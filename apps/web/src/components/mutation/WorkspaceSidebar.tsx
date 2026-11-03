import type { WorkspaceSidebarSection as Section } from "@t3tools/shared/mutationWorkspaceChrome";

import { isElectron } from "~/env";

import { SidebarChromeHeader } from "../sidebar/SidebarChrome";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../ui/sidebar";
import { WorkspaceChromeIcon } from "./WorkspaceChromeIcon";
import {
  setWorkspaceChromeValue,
  useWorkspaceChromeStore,
  useWorkspaceChromeValue,
} from "./workspaceChromeStore";

const EMPTY_SECTIONS: ReadonlyArray<Section> = Object.freeze([]);

function WorkspaceSidebarSection({ section }: { section: Section }) {
  const selected = useWorkspaceChromeValue(section.id);
  return (
    <SidebarGroup aria-labelledby={`workspace-sidebar-${section.id}`}>
      <h3
        id={`workspace-sidebar-${section.id}`}
        className="px-2 pb-1 font-medium text-sidebar-muted-foreground text-xs"
      >
        {section.title}
      </h3>
      <SidebarMenu>
        {section.items.map((item) => (
          <SidebarMenuItem key={item.id}>
            <SidebarMenuButton
              size={item.thumbnail === undefined ? "default" : "lg"}
              isActive={selected === item.id}
              aria-current={selected === item.id ? "true" : undefined}
              onClick={() => setWorkspaceChromeValue(section.id, item.id)}
            >
              {item.thumbnail !== undefined ? (
                <img
                  src={item.thumbnail}
                  alt=""
                  className="size-8 shrink-0 rounded-sm bg-muted object-cover"
                />
              ) : item.icon !== undefined ? (
                <WorkspaceChromeIcon name={item.icon} />
              ) : null}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.detail === undefined ? null : (
                <span className="shrink-0 text-sidebar-muted-foreground text-xs tabular-nums">
                  {item.detail}
                </span>
              )}
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}

/**
 * The app sidebar's content while a workspace declares one: the tool's
 * layers, history, bins, or presets in place of the thread list. Selecting an
 * item sets its section's value.
 */
export function WorkspaceSidebar() {
  const sections = useWorkspaceChromeStore(
    (state) => state.session?.chrome.sidebar ?? EMPTY_SECTIONS,
  );
  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent>
        {sections.map((section) => (
          <WorkspaceSidebarSection key={section.id} section={section} />
        ))}
      </SidebarContent>
    </>
  );
}

/** Whether the app sidebar should show the workspace's sidebar instead of threads. */
export function useWorkspaceSidebarActive() {
  return useWorkspaceChromeStore((state) => (state.session?.chrome.sidebar?.length ?? 0) > 0);
}
