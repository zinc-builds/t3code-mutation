import {
  workspaceShortcutLabel,
  type WorkspaceToolbarItem,
} from "@t3tools/shared/mutationWorkspaceChrome";
import { ChevronDownIcon } from "lucide-react";
import type { ReactElement } from "react";

import { isMacPlatform } from "~/lib/utils";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../ui/menu";
import { Separator } from "../ui/separator";
import { Toggle } from "../ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspaceChromeIcon } from "./WorkspaceChromeIcon";
import {
  runWorkspaceChromeCommand,
  setWorkspaceChromeValue,
  useWorkspaceChromeStore,
  useWorkspaceChromeValue,
} from "./workspaceChromeStore";

const EMPTY_ITEMS: ReadonlyArray<WorkspaceToolbarItem> = Object.freeze([]);

function shortcutLabel(shortcut: string | undefined) {
  return shortcut === undefined
    ? null
    : workspaceShortcutLabel(shortcut, isMacPlatform(navigator.platform));
}

/** An icon control names itself in a tooltip, with its shortcut. */
function Tipped(props: {
  readonly label: string;
  readonly shortcut?: string | undefined;
  readonly children: ReactElement;
}) {
  const shortcut = shortcutLabel(props.shortcut);
  return (
    <Tooltip>
      <TooltipTrigger render={props.children} />
      <TooltipPopup side="bottom">
        {props.label}
        {shortcut === null ? null : ` (${shortcut})`}
      </TooltipPopup>
    </Tooltip>
  );
}

function ToolbarButton({ item }: { item: Extract<WorkspaceToolbarItem, { type: "button" }> }) {
  const onClick = () => runWorkspaceChromeCommand(item.id);
  return item.icon === undefined ? (
    <Tipped label={item.label} shortcut={item.shortcut}>
      <Button size="xs" variant="ghost" onClick={onClick}>
        {item.label}
      </Button>
    </Tipped>
  ) : (
    <Tipped label={item.label} shortcut={item.shortcut}>
      <Button size="icon-xs" variant="ghost" aria-label={item.label} onClick={onClick}>
        <WorkspaceChromeIcon name={item.icon} />
      </Button>
    </Tipped>
  );
}

function ToolbarToggle({ item }: { item: Extract<WorkspaceToolbarItem, { type: "toggle" }> }) {
  const pressed = useWorkspaceChromeValue(item.id) === true;
  return (
    <Tipped label={item.label} shortcut={item.shortcut}>
      <Toggle
        size="xs"
        variant="ghost"
        aria-label={item.label}
        pressed={pressed}
        onPressedChange={(next) => setWorkspaceChromeValue(item.id, next)}
      >
        {item.icon === undefined ? item.label : <WorkspaceChromeIcon name={item.icon} />}
      </Toggle>
    </Tipped>
  );
}

function ToolbarSegmented({
  item,
}: {
  item: Extract<WorkspaceToolbarItem, { type: "segmented" }>;
}) {
  const value = useWorkspaceChromeValue(item.id);
  return (
    <ToggleGroup
      aria-label={item.label}
      value={typeof value === "string" ? [value] : []}
      onValueChange={(next) => {
        const [choice] = next;
        if (typeof choice === "string") setWorkspaceChromeValue(item.id, choice);
      }}
    >
      {item.options.map((option) => (
        <Tipped key={option.value} label={option.label} shortcut={option.shortcut}>
          <ToggleGroupItem value={option.value} aria-label={option.label}>
            {option.icon === undefined ? option.label : <WorkspaceChromeIcon name={option.icon} />}
          </ToggleGroupItem>
        </Tipped>
      ))}
    </ToggleGroup>
  );
}

function ToolbarMenu({ item }: { item: Extract<WorkspaceToolbarItem, { type: "menu" }> }) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="xs" variant="ghost">
            {item.icon === undefined ? null : <WorkspaceChromeIcon name={item.icon} />}
            {item.label}
            <ChevronDownIcon />
          </Button>
        }
      />
      <MenuPopup align="start">
        {item.items.map((entry) => (
          <MenuItem key={entry.id} onClick={() => runWorkspaceChromeCommand(entry.id)}>
            {entry.label}
            {entry.shortcut === undefined ? null : (
              <MenuShortcut>{shortcutLabel(entry.shortcut)}</MenuShortcut>
            )}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

/**
 * The workspace's tools in the window header, from its chrome manifest:
 * buttons and menu items send commands, toggles and segments set values.
 */
export function WorkspaceToolbar() {
  const items = useWorkspaceChromeStore((state) => state.session?.chrome.toolbar ?? EMPTY_ITEMS);
  if (items.length === 0) return null;
  return (
    <div
      role="toolbar"
      aria-label="Workspace tools"
      className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
    >
      {items.map((item, index) => {
        switch (item.type) {
          case "button":
            return <ToolbarButton key={item.id} item={item} />;
          case "toggle":
            return <ToolbarToggle key={item.id} item={item} />;
          case "segmented":
            return <ToolbarSegmented key={item.id} item={item} />;
          case "menu":
            return <ToolbarMenu key={item.id} item={item} />;
          case "separator": {
            // Separators have no id; the item before one names it.
            const before = items[index - 1];
            const key = `separator:${before === undefined || before.type === "separator" ? index : before.id}`;
            return <Separator key={key} orientation="vertical" className="mx-1 h-4" />;
          }
        }
      })}
    </div>
  );
}
