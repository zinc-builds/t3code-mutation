import { DotIcon } from "lucide-react";
import type { IconName } from "lucide-react/dynamic";
import { lazy, Suspense } from "react";

const DynamicIcon = lazy(() =>
  import("lucide-react/dynamic").then((module) => ({ default: module.DynamicIcon })),
);

function UnknownIcon() {
  return <DotIcon aria-hidden />;
}

/**
 * A lucide icon the agent named in its chrome manifest, loaded on demand so
 * the app does not bundle every icon. An unknown name shows a dot.
 */
export function WorkspaceChromeIcon(props: { readonly name: string; readonly className?: string }) {
  return (
    <Suspense fallback={<DotIcon aria-hidden className={props.className} />}>
      <DynamicIcon
        aria-hidden
        name={props.name as IconName}
        fallback={UnknownIcon}
        {...(props.className === undefined ? {} : { className: props.className })}
      />
    </Suspense>
  );
}
