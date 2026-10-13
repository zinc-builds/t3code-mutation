import type { WorkspaceBridgeRect } from "@t3tools/shared/mutationWorkspace";
import type {
  WorkspaceInspectorControl,
  WorkspaceInspectorSection,
} from "@t3tools/shared/mutationWorkspaceChrome";
import { useId, useLayoutEffect, useRef, useState } from "react";

import { hexToHsv, hsvToHex, type HsvColor } from "~/lib/color";
import { observeResize } from "~/lib/observeResize";

import { Button } from "../ui/button";
import { ColorHueSlider, ColorSaturationValuePlane } from "../ui/color-picker";
import { Input } from "../ui/input";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Slider } from "../ui/slider";
import { Switch } from "../ui/switch";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { WorkspaceChromeIcon } from "./WorkspaceChromeIcon";
import {
  resetWorkspaceChromeValue,
  runWorkspaceChromeCommand,
  setWorkspaceChromeValue,
  useWorkspaceChromeValue,
} from "./workspaceChromeStore";

type Control<T extends WorkspaceInspectorControl["type"]> = Extract<
  WorkspaceInspectorControl,
  { type: T }
>;
/** Select and segmented controls share one shape. */
type ChoiceControl = Extract<WorkspaceInspectorControl, { options: unknown }>;

/** A slider's readout: the step's precision, a sign when the range spans zero, and the unit. */
function formatValue(value: number, control: Control<"slider"> | Control<"number">) {
  const decimals = Math.min(3, Math.max(0, -Math.floor(Math.log10(control.step))));
  const signed = (control.min ?? 0) < 0 && value > 0 ? "+" : "";
  return `${signed}${value.toFixed(decimals)}${control.unit === undefined ? "" : ` ${control.unit}`}`;
}

function SliderControl({ control }: { control: Control<"slider"> }) {
  const value = useWorkspaceChromeValue(control.id);
  const current = typeof value === "number" ? value : control.value;
  return (
    <div className="grid gap-1">
      {/* Double-clicking a slider's name resets it, as in pro editors. */}
      <div
        className="flex items-baseline justify-between gap-2"
        onDoubleClick={() => resetWorkspaceChromeValue(control.id)}
      >
        <span className="truncate text-xs">{control.label}</span>
        <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
          {formatValue(current, control)}
        </span>
      </div>
      <Slider
        thumbLabel={control.label}
        min={control.min}
        max={control.max}
        step={control.step}
        value={current}
        onValueChange={(next) => setWorkspaceChromeValue(control.id, next)}
      />
    </div>
  );
}

function NumberControl({ control }: { control: Control<"number"> }) {
  const value = useWorkspaceChromeValue(control.id);
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="truncate text-xs">
        {control.label}
        {control.unit === undefined ? null : (
          <span className="text-muted-foreground"> ({control.unit})</span>
        )}
      </span>
      <NumberField
        size="sm"
        className="w-24"
        value={typeof value === "number" ? value : control.value}
        step={control.step}
        {...(control.min === undefined ? {} : { min: control.min })}
        {...(control.max === undefined ? {} : { max: control.max })}
        onValueChange={(next) => {
          if (next !== null) setWorkspaceChromeValue(control.id, next);
        }}
      >
        <NumberFieldGroup>
          <NumberFieldInput aria-label={control.label} />
        </NumberFieldGroup>
      </NumberField>
    </div>
  );
}

