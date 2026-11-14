// Fixed messages for the ?done=<code> flash after an action. Only these
// strings are ever shown: the query parameter selects, it never supplies text.
export const DONE = {
  kicked: "Kicked.",
  "kicked-offline": "They're already offline.",
  muted: "Muted.",
  "muted-pending": "Saved. They'll be muted when the game server answers.",
  unmuted: "Mute lifted.",
  "unmuted-pending": "Mute lifted. The game server didn't answer; it takes effect within a minute.",
  warned: "Warning sent.",
  banned: "Banned.",
  "banned-pending": "Banned. The kick didn't go through; the ban check will close them within a minute.",
  unbanned: "Ban lifted.",
  "note-added": "Note added.",
  "note-deleted": "Note deleted.",
  resolved: "Report resolved.",
  "retention-saved": "Chat retention saved.",
} as const;
export type DoneCode = keyof typeof DONE;
export const doneMessage = (code: string | null): string | null => (code && Object.hasOwn(DONE, code) ? DONE[code as DoneCode] : null);
