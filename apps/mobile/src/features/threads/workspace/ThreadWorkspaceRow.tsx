import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { WorkspaceReference } from "@t3tools/shared/mutationWorkspace";
import { Pressable, View, type ColorValue } from "react-native";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { openThreadWorkspace } from "../../../state/mutationWorkspace";

/** Where the agent rebuilt the interface; reopens that workspace from chat. */
export function ThreadWorkspaceRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: string;
  readonly workspace: WorkspaceReference;
  readonly iconColor: ColorValue;
}) {
  const { title } = props.workspace;
  return (
    <View className="mb-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open workspace ${title}`}
        className="flex-row items-center gap-2.5 rounded-xl border border-border px-3 py-2.5 active:opacity-70"
        onPress={() =>
          openThreadWorkspace(props.environmentId, props.threadId, {
            itemId: props.itemId,
            workspace: props.workspace,
          })
        }
      >
        <SymbolView
          name="square.grid.2x2"
          size={14}
          tintColor={props.iconColor}
          type="monochrome"
        />
        <Text className="flex-1 text-sm text-foreground-muted" numberOfLines={1}>
          Workspace <Text className="font-t3-medium text-foreground">{title}</Text>
        </Text>
        <Text className="font-t3-medium text-sm text-foreground">Open</Text>
      </Pressable>
    </View>
  );
}