function SelectControl({ control }: { control: ChoiceControl }) {
  const value = useWorkspaceChromeValue(control.id);
  const selected = control.options.find((option) => option.value === value) ?? control.options[0];
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="truncate text-xs">{control.label}</span>
      <Select
        value={selected?.value ?? null}
        onValueChange={(next) => {
          if (typeof next === "string") setWorkspaceChromeValue(control.id, next);
        }}
      >
        <SelectTrigger aria-label={control.label} size="xs" className="w-36">
          <SelectValue>{selected?.label}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {control.options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

function SegmentedControl({ control }: { control: ChoiceControl }) {
  const value = useWorkspaceChromeValue(control.id);
  return (
    <div className="grid gap-1.5">
      <span className="truncate text-xs">{control.label}</span>
      <ToggleGroup
        aria-label={control.label}
        className="w-full"
        value={typeof value === "string" ? [value] : []}
        onValueChange={(next) => {
          const [choice] = next;
          if (typeof choice === "string") setWorkspaceChromeValue(control.id, choice);
        }}
      >
        {control.options.map((option) => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            aria-label={option.label}
            className="flex-1"
          >
            {option.icon === undefined ? option.label : <WorkspaceChromeIcon name={option.icon} />}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

function ToggleControl({ control }: { control: Control<"toggle"> }) {
  const value = useWorkspaceChromeValue(control.id);
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-3">
      <span id={id} className="truncate text-xs">
        {control.label}
      </span>
      <Switch
        aria-labelledby={id}
        size="sm"
        checked={value === true}
        onCheckedChange={(next) => setWorkspaceChromeValue(control.id, next)}
      />
    </div>
  );
}

/** A swatch that opens a picker; drafts the hex field locally so typing is not clamped mid-word. */
function ColorControl({ control }: { control: Control<"color"> }) {
  const value = useWorkspaceChromeValue(control.id);
  const color = typeof value === "string" ? value : control.value;
  // Kept beside its hex, so a gray keeps the hue the user dragged it from.
  const [picked, setPicked] = useState(() => ({ hex: color, hsv: hexToHsv(color) }));
  const hsv = picked.hex.toLowerCase() === color ? picked.hsv : hexToHsv(color);
  const pick = (next: HsvColor) => {
    const hex = hsvToHex(next.h, next.s, next.v);
    setPicked({ hex, hsv: next });
    setWorkspaceChromeValue(control.id, hex);
  };
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="truncate text-xs">{control.label}</span>
      <Popover>
        <PopoverTrigger
          render={
            <Button size="xs" variant="outline" aria-label={`${control.label}: ${color}`}>
              <span
                aria-hidden
                className="size-3.5 rounded-sm border border-border"
                style={{ backgroundColor: color }}
              />
              <span className="font-mono tabular-nums">{color}</span>
            </Button>
          }
        />
        <PopoverPopup side="left" align="start" sideOffset={8} padding="none">
          <div className="w-56">
            <ColorSaturationValuePlane
              label={control.label}
              value={hsv}
              onChange={pick}
              variant="edge"
            />
            <div className="grid gap-3 p-3">
              <ColorHueSlider
                label={`${control.label} hue`}
                value={hsv.h}
                onChange={(h) => pick({ ...hsv, h })}
              />
              <Input
                nativeInput
                size="compact"
                font="mono"
                spellCheck={false}
                aria-label={`${control.label} hex`}
                value={hexDraft ?? color}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setHexDraft(next);
                  if (/^#[\da-f]{6}$/i.test(next)) setWorkspaceChromeValue(control.id, next);
                }}
                onBlur={() => setHexDraft(null)}
              />
            </div>
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}

function InspectorControl({ control }: { control: WorkspaceInspectorControl }) {
  switch (control.type) {
    case "slider":
      return <SliderControl control={control} />;
    case "number":
      return <NumberControl control={control} />;
    case "select":
      return <SelectControl control={control} />;
    case "segmented":
      return <SegmentedControl control={control} />;
    case "toggle":
      return <ToggleControl control={control} />;
    case "color":
      return <ColorControl control={control} />;
    case "button":
      return (
        <Button size="sm" variant="outline" onClick={() => runWorkspaceChromeCommand(control.id)}>
          {control.icon === undefined ? null : <WorkspaceChromeIcon name={control.icon} />}
          {control.label}
        </Button>
      );
  }
}

/**
 * The workspace's native inspector: a right column of the controls the agent
 * declared, with the chat composer docked at its bottom. It reports its
 * composer slot like a page's `data-t3-composer` element, relative to the
 * stage, so the composer overlay lands on it without remounting.
 */
export function WorkspaceInspector(props: {
  readonly sections: ReadonlyArray<WorkspaceInspectorSection>;
  readonly composerHeight: number;
  readonly onComposerSlotChange: (rect: WorkspaceBridgeRect | null) => void;
}) {
  const { onComposerSlotChange } = props;
  const slotRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = slotRef.current;
    const stage = slot?.closest<HTMLElement>("[data-mutation-stage]");
    if (!slot || !stage) return;
    const measure = () => {
      const slotBox = slot.getBoundingClientRect();
      const stageBox = stage.getBoundingClientRect();
      onComposerSlotChange({
        x: slotBox.left - stageBox.left,
        y: slotBox.top - stageBox.top,
        width: slotBox.width,
        height: slotBox.height,
      });
    };
    measure();
    const stop = observeResize([slot, stage], measure);
    return () => {
      stop();
      onComposerSlotChange(null);
    };
  }, [onComposerSlotChange]);

  return (
    <aside
      aria-label="Inspector"
      className="flex h-full w-80 shrink-0 flex-col border-border border-l bg-background"
    >
      <ScrollArea className="min-h-0 flex-1">
        {props.sections.map((section) => (
          <section
            // Sections have no id of their own; their first control names them.
            key={section.controls[0]?.id ?? section.title}
            aria-label={section.title}
            className="grid gap-3 border-border border-b px-4 py-3"
          >
            <h3 className="font-medium text-muted-foreground text-xs">{section.title}</h3>
            {section.controls.map((control) => (
              <InspectorControl key={control.id} control={control} />
            ))}
          </section>
        ))}
      </ScrollArea>
      <div ref={slotRef} className="m-2 shrink-0" style={{ minHeight: props.composerHeight }} />
    </aside>
  );
}
