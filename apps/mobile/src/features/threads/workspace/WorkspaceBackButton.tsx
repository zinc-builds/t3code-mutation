import { Pressable } from "react-native";
import { useResolveClassNames } from "uniwind";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";

/** The way from a mutation workspace back to the thread's chat, floating over the page's corner. */
export function WorkspaceBackButton(props: { readonly top: number; readonly onPress: () => void }) {
  const { color } = useResolveClassNames("text-foreground");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back to chat"
      hitSlop={8}
      onPress={props.onPress}
      style={{ top: props.top }}
      className="absolute left-3 z-30 flex-row items-center gap-1 rounded-full border border-border bg-card/90 py-1.5 pl-2 pr-3 shadow-md shadow-black/20 active:opacity-70"
    >
      <SymbolView
        name="chevron.left"
        size={13}
        tintColor={typeof color === "string" ? color : undefined}
        type="monochrome"
      />
      <Text className="font-t3-medium text-sm text-foreground">Chat</Text>
    </Pressable>
  );
}
