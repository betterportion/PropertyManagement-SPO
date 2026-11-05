import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** The option that opens a text box, for a place the walkthrough has no room for. */
export const SOMEWHERE_ELSE = "Somewhere else";
const ELSEWHERE_VALUE = "__elsewhere__";

/**
 * "Where in the house": the house's rooms (latest walkthrough, or the national
 * template for a house never walked), plus "Somewhere else" with a text box.
 * A dropdown so "living room" and "Living Rm" stay one room, which is what lets
 * somebody notice the same blinds breaking every year (Joseph's notes, 2026-11-04).
 *
 * A stored value that is not one of the rooms (typed before, or a room since
 * renamed) opens on "Somewhere else" with that text, so editing never loses it.
 */
export function RoomSelect({ rooms, value, onChange, id, testId }: {
  rooms: string[];
  value: string;
  onChange: (value: string) => void;
  id?: string;
  testId: string;
}) {
  const [elsewhere, setElsewhere] = useState(false);
  const typed = elsewhere || (value !== "" && !rooms.includes(value));
  return (
    <div className="space-y-2">
      <Select
        value={typed ? ELSEWHERE_VALUE : value}
        onValueChange={(choice) => {
          // Radix can report "" on its own (e.g. while the rooms load on a
          // phone); a person never picks "", so it must not clear the room.
          if (choice === "") return;
          const other = choice === ELSEWHERE_VALUE;
          setElsewhere(other);
          onChange(other ? "" : choice);
        }}
      >
        <SelectTrigger id={id} data-testid={testId}>
          <SelectValue placeholder="Select a room" />
        </SelectTrigger>
        <SelectContent>
          {rooms.map((room) => <SelectItem key={room} value={room}>{room}</SelectItem>)}
          <SelectItem value={ELSEWHERE_VALUE}>{SOMEWHERE_ELSE}</SelectItem>
        </SelectContent>
      </Select>
      {typed && (
        <Input
          aria-label="Where in the house"
          placeholder="e.g. Back porch, Basement stairs"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          data-testid={`${testId}-other`}
        />
      )}
    </div>
  );
}
