"use client";

import { Slider as SliderPrimitive } from "@base-ui/react/slider";

import { cn } from "~/lib/utils";

/**
 * A single-thumb slider. `thumbLabel` names the thumb's input for assistive
 * technology when no visible label is associated with the slider.
 */
function Slider({
  className,
  thumbLabel,
  ...props
}: SliderPrimitive.Root.Props<number> & { thumbLabel?: string }) {
  return (
    <SliderPrimitive.Root
      className={cn("w-full", className)}
      data-slot="slider"
      thumbAlignment="edge"
      {...props}
    >
      <SliderPrimitive.Control className="flex h-5 w-full touch-none select-none items-center data-disabled:opacity-64">
        <SliderPrimitive.Track className="relative h-1 w-full rounded-full bg-input">
          <SliderPrimitive.Indicator className="rounded-full bg-primary" />
          <SliderPrimitive.Thumb
            {...(thumbLabel === undefined ? {} : { "aria-label": thumbLabel })}
            className="block size-3.5 rounded-full border border-input bg-background shadow-sm/10 outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-dragging:shadow-md/15"
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
